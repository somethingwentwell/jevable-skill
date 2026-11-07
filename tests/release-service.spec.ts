import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes, randomUUID } from 'node:crypto'
import { request, createServer } from 'node:http'
import { LocalRuntime, type LocalRuntimeOptions } from '../src/runtime/local.ts'
import { startRuntimeService } from '../src/http/service.ts'
import { ReleaseClient } from '../src/releases/client.ts'
import { CORE_VERSION, PROTOCOL_VERSION, capabilities } from '../src/capabilities.ts'
import type { Release } from '../src/releases/snapshot.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const support = await readFile(new URL('../examples/support.yaml', import.meta.url), 'utf8')
const cleanup: (() => Promise<unknown>)[] = []
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
const modelSource = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'model', name: 'Model' },
  spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
    write: { type: 'llm', config: { provider: 'fixture', model: 'fixture', connection: { mode: 'workspace', id: 'fixture' },
      prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 20, stream: false },
      execution: { timeoutSeconds: 60, maxAttempts: 1 }, historyScope: 'none' } },
    end: { type: 'output', config: { value: '${{ nodes.write.output }}' } } }, edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }] } })
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
async function releaseFor(source = echo): Promise<Release> {
  const author = await LocalRuntime.open({ dataDirectory: await mkdtemp(join(tmpdir(), 'jevable-release-author-')) })
  try {
    const project = author.editProject({ operation: 'create', yaml: source, title: 'Service fixture', actor: 'fixture:author' })
    return author.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision, version: '1.0.0',
      actor: 'fixture:author', runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
  } finally { await author.close() }
}
async function fixture(release?: Release, runtimeOptions: Partial<LocalRuntimeOptions> = {}, maxConcurrentRequests = 16) {
  const artifact = release ?? await releaseFor(), token = randomBytes(32).toString('hex')
  const runtime = { dataDirectory: await mkdtemp(join(tmpdir(), 'jevable-release-service-')), ...runtimeOptions }
  const service = await startRuntimeService({ runtime, token, actor: 'fixture:service-owner', release: { snapshot: artifact.snapshot }, maxConcurrentRequests })
  cleanup.push(() => service.close())
  const client = new ReleaseClient(service.url, token, artifact.sha256)
  const call = async (command: any): Promise<any> => (await client.operation(command) as { result: unknown }).result
  return { artifact, runtime, service, token, client, call }
}

describe('exact-release standalone HTTP service', () => {
  it('returns only source display metadata and exact branch ports without running or exposing node configuration', async () => {
    const f = await fixture(await releaseFor(support))
    const info = await f.call({ operation: 'release.info' })
    expect(info.graph).toMatchObject({ name: 'Support reply', order: ['start', 'check', 'draft', 'result', 'skipped'] })
    expect(info.graph.edges).toHaveLength(4)
    expect(info.graph.edges).toEqual(expect.arrayContaining([
      { from: 'start', to: 'check' }, { from: 'check', to: 'draft', port: 'true' },
      { from: 'check', to: 'skipped', port: 'false' }, { from: 'draft', to: 'result' },
    ]))
    expect(info.graph.nodes.map((node: { id: string; kind: string }) => [node.id, node.kind])).toEqual([
      ['start', 'trigger'], ['check', 'ifElse'], ['draft', 'llm'], ['result', 'output'], ['skipped', 'output'],
    ])
    const display = JSON.stringify(info.graph)
    for (const privateField of ['config', 'prompt', 'connection', 'configured-model', 'team-model', 'nodes.start.output'])
      expect(display).not.toContain(privateField)
    expect((await f.call({ operation: 'runs.list' })).runs).toEqual([])
  })
  it('includes only configured approval action names needed by the in-container reviewer UI', async () => {
    const f = await fixture(await releaseFor(approval))
    const info = await f.call({ operation: 'release.info' })
    expect(info.graph.nodes.find((node: { id: string }) => node.id === 'review')).toMatchObject({
      id: 'review', kind: 'humanApproval', actions: ['approve', 'reject'],
    })
    expect(JSON.stringify(info.graph)).not.toContain('expiresAfter')
    expect((await f.call({ operation: 'runs.list' })).runs).toEqual([])
  })
  it.each(['01', '00'])('preserves an explicit release-client trace parent and sampling flags %s without replay', async flags => {
    const collector = createServer((_req, response) => {
      response.writeHead(200, { 'content-type': 'application/x-protobuf' }); response.end()
    })
    await new Promise<void>((resolve, reject) => { collector.once('error', reject); collector.listen(0, '127.0.0.1', resolve) })
    cleanup.push(() => new Promise<void>(resolve => { collector.close(() => resolve()); collector.closeAllConnections() }))
    const f = await fixture(undefined, { telemetry: { endpoint: `http://127.0.0.1:${(collector.address() as { port: number }).port}/v1/traces`,
      authentication: { kind: 'none' }, intervalMs: 60000, timeoutMs: 1000, flushTimeoutMs: 2000 } })
    const command = { operation: 'runs.start' as const, id: randomUUID(), input: 'PRIVATE_RELEASE_PARENT' }
    const parent = `00-11111111111111111111111111111111-2222222222222222-${flags}`
    // Exercise the inherited public signature: the release adapter must forward, not silently discard it.
    const client: import('../src/http/client.ts').RuntimeClient<import('../src/releases/service-session.ts').ReleaseOperation> = f.client
    const run: any = (await client.operation(command, parent) as { result: unknown }).result
    expect(run.traceSegments[0].parent).toMatchObject({ traceId: '11111111111111111111111111111111',
      spanId: '2222222222222222', traceFlags: flags === '01' ? 1 : 0 })
    expect((await client.operation(command, '00-33333333333333333333333333333333-4444444444444444-01') as any).result).toEqual(run)
    await expect(client.operation({ ...command, id: randomUUID() }, 'PRIVATE_INVALID_PARENT')).rejects.toHaveProperty('code', 'invalid-command')
    expect((await f.call({ operation: 'runs.list' })).runs).toHaveLength(1)
    expect(() => client.operation({ ...command, releaseSha256: f.artifact.sha256 } as any, parent)).toThrow('invalid-command')
  })
  it('reports selected release usage without running or changing approval state', async () => {
    const f = await fixture(await releaseFor(approval)), id = randomUUID()
    const run = await f.call({ operation: 'runs.start', id, input: { message: 'PRIVATE_USAGE_REVIEW' } })
    const before = await f.call({ operation: 'runs.events', id })
    const report = await f.call({ operation: 'usage.report', selection: { schemaVersion: 1, runs: [{ id, revision: run.revision }] } })
    expect(report.summary.inputTokens).toMatchObject({ reportedTokens: '0', coverage: 'complete-for-observed-intents' })
    expect(report.runs[0]).toMatchObject({ id, workflowStatus: 'waiting' })
    expect(JSON.stringify(report)).not.toContain('PRIVATE_USAGE_REVIEW')
    expect(await f.call({ operation: 'runs.events', id })).toEqual(before)
    expect(await f.call({ operation: 'runs.show', id })).toEqual(run)
  })
  it('retains cooperative pause controls for the exact release without executing on retry', async () => {
    const f = await fixture(await releaseFor(echo)), id = randomUUID()
    const start = await f.call({ operation: 'runs.start', id, input: 'input', paused: true })
    const command = { operation: 'runs.advance', id, requestId: randomUUID(), expectedCheckpointSha256: start.checkpointSha256, mode: 'pause' }
    const paused = await f.call(command)
    expect(paused).toMatchObject({ status: 'paused', steps: [], pause: { status: 'at-safe-checkpoint' } })
    expect(await f.call(command)).toEqual(paused)
    expect((await f.call({ ...command, requestId: randomUUID(), expectedCheckpointSha256: paused.checkpointSha256, mode: 'continue' })).status).toBe('completed')
  })

  it('retains breakpoints and permits guarded continuation for the exact release', async () => {
    const f = await fixture(), id = randomUUID()
    const start = await f.call({ operation: 'runs.start', id, input: 'input', paused: true })
    const command = { operation: 'runs.advance', id, requestId: randomUUID(), expectedCheckpointSha256: start.checkpointSha256,
      mode: 'continue', breakpoints: ['start'] }
    const hit = await f.call(command)
    expect(hit).toMatchObject({ steps: [], breakpoint: { nodeId: 'start' } })
    expect(await f.call(command)).toEqual(hit)
    const done = await f.call({ ...command, requestId: randomUUID(), expectedCheckpointSha256: hit.checkpointSha256 })
    expect(done).toMatchObject({ status: 'completed', output: 'input' })
  })
  it('starts without a project/run, exposes truthful capabilities and executes only pinned source', async () => {
    const f = await fixture(), caps: any = await f.client.capabilities()
    expect(caps).toMatchObject({ mode: 'release-execution', authoring: false, htmlPreview: false, operatorHtml: true, providerConfiguration: false,
      release: { id: f.artifact.snapshot.id, sha256: f.artifact.sha256 }, dependencies: { harness: false, skill: false } })
    expect(caps.runtimeWorkTelemetry).toEqual(capabilities().workflowRuntime.runtimeWorkTelemetry)
    expect(caps.httpAsyncCapacityTelemetry).toEqual(capabilities().workflowRuntime.httpAsyncCapacityTelemetry)
    expect(caps.operations).not.toContain('telemetry.flush')
    expect(caps.api.endpoints).toEqual(['/', '/v1/openapi.json', '/v1/capabilities', '/v1/health', '/v1/operations'])
    expect(caps.api.servesHtml).toBe(true)
    expect(await f.client.health()).toMatchObject({ status: 'ready', execution: 'not-run-by-health-check' })
    expect((await f.call({ operation: 'runs.list' })).runs).toEqual([])
    expect(await f.call({ operation: 'release.check' })).toMatchObject({ runtimeReadiness: 'ready', execution: 'not-run' })
    const info = await f.call({ operation: 'release.info' })
    expect(info).toMatchObject({ release: { sha256: f.artifact.sha256 }, execution: 'not-run',
      graph: { name: 'Standalone echo', order: ['start', 'result'],
        nodes: [{ id: 'start', kind: 'trigger' }, { id: 'result', kind: 'output' }],
        edges: [{ from: 'start', to: 'result' }] } })
    expect(JSON.stringify(info.graph)).not.toContain('config')
    expect(JSON.stringify(info.graph)).not.toContain('${{ inputs }}')
    expect((await f.call({ operation: 'runs.list' })).runs).toEqual([])
    const id = randomUUID(), command = { operation: 'runs.start', id, input: 'PRIVATE_SERVICE_INPUT' }, run = await f.call(command)
    expect(run).toMatchObject({ id, status: 'completed', output: 'PRIVATE_SERVICE_INPUT', release: { sha256: f.artifact.sha256 } })
    expect(await f.call(command)).toEqual(run)
    await expect(f.call({ ...command, input: 'different' })).rejects.toHaveProperty('code', 'conflict')
    await f.service.close()
    const rt = await LocalRuntime.open(f.runtime); cleanup.push(() => rt.close())
    expect(rt.projects()).toEqual([]); expect(rt.list()).toHaveLength(1)
  })

  it('serves an owner-authenticated OpenAPI contract derived from every accepted release operation', async () => {
    const f = await fixture(), route = f.service.url + '/v1/openapi.json'
    expect((await fetch(route)).status).toBe(401)
    const response = await fetch(route, { headers: { authorization: `Bearer ${f.token}` } })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const spec: any = await response.json(), caps: any = await f.client.capabilities()
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.paths['/v1/operations'].post.security).toBeUndefined()
    expect(spec.security).toEqual([{ ownerBearer: [] }])
    const schema = spec.components.schemas.ReleaseOperation
    expect(schema.oneOf.map((item: any) => item.properties.operation.const).sort()).toEqual([...caps.operations].sort())
    for (const item of schema.oneOf) {
      expect(item.required).toContain('releaseSha256')
      expect(item.properties.releaseSha256.pattern).toBe('^[a-f0-9]{64}$')
    }
    const refs: string[] = []
    const visit = (value: any): void => {
      if (!value || typeof value !== 'object') return
      if (typeof value.$ref === 'string') refs.push(value.$ref)
      for (const child of Object.values(value)) visit(child)
    }
    visit(schema)
    for (const ref of refs) {
      expect(ref.startsWith('#/components/schemas/ReleaseOperation/')).toBe(true)
      const parts = ref.slice(2).split('/'), found = parts.reduce((current, key) => current?.[key], spec as any)
      expect(found).toBeDefined()
    }
    expect(JSON.stringify(spec)).not.toContain(echo)
    expect((await f.call({ operation: 'runs.list' })).runs).toEqual([])
    expect((await fetch(route, { method: 'POST', headers: { authorization: `Bearer ${f.token}` } })).status).toBe(405)
  })

  it('requires an exact release guard and refuses authoring, source replacement, actor overrides and preview routes', async () => {
    const f = await fixture(), raw = (body: unknown) => fetch(f.service.url + '/v1/operations', { method: 'POST',
      headers: { Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json', 'X-Jevable-Protocol': PROTOCOL_VERSION }, body: JSON.stringify(body) })
    expect((await raw({ operation: 'runs.start', id: randomUUID(), input: 'x' })).status).toBe(400)
    expect((await raw({ operation: 'runs.start', id: randomUUID(), input: 'x', releaseSha256: 'b'.repeat(64) })).status).toBe(409)
    for (const command of [
      { operation: 'projects.list' }, { operation: 'providers.list' }, { operation: 'credentials.set', ref: 'secret', value: 'PRIVATE_SECRET', expectedGeneration: 0 },
      { operation: 'releases.list' }, { operation: 'releases.show', id: f.artifact.snapshot.id },
      { operation: 'releases.create', id: randomUUID(), projectId: randomUUID(), expectedGeneration: 1,
        revision: f.artifact.snapshot.workflow.revision, version: '2.0.0', runtimeStorage: 'sqlite', runtime: f.artifact.snapshot.runtime },
      { operation: 'runs.start', id: randomUUID(), input: 'x', yaml: approval },
      { operation: 'runs.start', id: randomUUID(), input: 'x', actor: 'spoofed' },
      { operation: 'runs.resume', id: randomUUID() }, { operation: 'release.check', yaml: echo },
    ]) await expect(f.call(command)).rejects.toHaveProperty('code', 'invalid-command')
    await expect(new ReleaseClient(f.service.url, f.token, 'b'.repeat(64)).operation({ operation: 'runs.list' })).rejects.toHaveProperty('code', 'conflict')
    expect(() => f.client.operation({ operation: 'runs.list', releaseSha256: 'b'.repeat(64) } as any)).toThrow('invalid-command')
    const denied = await fetch(f.service.url + '/v1/preview/bootstrap', { method: 'POST', headers: { Authorization: `Bearer ${f.token}`,
      'X-Jevable-Protocol': PROTOCOL_VERSION, 'Content-Type': 'application/json' }, body: '{}' })
    expect(denied.status).toBe(404)
    expect((await f.call({ operation: 'runs.list' })).runs).toEqual([])
  })

  it('never reads, advances, decides, cancels or exports another release or ordinary run from the same store', async () => {
    const selected = await releaseFor(), foreign = await releaseFor(), dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-release-shared-'))
    const rt = await LocalRuntime.open({ dataDirectory }), ordinary = await rt.run(echo, 'PRIVATE_ORDINARY'), other = await rt.runRelease(foreign.snapshot, 'PRIVATE_OTHER')
    await rt.close()
    const f = await fixture(selected, { dataDirectory })
    expect((await f.call({ operation: 'runs.list' })).runs).toEqual([])
    for (const id of [ordinary.id, other.id]) {
      await expect(f.call({ operation: 'usage.report', selection: { schemaVersion: 1, runs: [{ id, revision: selected.snapshot.workflow.revision }] } })).rejects.toHaveProperty('code', 'not-found')
      for (const operation of ['runs.show', 'runs.inspect', 'runs.events', 'runs.export', 'approvals.show'])
        await expect(f.call({ operation, id })).rejects.toHaveProperty('code', 'not-found')
      await expect(f.call({ operation: 'runs.cancel', id, requestId: randomUUID() })).rejects.toHaveProperty('code', 'not-found')
      await expect(f.call({ operation: 'runs.advance', id, requestId: randomUUID(), expectedCheckpointSha256: 'a'.repeat(64), mode: 'continue' })).rejects.toHaveProperty('code', 'not-found')
      await expect(f.call({ operation: 'approvals.decide', id, attemptId: randomUUID(), action: 'approve' })).rejects.toHaveProperty('code', 'not-found')
      await expect(f.call({ operation: 'runs.start', id, input: 'x' })).rejects.toHaveProperty('code', 'conflict')
    }
  })

  it('persists approval waits across service replacement and records the server actor on explicit guarded continuation', async () => {
    const f = await fixture(await releaseFor(approval)), id = randomUUID(), command = { operation: 'runs.start', id, input: { message: 'PRIVATE_REVIEW' }, paused: true }
    const paused = await f.call(command)
    const stepCommand = { operation: 'runs.advance', id, requestId: randomUUID(), expectedCheckpointSha256: paused.checkpointSha256, mode: 'step' }
    const stepped = await f.call(stepCommand); expect(await f.call(stepCommand)).toEqual(stepped)
    const waiting = await f.call({ ...stepCommand, requestId: randomUUID(), expectedCheckpointSha256: stepped.checkpointSha256, mode: 'continue' })
    expect(waiting.status).toBe('waiting'); await f.service.close()
    const next = await fixture(f.artifact, f.runtime)
    expect(next.service.instanceId).not.toBe(f.service.instanceId)
    expect(await next.call({ operation: 'runs.show', id })).toEqual(waiting)
    expect(await next.call(command)).toEqual(waiting)
    expect((await next.call({ operation: 'approvals.show', id })).review.input.input).toBe('PRIVATE_REVIEW')
    await expect(next.call({ operation: 'approvals.decide', id, attemptId: randomUUID(), action: 'approve' })).rejects.toHaveProperty('code', 'conflict')
    const decided = await next.call({ operation: 'approvals.decide', id, attemptId: waiting.attemptId, action: 'approve', pauseAfter: true })
    expect(decided.status).toBe('paused')
    const completed = await next.call({ operation: 'runs.advance', id, requestId: randomUUID(), expectedCheckpointSha256: decided.checkpointSha256, mode: 'continue' })
    expect(completed).toMatchObject({ status: 'completed', output: 'approve' })
    const evidence = await next.call({ operation: 'runs.export', id })
    expect(evidence.snapshot.private).toBeUndefined(); expect(JSON.stringify(evidence)).not.toContain('PRIVATE_REVIEW')
    const privateEvidence = await next.call({ operation: 'runs.export', id, includePrivate: true })
    expect(JSON.stringify(privateEvidence)).toContain('fixture:service-owner')
    expect((await next.call({ operation: 'runs.events', id })).privatePayloads).toBe('excluded')
  })

  it('retains explicit cancellation identity without resuming or rolling back the wait', async () => {
    const f = await fixture(await releaseFor(approval)), id = randomUUID()
    await f.call({ operation: 'runs.start', id, input: { message: 'review' } })
    const command = { operation: 'runs.cancel', id, requestId: randomUUID() }, stopped = await f.call(command)
    expect(stopped).toMatchObject({ status: 'cancelled', previousStatus: 'waiting', cancellation: { actor: 'fixture:service-owner' } })
    expect(await f.call(command)).toEqual(stopped)
    await expect(f.call({ operation: 'runs.advance', id, requestId: randomUUID(), expectedCheckpointSha256: stopped.checkpointSha256, mode: 'continue' })).rejects.toHaveProperty('code', 'conflict')
  })

  it('retains transport guards and serves an inert, secret-free release shell', async () => {
    const f = await fixture(), headers = { Authorization: `Bearer ${f.token}`, 'X-Jevable-Protocol': PROTOCOL_VERSION }
    expect((await fetch(f.service.url + '/v1/health')).status).toBe(401)
    const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(f.service.url + '/v1/health', { headers: { ...headers, Host: 'evil.example' } }, response => {
        response.resume(); response.once('end', () => resolve(response.statusCode))
      }); req.once('error', reject); req.end()
    })
    expect(hostStatus).toBe(403)
    expect((await fetch(f.service.url + '/v1/health', { headers: { ...headers, Origin: 'https://evil.example' } })).status).toBe(403)
    expect((await fetch(f.service.url + '/v1/health?token=ignored', { headers })).status).toBe(400)
    expect((await fetch(f.service.url + '/v1/health', { headers: { ...headers, 'X-Jevable-Protocol': 'future' } })).status).toBe(409)
    const page = await fetch(f.service.url + '/')
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(page.headers.get('cache-control')).toBe('no-store')
    const shell = await page.text()
    expect(shell).toContain('Open this workflow')
    expect(shell).not.toContain(f.token)
    expect(shell).not.toContain(f.artifact.sha256)
    expect(shell).not.toContain('Standalone echo')
    expect(shell).not.toContain('PRIVATE_SERVICE_INPUT')
    expect((await f.call({ operation: 'runs.list' })).runs).toEqual([])
  })

  it('pins startup input before async ownership acquisition and rejects mixed preview/release modes without a lock', async () => {
    const release = await releaseFor(), dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-release-startup-')), token = randomBytes(32).toString('hex')
    const snapshot = structuredClone(release.snapshot)
    const starting = startRuntimeService({ runtime: { dataDirectory }, token, actor: 'test', release: { snapshot } })
    snapshot.id = randomUUID(); snapshot.workflow.yaml = 'wrong'
    const service = await starting; cleanup.push(() => service.close())
    expect(service.release?.sha256).toBe(release.sha256); await service.close()
    await expect(startRuntimeService({ runtime: { dataDirectory }, token, actor: 'test', release: { snapshot: release.snapshot }, preview: { source: echo } })).rejects.toHaveProperty('code', 'invalid-command')
    const rt = await LocalRuntime.open({ dataDirectory }); cleanup.push(() => rt.close())
    expect(rt.list()).toEqual([]); expect(rt.projects()).toEqual([])
  })

  it('keeps exact-release cancellation available at full ordinary capacity', async () => {
    const entered = gate(), finish = gate(), models: NonNullable<LocalRuntimeOptions['models']> = {
      admit() {}, async verify() {}, async execute(_node, _input, _attempt, signal) {
        entered.release()
        await Promise.race([finish.promise, new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(Error('aborted')), { once: true }))])
        return { output: 'done', usage: { tries: 1 } }
      },
    }
    const f = await fixture(await releaseFor(modelSource), { models }, 1)
    cleanup.push(async () => finish.release())
    const id = randomUUID(), running = f.call({ operation: 'runs.start', id, input: 'private' })
    await entered.promise
    await expect(f.call({ operation: 'runs.list' })).rejects.toHaveProperty('code', 'concurrency-limit')
    const requestId = randomUUID(), request = await f.call({ operation: 'runs.cancel', id, requestId })
    expect(request.cancellation.id).toBe(requestId)
    const stopped = await running; expect(stopped.status).toBe('cancelled')
    expect(await f.call({ operation: 'runs.cancel', id, requestId })).toEqual(stopped)
  })

  it('drains a disconnected unsettled call before releasing storage and never redispatches on restart', async () => {
    const entered = gate(), finish = gate(), execute = vi.fn(async () => { entered.release(); await finish.promise; throw Error('PRIVATE_LOST_TRANSPORT') })
    const models: NonNullable<LocalRuntimeOptions['models']> = { admit() {}, execute, async verify() {} }
    const f = await fixture(await releaseFor(modelSource), { models })
    cleanup.push(async () => finish.release())
    const command = { operation: 'runs.start', id: randomUUID(), input: 'private' }, controller = new AbortController()
    const pending = fetch(f.service.url + '/v1/operations', { method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json', 'X-Jevable-Protocol': PROTOCOL_VERSION },
      body: JSON.stringify({ ...command, releaseSha256: f.artifact.sha256 }) }).catch(() => undefined)
    await entered.promise; controller.abort(); await pending
    expect(await f.service.close(5)).toMatchObject({ status: 'draining', activeRequests: 1 })
    await expect(LocalRuntime.open(f.runtime)).rejects.toHaveProperty('code', 'busy')
    finish.release(); await f.service.closed
    const next = await fixture(f.artifact, f.runtime)
    expect(await next.call(command)).toMatchObject({ status: 'executing', recovery: expect.stringContaining('uncertain') })
    expect(execute).toHaveBeenCalledTimes(1)
  })
})

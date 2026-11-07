import { afterEach, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request, createServer, type Server } from 'node:http'
import { startRuntimeService, RuntimeClient, type RuntimeServiceOptions, type RuntimeOperation } from '../src/http/index.ts'
import { LocalRuntime, type ModelCalls } from '../src/runtime/index.ts'
import { PROTOCOL_VERSION } from '../src/capabilities.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const token = randomBytes(32).toString('hex')
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(options: Partial<RuntimeServiceOptions> = {}) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-http-'))
  const service = await startRuntimeService({ runtime: { dataDirectory }, token, actor: 'local:http-owner', ...options })
  cleanup.push(async () => { await service.close(); await service.closed })
  const client = new RuntimeClient(service.url, token)
  const operation = async (command: RuntimeOperation) => (await client.operation(command) as { result: any }).result
  const raw = (body: unknown, headers: Record<string, string> = {}, path = '/v1/operations', method = 'POST') =>
    fetch(service.url + path, { method, headers: { Authorization: `Bearer ${token}`, 'X-Jevable-Protocol': PROTOCOL_VERSION,
      'Content-Type': 'application/json', ...headers }, ...(method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) })
  return { service, client, operation, raw, dataDirectory }
}
function wire(url: string, headers: string[], body: string | Buffer = '') {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const call = request(url + '/v1/operations', { method: 'POST', headers }, response => {
      let data = ''; response.setEncoding('utf8'); response.on('data', chunk => { data += chunk })
      response.on('end', () => resolve({ status: response.statusCode!, body: data }))
    })
    call.on('error', reject); call.end(body)
  })
}
const gate = () => {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
const modelSource = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'model', name: 'Model' },
  spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
    write: { type: 'llm', config: { provider: 'fixture', model: 'fixture', connection: { mode: 'workspace', id: 'fixture' },
      prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 20, stream: false },
      execution: { timeoutSeconds: 60, maxAttempts: 1 }, historyScope: 'none' } },
    end: { type: 'output', config: { value: '${{ nodes.write.output }}' } } },
  edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }] } })

describe('standalone authenticated loopback API', () => {
  it('checks an optional runtime-instance guard before executing and rejects duplicate guards', async () => {
    const f = await fixture(), id = randomUUID(), operation = { operation: 'runs.start', id, yaml: echo, input: 'guarded' } as const
    const wrong = new RuntimeClient(f.service.url, token, 1000, 20_000_000, { expectedInstanceId: randomUUID() })
    await expect(wrong.operation(operation)).rejects.toMatchObject({ code: 'instance-mismatch', status: 409 })
    expect((await f.operation({ operation: 'runs.list' })).runs).toHaveLength(0)
    const body = JSON.stringify(operation)
    const duplicate = await wire(f.service.url, ['Host', new URL(f.service.url).host, 'Authorization', `Bearer ${token}`,
      'Content-Type', 'application/json', 'Content-Length', String(Buffer.byteLength(body)), 'X-Jevable-Protocol', PROTOCOL_VERSION,
      'X-Jevable-Instance', f.service.instanceId, 'X-Jevable-Instance', f.service.instanceId], body)
    expect(duplicate.status).toBe(400)
    const pinned = new RuntimeClient(f.service.url, token, 1000, 20_000_000, { expectedInstanceId: f.service.instanceId })
    expect(await pinned.capabilities()).toMatchObject({ instanceId: f.service.instanceId, api: { instanceGuard: 'x-jevable-instance' } })
    expect(await pinned.operation(operation)).toMatchObject({ instanceId: f.service.instanceId, result: { id, status: 'completed' } })
    expect(() => new RuntimeClient(f.service.url, token, 1000, 20_000_000, { expectedInstanceId: 'not-uuid' })).toThrow()
  })

  it('a previously pinned client cannot execute after clean service replacement on the same endpoint', async () => {
    const f = await fixture(), client = new RuntimeClient(f.service.url, token, 1000, 20_000_000, { expectedInstanceId: f.service.instanceId })
    const port = Number(new URL(f.service.url).port)
    await f.service.close(); await f.service.closed
    const replacement = await startRuntimeService({ runtime: { dataDirectory: f.dataDirectory }, token, port, actor: 'local:replacement' })
    cleanup.push(async () => { await replacement.close(); await replacement.closed })
    await expect(client.operation({ operation: 'runs.start', id: randomUUID(), yaml: echo, input: 'must not run' })).rejects.toMatchObject({ code: 'instance-mismatch' })
    const reader = new RuntimeClient(replacement.url, token)
    expect(await reader.operation({ operation: 'runs.list' })).toMatchObject({ result: { runs: [] } })
  })
  it('advertises and serves explicit metadata pages without changing legacy list responses', async () => {
    const f = await fixture()
    const capabilities = await (await f.raw({}, {}, '/v1/capabilities', 'GET')).json()
    expect(capabilities.api.operations).toMatchObject({ storage: 'sqlite', runEvidenceSchemaVersion: 1,
      pagination: { required: false, maxLimit: 200 } })
    const ids = [randomUUID(), randomUUID()].sort()
    for (const id of ids) await f.operation({ operation: 'runs.start', id, yaml: echo, input: 'page me' })
    const page = await f.operation({ operation: 'runs.list', page: { limit: 1 } })
    expect(page).toMatchObject({ schemaVersion: 2, runs: [{ id: ids[0] }], nextCursor: ids[0] })
    expect((await f.operation({ operation: 'runs.list', page: { after: page.nextCursor, limit: 1 } })).nextCursor).toBe(null)
    expect((await f.operation({ operation: 'runs.list' })).runs).toHaveLength(2)
    expect((await f.raw({ operation: 'runs.list', page: { limit: 201 } })).status).toBe(400)
  })

  it('forwards persistent breakpoints through the management API without dispatch at a hit', async () => {
    const f = await fixture(), id = randomUUID()
    const start = await f.operation({ operation: 'runs.start', id, yaml: echo, input: 'input', paused: true })
    const command = { operation: 'runs.advance', id, requestId: randomUUID(), mode: 'continue',
      expectedCheckpointSha256: start.checkpointSha256, breakpoints: ['start', 'result'] } as const
    const hit = await f.operation({ ...command, breakpoints: [...command.breakpoints] })
    expect(hit).toMatchObject({ steps: [], breakpoint: { nodeId: 'start' } })
    expect(await f.operation({ ...command, breakpoints: [...command.breakpoints] })).toEqual(hit)
    const next = await f.operation({ ...command, breakpoints: ['result'], requestId: randomUUID(), expectedCheckpointSha256: hit.checkpointSha256 })
    expect(next).toMatchObject({ breakpoint: { nodeId: 'result' } })
  })
  it('starts paused and admits guarded controls with server-owned actors and no double step on retry', async () => {
    const f = await fixture(), id = randomUUID()
    const paused = await f.operation({ operation: 'runs.start', id, yaml: echo, input: 'debugged', paused: true })
    expect(paused).toMatchObject({ status: 'paused', steps: [], startedPaused: true })
    const command = { operation: 'runs.advance', id, requestId: randomUUID(), mode: 'step', expectedCheckpointSha256: paused.checkpointSha256 } as const
    expect((await f.raw({ ...command, actor: 'spoofed' })).status).toBe(400)
    const step = await f.operation(command)
    expect(step.status).toBe('paused'); expect(step.steps).toHaveLength(1)
    expect(await f.operation(command)).toEqual(step)
    expect((await f.raw({ ...command, requestId: randomUUID() })).status).toBe(409)
    const completed = await f.operation({ ...command, requestId: randomUUID(), mode: 'continue', expectedCheckpointSha256: step.checkpointSha256 })
    expect(completed).toMatchObject({ status: 'completed', output: 'debugged' })
    const inspected = await f.operation({ operation: 'runs.inspect', id })
    expect(inspected.run.controlRequests.map((item: any) => item.actor)).toEqual(['local:http-owner', 'local:http-owner'])
  })

  it('reads a guard and submits cooperative pause through the bounded control slot during an active model', async () => {
    const entered = gate(), release = gate(); let calls = 0
    const models: ModelCalls = { admit() {}, async verify() {}, async execute(_n, _i, _a, signal) {
      calls++; entered.release(); await release.promise; expect(signal?.aborted).toBe(false)
      return { output: 'done', usage: { tries: 1 } }
    } }
    const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-http-pause-'))
    const f = await fixture({ runtime: { dataDirectory, models }, maxConcurrentRequests: 1 })
    const id = randomUUID(), running = f.operation({ operation: 'runs.start', id, yaml: modelSource, input: 'PRIVATE_INPUT' })
    try {
      await entered.promise
      expect((await f.raw({ operation: 'runs.list' })).status).toBe(429)
      const observed = await f.operation({ operation: 'runs.show', id })
      const command = { operation: 'runs.advance', id, mode: 'pause', requestId: randomUUID(), expectedCheckpointSha256: observed.checkpointSha256 } as const
      expect((await f.raw({ ...command, mode: 'continue' })).status).toBe(429)
      expect((await f.raw({ ...command, actor: 'spoofed' })).status).toBe(400)
      const paused = await f.operation(command)
      expect(paused).toMatchObject({ status: 'executing', lastControl: { requestId: command.requestId, mode: 'pause' } })
      expect(await f.operation(command)).toEqual(paused)
      expect((await f.raw({ ...command, requestId: randomUUID() })).status).toBe(409)
      release.release(); const settled = await running
      expect(settled).toMatchObject({ status: 'paused', pause: { status: 'at-safe-checkpoint' } })
      expect((await f.operation({ ...command, requestId: randomUUID(), mode: 'continue', expectedCheckpointSha256: settled.checkpointSha256 })).status).toBe('completed')
      expect(calls).toBe(1)
      const evidence = await f.operation({ operation: 'runs.export', id })
      expect(evidence.snapshot.journal.some((event: any) => event.mode === 'pause')).toBe(true)
      expect(JSON.stringify(evidence)).not.toContain('PRIVATE_INPUT')
    } finally { release.release(); await running.catch(() => {}) }
  })

  it('commits an explicitly paused approval decision without running its downstream node', async () => {
    const f = await fixture(), id = randomUUID()
    const waiting = await f.operation({ operation: 'runs.start', id, yaml: approval, input: { message: 'Review debug run' } })
    const paused = await f.operation({ operation: 'approvals.decide', id, attemptId: waiting.attemptId, action: 'approve', pauseAfter: true })
    expect(paused.status).toBe('paused')
    expect((await f.operation({ operation: 'runs.show', id })).checkpointSha256).toBe(paused.checkpointSha256)
    expect((await f.operation({ operation: 'runs.advance', id, requestId: randomUUID(), mode: 'step', expectedCheckpointSha256: paused.checkpointSha256 })).status).toBe('completed')
  })

  it('exports redacted evidence by default and private evidence only by explicit strict boolean', async () => {
    const f = await fixture(), id = randomUUID()
    await f.operation({ operation: 'runs.start', id, yaml: echo, input: 'PRIVATE_HTTP_EVIDENCE' })
    const events = await f.operation({ operation: 'runs.events', id })
    const evidence = await f.operation({ operation: 'runs.export', id })
    expect(evidence.snapshot.run).toMatchObject({ id, status: 'completed' })
    expect(JSON.stringify(evidence)).not.toContain('PRIVATE_HTTP_EVIDENCE')
    expect((await f.operation({ operation: 'runs.export', id, includePrivate: true })).snapshot.private.run.input).toBe('PRIVATE_HTTP_EVIDENCE')
    expect((await f.raw({ operation: 'runs.export', id, includePrivate: 'true' })).status).toBe(400)
    expect(await f.operation({ operation: 'runs.events', id })).toEqual(events)
  })

  it('transfers explicitly included tests as fresh drafts through the owner JSON API without executing', async () => {
    const f = await fixture()
    const project = await f.operation({ operation: 'projects.command', command: { operation: 'create', title: 'Transfer tests', yaml: echo } })
    const batch = await f.operation({ operation: 'tests.generate', id: randomUUID(), limit: 1,
      project: { id: project.id, generation: project.generation, revision: project.acceptedRevision } })
    const sourceCase = batch.snapshot.cases[0]
    await f.operation({ operation: 'tests.command', command: { operation: 'accept', id: sourceCase.id,
      expectedGeneration: 1, reviewedSha256: sourceCase.sha256 } })
    const command = { operation: 'projects.export' as const, id: project.id, expectedGeneration: project.generation, revision: project.acceptedRevision }
    expect((await f.operation(command)).version).toBe(1)
    const bundle = await f.operation({ ...command, tests: true }), json = JSON.stringify(bundle)
    expect(bundle.version).toBe(2)
    const review = await f.operation({ operation: 'projects.import.inspect', json })
    const imported = await f.operation({ operation: 'projects.import', json, reviewedSha256: review.sha256 })
    const list = await f.operation({ operation: 'tests.list' })
    const test = list.tests.find((item: any) => item.project.id === imported.id)
    expect(test.status).toBe('draft'); expect(test.id).not.toBe(sourceCase.id)
    expect((await f.operation({ operation: 'tests.show', id: test.id })).importedFrom.source.id).toBe(sourceCase.id)
    expect((await f.operation({ operation: 'runs.list' })).runs).toEqual([])
  })

  it('keeps a bounded cancellation slot available when a workflow fills request capacity', async () => {
    const entered = gate(), release = gate()
    const models: ModelCalls = { admit() {}, async verify() {}, async execute(_n, _i, _a, signal) {
      entered.release()
      await Promise.race([release.promise, new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(Error('cancelled')), { once: true }))])
      return { output: 'done', usage: { tries: 1 } }
    } }
    const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-http-cancel-'))
    const { operation, raw, service } = await fixture({ runtime: { dataDirectory, models }, maxConcurrentRequests: 1 })
    cleanup.push(async () => release.release())
    const id = randomUUID(), requestId = randomUUID(), running = operation({ operation: 'runs.start', id, yaml: modelSource, input: 'private' })
    await entered.promise
    expect((await raw({ operation: 'runs.list' })).status).toBe(429)
    expect((await raw({ operation: 'runs.cancel', id, requestId, actor: 'spoofed' })).status).toBe(400)
    const request = await operation({ operation: 'runs.cancel', id, requestId })
    expect(request.cancellation).toMatchObject({ id: requestId, actor: 'local:http-owner' })
    const stopped = await running
    expect(stopped.status).toBe('cancelled')
    expect(await operation({ operation: 'runs.cancel', id, requestId })).toEqual(stopped)
    await service.close()
    const owner = await LocalRuntime.open({ dataDirectory, models })
    try { expect((await owner.show(id)).state.status).toBe('cancelled') } finally { await owner.close() }
  })

  it('generates only reviewable drafts with a server-owned actor and idempotent batch receipt', async () => {
    const { operation, raw } = await fixture()
    // A model-bearing workflow must be sampleable without provider setup or executing its graph.
    const project = await operation({ operation: 'projects.command', command: { operation: 'create', title: 'Generated', yaml: modelSource } })
    const command = { operation: 'tests.generate' as const, id: randomUUID(),
      project: { id: project.id, generation: 1, revision: project.acceptedRevision } }
    expect((await raw({ ...command, actor: 'spoofed' })).status).toBe(400)
    expect((await raw({ ...command, limit: 33 })).status).toBe(400)
    const generated = await operation(command)
    expect(generated.snapshot).toMatchObject({ actor: 'local:http-owner', execution: 'not-run', status: 'review-required', request: { limit: 12 } })
    expect(generated.snapshot.cases.length).toBeGreaterThan(0)
    expect(await operation(command)).toEqual(generated)
    expect(await operation({ operation: 'tests.generation', id: command.id })).toEqual(generated)
    const summaries = await operation({ operation: 'tests.generations' })
    expect(summaries.generations).toHaveLength(1)
    expect(summaries.generations[0]).not.toHaveProperty('cases')
    expect((await operation({ operation: 'tests.list' })).tests.every((test: any) => test.status === 'draft')).toBe(true)
    expect((await operation({ operation: 'runs.list' })).runs).toEqual([])
    expect((await raw({ ...command, limit: 1 })).status).toBe(409)
    const first = generated.snapshot.cases[0]
    expect((await raw({ operation: 'tests.run', test: { id: first.id, generation: 1, sha256: first.sha256 }, runId: randomUUID() })).status).toBe(409)
  })

  it('reviews revision-pinned tests with server-owned actors and retained expected/actual inspection', async () => {
    const { operation, raw } = await fixture()
    const project = await operation({ operation: 'projects.command', command: { operation: 'create', title: 'Tests', yaml: echo } })
    const definition = { title: 'API test', project: { id: project.id, generation: 1, revision: project.acceptedRevision },
      input: 'private test input', expectations: [{ kind: 'status', value: 'completed' }, { kind: 'output-equals', value: 'wrong expectation' }] }
    expect((await raw({ operation: 'tests.command', command: { operation: 'create', definition, actor: 'spoofed' } })).status).toBe(400)
    const draft = await operation({ operation: 'tests.command', command: { operation: 'create', definition } })
    expect(draft.actor).toBe('local:http-owner')
    expect((await raw({ operation: 'tests.run', test: { id: draft.id, generation: 1, sha256: draft.sha256 }, runId: randomUUID() })).status).toBe(409)
    const test = await operation({ operation: 'tests.command', command: { operation: 'accept', id: draft.id,
      expectedGeneration: 1, reviewedSha256: draft.sha256 } })
    const runId = randomUUID(), command = { operation: 'tests.run' as const, test: { id: test.id, generation: 2, sha256: test.sha256 }, runId }
    const result = await operation(command)
    expect(result).toMatchObject({ assessment: 'failed', workflowStatus: 'completed' })
    expect(result.checks[1]).not.toHaveProperty('expected'); expect(result.checks[1]).not.toHaveProperty('actual')
    expect(await operation(command)).toEqual(result)
    expect((await operation({ operation: 'tests.result', runId, inspect: true })).checks[1]).toMatchObject({ expected: 'wrong expectation', actual: 'private test input' })
    expect(JSON.stringify(await operation({ operation: 'tests.list' }))).not.toContain('private test input')
  })

  it('discovers its protocol, serves JSON only and owns its independent data directory', async () => {
    const { service, client, dataDirectory, raw } = await fixture()
    expect(await client.capabilities()).toMatchObject({ instanceId: service.instanceId,
      dependencies: { harness: false, desktop: false }, api: { protocol: PROTOCOL_VERSION, servesHtml: false } })
    expect(await client.health()).toMatchObject({ status: 'ready', instanceId: service.instanceId })
    await expect(LocalRuntime.open({ dataDirectory })).rejects.toMatchObject({ code: 'busy' })
    expect((await raw({}, {}, '/preview.html', 'GET')).status).toBe(404)
    expect(await service.close()).toMatchObject({ status: 'closed' })
    const reopened = await LocalRuntime.open({ dataDirectory }); await reopened.close()
  })

  it.each(['', 'Bearer wrong', `Bearer ${'0'.repeat(64)}`])('rejects missing or invalid authorization (%#)', async authorization => {
    const { raw } = await fixture()
    const response = await raw({ operation: 'projects.list' }, { Authorization: authorization })
    expect(response.status).toBe(401)
    const text = await response.text(); expect(text).not.toContain(token)
    expect(JSON.parse(text).code).toBe('unauthorized')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.has('access-control-allow-origin')).toBe(false)
  })

  it.each([
    [{ Origin: 'http://attacker.invalid' }, 403, 'origin-rejected'],
    [{ Origin: 'null' }, 403, 'origin-rejected'],
    [{ 'Sec-Fetch-Site': 'cross-site' }, 403, 'origin-rejected'],
    [{ 'X-Jevable-Protocol': 'future' }, 409, 'protocol-mismatch'],
  ] as const)('rejects boundary mismatch %#', async (headers, status, code) => {
    const { raw } = await fixture()
    const response = await raw({ operation: 'projects.list' }, headers)
    expect(response.status).toBe(status); expect(await response.json()).toMatchObject({ code })
  })

  it('rejects duplicate authentication, token URLs and method switching', async () => {
    const { raw, service } = await fixture()
    const result = await wire(service.url, ['Host', new URL(service.url).host, 'Authorization', `Bearer ${token}`,
      'Authorization', `Bearer ${token}`, 'X-Jevable-Protocol', PROTOCOL_VERSION, 'Content-Type', 'application/json'], '{}')
    expect(result.status).toBe(400); expect(JSON.parse(result.body).code).toBe('ambiguous-headers')
    const wrongHost = await wire(service.url, ['Host', 'attacker.invalid', 'Authorization', `Bearer ${token}`,
      'X-Jevable-Protocol', PROTOCOL_VERSION, 'Content-Type', 'application/json'], '{}')
    expect(wrongHost.status).toBe(403); expect(JSON.parse(wrongHost.body).code).toBe('host-rejected')
    expect((await raw({}, {}, '/v1/health?token=hidden', 'GET')).status).toBe(400)
    expect((await raw({}, {}, '/v1/operations', 'GET')).status).toBe(405)
    expect((await raw({}, {}, '/v1/operations', 'OPTIONS')).status).toBe(405)
    expect((await raw({ operation: 'projects.list' }, { Origin: service.url })).status).toBe(200)
  })

  it.each([
    ['{', {}, 400, 'invalid-json'],
    ['{"__proto__":{}}', {}, 400, 'invalid-json'],
    ['{}', { 'Content-Type': 'text/plain' }, 415, 'json-required'],
    ['{}', { 'Content-Encoding': 'gzip' }, 415, 'json-required'],
    ['{}', {}, 400, 'invalid-command'],
    ['{"operation":"projects.list","actor":"forged"}', {}, 400, 'invalid-command'],
  ] as const)('rejects malformed bodies before mutations %#', async (body, headers, status, code) => {
    const { raw, operation } = await fixture()
    const response = await raw(body, headers)
    expect(response.status).toBe(status); expect(await response.json()).toMatchObject({ code })
    expect(await operation({ operation: 'projects.list' })).toMatchObject({ projects: [] })
  })

  it('bounds declared and streamed bodies, invalid UTF-8 and deeply nested JSON', async () => {
    const { raw, service } = await fixture({ maxRequestBytes: 1024 })
    expect((await raw(' '.repeat(1025))).status).toBe(413)
    const headers = ['Host', new URL(service.url).host, 'Authorization', `Bearer ${token}`,
      'X-Jevable-Protocol', PROTOCOL_VERSION, 'Content-Type', 'application/json']
    expect((await wire(service.url, [...headers, 'Transfer-Encoding', 'chunked'], ' '.repeat(1025))).status).toBe(413)
    expect((await wire(service.url, headers, Buffer.from([0xff, 0xfe]))).status).toBe(400)
    expect((await raw('['.repeat(70) + '0' + ']'.repeat(70))).status).toBe(400)
  })

  it('keeps review guards and server-authenticated actor through project runs', async () => {
    const { operation, client } = await fixture()
    const create = { operation: 'create', id: randomUUID(), title: 'HTTP example', yaml: echo }
    await expect(client.operation({ operation: 'projects.command', command: { ...create, actor: 'forged' } })).rejects.toMatchObject({ code: 'invalid-command' })
    const project = await operation({ operation: 'projects.command', command: create })
    expect(project.changes[0].actor).toBe('local:http-owner')
    const proposed = await operation({ operation: 'projects.command', command: { operation: 'propose', id: project.id,
      expectedGeneration: 1, yaml: echo.replace('Standalone echo', 'Revised echo') } })
    const candidate = proposed.proposals[0]
    const accept = { operation: 'accept', id: project.id, expectedGeneration: 2, proposalId: candidate.id,
      reviewedRevision: candidate.revision, approvalChanges: [] }
    await expect(client.operation({ operation: 'projects.command', command: { ...accept, expectedGeneration: 1 } })).rejects.toMatchObject({ code: 'conflict' })
    await expect(client.operation({ operation: 'projects.command', command: { ...accept, reviewedRevision: project.acceptedRevision } })).rejects.toMatchObject({ code: 'conflict' })
    const accepted = await operation({ operation: 'projects.command', command: accept })
    const command: RuntimeOperation = { operation: 'projects.run', id: project.id, expectedGeneration: 3,
      revision: accepted.acceptedRevision, runId: randomUUID(), input: 'HTTP output' }
    const run = await operation(command)
    expect(run).toMatchObject({ status: 'completed', output: 'HTTP output', project: { id: project.id, generation: 3 } })
    expect(await operation(command)).toEqual(run)
    await expect(client.operation({ ...command, input: 'changed' })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('omits private waiting payloads from receipts/events but exposes explicit owner inspection', async () => {
    const { operation, client, service, dataDirectory } = await fixture()
    const run = await operation({ operation: 'runs.start', id: randomUUID(), yaml: approval, input: { message: 'PRIVATE_APPROVAL' } })
    expect(run.status).toBe('waiting')
    for (const command of [{ operation: 'runs.show', id: run.id }, { operation: 'runs.events', id: run.id }, { operation: 'runs.list' }] as RuntimeOperation[])
      expect(JSON.stringify(await operation(command))).not.toContain('PRIVATE_APPROVAL')
    expect(JSON.stringify(await operation({ operation: 'runs.inspect', id: run.id }))).toContain('PRIVATE_APPROVAL')
    const reviewed = await operation({ operation: 'approvals.show', id: run.id })
    expect(reviewed.review.input.input).toBe('PRIVATE_APPROVAL')
    expect(reviewed.deadlineStatus).toBe('open-at-observation')
    await expect(client.operation({ operation: 'approvals.decide', id: run.id, attemptId: randomUUID(), action: 'approve' })).rejects.toMatchObject({ code: 'conflict' })
    expect(await operation({ operation: 'approvals.decide', id: run.id, attemptId: run.attemptId, action: 'approve' })).toMatchObject({ status: 'completed' })
    await service.close()
    const runtime = await LocalRuntime.open({ dataDirectory })
    try { expect(await runtime.events(run.id)).toContainEqual(expect.objectContaining({ kind: 'approval-decided',
      data: expect.objectContaining({ decision: expect.objectContaining({ actor: 'local:http-owner' }) }) })) }
    finally { await runtime.close() }
  })

  it('reports response overflow without claiming a committed project was rejected', async () => {
    const { client, operation } = await fixture({ maxResponseBytes: 1024 })
    const id = randomUUID()
    await expect(client.operation({ operation: 'projects.command', command: { operation: 'create', id, title: 'Large',
      yaml: echo.replace('${{ inputs }}', 'x'.repeat(1000)) } })).rejects.toMatchObject({ code: 'response-limit', status: 413 })
    // Duplicate identity conflicts: the response failed, not the committed create.
    await expect(client.operation({ operation: 'projects.command', command: { operation: 'create', id, title: 'Retry', yaml: echo } })).rejects.toMatchObject({ code: 'conflict' })
    expect(await operation({ operation: 'runs.list' })).toMatchObject({ runs: [] })
  })

  it('does not redispatch after a lost response, and drains active work before releasing storage', async () => {
    const started = gate(), finish = gate(); let calls = 0
    const models: ModelCalls = { admit() {}, async execute() { calls++; started.release(); await finish.promise; throw Error('PRIVATE_PROVIDER_ERROR') }, async verify() {} }
    const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-http-drain-'))
    const { service, client } = await fixture({ runtime: { dataDirectory, models }, maxConcurrentRequests: 1 })
    // Always release the model before the service cleanup, even when an assertion fails.
    cleanup.push(async () => finish.release())
    const command: RuntimeOperation = { operation: 'runs.start', id: randomUUID(), yaml: modelSource, input: 'private' }
    const controller = new AbortController()
    const lost = fetch(service.url + '/v1/operations', { method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, 'X-Jevable-Protocol': PROTOCOL_VERSION, 'Content-Type': 'application/json' }, body: JSON.stringify(command) }).catch(() => undefined)
    await started.promise
    await expect(client.health()).rejects.toMatchObject({ code: 'concurrency-limit' })
    controller.abort(); await lost
    expect(await service.close(5)).toMatchObject({ status: 'draining', activeRequests: 1 })
    await expect(LocalRuntime.open({ dataDirectory, models })).rejects.toMatchObject({ code: 'busy' })
    finish.release(); await service.closed
    const restarted = await fixture({ runtime: { dataDirectory, models } })
    expect(await restarted.operation(command)).toMatchObject({ status: 'executing', recovery: expect.stringContaining('uncertain') })
    expect(calls).toBe(1)
  })

  it('releases storage if binding the requested port fails', async () => {
    const first = await fixture(), dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-http-bind-'))
    await expect(startRuntimeService({ runtime: { dataDirectory }, token, actor: 'owner', port: Number(new URL(first.service.url).port) })).rejects.toMatchObject({ code: 'EADDRINUSE' })
    const runtime = await LocalRuntime.open({ dataDirectory }); await runtime.close()
  })

  it('retains a successful result after client disconnect without a second model call', async () => {
    const started = gate(), finish = gate(); let calls = 0
    const models: ModelCalls = { admit() {}, async execute() { calls++; started.release(); await finish.promise;
      return { output: 'retained model result', usage: { tries: 1 } } }, async verify() {} }
    const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-http-success-'))
    const { service } = await fixture({ runtime: { dataDirectory, models } })
    cleanup.push(async () => finish.release())
    const command: RuntimeOperation = { operation: 'runs.start', id: randomUUID(), yaml: modelSource, input: 'input' }
    const controller = new AbortController()
    const lost = fetch(service.url + '/v1/operations', { method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, 'X-Jevable-Protocol': PROTOCOL_VERSION, 'Content-Type': 'application/json' }, body: JSON.stringify(command) }).catch(() => undefined)
    await started.promise; controller.abort(); await lost
    finish.release(); await service.close(); await service.closed
    const restarted = await fixture({ runtime: { dataDirectory, models } })
    const retained = await restarted.operation(command)
    expect(retained).toMatchObject({ id: command.id, status: 'completed', output: 'retained model result' })
    expect(await restarted.operation(command)).toEqual(retained)
    expect(calls).toBe(1)
  })

  it('keeps credential changes owner-attributed and secret-free, and rejects stale generations', async () => {
    const { operation, client } = await fixture()
    const command: RuntimeOperation = { operation: 'credentials.set', ref: 'fixture/key', value: 'PRIVATE_CREDENTIAL', expectedGeneration: 0 }
    expect(await operation(command)).toMatchObject({ configured: true, generation: 1 })
    await expect(client.operation(command)).rejects.toMatchObject({ code: 'conflict' })
    const status = await operation({ operation: 'credentials.status', ref: 'fixture/key' })
    const audit = await operation({ operation: 'providers.audit' })
    expect(JSON.stringify({ status, audit })).not.toContain('PRIVATE_CREDENTIAL')
    expect(JSON.stringify(audit)).toContain('local:http-owner')
    await expect(client.operation({ operation: 'templates.render', id: 'missing' })).rejects.toMatchObject({ code: 'invalid-command', status: 400 })
  })
})

describe('bounded local HTTP client', () => {
  async function endpoint(handler: Parameters<typeof createServer>[1]) {
    const server: Server = createServer(handler!)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
    const address = server.address(); if (!address || typeof address === 'string') throw Error('missing address')
    return `http://127.0.0.1:${address.port}`
  }
  it.each(['ftp://127.0.0.1:1234', 'http://example.com:1234', 'http://localhost:1234', 'http://127.0.0.1:1234/?token=secret',
    'http://user:pass@127.0.0.1:1234', 'http://127.0.0.1:1234/path'])('rejects non-local or credential-bearing endpoint %s', url => {
    expect(() => new RuntimeClient(url, token)).toThrow()
  })
  it.each(['protocol', 'redirect', 'oversize', 'json', 'timeout'] as const)('handles %s without automatic retries', async mode => {
    let calls = 0
    const url = await endpoint((_req, res) => {
      calls++
      if (mode === 'timeout') return
      res.setHeader('X-Jevable-Protocol', mode === 'protocol' ? 'wrong' : PROTOCOL_VERSION)
      res.setHeader('Content-Type', 'application/json')
      if (mode === 'redirect') { res.statusCode = 302; res.setHeader('Location', '/other') }
      res.end(mode === 'oversize' ? JSON.stringify('x'.repeat(2048)) : mode === 'json' ? '{' : '{}')
    })
    const client = new RuntimeClient(url, token, mode === 'timeout' ? 30 : 1000, 1024)
    await expect(client.health()).rejects.toMatchObject({ code: { protocol: 'protocol-mismatch', redirect: 'redirect-refused',
      oversize: 'response-limit', json: 'invalid-response', timeout: 'request-timeout' }[mode] })
    expect(calls).toBe(1)
  })
})

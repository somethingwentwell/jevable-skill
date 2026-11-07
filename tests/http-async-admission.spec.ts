import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { startRuntimeService, RuntimeClient, AsyncRunClient, type RuntimeServiceOptions } from '../src/http/index.ts'
import { LocalRuntime, type ModelCalls } from '../src/runtime/index.ts'
import { CORE_VERSION, PROTOCOL_VERSION } from '../src/capabilities.ts'
import { RunStore } from '../src/runtime/store.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const source = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'async-http', name: 'Async HTTP' },
  spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
    write: { type: 'llm', config: { provider: 'fixture', model: 'fixture', connection: { mode: 'workspace', id: 'fixture' },
      prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 20, stream: false }, historyScope: 'none',
      execution: { timeoutSeconds: 60, maxAttempts: 1 } } }, end: { type: 'output', config: { value: '${{ nodes.write.output }}' } } },
    edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }] } })
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

async function fixture(options: Partial<RuntimeServiceOptions> = {}, enabled = true) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-http-async-')), token = randomBytes(32).toString('hex')
  const service = await startRuntimeService({ runtime: { dataDirectory }, token, actor: 'fixture:owner',
    ...(enabled ? { asyncRuns: { maxConcurrentRuns: 1 } } : {}), ...options })
  cleanup.push(async () => { await service.close(); await service.closed })
  const client = new RuntimeClient(service.url, token, 1000, 20_000_000, { expectedInstanceId: service.instanceId })
  const raw = (command: unknown, path = '/v1/async-runs', method = 'POST', headers: Record<string, string> = {}) => fetch(service.url + path, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-jevable-protocol': PROTOCOL_VERSION,
      'x-jevable-instance': service.instanceId, ...headers }, ...(method === 'GET' ? {} : { body: JSON.stringify(command) }),
  })
  return { dataDirectory, token, service, client, raw }
}
function modelGate() {
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  const execute = vi.fn(async () => { entered.resolve(); await gate.promise; return { output: 'PRIVATE_MODEL_RESULT', usage: { tries: 1 } } })
  const models: ModelCalls = { admit: vi.fn(), execute, async verify() {} }
  cleanup.push(async () => { gate.resolve() })
  return { entered, gate, execute, models }
}
const command = (id = randomUUID(), yaml = echo) => ({ kind: 'workflow', id, yaml, input: 'PRIVATE_INPUT' })

describe('explicit authenticated asynchronous HTTP admission', () => {
  it('does not return creation success or execute after a lost durable creation acknowledgement; retry only observes the same UUID', async () => {
    const f = await fixture(), request = command(), original = RunStore.prototype.save
    const lost = vi.spyOn(RunStore.prototype, 'save').mockImplementation(function(this: RunStore, ...args) {
      original.apply(this, args); if (args[1] === 'run-created') throw Error('PRIVATE_LOST_ACK')
    })
    const response = await f.raw(request)
    expect(response.status).toBe(500); expect(response.headers.get('location')).toBeNull()
    expect(JSON.stringify(await response.json())).not.toContain('PRIVATE_LOST_ACK')
    lost.mockRestore()
    const client = new AsyncRunClient(f.service.url, f.token, f.service.instanceId)
    expect(await client.show(request.id)).toMatchObject({ run: { status: 'paused' } })
    const before = await f.client.operation({ operation: 'runs.events', id: request.id }) as any
    expect(before.result.events.map((event: any) => event.kind)).toEqual(['run-created'])
    expect(await client.start({ ...request, kind: 'workflow' })).toMatchObject({ observation: 'retained', run: { status: 'paused' } })
    expect(await f.client.operation({ operation: 'runs.events', id: request.id })).toEqual(before)
  })

  it('retains admitted work after the caller disconnects before receiving its creation receipt, then drains the original completion', async () => {
    const ready = Promise.withResolvers<void>(), admissionGate = Promise.withResolvers<void>(), m = modelGate()
    const models: ModelCalls = { ...m.models, async admit() { ready.resolve(); await admissionGate.promise } }
    const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-async-disconnect-'))
    const f = await fixture({ runtime: { dataDirectory, models } }), id = randomUUID()
    cleanup.push(async () => { admissionGate.resolve(); m.gate.resolve() })
    const pending = httpRequest(f.service.url + '/v1/async-runs', { method: 'POST', headers: {
      authorization: `Bearer ${f.token}`, 'content-type': 'application/json', 'x-jevable-protocol': PROTOCOL_VERSION,
      'x-jevable-instance': f.service.instanceId,
    } })
    pending.on('error', () => {}); pending.end(JSON.stringify(command(id, source)))
    await ready.promise; pending.destroy(); admissionGate.resolve(); await m.entered.promise
    expect((await f.service.close(10))).toMatchObject({ status: 'draining', activeAsyncRuns: 1 })
    await expect(LocalRuntime.open({ dataDirectory })).rejects.toHaveProperty('code', 'busy')
    m.gate.resolve(); await f.service.closed
    const reopened = await LocalRuntime.open({ dataDirectory, models })
    try {
      expect((await reopened.show(id)).state).toMatchObject({ status: 'completed', output: 'PRIVATE_MODEL_RESULT' })
      const observed = await reopened.runAsync(source, 'PRIVATE_INPUT', { id })
      expect(observed.observation).toBe('retained'); await observed.completion; expect(m.execute).toHaveBeenCalledTimes(1)
    } finally { await reopened.close() }
  })
  it('uses the typed client against the real service for creation, paused read, same-ID observation and explicit completion', async () => {
    const f = await fixture(), client = new AsyncRunClient(f.service.url, f.token, f.service.instanceId)
    const request = { ...command(), kind: 'workflow' as const, paused: true }
    const created = await client.start(request)
    expect(created).toMatchObject({ observation: 'created', run: { id: request.id, status: 'paused', startedPaused: true } })
    expect(await client.show(request.id)).toMatchObject({ observation: 'read', run: { status: 'paused' } })
    const before = await f.client.operation({ operation: 'runs.events', id: request.id })
    expect(await client.start(request)).toMatchObject({ observation: 'retained', run: { status: 'paused' } })
    expect(await f.client.operation({ operation: 'runs.events', id: request.id })).toEqual(before)
    const inspected = await f.client.operation({ operation: 'runs.show', id: request.id }) as any
    await f.client.operation({ operation: 'runs.advance', id: request.id, mode: 'continue', requestId: randomUUID(),
      expectedCheckpointSha256: inspected.result.checkpointSha256 })
    expect(await client.show(request.id)).toMatchObject({ run: { status: 'completed' } })
  })

  it('refuses an old typed client after clean owner replacement without creating a run or following the new instance', async () => {
    const f = await fixture(), client = new AsyncRunClient(f.service.url, f.token, f.service.instanceId), port = new URL(f.service.url).port
    await f.service.close(); await f.service.closed
    const replacement = await startRuntimeService({ runtime: { dataDirectory: f.dataDirectory }, token: f.token,
      actor: 'fixture:owner', port: Number(port), asyncRuns: { maxConcurrentRuns: 1 } })
    cleanup.push(async () => { await replacement.close(); await replacement.closed })
    await expect(client.start({ ...command(), kind: 'workflow' })).rejects.toHaveProperty('code', 'instance-mismatch')
    const owner = new RuntimeClient(replacement.url, f.token)
    expect(await owner.operation({ operation: 'runs.list' })).toMatchObject({ result: { runs: [] } })
  })
  it('keeps the async routes disabled without a reviewed startup opt-in', async () => {
    const f = await fixture({}, false), response = await f.raw(command())
    expect(response.status).toBe(404)
    expect(await f.client.operation({ operation: 'runs.list' })).toMatchObject({ result: { runs: [] } })
    expect(await f.client.capabilities()).toMatchObject({ api: { asyncRuns: false } })
  })

  it('returns 202 and an exact Location for acknowledged creation, then serves payload-free recorded metadata', async () => {
    const f = await fixture(), id = randomUUID(), response = await f.raw(command(id))
    expect(response.status).toBe(202); expect(response.headers.get('location')).toBe('/v1/async-runs/' + id)
    const receipt = await response.json()
    expect(receipt).toMatchObject({ format: 'jevable.ai/async-run', schemaVersion: 1, instanceId: f.service.instanceId,
      observation: 'created', run: { id, status: 'paused', revision: expect.stringMatching(/^[a-f0-9]{64}$/u) } })
    expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE_|yaml|completion|steps|output/u)
    const read = await f.raw(undefined, response.headers.get('location')!, 'GET')
    expect(read.status).toBe(200)
    const observed = await read.json()
    expect(observed).toMatchObject({ observation: 'read', run: { id, status: 'completed' } })
    expect(JSON.stringify(observed)).not.toMatch(/PRIVATE_|yaml|steps|output/u)
    expect(await f.client.capabilities()).toMatchObject({ api: { asyncRuns: { maxConcurrentRuns: 1, status: 'metadata-only' } } })
  })

  it('retains identical submissions as 200 observations without replay and refuses a changed input', async () => {
    const f = await fixture(), request = command(), created = await f.raw(request)
    expect(created.status).toBe(202)
    const before = await f.client.operation({ operation: 'runs.events', id: request.id })
    const retry = await f.raw(request)
    expect(retry.status).toBe(200); expect(await retry.json()).toMatchObject({ observation: 'retained', run: { status: 'completed' } })
    expect(retry.headers.get('location')).toBe('/v1/async-runs/' + request.id)
    expect(await f.client.operation({ operation: 'runs.events', id: request.id })).toEqual(before)
    const changed = await f.raw({ ...request, input: 'changed' }); expect(changed.status).toBe(409)
  })

  it('uses a separate bounded background reservation after returning 202, without consuming status/control capacity', async () => {
    const f = await fixture(), m = modelGate()
    // Configure the synthetic SDK port at startup, never on an HTTP request.
    await f.service.close(); await f.service.closed
    const service = await startRuntimeService({ runtime: { dataDirectory: f.dataDirectory, models: m.models }, token: f.token,
      actor: 'fixture:owner', asyncRuns: { maxConcurrentRuns: 1 } })
    cleanup.push(async () => { m.gate.resolve(); await service.close(); await service.closed })
    const raw = (body: unknown, path = '/v1/async-runs', method = 'POST') => fetch(service.url + path, { method,
      headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json', 'x-jevable-protocol': PROTOCOL_VERSION,
        'x-jevable-instance': service.instanceId }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) })
    const id = randomUUID(), admitted = await raw(command(id, source))
    expect(admitted.status).toBe(202); await m.entered.promise
    expect((await (await raw(undefined, '/v1/health', 'GET')).json()).activeAsyncRuns).toBe(1)
    expect((await raw(command())).status).toBe(429)
    const observed = await raw(undefined, '/v1/async-runs/' + id, 'GET')
    expect(observed.status).toBe(200); expect(await observed.json()).toMatchObject({ run: { status: 'executing' } })
    const cancel = await raw({ operation: 'runs.cancel', id, requestId: randomUUID() }, '/v1/operations')
    expect(cancel.status).toBe(200)
    m.gate.resolve()
    await vi.waitFor(async () => { expect((await (await raw(undefined, '/v1/health', 'GET')).json()).activeAsyncRuns).toBe(0) })
    expect(await (await raw(undefined, '/v1/async-runs/' + id, 'GET')).json()).toMatchObject({ run: { status: 'cancelled' } })
    expect(m.execute).toHaveBeenCalledTimes(1)
  })

  it('drains background completion after the admission HTTP request ends before releasing storage ownership', async () => {
    const m = modelGate(), dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-async-drain-'))
    const f = await fixture({ runtime: { dataDirectory, models: m.models } }), id = randomUUID()
    cleanup.push(async () => { m.gate.resolve() })
    const response = await f.raw(command(id, source)); expect(response.status).toBe(202); await m.entered.promise
    const closing = await f.service.close(10)
    expect(closing).toMatchObject({ status: 'draining', activeAsyncRuns: 1 })
    await expect(LocalRuntime.open({ dataDirectory })).rejects.toHaveProperty('code', 'busy')
    m.gate.resolve(); await f.service.closed
    const reopened = await LocalRuntime.open({ dataDirectory, models: m.models })
    try { expect((await reopened.show(id)).state).toMatchObject({ status: 'completed', output: 'PRIVATE_MODEL_RESULT' }) }
    finally { await reopened.close() }
  })

  it('reserves capacity during model admission and emits no successful receipt before durable creation', async () => {
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
    const models: ModelCalls = { async admit() { entered.resolve(); await gate.promise; throw new Error('readiness refused') },
      execute: vi.fn(), async verify() {} }
    const f = await fixture({ runtime: { dataDirectory: await mkdtemp(join(tmpdir(), 'jevable-async-readiness-')), models } })
    cleanup.push(async () => { gate.resolve() })
    let returned = false
    const pending = f.raw(command(randomUUID(), source)).then(value => { returned = true; return value })
    await entered.promise
    expect(returned).toBe(false); expect((await f.raw(command())).status).toBe(429)
    expect(await f.client.operation({ operation: 'runs.list' })).toMatchObject({ result: { runs: [] } })
    gate.resolve(); expect((await pending).status).toBe(500)
    expect(models.execute).not.toHaveBeenCalled()
    await vi.waitFor(async () => { expect((await (await f.raw(undefined, '/v1/health', 'GET')).json()).activeAsyncRuns).toBe(0) })
  })

  it('clears a rejected completion reservation without fabricating failure or redispatching uncertain intent', async () => {
    const execute = vi.fn(async () => { throw new Error('provider outcome unknown') })
    const models: ModelCalls = { admit() {}, execute, async verify() {} }
    const f = await fixture({ runtime: { dataDirectory: await mkdtemp(join(tmpdir(), 'jevable-async-uncertain-')), models } }), request = command(randomUUID(), source)
    expect((await f.raw(request)).status).toBe(202)
    await vi.waitFor(async () => { expect((await (await f.raw(undefined, '/v1/health', 'GET')).json()).activeAsyncRuns).toBe(0) })
    expect(await (await f.raw(undefined, '/v1/async-runs/' + request.id, 'GET')).json()).toMatchObject({ run: { status: 'executing' } })
    const retry = await f.raw(request)
    expect(retry.status).toBe(200); expect(await retry.json()).toMatchObject({ observation: 'retained', run: { status: 'executing' } })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('requires instance/protocol/owner authority before creating any asynchronous run', async () => {
    const f = await fixture()
    for (const [headers, expected] of [
      [{ 'x-jevable-instance': '' }, 400], [{ 'x-jevable-instance': randomUUID() }, 409],
      [{ 'x-jevable-protocol': 'invalid' }, 409], [{ authorization: 'Bearer invalid' }, 401],
      [{ origin: 'https://untrusted.example' }, 403],
    ] as const) expect((await f.raw(command(), '/v1/async-runs', 'POST', headers)).status).toBe(expected)
    expect(await f.client.operation({ operation: 'runs.list' })).toMatchObject({ result: { runs: [] } })
  })

  it.each([{ kind: 'workflow', id: 'bad', yaml: echo, input: 'input' }, { ...command(), project: {} },
    { ...command(), actor: 'forged' }, { ...command(), options: { id: randomUUID() } },
    { kind: 'release', id: randomUUID(), input: 'input', release: { id: randomUUID(), sha256: 'bad', revision: '1'.repeat(64) } },
    { kind: 'project', id: randomUUID(), input: 'input', project: { id: randomUUID(), generation: 0, revision: '1'.repeat(64) } },
  ])('refuses malformed or widened admission contracts without writes: %j', async request => {
    const f = await fixture(), response = await f.raw(request)
    expect(response.status).toBe(400)
    expect(await f.client.operation({ operation: 'runs.list' })).toMatchObject({ result: { runs: [] } })
  })

  it('admits reviewed project pins and refuses stale generations without replacing retained identities', async () => {
    const f = await fixture(), created = await f.client.operation({ operation: 'projects.command', command: { operation: 'create', title: 'Review', yaml: echo } }) as any
    const project = created.result
    const id = randomUUID(), request = { kind: 'project', id, input: 'PRIVATE_INPUT', project: { id: project.id, generation: 1, revision: project.acceptedRevision } }
    expect((await f.raw({ ...request, project: { ...request.project, generation: 2 } })).status).toBe(409)
    const response = await f.raw(request)
    expect(response.status).toBe(202); expect(await response.json()).toMatchObject({ run: { project: { id: project.id, generation: 1 } } })
  })

  it('narrows an exact-release app to its immutable pin, including status reads and bearer-independent pin mismatch', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-async-release-')), owner = await LocalRuntime.open({ dataDirectory })
    const project = owner.editProject({ operation: 'create', title: 'Release', yaml: echo, actor: 'fixture:owner' })
    const release = owner.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision,
      version: '1.0.0', runtime: { version: CORE_VERSION, sha256: '1'.repeat(64) }, actor: 'fixture:owner' })
    const foreign = await owner.run(echo, 'PRIVATE_FOREIGN')
    await owner.close()
    const f = await fixture({ runtime: { dataDirectory }, release: { snapshot: release.snapshot } }), id = randomUUID()
    const pin = { id: release.snapshot.id, sha256: release.sha256, revision: release.snapshot.workflow.revision }
    expect((await f.raw(command())).status).toBe(400)
    const request = { kind: 'release', id, input: 'PRIVATE_INPUT', release: pin }
    expect((await f.raw({ ...request, release: { ...pin, sha256: '0'.repeat(64) } })).status).toBe(409)
    const started = await f.raw(request)
    expect(started.status).toBe(202); expect(await started.json()).toMatchObject({ run: { release: { id: pin.id, sha256: pin.sha256 } } })
    expect((await f.raw(undefined, '/v1/async-runs/' + id, 'GET')).status).toBe(400)
    expect((await f.raw(undefined, '/v1/async-runs/' + id, 'GET', { 'x-jevable-release-sha256': '0'.repeat(64) })).status).toBe(409)
    const headers = { 'x-jevable-release-sha256': pin.sha256 }
    expect((await f.raw(undefined, '/v1/async-runs/' + foreign.id, 'GET', headers)).status).toBe(404)
    const read = await f.raw(undefined, '/v1/async-runs/' + id, 'GET', headers)
    expect(read.status).toBe(200); expect(JSON.stringify(await read.json())).not.toMatch(/PRIVATE_|output|yaml/u)
  })

  it.each([null, true, {}, { maxConcurrentRuns: 0 }, { maxConcurrentRuns: 65 }, { maxConcurrentRuns: 1, discover: true }])(
    'rejects invalid async startup policy before storage acquisition: %j', async asyncRuns => {
      const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-async-policy-'))
      const pending = startRuntimeService({ runtime: { dataDirectory }, token: randomBytes(32).toString('hex'), actor: 'fixture:owner', asyncRuns } as unknown as RuntimeServiceOptions)
        .then(service => { cleanup.push(async () => { await service.close(); await service.closed }); return service })
      await expect(pending).rejects.toHaveProperty('code', 'invalid-command')
      expect(await readdir(dataDirectory)).toEqual([])
    })
})

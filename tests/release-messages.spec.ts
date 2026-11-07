import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { LocalRuntime, type ModelCalls } from '../src/runtime/index.ts'
import { RunStore } from '../src/runtime/store.ts'
import { CORE_VERSION, capabilities } from '../src/capabilities.ts'
import { ReleaseMessageSession, releaseMessageRunId, type ReleaseMessageIdentity } from '../src/releases/index.ts'
import { inspectRelease, type Release } from '../src/releases/snapshot.ts'

const api = await readFile(new URL('../examples/api-echo.yaml', import.meta.url), 'utf8')
const manual = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = (await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')).replace('modes: [manual]', 'modes: [api]')
const model = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'message-model', name: 'Message model' },
  spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['api'] } },
    write: { type: 'llm', config: { provider: 'fixture', model: 'fixture', connection: { mode: 'workspace', id: 'fixture' },
      prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 20, stream: false }, historyScope: 'none',
      execution: { timeoutSeconds: 60, maxAttempts: 1 } } }, end: { type: 'output', config: { value: '${{ nodes.write.output }}' } } },
    edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }] } })
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close() })
const directory = () => mkdtemp(join(tmpdir(), 'jevable-release-message-'))
async function releaseFor(source = api): Promise<Release> {
  const author = await LocalRuntime.open({ dataDirectory: await directory() })
  try {
    const project = author.editProject({ operation: 'create', yaml: source, title: 'Message fixture', actor: 'fixture:author' })
    return author.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision,
      version: '1.0.0', actor: 'fixture:author', runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
  } finally { await author.close() }
}
async function fixture(source = api, models?: ModelCalls) {
  const artifact = await releaseFor(source), dataDirectory = await directory()
  const runtime = await LocalRuntime.open({ dataDirectory, ...(models ? { models } : {}) })
  cleanups.push(() => runtime.close())
  return { artifact, dataDirectory, runtime, session: new ReleaseMessageSession(runtime, artifact.snapshot, 'orders/tenant-a') }
}
const identity: ReleaseMessageIdentity = { release: { id: '11111111-1111-4111-8111-111111111111', sha256: 'a'.repeat(64), revision: 'b'.repeat(64) },
  source: 'orders/tenant-a', messageId: 'evt_001' }

describe('stable released-workflow message identity', () => {
  it('pins the v1 tuple and UUIDv8 encoding with an independent golden vector', () => {
    expect(releaseMessageRunId(identity)).toBe('b9486d15-0f3d-85ba-a77f-1c08d05b5af2')
    expect(z.uuid().safeParse(releaseMessageRunId(identity)).success).toBe(true)
    expect(releaseMessageRunId(structuredClone(identity))).toBe(releaseMessageRunId(identity))
  })
  it('keeps release UUID case canonical without normalizing source or message identity', () => {
    const pin = { ...identity.release, id: 'ABCDEFAB-1111-4111-8111-111111111111' }
    expect(releaseMessageRunId({ ...identity, release: pin })).toBe(releaseMessageRunId({ ...identity, release: { ...pin, id: pin.id.toLowerCase() } }))
    expect(releaseMessageRunId({ ...identity, messageId: 'EVT_001' })).not.toBe(releaseMessageRunId(identity))
    expect(releaseMessageRunId({ ...identity, source: 'Orders/tenant-a' })).not.toBe(releaseMessageRunId(identity))
  })
  it('separates releases, revisions, sender namespaces and framed delimiter-like IDs', () => {
    const variants = [identity, { ...identity, source: 'orders/tenant-b' }, { ...identity, messageId: 'evt_002' },
      { ...identity, release: { ...identity.release, id: randomUUID() } },
      { ...identity, release: { ...identity.release, sha256: 'c'.repeat(64) } },
      { ...identity, release: { ...identity.release, revision: 'c'.repeat(64) } },
      { ...identity, source: 'a:b', messageId: 'c' }, { ...identity, source: 'a', messageId: 'b:c' },
      { ...identity, messageId: '"],"other"' }, { ...identity, messageId: 'x'.repeat(256) }]
    expect(new Set(variants.map(releaseMessageRunId)).size).toBe(variants.length)
  })
  it.each(['', ' ', ' leading', 'trailing ', 'has space', '\t', '\n', '\r', '\0', 'é', '😀', 'x'.repeat(257)])('refuses malformed message identity %# without echoing it', messageId => {
    expect(() => releaseMessageRunId({ ...identity, messageId })).toThrow('invalid-command')
  })
  it.each(['', '/prefix', ' leading', 'has space', 'é', 'x'.repeat(129)])('refuses malformed source identity %#', source => {
    expect(() => releaseMessageRunId({ ...identity, source })).toThrow('invalid-command')
  })
  it.each([
    { ...identity, extra: true }, { ...identity, release: { ...identity.release, extra: true } },
    { ...identity, release: { ...identity.release, id: 'not-a-uuid' } },
    { ...identity, release: { ...identity.release, sha256: 'A'.repeat(64) } },
    { ...identity, release: { ...identity.release, revision: 'b'.repeat(63) } },
    { ...identity, messageId: null }, { ...identity, source: 3 },
  ])('refuses malformed pins or unknown identity fields %#', value => {
    expect(() => releaseMessageRunId(value as any)).toThrow('invalid-command')
  })
})

describe('trusted owned release-message SDK adapter', () => {
  it('reports the SDK-only boundary without claiming authentication, listeners or exactly-once effects', () => {
    expect(capabilities().workflowRuntime.releaseMessages).toMatchObject({ sdk: '@jevable/core/releases', adapter: 'ReleaseMessageSession',
      storageBackends: ['sqlite', 'postgres'], authentication: 'external-host-required', listener: false, automaticRetry: false,
      automaticResume: false, externalEffectsExactlyOnce: false })
  })
  it('refuses a manual-only workflow before touching the supplied runtime', async () => {
    const artifact = await releaseFor(manual), port = { runReleaseAsync: vi.fn(), show: vi.fn() }
    expect(() => new ReleaseMessageSession(port, artifact.snapshot, 'orders')).toThrow('invalid-command')
    expect(port.runReleaseAsync).not.toHaveBeenCalled(); expect(port.show).not.toHaveBeenCalled()
    expect(() => new ReleaseMessageSession(port, artifact.snapshot, ' invalid')).toThrow('invalid-command')
  })
  it('creates one acknowledged API run, observes duplicates and refuses changed input', async () => {
    const f = await fixture(), messageId = 'evt_001', created = await f.session.start({ messageId, input: 'PRIVATE_MESSAGE' })
    expect(created.observation).toBe('created')
    expect(created.message).toEqual({ source: 'orders/tenant-a', id: messageId })
    expect(created.run).toMatchObject({ id: f.session.runId(messageId), triggerMode: 'api', release: { id: f.artifact.snapshot.id, sha256: f.artifact.sha256 } })
    expect((await created.completion).state).toMatchObject({ status: 'completed', output: 'PRIVATE_MESSAGE' })
    const events = await f.runtime.events(created.run.id)
    const retained = await f.session.start({ messageId, input: 'PRIVATE_MESSAGE' })
    expect(retained.observation).toBe('retained'); expect(await retained.completion).toEqual(await f.session.show(messageId))
    expect(await f.runtime.events(created.run.id)).toEqual(events)
    await expect(f.session.start({ messageId, input: 'changed' })).rejects.toHaveProperty('code', 'conflict')
    expect(f.runtime.list()).toHaveLength(1)
  })
  it('owns release and input copies; caller mutation cannot retarget creation or evidence', async () => {
    const f = await fixture(approval), pin = f.session.release, request = { messageId: 'evt-copy', input: { message: 'PRIVATE_ORIGINAL' } }
    f.artifact.snapshot.id = randomUUID(); f.artifact.snapshot.workflow.yaml = manual; pin.sha256 = 'f'.repeat(64)
    const created = await f.session.start(request); request.input.message = 'changed'
    const waiting = await created.completion
    expect(waiting.state.status).toBe('waiting'); expect(waiting.input).toEqual({ message: 'PRIVATE_ORIGINAL' })
    expect(waiting.release?.id).toBe(f.session.release.id); expect(waiting.release?.sha256).not.toBe(pin.sha256)
    created.message.source = 'spoofed'; created.run.input = 'spoofed'
    expect((await f.session.show('evt-copy')).input).toEqual({ message: 'PRIVATE_ORIGINAL' })
  })
  it('keeps identical approval deliveries waiting without deciding, resuming or appending events', async () => {
    const f = await fixture(approval), request = { messageId: 'evt-review', input: { message: 'Review me' } }
    const created = await f.session.start(request), waiting = await created.completion, events = await f.runtime.events(waiting.id)
    expect(waiting.state.status).toBe('waiting')
    const duplicate = await f.session.start(request)
    expect(duplicate.observation).toBe('retained'); expect(await duplicate.completion).toEqual(waiting)
    expect(await f.runtime.events(waiting.id)).toEqual(events)
  })
  it('separates two reviewed sender namespaces using the same external message ID', async () => {
    const f = await fixture(), other = new ReleaseMessageSession(f.runtime, f.artifact.snapshot, 'orders/tenant-b')
    const first = await f.session.start({ messageId: '1', input: 'A' }); await first.completion
    const second = await other.start({ messageId: '1', input: 'B' }); await second.completion
    expect(first.run.id).not.toBe(second.run.id); expect(f.runtime.list()).toHaveLength(2)
  })
  it('observes the original run after owner replacement without a new UUID or replay', async () => {
    const f = await fixture(), request = { messageId: 'evt-restart', input: 'persisted' }
    const created = await f.session.start(request), result = await created.completion, events = await f.runtime.events(result.id)
    await f.runtime.close()
    const runtime = await LocalRuntime.open({ dataDirectory: f.dataDirectory }); cleanups.push(() => runtime.close())
    const next = new ReleaseMessageSession(runtime, f.artifact.snapshot, 'orders/tenant-a')
    expect(next.runId(request.messageId)).toBe(result.id); expect(await next.show(request.messageId)).toEqual(result)
    const duplicate = await next.start(request)
    expect(duplicate.observation).toBe('retained'); expect(await duplicate.completion).toEqual(result)
    expect(await runtime.events(result.id)).toEqual(events)
  })
  it('preserves an unacknowledged durable creation without running it or inventing successful admission', async () => {
    const f = await fixture(), original = RunStore.prototype.save
    const lost = vi.spyOn(RunStore.prototype, 'save').mockImplementation(function(this: RunStore, ...args) {
      original.apply(this, args); if (args[1] === 'run-created') throw Error('PRIVATE_LOST_ACK')
    })
    const request = { messageId: 'evt-lost-ack', input: 'persisted' }
    await expect(f.session.start(request)).rejects.toThrow('PRIVATE_LOST_ACK'); lost.mockRestore()
    const paused = await f.session.show(request.messageId)
    expect(paused.state.status).toBe('paused')
    const events = await f.runtime.events(paused.id)
    expect(events.map(event => event.kind)).toEqual(['run-created'])
    const retained = await f.session.start(request)
    expect(retained.observation).toBe('retained'); expect(await retained.completion).toEqual(paused)
    expect(await f.runtime.events(paused.id)).toEqual(events)
  })
  it('returns real original completion and busy refusal during execution; read never dispatches', async () => {
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
    const execute = vi.fn(async () => { entered.resolve(); await gate.promise; return { output: 'one result', usage: { tries: 1 } } })
    const models: ModelCalls = { admit() {}, execute, async verify() {} }
    const f = await fixture(model, models), request = { messageId: 'evt-running', input: 'one prompt' }
    const created = await f.session.start(request)
    try {
      await entered.promise
      expect((await f.session.show(request.messageId)).state.status).toBe('executing')
      await expect(f.session.start(request)).rejects.toHaveProperty('code', 'busy')
      await expect(f.runtime.close()).rejects.toHaveProperty('code', 'busy')
      expect(execute).toHaveBeenCalledTimes(1)
    } finally { gate.resolve(); await created.completion }
    expect((await f.session.start(request)).observation).toBe('retained'); expect(execute).toHaveBeenCalledTimes(1)
  })
  it('retains uncertain provider intent across reopening without dispatching a second call', async () => {
    const execute = vi.fn(async () => { throw Error('fixture response lost') })
    const models: ModelCalls = { admit() {}, execute, async verify() {} }
    const f = await fixture(model, models), request = { messageId: 'evt-uncertain', input: 'one prompt' }
    const created = await f.session.start(request)
    await expect(created.completion).rejects.toThrow('fixture response lost')
    const events = await f.runtime.events(created.run.id); await f.runtime.close()
    const runtime = await LocalRuntime.open({ dataDirectory: f.dataDirectory, models }); cleanups.push(() => runtime.close())
    const next = new ReleaseMessageSession(runtime, f.artifact.snapshot, 'orders/tenant-a'), retained = await next.start(request)
    expect(retained.observation).toBe('retained'); expect((await retained.completion).state.status).toBe('executing')
    expect(await runtime.events(created.run.id)).toEqual(events); expect(execute).toHaveBeenCalledTimes(1)
  })
  it.each(['actor', 'yaml', 'release', 'id', 'source', 'paused', 'triggerMode', 'authorization', 'signature', 'traceparent'])('refuses request override %s before any run creation', async field => {
    const f = await fixture()
    await expect(f.session.start({ messageId: 'evt-refused', input: 'input', [field]: 'spoofed' } as any)).rejects.toHaveProperty('code', 'invalid-command')
    expect(f.runtime.list()).toEqual([])
  })
  it('refuses invalid, oversized, circular or non-JSON data and input-schema mismatches without a run', async () => {
    const f = await fixture(), circular: any = {}; circular.self = circular
    for (const input of [undefined, NaN, new Date(), 1n, () => {}, circular, 'x'.repeat(1_000_001)]) {
      await expect(f.session.start({ messageId: 'evt-refused', input })).rejects.toThrow()
    }
    await expect(f.session.start({ messageId: 'evt-refused', input: {} })).rejects.toThrow()
    await expect(f.session.show('evt-missing')).rejects.toHaveProperty('code', 'not-found')
    expect(f.runtime.list()).toEqual([])
  })
  it('scope-checks a supplied trusted port observation instead of returning foreign owner data', async () => {
    const f = await fixture(), created = await f.session.start({ messageId: 'evt-owned', input: 'owned' }), run = await created.completion
    const foreign = { ...run, release: { ...run.release!, sha256: 'f'.repeat(64) } }
    const port = { runReleaseAsync: vi.fn(), show: vi.fn(async () => foreign) }
    const session = new ReleaseMessageSession(port, f.artifact.snapshot, 'orders/tenant-a')
    await expect(session.show('evt-owned')).rejects.toHaveProperty('code', 'not-found')
    expect(port.runReleaseAsync).not.toHaveBeenCalled()
  })
  it('permits a structurally compatible asynchronous storage port without importing or opening a backend', async () => {
    const artifact = await releaseFor(), show = vi.fn(), runReleaseAsync = vi.fn()
    const port = { runReleaseAsync, show }, session = new ReleaseMessageSession(port, artifact.snapshot, 'orders')
    expect(session.release).toEqual({ id: artifact.snapshot.id, sha256: inspectRelease(artifact.snapshot).sha256, revision: artifact.snapshot.workflow.revision })
    expect(show).not.toHaveBeenCalled(); expect(runReleaseAsync).not.toHaveBeenCalled()
  })
})

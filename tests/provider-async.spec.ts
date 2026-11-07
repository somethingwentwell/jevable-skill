import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { ConfiguredModels } from '../src/providers/model-calls.ts'
import type { ProviderPersistence } from '../src/providers/persistence.ts'
import type { ProviderConnectionRecord } from '../src/providers/config.ts'
import type { ModelEvidence } from '../src/providers/records.ts'
import { ProviderError } from '../src/providers/config.ts'
import { LocalRuntime, executionCheckpointHash } from '../src/runtime/index.ts'
import { compileLocalRun, executionModelPlans } from '../src/runtime/run-evaluator.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import type { JevableAttemptId } from '../src/runtime/run-types.ts'

const source = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'async-provider', name: 'Async provider' },
  spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
    model: { type: 'llm', config: { provider: 'fixture', model: 'fixture-model', connection: { mode: 'workspace', id: 'fixture' },
      prompt: '${{ inputs }}', responseFormat: 'text', historyScope: 'none', generation: { maxTokens: 30, stream: false }, execution: { maxAttempts: 1, timeoutSeconds: 2 } } },
    result: { type: 'output', config: { value: '${{ nodes.model.output }}' } } }, edges: [{ from: 'start', to: 'model' }, { from: 'model', to: 'result' }] } })
const node = executionModelPlans(compileLocalRun(source, DEFAULT_COMPILER_LIMITS))[0]!
const input = { prompt: 'private input', systemPrompt: '' }
const attemptId = () => randomUUID() as JevableAttemptId
const route: ProviderConnectionRecord = { generation: 1, updatedAt: new Date().toISOString(), connection: {
  id: 'fixture', provider: 'fixture', protocol: 'openai-compatible', endpoint: 'http://127.0.0.1:1/v1', allowedModels: ['fixture-model'],
  authentication: { kind: 'bearer', credentialRef: 'fixture/key' }, tokenParameter: 'max_tokens', maxResponseBytes: 10000,
  maxRequestBytes: 10000, maxStreamEvents: 100, maxTimeoutSeconds: 2 } }
const response = () => new Response(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'retained output' } }] }),
  { headers: { 'content-type': 'application/json' } })
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { vi.unstubAllGlobals(); for (const close of cleanup.splice(0).reverse()) await close() })
const store = (saveEvidence: ProviderPersistence['saveEvidence'], evidence?: ModelEvidence): ProviderPersistence => ({
  async connection() { return structuredClone(route) }, async credential() { return 'PRIVATE_FIXTURE_TOKEN' },
  async evidence() { return evidence }, saveEvidence,
})

describe('asynchronous model persistence boundary', () => {
  it('does not dispatch before intent acknowledgement or return before settlement acknowledgement', async () => {
    const intent = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), settled = Promise.withResolvers<void>(), settling = Promise.withResolvers<void>()
    const fetch = vi.fn(async () => response()); vi.stubGlobal('fetch', fetch)
    const records: ModelEvidence[] = []
    const models = new ConfiguredModels(store(async record => {
      records.push(record)
      if (record.result.status === 'pending') { entered.resolve(); await intent.promise }
      else { settling.resolve(); await settled.promise }
    }))
    let returned = false
    const pending = models.execute(node, input, attemptId()).then(value => { returned = true; return value })
    await entered.promise; expect(fetch).not.toHaveBeenCalled()
    intent.resolve(); await settling.promise
    expect(fetch).toHaveBeenCalledTimes(1); expect(returned).toBe(false)
    expect(JSON.stringify(records)).not.toContain('PRIVATE_FIXTURE_TOKEN')
    settled.resolve(); expect((await pending).output).toBe('retained output')
  })
  it('does not dispatch when the async intent write fails', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const failure = new Error('intent storage failed'), models = new ConfiguredModels(store(async () => { throw failure }))
    await expect(models.execute(node, input, attemptId())).rejects.toBe(failure)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('preserves pending evidence if the settlement write fails; retry never dispatches again', async () => {
    const fetch = vi.fn(async () => response()); vi.stubGlobal('fetch', fetch)
    let saved: ModelEvidence | undefined
    const failure = new Error('settlement storage failed')
    const persistence = { ...store(async record => {
      if (record.result.status !== 'pending') throw failure
      saved = record
    }), async evidence() { return saved } }
    const models = new ConfiguredModels(persistence), id = attemptId()
    await expect(models.execute(node, input, id)).rejects.toBe(failure)
    await expect(models.execute(node, input, id)).rejects.toMatchObject({ code: 'uncertain-attempt' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('owner loss during the intent wait prevents dispatch', async () => {
    const controller = new AbortController(), fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const lost = new Error('ownership lost')
    const models = new ConfiguredModels({ ...store(async () => { controller.abort(lost) }), signal: controller.signal })
    await expect(models.execute(node, input, attemptId())).rejects.toBe(lost)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('owner loss aborts an active provider request without recording a retryable transport error', async () => {
    const controller = new AbortController(), reached = Promise.withResolvers<void>(), lost = new Error('ownership lost')
    const fetch = vi.fn(async (_url: string, options: RequestInit) => {
      reached.resolve()
      return new Promise<Response>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true }))
    }); vi.stubGlobal('fetch', fetch)
    const writes: ModelEvidence[] = []
    const models = new ConfiguredModels({ ...store(async record => { writes.push(record) }), signal: controller.signal })
    const pending = models.execute(node, input, attemptId())
    const rejected = expect(pending).rejects.toBe(lost)
    await reached.promise; controller.abort(lost); await rejected
    expect(writes.map(record => record.result.status)).toEqual(['pending'])
  })
})

describe('asynchronous runtime admission guards', () => {
  async function runtime(admit: () => Promise<void>) {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-async-admit-'))
    const execute = vi.fn(async () => ({ output: 'result', usage: { tries: 1 as const } }))
    const owner = await LocalRuntime.open({ dataDirectory: directory, models: { admit, execute, async verify() {} } })
    cleanup.push(() => owner.close()); return { owner, execute }
  }
  it('retains ownership during readiness, blocks credential changes and releases it on failed admission', async () => {
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    const { owner, execute } = await runtime(async () => { entered.resolve(); await gate.promise; throw new ProviderError('missing-credential') })
    const pending = owner.check(source)
    try {
      await entered.promise
      expect(() => owner.configureConnection(route.connection, 0, 'local:test')).toThrow('busy')
      expect(() => owner.setCredential('fixture/key', 'new secret', 0, 'local:test')).toThrow('busy')
      await expect(owner.close()).rejects.toMatchObject({ code: 'busy' })
      expect(owner.list()).toEqual([]); expect(execute).not.toHaveBeenCalled()
    } finally { gate.resolve(); await pending }
    expect(await pending).toMatchObject({ runtimeReadiness: 'unavailable' })
    expect(owner.configureConnection(route.connection, 0, 'local:test').generation).toBe(1)
    await owner.close()
    await expect(owner.check(source)).rejects.toMatchObject({ code: 'closed' })
  })
  it.each(['show', 'events', 'exportRun', 'retainedRun'] as const)('keeps ownership until %s finishes verifying retained model evidence', async operation => {
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    const directory = await mkdtemp(join(tmpdir(), 'jevable-async-read-'))
    const execute = vi.fn(async () => ({ output: 'result', usage: { tries: 1 as const } }))
    const owner = await LocalRuntime.open({ dataDirectory: directory, models: {
      admit() {}, execute, async verify() { entered.resolve(); await gate.promise } } })
    cleanup.push(() => owner.close())
    const run = await owner.run(source, 'input')
    const pending = operation === 'retainedRun' ? owner.run(source, 'input', { id: run.id }) : owner[operation](run.id)
    try {
      await entered.promise
      await expect(owner.close()).rejects.toMatchObject({ code: 'busy' })
      expect(() => owner.setCredential('fixture/key', 'replacement', 0, 'local:test')).toThrow('busy')
    } finally { gate.resolve(); await pending }
    expect(execute).toHaveBeenCalledTimes(1)
    owner.setCredential('fixture/key', 'replacement', 0, 'local:test')
    await owner.close()
  })
  it('retains the last overlapping readiness operation and releases ownership after an unexpected failure', async () => {
    const first = Promise.withResolvers<void>(), second = Promise.withResolvers<void>()
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()], failure = new Error('fixture admission failure')
    let calls = 0
    const { owner } = await runtime(async () => {
      const index = calls++; entered[index]!.resolve()
      if (index === 0) await first.promise
      else { await second.promise; throw failure }
    })
    const a = owner.check(source), b = owner.check(source), rejected = expect(b).rejects.toBe(failure)
    try {
      await Promise.all(entered.map(item => item.promise)); first.resolve(); await a
      await expect(owner.close()).rejects.toMatchObject({ code: 'busy' })
      expect(() => owner.configureConnection(route.connection, 0, 'local:test')).toThrow('busy')
    } finally { first.resolve(); second.resolve(); await Promise.allSettled([a, b]) }
    await rejected
    owner.configureConnection(route.connection, 0, 'local:test')
    await owner.close()
  })
  it('awaits failed admission before creating a run; reserves its ID and blocks close/config changes while pending', async () => {
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    const { owner, execute } = await runtime(async () => { entered.resolve(); await gate.promise; throw new ProviderError('missing-credential') })
    const id = randomUUID(), pending = owner.run(source, 'input', { id }), rejection = expect(pending).rejects.toMatchObject({ code: 'missing-credential' })
    await entered.promise
    expect(owner.list()).toEqual([])
    await expect(owner.run(source, 'input', { id })).rejects.toMatchObject({ code: 'busy' })
    await expect(owner.close()).rejects.toMatchObject({ code: 'busy' })
    expect(() => owner.configureConnection(route.connection, 0, 'local:test')).toThrow('busy')
    gate.resolve(); await rejection
    expect(owner.list()).toEqual([]); expect(execute).not.toHaveBeenCalled()
    expect(await owner.check(source)).toMatchObject({ runtimeReadiness: 'unavailable' })
  })
  it('rechecks the reviewed project generation after async admission', async () => {
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    const { owner, execute } = await runtime(async () => { entered.resolve(); await gate.promise })
    const project = owner.editProject({ operation: 'create', title: 'Original', yaml: source, actor: 'local:test' })
    const pending = owner.runProject(project.id, project.generation, project.acceptedRevision, 'input')
    const rejection = expect(pending).rejects.toMatchObject({ code: 'conflict' })
    await entered.promise
    owner.editProject({ operation: 'rename', id: project.id, expectedGeneration: project.generation, title: 'Changed', actor: 'local:test' })
    gate.resolve(); await rejection
    expect(owner.list()).toEqual([]); expect(execute).not.toHaveBeenCalled()
  })
  it('rechecks a saved test after async admission rather than executing an edited definition', async () => {
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    const { owner, execute } = await runtime(async () => { entered.resolve(); await gate.promise })
    const project = owner.editProject({ operation: 'create', title: 'Test project', yaml: source, actor: 'local:test' })
    const draft = owner.editTest({ operation: 'create', actor: 'local:test', definition: {
      title: 'Original case', project: { id: project.id, generation: project.generation, revision: project.acceptedRevision },
      input: 'input', expectations: [{ kind: 'status', value: 'completed' }] } })
    const accepted = owner.editTest({ operation: 'accept', id: draft.id, expectedGeneration: draft.generation, reviewedSha256: draft.sha256, actor: 'local:test' })
    const pending = owner.runTest({ id: accepted.id, generation: accepted.generation, sha256: accepted.sha256 }, randomUUID())
    const rejection = expect(pending).rejects.toMatchObject({ code: 'conflict' })
    await entered.promise
    owner.editTest({ operation: 'edit', id: accepted.id, expectedGeneration: accepted.generation, actor: 'local:test',
      definition: { ...accepted.definition, title: 'Edited case', input: 'changed' } })
    gate.resolve(); await rejection
    expect(owner.list()).toEqual([]); expect(execute).not.toHaveBeenCalled()
  })
  it.each([['resume', false], ['advance', false], ['resume', true], ['advance', true]] as const)('preserves cancellation during %s admission (admission fails: %s)', async (operation, fails) => {
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    let delayed = false
    const { owner, execute } = await runtime(async () => { if (delayed) { entered.resolve(); await gate.promise; if (fails) throw new ProviderError('missing-credential') } })
    const initial = await owner.run(source, 'input', { paused: true })
    delayed = true
    const pending = operation === 'resume' ? owner.resume(initial.id) : owner.advance(initial.id,
      { requestId: randomUUID(), mode: 'continue', expectedCheckpointSha256: executionCheckpointHash(initial) }, 'local:test')
    await entered.promise
    const cancelId = randomUUID(); owner.cancel(initial.id, cancelId, 'local:test')
    gate.resolve(); const stopped = await pending
    expect(stopped.state.status).toBe('cancelled'); expect(stopped.cancellation?.id).toBe(cancelId)
    expect(execute).not.toHaveBeenCalled()
    expect((await owner.events(initial.id)).filter(event => event.kind === 'execution-requested')).toHaveLength(0)
  })
  it.each([false, true])('does not approve after cancellation during async admission (admission fails: %s)', async fails => {
    const document = JSON.parse(source)
    document.spec.nodes.review = { type: 'humanApproval', config: { title: 'Review', input: '${{ nodes.model.output }}',
      inputSchema: { type: 'string' }, actions: ['approve', 'reject'], expiresAfter: '1h', onReject: 'cancelled', onTimeout: 'expired' } }
    document.spec.edges = [{ from: 'start', to: 'model' }, { from: 'model', to: 'review' }, { from: 'review', port: 'approve', to: 'result' }]
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    let delayed = false
    const { owner, execute } = await runtime(async () => { if (delayed) { entered.resolve(); await gate.promise; if (fails) throw new ProviderError('missing-credential') } })
    const initial = await owner.run(JSON.stringify(document), 'input')
    expect(initial.state.status).toBe('waiting')
    if (initial.state.status !== 'waiting') throw new Error('Expected saved approval')
    delayed = true
    const deciding = owner.decide(initial.id, initial.state.attempt.id, 'approve', 'local:test')
    await entered.promise
    const cancellation = randomUUID(); owner.cancel(initial.id, cancellation, 'local:test')
    gate.resolve()
    const stopped = await deciding
    expect(stopped.state.status).toBe('cancelled'); expect(stopped.cancellation?.id).toBe(cancellation)
    expect(execute).toHaveBeenCalledTimes(1)
    expect((await owner.events(initial.id)).filter(event => event.kind === 'approval-decided')).toHaveLength(0)
  })
})

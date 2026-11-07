import { describe, expect, it, vi } from 'vitest'
import { readFile, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setImmediate as tick } from 'node:timers/promises'
import { DEFAULT_COMPILER_LIMITS as limits } from '../src/limits.ts'
import { compileLocalRun, initialCheckpoint } from '../src/runtime/run-evaluator.ts'
import { executeWorkflow, type ExecutionPersistence } from '../src/runtime/execution.ts'
import { runtimeStateSchema, type LocalRun } from '../src/runtime/run-types.ts'
import type { ModelCalls } from '../src/runtime/model-port.ts'
import { JournalError } from '../src/storage/postgres.ts'
import { LocalRuntime } from '../src/runtime/local.ts'
import { RunStore } from '../src/runtime/store.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const source = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'async-run', name: 'Async execution' },
  spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
    model: { type: 'llm', config: { provider: 'fixture', model: 'fixture', connection: { mode: 'workspace', id: 'fixture' },
      prompt: '${{ inputs }}', responseFormat: 'text', historyScope: 'none', generation: { maxTokens: 30, stream: false }, execution: { maxAttempts: 1, timeoutSeconds: 2 } } },
    result: { type: 'output', config: { value: '${{ nodes.model.output }}' } } }, edges: [{ from: 'start', to: 'model' }, { from: 'model', to: 'result' }] } })
function fixture(yaml = echo) {
  const graph = compileLocalRun(yaml, limits), at = new Date().toISOString()
  let record: LocalRun = { schemaVersion: 1, id: randomUUID(), yaml: graph.source.yaml, revision: graph.source.revision,
    input: 'private input', createdAt: at, updatedAt: at, state: initialCheckpoint(graph), loopDeadlines: {} }
  const events: { kind: string; data: unknown }[] = []
  const port: ExecutionPersistence = {
    async load() { await tick(); return structuredClone(record) },
    async events() { await tick(); return structuredClone(events) },
    async save(next, kind, data) { await tick(); record = structuredClone(next); events.push({ kind, data: structuredClone(data) }) },
    async saveSegment(next) { await tick(); return next },
    async finishCancellation(next) {
      await tick()
      if (!next.cancellation || ['completed', 'failed', 'cancelled'].includes(next.state.status)) return next
      record = { ...next, state: runtimeStateSchema.parse({ ...next.state, status: 'cancelled', previousStatus: next.state.status }) }
      return structuredClone(record)
    },
  }
  const controller = new AbortController()
  return { graph, port, controller, events, get record() { return record }, set record(next: LocalRun) { record = next },
    run(models?: ModelCalls, budget?: number) { return executeWorkflow({ initial: structuredClone(record), graph, limits, maxTransitions: 100,
      operation: 'run', signal: controller.signal, port, models, ...(budget === undefined ? {} : { budget }) }) } }
}
const models = (): ModelCalls => ({ admit() {}, async verify() {}, execute: vi.fn(async () => ({ output: 'retained model output', usage: { tries: 1 } })) })

describe('shared asynchronous execution loop', () => {
  it('awaits every delayed read/write and preserves deterministic node ordering', async () => {
    const f = fixture(), result = await f.run()
    expect(result.state).toMatchObject({ status: 'completed', output: 'private input' })
    expect(f.record).toEqual(result)
    expect(f.events.map(e => e.kind)).toEqual(['node-intent', 'node-result', 'node-intent', 'node-result'])
  })
  it('does not dispatch before the node intent acknowledgement or advance before result acknowledgement', async () => {
    const f = fixture(source), m = models(), save = f.port.save
    const entered = Promise.withResolvers<void>(), intent = Promise.withResolvers<void>(), settling = Promise.withResolvers<void>(), settled = Promise.withResolvers<void>()
    f.port.save = async (next, kind, data) => {
      if (kind === 'node-intent' && next.state.status === 'executing' && next.state.next === 'model') { entered.resolve(); await intent.promise }
      if (kind === 'node-result' && next.state.steps.at(-1)?.nodeId === 'model') { settling.resolve(); await settled.promise }
      await save(next, kind, data)
    }
    let returned = false
    const running = f.run(m).then(result => { returned = true; return result })
    await entered.promise; expect(m.execute).not.toHaveBeenCalled()
    intent.resolve(); await settling.promise
    expect(m.execute).toHaveBeenCalledTimes(1); expect(returned).toBe(false)
    expect(f.record.state.status).toBe('executing')
    settled.resolve(); expect((await running).state).toMatchObject({ status: 'completed', output: 'retained model output' })
  })
  it.each(['node-intent', 'node-result'] as const)('preserves an uncertain %s error even when owner-loss prevents the recovery read', async kind => {
    const f = fixture(), save = f.port.save, failure = new JournalError('commit-uncertain')
    f.port.save = async (...args) => {
      await save(...args)
      if (args[1] === kind) { f.port.load = async () => { throw new JournalError('ownership-lost') }; throw failure }
    }
    await expect(f.run()).rejects.toBe(failure)
    expect(f.events.filter(event => event.kind === kind)).toHaveLength(1)
  })
  it('refuses dispatch after owner loss during the intent acknowledgement', async () => {
    const f = fixture(source), m = models(), save = f.port.save, lost = new Error('owner lost')
    f.port.save = async (...args) => {
      await save(...args)
      if (args[1] === 'node-intent' && args[0].state.status === 'executing' && args[0].state.next === 'model') f.controller.abort(lost)
    }
    await expect(f.run(m)).rejects.toBe(lost); expect(m.execute).not.toHaveBeenCalled()
    expect(f.record.state).toMatchObject({ status: 'executing', next: 'model' })
  })
  it('retains a cancellation committed while a stale checkpoint write was awaiting', async () => {
    const f = fixture(), save = f.port.save
    f.port.save = async (...args) => {
      if (args[1] === 'node-intent') {
        f.record = { ...f.record, cancellation: { id: randomUUID(), actor: 'local:user', at: new Date().toISOString() } }
        throw new Error('stale checkpoint version')
      }
      await save(...args)
    }
    expect((await f.run()).state).toMatchObject({ status: 'cancelled', previousStatus: 'paused' })
    expect(f.events).toHaveLength(0)
  })
  it('finishes cooperative cancellation only after the model dispatch returns', async () => {
    const f = fixture(source), entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>(), m = models()
    m.execute = vi.fn(async () => { entered.resolve(); await released.promise; return { output: 'retained model output', usage: { tries: 1 } } })
    const running = f.run(m); await entered.promise
    f.record = { ...f.record, cancellation: { id: randomUUID(), actor: 'local:user', at: new Date().toISOString() } }; f.controller.abort()
    released.resolve(); const result = await running
    expect(result.state).toMatchObject({ status: 'cancelled', previousStatus: 'paused', next: 'result' })
    expect(result.state.steps.at(-1)?.output).toBe('retained model output'); expect(m.execute).toHaveBeenCalledTimes(1)
  })
  it('honors the single-step budget across asynchronous persistence', async () => {
    const f = fixture(); expect((await f.run(undefined, 1)).state).toMatchObject({ status: 'paused', next: 'result' })
    expect(f.events.map(e => e.kind)).toEqual(['node-intent', 'node-result'])
    expect((await f.run()).state.status).toBe('completed')
  })
  it('SQLite rejects a stale driver write when cancellation commits between the read and its continuation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-async-cancel-')), runtime = await LocalRuntime.open({ dataDirectory: directory })
    const id = randomUUID(), requestId = randomUUID(), get = RunStore.prototype.get
    let fired = false
    const spy = vi.spyOn(RunStore.prototype, 'get').mockImplementation(function (this: RunStore, key) {
      const record = get.call(this, key)
      if (!fired && record?.id === id && record.state.status === 'paused') {
        fired = true; queueMicrotask(() => runtime.cancel(id, requestId, 'local:owner'))
      }
      return record
    })
    try {
      const result = await runtime.run(echo, 'private input', { id })
      expect(fired).toBe(true); expect(result.cancellation?.id).toBe(requestId)
      expect(result.state).toMatchObject({ status: 'cancelled', previousStatus: 'paused' })
      expect((await runtime.events(id)).filter(e => e.kind === 'node-intent')).toHaveLength(0)
    } finally { spy.mockRestore(); await runtime.close() }
    const reopened = await LocalRuntime.open({ dataDirectory: directory })
    try { expect((await reopened.show(id)).cancellation?.id).toBe(requestId) }
    finally { await reopened.close() }
  })
})

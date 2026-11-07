import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LocalRuntime, executionCheckpointHash, type LocalRun, type ExecutionControl, type ModelCalls } from '../src/runtime/index.ts'
import { RunStore } from '../src/runtime/store.ts'
import { RunLedger } from '../src/runtime/run-ledger.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { runReceipt } from '../src/runtime/receipts.ts'
import { main } from '../src/cli.ts'
import { renderTemplate, listTemplates } from '../src/templates/index.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(options: Partial<Parameters<typeof LocalRuntime.open>[0]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-pause-'))
  const runtime = await LocalRuntime.open({ dataDirectory: directory, ...options }); cleanup.push(() => runtime.close())
  return { runtime, directory }
}
const command = (run: LocalRun, mode: ExecutionControl['mode'] = 'pause'): ExecutionControl => ({
  requestId: randomUUID(), expectedCheckpointSha256: executionCheckpointHash(run), mode,
})
const actor = 'local:PRIVATE_PAUSE_ACTOR'
const source = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'pause-model', name: 'Pause model' },
  spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
    write: { type: 'llm', config: { provider: 'fixture', model: 'fixture', connection: { mode: 'workspace', id: 'fixture' },
      prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 20, stream: false },
      execution: { timeoutSeconds: 60, maxAttempts: 1 }, historyScope: 'none' } },
    end: { type: 'output', config: { value: '${{ nodes.write.output }}' } } },
  edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }] } })
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

describe('durable cooperative pause', () => {
  it('keeps an idle checkpoint paused across retry/reopen and needs a fresh guarded continuation', async () => {
    const { runtime, directory } = await fixture(), start = await runtime.run(echo, 'PRIVATE_INPUT', { paused: true })
    const request = command(start), paused = await runtime.advance(start.id, request, actor)
    expect(paused.state).toEqual(start.state)
    expect(runReceipt(paused).pause).toMatchObject({ requestId: request.requestId, status: 'at-safe-checkpoint' })
    expect(await runtime.advance(start.id, request, actor)).toEqual(paused)
    await expect(runtime.advance(start.id, request, 'local:other')).rejects.toHaveProperty('code', 'conflict')
    await expect(runtime.advance(start.id, { ...request, mode: 'continue' }, actor)).rejects.toHaveProperty('code', 'conflict')
    const retained = await runtime.resume(start.id) // Legacy resume cannot discard a requested pause.
    expect(retained.state).toEqual(start.state)
    await runtime.close()
    const reopened = await LocalRuntime.open({ dataDirectory: directory }); cleanup.push(() => reopened.close())
    expect(await reopened.advance(start.id, request, actor)).toEqual(retained)
    const completed = await reopened.advance(start.id, command(retained, 'continue'), actor)
    expect(completed.state).toMatchObject({ status: 'completed', output: 'PRIVATE_INPUT' })
    expect(runReceipt(completed)).not.toHaveProperty('pause')
    expect(await reopened.advance(start.id, request, actor)).toEqual(completed)
    expect(JSON.stringify(await reopened.exportRun(start.id))).not.toContain('PRIVATE_')
  })

  it('does not abort an in-flight model; settles once and stops before downstream dispatch', async () => {
    const started = deferred(), release = deferred(), execute = vi.fn(async (_plan, _input, _id, signal) => {
      started.resolve(); await release.promise; expect(signal?.aborted).toBe(false)
      return { output: 'written', usage: { tries: 1 } }
    })
    const { runtime } = await fixture({ models: { admit() {}, execute, async verify() {} } })
    const id = randomUUID(), work = runtime.run(source, 'PRIVATE_INPUT', { id }); await started.promise
    try {
      const before = await runtime.show(id), request = command(before), paused = await runtime.advance(id, request, actor)
      expect(paused.state.status).toBe('executing')
      expect(runReceipt(paused).pause?.status).toContain('may be active or uncertain')
      expect(await runtime.advance(id, request, actor)).toEqual(paused)
      await expect(runtime.advance(id, command(paused, 'continue'), actor)).rejects.toHaveProperty('code', 'busy')
      release.resolve(); const result = await work
      expect(result.state).toMatchObject({ status: 'paused', next: 'end' })
      expect(result.state.steps.map(step => step.nodeId)).toEqual(['start', 'write'])
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await runtime.show(id)).toEqual(result)
      expect((await runtime.exportRun(id)).snapshot.run.pause?.status).toBe('at-safe-checkpoint')
      expect((await runtime.advance(id, command(result, 'continue'), actor)).state.status).toBe('completed')
      expect(execute).toHaveBeenCalledTimes(1)
    } finally { release.resolve(); await work.catch(() => {}) }
  })

  it('never converts an uncertain model intent into a safe pause or redispatches it', async () => {
    const started = deferred(), release = deferred(), execute = vi.fn(async () => {
      started.resolve(); await release.promise; throw Error('response lost')
    })
    const { runtime, directory } = await fixture({ models: { admit() {}, execute, async verify() {} } })
    const id = randomUUID(), work = runtime.run(source, 'input', { id }); const outcome = work.catch(error => error)
    await started.promise
    const request = command(await runtime.show(id)); await runtime.advance(id, request, actor)
    release.resolve(); expect(await outcome).toHaveProperty('message', 'response lost')
    const uncertain = await runtime.show(id); expect(uncertain.state.status).toBe('executing')
    expect(await runtime.advance(id, request, actor)).toEqual(uncertain)
    await expect(runtime.advance(id, command(uncertain, 'continue'), actor)).rejects.toHaveProperty('code', 'conflict')
    await runtime.close()
    const reopened = await LocalRuntime.open({ dataDirectory: directory, models: { admit() {}, execute, async verify() {} } }); cleanup.push(() => reopened.close())
    expect(await reopened.advance(id, request, actor)).toEqual(uncertain); expect(execute).toHaveBeenCalledTimes(1)
  })

  it('refuses stale checkpoints, breakpoint edits on pause, waiting and terminal states', async () => {
    const { runtime } = await fixture(), start = await runtime.run(echo, 'input', { paused: true }), request = command(start)
    await expect(runtime.advance(start.id, { ...request, breakpoints: [] }, actor)).rejects.toHaveProperty('code', 'invalid-command')
    const step = await runtime.advance(start.id, command(start, 'step'), actor)
    await expect(runtime.advance(start.id, request, actor)).rejects.toHaveProperty('code', 'conflict')
    const done = await runtime.advance(start.id, command(step, 'continue'), actor)
    await expect(runtime.advance(start.id, command(done), actor)).rejects.toHaveProperty('code', 'conflict')
    const waiting = await runtime.run(approval, { message: 'review' })
    await expect(runtime.advance(waiting.id, command(waiting), actor)).rejects.toHaveProperty('code', 'conflict')
  })

  it('does not persist or report a successful pause when the control write fails', async () => {
    const { runtime } = await fixture(), start = await runtime.run(echo, 'input', { paused: true }), request = command(start)
    const save = RunStore.prototype.save, spy = vi.spyOn(RunStore.prototype, 'save').mockImplementation(function(this: RunStore, record, kind, data) {
      if (kind === 'execution-requested') throw Error('cannot commit pause')
      return save.call(this, record, kind, data)
    })
    await expect(runtime.advance(start.id, request, actor)).rejects.toThrow('cannot commit pause'); spy.mockRestore()
    expect(await runtime.show(start.id)).toEqual(start)
    expect((await runtime.events(start.id)).map(event => event.kind)).toEqual(['run-created'])
  })

  it('does not let an older continuation overwrite a pause admitted during async model admission', async () => {
    const models: ModelCalls = { admit() {}, execute: async () => ({ output: 'written', usage: { tries: 1 } }), async verify() {} }
    const { runtime } = await fixture({ models }), start = await runtime.run(source, 'input', { paused: true })
    const started = deferred(), release = deferred()
    models.admit = async () => { started.resolve(); await release.promise }
    const continuing = runtime.advance(start.id, command(start, 'continue'), actor); const outcome = continuing.catch(error => error)
    await started.promise
    const paused = await runtime.advance(start.id, command(start), actor); release.resolve()
    expect(await outcome).toHaveProperty('code', 'conflict')
    expect(await runtime.show(start.id)).toEqual(paused)
  })

  it('retains a pause arriving at approval-node dispatch without authorizing its decision or downstream work', async () => {
    const { runtime } = await fixture(), save = RunStore.prototype.save
    let pause: Promise<LocalRun> | undefined
    const spy = vi.spyOn(RunStore.prototype, 'save').mockImplementation(function(this: RunStore, record, kind, data) {
      save.call(this, record, kind, data)
      if (kind === 'node-intent' && record.state.status === 'executing' && record.state.next === 'review') pause = runtime.advance(record.id, command(record), actor)
    })
    const waiting = await runtime.run(approval, { message: 'review' }); await pause; spy.mockRestore()
    expect(pause).toBeDefined(); expect(waiting.state.status).toBe('waiting')
    expect(runReceipt(waiting).pause?.status).toContain('approval-wait')
    if (waiting.state.status !== 'waiting') throw Error('Expected approval wait')
    const decided = await runtime.decide(waiting.id, waiting.state.attempt.id, 'approve', actor)
    expect(decided.state).toMatchObject({ status: 'paused', next: 'result' })
    expect((await runtime.advance(waiting.id, command(decided, 'continue'), actor)).state.status).toBe('completed')
  })

  it('reports terminal-before-checkpoint when the already-dispatched final node completes', async () => {
    const { runtime } = await fixture(), save = RunStore.prototype.save
    let pause: Promise<LocalRun> | undefined
    const spy = vi.spyOn(RunStore.prototype, 'save').mockImplementation(function(this: RunStore, record, kind, data) {
      save.call(this, record, kind, data)
      if (kind === 'node-intent' && record.state.status === 'executing' && record.state.next === 'result') pause = runtime.advance(record.id, command(record), actor)
    })
    const done = await runtime.run(echo, 'input'); await pause; spy.mockRestore()
    expect(done.state.status).toBe('completed')
    expect(runReceipt(done).pause?.status).toBe('terminal-before-next-checkpoint')
    expect(await runtime.show(done.id)).toEqual(done)
  })

  it('retains breakpoint configuration and lets durable cancellation take precedence', async () => {
    const { runtime } = await fixture(), start = await runtime.run(echo, 'input', { paused: true })
    const hit = await runtime.advance(start.id, { ...command(start, 'continue'), breakpoints: ['start', 'result'] }, actor)
    const paused = await runtime.advance(start.id, command(hit), actor)
    expect(runReceipt(paused)).toHaveProperty('breakpoints', ['start', 'result'])
    const next = await runtime.advance(start.id, command(paused, 'continue'), actor)
    expect(runReceipt(next)).toHaveProperty('breakpoint.nodeId', 'result')
    const requested = await runtime.advance(start.id, command(next), actor)
    const stopped = runtime.cancel(start.id, randomUUID(), actor)
    expect(runReceipt(stopped).pause?.status).toBe('superseded-by-cancellation')
    await expect(runtime.advance(start.id, command(stopped), actor)).rejects.toHaveProperty('code', 'conflict')
    expect(requested.state.steps).toEqual(stopped.state.steps)
  })

  it('preserves scoped loop pauses without extending their deadlines', async () => {
    const { runtime } = await fixture(), template = listTemplates().find(item => item.id === 'expense-check')!
    const yaml = JSON.stringify(renderTemplate(template.id)), normal = await runtime.run(yaml, template.sample)
    const body = normal.state.steps.find(step => step.scope)!.nodeId
    const start = await runtime.run(yaml, template.sample, { paused: true })
    const hit = await runtime.advance(start.id, { ...command(start, 'continue'), breakpoints: [body] }, actor)
    const paused = await runtime.advance(start.id, command(hit), actor)
    expect(paused.state).toEqual(hit.state); expect(paused.loopDeadlines).toEqual(hit.loopDeadlines)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 86_400_000)
    const expired = await runtime.resume(start.id)
    expect(expired.state).toMatchObject({ status: 'failed', code: 'loop-timeout' })
    expect(expired.state.steps).toEqual(paused.state.steps)
    expect(await runtime.show(expired.id)).toEqual(expired)
  })

  it('detects a forged guard or pause moved before its actual checkpoint in matching journal/record copies', async () => {
    const { runtime } = await fixture(), start = await runtime.run(echo, 'input', { paused: true })
    const step = await runtime.advance(start.id, command(start, 'step'), actor)
    const paused = await runtime.advance(start.id, command(step), actor), events = await runtime.events(start.id)
    const ledger = new RunLedger(DEFAULT_COMPILER_LIMITS)
    ledger.check(paused, { events })
    const bad = structuredClone(paused), altered = structuredClone(events)
    bad.controlRequests!.at(-1)!.expectedCheckpointSha256 = 'a'.repeat(64)
    altered.at(-1)!.data = bad.controlRequests!.at(-1)
    expect(() => ledger.check(bad, { events: altered })).toThrow('corrupt')
    const reordered = [events[0]!, events[1]!, events.at(-1)!, ...events.slice(2, -1)]
    expect(() => ledger.check(paused, { events: reordered })).toThrow('corrupt')
  })

  it('CLI pause is receipt success, not workflow completion; reject breakpoint editing flags', async () => {
    const { runtime, directory } = await fixture(), start = await runtime.run(echo, 'input', { paused: true })
    await runtime.close()
    const request = command(start), out = vi.fn(), err = vi.fn()
    const args = ['runs', 'pause', start.id, '--request-id', request.requestId, '--checkpoint-sha256', request.expectedCheckpointSha256, '--data-dir', directory]
    expect(await main([...args, '--breakpoints-file', 'anything.json'], { out, err })).toBe(2)
    expect(await main(args, { out, err })).toBe(0)
    const receipt = JSON.parse(out.mock.calls.at(-1)![0]); expect(receipt.pause.status).toBe('at-safe-checkpoint')
    expect(await main(args, { out, err })).toBe(0)
    expect(JSON.parse(out.mock.calls.at(-1)![0])).toEqual(receipt)
  })
})

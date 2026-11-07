import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { LocalRuntime, executionCheckpointHash, type LocalRun, type ExecutionControl } from '../src/runtime/index.ts'
import { runtimeStateSchema } from '../src/runtime/run-types.ts'
import { RunStore } from '../src/runtime/store.ts'
import { RunLedger } from '../src/runtime/run-ledger.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { runReceipt } from '../src/runtime/receipts.ts'
import { renderTemplate, listTemplates } from '../src/templates/index.ts'
import { main } from '../src/cli.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(options: Partial<Parameters<typeof LocalRuntime.open>[0]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-breakpoint-'))
  const runtime = await LocalRuntime.open({ dataDirectory: directory, ...options }); cleanup.push(() => runtime.close())
  return { runtime, directory }
}
const control = (run: LocalRun, breakpoints?: string[], mode: ExecutionControl['mode'] = 'continue'): ExecutionControl => ({
  requestId: randomUUID(), expectedCheckpointSha256: executionCheckpointHash(run), mode,
  ...(breakpoints === undefined ? {} : { breakpoints }),
})
const actor = 'local:PRIVATE_OWNER'

describe('persistent pre-dispatch node breakpoints', () => {
  it('stops before a model call and never re-dispatches an uncertain attempt', async () => {
    let fail = true
    const execute = vi.fn(async () => { if (fail) throw Error('uncertain provider response'); return { output: 'written', usage: { tries: 1 } } })
    const source = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'model', name: 'Model' },
      spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
        write: { type: 'llm', config: { provider: 'fixture', model: 'fixture', connection: { mode: 'workspace', id: 'fixture' },
          prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 20, stream: false },
          execution: { timeoutSeconds: 60, maxAttempts: 1 }, historyScope: 'none' } },
        end: { type: 'output', config: { value: '${{ nodes.write.output }}' } } },
      edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }] } })
    const { runtime } = await fixture({ models: { admit() {}, execute, async verify() {} } })
    const run = await runtime.run(source, 'private input', { paused: true })
    const hit = await runtime.advance(run.id, control(run, ['write']), actor)
    expect(execute).not.toHaveBeenCalled(); expect(hit.state).toMatchObject({ status: 'paused', next: 'write' })
    const request = control(hit)
    await expect(runtime.advance(hit.id, request, actor)).rejects.toThrow('uncertain provider response')
    const retained = await runtime.advance(hit.id, request, actor)
    expect(retained.state.status).toBe('executing')
    await expect(runtime.advance(hit.id, control(retained, []), actor)).rejects.toHaveProperty('code', 'conflict')
    expect(execute).toHaveBeenCalledTimes(1)
    fail = false
    const second = await runtime.run(source, 'input', { paused: true })
    const before = await runtime.advance(second.id, control(second, ['write', 'end']), actor)
    const after = await runtime.advance(second.id, control(before), actor)
    expect(after.state).toMatchObject({ status: 'paused', next: 'end' })
    expect(after.breakpointHits).toHaveLength(2); expect(await runtime.show(second.id)).toEqual(after)
  })

  it('durable cancellation takes priority over a retained breakpoint', async () => {
    const { runtime } = await fixture(), run = await runtime.run(echo, 'input', { paused: true })
    const hit = await runtime.advance(run.id, control(run, ['start']), actor)
    const cancelled = await runtime.cancel(hit.id, randomUUID(), actor)
    expect(cancelled.state.status).toBe('cancelled'); expect(cancelled.state.steps).toHaveLength(0)
    expect(runReceipt(cancelled)).not.toHaveProperty('breakpoint')
    await expect(runtime.advance(hit.id, control(cancelled, []), actor)).rejects.toHaveProperty('code', 'conflict')
  })
  it('stops before dispatch, retains exact retries/restart, and bypasses each recorded hit once', async () => {
    const { runtime, directory } = await fixture(), start = await runtime.run(echo, 'PRIVATE_INPUT', { paused: true })
    const command = control(start, ['start', 'result']), hit = await runtime.advance(start.id, command, actor)
    expect(hit.state).toEqual(start.state)
    expect(hit.breakpointHits).toHaveLength(1)
    expect((await runtime.events(hit.id)).map(event => event.kind)).toEqual(['run-created', 'execution-requested', 'breakpoint-hit'])
    expect(await runtime.advance(hit.id, command, actor)).toEqual(hit)
    await expect(runtime.advance(hit.id, { ...command, breakpoints: [] }, actor)).rejects.toHaveProperty('code', 'conflict')
    await runtime.close()
    const reopened = await LocalRuntime.open({ dataDirectory: directory }); cleanup.push(() => reopened.close())
    const next = await reopened.advance(hit.id, control(hit), actor)
    expect(next.state).toMatchObject({ status: 'paused', next: 'result', steps: [{ nodeId: 'start' }] })
    expect(next.breakpointHits).toHaveLength(2)
    expect(runReceipt(next)).toMatchObject({ breakpoints: ['start', 'result'], breakpoint: { nodeId: 'result' } })
    const evidence = await reopened.exportRun(next.id)
    expect(JSON.stringify(evidence)).not.toContain('PRIVATE_')
    expect(evidence.snapshot.journal.filter(event => event.kind === 'breakpoint-hit')).toHaveLength(2)
    const done = await reopened.advance(next.id, control(next), actor)
    expect(done.state).toMatchObject({ status: 'completed', output: 'PRIVATE_INPUT' })
    expect(runReceipt(done)).not.toHaveProperty('breakpoint')
    expect(await reopened.show(done.id)).toEqual(done)
  })

  it('steps through a configured node; omission retains configuration and [] clears it', async () => {
    const { runtime } = await fixture(), start = await runtime.run(echo, 'input', { paused: true })
    const step = await runtime.advance(start.id, control(start, ['start', 'result'], 'step'), actor)
    expect(step.state.steps).toHaveLength(1); expect(step.breakpointHits).toBeUndefined()
    const hit = await runtime.advance(step.id, control(step), actor)
    expect(hit.breakpointHits?.[0]?.nodeId).toBe('result')
    const done = await runtime.advance(hit.id, control(hit, []), actor)
    expect(done.state.status).toBe('completed'); expect(runReceipt(done)).toHaveProperty('breakpoints', [])
  })

  it.each([['missing'], ['start', 'start'], Array.from({ length: 129 }, (_, i) => `node-${i}`)])('refuses invalid configuration without an admitted control: %j', async (...ids) => {
    const { runtime } = await fixture(), run = await runtime.run(echo, 'input', { paused: true })
    await expect(runtime.advance(run.id, control(run, ids), actor)).rejects.toHaveProperty('code', 'invalid-command')
    expect(await runtime.show(run.id)).toEqual(run)
  })

  it('copies caller configuration before asynchronous validation', async () => {
    const { runtime } = await fixture(), run = await runtime.run(echo, 'input', { paused: true }), list = ['start']
    const pending = runtime.advance(run.id, control(run, list), actor); list.splice(0)
    expect((await pending).breakpointHits?.[0]?.nodeId).toBe('start')
  })

  it('re-arms loop-body nodes each iteration and creates no deadline at a loop-entry hit', async () => {
    const { runtime } = await fixture(), template = listTemplates().find(item => item.id === 'expense-check')!
    const workflow = renderTemplate(template.id), nodes = workflow.spec.nodes as Record<string, { type: string }>
    const loopId = Object.keys(nodes).find(id => nodes[id]?.type === 'loop')!
    const normal = await runtime.run(JSON.stringify(workflow), template.sample)
    const bodyId = normal.state.steps.find(step => step.scope && step.nodeId !== loopId)!.nodeId
    let run = await runtime.run(JSON.stringify(workflow), template.sample, { paused: true })
    run = await runtime.advance(run.id, control(run, [loopId, bodyId]), actor)
    expect(run.breakpointHits?.at(-1)?.nodeId).toBe(loopId); expect(run.loopDeadlines).toEqual({})
    const indexes: number[] = []
    while (run.state.status === 'paused') {
      run = await runtime.advance(run.id, control(run), actor)
      if (run.state.status === 'paused') {
        expect(run.breakpointHits?.at(-1)?.nodeId).toBe(bodyId)
        indexes.push(run.breakpointHits!.at(-1)!.scope!.index)
        expect(indexes.length).toBeLessThan(20)
      }
    }
    expect(indexes.length).toBeGreaterThan(1)
    expect(indexes).toEqual(indexes.map((_, i) => i))
    expect(run.state.status).toBe(normal.state.status)
    const values = (r: LocalRun) => r.state.steps.map(({ nodeId, output, scope }) => ({ nodeId, output, scope }))
    expect(values(run)).toEqual(values(normal))
  })

  it('does not let a breakpoint suspend an expired loop deadline', async () => {
    const { runtime } = await fixture(), template = listTemplates().find(item => item.id === 'expense-check')!
    const yaml = JSON.stringify(renderTemplate(template.id)), normal = await runtime.run(yaml, template.sample)
    const body = normal.state.steps.find(step => step.scope)!.nodeId
    const start = await runtime.run(yaml, template.sample, { paused: true })
    const hit = await runtime.advance(start.id, control(start, [body]), actor)
    expect(hit.state.status).toBe('paused')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 86_400_000)
    const expired = await runtime.advance(hit.id, control(hit), actor)
    expect(expired.state).toMatchObject({ status: 'failed', code: 'loop-timeout' })
    expect(expired.breakpointHits).toHaveLength(1)
    expect(await runtime.show(hit.id)).toEqual(expired)
  })

  it('honors downstream breakpoints after a real approval, without approving automatically', async () => {
    const { runtime } = await fixture(), run = await runtime.run(approval, { message: 'Review' }, { paused: true })
    const waiting = await runtime.advance(run.id, control(run, ['result']), actor)
    expect(waiting.state.status).toBe('waiting')
    if (waiting.state.status !== 'waiting') throw Error('Expected approval')
    const hit = await runtime.decide(run.id, waiting.state.attempt.id, 'approve', actor)
    expect(hit.state).toMatchObject({ status: 'paused', next: 'result' })
    expect(hit.breakpointHits).toHaveLength(1)
    expect((await runtime.resume(run.id)).state.status).toBe('completed')
  })

  it('never dispatches or fabricates a hit after a failed hit commit', async () => {
    const { runtime } = await fixture(), start = await runtime.run(echo, 'input', { paused: true }), command = control(start, ['start'])
    const save = RunStore.prototype.save
    const spy = vi.spyOn(RunStore.prototype, 'save').mockImplementation(function(this: RunStore, record, kind, data) {
      if (kind === 'breakpoint-hit') throw Error('storage unavailable')
      return save.call(this, record, kind, data)
    })
    await expect(runtime.advance(start.id, command, actor)).rejects.toThrow('storage unavailable')
    spy.mockRestore()
    const retained = await runtime.advance(start.id, command, actor)
    expect(retained.state.steps).toHaveLength(0); expect(retained.breakpointHits).toBeUndefined()
    expect((await runtime.advance(start.id, control(retained), actor)).breakpointHits).toHaveLength(1)
  })

  it('rejects corrupted hit metadata and a valid later checkpoint moved before its settlement', async () => {
    const { runtime } = await fixture(), start = await runtime.run(echo, 'input', { paused: true })
    const hit = await runtime.advance(start.id, control(start, ['result']), actor), events = await runtime.events(start.id)
    const ledger = new RunLedger(DEFAULT_COMPILER_LIMITS)
    expect(() => ledger.check(hit, { events })).not.toThrow()
    for (const change of [{ checkpointSha256: '0'.repeat(64) }, { configurationRequestId: randomUUID() }, { stepCount: 0 }]) {
      const damaged = structuredClone(hit); Object.assign(damaged.breakpointHits![0]!, change)
      const damagedEvents = events.map(e => e.kind === 'breakpoint-hit' ? { ...e, data: damaged.breakpointHits![0] } : e)
      expect(() => ledger.check(damaged, { events: damagedEvents })).toThrow('corrupt')
    }
    const moved = [events[0]!, events[1]!, events.at(-1)!, ...events.slice(2, -1)]
    expect(() => ledger.check(hit, { events: moved })).toThrow('corrupt')
  })

  it('preserves legacy checkpoint hashes and migrates schema 12 without changing retained runs', async () => {
    const { runtime, directory } = await fixture(), old = await runtime.run(echo, 'old', { paused: true })
    const legacy = createHash('sha256').update(JSON.stringify({ id: old.id, revision: old.revision,
      state: runtimeStateSchema.parse(old.state), cancellation: null, lastControlRequest: null })).digest('hex')
    expect(executionCheckpointHash(old)).toBe(legacy)
    await runtime.close()
    const db = new DatabaseSync(join(directory, 'runtime.sqlite')); db.exec('PRAGMA user_version=12'); db.close()
    const reopened = await LocalRuntime.open({ dataDirectory: directory }); cleanup.push(() => reopened.close())
    expect(await reopened.show(old.id)).toEqual(old)
    expect((await reopened.advance(old.id, control(old, ['start']), actor)).breakpointHits).toHaveLength(1)
  })

  it('exposes CLI configuration files and refuses malformed files before creating state', async () => {
    const { runtime, directory } = await fixture(), run = await runtime.run(echo, 'input', { paused: true })
    await runtime.close()
    const file = join(directory, 'breakpoints.json'); await writeFile(file, '["result"]')
    const out = vi.fn(), error = vi.fn()
    const args = ['runs', 'continue', run.id, '--request-id', randomUUID(), '--checkpoint-sha256', executionCheckpointHash(run),
      '--breakpoints-file', file, '--data-dir', directory]
    expect(await main(args, { out, err: error })).toBe(3)
    expect(JSON.parse(out.mock.calls[0]![0])).toMatchObject({ breakpoint: { nodeId: 'result' } })
    await writeFile(file, '{}')
    args[args.length - 1] = join(directory, 'must-not-exist')
    expect(await main(args, { out, err: error })).toBe(1)
    expect(JSON.parse(error.mock.calls.at(-1)![0]).code).toBe('invalid-command')
    await expect(stat(args.at(-1)!)).rejects.toHaveProperty('code', 'ENOENT')
  })
})

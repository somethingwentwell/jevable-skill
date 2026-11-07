import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { LocalRuntime, executionCheckpointHash, type LocalRun, type ExecutionControl, type ModelCalls } from '../src/runtime/index.ts'
import { RunStore } from '../src/runtime/store.ts'
import { runReceipt } from '../src/runtime/receipts.ts'
import { renderTemplate, listTemplates } from '../src/templates/index.ts'
import { main } from '../src/cli.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(options: Partial<Parameters<typeof LocalRuntime.open>[0]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-control-'))
  const runtime = await LocalRuntime.open({ dataDirectory: directory, ...options }); cleanup.push(() => runtime.close())
  return { runtime, directory }
}
const control = (run: LocalRun, mode: ExecutionControl['mode'] = 'step'): ExecutionControl => ({ requestId: randomUUID(), expectedCheckpointSha256: executionCheckpointHash(run), mode })
const actor = 'local:PRIVATE_DEBUG_OWNER'
const modelSource = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'model', name: 'Model' },
  spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
    write: { type: 'llm', config: { provider: 'fixture', model: 'fixture', connection: { mode: 'workspace', id: 'fixture' },
      prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 20, stream: false },
      execution: { timeoutSeconds: 60, maxAttempts: 1 }, historyScope: 'none' } },
    end: { type: 'output', config: { value: '${{ nodes.write.output }}' } } },
  edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }] } })

describe('guarded explicit execution control', () => {
  it('admits a paused run without attempts, advances once, and retains retry identity across restart', async () => {
    const { runtime, directory } = await fixture(), id = randomUUID()
    const run = await runtime.run(echo, 'PRIVATE_INPUT', { id, paused: true })
    expect(run.state).toMatchObject({ status: 'paused', steps: [] })
    expect((await runtime.events(id)).map(event => event.kind)).toEqual(['run-created'])
    expect(await runtime.run(echo, 'PRIVATE_INPUT', { id, paused: true })).toEqual(run)
    await expect(runtime.run(echo, 'PRIVATE_INPUT', { id })).rejects.toHaveProperty('code', 'conflict')
    const request = control(run), stepped = await runtime.advance(id, request, actor)
    expect(stepped.state).toMatchObject({ status: 'paused', steps: [{ nodeId: 'start' }] })
    expect(runReceipt(stepped).checkpointSha256).not.toBe(runReceipt(run).checkpointSha256)
    expect(await runtime.advance(id, request, actor)).toEqual(stepped)
    await expect(runtime.advance(id, { ...request, requestId: randomUUID() }, actor)).rejects.toHaveProperty('code', 'conflict')
    await runtime.close()
    const reopened = await LocalRuntime.open({ dataDirectory: directory }); cleanup.push(() => reopened.close())
    expect(await reopened.advance(id, request, actor)).toEqual(stepped)
    const continued = await reopened.advance(id, control(stepped, 'continue'), actor)
    expect(continued.state).toMatchObject({ status: 'completed', output: 'PRIVATE_INPUT' })
    expect(await reopened.advance(id, request, actor)).toEqual(continued) // Current state, not a stale frozen receipt.
    const evidence = await reopened.exportRun(id)
    expect(evidence.snapshot.journal.filter(event => event.kind === 'execution-requested')).toHaveLength(2)
    expect(JSON.stringify(evidence)).not.toContain('PRIVATE_')
    expect((await reopened.exportRun(id, true)).snapshot.private!.run.controlRequests![0]!.actor).toBe(actor)
  })

  it('steps real model calls once and refuses uncertain dispatch, stale guards and altered request reuse', async () => {
    let fail = false
    const execute = vi.fn(async () => { if (fail) throw Error('transport lost'); return { output: 'written', usage: { tries: 1 } } })
    const models: ModelCalls = { admit() {}, execute, async verify() {} }
    const { runtime } = await fixture({ models })
    let run = await runtime.run(modelSource, 'input', { paused: true })
    expect(execute).not.toHaveBeenCalled()
    run = await runtime.advance(run.id, control(run), actor)
    const request = control(run), written = await runtime.advance(run.id, request, actor)
    expect(execute).toHaveBeenCalledTimes(1); expect(written.state.status).toBe('paused')
    expect(await runtime.advance(run.id, request, actor)).toEqual(written)
    await expect(runtime.advance(run.id, { ...request, mode: 'continue' }, actor)).rejects.toHaveProperty('code', 'conflict')
    await expect(runtime.advance(run.id, request, 'local:someone-else')).rejects.toHaveProperty('code', 'conflict')
    fail = true
    let uncertain = await runtime.run(modelSource, 'input', { paused: true })
    uncertain = await runtime.advance(uncertain.id, control(uncertain), actor)
    const uncertainRequest = control(uncertain)
    await expect(runtime.advance(uncertain.id, uncertainRequest, actor)).rejects.toThrow()
    const retained = await runtime.advance(uncertain.id, uncertainRequest, actor)
    expect(retained.state.status).toBe('executing'); expect(execute).toHaveBeenCalledTimes(2)
    await expect(runtime.advance(retained.id, control(retained), actor)).rejects.toHaveProperty('code', 'conflict')
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('stops at real approvals and can commit a decision without executing downstream nodes', async () => {
    const { runtime } = await fixture(), start = await runtime.run(approval, { message: 'Review' }, { paused: true })
    const waiting = await runtime.advance(start.id, control(start, 'continue'), actor)
    expect(waiting.state.status).toBe('waiting')
    await expect(runtime.advance(start.id, control(waiting), actor)).rejects.toHaveProperty('code', 'conflict')
    if (waiting.state.status !== 'waiting') throw Error('Expected wait')
    const decisionOptions = { pauseAfter: true }
    const decision = runtime.decide(start.id, waiting.state.attempt.id, 'approve', actor, decisionOptions)
    decisionOptions.pauseAfter = false // Async verification must not permit a caller mutation to authorize continuation.
    const decided = await decision
    expect(decided.state.status).toBe('paused')
    expect((await runtime.events(start.id)).at(-1)!.kind).toBe('approval-decided')
    const completed = await runtime.advance(start.id, control(decided), actor)
    expect(completed.state).toMatchObject({ status: 'completed', output: 'approve' })
    await expect(runtime.advance(start.id, control(completed), actor)).rejects.toHaveProperty('code', 'conflict')
  })

  it('counts one evaluator transition, not one displayed loop step, and preserves scope across controls', async () => {
    const { runtime } = await fixture(), template = listTemplates().find(item => item.id === 'expense-check')!
    const yaml = JSON.stringify(renderTemplate(template.id))
    let run = await runtime.run(yaml, template.sample, { paused: true }), scopes = 0
    while (run.state.status === 'paused') {
      const before = (await runtime.events(run.id)).filter(event => event.kind === 'node-intent').length
      run = await runtime.advance(run.id, control(run), actor)
      expect((await runtime.events(run.id)).filter(event => event.kind === 'node-intent')).toHaveLength(before + 1)
      if ('scope' in run.state && run.state.scope) scopes++
      expect(run.controlRequests!.length).toBeLessThan(100)
    }
    expect(scopes).toBeGreaterThan(0); expect(run.state.status).toBe('waiting')
    const normal = await runtime.run(yaml, template.sample)
    expect(normal.state.status).toBe(run.state.status)
    const values = (value: LocalRun) => value.state.steps.map(({ nodeId, output, scope }) => ({ nodeId, output, scope }))
    expect(values(run)).toEqual(values(normal))
  })

  it('retains admitted controls if dispatch fails before intent; retry never silently starts them', async () => {
    const { runtime } = await fixture(), run = await runtime.run(echo, 'input', { paused: true }), request = control(run)
    const save = RunStore.prototype.save
    const spy = vi.spyOn(RunStore.prototype, 'save').mockImplementation(function(this: RunStore, record, kind, data) {
      if (kind === 'node-intent') throw Error('disk unavailable')
      return save.call(this, record, kind, data)
    })
    await expect(runtime.advance(run.id, request, actor)).rejects.toThrow('disk unavailable')
    spy.mockRestore()
    const retained = await runtime.advance(run.id, request, actor)
    expect(retained.state).toEqual(run.state); expect(retained.controlRequests).toHaveLength(1)
    expect(executionCheckpointHash(retained)).not.toBe(executionCheckpointHash(run))
    await expect(runtime.advance(run.id, { ...request, requestId: randomUUID() }, actor)).rejects.toHaveProperty('code', 'conflict')
    expect((await runtime.advance(run.id, control(retained), actor)).state.steps).toHaveLength(1)
  })

  it('does not reset transition limits and does not dispatch when control admission fails', async () => {
    const { runtime } = await fixture({ maxTransitionsPerRun: 1 }), run = await runtime.run(echo, 'input', { paused: true })
    const save = RunStore.prototype.save
    const spy = vi.spyOn(RunStore.prototype, 'save').mockImplementation(function(this: RunStore, record, kind, data) {
      if (kind === 'execution-requested') throw Error('cannot admit')
      return save.call(this, record, kind, data)
    })
    await expect(runtime.advance(run.id, control(run), actor)).rejects.toThrow('cannot admit')
    expect((await runtime.events(run.id)).map(event => event.kind)).toEqual(['run-created']); spy.mockRestore()
    const step = await runtime.advance(run.id, control(run), actor), request = control(step, 'continue')
    await expect(runtime.advance(run.id, request, actor)).rejects.toHaveProperty('code', 'limit')
    expect((await runtime.advance(run.id, request, actor)).state).toEqual(step.state)
  })

  it('serializes concurrent controls and honors cancellation during verification without dispatch', async () => {
    const { runtime } = await fixture(), run = await runtime.run(echo, 'input', { paused: true }), request = control(run)
    const first = runtime.advance(run.id, request, actor)
    await expect(runtime.advance(run.id, request, actor)).rejects.toHaveProperty('code', 'busy')
    const stepped = await first, show = runtime.show.bind(runtime)
    vi.spyOn(runtime, 'show').mockImplementationOnce(async id => {
      const observed = await show(id); runtime.cancel(id, randomUUID(), actor); return observed
    })
    const stopped = await runtime.advance(run.id, control(stepped), actor)
    expect(stopped.state.status).toBe('cancelled')
    expect(stopped.state.steps).toEqual(stepped.state.steps)
  })

  it('owns request data across async validation and rejects unsupported flags', async () => {
    const { runtime } = await fixture(), run = await runtime.run(echo, 'input', { paused: true }), request = control(run)
    const promise = runtime.advance(run.id, request, actor); request.mode = 'continue'
    expect((await promise).state.status).toBe('paused')
    await expect(runtime.advance(run.id, { ...request, unexpected: true } as ExecutionControl, actor)).rejects.toHaveProperty('code', 'invalid-command')
    await expect(runtime.run(echo, 'input', { paused: 'yes' as unknown as boolean })).rejects.toHaveProperty('code', 'invalid-command')
  })

  it('preserves schema-11 evidence and checks control provenance on reopen', async () => {
    const { runtime, directory } = await fixture(), old = await runtime.run(echo, 'before')
    await runtime.close()
    let db = new DatabaseSync(join(directory, 'runtime.sqlite')); db.exec('PRAGMA user_version=11'); db.close()
    const reopened = await LocalRuntime.open({ dataDirectory: directory }); cleanup.push(() => reopened.close())
    expect(await reopened.show(old.id)).toEqual(old)
    const run = await reopened.run(echo, 'new', { paused: true })
    await reopened.advance(run.id, control(run), actor); await reopened.close()
    db = new DatabaseSync(join(directory, 'runtime.sqlite'))
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(18)
    db.prepare("UPDATE events SET data='{}' WHERE run_id=? AND kind='execution-requested'").run(run.id); db.close()
    await expect(LocalRuntime.open({ dataDirectory: directory })).rejects.toHaveProperty('code', 'corrupt')
  })

  it('pins paused project admission and provides CLI step/continue without autoexecution on inspection', async () => {
    const { runtime, directory } = await fixture(), project = runtime.editProject({ operation: 'create', title: 'Debug', yaml: echo, actor })
    const run = await runtime.runProject(project.id, 1, project.acceptedRevision, 'input', { paused: true })
    expect(run.project).toEqual({ id: project.id, generation: 1 }); await runtime.close()
    const out = vi.fn(), err = vi.fn(), request = control(run)
    const argv = ['runs', 'step', run.id, '--request-id', request.requestId, '--checkpoint-sha256', request.expectedCheckpointSha256, '--data-dir', directory]
    expect(await main(argv, { out, err })).toBe(3)
    const step = JSON.parse(out.mock.calls.at(-1)![0]); expect(step.status).toBe('paused')
    expect(await main(argv, { out, err })).toBe(3)
    expect(JSON.parse(out.mock.calls.at(-1)![0])).toEqual(step)
    expect(await main(['runs', 'continue', run.id, '--request-id', randomUUID(), '--checkpoint-sha256', step.checkpointSha256, '--data-dir', directory], { out, err })).toBe(0)
    expect(JSON.parse(out.mock.calls.at(-1)![0]).output).toBe('input')
  })
})

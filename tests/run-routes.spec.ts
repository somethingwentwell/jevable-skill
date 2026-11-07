import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parse } from 'yaml'
import { LocalRuntime, executionCheckpointHash, type LocalRun, type ModelCalls } from '../src/runtime/index.ts'
import { RunLedger } from '../src/runtime/run-ledger.ts'
import { recordedRoutes } from '../src/runtime/run-routes.ts'
import { RunStore } from '../src/runtime/store.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { createPreview, projectPreviewExecution } from '../src/preview/index.ts'
import { runReceipt } from '../src/runtime/receipts.ts'

const approval = parse(await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8'))
const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const owners: LocalRuntime[] = []
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); for (const owner of owners.splice(0)) await owner.close() })
async function open(dataDirectory?: string, models?: ModelCalls) {
  const directory = dataDirectory ?? await mkdtemp(join(tmpdir(), 'jevable-routes-'))
  const runtime = await LocalRuntime.open({ dataDirectory: directory, ...(models ? { models } : {}) }); owners.push(runtime)
  return { runtime, directory }
}
const control = (run: LocalRun, mode: 'step' | 'continue' = 'step') => ({ requestId: randomUUID(), mode, expectedCheckpointSha256: executionCheckpointHash(run) })
const rule = (mode: 'switch' | 'ifElse') => JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'route', name: 'Routes' },
  spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
    choose: { type: 'rule', config: mode === 'switch' ? { mode, value: '${{ inputs }}', cases: [{ value: 'yes', port: 'yes' }] }
      : { mode, condition: '${{ inputs == "yes" }}' } },
    end: { type: 'output', config: { value: '${{ inputs }}' } } }, edges: [{ from: 'start', to: 'choose' },
    ...(mode === 'switch' ? ['yes', 'default'] : ['true', 'false']).map(port => ({ from: 'choose', port, to: 'end' }))] } })

const loopSource = (mode: 'forEach' | 'repeatUntil', until = false, badExit = false) => JSON.stringify({
  apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'loops', name: 'Loop ports' },
  spec: { inputSchema: { type: 'array', items: { type: 'string' } }, nodes: {
    start: { type: 'trigger', config: { modes: ['manual'] } },
    each: { type: 'loop', config: { mode, ...(mode === 'forEach' ? { items: '${{ inputs }}' }
      : { input: '${{ inputs }}', until: until ? '${{ true }}' : '${{ false }}', onLimit: 'branch' }), maxIterations: 2, timeoutSeconds: 60,
      body: { entry: 'check', nodes: { check: { type: 'rule', config: { mode: 'ifElse', condition: '${{ true }}' } } }, edges: [],
        exits: ['true', 'false'].map(port => ({ from: 'check', port, result: badExit ? '${{ inputs[99] }}' : true })) } } },
    end: { type: 'output', config: { value: '${{ nodes.each.output.count }}' } } },
    edges: [{ from: 'start', to: 'each' }, { from: 'each', port: 'done', to: 'end' },
      ...(mode === 'repeatUntil' ? [{ from: 'each', port: 'limit', to: 'end' }] : [])] } })

describe('durably recorded outgoing ports', () => {
  it.each([['ifElse', 'yes', 'true'], ['ifElse', 'no', 'false'], ['switch', 'yes', 'yes'], ['switch', 'no', 'default']] as const)
  ('records %s %s as %s before the target executes and preserves it across reopen', async (mode, input, port) => {
    const { runtime, directory } = await open(), source = rule(mode)
    let run = await runtime.run(source, input, { paused: true })
    run = await runtime.advance(run.id, control(run), 'fixture')
    run = await runtime.advance(run.id, control(run), 'fixture')
    expect(run.state).toMatchObject({ status: 'paused', next: 'end' })
    expect(run.state.steps.map(step => step.port)).toEqual(['next', port])
    const events = await runtime.events(run.id)
    expect(events.flatMap(event => (event.data as { routes?: unknown[] }).routes ?? [])).toEqual(recordedRoutes(run.state.steps))
    const view = projectPreviewExecution(createPreview(source), runReceipt(run))
    expect(view.graphs[0]!.nodes.find(node => node.id === 'end')).toMatchObject({ count: 0, status: 'next' })
    expect(view.graphs[0]!.edges.filter(edge => edge.selectedCount === 1)).toHaveLength(2)
    await runtime.close()
    const reopened = (await open(directory)).runtime
    expect(await reopened.show(run.id)).toEqual(run)
    const done = await reopened.advance(run.id, control(run, 'continue'), 'fixture')
    expect(done.state.steps.at(-1)).not.toHaveProperty('port')
    expect((await reopened.exportRun(run.id)).snapshot.steps.map(step => step.port)).toEqual(['next', port, undefined])
  })

  it.each(['approve', 'reject', 'timeout'])('records explicit approval branch %s without publishing actor or review data', async port => {
    const workflow = structuredClone(approval)
    workflow.spec.nodes.review.config.onReject = 'branch'; workflow.spec.nodes.review.config.onTimeout = 'branch'
    workflow.spec.edges = [{ from: 'start', to: 'review' }, ...['approve', 'reject', 'timeout'].map(port => ({ from: 'review', port, to: 'result' }))]
    const { runtime } = await open(), run = await runtime.run(JSON.stringify(workflow), { message: 'PRIVATE_REVIEW' })
    if (run.state.status !== 'waiting') throw Error('Expected wait')
    expect(run.state.steps.map(step => step.port)).toEqual(['next'])
    if (port === 'timeout') { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(run.state.expiresAt) + 1) }
    const done = await runtime.decide(run.id, run.state.attempt.id, port === 'timeout' ? 'approve' : port, 'PRIVATE_ACTOR')
    expect(done.state.steps.map(step => step.port)).toEqual(['next', port, undefined])
    const evidence = await runtime.exportRun(run.id)
    expect(evidence.snapshot.journal.find(event => event.kind === 'approval-decided')).toHaveProperty('routes', [{ stepIndex: 1, nodeId: 'review', port }])
    expect(JSON.stringify(evidence)).not.toContain('PRIVATE_')
  })

  it.each([['forEach', [], false, 'done', 0], ['forEach', ['a', 'b'], false, 'done', 2],
    ['repeatUntil', [], true, 'done', 1], ['repeatUntil', [], false, 'limit', 2]] as const)
  ('records %s completion %s %s %s separately from body exits', async (mode, input, until, port, count) => {
    const { runtime } = await open(), source = loopSource(mode, until), run = await runtime.run(source, [...input])
    expect(run.state).toMatchObject({ status: 'completed', output: count })
    expect(run.state.steps.filter(step => step.nodeId === 'each' && step.scope).every(step => step.port === undefined)).toBe(true)
    expect(run.state.steps.find(step => step.nodeId === 'each' && !step.scope)?.port).toBe(port)
    const before = await runtime.events(run.id)
    const view = projectPreviewExecution(createPreview(source), runReceipt(await runtime.show(run.id)))
    expect(view.graphs[1]!.exits.reduce((n, exit) => n + exit.selectedCount, 0)).toBe(count)
    expect(await runtime.events(run.id)).toEqual(before)
  })

  it('retains a selected body exit without claiming that its return binding succeeded', async () => {
    const { runtime } = await open(), source = loopSource('forEach', false, true), run = await runtime.run(source, ['one'])
    expect(run.state).toMatchObject({ status: 'failed', code: 'invalid-node-value' })
    expect(run.state.steps.map(step => step.port)).toEqual(['next', 'true'])
    const view = projectPreviewExecution(createPreview(source), runReceipt(await runtime.show(run.id)))
    expect(view.graphs[1]!.exits[0]!.selectedCount).toBe(1)
    const doneIndex = createPreview(source).graphs[0]!.edges.findIndex(edge => edge.from === 'each')
    expect(view.graphs[0]!.edges[doneIndex]!.selectedCount).toBe(0)
  })

  it('records Decision next separately from the Rule using its typed answer', async () => {
    const workflow = parse(await readFile(new URL('../examples/decision.yaml', import.meta.url), 'utf8'))
    workflow.spec.nodes.judge.config.provider = 'llm'
    workflow.spec.nodes.judge.config.llm = { provider: 'fixture', generation: { maxTokens: 200, stream: false } }
    const source = JSON.stringify(workflow)
    const execute = vi.fn(async () => ({ output: JSON.stringify({ value: {
      route: { type: 'choice', choice: 'billing', probabilities: { billing: 0.75, technical: 0.25 }, confidence: 0.8 },
      urgency: { type: 'score', score: 1.6, probabilities: [0.1, 0.2, 0.7], confidence: 0.7 },
      needsHuman: { type: 'noul', probability: 0.9, confidence: 0.9 },
    } }), usage: { tries: 1 } }))
    const { runtime } = await open(undefined, { admit() {}, execute, async verify() {} }), run = await runtime.run(source, 'PRIVATE_TICKET')
    expect(run.state.steps.map(step => step.port)).toEqual(['next', 'next', 'true', undefined])
    await runtime.exportRun(run.id); await runtime.show(run.id)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('does not publish a selected port when the settlement write fails', async () => {
    const { runtime } = await open(), id = randomUUID(), original = RunStore.prototype.save
    vi.spyOn(RunStore.prototype, 'save').mockImplementation(function (this: RunStore, record, kind, data) {
      if (kind === 'node-result') throw Error('fixture storage failure')
      return original.call(this, record, kind, data)
    })
    await expect(runtime.run(echo, 'input', { id })).rejects.toThrow('fixture storage failure')
    expect((await runtime.show(id)).state).toMatchObject({ status: 'executing', steps: [] })
    expect((await runtime.events(id)).some(event => event.kind === 'node-result')).toBe(false)
  })

  it('reads and continues legacy checkpoints without backfilling missing port fields', async () => {
    const { runtime, directory } = await open()
    let run = await runtime.run(rule('ifElse'), 'yes', { paused: true })
    run = await runtime.advance(run.id, control(run), 'fixture'); await runtime.close()
    const db = new DatabaseSync(join(directory, 'runtime.sqlite'))
    try {
      const record = JSON.parse((db.prepare('SELECT record FROM runs WHERE id=?').get(run.id) as { record: string }).record)
      record.state.steps.forEach((step: { port?: string }) => { delete step.port })
      db.prepare('UPDATE runs SET record=? WHERE id=?').run(JSON.stringify(record), run.id)
      for (const row of db.prepare('SELECT sequence,data FROM events WHERE run_id=?').all(run.id) as { sequence: number; data: string }[]) {
        const data = JSON.parse(row.data); delete data.routes
        db.prepare('UPDATE events SET data=? WHERE sequence=?').run(JSON.stringify(data), row.sequence)
      }
    } finally { db.close() }
    const reopened = (await open(directory)).runtime, legacy = await reopened.show(run.id)
    expect(legacy.state.steps[0]).not.toHaveProperty('port')
    const done = await reopened.advance(run.id, control(legacy, 'continue'), 'fixture')
    expect(done.state.steps.map(step => step.port)).toEqual([undefined, 'true', undefined])
    expect((await reopened.exportRun(run.id)).snapshot.steps[0]).not.toHaveProperty('port')
  })

  it('rejects contradictory, missing, reordered and incorrectly attributed route evidence', async () => {
    const { runtime } = await open(), run = await runtime.run(rule('ifElse'), 'yes'), events = await runtime.events(run.id)
    const check = (r: LocalRun, e: typeof events) => new RunLedger(DEFAULT_COMPILER_LIMITS).check(r, { events: e })
    check(run, events)
    const forged = structuredClone(run); forged.state.steps[1]!.port = 'false'
    expect(() => check(forged, events)).toThrow('corrupt')
    for (const change of [
      (e: any[]) => { delete e.find(event => event.kind === 'node-result').data.routes },
      (e: any[]) => { e.find(event => event.kind === 'node-result').data.routes[0].port = 'false' },
      (e: any[]) => { e.find(event => event.kind === 'node-result').data.attemptId = randomUUID() },
      (e: any[]) => { e.find(event => event.kind === 'node-result').data.routes[0].stepIndex = 1 },
      (e: any[]) => { e[0].data.routes = [] },
      (e: any[]) => { [e[1], e[2]] = [e[2], e[1]] },
    ]) { const mutated = structuredClone(events); change(mutated); expect(() => check(run, mutated)).toThrow('corrupt') }
  })
})

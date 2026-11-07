import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPreview, projectPreviewNodeInspection, renderPreview } from '../src/preview/index.ts'
import { LocalRuntime, executionCheckpointHash, type LocalRun } from '../src/runtime/index.ts'
import { PreviewSession } from '../src/preview/session.ts'
import { dispatchOperation, type RuntimeOperation } from '../src/http/operations.ts'
import { renderTemplate, listTemplates } from '../src/templates/index.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
async function runtime() {
  const rt = await LocalRuntime.open({ dataDirectory: await mkdtemp(join(tmpdir(), 'jevable-node-inspect-')) })
  cleanup.push(() => rt.close()); return rt
}
function command(run: LocalRun, nodeId = 'result', index: number | 'checkpoint' = run.state.steps.length - 1, graphScope = 'workflow') {
  return { id: run.id, expectedCheckpointSha256: executionCheckpointHash(run), selection: { graphScope, nodeId,
    record: index === 'checkpoint' ? { kind: 'checkpoint' as const } : { kind: 'step' as const, index } } }
}
describe('private per-node recorded projection', () => {
  it('returns one detached real result, excluding other steps/source/run input/actors/raw model data', async () => {
    const rt = await runtime(), run = await rt.run(echo, '<script>PRIVATE_VALUE</script>'), before = await rt.events(run.id)
    const result = projectPreviewNodeInspection(createPreview(echo), run, command(run))
    expect(result).toMatchObject({ privateInspection: true, kind: 'node-result', status: 'settled',
      output: { status: 'recorded', value: '<script>PRIVATE_VALUE</script>' } })
    expect(Object.keys(result)).not.toContain('yaml'); expect(result).not.toHaveProperty('steps')
    expect(result).not.toHaveProperty('modelOutput'); expect(result).not.toHaveProperty('approval')
    expect(await rt.events(run.id)).toEqual(before); expect(await rt.show(run.id)).toEqual(run)
    result.selection.nodeId = 'start'; expect(command(run).selection.nodeId).toBe('result')
    const saved = structuredClone(run); saved.state.steps.at(-1)!.inspection!.modelOutput = 'PRIVATE_RAW_MODEL'
    expect(JSON.stringify(projectPreviewNodeInspection(createPreview(echo), saved, command(saved)))).not.toContain('PRIVATE_RAW_MODEL')
  })
  it('distinguishes missing historical input from a recorded null, false or zero', async () => {
    const rt = await runtime(), run = await rt.run(echo, 'value'), legacy = structuredClone(run)
    delete legacy.state.steps.at(-1)!.inspection
    const preview = createPreview(echo)
    expect(projectPreviewNodeInspection(preview, legacy, command(legacy)).input).toEqual({ status: 'unavailable' })
    for (const input of [null, false, 0, '', {}]) {
      const saved = structuredClone(run); saved.state.steps.at(-1)!.inspection!.input = input
      expect(projectPreviewNodeInspection(preview, saved, command(saved)).input).toEqual({ status: 'recorded', value: input })
    }
  })
  it('never evaluates a paused node to produce missing input/output', async () => {
    const rt = await runtime(), paused = await rt.run(echo, 'PRIVATE_RUN_INPUT', { paused: true }), before = await rt.events(paused.id)
    const result = projectPreviewNodeInspection(createPreview(echo), paused, command(paused, 'start', 'checkpoint'))
    expect(result).toMatchObject({ kind: 'checkpoint', status: 'paused', input: { status: 'unavailable' }, output: { status: 'unavailable' } })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_RUN_INPUT'); expect(await rt.events(paused.id)).toEqual(before)
  })
  it('shows prepared approval input and unsettled output without a decision or reconstruction', async () => {
    const rt = await runtime(), run = await rt.run(approval, { message: 'PRIVATE_REVIEW' }), before = await rt.events(run.id)
    const result = projectPreviewNodeInspection(createPreview(approval), run, command(run, 'review', 'checkpoint'))
    expect(result).toMatchObject({ status: 'waiting', kind: 'checkpoint', attemptId: (run.state as any).attempt.id,
      input: { status: 'recorded' }, output: { status: 'unsettled' } })
    expect(JSON.stringify(result.input)).toContain('PRIVATE_REVIEW'); expect(await rt.events(run.id)).toEqual(before)
    const stopped = await rt.cancel(run.id, randomUUID(), 'PRIVATE_CANCEL_ACTOR')
    const cancelled = projectPreviewNodeInspection(createPreview(approval), stopped, command(stopped, 'review', 'checkpoint'))
    expect(cancelled).toMatchObject({ status: 'cancelled', previousStatus: 'waiting', output: { status: 'unsettled' } })
    expect(JSON.stringify(cancelled)).not.toContain('PRIVATE_CANCEL_ACTOR')
  })
  it('keeps failure inspection private without leaking the approving actor', async () => {
    const rt = await runtime(), waiting = await rt.run(approval, { message: 'PRIVATE_REJECT' })
    const failed = await rt.decide(waiting.id, (waiting.state as any).attempt.id, 'reject', 'PRIVATE_APPROVAL_ACTOR')
    const result = projectPreviewNodeInspection(createPreview(approval), failed, command(failed, 'review', 'checkpoint'))
    expect(result).toMatchObject({ status: 'failed', code: 'approval-rejected', output: { status: 'unavailable' } })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_APPROVAL_ACTOR')
  })
  it('pins exact global step/graph/iteration and labels loop bookkeeping separately', async () => {
    const source = JSON.stringify(renderTemplate('expense-check')), preview = createPreview(source), rt = await runtime()
    const run = await rt.run(source, listTemplates().find(item => item.id === 'expense-check')!.sample)
    const records = run.state.steps.map((step, index) => ({ step, index }))
    for (const { step, index } of records.filter(({ step }) => step.nodeId === 'item')) {
      const result = projectPreviewNodeInspection(preview, run, command(run, 'item', index, 'workflow/each'))
      expect(result).toMatchObject({ kind: 'node-result', scope: step.scope, selection: { record: { index } } })
      expect(result.output).toEqual({ status: 'recorded', value: step.output })
      expect(() => projectPreviewNodeInspection(preview, run, command(run, 'item', index))).toThrow('not-found')
    }
    for (const { step, index } of records.filter(({ step }) => step.nodeId === 'each'))
      expect(projectPreviewNodeInspection(preview, run, command(run, 'each', index)).kind)
        .toBe(step.scope ? 'loop-iteration-result' : 'loop-aggregate')
  })
  it.each(['id', 'revision', 'checkpoint', 'node', 'graph', 'index', 'source'])('refuses mismatched %s without private error text', async mismatch => {
    const rt = await runtime(), run = await rt.run(echo, 'PRIVATE_PAYLOAD'), request = command(run), preview = createPreview(echo)
    const copy = structuredClone(run)
    if (mismatch === 'id') request.id = randomUUID()
    if (mismatch === 'revision') copy.revision = 'b'.repeat(64)
    if (mismatch === 'checkpoint') request.expectedCheckpointSha256 = 'b'.repeat(64)
    if (mismatch === 'node') request.selection.nodeId = 'start'
    if (mismatch === 'graph') request.selection.graphScope = 'workflow/missing'
    if (mismatch === 'index') (request.selection.record as any).index = 500
    if (mismatch === 'source') copy.yaml = approval
    let error: Error | undefined
    try { projectPreviewNodeInspection(preview, copy, request) } catch (caught) { error = caught as Error }
    expect(error).toBeDefined(); expect(error!.message).not.toContain('PRIVATE_PAYLOAD')
  })
  it('refuses unsupported selectors, completed checkpoint and oversized private fields', async () => {
    const rt = await runtime(), run = await rt.run(echo, 'value'), preview = createPreview(echo), request = command(run)
    for (const bad of [{ ...request, includePrivate: true }, { ...request, selection: { ...request.selection, actor: 'x' } },
      { ...request, selection: { ...request.selection, record: { kind: 'step', index: -1 } } },
      { ...request, selection: { ...request.selection, record: { kind: 'step', index: 50000 } } }])
      expect(() => projectPreviewNodeInspection(preview, run, bad)).toThrow('invalid-command')
    expect(() => projectPreviewNodeInspection(preview, run, command(run, 'result', 'checkpoint'))).toThrow('not-found')
    const large = structuredClone(run); large.state.steps.at(-1)!.output = 'x'.repeat(8_000_001)
    expect(() => projectPreviewNodeInspection(preview, large, command(large))).toThrow('limit')
  })
  it('keeps portable preview evidence-free even after private inspection', async () => {
    const rt = await runtime(), run = await rt.run(echo, 'PRIVATE_SCREEN_VALUE')
    projectPreviewNodeInspection(createPreview(echo), run, command(run))
    const rendered = renderPreview(echo)
    expect(rendered.html).not.toContain('PRIVATE_SCREEN_VALUE'); expect(rendered.html).not.toContain('node-private-load')
    expect(rendered.html).toContain('connect-src &#39;none&#39;')
  })
})

describe('project-scoped node inspection protocol through the actual owner', () => {
  it('rechecks the private capture, refuses foreign runs and preserves the journal/checkpoint', async () => {
    const rt = await runtime(), call = vi.fn((operation: RuntimeOperation) => dispatchOperation({ storage: 'sqlite', runtime: rt }, operation, 'PRIVATE_HOST_ACTOR'))
    const session = await PreviewSession.create({ call }, echo)
    const receipt = await session.operation({ operation: 'run', id: randomUUID(), input: 'PRIVATE_OUTPUT' }) as any
    const run = await rt.show(receipt.id), request = { operation: 'node.inspect', ...command(run) }, before = await rt.events(run.id)
    expect(await session.operation(request)).toMatchObject({ output: { status: 'recorded', value: 'PRIVATE_OUTPUT' } })
    expect(await rt.events(run.id)).toEqual(before)
    call.mockClear()
    await expect(session.operation({ ...request, expectedCheckpointSha256: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'conflict' })
    expect(call.mock.calls.map(([op]) => op.operation)).toEqual(['runs.show'])
    const foreign = await rt.run(echo, 'FOREIGN_OUTPUT'); call.mockClear()
    await expect(session.operation({ operation: 'node.inspect', ...command(foreign) })).rejects.toMatchObject({ code: 'not-found' })
    expect(call.mock.calls.map(([op]) => op.operation)).toEqual(['runs.show'])
    const malicious = structuredClone(run); malicious.project!.id = randomUUID()
    let pin: { id: string; generation: number } | undefined
    const raceOwner = { call: async (op: RuntimeOperation) => op.operation === 'runs.show'
      ? { ...receipt, project: pin }
      : op.operation === 'runs.inspect' ? { schemaVersion: 1, privateInspection: true, run: malicious } : call(op) }
    const guarded = await PreviewSession.create(raceOwner, echo)
    // Use its own exact pin for the preceding public read, never for the malicious private record.
    pin = { id: guarded.pin.id, generation: guarded.pin.generation }
    await expect(guarded.operation(request)).rejects.toMatchObject({ code: 'not-found' })
  })
})

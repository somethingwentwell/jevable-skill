import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { createPreview, projectPreviewExecution } from '../src/preview/index.ts'
import { LocalRuntime, executionCheckpointHash, type LocalRun, type ModelCalls } from '../src/runtime/index.ts'
import { runReceipt } from '../src/runtime/receipts.ts'
import { renderTemplate, listTemplates } from '../src/templates/index.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const close: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const done of close.splice(0).reverse()) await done() })
async function runtime(models?: ModelCalls) {
  const value = await LocalRuntime.open({ dataDirectory: await mkdtemp(join(tmpdir(), 'jevable-overlay-')), ...(models ? { models } : {}) })
  close.push(() => value.close()); return value
}
const control = (run: LocalRun, mode: 'step' | 'continue' = 'step') => ({ requestId: randomUUID(), expectedCheckpointSha256: executionCheckpointHash(run), mode })
const project = (source: string, run: LocalRun) => projectPreviewExecution(createPreview(source), runReceipt(run))
const node = (view: ReturnType<typeof project>, id: string, scope = 'workflow') => view.graphs.find(graph => graph.scope === scope)!.nodes.find(node => node.id === id)!

describe('metadata-only execution graph projection', () => {
  it('maps actual paused, stepped and completed receipts without executing or leaking payloads', async () => {
    const rt = await runtime(), initial = await rt.run(echo, 'PRIVATE_INPUT', { paused: true })
    expect(node(project(echo, initial), 'start')).toMatchObject({ status: 'next', count: 0, timedRecords: 0 })
    const stepped = await rt.advance(initial.id, control(initial), 'PRIVATE_ACTOR')
    const view = project(echo, stepped)
    expect(node(view, 'start')).toMatchObject({ status: 'settled', count: 1, timedRecords: 1 })
    expect(view.graphs[0]!.nodes.filter(item => item.status === 'next')).toHaveLength(1)
    expect(view.graphs[0]!.edges[0]).toMatchObject({ status: 'selected', count: 1, selectedCount: 1 })
    const completed = await rt.advance(initial.id, control(stepped, 'continue'), 'PRIVATE_ACTOR')
    const before = await rt.events(initial.id), projected = project(echo, completed)
    expect(projected.status).toBe('completed'); expect(projected.summary).toContain('not a test-assessment claim')
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_')
    expect(await rt.events(initial.id)).toEqual(before)
    expect(runInNewContext(`(${projectPreviewExecution.toString()})(preview, receipt)`, {
      preview: createPreview(echo), receipt: runReceipt(completed),
    })).toEqual(projected) // The browser-serialized function has no module dependency.
  })

  it('distinguishes real approval waits, failed checkpoints and cancelled waits', async () => {
    const rt = await runtime(), waiting = await rt.run(approval, { message: 'PRIVATE_REVIEW' })
    if (waiting.state.status !== 'waiting') throw Error('Expected approval')
    const pending = node(project(approval, waiting), waiting.state.next)
    expect(pending).toMatchObject({ status: 'waiting', count: 0, attemptId: waiting.state.attempt.id })
    const rejected = await rt.decide(waiting.id, waiting.state.attempt.id, 'reject', 'PRIVATE_ACTOR')
    expect(project(approval, rejected).graphs[0]!.nodes.some(item => item.status === 'failed')).toBe(true)
    const second = await rt.run(approval, { message: 'PRIVATE_REVIEW' })
    const cancelled = await rt.cancel(second.id, randomUUID(), 'PRIVATE_ACTOR')
    expect(project(approval, cancelled).graphs[0]!.nodes.some(item => item.status === 'stopped')).toBe(true)
    expect(project(approval, cancelled).summary).toContain('external effects are not reverted')
    expect(JSON.stringify(project(approval, cancelled))).not.toContain('PRIVATE_')
  })

  it('keeps loop iterations, synthetic returns and aggregate results distinct from attempts', async () => {
    const rt = await runtime(), source = JSON.stringify(renderTemplate('expense-check'))
    const sample = listTemplates().find(item => item.id === 'expense-check')!.sample
    let run = await rt.run(source, sample, { paused: true }), bodyCheckpoints = 0
    while (run.state.status === 'paused') {
      const view = project(source, run)
      if (run.state.scope) {
        bodyCheckpoints++
        expect(node(view, 'each').status).toBe('active-loop')
        expect(node(view, 'item', 'workflow/each')).toMatchObject({ status: 'next', currentIteration: run.state.scope.index })
      }
      run = await rt.advance(run.id, control(run), 'test')
    }
    expect(bodyCheckpoints).toBe(2)
    const view = project(source, run), body = node(view, 'item', 'workflow/each'), loop = node(view, 'each')
    expect(body).toMatchObject({ count: 2, iterations: [0, 1], timedRecords: 2 })
    expect(body.records.map(item => item.iteration)).toEqual([0, 1])
    expect(body.records.map(item => item.port)).toEqual(['true', 'false'])
    expect(view.graphs[1]!.exits.map(exit => exit.selectedCount)).toEqual([1, 1])
    expect(loop).toMatchObject({ count: 3, iterations: [0, 1], timedRecords: 0 })
    expect(loop.records.every(item => item.attemptId === undefined)).toBe(true)
    expect(node(view, 'small')).toMatchObject({ status: 'unobserved', count: 0 })
    expect(view.graphs[0]!.edges.find(item => item.index === 3)).toMatchObject({ status: 'unobserved', count: 0 })
  })

  it('refuses overlays on a draft with colliding outer and body identities', () => {
    const workflow: any = renderTemplate('expense-check'), body = workflow.spec.nodes.each.config.body
    body.nodes.each = body.nodes.item; delete body.nodes.item; body.entry = 'each'
    body.exits.forEach((exit: any) => { exit.from = 'each' })
    const preview = createPreview(JSON.stringify(workflow))
    expect(preview.validation.status).not.toBe('valid')
    expect(() => projectPreviewExecution(preview, { id: randomUUID(), revision: preview.revision, status: 'paused', nodeId: 'each',
      scope: { loop: 'each', index: 0 }, steps: [] })).toThrow('admitted preview')
  })

  it('disambiguates recorded same-target ports but keeps legacy adjacency ambiguous', async () => {
    const workflow: any = renderTemplate('expense-check')
    workflow.spec.edges.find((edge: any) => edge.from === 'large' && edge.port === 'false').to = 'review'
    delete workflow.spec.nodes.small
    const source = JSON.stringify(workflow), rt = await runtime()
    const run = await rt.run(source, listTemplates().find(item => item.id === 'expense-check')!.sample)
    const view = project(source, run)
    expect(view.ambiguousConnections).toBe(0)
    const branchIndices = createPreview(source).graphs[0]!.edges.flatMap((edge, index) => edge.from === 'large' ? [index] : [])
    expect(branchIndices.map(index => view.graphs[0]!.edges[index]!.status)).toEqual(['unobserved', 'selected'])
    const receipt = runReceipt(run)
    const legacy = projectPreviewExecution(createPreview(source), { ...receipt, steps: receipt.steps.map(({ port: _port, ...step }) => step) })
    expect(legacy.ambiguousConnections).toBe(1)
    expect(branchIndices.map(index => legacy.graphs[0]!.edges[index]!.status)).toEqual(['ambiguous', 'ambiguous'])
    expect(branchIndices.map(index => legacy.graphs[0]!.edges[index]!.selectedCount)).toEqual([0, 0])
  })

  it('allowlists model usage and trace metadata, bounds old records and rejects unsafe timings', () => {
    const preview = createPreview(echo), attemptId = randomUUID(), trace = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1, secret: 'PRIVATE_TRACE' }
    const receipt = { id: randomUUID(), revision: preview.revision, status: 'completed', output: 'PRIVATE_OUTPUT', actor: 'PRIVATE_ACTOR',
      steps: Array.from({ length: 205 }, () => ({ nodeId: 'start', attemptId, durationMs: 2,
        modelUsage: { tries: 1, inputTokens: 3, outputTokens: 4, secret: 'PRIVATE_USAGE' }, trace, input: 'PRIVATE_INPUT' })) }
    const view = projectPreviewExecution(preview, receipt), result = node(view, 'start')
    expect(result).toMatchObject({ count: 205, timedRecords: 205, recordedDurationMs: 410, omittedRecords: 5 })
    expect(result.records).toHaveLength(200); expect(result.records[0]!.index).toBe(5)
    expect(result.records[0]!.modelUsage).toEqual({ tries: 1, inputTokens: 3, outputTokens: 4 })
    expect(JSON.stringify(view)).not.toContain('PRIVATE_')
    expect(() => projectPreviewExecution(preview, { ...receipt, revision: 'other' })).toThrow('match')
    expect(() => projectPreviewExecution(preview, { ...receipt, steps: [{ nodeId: 'start', durationMs: -1 }] })).toThrow('duration')
    expect(() => projectPreviewExecution(preview, { ...receipt, steps: [{ nodeId: 'missing' }] })).toThrow('unknown')
    expect(() => projectPreviewExecution(preview, { ...receipt, steps: Array(2).fill({ nodeId: 'start', durationMs: Number.MAX_SAFE_INTEGER }) })).toThrow('safe integer')
  })
  it('rejects unknown, terminal and loop-bookkeeping port claims', async () => {
    const rt = await runtime(), receipt = runReceipt(await rt.run(echo, 'input')), preview = createPreview(echo)
    for (const port of ['invented', '', '<script>']) {
      const bad = structuredClone(receipt); bad.steps[0]!.port = port
      expect(() => projectPreviewExecution(preview, bad)).toThrow(/port/)
    }
    const terminal = structuredClone(receipt); terminal.steps.at(-1)!.port = 'next'
    expect(() => projectPreviewExecution(preview, terminal)).toThrow(/port/)
    const source = JSON.stringify(renderTemplate('expense-check'))
    const loop = runReceipt(await rt.run(source, listTemplates().find(item => item.id === 'expense-check')!.sample))
    loop.steps.find(step => step.nodeId === 'each' && step.scope)!.port = 'done'
    expect(() => projectPreviewExecution(createPreview(source), loop)).toThrow(/port/)
  })

  it('projects retained unsettled model intent and model usage from real runtime receipts', async () => {
    const source = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'model', name: 'Model' },
      spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
        write: { type: 'llm', config: { provider: 'fixture', model: 'fixture', connection: { mode: 'workspace', id: 'fixture' },
          prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 20, stream: false },
          execution: { timeoutSeconds: 60, maxAttempts: 1 }, historyScope: 'none' } },
        end: { type: 'output', config: { value: '${{ nodes.write.output }}' } } }, edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }] } })
    let fail = true
    const execute = vi.fn(async () => { if (fail) throw Error('PRIVATE_TRANSPORT'); return { output: 'PRIVATE_MODEL', usage: { tries: 1, inputTokens: 3, outputTokens: 4 } } })
    const rt = await runtime({ admit() {}, execute, async verify() {} }), id = randomUUID()
    await expect(rt.run(source, 'PRIVATE_INPUT', { id })).rejects.toThrow()
    const uncertain = await rt.show(id), view = project(source, uncertain)
    expect(node(view, 'write')).toMatchObject({ status: 'unsettled', count: 0 })
    expect(view.summary).toContain('outcome unsettled'); expect(execute).toHaveBeenCalledTimes(1)
    fail = false
    const complete = await rt.run(source, 'PRIVATE_INPUT'), projected = project(source, complete)
    expect(node(projected, 'write').records[0]!.modelUsage).toEqual({ tries: 1, inputTokens: 3, outputTokens: 4 })
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_')
  })
})

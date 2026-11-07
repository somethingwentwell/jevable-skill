import { z } from 'zod'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { executionCheckpointHash, localRunSchema, type LocalRun } from '../runtime/run-types.ts'
import { runReceipt } from '../runtime/receipts.ts'
import { admitWorkflowData, parseWorkflow, type WorkflowCompilerLimits } from '../workflow/index.ts'
import { DEFAULT_COMPILER_LIMITS } from '../limits.ts'
import { projectPreviewExecution } from './execution.ts'
import type { WorkflowPreview } from './model.ts'

export const previewNodeSelectionSchema = z.strictObject({
  graphScope: z.string().min(1).max(256), nodeId: z.string().min(1).max(128),
  record: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('step'), index: z.number().int().min(0).max(49999) }),
    z.strictObject({ kind: z.literal('checkpoint') }),
  ]),
})
export const previewNodeInspectionRequestSchema = z.strictObject({ id: z.uuid(),
  expectedCheckpointSha256: z.string().regex(/^[a-f0-9]{64}$/u), selection: previewNodeSelectionSchema })
export type PreviewNodeSelection = z.infer<typeof previewNodeSelectionSchema>
export type PreviewNodeInspectionRequest = z.infer<typeof previewNodeInspectionRequestSchema>

/** Private, detached projection of one exact retained record. Never binds, executes or reconstructs values. */
export function projectPreviewNodeInspection(preview: WorkflowPreview, value: unknown, request: unknown,
  sourceLimits: WorkflowCompilerLimits['source'] = DEFAULT_COMPILER_LIMITS.source) {
  const selected = previewNodeInspectionRequestSchema.safeParse(request)
  if (!selected.success) throw new WorkflowRuntimeError('invalid-command')
  let parsed: ReturnType<typeof localRunSchema.safeParse>
  try { parsed = localRunSchema.safeParse(value) } catch { throw new WorkflowRuntimeError('corrupt') }
  if (!parsed.success) throw new WorkflowRuntimeError('corrupt')
  const run = parsed.data as LocalRun, command = selected.data
  if (run.id !== command.id || !preview.revision || run.revision !== preview.revision)
    throw new WorkflowRuntimeError('not-found')
  if (run.state.steps.length > 50000) throw new WorkflowRuntimeError('limit')
  try {
    if (parseWorkflow(run.yaml, sourceLimits).revision !== preview.revision) throw Error('Source identity')
    projectPreviewExecution(preview, runReceipt(run))
  } catch { throw new WorkflowRuntimeError('corrupt') }
  const checkpointSha256 = executionCheckpointHash(run)
  if (checkpointSha256 !== command.expectedCheckpointSha256) throw new WorkflowRuntimeError('conflict')
  const graph = preview.graphs.find(graph => graph.scope === command.selection.graphScope)
  const node = graph?.nodes.find(node => node.id === command.selection.nodeId)
  if (!graph || !node) throw new WorkflowRuntimeError('not-found')
  const state = run.state, record = command.selection.record
  const step = record.kind === 'step' ? state.steps[record.index] : undefined
  if (record.kind === 'step' && !step) throw new WorkflowRuntimeError('not-found')
  if (record.kind === 'checkpoint' && state.status === 'completed') throw new WorkflowRuntimeError('not-found')
  const nodeId = step?.nodeId ?? (state.status === 'failed' ? state.nodeId : 'next' in state ? state.next : undefined)
  const scope = step ? step.scope : 'scope' in state ? state.scope : undefined
  const inspection = step?.inspection ?? (!step && state.status === 'failed' ? state.inspection : undefined)
  const attempt = !step && 'attempt' in state ? state.attempt : undefined
  const bookkeeping = Boolean(step && scope && nodeId === scope.loop && !inspection?.attemptId)
  const parent = scope ? preview.graphs[0]!.nodes.find(node => node.id === scope.loop && node.bodyScope) : undefined
  const actualGraph = !scope || bookkeeping ? preview.graphs[0]!.scope : parent?.bodyScope
  if (nodeId !== node.id || actualGraph !== graph.scope) throw new WorkflowRuntimeError('not-found')
  const field = (value: unknown, present: boolean) => {
    if (!present) return { status: 'unavailable' as const }
    try { return { status: 'recorded' as const, value: admitWorkflowData(value, { maxBytes: 8_000_000, maxDepth: 128, maxValues: 1_000_000 }) } }
    catch { throw new WorkflowRuntimeError('limit') }
  }
  const input = attempt?.prepared.status === 'ready' ? field(attempt.prepared.input, true)
    : field(inspection?.input, inspection !== undefined && Object.hasOwn(inspection, 'input'))
  const output = step ? field(step.output, true) : { status: attempt ? 'unsettled' as const : 'unavailable' as const }
  const result = { schemaVersion: 1 as const, format: 'jevable.preview-node-inspection/v1' as const, privateInspection: true as const,
    runId: run.id, revision: run.revision, checkpointSha256, selection: command.selection,
    kind: step ? bookkeeping ? 'loop-iteration-result' as const : node.node.type === 'loop' ? 'loop-aggregate' as const : 'node-result' as const : 'checkpoint' as const,
    status: step ? 'settled' : state.status, input, output,
    ...(scope ? { scope } : {}), ...(inspection?.attemptId || attempt ? { attemptId: inspection?.attemptId ?? attempt!.id } : {}),
    ...(step?.port ? { port: step.port } : {}),
    ...(!step && state.status === 'failed' ? { code: state.code } : {}),
    ...(!step && state.status === 'cancelled' ? { previousStatus: state.previousStatus } : {}) }
  // Two independently bounded fields plus their envelope must fit the fixed live response ceiling.
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 16_000_000) throw new WorkflowRuntimeError('limit')
  return result
}
export type PreviewNodeInspection = ReturnType<typeof projectPreviewNodeInspection>

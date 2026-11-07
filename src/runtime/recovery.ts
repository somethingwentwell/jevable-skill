import type { CompiledWorkflow, WorkflowCompilerLimits } from '../workflow/index.ts'
import type { LocalRun } from './run-types.ts'
import { nodeInspection } from './run-types.ts'
import type { ModelCalls } from './model-port.ts'
import { modelInput } from './model-plan.ts'
import { advanceCheckpoint, annotated, findNode, type RunCheckpoint } from './run-evaluator.ts'
import { WorkflowRuntimeError } from './errors.ts'

/** Read committed response evidence and derive one settlement. No new intent, provider request, approval or downstream step. */
export async function prepareModelRecovery(record: LocalRun, graph: CompiledWorkflow, limits: WorkflowCompilerLimits,
  models?: ModelCalls): Promise<RunCheckpoint> {
  const state = record.state
  if (state.status !== 'executing' || record.cancellation || state.attempt.prepared.status !== 'ready') throw new WorkflowRuntimeError('conflict')
  const node = findNode(graph, state.next, state.scope)
  if (!node || !['llm', 'decision'].includes(node.plan.kind) || !models?.recover) throw new WorkflowRuntimeError('invalid-command')
  if (node.plan.kind !== 'llm' && node.plan.kind !== 'decision') throw new WorkflowRuntimeError('invalid-command')
  const input = modelInput(node.plan, state.attempt.prepared.input)
  const result = await models.recover(node.plan, state.attempt.id, input)
  if (typeof result?.output !== 'string') throw new WorkflowRuntimeError('corrupt')
  const output = result.output
  const usage = nodeInspection.shape.modelUsage.safeParse(result.usage)
  if (!usage.success || !usage.data) throw new WorkflowRuntimeError('corrupt')
  await models.verify(node.plan, state.attempt.id, input, output)
  const checkpoint = { status: 'paused' as const, steps: state.steps, next: state.next, ...(state.scope ? { scope: state.scope } : {}) }
  const next = advanceCheckpoint(graph, record.input, checkpoint, limits.binding.data, undefined, state.attempt, output)
  // The lost node settlement had no retained duration. Do not call recovery latency original model latency.
  return annotated(next, state.attempt.id, { modelUsage: usage.data })
}

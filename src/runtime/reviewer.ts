import { reviewerDecision, reviewerTarget, type ReviewerDecisionRequest } from '../access/reviewer.ts'
import type { GrantActionAdmission } from '../access/actions.ts'
import type { CompiledWorkflow, WorkflowCompilerLimits } from '../workflow/index.ts'
import type { LocalRun } from './run-types.ts'
import { advanceCheckpoint, findNode } from './run-evaluator.ts'
import { recordedRoutes } from './run-routes.ts'
import { validateRunTransition } from './run-transition.ts'
import { WorkflowRuntimeError } from './errors.ts'
import { runTraceSegment } from './run-trace.ts'

/** Actual private-provider context only. This is never part of a client's decision request. */
export type ReviewerTraceObservation = Pick<NonNullable<LocalRun['traceSegments']>[number], 'trace' | 'parent'>

/** Pure settlement from authenticated admission and checked retained state. No provider or storage effects. */
export function prepareReviewerSettlement(record: LocalRun, events: readonly { kind: string; data: unknown }[], graph: CompiledWorkflow,
  request: ReviewerDecisionRequest, admission: GrantActionAdmission, limits: WorkflowCompilerLimits, observation?: ReviewerTraceObservation) {
  const target = reviewerTarget(record, events), state = record.state
  if (state.status !== 'waiting' || target.kind !== 'run' || admission.scope.kind !== 'reviewer'
    || admission.scope.runId !== record.id || admission.scope.revision !== record.revision || admission.scope.attemptId !== state.attempt.id)
    throw new WorkflowRuntimeError('not-found')
  const node = findNode(graph, state.next, state.scope)
  if (node?.plan.kind !== 'humanApproval' || !node.plan.actions.includes(request.action)) throw new WorkflowRuntimeError('not-found')
  if (events.some(event => event.data !== null && typeof event.data === 'object' && 'decision' in event.data
    && event.data.decision !== null && typeof event.data.decision === 'object' && 'delegation' in event.data.decision
    && event.data.decision.delegation !== null && typeof event.data.decision.delegation === 'object'
    && 'requestId' in event.data.decision.delegation && event.data.decision.delegation.requestId === request.requestId)) throw new WorkflowRuntimeError('conflict')
  const decision = reviewerDecision(admission, request), stateAfter = advanceCheckpoint(graph, record.input,
    { status: 'paused', steps: state.steps, next: state.next, ...(state.scope ? { scope: state.scope } : {}) }, limits.binding.data, undefined, state.attempt, undefined, decision)
  if (observation && (record.traceSegments?.length ?? 0) >= 10000) throw new WorkflowRuntimeError('limit')
  const previous = record.traceSegments?.at(-1)?.trace
  const segment = observation ? runTraceSegment.parse({ operation: 'approval', at: decision.at, ...observation, ...(previous ? { previous } : {}) }) : undefined
  const next: LocalRun = { ...record, state: stateAfter, updatedAt: decision.at,
    ...(segment ? { traceSegments: [...record.traceSegments ?? [], segment] } : {}) }, data = { attemptId: state.attempt.id, nodeId: state.next, decision,
    ...(segment ? { segment } : {}),
    ...(state.scope ? { scope: state.scope } : {}), routes: recordedRoutes(stateAfter.steps, state.steps.length), ...(request.pauseAfter ? { pauseAfter: true as const } : {}) }
  validateRunTransition(record, next, 'approval-decided', data, graph, limits)
  return { record: next, data, decision }
}

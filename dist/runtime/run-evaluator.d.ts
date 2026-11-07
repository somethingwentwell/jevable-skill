import type { CompiledWorkflow, CompiledWorkflowNode, NodeId, ReadonlyJsonValue, WorkflowCompilerLimits, WorkflowDataLimits } from '../workflow/index.ts';
import type { Span } from '@opentelemetry/api';
import type { JevableNodeInspection, JevableNodeAttempt, JevableAttemptId, JevableApprovalDecision } from './run-types.ts';
import type { ModelCalls } from './model-port.ts';
export { LOCAL_PLAN_KINDS, planKinds, compileRuntimeWorkflow, executionModelPlans } from './admission.ts';
/** Iteration of a loop body step, iteration result or continuation. */
export type LoopScope = {
    loop: NodeId;
    index: number;
};
/**
 * One completed value; no uncommitted output enters a subsequent node's context. A scoped step with the loop's own ID
 * is that iteration's result; the loop's unscoped step holds `{ results, count }`.
 */
export interface RunStep {
    nodeId: NodeId;
    output: ReadonlyJsonValue;
    /** Selected outgoing port, recorded at settlement. Absent on legacy records, terminal outputs and loop result bookkeeping. */
    port?: string | undefined;
    inspection?: JevableNodeInspection | undefined;
    scope?: LoopScope | undefined;
}
/** Failure categories saved by the evaluator; `loop-timeout` is decided by the run owner, not recomputed. */
export type RunFailureCode = 'invalid-node-value' | 'loop-limit' | 'loop-timeout' | 'approval-rejected' | 'approval-expired' | 'ai-budget';
/** Exact next node and committed values, or a settled workflow outcome. */
export type RunCheckpoint = {
    status: 'paused';
    steps: RunStep[];
    next: NodeId;
    scope?: LoopScope | undefined;
} | {
    status: 'completed';
    steps: RunStep[];
    output: ReadonlyJsonValue;
} | RunFailure;
/** Saved failure at one node, with its loop iteration when the node is a loop body step. */
interface RunFailure {
    status: 'failed';
    steps: RunStep[];
    nodeId: NodeId;
    code: RunFailureCode;
    inspection?: JevableNodeInspection | undefined;
    scope?: LoopScope | undefined;
}
/** A saved Human Approval task; the run owner sets `expiresAt` when the task is saved, so it is never recomputed. */
export interface RunWaiting {
    status: 'waiting';
    steps: RunStep[];
    next: NodeId;
    attempt: JevableNodeAttempt;
    expiresAt: string;
    scope?: LoopScope | undefined;
}
type Paused = Extract<RunCheckpoint, {
    status: 'paused';
}>;
/** Select one admitted start contract; there is no implicit API/webhook ingress or mode fallback. */
export declare function compileLocalRun(yaml: string, limits: WorkflowCompilerLimits, triggerMode?: 'api'): CompiledWorkflow;
/**
 * Pause before the first executable node without calculating its output.
 * @param graph - Admitted nonempty graph.
 * @returns an empty checkpoint pinned to the entry node.
 */
export declare function initialCheckpoint(graph: CompiledWorkflow): Paused;
/**
 * Find the compiled node a continuation or step names, inside its loop body when scoped.
 * @param graph - Admitted graph.
 * @param id - Node identity.
 * @param scope - Loop iteration for body nodes.
 * @returns the node, or undefined when the identity does not exist at that scope (for example an iteration result).
 */
export declare function findNode(graph: CompiledWorkflow, id: NodeId, scope?: LoopScope): CompiledWorkflowNode | undefined;
/**
 * Whether a node identity exists in the graph or any loop body; body identities never repeat outer ones.
 * @param graph - Admitted graph.
 * @param id - Candidate identity, such as a debugger breakpoint.
 * @returns true when some outer or body node has that identity.
 */
export declare function hasNode(graph: CompiledWorkflow, id: string): boolean;
/**
 * Retain the admitted identity and available input when an attempt settles or becomes uncertain.
 * @param attempt - Saved pre-dispatch input preparation; presence does not prove dispatch occurred.
 * @returns inspection data without fabricated output or trace context.
 */
export declare function attemptInspection(attempt: JevableNodeAttempt): JevableNodeInspection;
/**
 * Validate saved preparation without executing the pending node.
 * @param attempt - Optional legacy-compatible admission record.
 * @param graph - Validated graph; preparation does not invoke external operations.
 * @param input - Frozen run input.
 * @param checkpoint - Previously validated committed prefix and continuation.
 * @param limits - Runtime value bounds used for review-schema validation.
 * @returns whether the pending identity is new and its preparation matches the pinned inputs.
 */
export declare function preparedAttemptMatches(attempt: JevableNodeAttempt | undefined, graph: CompiledWorkflow, input: ReadonlyJsonValue, checkpoint: Pick<Paused, 'steps' | 'next' | 'scope'>, limits: WorkflowDataLimits): boolean;
/**
 * Execute exactly one node using only committed preceding values; never mutate the supplied checkpoint.
 * Entering a loop adds no step; a body node that exits its iteration also adds that iteration's result, and the last
 * iteration adds the loop's output.
 * @param graph - Admitted graph containing the checkpoint's next node.
 * @param input - Validated, revision-pinned run input.
 * @param checkpoint - Previously validated paused checkpoint.
 * @param limits - Runtime value bounds.
 * @param span - Optional live attempt span; always ended, never created during retained-data validation.
 * @param attempt - Already committed preparation for dispatch; omitted only for pure retained-data validation.
 * @param modelOutput - Exact model text or collector arguments saved before settlement or used in side-effect-free validation.
 * @param approval - Saved Human Approval decision; the caller has checked a named action against the node's actions.
 * @returns the next pause or terminal outcome; declared data failures use a fixed safe category.
 */
export declare function advanceCheckpoint(graph: CompiledWorkflow, input: ReadonlyJsonValue, checkpoint: Paused, limits: WorkflowDataLimits, span?: Span, attempt?: JevableNodeAttempt, modelOutput?: string, approval?: JevableApprovalDecision): RunCheckpoint;
/**
 * Recompute saved steps without side effects, feeding recorded model outputs, until the saved position is reached.
 * @param graph - Source-pinned graph.
 * @param input - Frozen run input.
 * @param steps - Saved committed steps.
 * @param limits - Runtime value bounds.
 * @param target - Saved continuation; omitted to stop at the saved step count.
 * @returns the recomputed checkpoint; a saved record that diverges fails comparison with it.
 */
export declare function replayCheckpoint(graph: CompiledWorkflow, input: ReadonlyJsonValue, steps: readonly RunStep[], limits: WorkflowDataLimits, target?: {
    next: NodeId;
    scope?: LoopScope | undefined;
}): RunCheckpoint;
/**
 * Recompute a saved terminal outcome: replay the saved steps, then advance until a node settles without adding steps.
 * @param graph - Source-pinned graph.
 * @param input - Frozen run input.
 * @param actual - Saved completed or failed outcome, with optional model outputs on its inspections.
 * @param limits - Runtime value bounds.
 * @returns the recomputed terminal checkpoint, or a paused one when the saved record ends early.
 */
export declare function replayOutcome(graph: CompiledWorkflow, input: ReadonlyJsonValue, actual: Exclude<RunCheckpoint, {
    status: 'paused';
}>, limits: WorkflowDataLimits): RunCheckpoint;
/**
 * Validate stored values and any recorded resolved input without fabricating metadata for older records.
 * @param actual - Stored checkpoint, with legacy inspection omissions permitted.
 * @param expected - Side-effect-free deterministic evaluation; never supplied by an external node adapter.
 * @returns whether execution values and each present input snapshot match; trace IDs are not recomputed.
 */
export declare function checkpointMatches(actual: RunCheckpoint, expected: RunCheckpoint): boolean;
/**
 * Commit intent before executing one node and commit its result before allowing a successor.
 * @param graph - Graph admitted under the configured execution policy.
 * @param input - Frozen run input.
 * @param checkpoint - Last committed values and exact next node.
 * @param limits - Explicit runtime value bounds.
 * @param persistence - Owning journal writes and attempt span factory; failures propagate without retry.
 * @param models - Explicitly configured model executor; absent policies refuse LLM admission.
 * @param signal - User cancellation forwarded to an in-flight model call.
 * @returns the owner's committed result. A failed result write must leave its intent uncertain. A Human Approval node with
 * a valid review input produces a waiting task instead of a settled step.
 */
export declare function advanceDurably<T>(graph: CompiledWorkflow, input: ReadonlyJsonValue, checkpoint: Paused, limits: WorkflowDataLimits, persistence: {
    intent(attempt: JevableNodeAttempt): Promise<void>;
    tracedIntent?(attempt: JevableNodeAttempt): Promise<void>;
    span(id: JevableAttemptId): Span | undefined | Promise<Span | undefined>;
    result(next: RunCheckpoint | RunWaiting): Promise<T>;
}, models?: ModelCalls, signal?: AbortSignal): Promise<T>;
/**
 * Add observed metadata to the step or failure that settled one attempt.
 * @param next - Settled checkpoint from the evaluator.
 * @param id - Attempt that produced it; loop iteration results and other attempts are unchanged.
 * @param extra - Inspection fields replay validation never recomputes, such as timing and model use.
 * @returns a copy with the fields on that attempt's inspection.
 */
export declare function annotated(next: RunCheckpoint, id: JevableAttemptId, extra: Partial<JevableNodeInspection>): RunCheckpoint;
/**
 * Add the observed start time and duration to the step or failure that settled one attempt.
 * @param next - Settled checkpoint from the evaluator.
 * @param id - Attempt that produced it; loop iteration results and other attempts are unchanged.
 * @param started - Epoch milliseconds when the attempt began, such as dispatch or the start of an approval wait.
 * @returns a copy with timing on that attempt's inspection.
 */
export declare function timed(next: RunCheckpoint, id: JevableAttemptId, started: number): RunCheckpoint;
/** Await every configured admission check before a run or node can be dispatched. */
export declare function admitExecution(graph: CompiledWorkflow, models?: ModelCalls): Promise<void>;
/**
 * Reconcile model settlements with durable Sessions without issuing network calls.
 * @param graph - Source-pinned graph.
 * @param checkpoint - Committed values or failure under validation.
 * @param models - Session-reading model adapter.
 * @returns resolution when every model settlement matches its Session.
 */
export declare function verifyModelResults(graph: CompiledWorkflow, checkpoint: RunCheckpoint, models?: ModelCalls): Promise<void>;

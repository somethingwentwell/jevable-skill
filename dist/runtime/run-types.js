import { z } from 'zod';
import { createHash } from 'node:crypto';
import { testIdentitySchema } from "../testing/schema.js";
import { savedExecutionControlSchema, breakpointHitSchema } from "./control.js";
import { apiTriggerModeSchema, triggerMetadata } from "./trigger.js";
import { callerBindingSchema } from "../access/caller.js";
import { reviewerBindingSchema, reviewerDecisionEvidenceSchema } from "../access/reviewer.js";
import { callerCancellationBindingSchema, callerCancellationEvidenceSchema } from "../access/caller-cancellation.js";
import { runTrace, runTraceSegment } from "./run-trace.js";
export { runTrace } from "./run-trace.js";
const nodeId = z.string().min(1).transform(value => value);
const attemptId = z.uuid().transform(value => value);
const json = z.json();
export const nodeAttempt = z.strictObject({ id: attemptId, nodeId, prepared: z.discriminatedUnion('status', [
        z.strictObject({ status: z.literal('ready'), input: json }),
        z.strictObject({ status: z.literal('invalid-node-value') }),
    ]), trace: z.lazy(() => runTrace).optional() });
export const approvalDecision = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('action'), action: z.string().min(1), actor: z.string().min(1).max(256), at: z.iso.datetime(), delegation: reviewerBindingSchema.optional() })
        .refine(value => value.delegation === undefined || reviewerDecisionEvidenceSchema.safeParse(value).success),
    z.strictObject({ kind: z.literal('expired'), at: z.iso.datetime() }),
]);
export const nodeInspection = z.strictObject({ input: json.optional(), trace: runTrace.optional(), attemptId: attemptId.optional(),
    modelOutput: z.string().optional(), approval: approvalDecision.optional(), startedAt: z.iso.datetime().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    modelUsage: z.strictObject({ tries: z.number().int().positive(), inputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional() }).optional() });
export const loopScope = z.strictObject({ loop: nodeId, index: z.number().int().nonnegative() });
const step = z.strictObject({ nodeId, output: json, port: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/u).max(128).optional(),
    inspection: nodeInspection.optional(), scope: loopScope.optional() });
const position = { steps: z.array(step), next: nodeId, scope: loopScope.optional() };
export const checkpointSchema = z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('paused'), ...position }),
    z.strictObject({ status: z.literal('completed'), steps: z.array(step), output: json }),
    z.strictObject({ status: z.literal('failed'), steps: z.array(step), nodeId,
        code: z.enum(['invalid-node-value', 'loop-limit', 'loop-timeout', 'approval-rejected', 'approval-expired', 'ai-budget']),
        inspection: nodeInspection.optional(), scope: loopScope.optional() }),
]);
const executingState = z.strictObject({ status: z.literal('executing'), ...position, attempt: nodeAttempt });
const waitingState = z.strictObject({ status: z.literal('waiting'), steps: z.array(step), next: nodeId, attempt: nodeAttempt, expiresAt: z.iso.datetime(), scope: loopScope.optional() });
const cancelledState = z.union([
    z.strictObject({ status: z.literal('cancelled'), previousStatus: z.literal('paused'), ...position }),
    executingState.extend({ status: z.literal('cancelled'), previousStatus: z.literal('executing') }),
    waitingState.extend({ status: z.literal('cancelled'), previousStatus: z.literal('waiting') }),
]);
export const cancellationRequest = z.strictObject({ id: z.uuid(), actor: z.string().trim().min(1).max(256), at: z.iso.datetime(),
    traceParent: runTrace.optional(), delegation: callerCancellationBindingSchema.optional() })
    .refine(value => value.delegation === undefined || callerCancellationEvidenceSchema.safeParse(value).success);
export const runtimeStateSchema = z.union([checkpointSchema, executingState, waitingState, cancelledState]);
/** Cancellation retains the exact last checkpoint/intent; it does not fabricate a settled attempt. */
export function stoppedCheckpoint(state) {
    if (state.status !== 'cancelled')
        return state;
    const { previousStatus, status: _status, ...checkpoint } = state;
    return { ...checkpoint, status: previousStatus };
}
export function stoppedCheckpointHash(state) {
    return createHash('sha256').update(JSON.stringify(runtimeStateSchema.parse(stoppedCheckpoint(state)))).digest('hex');
}
export const localRunSchema = z.strictObject({
    schemaVersion: z.literal(1), id: z.uuid(), revision: z.string().regex(/^[a-f0-9]{64}$/u), yaml: z.string(),
    input: json, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
    project: z.strictObject({ id: z.uuid(), generation: z.number().int().positive() }).optional(),
    release: z.strictObject({ id: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).optional(),
    test: testIdentitySchema.optional(),
    caller: callerBindingSchema.optional(),
    triggerMode: apiTriggerModeSchema.optional(),
    cancellation: cancellationRequest.optional(),
    startedPaused: z.literal(true).optional(),
    controlRequests: z.array(savedExecutionControlSchema).min(1).max(10000).optional(),
    breakpointHits: z.array(breakpointHitSchema).min(1).max(10000).optional(),
    traceSegments: z.array(runTraceSegment).max(10000).optional(),
    state: runtimeStateSchema, loopDeadlines: z.record(z.string(), z.number().int().nonnegative()),
});
/** Binds an explicit execution action to this run, checkpoint and last admitted control request. */
export function executionCheckpointHash(run) {
    return createHash('sha256').update(JSON.stringify({ id: run.id, revision: run.revision, ...triggerMetadata(run),
        ...(run.caller ? { caller: callerBindingSchema.parse(run.caller) } : {}),
        state: runtimeStateSchema.parse(run.state), cancellation: run.cancellation?.id ?? null,
        lastControlRequest: run.controlRequests?.at(-1)?.requestId ?? null,
        ...(run.breakpointHits?.length ? { lastBreakpointHit: breakpointHitSchema.parse(run.breakpointHits.at(-1)) } : {}) })).digest('hex');
}

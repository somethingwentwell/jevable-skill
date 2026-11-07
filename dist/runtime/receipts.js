import { executionCheckpointHash } from "./run-types.js";
import { breakpointMetadata } from "./breakpoint-metadata.js";
import { pauseMetadata } from "./pause.js";
import { triggerMetadata } from "./trigger.js";
/** Public owner receipt omits private source, inputs and intermediate node payloads. */
export function runReceipt(run) {
    const state = run.state;
    return { schemaVersion: 1, id: run.id, revision: run.revision, status: state.status,
        ...triggerMetadata(run),
        checkpointSha256: executionCheckpointHash(run),
        ...breakpointMetadata(run),
        ...pauseMetadata(run),
        ...(run.startedPaused ? { startedPaused: true } : {}),
        ...(run.controlRequests?.length ? { lastControl: { requestId: run.controlRequests.at(-1).requestId,
                mode: run.controlRequests.at(-1).mode, acknowledgement: 'admitted; inspect current status, not proof of completion' } } : {}),
        ...(state.status === 'paused' ? { nodeId: state.next } : {}),
        ...('scope' in state && state.scope ? { scope: state.scope } : {}),
        ...(run.project ? { project: run.project } : {}), createdAt: run.createdAt, updatedAt: run.updatedAt,
        ...(run.release ? { release: run.release } : {}),
        ...(run.test ? { test: run.test } : {}),
        ...(run.cancellation ? { cancellation: { ...run.cancellation,
                status: state.status === 'cancelled' ? 'stopped' : state.status === 'completed' || state.status === 'failed' ? 'terminal-before-stop' : 'requested',
                externalEffects: 'not-reverted; provider-side outcome may be unknown' } } : {}),
        ...(state.status === 'cancelled' ? { nodeId: state.next, previousStatus: state.previousStatus,
            ...('attempt' in state ? { attemptId: state.attempt.id } : {}),
            ...(state.previousStatus === 'executing' ? { recovery: 'unsettled attempt retained; cancellation does not prove provider-side termination' } : {}) } : {}),
        ...(run.traceSegments ? { traceSegments: run.traceSegments, telemetryDelivery: 'not-guaranteed; inspect exporter status' } : {}),
        ...(state.status === 'completed' ? { output: state.output } : {}),
        ...(state.status === 'failed' ? { code: state.code, nodeId: state.nodeId } : {}),
        ...(state.status === 'waiting' ? { nodeId: state.next, attemptId: state.attempt.id, expiresAt: state.expiresAt } : {}),
        ...(state.status === 'executing' ? { nodeId: state.next, attemptId: state.attempt.id,
            recovery: 'uncertain; inspect retained evidence, do not redispatch automatically' } : {}),
        steps: state.steps.map(step => ({ nodeId: step.nodeId, scope: step.scope, attemptId: step.inspection?.attemptId,
            ...(step.port === undefined ? {} : { port: step.port }),
            ...(step.inspection?.trace ? { trace: step.inspection.trace } : {}),
            ...(step.inspection?.modelUsage ? { modelUsage: step.inspection.modelUsage } : {}),
            startedAt: step.inspection?.startedAt, durationMs: step.inspection?.durationMs })), };
}

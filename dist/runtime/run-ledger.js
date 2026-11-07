import { isDeepStrictEqual } from 'node:util';
import { validateWorkflowValue } from "../workflow/index.js";
import { WorkflowRuntimeError } from "./errors.js";
import { checkpointMatches, compileLocalRun, findNode, preparedAttemptMatches, replayCheckpoint, replayOutcome } from "./run-evaluator.js";
import { stoppedCheckpoint, stoppedCheckpointHash } from "./run-types.js";
import { recordedRoutes, recordedRoutesSchema } from "./run-routes.js";
import { checkBreakpointEvidence } from "./breakpoints.js";
import { triggerMetadata } from "./trigger.js";
import { verifyCallerBinding } from "../access/caller.js";
import { verifyCallerCancellation } from "../access/caller-cancellation.js";
import { verifyCallerControls } from "../access/caller-control.js";
import { verifyReviewerDecisions } from "../access/reviewer.js";
import { cancellationTraceCause, runTraceSegment } from "./run-trace.js";
/** Shared checkpoint/review/control/cancellation replay; never dispatches models or other workflow effects. */
export class RunLedger {
    limits;
    constructor(limits) {
        this.limits = limits;
    }
    check(record, evidence) {
        const graph = compileLocalRun(record.yaml, this.limits, record.triggerMode);
        if (graph.source.revision !== record.revision || record.yaml !== graph.source.yaml)
            throw new WorkflowRuntimeError('corrupt');
        const creations = evidence.events.filter(event => event.kind === 'run-created');
        const created = creations[0]?.data;
        const creation = { revision: record.revision, ...(record.startedPaused ? { startedPaused: true } : {}), ...triggerMetadata(record),
            ...(record.project ? { project: record.project } : {}), ...(record.release ? { release: record.release } : {}),
            ...(record.test ? { test: record.test } : {}), ...(record.caller ? { caller: record.caller } : {}) };
        if (creations.length !== 1 || evidence.events[0]?.kind !== 'run-created'
            || !isDeepStrictEqual(created, creation))
            throw new WorkflowRuntimeError('corrupt');
        verifyCallerBinding(record, evidence.grant);
        verifyCallerCancellation(record, evidence.events, evidence.grant);
        verifyCallerControls(record, evidence.events, evidence.grant);
        verifyReviewerDecisions(record, evidence.events, evidence.reviewerGrants);
        const controls = evidence.events.filter(event => event.kind === 'execution-requested').map(event => event.data);
        if (!isDeepStrictEqual(record.controlRequests ?? [], controls)
            || new Set(record.controlRequests?.map(request => request.requestId)).size !== controls.length)
            throw new WorkflowRuntimeError('corrupt');
        checkBreakpointEvidence(record, evidence.events, graph, this.limits);
        if (record.project) {
            const project = evidence.project;
            if (!project || project.id !== record.project.id || project.generation !== record.project.generation || project.archived || project.acceptedRevision !== record.revision)
                throw new WorkflowRuntimeError('corrupt');
        }
        if (record.release) {
            const release = evidence.release;
            if (!release || release.snapshot.id !== record.release.id || record.project || release.sha256 !== record.release.sha256 || release.snapshot.workflow.revision !== record.revision)
                throw new WorkflowRuntimeError('corrupt');
        }
        if (record.test) {
            const test = evidence.test, pin = test?.definition.project;
            if (!test || !pin || test.archived || test.id !== record.test.id || test.generation !== record.test.generation || test.status !== 'accepted' || test.sha256 !== record.test.sha256 || !record.project || record.release
                || pin.id !== record.project.id || pin.generation !== record.project.generation || pin.revision !== record.revision
                || !isDeepStrictEqual(test.definition.input, record.input) || test.definition.triggerMode !== record.triggerMode)
                throw new WorkflowRuntimeError('corrupt');
        }
        const spans = new Set();
        const journalSegments = [];
        let cancellationAdmitted = false;
        for (const event of evidence.events) {
            if (event.kind === 'cancellation-requested')
                cancellationAdmitted = true;
            const value = event.kind === 'execution-segment' ? event.data
                : event.kind === 'approval-decided' && event.data && typeof event.data === 'object' && 'segment' in event.data ? event.data.segment : undefined;
            if (value === undefined)
                continue;
            const parsed = runTraceSegment.safeParse(value);
            if (!parsed.success || parsed.data.operation === 'cancel' && (!cancellationAdmitted
                || !isDeepStrictEqual(parsed.data.cause, cancellationTraceCause(record))))
                throw new WorkflowRuntimeError('corrupt');
            journalSegments.push(parsed.data);
        }
        if (!isDeepStrictEqual(record.traceSegments ?? [], journalSegments))
            throw new WorkflowRuntimeError('corrupt');
        for (const [index, segment] of (record.traceSegments ?? []).entries()) {
            const key = `${segment.trace.traceId}/${segment.trace.spanId}`;
            if (spans.has(key) || !isDeepStrictEqual(segment.previous, record.traceSegments?.[index - 1]?.trace)
                || (segment.parent && segment.parent.traceId !== segment.trace.traceId))
                throw new WorkflowRuntimeError('corrupt');
            spans.add(key);
        }
        validateWorkflowValue(graph.input, record.input, this.limits.binding.data);
        const requests = evidence.events.filter(event => event.kind === 'cancellation-requested');
        const stops = evidence.events.filter(event => event.kind === 'run-cancelled');
        if (requests.length !== (record.cancellation ? 1 : 0) || (record.cancellation && !isDeepStrictEqual(requests[0]?.data, record.cancellation))
            || stops.length !== (record.state.status === 'cancelled' ? 1 : 0)
            || (record.state.status === 'cancelled' && (!record.cancellation || !isDeepStrictEqual(stops[0]?.data, {
                requestId: record.cancellation.id, previousStatus: record.state.previousStatus,
                next: record.state.next, attemptId: 'attempt' in record.state ? record.state.attempt.id : null,
                checkpointSha256: stoppedCheckpointHash(record.state),
            }))))
            throw new WorkflowRuntimeError('corrupt');
        const state = stoppedCheckpoint(record.state);
        const position = state.status === 'waiting' || state.status === 'executing' ? { status: 'paused',
            steps: state.steps, next: state.next, ...state.scope ? { scope: state.scope } : {} } : undefined;
        const actual = position ?? state;
        const expected = actual.status === 'paused'
            ? replayCheckpoint(graph, record.input, actual.steps, this.limits.binding.data, actual)
            : actual.status === 'failed' && actual.code === 'loop-timeout'
                ? replayCheckpoint(graph, record.input, actual.steps, this.limits.binding.data, { next: actual.nodeId, scope: actual.scope })
                : replayOutcome(graph, record.input, actual, this.limits.binding.data);
        const comparable = actual.status === 'failed' && actual.code === 'loop-timeout'
            ? { status: 'paused', steps: actual.steps, next: actual.nodeId, scope: actual.scope } : actual;
        if (!checkpointMatches(comparable, expected))
            throw new WorkflowRuntimeError('corrupt');
        const routes = [], intents = new Map(), settledRoutes = new Set();
        for (const event of evidence.events) {
            if (event.kind === 'node-intent' && event.data && typeof event.data === 'object' && 'attempt' in event.data) {
                const data = event.data;
                if (typeof data.attempt?.id === 'string')
                    intents.set(data.attempt.id, { nodeId: data.attempt.nodeId, scope: data.scope ?? null });
            }
            if (!event.data || typeof event.data !== 'object' || !('routes' in event.data))
                continue;
            if (!['node-result', 'approval-decided'].includes(event.kind))
                throw new WorkflowRuntimeError('corrupt');
            const parsed = recordedRoutesSchema.safeParse(event.data.routes);
            if (!parsed.success)
                throw new WorkflowRuntimeError('corrupt');
            const data = event.data, attemptId = data.attemptId;
            if (typeof attemptId !== 'string' || settledRoutes.has(attemptId)
                || !isDeepStrictEqual(intents.get(attemptId), { nodeId: data.nodeId, scope: data.scope ?? null }))
                throw new WorkflowRuntimeError('corrupt');
            settledRoutes.add(attemptId);
            for (const route of parsed.data) {
                const step = actual.steps[route.stepIndex];
                if (!step)
                    throw new WorkflowRuntimeError('corrupt');
                if (step.inspection?.attemptId) {
                    if (step.inspection.attemptId !== attemptId || step.nodeId !== data.nodeId || !isDeepStrictEqual(step.scope ?? null, data.scope ?? null))
                        throw new WorkflowRuntimeError('corrupt');
                }
                else {
                    const scope = data.scope && typeof data.scope === 'object' && 'loop' in data.scope ? data.scope.loop : undefined;
                    if (step.scope || findNode(graph, step.nodeId)?.plan.kind !== 'loop'
                        || !(data.nodeId === step.nodeId && data.scope == null || scope === step.nodeId))
                        throw new WorkflowRuntimeError('corrupt');
                }
            }
            routes.push(...parsed.data);
        }
        if (!isDeepStrictEqual(routes, recordedRoutes(actual.steps)))
            throw new WorkflowRuntimeError('corrupt');
        if (position && (state.status === 'executing' || state.status === 'waiting')
            && !preparedAttemptMatches(state.attempt, graph, record.input, position, this.limits.binding.data))
            throw new WorkflowRuntimeError('corrupt');
        if (state.status === 'waiting' && (findNode(graph, state.next, state.scope)?.plan.kind !== 'humanApproval'
            || state.scope && record.loopDeadlines[state.scope.loop] === undefined))
            throw new WorkflowRuntimeError('corrupt');
        if (state.status === 'waiting') {
            const requests = evidence.events.filter(event => event.kind === 'approval-requested' && event.data !== null && typeof event.data === 'object'
                && 'attemptId' in event.data && event.data.attemptId === state.attempt.id);
            const request = requests[0]?.data;
            if (requests.length !== 1 || request?.nodeId !== state.next || request.status !== 'waiting'
                || !isDeepStrictEqual(request.scope ?? undefined, state.scope)
                || request.expiresAt !== undefined && request.expiresAt !== state.expiresAt
                || !isDeepStrictEqual(intents.get(state.attempt.id), { nodeId: state.next, scope: state.scope ?? null }))
                throw new WorkflowRuntimeError('corrupt');
        }
        return graph;
    }
}

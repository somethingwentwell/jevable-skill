import { isDeepStrictEqual as same } from 'node:util';
import { z } from 'zod';
import { WorkflowRuntimeError } from "./errors.js";
import { advanceCheckpoint, checkpointMatches, findNode, initialCheckpoint } from "./run-evaluator.js";
import { approvalDecision, executionCheckpointHash, stoppedCheckpoint, loopScope } from "./run-types.js";
import { recordedRoutes, recordedRoutesSchema } from "./run-routes.js";
import { breakpointConfiguration, validateBreakpoints } from "./breakpoints.js";
import { requestedPause } from "./pause.js";
import { cancellationTraceCause, runTraceSegment } from "./run-trace.js";
export const runEventKind = z.enum(['run-created', 'execution-segment', 'execution-requested', 'cancellation-requested', 'run-cancelled',
    'node-intent', 'node-trace', 'node-result', 'approval-requested', 'approval-decided', 'loop-timeout', 'breakpoint-hit']);
const require = (valid) => { if (!valid)
    throw new WorkflowRuntimeError('conflict'); };
/** Guard one storage transition. Uses retained values only; never dispatches or approves an action itself. */
export function validateRunTransition(before, next, kind, data, graph, limits) {
    if (!before) {
        require(kind === 'run-created' && next.createdAt === next.updatedAt && same(next.state, initialCheckpoint(graph))
            && same(next.loopDeadlines, {}) && next.cancellation === undefined && next.controlRequests === undefined && next.traceSegments === undefined && next.breakpointHits === undefined);
        return;
    }
    require(kind !== 'run-created' && !['completed', 'failed', 'cancelled'].includes(before.state.status) && Date.parse(next.updatedAt) >= Date.parse(before.updatedAt));
    for (const field of ['schemaVersion', 'id', 'yaml', 'revision', 'input', 'createdAt', 'project', 'release', 'test', 'caller', 'startedPaused', 'triggerMode'])
        require(same(before[field], next[field]));
    for (const [field, event] of [['cancellation', 'cancellation-requested'], ['controlRequests', 'execution-requested'], ['traceSegments', 'execution-segment'], ['breakpointHits', 'breakpoint-hit']])
        if (kind !== event && !(field === 'traceSegments' && kind === 'approval-decided'))
            require(same(before[field], next[field]));
    if (kind !== 'node-intent')
        require(same(before.loopDeadlines, next.loopDeadlines));
    if (['execution-segment', 'execution-requested', 'cancellation-requested', 'breakpoint-hit'].includes(kind))
        require(same(before.state, next.state));
    if (kind === 'breakpoint-hit') {
        const previous = before.breakpointHits ?? [], hits = next.breakpointHits ?? [], last = hits.at(-1), configuration = breakpointConfiguration(before);
        require(before.state.status === 'paused' && !before.cancellation && !requestedPause(before) && hits.length === previous.length + 1
            && same(hits.slice(0, -1), previous) && same(last, data) && last?.checkpointSha256 === executionCheckpointHash(before)
            && last?.at === next.updatedAt && last?.configurationRequestId === configuration?.requestId
            && configuration?.breakpoints?.includes(last.nodeId)
            && before.state.status === 'paused' && last?.nodeId === before.state.next && last.stepCount === before.state.steps.length
            && same(last.scope, before.state.scope));
        return;
    }
    if (kind === 'execution-segment') {
        const previous = before.traceSegments ?? [], segments = next.traceSegments ?? [], segment = segments.at(-1);
        require(segments.length === previous.length + 1 && same(segments.slice(0, -1), previous) && same(segment, data)
            && (segment?.operation !== 'cancel' || before.cancellation && same(segment.cause, cancellationTraceCause(before))));
        return;
    }
    if (kind === 'execution-requested') {
        const previous = before.controlRequests ?? [], requests = next.controlRequests ?? [], last = requests.at(-1);
        require(((last?.mode !== 'recover' && before.state.status === 'paused') || (['pause', 'recover'].includes(last?.mode ?? '') && before.state.status === 'executing'))
            && !before.cancellation && requests.length === previous.length + 1 && !previous.some(item => item.requestId === last?.requestId)
            && same(requests.slice(0, -1), previous) && same(last, data) && last?.expectedCheckpointSha256 === executionCheckpointHash(before));
        try {
            validateBreakpoints(graph, last);
        }
        catch {
            require(false);
        }
        if (last?.mode === 'recover' && before.state.status === 'executing') {
            const node = findNode(graph, before.state.next, before.state.scope);
            require(node && ['llm', 'decision'].includes(node.plan.kind) && before.state.attempt.prepared.status === 'ready');
        }
        return;
    }
    if (kind === 'cancellation-requested') {
        require(!before.cancellation && next.cancellation && same(next.cancellation, data));
        return;
    }
    if (kind === 'run-cancelled') {
        require(before.cancellation && next.state.status === 'cancelled' && same(stoppedCheckpoint(next.state), before.state));
        return;
    }
    if (kind === 'node-intent') {
        require(before.state.status === 'paused' && !before.cancellation && !requestedPause(before) && next.state.status === 'executing');
        if (before.state.status !== 'paused' || next.state.status !== 'executing')
            return;
        require(same({ ...next.state, status: 'paused', attempt: undefined }, { ...before.state, attempt: undefined }));
        require(same(data, { attempt: next.state.attempt, scope: before.state.scope ?? null, revision: next.revision }));
        for (const [key, value] of Object.entries(before.loopDeadlines))
            require(next.loopDeadlines[key] === value);
        const added = Object.keys(next.loopDeadlines).filter(key => before.loopDeadlines[key] === undefined);
        const checkpoint = before.state;
        require(added.length <= 1 && added.every(key => key === checkpoint.next
            && findNode(graph, checkpoint.next)?.plan.kind === 'loop' && next.loopDeadlines[key] >= Date.parse(next.updatedAt)));
        return;
    }
    if (kind === 'node-trace') {
        require(before.state.status === 'executing' && next.state.status === 'executing');
        if (before.state.status !== 'executing' || next.state.status !== 'executing')
            return;
        require(!before.state.attempt.trace && next.state.attempt.trace
            && same({ ...next.state, attempt: { ...next.state.attempt, trace: undefined } }, { ...before.state, attempt: { ...before.state.attempt, trace: undefined } })
            && same(data, { attemptId: before.state.attempt.id, trace: next.state.attempt.trace }));
        return;
    }
    if (kind === 'loop-timeout') {
        require(['paused', 'waiting'].includes(before.state.status) && 'scope' in before.state && before.state.scope && !before.cancellation);
        if ((before.state.status !== 'paused' && before.state.status !== 'waiting') || !before.state.scope)
            return;
        require((before.loopDeadlines[before.state.scope.loop] ?? Infinity) <= Date.parse(next.updatedAt)
            && same(next.state, { status: 'failed', code: 'loop-timeout', nodeId: before.state.next, scope: before.state.scope, steps: before.state.steps })
            && same(data, { scope: before.state.scope, ...(before.state.status === 'waiting' ? { attemptId: before.state.attempt.id, nodeId: before.state.next } : {}) }));
        return;
    }
    if (kind === 'approval-requested') {
        require(before.state.status === 'executing' && next.state.status === 'waiting');
        if (before.state.status !== 'executing' || next.state.status !== 'waiting')
            return;
        const node = findNode(graph, before.state.next, before.state.scope);
        require(node?.plan.kind === 'humanApproval' && before.state.attempt.prepared.status === 'ready'
            && same(next.state.steps, before.state.steps) && same(next.state.attempt, before.state.attempt) && next.state.next === before.state.next
            && same(next.state.scope, before.state.scope)
            && Date.parse(next.state.expiresAt) >= Date.parse(next.updatedAt)
            && Date.parse(next.state.expiresAt) <= Date.parse(next.updatedAt) + (node?.plan.kind === 'humanApproval' ? node.plan.expiresAfterMs : 0)
            && (same(data, { attemptId: before.state.attempt.id, nodeId: before.state.next, scope: before.state.scope ?? null, status: 'waiting' })
                || same(data, { attemptId: before.state.attempt.id, nodeId: before.state.next, scope: before.state.scope ?? null,
                    status: 'waiting', expiresAt: next.state.expiresAt })));
        return;
    }
    require(kind === 'node-result' || kind === 'approval-decided');
    require(before.state.status === (kind === 'node-result' ? 'executing' : 'waiting') && !['waiting', 'executing', 'cancelled'].includes(next.state.status));
    if (before.state.status !== 'executing' && before.state.status !== 'waiting')
        return;
    const state = next.state, prior = before.state;
    const fresh = state.status === 'failed' ? state.inspection : state.steps.find(step => step.inspection?.attemptId === prior.attempt.id)?.inspection;
    const parsed = kind === 'approval-decided' ? z.strictObject({ attemptId: z.uuid(), nodeId: z.string(), decision: approvalDecision,
        scope: loopScope.optional(), routes: recordedRoutesSchema.optional(), pauseAfter: z.literal(true).optional(), segment: runTraceSegment.optional() }).safeParse(data) : undefined;
    require(!parsed || parsed.success);
    const decision = parsed?.success ? parsed.data : undefined;
    if (decision?.segment) {
        const previous = before.traceSegments ?? [], segment = decision.segment, segments = next.traceSegments ?? [];
        require(decision.decision.kind === 'action' && decision.decision.delegation
            && segment.operation === 'approval' && segment.at === decision.decision.at && next.updatedAt === segment.at
            && same(segment.previous, previous.at(-1)?.trace) && (!segment.parent || segment.parent.traceId === segment.trace.traceId)
            && previous.length < 10000 && !previous.some(value => value.trace.traceId === segment.trace.traceId && value.trace.spanId === segment.trace.spanId)
            && segments.length === previous.length + 1 && same(segments.slice(0, -1), previous) && same(segments.at(-1), segment));
    }
    else if (kind === 'approval-decided')
        require(same(before.traceSegments, next.traceSegments));
    if (decision)
        require(!before.cancellation && decision.attemptId === prior.attempt.id && decision.nodeId === prior.next
            && same(decision.scope, prior.scope)
            && (!prior.scope || (before.loopDeadlines[prior.scope.loop] ?? 0) > Date.parse(decision.decision.at))
            && Date.parse(decision.decision.at) >= Date.parse(before.updatedAt) && Date.parse(decision.decision.at) <= Date.parse(next.updatedAt)
            && (decision.decision.kind === 'expired' ? Date.parse(decision.decision.at) >= Date.parse(prior.expiresAt)
                : Date.parse(decision.decision.at) < Date.parse(prior.expiresAt)));
    const routes = recordedRoutes(state.steps, prior.steps.length);
    const suppliedRoutes = data && typeof data === 'object' && 'routes' in data ? data.routes : undefined;
    require(same(suppliedRoutes ?? [], routes));
    if (!decision)
        require(same(data, { attemptId: prior.attempt.id, nodeId: prior.next, scope: 'scope' in prior ? prior.scope ?? null : null,
            status: state.status, ...(suppliedRoutes === undefined ? {} : { routes }) }));
    const expected = advanceCheckpoint(graph, next.input, { status: 'paused', steps: prior.steps, next: prior.next,
        ...('scope' in prior && prior.scope ? { scope: prior.scope } : {}) }, limits.binding.data, undefined, prior.attempt, fresh?.modelOutput, decision?.decision);
    require(checkpointMatches(state, expected) && same(state.steps.slice(0, prior.steps.length), prior.steps));
    // New durable settlements cannot silently omit a newly selected port; legacy prefixes stay untouched.
    require(same(recordedRoutes(state.steps, prior.steps.length), recordedRoutes(expected.steps, prior.steps.length)));
    for (const [index, step] of expected.steps.entries())
        if (index >= prior.steps.length && step.inspection?.attemptId)
            require(state.steps[index]?.inspection?.attemptId === step.inspection.attemptId && same(state.steps[index]?.inspection?.approval, step.inspection.approval)
                && same(state.steps[index]?.inspection?.trace, prior.attempt.trace));
    if (expected.status === 'failed' && expected.inspection?.attemptId)
        require(state.status === 'failed' && state.inspection?.attemptId === expected.inspection.attemptId && same(state.inspection?.approval, expected.inspection.approval)
            && same(state.inspection?.trace, prior.attempt.trace));
}

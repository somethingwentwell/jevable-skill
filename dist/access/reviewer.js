import { z } from 'zod';
import { isDeepStrictEqual as same } from 'node:util';
import { grantIdSchema, grantMetadataSchema, grantScopeSchema } from "./grants.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { runTraceSegment } from "../runtime/run-trace.js";
import { approvalActionSchema } from "../workflow/approval-action.js";
export const reviewerDecisionRequestSchema = z.strictObject({ requestId: grantIdSchema, action: approvalActionSchema, pauseAfter: z.boolean().optional() });
export const reviewerBindingSchema = z.strictObject({ requestId: grantIdSchema, grantId: grantIdSchema,
    scope: grantScopeSchema.options[1], deadline: z.iso.datetime(), pauseAfter: z.boolean() });
export const reviewerDecisionEvidenceSchema = z.strictObject({ kind: z.literal('action'), action: approvalActionSchema,
    actor: z.string().min(1).max(256), at: z.iso.datetime(), delegation: reviewerBindingSchema })
    .refine(value => value.actor === `grant:${value.delegation.grantId}` && value.delegation.scope.decisions.includes(value.action)
    && Date.parse(value.at) < Date.parse(value.delegation.deadline));
const corrupt = () => new WorkflowRuntimeError('corrupt');
const denied = () => new WorkflowRuntimeError('not-found');
function payload(event) {
    return event.data !== null && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data : undefined;
}
function delegated(events) {
    const results = [];
    for (const event of events) {
        const data = payload(event), raw = data?.decision;
        if (raw === null || typeof raw !== 'object' || !('delegation' in raw))
            continue;
        const parsed = reviewerDecisionEvidenceSchema.safeParse(raw);
        if (event.kind !== 'approval-decided' || !parsed.success || !data)
            throw corrupt();
        results.push({ decision: parsed.data, data });
    }
    return results;
}
/** PostgreSQL retains the decision request as the atomic journal batch identity as well. */
export function verifyReviewerBatchIdentity(kind, data, batchId) {
    const decision = delegated([{ kind, data }])[0]?.decision;
    if (!decision)
        return undefined;
    const parsed = grantIdSchema.safeParse(batchId);
    if (!parsed.success || parsed.data !== decision.delegation.requestId)
        throw corrupt();
    return decision;
}
function inspected(record) {
    const values = record.state.steps.map(step => ({ attemptId: step.inspection?.attemptId, nodeId: step.nodeId, scope: step.scope, decision: step.inspection?.approval }));
    if (record.state.status === 'failed')
        values.push({ attemptId: record.state.inspection?.attemptId, nodeId: record.state.nodeId,
            scope: record.state.scope, decision: record.state.inspection?.approval });
    return values;
}
/** Checked grant readers resolve these privately; no token or principal survives in run evidence. */
export function reviewerGrantIds(record, events) {
    const ids = delegated(events).map(item => item.decision.delegation.grantId);
    for (const item of inspected(record))
        if (item.decision?.kind === 'action' && item.decision.delegation)
            ids.push(item.decision.delegation.grantId);
    return [...new Set(ids)];
}
/** Historical consistency, not live authority. A privileged database writer can still rewrite every source. */
export function verifyReviewerDecisions(record, events, grants = []) {
    const decisions = delegated(events), seen = new Set(), inspections = inspected(record);
    // Historical reviewer binaries recorded continuation as an ordinary execution-segment.
    // New decision segments join the same ordered chain but never require an extra writer event.
    if (decisions.length || events.some(event => payload(event)?.segment !== undefined)) {
        const segments = events.flatMap(event => {
            const data = payload(event);
            const raw = event.kind === 'execution-segment' ? data : data?.segment;
            if (raw === undefined)
                return [];
            const parsed = runTraceSegment.safeParse(raw);
            if (!parsed.success || event.kind !== 'execution-segment' && (event.kind !== 'approval-decided'
                || !decisions.some(value => value.data === data && parsed.data.operation === 'approval' && parsed.data.at === value.decision.at)))
                throw corrupt();
            return [parsed.data];
        });
        if (!same(record.traceSegments ?? [], segments))
            throw corrupt();
    }
    for (const { decision, data } of decisions) {
        const binding = decision.delegation, metadata = grants.find(grant => grant.id === binding.grantId), parsed = grantMetadataSchema.safeParse(metadata);
        const requests = events.filter(event => event.kind === 'approval-requested' && payload(event)?.attemptId === data.attemptId);
        const wait = requests.length === 1 ? payload(requests[0]) : undefined;
        const scope = binding.scope, at = Date.parse(decision.at), inspection = inspections.filter(item => item.attemptId === data.attemptId);
        const loop = wait?.scope && typeof wait.scope === 'object' && 'loop' in wait.scope ? String(wait.scope.loop) : undefined;
        const waitExpiry = z.iso.datetime().safeParse(wait?.expiresAt);
        if (!parsed.success || !same(parsed.data.scope, scope) || scope.runId !== record.id || scope.revision !== record.revision
            || scope.attemptId !== data.attemptId || !waitExpiry.success || wait?.nodeId !== data.nodeId
            || !same(wait?.scope ?? undefined, data.scope) || data.pauseAfter !== undefined && data.pauseAfter !== true
            || (data.pauseAfter === true) !== binding.pauseAfter
            || inspection.length !== 1 || !same(inspection[0]?.decision, decision) || inspection[0]?.nodeId !== data.nodeId
            || !same(inspection[0]?.scope, data.scope) || seen.has(binding.requestId)
            || at < Date.parse(parsed.data.issuedAt) || at >= Date.parse(parsed.data.expiresAt)
            || parsed.data.revocation && at > Date.parse(parsed.data.revocation.at))
            throw corrupt();
        const deadlines = [Date.parse(parsed.data.expiresAt), Date.parse(waitExpiry.data)];
        if (loop) {
            const deadline = record.loopDeadlines[loop];
            if (deadline === undefined)
                throw corrupt();
            deadlines.push(deadline);
        }
        if (Date.parse(binding.deadline) !== Math.min(...deadlines) || at >= Math.min(...deadlines))
            throw corrupt();
        seen.add(binding.requestId);
    }
    const privateInspections = inspections.filter(item => item.decision?.kind === 'action' && item.decision.delegation);
    if (privateInspections.length !== decisions.length)
        throw corrupt();
}
/** Derive the only live target from retained evidence. Expiry-less legacy waits need an owner decision. */
export function reviewerTarget(record, events) {
    const state = record.state;
    if (state.status !== 'waiting' || record.cancellation)
        throw denied();
    const requests = events.filter(event => event.kind === 'approval-requested' && payload(event)?.attemptId === state.attempt.id);
    const wait = requests.length === 1 ? payload(requests[0]) : undefined;
    if (wait?.expiresAt !== state.expiresAt || wait.nodeId !== state.next || !same(wait.scope ?? undefined, state.scope))
        throw denied();
    const loopExpiry = state.scope ? record.loopDeadlines[state.scope.loop] : undefined;
    if (state.scope && loopExpiry === undefined)
        throw corrupt();
    return { kind: 'run', runId: record.id, revision: record.revision, cancelled: false,
        wait: { attemptId: state.attempt.id, expiresAt: state.expiresAt,
            ...(loopExpiry === undefined ? {} : { loopExpiresAt: new Date(loopExpiry).toISOString() }) } };
}
export function reviewerDecision(admission, request) {
    if (admission.scope.kind !== 'reviewer' || admission.action.kind !== 'decision' || admission.action.decision !== request.action)
        throw corrupt();
    return reviewerDecisionEvidenceSchema.parse({ kind: 'action', action: request.action, actor: admission.actor, at: admission.admittedAt,
        delegation: { requestId: request.requestId, grantId: admission.grantId, scope: admission.scope, deadline: admission.expiresAt, pauseAfter: request.pauseAfter === true } });
}
/** This is receipt observation only; callers must freshly authenticate the exact reviewer/action first. */
export function reviewerRetry(record, events, principal, request) {
    if (principal.scope.kind !== 'reviewer' || principal.scope.runId !== record.id || principal.scope.revision !== record.revision
        || !principal.scope.decisions.includes(request.action))
        throw denied();
    const prior = delegated(events).find(item => item.decision.delegation.requestId === request.requestId)?.decision;
    if (!prior)
        return undefined;
    if (prior.delegation.grantId !== principal.grantId || !same(prior.delegation.scope, principal.scope))
        throw denied();
    if (prior.action !== request.action || prior.delegation.pauseAfter !== (request.pauseAfter === true))
        throw new WorkflowRuntimeError('conflict');
    return reviewerReceipt(record, prior);
}
export const reviewerDecisionReceiptSchema = z.strictObject({ schemaVersion: z.literal(1), requestId: grantIdSchema, runId: grantIdSchema,
    attemptId: grantIdSchema, revision: z.string().regex(/^[a-f0-9]{64}$/u), action: approvalActionSchema, at: z.iso.datetime(),
    pauseAfter: z.boolean(), status: z.enum(['paused', 'waiting', 'executing', 'completed', 'failed', 'cancelled']) });
export function reviewerReceipt(record, decision) {
    return { schemaVersion: 1, requestId: decision.delegation.requestId, runId: record.id, attemptId: decision.delegation.scope.attemptId,
        revision: record.revision, action: decision.action, at: decision.at, pauseAfter: decision.delegation.pauseAfter, status: record.state.status };
}

import { z } from 'zod';
import { isDeepStrictEqual as same } from 'node:util';
import { grantIdSchema, grantMetadataSchema, grantScopeSchema } from "./grants.js";
import { callerRunReceipt, callerRunReceiptSchema } from "./caller.js";
export { callerCancellationRequestSchema } from "./caller.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { runTrace } from "../runtime/run-trace.js";
/** Private writer-derived attribution. Never accepted in a caller request. */
export const callerCancellationBindingSchema = z.strictObject({ grantId: grantIdSchema,
    scope: grantScopeSchema.options[0], deadline: z.iso.datetime() });
export const callerCancellationEvidenceSchema = z.strictObject({ id: grantIdSchema,
    actor: z.string().min(1).max(256), at: z.iso.datetime(), traceParent: runTrace.optional(), delegation: callerCancellationBindingSchema })
    .refine(value => value.actor === `grant:${value.delegation.grantId}`
    && value.delegation.scope.permissions.includes('cancel') && Date.parse(value.at) < Date.parse(value.delegation.deadline));
const externalEffects = 'not-reverted; unsettled attempts may have unknown outcomes';
export const callerCancellationReceiptSchema = callerRunReceiptSchema.safeExtend({ requestId: grantIdSchema,
    requestedAt: z.iso.datetime(), externalEffects: z.literal(externalEffects) })
    .refine(value => Date.parse(value.requestedAt) >= Date.parse(value.createdAt)
    && Date.parse(value.requestedAt) <= Date.parse(value.updatedAt));
const corrupt = () => new WorkflowRuntimeError('corrupt');
const conflict = () => new WorkflowRuntimeError('conflict');
/** Actual retained target; a request cannot choose a grant, release, actor or scope. */
export function callerCancellationTarget(record) {
    if (!record.caller || !record.release)
        throw new WorkflowRuntimeError('not-found');
    return { kind: 'run', runId: record.id, revision: record.revision,
        release: { ...record.release, revision: record.revision }, callerGrantId: record.caller.grantId,
        cancelled: record.cancellation !== undefined || record.state.status === 'cancelled' };
}
export function prepareCallerCancellation(record, request, admission, parent) {
    if (admission.action.kind !== 'cancel' || admission.action.runId !== record.id || admission.scope.kind !== 'caller'
        || admission.grantId !== record.caller?.grantId || !same(admission.scope, record.caller.scope))
        throw corrupt();
    if (record.cancellation || ['completed', 'failed', 'cancelled'].includes(record.state.status))
        throw conflict();
    if (Date.parse(admission.admittedAt) < Math.max(Date.parse(record.createdAt), Date.parse(record.updatedAt)))
        throw conflict();
    const cancellation = callerCancellationEvidenceSchema.parse({ id: request.requestId, actor: admission.actor, at: admission.admittedAt,
        ...(parent ? { traceParent: parent } : {}),
        delegation: { grantId: admission.grantId, scope: admission.scope, deadline: admission.expiresAt } });
    return { record: { ...record, cancellation, updatedAt: cancellation.at }, cancellation };
}
/** Fresh scoped authentication precedes this observation. No abort, settlement, execution or new evidence. */
export function callerCancellationRetry(record, request) {
    if (!record.cancellation)
        return undefined;
    const saved = callerCancellationEvidenceSchema.safeParse(record.cancellation);
    if (!saved.success || saved.data.id !== request.requestId)
        throw conflict();
    if (saved.data.delegation.grantId !== record.caller?.grantId || !same(saved.data.delegation.scope, record.caller.scope))
        throw corrupt();
    return callerCancellationReceipt(record);
}
export function callerCancellationReceipt(record) {
    const saved = callerCancellationEvidenceSchema.safeParse(record.cancellation);
    if (!saved.success)
        throw corrupt();
    return { ...callerRunReceipt(record), requestId: saved.data.id, requestedAt: saved.data.at, externalEffects };
}
function delegated(event) {
    if (event.kind === 'execution-requested')
        return undefined; // Independently checked by the caller-control verifier.
    if (event.data === null || typeof event.data !== 'object' || !Object.hasOwn(event.data, 'delegation'))
        return undefined;
    const saved = callerCancellationEvidenceSchema.safeParse(event.data);
    if (event.kind !== 'cancellation-requested' || !saved.success)
        throw corrupt();
    return saved.data;
}
/** PostgreSQL binds the action UUID to the exact atomic run-event batch on write AND replay. */
export function verifyCallerCancellationBatchIdentity(kind, data, batchId) {
    const cancellation = delegated({ kind, data });
    if (cancellation && cancellation.id !== grantIdSchema.safeParse(batchId).data)
        throw corrupt();
    return cancellation;
}
/** Historical consistency, never live authority. Shared replay also checks snapshot/event correspondence. */
export function verifyCallerCancellation(record, events, metadata) {
    const cancellations = events.flatMap(event => { const value = delegated(event); return value ? [value] : []; });
    const saved = record.cancellation?.delegation === undefined ? undefined : callerCancellationEvidenceSchema.safeParse(record.cancellation);
    if (!saved) {
        if (cancellations.length)
            throw corrupt();
        return;
    }
    const grant = grantMetadataSchema.safeParse(metadata);
    if (!saved.success || !grant.success || cancellations.length !== 1 || !same(saved.data, cancellations[0]))
        throw corrupt();
    const value = saved.data, binding = value.delegation, at = Date.parse(value.at);
    if (binding.grantId !== record.caller?.grantId || binding.grantId !== grant.data.id
        || !same(binding.scope, record.caller.scope) || !same(binding.scope, grant.data.scope)
        || binding.deadline !== grant.data.expiresAt || at < Date.parse(record.createdAt)
        || at < Date.parse(grant.data.issuedAt) || at >= Date.parse(grant.data.expiresAt)
        || grant.data.revocation && at > Date.parse(grant.data.revocation.at))
        throw corrupt();
}

import { z } from 'zod';
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { approvalNotificationEventSchema, approvalNotificationKind, notificationRequestSchema, notificationSha256 } from "./schema.js";
import { reference } from "../providers/config.js";
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const scope = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('project'), id: z.uuid(), generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), revision: hash }),
    z.strictObject({ kind: z.literal('release'), id: z.uuid(), sha256: hash, revision: hash }),
]);
const route = z.strictObject({ scope, endpointId: reference, endpointSha256: hash,
    eventKinds: z.array(approvalNotificationKind).min(1).max(4)
        .refine(kinds => new Set(kinds).size === kinds.length) });
const policySchema = z.strictObject({ format: z.literal('jevable.ai/automatic-approval-policy/v1'),
    routes: z.array(route).min(1).max(32) });
export { policySchema as automaticApprovalPolicySchema };
const destinationsSchema = z.array(z.strictObject({ id: reference, endpointSha256: hash })).max(32)
    .refine(values => new Set(values.map(value => value.id)).size === values.length);
/** Normalize reviewed routes; no credentials, startup defaults, wildcard scopes or delivery authority. */
export function parseAutomaticApprovalPolicy(value) {
    const parsed = policySchema.safeParse(value);
    if (!parsed.success)
        throw new WorkflowRuntimeError('invalid-command');
    const seen = new Set();
    const routes = parsed.data.routes.map(item => {
        const normalized = { ...item, eventKinds: [...item.eventKinds].sort() };
        for (const kind of normalized.eventKinds) {
            const key = JSON.stringify([normalized.scope, normalized.endpointId, kind]);
            if (seen.has(key))
                throw new WorkflowRuntimeError('invalid-command');
            seen.add(key);
        }
        return normalized;
    }).sort((a, b) => {
        const left = JSON.stringify(a), right = JSON.stringify(b);
        return left < right ? -1 : left > right ? 1 : 0;
    });
    return { format: parsed.data.format, routes };
}
/** Review metadata only. The startup owner must verify stored scopes separately; this never authorizes human approval. */
export function reviewAutomaticApprovalPolicy(value) {
    const policy = parseAutomaticApprovalPolicy(value);
    return { policy, policySha256: notificationSha256(policy), scopeVerification: 'not-performed', dispatch: 'not-attempted' };
}
function requestId(policySha256, eventSha256, endpointId, endpointSha256) {
    const bytes = Buffer.from(notificationSha256({ domain: 'jevable.ai/automatic-approval-request/v1',
        policySha256, eventSha256, endpointId, endpointSha256 }).slice(0, 32), 'hex');
    // RFC 9562 UUIDv8 carries a domain-separated deterministic identity, not approval authority.
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** Structural planning only; the caller must separately verify retained journal evidence and delivery authority. Never send or replay. */
export function planAutomaticApprovalNotifications(policyValue, eventValue, destinationsValue) {
    const policy = parseAutomaticApprovalPolicy(policyValue);
    const parsed = approvalNotificationEventSchema.safeParse(eventValue);
    const destinations = destinationsSchema.safeParse(destinationsValue);
    if (!parsed.success || !destinations.success)
        throw new WorkflowRuntimeError('invalid-command');
    const event = parsed.data;
    if (event.id !== notificationSha256({ source: event.source, type: event.type, time: event.time, data: event.data }))
        throw new WorkflowRuntimeError('corrupt');
    const kind = approvalNotificationKind.parse(event.type.slice('ai.jevable.approval.'.length));
    const policySha256 = notificationSha256(policy), eventSha256 = notificationSha256(event);
    const requests = [], endpoints = new Set();
    for (const item of policy.routes) {
        if (item.scope.revision !== event.data.revision || !item.eventKinds.includes(kind))
            continue;
        const matches = item.scope.kind === 'release'
            ? event.data.release?.id === item.scope.id && event.data.release.sha256 === item.scope.sha256
            : event.data.project?.id === item.scope.id && event.data.project.generation === item.scope.generation;
        if (!matches)
            continue;
        const current = destinations.data.find(value => value.id === item.endpointId);
        if (!current || current.endpointSha256 !== item.endpointSha256)
            throw new WorkflowRuntimeError('conflict');
        // A run can carry both project and release provenance. Two matching scopes must not double-send to one endpoint.
        if (endpoints.has(item.endpointId))
            throw new WorkflowRuntimeError('conflict');
        endpoints.add(item.endpointId);
        requests.push(notificationRequestSchema.parse({ runId: event.data.runId, revision: event.data.revision,
            attemptId: event.data.attemptId, eventKind: kind, endpointId: item.endpointId,
            endpointSha256: item.endpointSha256, eventSha256,
            requestId: requestId(policySha256, eventSha256, item.endpointId, item.endpointSha256) }));
    }
    return { policySha256, actor: `automatic:${policySha256}`, requests, dispatch: 'not-attempted' };
}

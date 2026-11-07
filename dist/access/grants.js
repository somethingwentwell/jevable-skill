import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { approvalActionSchema } from "../workflow/approval-action.js";
export const GRANT_LIMITS = Object.freeze({ records: 10000, bytes: 32768, page: 200 });
export const grantIdSchema = z.uuid().transform(value => value.toLowerCase());
const sha = z.string().regex(/^(?!0{64}$)[a-f0-9]{64}$/u);
const actor = z.string().min(1).max(256).refine(value => Boolean(value.trim()) && value.isWellFormed());
const callerPermissions = z.array(z.enum(['start', 'read', 'control', 'cancel'])).min(1).max(4)
    .refine(values => new Set(values).size === values.length).transform(values => values.sort());
export const reviewerDecisionsSchema = z.array(approvalActionSchema).min(1).max(200)
    .refine(values => new Set(values).size === values.length).transform(values => values.sort());
export const grantScopeSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('caller'), release: z.strictObject({ id: grantIdSchema, sha256: sha, revision: sha }), permissions: callerPermissions }),
    z.strictObject({ kind: z.literal('reviewer'), runId: grantIdSchema, attemptId: grantIdSchema, revision: sha, decisions: reviewerDecisionsSchema }),
]);
export const grantIssueSchema = z.strictObject({ id: grantIdSchema, tokenSha256: sha, scope: grantScopeSchema,
    expiresAt: z.iso.datetime(), actor });
export const grantRevokeSchema = z.strictObject({ id: grantIdSchema, requestId: grantIdSchema, expectedGeneration: z.literal(1), actor });
export const grantPageSchema = z.strictObject({ after: grantIdSchema.optional(), limit: z.number().int().min(1).max(GRANT_LIMITS.page).default(100) });
const revocationSchema = z.strictObject({ requestId: grantIdSchema, previousGeneration: z.literal(1), actor, at: z.iso.datetime() });
const recordShape = { schemaVersion: z.literal(1), id: grantIdSchema, generation: z.union([z.literal(1), z.literal(2)]),
    tokenSha256: sha, scope: grantScopeSchema, issuedAt: z.iso.datetime(), issuer: actor, expiresAt: z.iso.datetime(), revocation: revocationSchema.optional() };
export const grantRecordSchema = z.strictObject(recordShape).refine(record => Date.parse(record.expiresAt) > Date.parse(record.issuedAt)
    && (record.generation === 1 ? record.revocation === undefined : record.revocation !== undefined
        && record.revocation.requestId !== record.id && Date.parse(record.revocation.at) >= Date.parse(record.issuedAt)));
const { tokenSha256: _privateDigest, ...metadataShape } = recordShape;
export const grantMetadataSchema = z.strictObject({ ...metadataShape, observedAt: z.iso.datetime(), status: z.enum(['active', 'expired', 'revoked']) })
    .refine(record => Date.parse(record.expiresAt) > Date.parse(record.issuedAt)
    && (record.generation === 1 ? record.revocation === undefined : record.revocation !== undefined
        && record.revocation.requestId !== record.id && Date.parse(record.revocation.at) >= Date.parse(record.issuedAt))
    && record.status === (record.revocation ? 'revoked' : Date.parse(record.observedAt) >= Date.parse(record.expiresAt) ? 'expired' : 'active'));
export const grantPageResultSchema = z.strictObject({ schemaVersion: z.literal(1), observedAt: z.iso.datetime(),
    grants: z.array(grantMetadataSchema).max(GRANT_LIMITS.page), nextCursor: grantIdSchema.nullable() })
    .refine(page => page.grants.every((record, i) => record.observedAt === page.observedAt && (i === 0 || page.grants[i - 1].id < record.id))
    && (page.nextCursor === null || page.grants.at(-1)?.id === page.nextCursor));
const historySchema = z.strictObject({ kind: z.enum(['grant-issued', 'grant-revoked']), requestId: grantIdSchema,
    previousSha256: sha.nullable(), record: grantRecordSchema });
const invalid = () => new WorkflowRuntimeError('invalid-command');
const corrupt = () => new WorkflowRuntimeError('corrupt');
export const parseGrantIssue = (value) => { const parsed = grantIssueSchema.safeParse(value); if (!parsed.success)
    throw invalid(); return parsed.data; };
export const parseGrantRevoke = (value) => { const parsed = grantRevokeSchema.safeParse(value); if (!parsed.success)
    throw invalid(); return parsed.data; };
export const parseGrantId = (value) => { const parsed = grantIdSchema.safeParse(value); if (!parsed.success)
    throw invalid(); return parsed.data; };
export const parseGrantPage = (value) => { const parsed = grantPageSchema.safeParse(value); if (!parsed.success)
    throw invalid(); return parsed.data; };
export function inspectGrant(value) {
    try {
        if (Buffer.byteLength(JSON.stringify(value)) > GRANT_LIMITS.bytes)
            throw corrupt();
        return grantRecordSchema.parse(value);
    }
    catch {
        throw corrupt();
    }
}
const canonical = (value) => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(Reflect.get(value, key))).join(',') + '}'
        : JSON.stringify(value);
export const grantRecordHash = (record) => createHash('sha256').update(canonical(record)).digest('hex');
export function issueGrantRecord(command, at) {
    if (!z.iso.datetime().safeParse(at).success || Date.parse(command.expiresAt) <= Date.parse(at))
        throw invalid();
    return inspectGrant({ schemaVersion: 1, id: command.id, generation: 1, tokenSha256: command.tokenSha256,
        scope: command.scope, issuedAt: at, issuer: command.actor, expiresAt: command.expiresAt });
}
export function sameGrantIssue(record, command) {
    return record.id === command.id && record.tokenSha256 === command.tokenSha256 && record.issuer === command.actor
        && record.expiresAt === command.expiresAt && isDeepStrictEqual(record.scope, command.scope);
}
export function revokeGrantRecord(record, command, at) {
    if (record.id !== command.id || command.requestId === record.id)
        throw new WorkflowRuntimeError('conflict');
    if (record.revocation) {
        if (record.revocation.requestId !== command.requestId || record.revocation.actor !== command.actor)
            throw new WorkflowRuntimeError('conflict');
        return record;
    }
    if (!z.iso.datetime().safeParse(at).success || Date.parse(at) < Date.parse(record.issuedAt))
        throw invalid();
    return inspectGrant({ ...record, generation: 2, revocation: { requestId: command.requestId, previousGeneration: 1, actor: command.actor, at } });
}
export function grantHistory(record, previous) {
    return { kind: previous ? 'grant-revoked' : 'grant-issued', requestId: previous ? record.revocation.requestId : record.id,
        previousSha256: previous ? grantRecordHash(previous) : null, record };
}
/** Audit consistency detects accidental/partial substitution, not a signature against a privileged database writer. */
export function inspectGrantHistory(record, values) {
    try {
        if (values.length !== record.generation)
            throw corrupt();
        const entries = values.map(value => historySchema.parse(value)), first = entries[0];
        if (first.kind !== 'grant-issued' || first.requestId !== record.id || first.previousSha256 !== null || first.record.generation !== 1)
            throw corrupt();
        let current = first.record;
        if (entries[1]) {
            const last = entries[1], revocation = last.record.revocation;
            if (last.kind !== 'grant-revoked' || !revocation || last.requestId !== revocation.requestId
                || last.previousSha256 !== grantRecordHash(current))
                throw corrupt();
            current = revokeGrantRecord(current, { id: current.id, requestId: revocation.requestId, expectedGeneration: 1, actor: revocation.actor }, revocation.at);
            if (!isDeepStrictEqual(current, last.record))
                throw corrupt();
        }
        if (!isDeepStrictEqual(current, record))
            throw corrupt();
    }
    catch {
        throw corrupt();
    }
}
export function grantMetadata(record, at = new Date().toISOString()) {
    const { tokenSha256: _digest, ...metadata } = record;
    return structuredClone({ ...metadata, observedAt: at, status: record.revocation ? 'revoked' : Date.parse(at) >= Date.parse(record.expiresAt) ? 'expired' : 'active' });
}
/** Prepare and privately persist this before issuance; the owner receives only its digest. No grant is issued here. */
export function prepareGrantToken(value) {
    const id = parseGrantId(value), token = `jvg1.${id}.${randomBytes(32).toString('hex')}`;
    return { id, token, tokenSha256: grantTokenProof(token).tokenSha256 };
}
/** Syntax/digest is NOT authorization, a permission decision, or constant-time handling of the whole request. */
export function grantTokenProof(value) {
    if (typeof value !== 'string' || value.length !== 106)
        return null;
    const match = /^jvg1\.([a-f0-9-]{36})\.([a-f0-9]{64})$/u.exec(value);
    if (!match || !grantIdSchema.safeParse(match[1]).success)
        return null;
    return { id: match[1], tokenSha256: createHash('sha256').update('jevable/delegated-grant/v1\0' + value).digest('hex') };
}
/** Internal lookup only. Action admission must recheck scope/revocation at its own mutation boundary. */
export function grantPrincipal(record, proof, at = new Date().toISOString()) {
    if (!z.iso.datetime().safeParse(at).success || Date.parse(at) < Date.parse(record.issuedAt)
        || proof.id !== record.id || !sha.safeParse(proof.tokenSha256).success
        || !timingSafeEqual(Buffer.from(proof.tokenSha256, 'hex'), Buffer.from(record.tokenSha256, 'hex'))
        || record.revocation || Date.parse(at) >= Date.parse(record.expiresAt))
        return null;
    return { grantId: record.id, actor: `grant:${record.id}`, scope: structuredClone(record.scope), expiresAt: record.expiresAt };
}

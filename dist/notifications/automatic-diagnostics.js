import { z } from 'zod';
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { notificationRequestSchema } from "./schema.js";
import { inspectAutomaticAdmission, automaticAdmissionPage, automaticAdmissionSemantics, automaticFailureCode, parseAutomaticAdmissionPage } from "./automatic-admission.js";
import { notificationReleaseScopeSchema } from "./release-history.js";
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const outcome = z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('reserved') }),
    z.strictObject({ status: z.literal('failed'), at: z.iso.datetime(), code: automaticFailureCode }),
    z.strictObject({ status: z.literal('delivery-recorded'), at: z.iso.datetime(), deliverySha256: hash,
        deliveryStatus: z.enum(['pending', 'settled']) }),
]);
export const automaticDiagnosticSchema = z.strictObject({ schemaVersion: z.literal(1),
    request: notificationRequestSchema.refine(value => value.eventKind !== undefined && value.redeliverOf === undefined),
    policySha256: hash, createdAt: z.iso.datetime(), outcome,
    release: z.strictObject({ id: z.uuid(), sha256: hash }).optional(), semantics: z.literal(automaticAdmissionSemantics),
});
export const automaticDiagnosticPageSchema = z.strictObject({ schemaVersion: z.literal(1),
    admissions: z.array(automaticDiagnosticSchema).max(200), nextCursor: z.uuid().nullable(), semantics: z.literal(automaticAdmissionSemantics),
});
export const automaticDiagnosticStatusSchema = z.strictObject({ schemaVersion: z.literal(1), configured: z.boolean(),
    policySha256: hash.optional(), routeCount: z.number().int().min(1).max(32).optional(),
    live: z.strictObject({ pending: z.number().int().nonnegative(), admitting: z.number().int().nonnegative(),
        active: z.number().int().nonnegative(), sealed: z.boolean(),
        fault: z.strictObject({ code: automaticFailureCode, requestId: z.uuid().optional(), runId: z.uuid().optional(),
            transition: z.string().regex(/^[a-z][a-z-]{0,127}$/u).optional() }).optional(),
        semantics: z.literal('live-commits-only; no-replay; failure-is-not-proof-of-no-effect'),
    }).nullable(),
}).refine(value => value.configured ? value.policySha256 !== undefined && value.routeCount !== undefined && value.live !== null
    : value.policySha256 === undefined && value.routeCount === undefined && value.live === null);
/** Public diagnostic projection excludes the full policy, other routes/destinations,
 * event body and private review values. It is neither delivery nor approval authority.
 */
export function automaticDiagnostic(value) {
    const record = inspectAutomaticAdmission(value), release = record.event.data.release;
    return automaticDiagnosticSchema.parse({ schemaVersion: 1, request: record.request, policySha256: record.policySha256,
        createdAt: record.createdAt, outcome: record.outcome, ...(release ? { release } : {}), semantics: automaticAdmissionSemantics });
}
export function automaticDiagnosticMatches(record, scope) {
    const release = record.event.data.release;
    return release?.id === scope.id && release.sha256 === scope.sha256 && record.request.revision === scope.revision;
}
/** Live bounded filtering; retain one page and return matching cursors only. The
 * underlying owner verifies every record, including skipped foreign histories.
 */
export async function automaticDiagnosticPage(reader, value, scopeValue) {
    const options = parseAutomaticAdmissionPage(value);
    const parsedScope = scopeValue === undefined ? undefined : notificationReleaseScopeSchema.safeParse(scopeValue);
    if (parsedScope && !parsedScope.success)
        throw new WorkflowRuntimeError('invalid-command');
    const scope = parsedScope?.data;
    const matches = (record) => scope === undefined || automaticDiagnosticMatches(record, scope);
    if (options.after !== undefined) {
        const record = inspectAutomaticAdmission(await reader.get(options.after));
        if (record.request.requestId !== options.after)
            throw new WorkflowRuntimeError('corrupt');
        if (!matches(record))
            throw new WorkflowRuntimeError('not-found');
    }
    const records = [];
    let after = options.after, scanned = 0;
    while (true) {
        const page = await reader.page({ ...(after === undefined ? {} : { after }), limit: 200 });
        if (!Array.isArray(page.records) || page.records.length > 200
            || page.nextCursor !== null && (!z.uuid().safeParse(page.nextCursor).success || page.nextCursor !== page.records.at(-1)?.request.requestId))
            throw new WorkflowRuntimeError('corrupt');
        let previous = after;
        for (const value of page.records) {
            const record = inspectAutomaticAdmission(value), id = record.request.requestId;
            if (previous !== undefined && id <= previous)
                throw new WorkflowRuntimeError('corrupt');
            previous = id;
            if (++scanned > 100000)
                throw new WorkflowRuntimeError('limit');
            if (!matches(record))
                continue;
            if (records.length === options.limit)
                return diagnosticPage(records, records.at(-1).request.requestId);
            records.push(record);
        }
        if (page.nextCursor === null)
            return diagnosticPage(records, null);
        after = page.nextCursor;
    }
}
function diagnosticPage(records, nextCursor) {
    return { schemaVersion: 1, admissions: records.map(automaticDiagnostic), nextCursor, semantics: automaticAdmissionSemantics };
}
/** Check untrusted selected-owner metadata before CLI output; no raw foreign fields. */
export function inspectAutomaticDiagnosticPage(value, request) {
    const options = automaticAdmissionPage.parse(request), page = automaticDiagnosticPageSchema.parse(value);
    if (page.admissions.length > options.limit || page.nextCursor !== null && page.nextCursor !== page.admissions.at(-1)?.request.requestId)
        throw new WorkflowRuntimeError('corrupt');
    let after = options.after;
    for (const record of page.admissions) {
        if (after !== undefined && record.request.requestId <= after)
            throw new WorkflowRuntimeError('corrupt');
        after = record.request.requestId;
    }
    return page;
}

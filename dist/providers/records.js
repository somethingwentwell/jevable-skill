import { z } from 'zod';
import { connectionRecordSchema, reference } from "./config.js";
import { runTrace } from "../runtime/run-types.js";
export const MAX_MODEL_ATTEMPTS = 10;
const usage = z.strictObject({ tries: z.literal(1), inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional() });
const failureCode = z.enum(['request-too-large', 'response-too-large', 'invalid-response', 'http-error', 'transport-error', 'timeout', 'cancelled']);
const common = {
    attemptId: z.uuid(), at: z.iso.datetime(),
    route: connectionRecordSchema,
    request: z.record(z.string(), z.json()),
    // Local model-call identity is independent of authorization to send context to a provider.
    trace: runTrace.optional(),
    traceparent: z.string().regex(/^00-(?!0{32}-)[a-f0-9]{32}-(?!0{16}-)[a-f0-9]{16}-0[01]$/u).optional(),
};
const legacyEvidenceSchema = z.strictObject({
    schemaVersion: z.literal(1), ...common,
    result: z.discriminatedUnion('status', [
        z.strictObject({ status: z.literal('pending') }),
        z.strictObject({ status: z.literal('failed'), code: failureCode, at: z.iso.datetime() }),
        z.strictObject({ status: z.literal('completed'), output: z.string(), usage, at: z.iso.datetime(),
            providerModel: z.string().max(256).optional(), responseId: z.string().max(256).optional() }),
    ]),
});
export const RETRYABLE_HTTP_STATUSES = [408, 429, 500, 502, 503, 504];
const retryFailure = z.strictObject({ status: z.literal('failed'), code: failureCode, at: z.iso.datetime(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    retryDelayMs: z.number().int().min(100).max(3_600_000).optional(),
}).refine(value => (value.httpStatus === undefined || value.code === 'http-error') && (value.retryDelayMs === undefined
    || value.code === 'http-error' && RETRYABLE_HTTP_STATUSES.some(status => status === value.httpStatus)));
const retryEvidenceSchema = z.strictObject({
    schemaVersion: z.literal(2), ...common,
    policy: z.strictObject({ kind: z.literal('transient-http-v1'), maxAttempts: z.number().int().min(2).max(MAX_MODEL_ATTEMPTS),
        timeoutSeconds: z.number().int().min(1).max(3600) }),
    tries: z.array(z.strictObject({ id: z.uuid(), number: z.number().int().min(1).max(MAX_MODEL_ATTEMPTS), at: z.iso.datetime(), trace: runTrace.optional(),
        result: z.discriminatedUnion('status', [z.strictObject({ status: z.literal('pending') }), retryFailure,
            z.strictObject({ status: z.literal('completed'), at: z.iso.datetime() })]),
    })).min(1).max(MAX_MODEL_ATTEMPTS),
    result: z.discriminatedUnion('status', [z.strictObject({ status: z.literal('pending') }),
        z.strictObject({ status: z.literal('failed'), code: failureCode, at: z.iso.datetime() }),
        z.strictObject({ status: z.literal('completed'), output: z.string(), at: z.iso.datetime(),
            usage: usage.extend({ tries: z.number().int().min(1).max(MAX_MODEL_ATTEMPTS) }),
            providerModel: z.string().max(256).optional(), responseId: z.string().max(256).optional() }),
    ]),
}).refine(record => {
    if (record.tries.length > record.policy.maxAttempts || record.tries[0].at !== record.at)
        return false;
    if (new Set(record.tries.map(attempt => attempt.id)).size !== record.tries.length)
        return false;
    const traces = record.tries.flatMap(attempt => attempt.trace ? [attempt.trace] : []);
    if (new Set(traces.map(trace => trace.spanId)).size !== traces.length
        || traces.some(trace => trace.traceId !== traces[0].traceId || trace.traceFlags !== traces[0].traceFlags
            || record.trace !== undefined && (trace.traceId !== record.trace.traceId || trace.traceFlags !== record.trace.traceFlags || trace.spanId === record.trace.spanId)
            || record.traceparent !== undefined && (record.traceparent.slice(3, 35) !== trace.traceId || Number(record.traceparent.slice(-1)) !== trace.traceFlags)))
        return false;
    for (const [index, attempt] of record.tries.entries()) {
        if (attempt.number !== index + 1)
            return false;
        if (index < record.tries.length - 1 && (attempt.result.status !== 'failed' || attempt.result.retryDelayMs === undefined))
            return false;
        if (attempt.result.status === 'failed' && attempt.result.retryDelayMs !== undefined
            && (attempt.number >= record.policy.maxAttempts || attempt.result.retryDelayMs < Math.min(2000, 100 * 2 ** (attempt.number - 1))))
            return false;
    }
    const last = record.tries.at(-1).result;
    if (record.result.status === 'pending')
        return last.status === 'pending' || last.status === 'failed' && last.retryDelayMs !== undefined;
    if (record.result.status === 'completed')
        return last.status === 'completed' && last.at === record.result.at && record.result.usage.tries === record.tries.length;
    return last.status === 'failed' && ((record.result.code === last.code && record.result.at === last.at && last.retryDelayMs === undefined)
        || last.retryDelayMs !== undefined && ['cancelled', 'timeout'].includes(record.result.code));
});
export const modelEvidenceSchema = z.discriminatedUnion('schemaVersion', [legacyEvidenceSchema, retryEvidenceSchema])
    .refine(record => record.traceparent === undefined || record.route.connection.tracePropagation === 'w3c')
    .refine(record => record.trace === undefined || record.traceparent === undefined
    || record.traceparent === `00-${record.trace.traceId}-${record.trace.spanId}-0${record.trace.traceFlags}`);
export const credentialSchema = z.strictObject({ ref: reference, generation: z.number().int().positive(), updatedAt: z.iso.datetime(),
    // A bearer value has no whitespace or control characters. Files may have one trailing newline before admission.
    value: z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/u) });
/** Secret-free retained generation prevents stale writes after logical credential clearing. */
export const clearedCredentialSchema = z.strictObject({ ref: reference, generation: z.number().int().positive(),
    updatedAt: z.iso.datetime(), cleared: z.literal(true) });
export const credentialRecordSchema = z.union([credentialSchema, clearedCredentialSchema]);

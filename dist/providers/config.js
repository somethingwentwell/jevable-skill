import { z } from 'zod';
import { baggageKeysSchema } from "../telemetry/baggage.js";
export const reference = z.string().regex(/^[A-Za-z][A-Za-z0-9._/-]{0,127}$/u);
/** Connections are operator configuration, never inferred from imported workflow endpoints. */
const connectionFields = {
    id: reference,
    provider: z.string().trim().min(1).max(256),
    endpoint: z.string().max(2048).refine(value => {
        try {
            const url = new URL(value);
            return !url.username && !url.password && !url.search && !url.hash && !value.includes('${{')
                && (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)));
        }
        catch {
            return false;
        }
    }, 'Endpoint must use HTTPS, or loopback HTTP, without credentials, query or fragment.').transform(value => value.replace(/\/+$/u, '')),
    allowedModels: z.array(z.string().trim().min(1).max(256)).min(1).max(1000).refine(values => new Set(values).size === values.length),
    authentication: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('bearer'), credentialRef: reference }),
        z.strictObject({ kind: z.literal('none') }),
    ]),
    // Opt-in per destination. Absence preserves historical records and never forwards ambient context.
    tracePropagation: z.enum(['none', 'w3c']).optional(),
    baggageKeys: baggageKeysSchema.optional(),
    maxResponseBytes: z.number().int().min(1024).max(16_000_000),
    maxRequestBytes: z.number().int().min(1024).max(16_000_000),
    maxTimeoutSeconds: z.number().int().min(1).max(3600),
};
export const connectionSchema = z.discriminatedUnion('protocol', [
    z.strictObject({ ...connectionFields, protocol: z.literal('openai-compatible'),
        tokenParameter: z.enum(['max_tokens', 'max_completion_tokens']), maxStreamEvents: z.number().int().min(1).max(100_000) }),
    z.strictObject({ ...connectionFields, protocol: z.literal('systemone'), provider: z.enum(['jev', 'laya']) }),
]).refine(value => value.baggageKeys === undefined || value.tracePropagation === 'w3c');
export const connectionRecordSchema = z.strictObject({
    generation: z.number().int().positive(), updatedAt: z.iso.datetime(), connection: connectionSchema,
});
/** Diagnostics use fixed categories and never include a provider response, request or credential. */
export class ProviderError extends Error {
    code;
    constructor(code) {
        super(`Jevable provider operation failed: ${code}.`);
        this.code = code;
        this.name = 'ProviderError';
    }
}

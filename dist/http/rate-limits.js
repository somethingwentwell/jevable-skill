import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { readBoundedFile } from "../files.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
const bucketSchema = z.strictObject({
    capacity: z.number().int().min(1).max(10_000),
    refillTokens: z.number().int().min(1).max(10_000),
    refillIntervalMs: z.number().int().min(1000).max(3_600_000),
});
/** Two fixed-size buckets shared by this HTTP owner, not per-IP/account or distributed state. */
export const httpRateLimitsSchema = z.strictObject({ requests: bucketSchema, controls: bucketSchema });
export class HttpRateLimitError extends Error {
    retryAfterSeconds;
    status = 429;
    code = 'rate-limit';
    constructor(retryAfterSeconds) {
        super('rate-limit');
        this.retryAfterSeconds = retryAfterSeconds;
    }
}
/** Synchronous debit before dispatch. No timers, queue, retained payloads or automatic retry. */
export function createHttpRateLimiter(value, now = () => performance.now()) {
    const parsed = httpRateLimitsSchema.safeParse(value);
    if (!parsed.success)
        throw new WorkflowRuntimeError('invalid-command');
    const policy = parsed.data, initial = now();
    if (!Number.isFinite(initial))
        throw new WorkflowRuntimeError('invalid-command');
    const buckets = {
        requests: { tokens: policy.requests.capacity, at: initial },
        controls: { tokens: policy.controls.capacity, at: initial },
    };
    return {
        policy: () => structuredClone(policy),
        admit(lane) {
            const current = now();
            if (!Number.isFinite(current))
                throw new WorkflowRuntimeError('invalid-command');
            const bucket = buckets[lane], config = policy[lane];
            // A backwards clock cannot create credit or move the refill anchor backwards.
            const at = Math.max(current, bucket.at);
            bucket.tokens = Math.min(config.capacity, bucket.tokens + (at - bucket.at) * config.refillTokens / config.refillIntervalMs);
            bucket.at = at;
            if (bucket.tokens < 1)
                throw new HttpRateLimitError(Math.max(1, Math.ceil((1 - bucket.tokens) * config.refillIntervalMs / config.refillTokens / 1000)));
            bucket.tokens -= 1;
        },
    };
}
/** Classify only already owner/scoped-authenticated commands; delegated requests cannot use reserve. */
export function isOwnerControlCommand(path, command) {
    if (path !== '/v1/operations' && path !== '/v1/preview/operations')
        return false;
    if (command === null || typeof command !== 'object' || Array.isArray(command))
        return false;
    const scoped = path === '/v1/preview/operations', operation = Reflect.get(command, 'operation');
    return operation === (scoped ? 'cancel' : 'runs.cancel')
        || operation === (scoped ? 'show' : 'runs.show')
        || (!scoped && operation === 'notifications.abort')
        || (operation === (scoped ? 'advance' : 'runs.advance') && Reflect.get(command, 'mode') === 'pause');
}
export async function readHttpRateLimitsFile(path) {
    if (path === undefined)
        return undefined;
    if (typeof path !== 'string' || !path)
        throw new WorkflowRuntimeError('invalid-command');
    let value;
    try {
        value = JSON.parse(await readBoundedFile(path, 4096));
    }
    catch {
        throw new WorkflowRuntimeError('invalid-command');
    }
    const parsed = httpRateLimitsSchema.safeParse(value);
    if (!parsed.success)
        throw new WorkflowRuntimeError('invalid-command');
    return parsed.data;
}

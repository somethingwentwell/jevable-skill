import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { httpRateLimitsSchema, HttpRateLimitError } from "./rate-limits.js";
const optionsSchema = z.strictObject({ scope: z.uuid(), policy: httpRateLimitsSchema,
    timeoutMs: z.number().int().min(100).max(5000), consume: z.custom(value => typeof value === 'function') });
const receiptBase = { requestId: z.uuid(), scope: z.uuid(), policySha256: z.string().regex(/^[a-f0-9]{64}$/u), lane: z.enum(['requests', 'controls']) };
const receiptSchema = z.discriminatedUnion('admitted', [
    z.strictObject({ ...receiptBase, admitted: z.literal(true) }),
    z.strictObject({ ...receiptBase, admitted: z.literal(false), retryAfterSeconds: z.number().int().min(1).max(3600) }),
]);
/** No upstream messages, automatic fallback, credit refund or late-response execution. */
export class HttpRateCoordinatorError extends Error {
    status = 503;
    code = 'rate-coordinator-unavailable';
    constructor() { super('rate-coordinator-unavailable'); }
}
export function createCoordinatedHttpRateLimiter(value) {
    const parsed = optionsSchema.safeParse(value);
    if (!parsed.success)
        throw new WorkflowRuntimeError('invalid-command');
    const { scope, timeoutMs } = parsed.data, policy = structuredClone(parsed.data.policy);
    // Capture the function/receiver before asynchronous startup. Later property replacement cannot retarget admission.
    const consume = parsed.data.consume.bind(value);
    const policySha256 = createHash('sha256').update(JSON.stringify(policy)).digest('hex');
    return {
        policy: () => structuredClone(policy),
        identity: () => ({ scope, policySha256, timeoutMs }),
        async admit(lane, observeSql) {
            if (lane !== 'requests' && lane !== 'controls')
                throw new WorkflowRuntimeError('invalid-command');
            const requestId = randomUUID(), controller = new AbortController();
            let timer;
            let retryAfterSeconds;
            try {
                const result = await Promise.race([
                    Promise.resolve().then(() => {
                        const request = { requestId, scope, policySha256, lane, policy: structuredClone(policy) };
                        return observeSql === undefined ? consume(request, controller.signal) : consume(request, controller.signal, observeSql);
                    }),
                    new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new HttpRateCoordinatorError()); }, timeoutMs); }),
                ]);
                const receipt = receiptSchema.safeParse(result);
                if (!receipt.success || receipt.data.requestId !== requestId || receipt.data.scope !== scope
                    || receipt.data.policySha256 !== policySha256 || receipt.data.lane !== lane)
                    throw new HttpRateCoordinatorError();
                if (!receipt.data.admitted)
                    retryAfterSeconds = receipt.data.retryAfterSeconds;
            }
            catch {
                // Only a validated, exactly bound receipt can produce a quota refusal. Even
                // typed exceptions thrown by an adapter are uncertain coordinator failures.
                throw new HttpRateCoordinatorError();
            }
            finally {
                clearTimeout(timer);
            }
            if (retryAfterSeconds !== undefined)
                throw new HttpRateLimitError(retryAfterSeconds);
        },
    };
}

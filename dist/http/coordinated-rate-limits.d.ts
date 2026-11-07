import { type HttpRateLimits } from './rate-limits.ts';
import type { HttpRateSqlObserver } from './rate-sql-observation.ts';
export type HttpRateLane = 'requests' | 'controls';
/** One HTTP attempt, not a workflow mutation identity. An uncertain debit is never retried here. */
export interface HttpRateDebit {
    requestId: string;
    scope: string;
    policySha256: string;
    lane: HttpRateLane;
    policy: HttpRateLimits;
}
export type HttpRateDebitReceipt = Pick<HttpRateDebit, 'requestId' | 'scope' | 'policySha256' | 'lane'> & ({
    admitted: true;
} | {
    admitted: false;
    retryAfterSeconds: number;
});
/** Trusted host adapter. Implement atomic shared debit with immutable scope/policy binding.
 * It must never dispatch a workflow, grant permission or refund on transport/operation failure.
 * The embedding host owns the coordinator's lifecycle; the HTTP server does not discover one.
 */
export interface CoordinatedHttpRateLimits {
    scope: string;
    policy: HttpRateLimits;
    timeoutMs: number;
    consume(request: HttpRateDebit, signal: AbortSignal, observeSql?: HttpRateSqlObserver): Promise<HttpRateDebitReceipt>;
}
/** No upstream messages, automatic fallback, credit refund or late-response execution. */
export declare class HttpRateCoordinatorError extends Error {
    readonly status = 503;
    readonly code = "rate-coordinator-unavailable";
    constructor();
}
export declare function createCoordinatedHttpRateLimiter(value: unknown): {
    policy: () => {
        requests: {
            capacity: number;
            refillTokens: number;
            refillIntervalMs: number;
        };
        controls: {
            capacity: number;
            refillTokens: number;
            refillIntervalMs: number;
        };
    };
    identity: () => {
        scope: string;
        policySha256: string;
        timeoutMs: number;
    };
    admit(lane: HttpRateLane, observeSql?: HttpRateSqlObserver): Promise<void>;
};

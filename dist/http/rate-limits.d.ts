import { z } from 'zod';
/** Two fixed-size buckets shared by this HTTP owner, not per-IP/account or distributed state. */
export declare const httpRateLimitsSchema: z.ZodObject<{
    requests: z.ZodObject<{
        capacity: z.ZodNumber;
        refillTokens: z.ZodNumber;
        refillIntervalMs: z.ZodNumber;
    }, z.core.$strict>;
    controls: z.ZodObject<{
        capacity: z.ZodNumber;
        refillTokens: z.ZodNumber;
        refillIntervalMs: z.ZodNumber;
    }, z.core.$strict>;
}, z.core.$strict>;
export type HttpRateLimits = z.infer<typeof httpRateLimitsSchema>;
export declare class HttpRateLimitError extends Error {
    readonly retryAfterSeconds: number;
    readonly status = 429;
    readonly code = "rate-limit";
    constructor(retryAfterSeconds: number);
}
/** Synchronous debit before dispatch. No timers, queue, retained payloads or automatic retry. */
export declare function createHttpRateLimiter(value: unknown, now?: () => number): {
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
    admit(lane: "requests" | "controls"): void;
};
/** Classify only already owner/scoped-authenticated commands; delegated requests cannot use reserve. */
export declare function isOwnerControlCommand(path: string, command: unknown): boolean;
export declare function readHttpRateLimitsFile(path: string | boolean | undefined): Promise<HttpRateLimits | undefined>;

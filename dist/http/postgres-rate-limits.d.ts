import { type PostgresHttpRateCoordinatorOptions } from './postgres-rate-config.ts';
export { PostgresHttpRateCoordinatorError } from './postgres-rate-config.ts';
export type { PostgresHttpRateCoordinatorOptions, PostgresHttpRateCoordinatorCode } from './postgres-rate-config.ts';
import type { CoordinatedHttpRateLimits, HttpRateDebit, HttpRateDebitReceipt } from './coordinated-rate-limits.ts';
import { type HttpRateSqlObserver } from './rate-sql-observation.ts';
/** One explicitly owned database session; independent hosts share only the provisioned scope row.
 * No workflow journal lock, connection pool, discovery, reconnect, retry or per-attempt history.
 */
export declare class PostgresHttpRateCoordinator {
    private readonly client;
    private readonly options;
    private state;
    private tail;
    private pending;
    private ending;
    private closing;
    private readonly canonicalPolicy;
    private readonly policySha256;
    private constructor();
    /** Explicit operator initialization or runtime attach; attaching never resets balances. */
    static open(value: PostgresHttpRateCoordinatorOptions): Promise<PostgresHttpRateCoordinator>;
    /** Metadata only, no query, account identity or balance disclosure. */
    status(): {
        state: "closed" | "open" | "closing" | "opening" | "lost";
        scope: string;
        policySha256: string;
        pendingDebits: number;
        maxPendingDebits: number;
    };
    /** Detached pinned HTTP configuration. Closing an HTTP server does not close this owner. */
    admission(): CoordinatedHttpRateLimits;
    private lose;
    private readLockedScope;
    /** Non-idempotent quota attempt: never retry an uncertain call, including with the same requestId. */
    consume(value: HttpRateDebit, signal: AbortSignal, observeSql?: HttpRateSqlObserver): Promise<HttpRateDebitReceipt>;
    /** Seal admission, refuse queued work, settle active SQL and end this session; no database deletion. */
    close(): Promise<void>;
}

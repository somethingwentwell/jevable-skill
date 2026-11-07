export declare const HTTP_RATE_SQL_OPERATIONS: readonly ["begin", "lock", "debit", "commit", "rollback"];
export type HttpRateSqlOperation = typeof HTTP_RATE_SQL_OPERATIONS[number];
export type HttpRateSqlOutcome = 'acknowledged' | 'failed' | 'uncertain';
/** Trusted synchronous diagnostics only. Never pass SQL, parameters, identities or raw errors. */
export interface HttpRateSqlObservation {
    end(outcome: HttpRateSqlOutcome): void;
}
export type HttpRateSqlObserver = (operation: HttpRateSqlOperation) => HttpRateSqlObservation | undefined;
export declare function beginHttpRateSqlObservation(observer: HttpRateSqlObserver | undefined, operation: HttpRateSqlOperation): HttpRateSqlObservation | undefined;
export declare function endHttpRateSqlObservation(observation: HttpRateSqlObservation | undefined, outcome: HttpRateSqlOutcome): void;

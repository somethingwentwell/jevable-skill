/** Fixed-size process observations, never receipts, IDs, payloads or storage queries. */
export declare const TRANSACTION_KINDS: readonly ["read", "write"];
export declare const TRANSACTION_OUTCOMES: readonly ["acknowledged", "failed-before-commit", "commit-uncertain"];
export type TransactionKind = typeof TRANSACTION_KINDS[number];
export type TransactionOutcome = typeof TRANSACTION_OUTCOMES[number];
export declare const TRANSACTION_DURATION_BOUNDS: readonly number[];
export type TransactionDurationDistribution = {
    buckets: number[];
    min?: number | undefined;
    max?: number | undefined;
};
export type TransactionMetricSnapshot = {
    available: false;
} | {
    available: true;
    values: {
        kind: TransactionKind;
        outcome: TransactionOutcome;
        transactions: number;
        seconds: number;
        /** Absent for older/custom sources: never infer a distribution from count/sum. */
        duration?: TransactionDurationDistribution;
    }[];
};
export declare class TransactionStatistics {
    private available;
    private readonly values;
    invalidate(): void;
    record(kind: TransactionKind, outcome: TransactionOutcome, seconds: number): void;
    snapshot(): TransactionMetricSnapshot;
}

/** Bounded process-local native-call observations. No SQL, arguments, rows or errors retained. */
export declare const SQLITE_METHODS: readonly ["exec", "prepare", "all", "get", "run", "iterate", "iterator.next", "iterator.return"];
export declare const SQLITE_OUTCOMES: readonly ["returned", "threw"];
export declare const SQLITE_DURATION_BOUNDS: readonly number[];
export type SQLiteMethod = typeof SQLITE_METHODS[number];
export type SQLiteOutcome = typeof SQLITE_OUTCOMES[number];
export type SQLiteStatementSnapshot = {
    available: false;
} | {
    available: true;
    values: {
        method: SQLiteMethod;
        outcome: SQLiteOutcome;
        calls: number;
        seconds: number;
        duration: {
            buckets: number[];
            min?: number | undefined;
            max?: number | undefined;
        };
    }[];
};
export declare class SQLiteStatementStatistics {
    private available;
    private readonly values;
    invalidate(): void;
    record(method: SQLiteMethod, outcome: SQLiteOutcome, seconds: number): void;
    snapshot(): SQLiteStatementSnapshot;
}

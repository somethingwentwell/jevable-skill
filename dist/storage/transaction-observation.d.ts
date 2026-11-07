import type { TransactionKind, TransactionOutcome } from './transaction-statistics.ts';
/** Optional synchronous host diagnostics. No SQL, identities, parameters, values or raw errors cross this boundary. */
export interface JournalTransactionObservation {
    end(outcome: TransactionOutcome): void;
}
export type JournalTransactionObserver = (kind: TransactionKind) => JournalTransactionObservation | undefined;
export declare function beginTransactionObservation(observer: JournalTransactionObserver | undefined, kind: TransactionKind): JournalTransactionObservation | undefined;
export declare function endTransactionObservation(observation: JournalTransactionObservation | undefined, outcome: TransactionOutcome): void;

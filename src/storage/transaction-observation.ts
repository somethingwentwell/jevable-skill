import { types } from 'node:util'
import type { TransactionKind, TransactionOutcome } from './transaction-statistics.ts'

/** Optional synchronous host diagnostics. No SQL, identities, parameters, values or raw errors cross this boundary. */
export interface JournalTransactionObservation { end(outcome: TransactionOutcome): void }
export type JournalTransactionObserver = (kind: TransactionKind) => JournalTransactionObservation | undefined

function containAsyncReturn(value: unknown): boolean {
  if (!types.isPromise(value)) return false
  Promise.prototype.then.call(value, undefined, () => {})
  return true
}
export function beginTransactionObservation(observer: JournalTransactionObserver | undefined, kind: TransactionKind) {
  try {
    const observation = observer?.(kind)
    // Invalid asynchronous hooks never delay admission; contain native rejected promises,
    // including cross-realm promises, without assimilating arbitrary thenables.
    if (containAsyncReturn(observation)) return undefined
    return observation
  } catch { return undefined }
}
export function endTransactionObservation(observation: JournalTransactionObservation | undefined, outcome: TransactionOutcome) {
  try { containAsyncReturn(observation?.end(outcome)) } catch { /* Optional diagnostics cannot replace journal results/errors or retry work. */ }
}

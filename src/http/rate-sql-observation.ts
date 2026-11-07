import { types } from 'node:util'

export const HTTP_RATE_SQL_OPERATIONS = ['begin', 'lock', 'debit', 'commit', 'rollback'] as const
export type HttpRateSqlOperation = typeof HTTP_RATE_SQL_OPERATIONS[number]
export type HttpRateSqlOutcome = 'acknowledged' | 'failed' | 'uncertain'
/** Trusted synchronous diagnostics only. Never pass SQL, parameters, identities or raw errors. */
export interface HttpRateSqlObservation { end(outcome: HttpRateSqlOutcome): void }
export type HttpRateSqlObserver = (operation: HttpRateSqlOperation) => HttpRateSqlObservation | undefined

function containPromise(value: unknown) {
  if (!types.isPromise(value)) return false
  Promise.prototype.then.call(value, undefined, () => {})
  return true
}
export function beginHttpRateSqlObservation(observer: HttpRateSqlObserver | undefined, operation: HttpRateSqlOperation) {
  try { const observation = observer?.(operation); return containPromise(observation) ? undefined : observation }
  catch { return undefined }
}
export function endHttpRateSqlObservation(observation: HttpRateSqlObservation | undefined, outcome: HttpRateSqlOutcome) {
  try { containPromise(observation?.end(outcome)) } catch { /* Preserve original SQL result/error; no retry or refund. */ }
}

/** Fixed-size process observations, never receipts, IDs, payloads or storage queries. */
export const TRANSACTION_KINDS = ['read', 'write'] as const
export const TRANSACTION_OUTCOMES = ['acknowledged', 'failed-before-commit', 'commit-uncertain'] as const
export type TransactionKind = typeof TRANSACTION_KINDS[number]
export type TransactionOutcome = typeof TRANSACTION_OUTCOMES[number]
export const TRANSACTION_DURATION_BOUNDS = Object.freeze([0.001, 0.01, 0.1, 0.5, 1, 5, 10, 30, 60, 300, 3600])
export type TransactionDurationDistribution = { buckets: number[]; min?: number | undefined; max?: number | undefined }
export type TransactionMetricSnapshot = { available: false } | { available: true; values: {
  kind: TransactionKind; outcome: TransactionOutcome; transactions: number; seconds: number
  /** Absent for older/custom sources: never infer a distribution from count/sum. */
  duration?: TransactionDurationDistribution
}[] }

export class TransactionStatistics {
  private available = true
  private readonly values = TRANSACTION_KINDS.flatMap(kind => TRANSACTION_OUTCOMES.map(outcome => ({ kind, outcome,
    transactions: 0, seconds: 0, duration: { buckets: Array<number>(TRANSACTION_DURATION_BOUNDS.length + 1).fill(0),
      min: undefined as number | undefined, max: undefined as number | undefined } })))
  invalidate() { this.available = false }
  record(kind: TransactionKind, outcome: TransactionOutcome, seconds: number) {
    if (!this.available) return
    const value = this.values.find(value => value.kind === kind && value.outcome === outcome)
    if (!value || !Number.isFinite(seconds) || seconds < 0 || value.transactions >= Number.MAX_SAFE_INTEGER
      || !Number.isFinite(value.seconds + seconds)) { this.invalidate(); return }
    value.transactions++; value.seconds += seconds
    const bucket = TRANSACTION_DURATION_BOUNDS.findIndex(bound => seconds <= bound)
    value.duration.buckets[bucket === -1 ? TRANSACTION_DURATION_BOUNDS.length : bucket]!++
    value.duration.min = value.duration.min === undefined ? seconds : Math.min(value.duration.min, seconds)
    value.duration.max = value.duration.max === undefined ? seconds : Math.max(value.duration.max, seconds)
  }
  snapshot(): TransactionMetricSnapshot { return this.available ? { available: true,
    values: this.values.map(value => ({ ...value, duration: { ...value.duration, buckets: [...value.duration.buckets] } })) } : { available: false } }
}

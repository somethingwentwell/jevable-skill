import { ValueType, type Meter } from '@opentelemetry/api'
import { AggregationTemporality, DataPointType, type ResourceMetrics } from '@opentelemetry/sdk-metrics'
import { TRANSACTION_DURATION_BOUNDS, TRANSACTION_KINDS, TRANSACTION_OUTCOMES, type TransactionMetricSnapshot } from '../storage/transaction-statistics.ts'

export type StorageTransactionMetricSource = () => TransactionMetricSnapshot
export const STORAGE_TRANSACTION_LABELS = ['jevable.storage.transaction.kind', 'jevable.storage.transaction.outcome']
type Values = Extract<TransactionMetricSnapshot, { available: true }>['values']
const bucketIndex = (seconds: number) => {
  const index = TRANSACTION_DURATION_BOUNDS.findIndex(bound => seconds <= bound)
  return index < 0 ? TRANSACTION_DURATION_BOUNDS.length : index
}
function validDistribution(value: Values[number]) {
  const d = value.duration
  if (!d) return true
  if (d.buckets.length !== TRANSACTION_DURATION_BOUNDS.length + 1
    || !d.buckets.every(n => Number.isSafeInteger(n) && n >= 0)
    || d.buckets.reduce((a, b) => a + b, 0) !== value.transactions) return false
  if (value.transactions === 0) return d.min === undefined && d.max === undefined
  const mean = value.seconds / value.transactions
  // Cumulative floating-point addition can drift; bound its relative error by
  // the number of additions instead of rejecting ordinary repeated samples.
  const tolerance = Math.max(mean, d.max ?? 0) * Math.min(1, value.transactions * Number.EPSILON)
  return typeof d.min === 'number' && Number.isFinite(d.min) && d.min >= 0
    && typeof d.max === 'number' && Number.isFinite(d.max) && d.max >= d.min
    && value.seconds >= d.max && mean >= d.min - tolerance && mean <= d.max + tolerance
    && d.buckets.findIndex(n => n > 0) === bucketIndex(d.min)
    && d.buckets.findLastIndex(n => n > 0) === bucketIndex(d.max)
}

export function omitUnavailableStorageTransactionMetrics(resource: ResourceMetrics) {
  for (const scope of resource.scopeMetrics) {
    const available = scope.metrics.find(metric => metric.descriptor.name === 'jevable.storage.journal.available')
    if (available?.dataPointType === DataPointType.GAUGE && available.dataPoints.some(point => point.value === 0))
      scope.metrics = scope.metrics.filter(metric => !metric.descriptor.name.startsWith('jevable.storage.journal.') || metric === available)
  }
}

export function installStorageTransactionMetrics(meter: Meter, read: StorageTransactionMetricSource) {
  let collected: Values | undefined
  const available = meter.createObservableGauge('jevable.storage.journal.available', { unit: '1',
    description: 'One when process-local PostgreSQL journal transaction observations are known; not database health or ownership' })
  const transactions = meter.createObservableCounter('jevable.storage.journal.transactions', { unit: '{transaction}',
    description: 'Ended transaction-path observations since enabled, including failed BEGIN, reads and retained-batch retries; not unique mutations or workflow successes' })
  const duration = meter.createObservableCounter('jevable.storage.journal.duration', { unit: 's',
    description: 'Cumulative active transaction seconds including SQL/lock/commit or rollback wait, excluding the local queue; not a latency histogram or commit durability proof' })
  meter.addBatchObservableCallback(result => {
    collected = undefined
    let state: TransactionMetricSnapshot = { available: false }
    try {
      const source = read()
      if (source.available === true && source.values.length === 6) {
        const values = source.values.map(value => ({ kind: value.kind, outcome: value.outcome,
          transactions: value.transactions, seconds: value.seconds, ...(value.duration === undefined ? {} : {
            duration: { buckets: [...value.duration.buckets], min: value.duration.min, max: value.duration.max } }) }))
        if (values.every(value => TRANSACTION_KINDS.includes(value.kind) && TRANSACTION_OUTCOMES.includes(value.outcome)
          && Number.isSafeInteger(value.transactions) && value.transactions >= 0 && Number.isFinite(value.seconds) && value.seconds >= 0
          && (value.transactions !== 0 || value.seconds === 0) && validDistribution(value))
          && new Set(values.map(value => `${value.kind}/${value.outcome}`)).size === 6
          && (values.every(value => value.duration === undefined) || values.every(value => value.duration !== undefined)))
          state = { available: true, values }
      }
    } catch { /* A failed diagnostic source is unknown, never a workflow failure or arbitrary error label. */ }
    result.observe(available, Number(state.available))
    if (!state.available) return
    collected = state.values
    for (const value of state.values) {
      const attributes = { 'jevable.storage.transaction.kind': value.kind, 'jevable.storage.transaction.outcome': value.outcome }
      result.observe(transactions, value.transactions, attributes); result.observe(duration, value.seconds, attributes)
    }
  }, [available, transactions, duration])
  // The journal already owns bounded cumulative aggregates. Do not replay samples
  // into a synchronous SDK histogram or approximate a distribution from a sum.
  // Enrich the same collection, using the observable counter's SDK timestamps.
  return (resource: ResourceMetrics) => {
    const values = collected
    if (!values?.every(value => value.duration !== undefined)) return
    for (const scope of resource.scopeMetrics) {
      const counts = scope.metrics.find(metric => metric.descriptor.name === 'jevable.storage.journal.transactions')
      const seconds = scope.metrics.find(metric => metric.descriptor.name === 'jevable.storage.journal.duration')
      if (counts?.dataPointType !== DataPointType.SUM || counts.dataPoints.length !== 6
        || seconds?.dataPointType !== DataPointType.SUM || seconds.dataPoints.length !== 6) continue
      scope.metrics.push({ descriptor: { name: 'jevable.storage.journal.transaction.duration', unit: 's', valueType: ValueType.DOUBLE,
        description: 'Cumulative ended active transaction-path duration distribution; includes SQL/lock/commit or rollback wait, excludes local queue; not durability or business success' },
        aggregationTemporality: AggregationTemporality.CUMULATIVE, dataPointType: DataPointType.HISTOGRAM,
        dataPoints: counts.dataPoints.map(point => {
          const value = values.find(value => value.kind === point.attributes['jevable.storage.transaction.kind']
            && value.outcome === point.attributes['jevable.storage.transaction.outcome'])!
          const total = seconds.dataPoints.find(p => p.attributes['jevable.storage.transaction.kind'] === value.kind
            && p.attributes['jevable.storage.transaction.outcome'] === value.outcome)!
          return { startTime: point.startTime, endTime: point.endTime, attributes: point.attributes,
            // Observable-counter re-aggregation can round by an ULP. Share its
            // serialized total; the distribution itself is never re-aggregated.
            value: { count: value.transactions, sum: total.value,
              ...(value.duration!.min === undefined ? {} : { min: value.duration!.min }),
              ...(value.duration!.max === undefined ? {} : { max: value.duration!.max }),
              buckets: { boundaries: [...TRANSACTION_DURATION_BOUNDS], counts: [...value.duration!.buckets] } } }
        }) })
    }
  }
}

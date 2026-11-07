import { ValueType, type Meter } from '@opentelemetry/api'
import { AggregationTemporality, DataPointType, type ResourceMetrics } from '@opentelemetry/sdk-metrics'
import { SQLITE_METHODS, SQLITE_OUTCOMES, SQLITE_DURATION_BOUNDS, type SQLiteStatementSnapshot } from '../storage/sqlite-statistics.ts'

export type SQLiteStatementMetricSource = () => SQLiteStatementSnapshot
export const SQLITE_STATEMENT_LABELS = ['jevable.sqlite.method', 'jevable.sqlite.outcome']
type Values = Extract<SQLiteStatementSnapshot, { available: true }>['values']
const bucket = (seconds: number) => {
  const index = SQLITE_DURATION_BOUNDS.findIndex(bound => seconds <= bound)
  return index < 0 ? SQLITE_DURATION_BOUNDS.length : index
}
function valid(value: Values[number]) {
  const d = value.duration
  if (!SQLITE_METHODS.includes(value.method) || !SQLITE_OUTCOMES.includes(value.outcome)
    || !Number.isSafeInteger(value.calls) || value.calls < 0 || !Number.isFinite(value.seconds) || value.seconds < 0
    || !d || d.buckets.length !== SQLITE_DURATION_BOUNDS.length + 1
    || !d.buckets.every(n => Number.isSafeInteger(n) && n >= 0) || d.buckets.reduce((a, b) => a + b, 0) !== value.calls) return false
  if (value.calls === 0) return value.seconds === 0 && d.min === undefined && d.max === undefined
  const mean = value.seconds / value.calls
  const tolerance = Math.max(mean, d.max ?? 0) * Math.min(1, value.calls * Number.EPSILON)
  return typeof d.min === 'number' && Number.isFinite(d.min) && d.min >= 0
    && typeof d.max === 'number' && Number.isFinite(d.max) && d.max >= d.min && value.seconds >= d.max
    && mean >= d.min - tolerance && mean <= d.max + tolerance
    && d.buckets.findIndex(n => n > 0) === bucket(d.min) && d.buckets.findLastIndex(n => n > 0) === bucket(d.max)
}
export function omitUnavailableSQLiteStatementMetrics(resource: ResourceMetrics) {
  for (const scope of resource.scopeMetrics) {
    const available = scope.metrics.find(metric => metric.descriptor.name === 'jevable.storage.sqlite.available')
    if (available?.dataPointType === DataPointType.GAUGE && available.dataPoints.some(point => point.value === 0))
      scope.metrics = scope.metrics.filter(metric => !metric.descriptor.name.startsWith('jevable.storage.sqlite.') || metric === available)
  }
}
export function installSQLiteStatementMetrics(meter: Meter, read: SQLiteStatementMetricSource) {
  let collected: Values | undefined
  const available = meter.createObservableGauge('jevable.storage.sqlite.available', { unit: '1',
    description: 'One when this process supplies known owned SQLite native-call observations; not database health or commit durability' })
  const calls = meter.createObservableCounter('jevable.storage.sqlite.calls', { unit: '{call}',
    description: 'Ended owned exec/prepare/statement/iterator method calls; returned is not committed, and iterator.next includes completion probes' })
  const seconds = meter.createObservableCounter('jevable.storage.sqlite.seconds', { unit: 's',
    description: 'Cumulative synchronous native method time, excluding application work between iterator steps; not transaction latency' })
  meter.addBatchObservableCallback(result => {
    collected = undefined
    let state: SQLiteStatementSnapshot = { available: false }
    try {
      const source = read()
      if (source.available === true && source.values.length === SQLITE_METHODS.length * SQLITE_OUTCOMES.length) {
        const values = source.values.map(value => ({ method: value.method, outcome: value.outcome,
          calls: value.calls, seconds: value.seconds, duration: { buckets: [...value.duration.buckets], min: value.duration.min, max: value.duration.max } }))
        if (values.every(valid) && new Set(values.map(v => `${v.method}/${v.outcome}`)).size === 16) state = { available: true, values }
      }
    } catch { /* A diagnostic failure is unavailable, never SQL text or an execution failure. */ }
    result.observe(available, Number(state.available))
    if (!state.available) return
    collected = state.values
    for (const value of state.values) {
      const attributes = { 'jevable.sqlite.method': value.method, 'jevable.sqlite.outcome': value.outcome }
      result.observe(calls, value.calls, attributes); result.observe(seconds, value.seconds, attributes)
    }
  }, [available, calls, seconds])
  // The source owns fixed cumulative buckets. Enrich one collected snapshot;
  // never replay samples into a synchronous SDK histogram or infer buckets from sums.
  return (resource: ResourceMetrics) => {
    const values = collected
    if (!values) return
    for (const scope of resource.scopeMetrics) {
      const counts = scope.metrics.find(metric => metric.descriptor.name === 'jevable.storage.sqlite.calls')
      const durations = scope.metrics.find(metric => metric.descriptor.name === 'jevable.storage.sqlite.seconds')
      if (counts?.dataPointType !== DataPointType.SUM || counts.dataPoints.length !== 16
        || durations?.dataPointType !== DataPointType.SUM || durations.dataPoints.length !== 16) continue
      scope.metrics.push({ descriptor: { name: 'jevable.storage.sqlite.duration', unit: 's', valueType: ValueType.DOUBLE,
        description: 'Cumulative synchronous native-call duration distribution, not SQL statement count, transaction durability or business success' },
        aggregationTemporality: AggregationTemporality.CUMULATIVE, dataPointType: DataPointType.HISTOGRAM,
        dataPoints: counts.dataPoints.map(point => {
          const value = values.find(v => v.method === point.attributes['jevable.sqlite.method'] && v.outcome === point.attributes['jevable.sqlite.outcome'])!
          const total = durations.dataPoints.find(p => p.attributes['jevable.sqlite.method'] === value.method && p.attributes['jevable.sqlite.outcome'] === value.outcome)!
          return { startTime: point.startTime, endTime: point.endTime, attributes: point.attributes,
            value: { count: value.calls, sum: total.value,
              ...(value.duration.min === undefined ? {} : { min: value.duration.min }),
              ...(value.duration.max === undefined ? {} : { max: value.duration.max }),
              buckets: { boundaries: [...SQLITE_DURATION_BOUNDS], counts: [...value.duration.buckets] } } }
        }) })
    }
  }
}

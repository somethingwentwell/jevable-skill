import { afterEach, describe, expect, it, vi } from 'vitest'
import { JsonMetricsSerializer, ProtobufMetricsSerializer } from '@opentelemetry/otlp-transformer'
import { TRANSACTION_DURATION_BOUNDS, TransactionStatistics } from '../src/storage/transaction-statistics.ts'
import { RuntimeTelemetry } from '../src/telemetry/traces.ts'
import { parseTelemetryConfig } from '../src/telemetry/config.ts'
import { PostgresJournal } from '../src/storage/postgres.ts'
import { PostgresRuntime } from '../src/runtime/postgres.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const config = { metricsEndpoint: 'http://127.0.0.1:4318/v1/metrics', storageTransactionMetrics: true,
  authentication: { kind: 'none' as const }, intervalMs: 60000, timeoutMs: 100, flushTimeoutMs: 300 }
const numeric = (point: any) => Number(point.asInt ?? point.asDouble)
function receiver(fail = false) {
  const batches: any[] = [], original = ProtobufMetricsSerializer.serializeRequest
  vi.spyOn(ProtobufMetricsSerializer, 'serializeRequest').mockImplementation(value => {
    batches.push(JSON.parse(Buffer.from(JsonMetricsSerializer.serializeRequest(value)!).toString())); return original(value)
  })
  const send = vi.fn(async () => { if (fail) throw Error('PRIVATE_COLLECTOR_ERROR'); return new Response(null) }); vi.stubGlobal('fetch', send)
  const metrics = () => batches.at(-1).resourceMetrics.flatMap((r: any) => r.scopeMetrics.flatMap((s: any) => s.metrics))
  const points = (name: string) => { const m = metrics().find((m: any) => m.name === name); return (m?.sum ?? m?.gauge)?.dataPoints ?? [] }
  return { batches, send, metrics, points, available: () => numeric(points('jevable.storage.journal.available')[0]) }
}

describe('fixed journal statistics', () => {
  it('retains six numeric groups and detached cumulative snapshots only', () => {
    const source = new TransactionStatistics(); source.record('write', 'acknowledged', 0.25); source.record('write', 'acknowledged', 0.5)
    const state = source.snapshot(); expect(state.available).toBe(true)
    if (!state.available) throw Error('unavailable')
    expect(state.values).toHaveLength(6); expect(state.values.find(v => v.kind === 'write' && v.outcome === 'acknowledged')).toMatchObject({ transactions: 2, seconds: 0.75 })
    state.values[0]!.transactions = 900; state.values[3]!.duration!.buckets[0] = 900
    expect(source.snapshot()).not.toEqual(state)
  })
  it.each([-1, NaN, Infinity])('invalid clock observation %s becomes unknown, never a false zero', seconds => {
    const source = new TransactionStatistics(); source.record('read', 'acknowledged', seconds)
    expect(source.snapshot()).toEqual({ available: false }); source.record('read', 'acknowledged', 1)
    expect(source.snapshot()).toEqual({ available: false })
  })
  it('count or cumulative-time overflow becomes unknown with fixed-size state', () => {
    const count = new TransactionStatistics(); (count as any).values[0].transactions = Number.MAX_SAFE_INTEGER
    count.record('read', 'acknowledged', 0); expect(count.snapshot()).toEqual({ available: false })
    const time = new TransactionStatistics(); time.record('write', 'acknowledged', 1e308); time.record('write', 'acknowledged', 1e308)
    expect(time.snapshot()).toEqual({ available: false })
    const kind = new TransactionStatistics(); kind.record('PRIVATE_KIND' as never, 'acknowledged', 1)
    expect(kind.snapshot()).toEqual({ available: false })
  })
  it('uses inclusive upper bounds and a final overflow bucket without retaining observations', () => {
    const source = new TransactionStatistics(), samples = [0, ...TRANSACTION_DURATION_BOUNDS, 3601]
    for (const seconds of samples) source.record('write', 'commit-uncertain', seconds)
    const state = source.snapshot(); if (!state.available) throw Error('unavailable')
    const value = state.values.find(v => v.kind === 'write' && v.outcome === 'commit-uncertain')!
    expect(value.transactions).toBe(13); expect(value.duration).toEqual({ buckets: [2, ...Array(11).fill(1)], min: 0, max: 3601 })
    expect(value.seconds).toBe(samples.reduce((a, b) => a + b, 0))
    for (const item of state.values.filter(v => v !== value)) expect(item.duration).toEqual({ buckets: Array(12).fill(0), min: undefined, max: undefined })
    expect(new TransactionStatistics().snapshot()).not.toEqual(state)
    expect(Object.isFrozen(TRANSACTION_DURATION_BOUNDS)).toBe(true)
  })
})

describe('opt-in journal transaction metrics', () => {
  it('requires a metrics destination and advertises a boolean opt-in in input discovery', async () => {
    expect(parseTelemetryConfig({ ...config, storageTransactionMetrics: undefined }).storageTransactionMetrics).toBe(false)
    expect(() => parseTelemetryConfig({ ...config, metricsEndpoint: undefined, endpoint: config.metricsEndpoint })).toThrow('invalid-command')
    expect(() => parseTelemetryConfig({ ...config, storageTransactionMetrics: 'true' })).toThrow('invalid-command')
    const { showSchema } = await import('../src/contracts.ts')
    expect((showSchema('telemetry-config').schema as any).properties.storageTransactionMetrics).toMatchObject({ type: 'boolean', default: false })
  })
  it.each([0, 1])('exports six bounded cumulative groups independent of trace sampling %s', async sampleRatio => {
    const wire = receiver(), source = new TransactionStatistics(); source.record('write', 'commit-uncertain', 0.125)
    const telemetry = new RuntimeTelemetry({ ...config, sampleRatio }, () => undefined, { storage: 'postgres', storageTransactions: () => source.snapshot() })
    cleanup.push(() => telemetry.close()); await telemetry.flush(); await telemetry.flush()
    expect(wire.send).toHaveBeenCalledTimes(2); expect(wire.metrics()).toHaveLength(4); expect(wire.available()).toBe(1)
    const counts = wire.points('jevable.storage.journal.transactions'), durations = wire.points('jevable.storage.journal.duration')
    expect(counts).toHaveLength(6); expect(durations).toHaveLength(6)
    expect(counts.map(numeric).reduce((a: number, b: number) => a + b, 0)).toBe(1)
    expect(durations.map(numeric).reduce((a: number, b: number) => a + b, 0)).toBe(0.125)
    for (const point of [...counts, ...durations]) expect(point.attributes.map((a: any) => a.key).sort()).toEqual(['jevable.storage.transaction.kind', 'jevable.storage.transaction.outcome'])
    for (const m of wire.metrics().filter((m: any) => m.sum)) expect(m.sum).toMatchObject({ aggregationTemporality: 2, isMonotonic: true })
    const histogram = wire.metrics().find((m: any) => m.name === 'jevable.storage.journal.transaction.duration').histogram
    expect(histogram.aggregationTemporality).toBe(2); expect(histogram.dataPoints).toHaveLength(6)
    const point = histogram.dataPoints.find((p: any) => Number(p.count) > 0)
    expect(point).toMatchObject({ count: 1, sum: 0.125, min: 0.125, max: 0.125,
      explicitBounds: [...TRANSACTION_DURATION_BOUNDS], bucketCounts: [0,0,0,1,0,0,0,0,0,0,0,0] })
    expect(point.attributes.map((a: any) => a.key).sort()).toEqual(['jevable.storage.transaction.kind', 'jevable.storage.transaction.outcome'])
    expect(histogram.dataPoints.reduce((sum: number, p: any) => sum + Number(p.count), 0)).toBe(1)
    for (const p of histogram.dataPoints.filter((p: any) => Number(p.count) === 0)) {
      expect(p.min).toBeUndefined(); expect(p.max).toBeUndefined(); expect(p.sum).toBe(0)
    }
    expect(telemetry.status()).toMatchObject({ storageTransactionMetrics: true, signals: ['metrics'] })
  })
  it('collects nothing without opt-in and reports unsupported sources unknown', async () => {
    const wire = receiver(), read = vi.fn(() => new TransactionStatistics().snapshot())
    const disabled = new RuntimeTelemetry({ ...config, storageTransactionMetrics: false }, () => undefined, { storageTransactions: read })
    cleanup.push(() => disabled.close()); await disabled.flush(); expect(read).not.toHaveBeenCalled(); expect(wire.send).not.toHaveBeenCalled()
    const unsupported = new RuntimeTelemetry(config, () => undefined, { storage: 'sqlite' })
    cleanup.push(() => unsupported.close()); await unsupported.flush(); expect(wire.available()).toBe(0); expect(wire.metrics()).toHaveLength(1)
  })
  it.each(['throw', 'missing', 'duplicate', 'foreign', 'negative', 'fractional', 'nonfinite', 'empty-duration', 'getter'])(
    'invalid %s source suppresses stale totals without exporting source details', async cause => {
      const wire = receiver(), stats = new TransactionStatistics(); stats.record('read', 'acknowledged', 0.5)
      let source: any = stats.snapshot()
      const telemetry = new RuntimeTelemetry(config, () => undefined, { storageTransactions: () => { if (source === 'throw') throw Error('PRIVATE_ERROR'); return source } })
      cleanup.push(() => telemetry.close()); await telemetry.flush(); expect(wire.available()).toBe(1)
      if (cause === 'throw') source = 'throw'
      if (cause === 'missing') source = { available: false }
      if (cause === 'duplicate') source.values[1] = source.values[0]
      if (cause === 'foreign') source.values[0].kind = 'PRIVATE_ID'
      if (cause === 'negative') source.values[0].transactions = -1
      if (cause === 'fractional') source.values[0].transactions = 0.5
      if (cause === 'nonfinite') source.values[0].seconds = Infinity
      if (cause === 'empty-duration') source.values[1].seconds = 1
      if (cause === 'getter') Object.defineProperty(source, 'values', { get() { throw Error('PRIVATE_GETTER') } })
      await telemetry.flush(); expect(wire.available()).toBe(0); expect(wire.metrics()).toHaveLength(1)
      expect(JSON.stringify(wire.batches)).not.toContain('PRIVATE_')
    })
  it('Collector failure never modifies, replays or resets the journal observations', async () => {
    const wire = receiver(true), stats = new TransactionStatistics(); stats.record('write', 'acknowledged', 0.125)
    const before = stats.snapshot(), telemetry = new RuntimeTelemetry(config, () => undefined, { storageTransactions: () => stats.snapshot() })
    cleanup.push(() => telemetry.close()); await telemetry.flush(); await telemetry.flush()
    expect(stats.snapshot()).toEqual(before); expect(wire.send).toHaveBeenCalledTimes(2)
    expect(telemetry.status()).toMatchObject({ metrics: { failedBatches: 2, dropped: 38 } })
  })
  it('collects the distribution once with the counters and never redistributes a cumulative average', async () => {
    const wire = receiver(), stats = new TransactionStatistics(); stats.record('read', 'acknowledged', 0); stats.record('read', 'acknowledged', 3601)
    const read = vi.fn(() => stats.snapshot()), telemetry = new RuntimeTelemetry(config, () => undefined, { storageTransactions: read })
    cleanup.push(() => telemetry.close()); await telemetry.flush(); expect(read).toHaveBeenCalledTimes(1)
    const first = wire.metrics().find((m: any) => m.histogram).histogram.dataPoints
    await telemetry.flush(); expect(read).toHaveBeenCalledTimes(2)
    const second = wire.metrics().find((m: any) => m.histogram).histogram.dataPoints
    expect(second.map((p: any) => p.bucketCounts)).toEqual(first.map((p: any) => p.bucketCounts))
    const populated = second.find((p: any) => Number(p.count) > 0)
    expect(populated.bucketCounts).toEqual([1, ...Array(10).fill(0), 1])
    expect(populated).toMatchObject({ count: 2, sum: 3601, min: 0, max: 3601 })
    for (const point of second) {
      const count = wire.points('jevable.storage.journal.transactions').find((p: any) => JSON.stringify(p.attributes) === JSON.stringify(point.attributes))
      expect(point.startTimeUnixNano).toEqual(count.startTimeUnixNano); expect(point.timeUnixNano).toEqual(count.timeUnixNano)
    }
  })
  it('supports old/custom counter-only snapshots without inventing a distribution or caching an earlier one', async () => {
    const wire = receiver(), stats = new TransactionStatistics(); stats.record('read', 'acknowledged', 1)
    let state = stats.snapshot()
    const telemetry = new RuntimeTelemetry(config, () => undefined, { storageTransactions: () => state }); cleanup.push(() => telemetry.close())
    await telemetry.flush(); expect(wire.metrics().some((m: any) => m.histogram)).toBe(true)
    if (!state.available) throw Error('unavailable')
    state = { available: true, values: state.values.map(({ duration: _duration, ...value }) => value) }
    await telemetry.flush(); expect(wire.available()).toBe(1); expect(wire.metrics()).toHaveLength(3)
    expect(wire.metrics().some((m: any) => m.histogram)).toBe(false)
  })
  it('joins the SDK counter sum exactly after its cumulative delta re-aggregation rounds by one ULP', async () => {
    const wire = receiver(), stats = new TransactionStatistics(); stats.record('read', 'acknowledged', 0.000049)
    let state = stats.snapshot()
    const telemetry = new RuntimeTelemetry(config, () => undefined, { storageTransactions: () => state }); cleanup.push(() => telemetry.close())
    await telemetry.flush(); stats.record('read', 'acknowledged', 0.006326583000000029 - 0.000049)
    state = stats.snapshot(); if (!state.available) throw Error('unavailable')
    // Model the exact pre-aggregated source sum from the real received SQL
    // regression; deriving it via this two-sample addition rounds it first.
    state.values[0]!.seconds = 0.006326583000000029; await telemetry.flush()
    const raw = state.values[0]!.seconds, total = wire.points('jevable.storage.journal.duration').find((p: any) => numeric(p) > 0)
    expect(numeric(total)).not.toBe(raw)
    const histogram = wire.metrics().find((m: any) => m.histogram).histogram.dataPoints.find((p: any) => p.count > 0)
    expect(histogram.sum).toBe(numeric(total)); expect(histogram.count).toBe(2)
    expect(histogram.bucketCounts.reduce((a: number, b: number) => a + b, 0)).toBe(2)
  })
  it.each(['partial', 'short', 'negative', 'fractional', 'infinite', 'wrong-count', 'bad-min', 'bad-max', 'wrong-range', 'empty-min', 'impossible-sum', 'getter'])(
    'invalid %s distribution suppresses the same entire observation, never stale histograms', async cause => {
      const wire = receiver(), stats = new TransactionStatistics(); stats.record('read', 'acknowledged', 1)
      const state = stats.snapshot(); if (!state.available) throw Error('unavailable')
      const telemetry = new RuntimeTelemetry(config, () => undefined, { storageTransactions: () => state }); cleanup.push(() => telemetry.close())
      await telemetry.flush(); expect(wire.metrics()).toHaveLength(4)
      const value = state.values[0]!, d = value.duration!
      if (cause === 'partial') delete state.values[1]!.duration
      if (cause === 'short') d.buckets.pop()
      if (cause === 'negative') d.buckets[0] = -1
      if (cause === 'fractional') d.buckets[0] = 0.5
      if (cause === 'infinite') d.buckets[0] = Infinity
      if (cause === 'wrong-count') d.buckets[0] = 1
      if (cause === 'bad-min') d.min = NaN
      if (cause === 'bad-max') d.max = 0
      if (cause === 'wrong-range') { d.buckets[4] = 0; d.buckets[0] = 1 }
      if (cause === 'empty-min') state.values[1]!.duration!.min = 0
      if (cause === 'impossible-sum') value.seconds = 2
      if (cause === 'getter') Object.defineProperty(d, 'buckets', { get() { throw Error('PRIVATE_BUCKET') } })
      await telemetry.flush(); expect(wire.available()).toBe(0); expect(wire.metrics()).toHaveLength(1)
      expect(JSON.stringify(wire.batches)).not.toContain('PRIVATE_')
    })
  it('does not invalidate a legitimate repeated floating-point population', async () => {
    const wire = receiver(), stats = new TransactionStatistics()
    for (let i = 0; i < 100000; i++) stats.record('write', 'acknowledged', 0.1)
    const telemetry = new RuntimeTelemetry(config, () => undefined, { storageTransactions: () => stats.snapshot() }); cleanup.push(() => telemetry.close())
    await telemetry.flush(); expect(wire.available()).toBe(1)
    const point = wire.metrics().find((m: any) => m.histogram).histogram.dataPoints.find((p: any) => p.count > 0)
    expect(point.count).toBe(100000); expect(point.bucketCounts[2]).toBe(100000); expect(point.min).toBe(0.1); expect(point.max).toBe(0.1)
  })
  it.each([false, true])('wires the PostgreSQL owned source only when enabled (%s), without collection SQL', async enabled => {
    // Runtime wiring against a journal double, not real PostgreSQL/received-wire qualification.
    const wire = receiver(), stats = new TransactionStatistics(), controller = new AbortController()
    const journal = { signal: controller.signal, records: vi.fn(async () => []), count: vi.fn(async () => 0),
      events: vi.fn(async () => ({ events: [], cursor: '0' })), page: vi.fn(async () => ({ records: [], nextCursor: null })),
      enableTransactionMetrics: vi.fn(), transactionMetrics: vi.fn(() => stats.snapshot()), close: vi.fn(async () => {}) } as unknown as PostgresJournal
    vi.spyOn(PostgresJournal, 'open').mockResolvedValue(journal)
    const runtime = await PostgresRuntime.open({ database: { host: '127.0.0.1', port: 5432, database: 'fixture', user: 'fixture',
      password: 'PRIVATE_PASSWORD', namespace: 'fixture', initialize: false, tls: { mode: 'loopback-test' } },
      telemetry: { ...config, storageTransactionMetrics: enabled } }); cleanup.push(() => runtime.close())
    expect(journal.enableTransactionMetrics).toHaveBeenCalledTimes(enabled ? 1 : 0)
    vi.mocked(journal.records).mockClear(); vi.mocked(journal.page).mockClear()
    stats.record('write', 'commit-uncertain', 0.5); await runtime.telemetryFlush()
    expect(journal.transactionMetrics).toHaveBeenCalledTimes(enabled ? 1 : 0)
    expect(journal.records).not.toHaveBeenCalled(); expect(journal.page).not.toHaveBeenCalled()
    if (enabled) { expect(wire.available()).toBe(1); expect(wire.points('jevable.storage.journal.transactions').map(numeric).reduce((a: number, b: number) => a + b, 0)).toBe(1) }
    else expect(wire.send).not.toHaveBeenCalled()
    expect(JSON.stringify(wire.batches)).not.toContain('PRIVATE_PASSWORD')
  })
})

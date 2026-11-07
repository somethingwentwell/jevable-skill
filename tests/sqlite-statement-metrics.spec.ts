import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { JsonMetricsSerializer, ProtobufMetricsSerializer } from '@opentelemetry/otlp-transformer'
import { SQLiteStatementStatistics, SQLITE_DURATION_BOUNDS, type SQLiteMethod } from '../src/storage/sqlite-statistics.ts'
import { observeSQLiteDatabase } from '../src/storage/sqlite-observation.ts'
import { RuntimeTelemetry } from '../src/telemetry/traces.ts'
import { parseTelemetryConfig } from '../src/telemetry/config.ts'
import { LocalRuntime } from '../src/runtime/local.ts'

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const config = { metricsEndpoint: 'http://127.0.0.1:4318/v1/metrics', sqliteStatementMetrics: true,
  authentication: { kind: 'none' as const }, intervalMs: 60000, timeoutMs: 100, flushTimeoutMs: 300 }
const numeric = (p: any) => Number(p.asInt ?? p.asDouble)
function group(stats: SQLiteStatementStatistics, method: SQLiteMethod, outcome = 'returned') {
  const state = stats.snapshot(); if (!state.available) throw Error('unavailable')
  return state.values.find(v => v.method === method && v.outcome === outcome)!
}
function receiver(fail = false) {
  const batches: any[] = [], original = ProtobufMetricsSerializer.serializeRequest
  vi.spyOn(ProtobufMetricsSerializer, 'serializeRequest').mockImplementation(value => {
    batches.push(JSON.parse(Buffer.from(JsonMetricsSerializer.serializeRequest(value)!).toString())); return original(value)
  })
  const send = vi.fn(async () => { if (fail) throw Error('PRIVATE_COLLECTOR'); return new Response(null) }); vi.stubGlobal('fetch', send)
  const metrics = () => batches.at(-1).resourceMetrics.flatMap((r: any) => r.scopeMetrics.flatMap((s: any) => s.metrics))
  const points = (name: string) => { const m = metrics().find((m: any) => m.name === name); return (m?.sum ?? m?.gauge)?.dataPoints ?? [] }
  return { batches, send, metrics, points, available: () => numeric(points('jevable.storage.sqlite.available')[0]) }
}

describe('owned SQLite observations', () => {
  it('preserves real native binding, rows, setters, failures and rollback without claiming commits', () => {
    const native = new DatabaseSync(':memory:'), stats = new SQLiteStatementStatistics()
    cleanup.push(() => native.close()); const exec = DatabaseSync.prototype.exec
    const db = observeSQLiteDatabase(native, stats)
    db.exec('CREATE TABLE private_table (id INTEGER PRIMARY KEY, value TEXT); BEGIN')
    const insert = db.prepare('INSERT INTO private_table VALUES (?, ?)')
    expect(insert.run(1, 'PRIVATE_VALUE')).toMatchObject({ changes: 1 })
    expect(() => insert.run(1, 'PRIVATE_DUPLICATE')).toThrow()
    db.exec('ROLLBACK')
    expect(db.prepare('SELECT * FROM private_table').all()).toEqual([])
    const query = db.prepare('SELECT $id AS id'); query.setReadBigInts(true)
    expect(query.get({ id: 42n })).toMatchObject({ id: 42n })
    expect(() => db.prepare('PRIVATE_INVALID SQL')).toThrow()
    expect(group(stats, 'run').calls).toBe(1); expect(group(stats, 'run', 'threw').calls).toBe(1)
    expect(group(stats, 'prepare', 'threw').calls).toBe(1)
    expect(DatabaseSync.prototype.exec).toBe(exec)
    expect(JSON.stringify(stats.snapshot())).not.toContain('PRIVATE_')
    const separate = new DatabaseSync(':memory:'); separate.exec('SELECT 1'); separate.close()
    expect(group(stats, 'exec').calls).toBe(2)
  })
  it('times each lazy iterator call, including completion and early return, not application gaps', () => {
    const native = new DatabaseSync(':memory:'), stats = new SQLiteStatementStatistics(); cleanup.push(() => native.close())
    let now = 0; const db = observeSQLiteDatabase(native, stats, () => { now += 1; return now })
    const iterator = db.prepare('SELECT 1 AS id UNION ALL SELECT 2').iterate()
    expect(iterator[Symbol.iterator]()).toBe(iterator)
    expect(iterator.next()).toMatchObject({ done: false, value: { id: 1 } }); now += 100000
    expect(iterator.next()).toMatchObject({ done: false, value: { id: 2 } })
    expect(iterator.next()).toMatchObject({ done: true })
    for (const row of db.prepare('SELECT 3 AS id UNION ALL SELECT 4').iterate()) { expect(row).toMatchObject({ id: 3 }); break }
    expect(group(stats, 'iterate')).toMatchObject({ calls: 2, seconds: 0.002 })
    expect(group(stats, 'iterator.next')).toMatchObject({ calls: 4, seconds: 0.004 })
    expect(group(stats, 'iterator.return')).toMatchObject({ calls: 1, seconds: 0.001 })
  })
  it.each(['clock', 'record'])('contains %s hook errors without replacing native values or exception identity', cause => {
    const error = Error('PRIVATE_NATIVE'), stats = new SQLiteStatementStatistics(), work = vi.fn(() => { throw error })
    const native = { exec: work, prepare: () => ({ get: () => 'PRIVATE_RESULT' }) } as unknown as DatabaseSync
    if (cause === 'record') vi.spyOn(stats, 'record').mockImplementation(() => { throw Error('PRIVATE_HOOK') })
    const db = observeSQLiteDatabase(native, stats, cause === 'clock' ? () => { throw Error('PRIVATE_CLOCK') } : () => 1)
    try { db.exec('PRIVATE_SQL'); throw Error('should throw') } catch (caught) { expect(caught).toBe(error) }
    expect(work).toHaveBeenCalledTimes(1); expect(db.prepare('SELECT').get()).toBe('PRIVATE_RESULT')
    expect(stats.snapshot()).toEqual({ available: false })
  })
  it('keeps sixteen detached fixed groups with actual bucket boundaries and overflow containment', () => {
    const stats = new SQLiteStatementStatistics(); stats.record('get', 'returned', 0); stats.record('get', 'returned', 0.001)
    stats.record('get', 'returned', 3601)
    expect(group(stats, 'get')).toMatchObject({ calls: 3, seconds: 3601.001,
      duration: { min: 0, max: 3601, buckets: [2,0,0,0,0,0,0,0,0,0,0,1] } })
    const before = stats.snapshot(); if (!before.available) throw Error('unavailable')
    expect(before.values).toHaveLength(16); before.values[0]!.calls = 999; before.values[0]!.duration.buckets[0] = 999
    expect(group(stats, 'exec').calls).toBe(0)
    const overflow = new SQLiteStatementStatistics(); (overflow as any).values[0].calls = Number.MAX_SAFE_INTEGER
    overflow.record('exec', 'returned', 0); expect(overflow.snapshot()).toEqual({ available: false })
  })
  it.each([-1, Infinity, NaN])('invalid duration %s makes observations permanently unknown', seconds => {
    const stats = new SQLiteStatementStatistics(); stats.record('exec', 'returned', seconds); stats.record('exec', 'returned', 1)
    expect(stats.snapshot()).toEqual({ available: false })
  })
})

describe('opt-in SQLite metric delivery', () => {
  it('requires a destination and strict boolean, defaults off and appears in schema', async () => {
    expect(parseTelemetryConfig({ ...config, sqliteStatementMetrics: undefined }).sqliteStatementMetrics).toBe(false)
    expect(() => parseTelemetryConfig({ ...config, metricsEndpoint: undefined, endpoint: config.metricsEndpoint })).toThrow('invalid-command')
    expect(() => parseTelemetryConfig({ ...config, sqliteStatementMetrics: 'true' })).toThrow('invalid-command')
    const { showSchema } = await import('../src/contracts.ts')
    expect((showSchema('telemetry-config').schema as any).properties.sqliteStatementMetrics).toMatchObject({ type: 'boolean', default: false })
  })
  it.each([0, 1])('exports sixteen cumulative real distributions independent of trace sampling %s', async sampleRatio => {
    const wire = receiver(), stats = new SQLiteStatementStatistics(); stats.record('run', 'threw', 0.125)
    const read = vi.fn(() => stats.snapshot()), telemetry = new RuntimeTelemetry({ ...config, sampleRatio }, () => undefined, { sqliteStatements: read })
    cleanup.push(() => telemetry.close()); await telemetry.flush(); await telemetry.flush()
    expect(read).toHaveBeenCalledTimes(2); expect(wire.available()).toBe(1); expect(wire.metrics()).toHaveLength(4)
    expect(wire.points('jevable.storage.sqlite.calls').map(numeric).reduce((a: number, b: number) => a + b, 0)).toBe(1)
    for (const name of ['calls', 'seconds']) {
      const points = wire.points(`jevable.storage.sqlite.${name}`); expect(points).toHaveLength(16)
      for (const point of points) expect(point.attributes.map((a: any) => a.key).sort()).toEqual(['jevable.sqlite.method', 'jevable.sqlite.outcome'])
    }
    const histogram = wire.metrics().find((m: any) => m.histogram).histogram
    expect(histogram.aggregationTemporality).toBe(2); expect(histogram.dataPoints).toHaveLength(16)
    expect(histogram.dataPoints.find((p: any) => Number(p.count))).toMatchObject({ count: 1, sum: 0.125,
      min: 0.125, max: 0.125, explicitBounds: [...SQLITE_DURATION_BOUNDS], bucketCounts: [0,0,0,1,0,0,0,0,0,0,0,0] })
    expect(telemetry.status()).toMatchObject({ sqliteStatementMetrics: true })
  })
  it('does not read without opt-in and treats missing PostgreSQL source as unknown, not healthy zero', async () => {
    const wire = receiver(), read = vi.fn(() => new SQLiteStatementStatistics().snapshot())
    const disabled = new RuntimeTelemetry({ ...config, sqliteStatementMetrics: false }, () => undefined, { sqliteStatements: read })
    cleanup.push(() => disabled.close()); await disabled.flush(); expect(read).not.toHaveBeenCalled(); expect(wire.send).not.toHaveBeenCalled()
    const unsupported = new RuntimeTelemetry(config, () => undefined, { storage: 'postgres' })
    cleanup.push(() => unsupported.close()); await unsupported.flush(); expect(wire.available()).toBe(0); expect(wire.metrics()).toHaveLength(1)
  })
  it.each(['throw', 'missing', 'duplicate', 'foreign', 'negative', 'fractional', 'nonfinite', 'bucket', 'getter'])('omits stale totals for invalid %s sources', async cause => {
    const wire = receiver(), stats = new SQLiteStatementStatistics(); stats.record('get', 'returned', 0.5)
    let state: any = stats.snapshot()
    const telemetry = new RuntimeTelemetry(config, () => undefined, { sqliteStatements: () => { if (state === 'throw') throw Error('PRIVATE_SOURCE'); return state } })
    cleanup.push(() => telemetry.close()); await telemetry.flush(); expect(wire.available()).toBe(1)
    if (cause === 'throw') state = 'throw'
    if (cause === 'missing') state = { available: false }
    if (cause === 'duplicate') state.values[1] = state.values[0]
    if (cause === 'foreign') state.values[0].method = 'PRIVATE_SQL'
    if (cause === 'negative') state.values[0].calls = -1
    if (cause === 'fractional') state.values[0].calls = 1.5
    if (cause === 'nonfinite') state.values[0].seconds = Infinity
    if (cause === 'bucket') state.values[0].duration.buckets[0] = 1
    if (cause === 'getter') Object.defineProperty(state, 'values', { get() { throw Error('PRIVATE_GETTER') } })
    await telemetry.flush(); expect(wire.available()).toBe(0); expect(wire.metrics()).toHaveLength(1)
    expect(JSON.stringify(wire.batches)).not.toContain('PRIVATE_')
  })
  it('Collector failures neither reset nor replay native work', async () => {
    const wire = receiver(true), stats = new SQLiteStatementStatistics(); stats.record('exec', 'returned', 0.5)
    const before = stats.snapshot(), telemetry = new RuntimeTelemetry(config, () => undefined, { sqliteStatements: () => stats.snapshot() })
    cleanup.push(() => telemetry.close()); await telemetry.flush(); await telemetry.flush()
    expect(stats.snapshot()).toEqual(before); expect(wire.send).toHaveBeenCalledTimes(2)
    expect(telemetry.status()).toMatchObject({ metrics: { failedBatches: 2, dropped: 98 } })
  })
  it('runs, flushes without collection SQL, reopens and resumes approvals in the independent SQLite owner', async () => {
    const wire = receiver(), dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-sqlite-statement-'))
    const yaml = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
    const runtime = await LocalRuntime.open({ dataDirectory, telemetry: config }); cleanup.push(() => runtime.close())
    const waiting = await runtime.run(yaml, { message: 'PRIVATE_INPUT' }); expect(waiting.state.status).toBe('waiting')
    const before = await runtime.events(waiting.id); await runtime.telemetryFlush()
    expect(wire.available()).toBe(1)
    const first = wire.points('jevable.storage.sqlite.calls').map(numeric); expect(first.reduce((a: number, b: number) => a + b, 0)).toBeGreaterThan(0)
    await runtime.telemetryFlush(); expect(wire.points('jevable.storage.sqlite.calls').map(numeric)).toEqual(first)
    expect(await runtime.events(waiting.id)).toEqual(before); await runtime.close()
    const reopened = await LocalRuntime.open({ dataDirectory, telemetry: config }); cleanup.push(() => reopened.close())
    if (waiting.state.status !== 'waiting') throw Error('not waiting')
    const completed = await reopened.decide(waiting.id, waiting.state.attempt.id, 'approve', 'PRIVATE_ACTOR')
    expect(completed.state.status).toBe('completed'); await reopened.telemetryFlush()
    expect(wire.available()).toBe(1); expect(JSON.stringify(wire.batches)).not.toContain('PRIVATE_')
  })
})

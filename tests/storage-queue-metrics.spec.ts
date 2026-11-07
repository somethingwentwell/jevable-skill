import { afterEach, describe, expect, it, vi } from 'vitest'
import { JsonMetricsSerializer, ProtobufMetricsSerializer } from '@opentelemetry/otlp-transformer'
import { RuntimeTelemetry } from '../src/telemetry/traces.ts'
import { parseTelemetryConfig } from '../src/telemetry/config.ts'
import type { StorageQueueMetricSnapshot } from '../src/telemetry/storage-queue-metrics.ts'
import { QueueOccupancy } from '../src/storage/queue-occupancy.ts'
import { domainQueueOccupancy, withDomainWrite } from '../src/storage/domain-owner.ts'
import { PostgresJournal } from '../src/storage/postgres.ts'
import { PostgresRuntime } from '../src/runtime/postgres.ts'
import { LocalRuntime } from '../src/runtime/local.ts'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const config = { metricsEndpoint: 'http://127.0.0.1:4318/v1/metrics', storageQueueMetrics: true,
  authentication: { kind: 'none' as const }, intervalMs: 60000, timeoutMs: 100, flushTimeoutMs: 300 }
const attrs = (point: any) => Object.fromEntries(point.attributes.map((a: any) => [a.key, a.value.stringValue]))
const numeric = (point: any) => Number(point.asInt ?? point.asDouble)
function receiver(fail = false) {
  const batches: any[] = [], serialize = ProtobufMetricsSerializer.serializeRequest
  vi.spyOn(ProtobufMetricsSerializer, 'serializeRequest').mockImplementation(metrics => {
    batches.push(JSON.parse(Buffer.from(JsonMetricsSerializer.serializeRequest(metrics)!).toString())); return serialize(metrics)
  })
  const send = vi.fn(async () => { if (fail) throw Error('PRIVATE_COLLECTOR_ERROR'); return new Response(null) })
  vi.stubGlobal('fetch', send)
  const metrics = () => batches.at(-1).resourceMetrics.flatMap((r: any) => r.scopeMetrics.flatMap((s: any) => s.metrics))
  const points = (name: string) => metrics().find((m: any) => m.name === name)?.gauge.dataPoints ?? []
  return { batches, send, metrics, points,
    available: () => numeric(points('jevable.storage.queue.available')[0]),
    counts: () => points('jevable.storage.queue.operations').map((p: any) => ({ ...attrs(p), value: numeric(p) })) }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
const empty: StorageQueueMetricSnapshot = { available: true, domain: { waiting: 0, active: 0 }, journal: { waiting: 0, active: 0 } }

describe('process-local queue occupancy', () => {
  it('ends each admission once, including before begin, without negative or leaked counts', () => {
    const queue = new QueueOccupancy(), first = queue.admit(), second = queue.admit()
    expect(queue.snapshot()).toEqual({ waiting: 2, active: 0 })
    first.begin(); first.begin(); second.end(); second.begin(); second.end()
    expect(queue.snapshot()).toEqual({ waiting: 0, active: 1 })
    first.end(); first.end(); first.begin(); expect(queue.snapshot()).toEqual({ waiting: 0, active: 0 })
  })
  it('projects actual domain serialization, never runs work during a snapshot, and releases failures', async () => {
    const journal = { signal: new AbortController().signal } as PostgresJournal
    const entered = deferred(), held = deferred(), phases: string[] = []
    const first = withDomainWrite(journal, async () => { phases.push('first'); entered.resolve(); await held.promise; throw Error('PRIVATE_FAILURE') })
    const observed = first.catch(e => e.message)
    await entered.promise
    const second = withDomainWrite(journal, async () => { phases.push('second'); return 'result' })
    expect(domainQueueOccupancy(journal)).toEqual({ waiting: 1, active: 1 })
    expect(domainQueueOccupancy(journal)).toEqual({ waiting: 1, active: 1 }); expect(phases).toEqual(['first'])
    held.resolve(); expect(await observed).toBe('PRIVATE_FAILURE'); expect(await second).toBe('result')
    expect(phases).toEqual(['first', 'second']); expect(domainQueueOccupancy(journal)).toEqual({ waiting: 0, active: 0 })
  })
  it('settles waiting owner-loss refusals without invoking callbacks or retaining occupancy', async () => {
    const controller = new AbortController(), journal = { signal: controller.signal } as PostgresJournal
    controller.abort(Error('PRIVATE_LOST')); const work = vi.fn(async () => {})
    const rejected = withDomainWrite(journal, work)
    expect(domainQueueOccupancy(journal)).toEqual({ waiting: 1, active: 0 })
    await expect(rejected).rejects.toThrow('PRIVATE_LOST'); expect(work).not.toHaveBeenCalled()
    expect(domainQueueOccupancy(journal)).toEqual({ waiting: 0, active: 0 })
  })
})

describe('opt-in storage queue gauges', () => {
  it('requires metrics, preserves opt-in defaults, and admits the same field in shipped input discovery', async () => {
    expect(parseTelemetryConfig({ ...config, storageQueueMetrics: undefined }).storageQueueMetrics).toBe(false)
    expect(() => parseTelemetryConfig({ ...config, metricsEndpoint: undefined, endpoint: config.metricsEndpoint })).toThrow('invalid-command')
    expect(() => parseTelemetryConfig({ ...config, storageQueueMetrics: 'true' })).toThrow('invalid-command')
    const { showSchema } = await import('../src/contracts.ts')
    expect((showSchema('telemetry-config').schema as any).properties.storageQueueMetrics).toMatchObject({ type: 'boolean', default: false })
  })
  it.each([0, 1])('exports five bounded idle gauge points independently of trace sampling (%s)', async sampleRatio => {
    const wire = receiver(), read = vi.fn(() => empty)
    const runtime = new RuntimeTelemetry({ ...config, sampleRatio }, () => undefined, { storage: 'postgres', storageQueues: read })
    cleanup.push(() => runtime.close()); await runtime.flush(); await runtime.flush()
    expect(wire.send).toHaveBeenCalledTimes(2); expect(read).toHaveBeenCalledTimes(2)
    expect(wire.available()).toBe(1); expect(wire.metrics()).toHaveLength(2)
    expect(wire.counts()).toEqual(['domain', 'journal'].flatMap(queue => ['waiting', 'active'].map(state => ({
      'jevable.storage.queue': queue, 'jevable.storage.queue.state': state, value: 0 }))))
    expect(runtime.status()).toMatchObject({ storageQueueMetrics: true, signals: ['metrics'] })
    expect(wire.batches.at(-1).resourceMetrics[0].resource.attributes).toContainEqual({ key: 'jevable.storage.kind', value: { stringValue: 'postgres' } })
  })
  it('does not collect or export queue data without opt-in', async () => {
    const wire = receiver(), read = vi.fn(() => empty)
    const runtime = new RuntimeTelemetry({ ...config, storageQueueMetrics: false }, () => undefined, { storageQueues: read })
    cleanup.push(() => runtime.close()); await runtime.flush()
    expect(read).not.toHaveBeenCalled(); expect(wire.send).not.toHaveBeenCalled()
    runtime.end(runtime.start('jevable.run', {}), 'completed'); await runtime.flush()
    expect(wire.metrics().some((m: any) => m.name.startsWith('jevable.storage.queue.'))).toBe(false)
  })
  it('observes actual held domain work without dispatch, IDs, SQL, payloads or injected labels', async () => {
    const wire = receiver(), journal = { signal: new AbortController().signal } as PostgresJournal
    const entered = deferred(), held = deferred(), work = vi.fn(async () => 'PRIVATE_RESULT')
    const first = withDomainWrite(journal, async () => { entered.resolve(); await held.promise })
    await entered.promise; const second = withDomainWrite(journal, work)
    const runtime = new RuntimeTelemetry(config, () => undefined, { storageQueues: () => ({ available: true,
      domain: { ...domainQueueOccupancy(journal), private: 'PRIVATE_INPUT' }, journal: { waiting: 3, active: 1 } }) })
    cleanup.push(() => runtime.close()); await runtime.flush()
    expect(work).not.toHaveBeenCalled(); expect(wire.available()).toBe(1)
    expect(wire.counts().map((p: any) => p.value)).toEqual([1, 1, 3, 1])
    held.resolve(); await first; expect(await second).toBe('PRIVATE_RESULT'); await runtime.flush()
    expect(wire.counts().slice(0, 2).map((p: any) => p.value)).toEqual([0, 0])
    expect(JSON.stringify(wire.batches)).not.toContain('PRIVATE_')
  })
  it.each(['missing', 'throw', 'negative', 'fractional', 'overflow', 'multiple-active', 'nonfinite', 'getter'] as const)(
    'omits stale gauges when the source is %s instead of claiming an empty queue', async cause => {
      const wire = receiver(); let state: any = { available: true, domain: { waiting: 7, active: 1 }, journal: { waiting: 4, active: 1 } }
      const runtime = new RuntimeTelemetry(config, () => undefined, { storageQueues: () => {
        if (state === 'throw') throw Error('PRIVATE_SOURCE_ERROR'); return state
      } })
      cleanup.push(() => runtime.close()); await runtime.flush(); expect(wire.available()).toBe(1)
      if (cause === 'missing') state = { available: false }
      if (cause === 'throw') state = 'throw'
      if (cause === 'negative') state.domain.waiting = -1
      if (cause === 'fractional') state.domain.waiting = 1.5
      if (cause === 'overflow') state.journal.waiting = Number.MAX_SAFE_INTEGER + 1
      if (cause === 'multiple-active') state.journal.active = 2
      if (cause === 'nonfinite') state.journal.waiting = Infinity
      if (cause === 'getter') Object.defineProperty(state, 'domain', { get() { throw Error('PRIVATE_GETTER') } })
      await runtime.flush(); expect(wire.available()).toBe(0); expect(wire.counts()).toEqual([])
      expect(wire.metrics()).toHaveLength(1); expect(JSON.stringify(wire.batches)).not.toContain('PRIVATE_')
      state = empty; await runtime.flush(); expect(wire.available()).toBe(1); expect(wire.counts()).toHaveLength(4)
    })
  it('captures numeric projections once rather than exporting mutable source aliases', async () => {
    const wire = receiver(); let reads = 0
    const domain = { get waiting() { reads++; return reads === 1 ? 6 : -1 }, active: 1 }
    const runtime = new RuntimeTelemetry(config, () => undefined, { storageQueues: () => ({ available: true, domain, journal: empty.available ? empty.journal : { waiting: 0, active: 0 } }) })
    cleanup.push(() => runtime.close()); await runtime.flush()
    expect(reads).toBe(1); expect(wire.available()).toBe(1); expect(wire.counts()[0].value).toBe(6)
  })
  it('keeps exporter failure separate from queue ownership and never replays work', async () => {
    const wire = receiver(true), journal = { signal: new AbortController().signal } as PostgresJournal
    const work = vi.fn(async () => {}); await withDomainWrite(journal, work)
    const runtime = new RuntimeTelemetry(config, () => undefined, { storageQueues: () => ({ available: true, domain: domainQueueOccupancy(journal), journal: { waiting: 0, active: 0 } }) })
    cleanup.push(() => runtime.close()); await runtime.flush(); await runtime.flush()
    expect(work).toHaveBeenCalledTimes(1); expect(domainQueueOccupancy(journal)).toEqual({ waiting: 0, active: 0 })
    expect(runtime.status()).toMatchObject({ metrics: { failedBatches: 2, dropped: 10 } }); expect(wire.send).toHaveBeenCalledTimes(2)
  })
  it('reports unsupported SQLite occupancy as unknown without changing standalone execution', async () => {
    const wire = receiver(), dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-storage-queue-sqlite-'))
    const runtime = await LocalRuntime.open({ dataDirectory, telemetry: config })
    cleanup.push(() => runtime.close()); await runtime.telemetryFlush()
    expect(wire.available()).toBe(0); expect(wire.counts()).toEqual([]); expect(wire.metrics()).toHaveLength(1)
    expect(runtime.list()).toEqual([])
  })
  it('wires owned PostgreSQL queues without collection reads, and reports unknown after owner loss', async () => {
    // Domain/runtime integration against an empty journal double, not actual PostgreSQL/lock qualification.
    const wire = receiver(), controller = new AbortController(), journal = {
      signal: controller.signal, status: vi.fn(() => ({ state: controller.signal.aborted ? 'lost' : 'open' })),
      queueOccupancy: vi.fn(() => ({ waiting: 5, active: 1 })), records: vi.fn(async () => []),
      count: vi.fn(async () => 0), events: vi.fn(async () => ({ events: [], cursor: '0' })),
      page: vi.fn(async () => ({ records: [], nextCursor: null })), close: vi.fn(async () => {}),
    } as unknown as PostgresJournal
    vi.spyOn(PostgresJournal, 'open').mockResolvedValue(journal)
    const database = { host: '127.0.0.1', port: 5432, database: 'fixture', user: 'fixture', password: 'PRIVATE_PASSWORD',
      namespace: 'fixture', initialize: false, tls: { mode: 'loopback-test' as const } }
    const runtime = await PostgresRuntime.open({ database, telemetry: config }); cleanup.push(() => runtime.close())
    vi.mocked(journal.records).mockClear(); vi.mocked(journal.page).mockClear()
    await runtime.telemetryFlush(); expect(wire.available()).toBe(1); expect(wire.counts().map((p: any) => p.value)).toEqual([0, 0, 5, 1])
    expect(journal.records).not.toHaveBeenCalled(); expect(journal.page).not.toHaveBeenCalled()
    controller.abort(); await expect(runtime.telemetryFlush()).rejects.toThrow()
    await runtime.close(); expect(wire.available()).toBe(0); expect(wire.counts()).toEqual([])
    expect(JSON.stringify(wire.batches)).not.toContain('PRIVATE_PASSWORD')
  })
})

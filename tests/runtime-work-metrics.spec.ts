import { afterEach, describe, expect, it, vi } from 'vitest'
import { JsonMetricsSerializer, ProtobufMetricsSerializer } from '@opentelemetry/otlp-transformer'
import { RuntimeTelemetry } from '../src/telemetry/traces.ts'
import { parseTelemetryConfig } from '../src/telemetry/config.ts'
import { capabilities } from '../src/capabilities.ts'
import type { RuntimeWorkMetricSnapshot } from '../src/telemetry/runtime-work-metrics.ts'
import { LocalRuntime } from '../src/runtime/local.ts'
import { PostgresRuntime } from '../src/runtime/postgres.ts'
import { PostgresJournal } from '../src/storage/postgres.ts'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ModelCalls } from '../src/runtime/model-port.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const config = { metricsEndpoint: 'http://127.0.0.1:4318/v1/metrics', runtimeWorkMetrics: true,
  authentication: { kind: 'none' as const }, intervalMs: 60000, timeoutMs: 100, flushTimeoutMs: 300 }
const idle: RuntimeWorkMetricSnapshot = { available: true, operations: 0, runReservations: 0 }
const decision = await readFile(new URL('../examples/native-decision.yaml', import.meta.url), 'utf8')
const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
function receiver(fail = false) {
  const batches: any[] = [], serialize = ProtobufMetricsSerializer.serializeRequest
  vi.spyOn(ProtobufMetricsSerializer, 'serializeRequest').mockImplementation(metrics => {
    batches.push(JSON.parse(Buffer.from(JsonMetricsSerializer.serializeRequest(metrics)!).toString())); return serialize(metrics)
  })
  const send = vi.fn(async () => { if (fail) throw Error('PRIVATE_COLLECTOR_FAILURE'); return new Response(null) })
  vi.stubGlobal('fetch', send)
  const metrics = () => batches.at(-1)?.resourceMetrics.flatMap((r: any) => r.scopeMetrics.flatMap((s: any) => s.metrics)) ?? []
  const work = () => metrics().filter((m: any) => m.name.startsWith('jevable.runtime.work.'))
  const snapshot = () => Object.fromEntries(work().map((m: any) => {
    expect(m.gauge.dataPoints).toHaveLength(1)
    expect(m.gauge.dataPoints[0].attributes ?? []).toEqual([])
    return [m.name, Number(m.gauge.dataPoints[0].asInt ?? m.gauge.dataPoints[0].asDouble)]
  }))
  return { batches, send, metrics, work, snapshot }
}
const expected = (operations = 0, runReservations = 0) => ({ 'jevable.runtime.work.available': 1,
  'jevable.runtime.work.operations': operations, 'jevable.runtime.work.run_reservations': runReservations })

describe('opt-in owner runtime work gauges', () => {
  it('requires an explicit metrics destination, strict boolean opt-in and shared discovery', async () => {
    expect(parseTelemetryConfig({ ...config, runtimeWorkMetrics: undefined }).runtimeWorkMetrics).toBe(false)
    expect(() => parseTelemetryConfig({ ...config, runtimeWorkMetrics: 'true' })).toThrow('invalid-command')
    expect(() => parseTelemetryConfig({ ...config, metricsEndpoint: undefined, endpoint: config.metricsEndpoint })).toThrow('invalid-command')
    expect(() => parseTelemetryConfig({ ...config, runtimeWorkMetrics: false, metricsEndpoint: undefined, endpoint: config.metricsEndpoint })).not.toThrow()
    const { showSchema } = await import('../src/contracts.ts')
    expect((showSchema('telemetry-config').schema as any).properties.runtimeWorkMetrics).toMatchObject({ type: 'boolean', default: false })
    const discovery = capabilities().workflowRuntime.runtimeWorkTelemetry
    expect(discovery).toMatchObject({ option: 'runtimeWorkMetrics', default: false, requires: ['metricsEndpoint'],
      configuration: 'startup-only', signal: 'metrics', owners: ['sqlite', 'postgres'], traceSampling: 'independent', pointLabels: false })
    expect(parseTelemetryConfig({ ...config, [discovery.option]: undefined }).runtimeWorkMetrics).toBe(discovery.default)
  })
  it('returns detached nested work metadata without installing telemetry or reading owner state', () => {
    const wire = receiver(), baseline = capabilities().workflowRuntime.runtimeWorkTelemetry
    const mutated = capabilities().workflowRuntime.runtimeWorkTelemetry
    mutated.requires.push('forged'); mutated.owners.push('forged'); mutated.collection.push('forged')
    mutated.instruments[0]!.name = 'forged'; mutated.exclusions.push('forged'); mutated.default = true
    expect(capabilities().workflowRuntime.runtimeWorkTelemetry).toEqual(baseline)
    expect(wire.batches).toEqual([]); expect(wire.send).not.toHaveBeenCalled()
  })
  it.each([0, 1])('collects three label-free idle gauges independent of sampling (%s)', async sampleRatio => {
    const wire = receiver(), read = vi.fn(() => idle), runtime = new RuntimeTelemetry({ ...config, sampleRatio }, () => undefined, { runtimeWork: read })
    cleanup.push(() => runtime.close()); await runtime.flush(); await runtime.flush()
    expect(read).toHaveBeenCalledTimes(2); expect(wire.send).toHaveBeenCalledTimes(2)
    expect(wire.snapshot()).toEqual(expected()); expect(wire.work()).toHaveLength(3)
    expect(wire.work().map((m: any) => m.unit)).toEqual(['1', '{operation}', '{run}'])
    expect(capabilities().workflowRuntime.runtimeWorkTelemetry.instruments.map(({ name, unit, kind }) => ({ name, unit, kind })))
      .toEqual(wire.work().map((m: any) => ({ name: m.name, unit: m.unit, kind: m.gauge ? 'gauge' : 'not-a-gauge' })))
    expect(runtime.status()).toMatchObject({ runtimeWorkMetrics: true, signals: ['metrics'] })
  })
  it('does not read or export the source when omitted or false', async () => {
    const wire = receiver(), read = vi.fn(() => idle)
    const runtime = new RuntimeTelemetry({ ...config, runtimeWorkMetrics: false }, () => undefined, { runtimeWork: read })
    cleanup.push(() => runtime.close()); await runtime.flush()
    expect(read).not.toHaveBeenCalled(); expect(wire.send).not.toHaveBeenCalled()
    runtime.end(runtime.start('jevable.run', {}), 'completed'); await runtime.flush()
    expect(read).not.toHaveBeenCalled(); expect(wire.work()).toEqual([]); expect(runtime.status()).not.toHaveProperty('runtimeWorkMetrics')
  })
  it('reports missing sources as unavailable, not an invented empty owner', async () => {
    const wire = receiver(), runtime = new RuntimeTelemetry(config, () => undefined)
    cleanup.push(() => runtime.close()); await runtime.flush()
    expect(wire.snapshot()).toEqual({ 'jevable.runtime.work.available': 0 })
  })
  it.each(['missing', 'throw', 'negative', 'fractional', 'overflow', 'nonfinite', 'getter', 'truthy'] as const)(
    'omits prior occupancy when the snapshot becomes %s and restores only valid counts', async kind => {
      const wire = receiver(); let state: any = { available: true, operations: 7, runReservations: 4 }
      const runtime = new RuntimeTelemetry(config, () => undefined, { runtimeWork: () => {
        if (state === 'throw') throw Error('PRIVATE_SOURCE_ERROR'); return state
      } })
      cleanup.push(() => runtime.close()); await runtime.flush(); expect(wire.snapshot()).toEqual(expected(7, 4))
      if (kind === 'missing') state = undefined
      if (kind === 'throw') state = 'throw'
      if (kind === 'negative') state.operations = -1
      if (kind === 'fractional') state.runReservations = 1.5
      if (kind === 'overflow') state.operations = Number.MAX_SAFE_INTEGER + 1
      if (kind === 'nonfinite') state.runReservations = Infinity
      if (kind === 'getter') Object.defineProperty(state, 'operations', { get() { throw Error('PRIVATE_GETTER') } })
      if (kind === 'truthy') state.available = 'true'
      await runtime.flush(); expect(wire.snapshot()).toEqual({ 'jevable.runtime.work.available': 0 })
      state = idle; await runtime.flush(); expect(wire.snapshot()).toEqual(expected())
      expect(JSON.stringify(wire.batches)).not.toContain('PRIVATE_')
    })
  it('copies only two fixed numeric values once and never evaluates unrelated fields', async () => {
    const wire = receiver(); let reads = 0
    const state = { available: true as const, get operations() { reads++; return reads === 1 ? 6 : -1 }, runReservations: 2,
      get token() { throw Error('must not evaluate private field') } }
    const runtime = new RuntimeTelemetry(config, () => undefined, { runtimeWork: () => state })
    cleanup.push(() => runtime.close()); await runtime.flush()
    expect(reads).toBe(1); expect(wire.snapshot()).toEqual(expected(6, 2))
  })
  it('samples idle work on the configured interval without dispatching execution', async () => {
    vi.useFakeTimers(); const wire = receiver(), read = vi.fn(() => idle)
    const runtime = new RuntimeTelemetry({ ...config, intervalMs: 20 }, () => undefined, { runtimeWork: read })
    cleanup.push(() => runtime.close()); await vi.advanceTimersByTimeAsync(45)
    expect(read).toHaveBeenCalledTimes(2); expect(wire.send).toHaveBeenCalledTimes(2); expect(wire.snapshot()).toEqual(expected())
  })
  it('shares in-flight collections across concurrent flushes', async () => {
    const wire = receiver(), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), read = vi.fn(() => idle)
    wire.send.mockImplementation(async () => { entered.resolve(); await gate.promise; return new Response(null) })
    const runtime = new RuntimeTelemetry(config, () => undefined, { runtimeWork: read }); cleanup.push(() => runtime.close())
    const first = runtime.flush(); await entered.promise; const second = runtime.flush()
    try { expect(read).toHaveBeenCalledOnce(); expect(wire.send).toHaveBeenCalledOnce() }
    finally { gate.resolve(); await Promise.all([first, second]) }
  })
  it('does not retry source work when the collector fails', async () => {
    const wire = receiver(true), read = vi.fn(() => ({ available: true as const, operations: 2, runReservations: 1 }))
    const runtime = new RuntimeTelemetry(config, () => undefined, { runtimeWork: read }); cleanup.push(() => runtime.close())
    await runtime.flush(); await runtime.flush()
    expect(read).toHaveBeenCalledTimes(2); expect(wire.snapshot()).toEqual(expected(2, 1))
    expect(runtime.status()).toMatchObject({ metrics: { failedBatches: 2, dropped: 6 } })
  })
})

describe('standalone owner work sources', () => {
  it('observes two actually held SQLite admissions, releases them on settlement and keeps busy guards', async () => {
    const wire = receiver(), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(); let admissions = 0
    const models: ModelCalls = { admit: vi.fn(async () => { if (++admissions === 2) entered.resolve(); await gate.promise }), execute: vi.fn(), verify: vi.fn() }
    const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-runtime-work-admission-'))
    const owner = await LocalRuntime.open({ dataDirectory, telemetry: config, models }); cleanup.push(() => owner.close())
    const calls = [owner.run(decision, 'PRIVATE_ONE', { paused: true }), owner.run(decision, 'PRIVATE_TWO', { paused: true })]
    try {
      await entered.promise; await owner.telemetryFlush(); expect(wire.snapshot()).toEqual(expected(2, 2))
      await expect(owner.close()).rejects.toHaveProperty('code', 'busy'); expect(models.execute).not.toHaveBeenCalled()
    } finally { gate.resolve(); await Promise.all(calls) }
    await owner.telemetryFlush(); expect(wire.snapshot()).toEqual(expected())
    expect(owner.list()).toHaveLength(2); expect(models.execute).not.toHaveBeenCalled(); expect(JSON.stringify(wire.batches)).not.toContain('PRIVATE_')
    await owner.close(); expect(wire.snapshot()).toEqual({ 'jevable.runtime.work.available': 0 })
  })
  it('observes readiness without reserving a run and releases a failed admission without dispatch', async () => {
    const wire = receiver(), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), failure = Error('PRIVATE_ADMISSION')
    const models: ModelCalls = { admit: vi.fn(async () => { entered.resolve(); await gate.promise; throw failure }), execute: vi.fn(), verify: vi.fn() }
    const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-runtime-work-readiness-'))
    const owner = await LocalRuntime.open({ dataDirectory, telemetry: config, models }); cleanup.push(() => owner.close())
    const check = owner.check(decision)
    const rejected = expect(check).rejects.toBe(failure)
    try { await entered.promise; await owner.telemetryFlush(); expect(wire.snapshot()).toEqual(expected(1, 0)) }
    finally { gate.resolve(); await rejected }
    await owner.telemetryFlush(); expect(wire.snapshot()).toEqual(expected()); expect(owner.list()).toEqual([]); expect(models.execute).not.toHaveBeenCalled()
  })
  it('does not reconstruct reservations for completed, paused or waiting records on reopen or retries', async () => {
    const wire = receiver(), dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-runtime-work-reopen-'))
    let owner = await LocalRuntime.open({ dataDirectory, telemetry: config }); cleanup.push(() => owner.close())
    const id = randomUUID(), completed = await owner.run(echo, 'PRIVATE_DONE', { id }), paused = await owner.run(echo, 'PRIVATE_PAUSED', { paused: true })
    const waiting = await owner.run(approval, { message: 'PRIVATE_WAIT' }), events = await owner.events(id)
    await owner.telemetryFlush(); expect(wire.snapshot()).toEqual(expected()); await owner.close()
    owner = await LocalRuntime.open({ dataDirectory, telemetry: config })
    await owner.telemetryFlush(); expect(wire.snapshot()).toEqual(expected())
    expect(await owner.run(echo, 'PRIVATE_DONE', { id })).toEqual(completed)
    expect(await owner.events(id)).toEqual(events); expect(await owner.show(paused.id)).toEqual(paused); expect(await owner.show(waiting.id)).toEqual(waiting)
    await owner.telemetryFlush(); expect(wire.snapshot()).toEqual(expected())
    const resources = wire.batches.map(b => Object.fromEntries(b.resourceMetrics[0].resource.attributes.map((a: any) => [a.key, a.value.stringValue])))
    expect(new Set(resources.map(r => r['service.instance.id'])).size).toBe(2)
  })
  it('uses existing PostgreSQL operation counters, performs no SQL during collection and omits work after owner loss', async () => {
    // Empty journal/host double: this verifies wiring, not an actual PostgreSQL database or lease.
    const wire = receiver(), controller = new AbortController(), journal = {
      signal: controller.signal, status: vi.fn(() => ({ state: controller.signal.aborted ? 'lost' : 'open' })),
      records: vi.fn(async () => []), count: vi.fn(async () => 0), events: vi.fn(async () => ({ events: [], cursor: '0' })),
      page: vi.fn(async () => ({ records: [], nextCursor: null })), close: vi.fn(async () => {}),
    } as unknown as PostgresJournal
    vi.spyOn(PostgresJournal, 'open').mockResolvedValue(journal)
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    const database = { host: '127.0.0.1', port: 5432, database: 'fixture', user: 'fixture', password: 'PRIVATE_PASSWORD',
      namespace: 'fixture', initialize: false, tls: { mode: 'loopback-test' as const } }
    const owner = await PostgresRuntime.open({ database, telemetry: config }); cleanup.push(() => owner.close())
    vi.mocked(journal.records).mockClear(); vi.mocked(journal.page).mockClear(); vi.mocked(journal.count).mockClear(); vi.mocked(journal.events).mockClear()
    await owner.telemetryFlush(); expect(wire.snapshot()).toEqual(expected())
    vi.mocked(journal.records).mockImplementationOnce(async () => { entered.resolve(); await gate.promise; return [] })
    const check = owner.connections()
    try { await entered.promise; await owner.telemetryFlush(); expect(wire.snapshot()).toEqual(expected(1, 0)) }
    finally { gate.resolve(); await check }
    await owner.telemetryFlush(); expect(wire.snapshot()).toEqual(expected())
    expect(journal.records).toHaveBeenCalledTimes(1)
    for (const call of [journal.page, journal.count, journal.events]) expect(call).not.toHaveBeenCalled()
    controller.abort(); await owner.close(); expect(wire.snapshot()).toEqual({ 'jevable.runtime.work.available': 0 })
    expect(JSON.stringify(wire.batches)).not.toContain('PRIVATE_PASSWORD')
  })
})

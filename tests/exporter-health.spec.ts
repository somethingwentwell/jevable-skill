import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { JsonMetricsSerializer, ProtobufMetricsSerializer } from '@opentelemetry/otlp-transformer'
import { RuntimeTelemetry } from '../src/telemetry/traces.ts'
import { RuntimeMetrics } from '../src/telemetry/metrics.ts'
import { parseTelemetryConfig } from '../src/telemetry/config.ts'
import { LocalRuntime } from '../src/runtime/local.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
})
const config = { metricsEndpoint: 'http://127.0.0.1:4318/v1/metrics', authentication: { kind: 'none' as const },
  exporterMetrics: true, intervalMs: 60000, timeoutMs: 100, flushTimeoutMs: 200 }
const ok = () => new Response(null, { status: 200, headers: { 'content-type': 'application/x-protobuf' } })
const attrs = (point: any) => Object.fromEntries(point.attributes.map((a: any) => [a.key, a.value.stringValue]))
const value = (point: any) => Number(point.asInt ?? point.asDouble)
function receiver(reply: (url: string, init: RequestInit) => Response | Promise<Response> = () => ok()) {
  const batches: any[] = []
  const original = ProtobufMetricsSerializer.serializeRequest
  vi.spyOn(ProtobufMetricsSerializer, 'serializeRequest').mockImplementation(metrics => {
    batches.push(JSON.parse(Buffer.from(JsonMetricsSerializer.serializeRequest(metrics)!).toString()))
    return original(metrics)
  })
  const fetch = vi.fn((url: string, init: RequestInit) => Promise.resolve(reply(url, init)))
  vi.stubGlobal('fetch', fetch)
  const metrics = (index = batches.length - 1): any[] => batches[index].resourceMetrics.flatMap((r: any) => r.scopeMetrics.flatMap((s: any) => s.metrics))
  const points = (name: string, index?: number): any[] => {
    const metric = metrics(index).find(m => m.name === name)
    return metric ? (metric.sum ?? metric.gauge).dataPoints : []
  }
  const point = (name: string, signal: string, state?: string, index?: number) => points(`jevable.telemetry.${name}`, index).find(p => {
    const labels = attrs(p)
    return labels['jevable.telemetry.signal'] === signal && labels['jevable.telemetry.state'] === state
  })
  return { batches, fetch, metrics, points, point }
}
function owner(overrides: Partial<typeof config> = {}, canExport?: () => boolean) {
  const telemetry = new RuntimeTelemetry({ ...config, ...overrides }, () => undefined, canExport ? { canExport } : {})
  cleanup.push(() => telemetry.close()); return telemetry
}

describe('opt-in exporter-health metrics', () => {
  it('requires explicit metrics export and a strict boolean; defaults to disabled', () => {
    expect(parseTelemetryConfig({ ...config, exporterMetrics: undefined }).exporterMetrics).toBe(false)
    expect(() => parseTelemetryConfig({ endpoint: config.metricsEndpoint, authentication: config.authentication, exporterMetrics: true })).toThrow()
    expect(() => parseTelemetryConfig({ ...config, exporterMetrics: 'true' })).toThrow()
  })

  it('does not create idle traffic when disabled', async () => {
    const wire = receiver(), runtime = owner({ exporterMetrics: false })
    await runtime.flush(); await runtime.close()
    expect(wire.fetch).not.toHaveBeenCalled()
  })

  it('exports exactly sixteen fixed-label health points for an idle metrics-only owner', async () => {
    const wire = receiver(), runtime = owner()
    await runtime.flush()
    expect(wire.fetch).toHaveBeenCalledTimes(1)
    expect(wire.metrics()).toHaveLength(5)
    expect(wire.metrics().flatMap(m => (m.sum ?? m.gauge).dataPoints)).toHaveLength(16)
    expect(value(wire.point('records', 'metrics', 'accepted'))).toBe(0)
    expect(value(wire.point('last_failure', 'metrics', 'none'))).toBe(1)
    expect(value(wire.point('last_success', 'metrics'))).toBe(0)
    for (const metric of wire.metrics()) {
      if (metric.sum) { expect(metric.sum.isMonotonic).toBe(true); expect(metric.sum.aggregationTemporality).toBe(2) }
      for (const point of (metric.sum ?? metric.gauge).dataPoints) expect(Object.keys(attrs(point)).every(k => ['jevable.telemetry.signal', 'jevable.telemetry.state'].includes(k))).toBe(true)
    }
    await runtime.flush()
    expect(value(wire.point('records', 'metrics', 'accepted'))).toBe(16)
    expect(value(wire.point('records', 'metrics', 'exported'))).toBe(16)
    expect(value(wire.point('batches', 'metrics', 'success'))).toBe(1)
    expect(value(wire.point('last_success', 'metrics'))).toBeGreaterThan(0)
    expect(runtime.status().metrics).toMatchObject({ accepted: 32, exported: 32, pendingChanges: false })
  })

  it('reports its previous failure on the next sample and clears the one-hot category after acknowledgement', async () => {
    let fail = true
    const wire = receiver(() => fail ? new Response('PRIVATE_COLLECTOR_ERROR', { status: 503 }) : ok()), runtime = owner()
    await runtime.flush()
    expect(runtime.status().metrics).toMatchObject({ failedBatches: 1, dropped: 16, lastFailure: 'response' })
    fail = false; await runtime.flush()
    expect(value(wire.point('last_failure', 'metrics', 'response'))).toBe(1)
    expect(value(wire.point('last_failure', 'metrics', 'none'))).toBe(0)
    expect(value(wire.point('records', 'metrics', 'dropped'))).toBe(16)
    await runtime.flush()
    expect(value(wire.point('last_failure', 'metrics', 'response'))).toBe(0)
    expect(value(wire.point('last_failure', 'metrics', 'none'))).toBe(1)
    expect(wire.fetch).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(wire.batches)).not.toContain('PRIVATE_COLLECTOR_ERROR')
  })

  it('distinguishes rejected data points from transport drops', async () => {
    const wire = receiver(() => new Response(new Uint8Array([10, 2, 8, 1]), { headers: { 'content-type': 'application/x-protobuf' } })), runtime = owner()
    await runtime.flush(); await runtime.flush()
    expect(value(wire.point('records', 'metrics', 'rejected'))).toBe(1)
    expect(value(wire.point('records', 'metrics', 'dropped'))).toBe(0)
    expect(value(wire.point('last_failure', 'metrics', 'partial-rejection'))).toBe(1)
  })

  it('exposes serialization failure in the next successful sample without exporting raw errors', async () => {
    const wire = receiver(), runtime = owner()
    vi.mocked(ProtobufMetricsSerializer.serializeRequest).mockImplementationOnce(() => { throw new Error('PRIVATE_SERIALIZATION') })
    await runtime.flush()
    expect(wire.fetch).not.toHaveBeenCalled()
    expect(runtime.status().metrics).toMatchObject({ failedBatches: 1, dropped: 16, lastFailure: 'serialization' })
    await runtime.flush()
    expect(value(wire.point('last_failure', 'metrics', 'serialization'))).toBe(1)
    expect(JSON.stringify(wire.batches)).not.toContain('PRIVATE_SERIALIZATION')
  })

  it('resets counters under a new resource instance when the runtime owner restarts', async () => {
    const wire = receiver(), first = owner()
    await first.flush(); await first.close()
    const boundary = wire.batches.length, second = owner()
    await second.flush()
    expect(value(wire.point('records', 'metrics', 'accepted', boundary))).toBe(0)
    const instance = (index: number) => wire.batches[index].resourceMetrics[0].resource.attributes.find((a: any) => a.key === 'service.instance.id').value.stringValue
    expect(instance(0)).not.toBe(instance(boundary))
  })

  it('observes trace and log queue overflow and export failure without resending those records', async () => {
    const wire = receiver(url => url.endsWith('/metrics') ? ok() : new Response(null, { status: 503 }))
    const runtime = new RuntimeTelemetry({ ...config, endpoint: config.metricsEndpoint.replace('metrics', 'traces'),
      logsEndpoint: config.metricsEndpoint.replace('metrics', 'logs'), queueSize: 1, batchSize: 1 }, () => undefined)
    cleanup.push(() => runtime.close())
    runtime.end(runtime.start('jevable.node', { 'jevable.node.kind': 'trigger' }), 'completed')
    runtime.end(runtime.start('jevable.node', { 'jevable.node.kind': 'output' }), 'completed')
    await runtime.flush(); await runtime.flush()
    for (const signal of ['traces', 'logs']) {
      expect(value(wire.point('records', signal, 'accepted'))).toBe(1)
      expect(value(wire.point('records', signal, 'dropped'))).toBe(2)
      expect(value(wire.point('batches', signal, 'failure'))).toBe(1)
      expect(value(wire.point('occupancy', signal, 'queued'))).toBe(0)
      expect(value(wire.point('last_failure', signal, 'response'))).toBe(1)
      expect(wire.fetch.mock.calls.filter(([url]) => url.endsWith(`/${signal}`))).toHaveLength(1)
    }
  })

  it('exports zero trace counters when trace sampling is disabled', async () => {
    const wire = receiver(), runtime = new RuntimeTelemetry({ ...config, endpoint: config.metricsEndpoint.replace('metrics', 'traces'), sampleRatio: 0 }, () => undefined)
    cleanup.push(() => runtime.close())
    runtime.end(runtime.start('jevable.run', {}), 'completed'); await runtime.flush()
    expect(value(wire.point('records', 'traces', 'accepted'))).toBe(0)
    expect(wire.fetch.mock.calls.every(([url]) => url.endsWith('/metrics'))).toBe(true)
  })

  it('samples idle owners periodically without a recursive export loop and stops timers on close', async () => {
    vi.useFakeTimers()
    const wire = receiver(), runtime = owner({ intervalMs: 100 })
    await vi.advanceTimersByTimeAsync(99); expect(wire.fetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1); expect(wire.fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(300); expect(wire.fetch).toHaveBeenCalledTimes(4)
    await runtime.close(); const count = wire.fetch.mock.calls.length
    expect(count).toBe(5)
    await vi.advanceTimersByTimeAsync(1000); expect(wire.fetch).toHaveBeenCalledTimes(count)
  })

  it('defers periodic and explicit sampling while credential mutation excludes export', async () => {
    vi.useFakeTimers(); let allowed = false
    const wire = receiver(), runtime = owner({ intervalMs: 100 }, () => allowed)
    await vi.advanceTimersByTimeAsync(300); await runtime.flush()
    expect(wire.fetch).not.toHaveBeenCalled()
    allowed = true; await vi.advanceTimersByTimeAsync(100)
    expect(wire.fetch).toHaveBeenCalledTimes(1)
  })

  it('joins concurrent flushes and bounds shutdown of a stalled health export', async () => {
    const wire = receiver((_url, init) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('PRIVATE_ABORT')), { once: true })
    })), runtime = owner({ timeoutMs: 1000, flushTimeoutMs: 20 })
    await Promise.all([runtime.flush(), runtime.flush()])
    expect(wire.fetch).toHaveBeenCalledTimes(1)
    expect(runtime.status().metrics).toMatchObject({ inFlight: 16, queued: 0 })
    const started = performance.now(); await runtime.close()
    expect(performance.now() - started).toBeLessThan(500)
    expect(runtime.status().metrics).toMatchObject({ closed: true, inFlight: 0, dropped: 16, lastFailure: 'transport' })
    expect(wire.fetch).toHaveBeenCalledTimes(1)
  })

  it('bounds malformed internal counters and never admits arbitrary failure text or labels', async () => {
    const wire = receiver(), metrics = new RuntimeMetrics(parseTelemetryConfig(config), () => undefined, resourceFromAttributes({}), () => true, () => ({
      logs: { accepted: Infinity, exported: -2, rejected: NaN, dropped: Number.MAX_VALUE, failedBatches: 1.9,
        successfulBatches: 0, queued: 3, inFlight: 2, lastSuccessAt: 'invalid', lastFailure: 'PRIVATE_FAILURE' },
    }))
    cleanup.push(() => metrics.close()); await metrics.flush()
    expect(value(wire.point('records', 'logs', 'accepted'))).toBe(0)
    expect(value(wire.point('records', 'logs', 'exported'))).toBe(0)
    expect(value(wire.point('records', 'logs', 'dropped'))).toBe(Number.MAX_SAFE_INTEGER)
    expect(value(wire.point('batches', 'logs', 'failure'))).toBe(1)
    expect(value(wire.point('occupancy', 'logs', 'queued'))).toBe(3)
    expect(value(wire.point('occupancy', 'logs', 'in-flight'))).toBe(2)
    expect(value(wire.point('last_failure', 'logs', 'other'))).toBe(1)
    expect(value(wire.point('last_success', 'logs'))).toBe(0)
    expect(JSON.stringify(wire.batches)).not.toContain('PRIVATE_FAILURE')
  })

  it('keeps retained execution unchanged during receiver outages, repeated health flushes and stable-ID retry', async () => {
    let fail = true
    const wire = receiver(() => fail ? new Response(null, { status: 503 }) : ok())
    const runtime = await LocalRuntime.open({ dataDirectory: await mkdtemp(join(tmpdir(), 'jevable-exporter-health-')), telemetry: config })
    cleanup.push(() => runtime.close())
    const source = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8'), id = randomUUID()
    const run = await runtime.run(source, 'PRIVATE_INPUT', { id })
    expect(run.state.status).toBe('completed'); await runtime.telemetryFlush()
    fail = false; await runtime.telemetryFlush(); await runtime.telemetryFlush()
    expect(await runtime.show(id)).toEqual(run)
    expect(await runtime.run(source, 'PRIVATE_INPUT', { id })).toEqual(run)
    await runtime.telemetryFlush()
    expect(wire.points('jevable.execution.segments').map(value)).toEqual([1])
    expect(JSON.stringify(wire.batches)).not.toMatch(/PRIVATE_INPUT/)
    expect(JSON.stringify(wire.batches)).not.toContain(id)
  })
})

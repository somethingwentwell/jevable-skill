import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { SpanContext } from '@opentelemetry/api'
import { startRuntimeService } from '../src/http/service.ts'
import { startRuntimeServer, type RuntimeServiceHost } from '../src/http/server.ts'
import { LocalRuntime } from '../src/runtime/local.ts'
import { runReceipt } from '../src/runtime/receipts.ts'
import { RuntimeTelemetry } from '../src/telemetry/traces.ts'
import { observeHttpRequest } from '../src/telemetry/http.ts'
import { parseTelemetryConfig } from '../src/telemetry/config.ts'
import { PROTOCOL_VERSION } from '../src/capabilities.ts'
import type { HttpRateDebit, HttpRateDebitReceipt } from '../src/http/coordinated-rate-limits.ts'
import { HttpRateLimitError } from '../src/http/rate-limits.ts'

// Independent received-byte readers; no serializer interception or mocked exporter.
const { fields, logRecords, metricSums } = await import(new URL('../scripts/check-telemetry-package.mjs', import.meta.url).href)
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const token = 'a'.repeat(64), parent = `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Jevable-Protocol': PROTOCOL_VERSION,
  traceparent: parent, baggage: 'PRIVATE_BAGGAGE', tracestate: 'PRIVATE_TRACESTATE' }
const policy = { requests: { capacity: 2, refillTokens: 1, refillIntervalMs: 3600000 },
  controls: { capacity: 2, refillTokens: 1, refillIntervalMs: 3600000 } }
const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const attrs = (bytes: Buffer[]) => Object.fromEntries((bytes ?? []).map(bytes => {
  const kv = fields(bytes), value = fields(kv.get(2)[0])
  return [kv.get(1)[0].toString(), value.has(1) ? value.get(1)[0].toString() : value.has(2) ? Boolean(value.get(2)[0])
    : value.has(3) ? Number(value.get(3)[0]) : value.get(4)[0].readDoubleLE()]
}))
const records = (bytes: Buffer) => (fields(bytes).get(1) ?? []).flatMap((r: Buffer) =>
  (fields(r).get(2) ?? []).flatMap((s: Buffer) => fields(s).get(2) ?? []))
function spans(bytes: Buffer) {
  return records(bytes).map((raw: Buffer) => { const span = fields(raw)
    return { traceId: span.get(1)[0].toString('hex'), spanId: span.get(2)[0].toString('hex'),
      parent: span.get(4)?.[0].toString('hex'), name: span.get(5)[0].toString(), attributes: attrs(span.get(9)),
      status: Number(span.has(15) ? fields(span.get(15)[0]).get(3)?.[0] ?? 0n : 0n),
      links: (span.get(13) ?? []).map((bytes: Buffer) => { const link = fields(bytes)
        return { traceId: link.get(1)[0].toString('hex'), spanId: link.get(2)[0].toString('hex') } }) }
  })
}
const bounds = [0.001, 0.01, 0.1, 0.5, 1, 5, 10, 30, 60, 300, 3600]
function histograms(bytes: Buffer) {
  return records(bytes).flatMap((raw: Buffer) => { const metric = fields(raw)
    if (!metric.has(9)) return []
    const histogram = fields(metric.get(9)[0])
    return [{ name: metric.get(1)[0].toString(), temporality: Number(histogram.get(2)[0]),
      points: (histogram.get(1) ?? []).map((raw: Buffer) => { const point = fields(raw), buckets: number[] = []
        // OTLP HistogramDataPoint.bucket_counts is packed fixed64, not varint.
        const packed = point.get(6)?.[0] ?? Buffer.alloc(0)
        expect(packed.length % 8).toBe(0)
        for (let i = 0; i < packed.length; i += 8) buckets.push(Number(packed.readBigUInt64LE(i)))
        const limits: number[] = [], packedBounds = point.get(7)?.[0] ?? Buffer.alloc(0)
        for (let i = 0; i < packedBounds.length; i += 8) limits.push(packedBounds.readDoubleLE(i))
        return { labels: attrs(point.get(9)), count: Number(point.get(4)[0].readBigUInt64LE()),
          sum: point.get(5)[0].readDoubleLE(), buckets, bounds: limits }
      }) }]
  })
}
async function fixture(overrides = {}) {
  const packets: { path: string; bytes: Buffer }[] = []
  const collector = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
    packets.push({ path: req.url!, bytes: Buffer.concat(chunks) })
    res.writeHead(200, { 'Content-Type': 'application/x-protobuf' }); res.end()
  })
  await new Promise<void>((resolve, reject) => { collector.once('error', reject); collector.listen(0, '127.0.0.1', () => {
    collector.off('error', reject); resolve()
  }) })
  cleanup.push(() => new Promise<void>(resolve => { collector.close(() => resolve()); collector.closeAllConnections() }))
  const address = collector.address(); if (!address || typeof address === 'string') throw Error('listener')
  const base = `http://127.0.0.1:${address.port}`, config = parseTelemetryConfig({ endpoint: base + '/v1/traces',
    metricsEndpoint: base + '/v1/metrics', logsEndpoint: base + '/v1/logs', authentication: { kind: 'none' },
    httpAccessDecisions: true, httpRequests: true, intervalMs: 60000, timeoutMs: 1000, flushTimeoutMs: 2000, ...overrides })
  return { config, packets, spans: () => packets.filter(p => p.path === '/v1/traces').flatMap(p => spans(p.bytes)),
    logs: () => packets.filter(p => p.path === '/v1/logs').flatMap(p => logRecords(p.bytes)),
    metrics: () => packets.filter(p => p.path === '/v1/metrics').flatMap(p => metricSums(p.bytes)) }
}
const admit = (request: HttpRateDebit): HttpRateDebitReceipt => ({ requestId: request.requestId, scope: request.scope,
  policySha256: request.policySha256, lane: request.lane, admitted: true })
const isRate = (stage: unknown) => typeof stage === 'string' && /^(local|coordinated)-rate-(requests|controls)$/u.test(stage)
const rateLogs = (f: Awaited<ReturnType<typeof fixture>>) => f.logs().filter((l: any) => isRate(l.attributes['jevable.http.access.stage']))
const rateSpans = (f: Awaited<ReturnType<typeof fixture>>) => f.spans().filter(s => isRate(s.attributes['jevable.http.access.stage']))
async function host(f: Awaited<ReturnType<typeof fixture>>, extra: Partial<RuntimeServiceHost> = {}, options = {}) {
  const telemetry = new RuntimeTelemetry(f.config, () => undefined)
  const operation = vi.fn(async () => ({ observed: true }))
  const server = await startRuntimeServer({ token, actor: 'PRIVATE_ACTOR', ...options }, async () => ({
    capabilities: () => ({}), withTraceParent: (_p, work) => work(), operation,
    observeHttpAccess: stage => telemetry.observeHttpAccess(stage),
    observeHttpRequest: (method, path) => telemetry.observeHttpRequest(method, path),
    close: async () => { await telemetry.close() }, ...extra,
  }))
  cleanup.push(async () => { await server.close(); await server.closed })
  return { server, operation, telemetry }
}
const call = (url: string, command: unknown = { operation: 'projects.list' }, extra = {}, path = '/v1/operations', method = 'POST') =>
  fetch(url + path, { method, headers: { ...headers, ...extra }, ...(method === 'GET' ? {} : { body: JSON.stringify(command) }) })

for (const kind of ['local', 'coordinated'] as const) {
  it.each([
    { label: 'sampled', overrides: {}, access: true, requests: true, traces: true, logs: true, metrics: true },
    { label: 'unsampled', overrides: { sampleRatio: 0 }, access: true, requests: true, traces: false, logs: true, metrics: true },
    { label: 'access disabled', overrides: { httpAccessDecisions: false }, access: false, requests: true, traces: true, logs: true, metrics: true },
    { label: 'request disabled', overrides: { httpRequests: false }, access: true, requests: false, traces: true, logs: true, metrics: true },
    { label: 'logs only', overrides: { endpoint: undefined, metricsEndpoint: undefined }, access: true, requests: true, traces: false, logs: true, metrics: false },
    { label: 'metrics only', overrides: { endpoint: undefined, logsEndpoint: undefined }, access: true, requests: true, traces: false, logs: false, metrics: true },
    { label: 'traces only', overrides: { metricsEndpoint: undefined, logsEndpoint: undefined }, access: true, requests: true, traces: true, logs: false, metrics: false },
  ])(`${kind} quotas preserve admission/retained state and received correlation: $label`, async profile => {
    const f = await fixture(profile.overrides), dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-rate-wire-'))
    const balance = { requests: 2, controls: 2 }, scope = randomUUID(), debits: HttpRateDebit[] = []
    const consume = vi.fn(async (request: HttpRateDebit) => { debits.push(request)
      if (balance[request.lane] > 0) { balance[request.lane]--; return admit(request) }
      return { ...admit(request), admitted: false as const, retryAfterSeconds: 3600 }
    })
    const server = await startRuntimeService({ token, actor: 'PRIVATE_ACTOR', runtime: { dataDirectory, telemetry: f.config },
      ...(kind === 'local' ? { rateLimits: policy } : { coordinatedRateLimits: { scope, policy, timeoutMs: 1000, consume } }) })
    cleanup.push(async () => { await server.close(); await server.closed })
    const bad = await call(server.url, undefined, { Authorization: 'Bearer PRIVATE_KEY' }); expect(bad.status).toBe(401); await bad.json()
    const caps = await call(server.url, {}, {}, '/v1/capabilities', 'GET'); expect(caps.status).toBe(200); await caps.json()
    const runId = randomUUID(), refusedId = randomUUID()
    const started = await call(server.url, { operation: 'runs.start', id: runId, yaml: echo, input: 'PRIVATE_INPUT' })
    expect(started.status).toBe(200); const retained = (await started.json()).result
    expect(retained.status).toBe('completed')
    expect((await call(server.url)).status).toBe(200)
    const refused = await call(server.url, { operation: 'runs.start', id: refusedId, yaml: echo, input: 'PRIVATE_REFUSED' })
    expect(refused.status).toBe(429); expect(refused.headers.get('Retry-After')).toMatch(/^\d+$/u)
    expect(await refused.json()).toMatchObject({ code: 'rate-limit', execution: 'not-dispatched' })
    for (const expected of [200, 200, 429]) {
      const response = await call(server.url, {}, {}, '/v1/health', 'GET'); expect(response.status).toBe(expected); await response.json()
    }
    await server.close(); await server.closed
    const reader = await LocalRuntime.open({ dataDirectory })
    try { expect(JSON.parse(JSON.stringify(runReceipt(await reader.show(runId))))).toEqual(retained)
      await expect((async () => reader.show(refusedId))()).rejects.toThrow('not-found')
    } finally { await reader.close() }
    if (kind === 'coordinated') { expect(consume).toHaveBeenCalledTimes(6); expect(new Set(debits.map(d => d.requestId)).size).toBe(6) }
    const logs = rateLogs(f), rates = rateSpans(f)
    expect(logs).toHaveLength(profile.access && profile.logs ? 6 : 0)
    expect(rates).toHaveLength(profile.access && profile.traces ? 6 : 0)
    const expected = ['requests', 'controls'].flatMap(lane => ['admitted', 'admitted', 'refused'].map(outcome => `${kind}-rate-${lane}:${outcome}`)).sort()
    if (logs.length) expect(logs.map((l: any) => `${l.attributes['jevable.http.access.stage']}:${l.attributes['jevable.http.access.outcome']}`).sort()).toEqual(expected)
    for (const rate of rates) { expect(rate.parent).toBeUndefined(); expect(rate.traceId).not.toBe('1'.repeat(32)); expect(rate.status).toBe(0)
      if (profile.requests) {
        const requests = f.spans().filter(s => s.name === 'jevable.http.request' && s.links.some((l: any) => l.spanId === rate.spanId))
        expect(requests).toHaveLength(1); expect(requests[0]!.links).toEqual([{ traceId: rate.traceId, spanId: rate.spanId }])
        const request = requests[0]!, admittedOperation = request.attributes['http.response.status_code'] === 200 && request.attributes['http.request.method'] === 'POST'
        expect(request.parent).toBe(admittedOperation ? '2'.repeat(16) : undefined)
      }
    }
    if (profile.logs && profile.requests && profile.access) {
      const linked = f.logs().filter((l: any) => l.event === 'jevable.http.request.ended' && l.attributes['jevable.http.rate.span_id'])
      expect(linked).toHaveLength(6)
      for (const request of linked) {
        const matching = logs.filter((l: any) => l.spanId === request.attributes['jevable.http.rate.span_id'])
        expect(matching).toHaveLength(1); expect(matching[0].traceId).toBe(request.attributes['jevable.http.rate.trace_id'])
      }
    } else expect(f.logs().filter((l: any) => l.attributes['jevable.http.rate.span_id'])).toHaveLength(0)
    const totals = f.metrics().filter((m: any) => m.name === 'jevable.http.access.evaluations')
    if (profile.metrics && profile.access) {
      expect(totals).toHaveLength(1); const points = totals[0].points.filter((p: any) => isRate(p.labels['jevable.http.access.stage']))
      expect(points.reduce((n: number, p: any) => n + p.value, 0)).toBe(6)
      expect(points.map((p: any) => `${p.labels['jevable.http.access.stage']}:${p.labels['jevable.http.access.outcome']}:${p.value}`).sort()).toEqual([
        `${kind}-rate-controls:admitted:2`, `${kind}-rate-controls:refused:1`, `${kind}-rate-requests:admitted:2`, `${kind}-rate-requests:refused:1` ].sort())
      const durations = f.packets.filter(p => p.path === '/v1/metrics').flatMap(p => histograms(p.bytes))
        .filter(h => h.name === 'jevable.http.access.duration')
      expect(durations).toHaveLength(1); expect(durations[0]!.temporality).toBe(2)
      const ratePoints = durations[0]!.points.filter((p: any) => isRate(p.labels['jevable.http.access.stage']))
      expect(ratePoints.reduce((n: number, p: any) => n + p.count, 0)).toBe(6)
      for (const point of ratePoints) {
        expect(Object.keys(point.labels).sort()).toEqual(['jevable.http.access.outcome', 'jevable.http.access.stage'])
        expect(point.bounds).toEqual(bounds); expect(point.buckets).toHaveLength(bounds.length + 1)
        expect(point.buckets.reduce((n: number, c: number) => n + c, 0)).toBe(point.count)
        if (profile.logs) {
          const values = logs.filter((l: any) => l.attributes['jevable.http.access.stage'] === point.labels['jevable.http.access.stage']
            && l.attributes['jevable.http.access.outcome'] === point.labels['jevable.http.access.outcome'])
            .map((l: any) => l.attributes['jevable.duration.seconds'])
          expect(values).toHaveLength(point.count); expect(point.sum).toBeCloseTo(values.reduce((a: number, b: number) => a + b, 0), 10)
          const population = Array.from({ length: bounds.length + 1 }, () => 0)
          for (const value of values) { const i = bounds.findIndex(b => value <= b); population[i < 0 ? bounds.length : i]!++ }
          expect(point.buckets).toEqual(population)
        }
      }
    } else expect(totals).toHaveLength(0)
    for (const packet of f.packets) { expect(packet.bytes.includes('PRIVATE_')).toBe(false); expect(packet.bytes.includes(scope)).toBe(false)
      for (const debit of debits) { expect(packet.bytes.includes(debit.requestId)).toBe(false); expect(packet.bytes.includes(debit.policySha256)).toBe(false) }
    }
    for (const metric of f.metrics()) for (const point of metric.points)
      expect(Object.keys(point.labels).some(k => /trace|span|scope|request_id|policy/u.test(k))).toBe(false)
  })
}

it.each(['throw', 'forged-rate-error', 'thrown-rate-class', 'malformed', 'timeout'])('observes coordinator %s as failed without workflow dispatch/retry/refund', async mode => {
  const f = await fixture(), scope = randomUUID(), gate = Promise.withResolvers<HttpRateDebitReceipt>()
  let late: HttpRateDebit | undefined, signal: AbortSignal | undefined
  const consume = vi.fn(async (request: HttpRateDebit, abort: AbortSignal): Promise<HttpRateDebitReceipt> => {
    if (mode === 'throw') throw Error('PRIVATE_COORDINATOR_DETAIL')
    if (mode === 'forged-rate-error') throw { code: 'rate-limit', retryAfterSeconds: 1, message: 'PRIVATE_DENIAL' }
    if (mode === 'thrown-rate-class') throw new HttpRateLimitError(1)
    if (mode === 'malformed') return { ...admit(request), requestId: randomUUID() }
    late = request; signal = abort; return gate.promise
  })
  const { server, operation } = await host(f, {}, { coordinatedRateLimits: { scope, policy, timeoutMs: 100, consume } })
  const response = await call(server.url)
  expect(response.status).toBe(503); expect(response.headers.get('Retry-After')).toBeNull()
  expect(await response.json()).toMatchObject({ code: 'rate-coordinator-unavailable', execution: 'not-dispatched' })
  if (late) { expect(signal!.aborted).toBe(true); gate.resolve(admit(late)); await gate.promise }
  await server.close(); await server.closed
  expect(consume).toHaveBeenCalledOnce(); expect(operation).not.toHaveBeenCalled()
  const logs = rateLogs(f), rates = rateSpans(f); expect(logs).toHaveLength(1); expect(rates).toHaveLength(1)
  expect(logs[0].severity).toBe(17); expect(rates[0]!.status).toBe(2)
  expect(rates[0]!.attributes).toEqual({ 'jevable.http.access.stage': 'coordinated-rate-requests',
    'jevable.http.access.outcome': 'failed', 'error.type': 'http_access_failed' })
  expect(logs[0].spanId).toBe(rates[0]!.spanId)
  if (mode === 'timeout') expect(logs[0].attributes['jevable.duration.seconds']).toBeGreaterThanOrEqual(0.09)
  for (const p of f.packets) expect(p.bytes.includes('PRIVATE_')).toBe(false)
})

it('records drain during an acknowledged debit as failed, never dispatches and never refunds', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<HttpRateDebitReceipt>()
  let debit!: HttpRateDebit
  const consume = vi.fn(async (request: HttpRateDebit) => { debit = request; entered.resolve(); return gate.promise })
  const { server, operation } = await host(f, {}, { coordinatedRateLimits: { scope: randomUUID(), policy, timeoutMs: 1000, consume } })
  const pending = call(server.url); await entered.promise
  const close = server.close(); gate.resolve(admit(debit))
  const response = await pending; expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ code: 'draining' })
  await close; await server.closed
  expect(consume).toHaveBeenCalledOnce(); expect(operation).not.toHaveBeenCalled()
  expect(rateLogs(f).map((l: any) => l.attributes['jevable.http.access.outcome'])).toEqual(['failed'])
})

it.each(['start', 'end', 'context', 'link'])('contains throwing quota diagnostic %s hooks and preserves exactly one original dispatch', async mode => {
  const f = await fixture(), consume = vi.fn(async (request: HttpRateDebit) => admit(request)), end = vi.fn(() => {
    if (mode === 'end') throw Error('PRIVATE_DIAGNOSTIC')
  })
  const { server, operation } = await host(f, {
    observeHttpAccess(stage) { if (!isRate(stage)) return undefined
      if (mode === 'start') throw Error('PRIVATE_DIAGNOSTIC')
      return { end, traceContext() { if (mode === 'context') throw Error('PRIVATE_DIAGNOSTIC')
        return { traceId: 'b'.repeat(32), spanId: 'c'.repeat(16), traceFlags: 1 } } }
    }, observeHttpRequest: () => ({ run: (_parent, work) => work(), end() {}, linkRateAdmission() {
      if (mode === 'link') throw Error('PRIVATE_DIAGNOSTIC')
    } }),
  }, { coordinatedRateLimits: { scope: randomUUID(), policy, timeoutMs: 1000, consume } })
  const response = await call(server.url); expect(response.status).toBe(200); await response.json()
  await server.close(); await server.closed
  expect(consume).toHaveBeenCalledOnce(); expect(operation).toHaveBeenCalledOnce()
  expect(end).toHaveBeenCalledTimes(mode === 'start' ? 0 : 1)
})

it('bounds/detaches quota correlation and never starts the request before authenticated parent admission', () => {
  const context = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1, traceState: { PRIVATE: true } }
  const span = { spanContext: () => ({ traceId: '1'.repeat(32), spanId: 'c'.repeat(16), traceFlags: 1 }),
    setAttributes: vi.fn(), setStatus: vi.fn(), end: vi.fn() }
  const startSpan = vi.fn(() => span), settled = vi.fn(), parents = new AsyncLocalStorage<SpanContext | undefined>()
  const observation = observeHttpRequest({ startSpan } as any, parents, 'POST', '/v1/operations', settled)
  for (const value of [{ ...context, traceId: '0'.repeat(32) }, { ...context, traceFlags: 255 },
    { ...context, traceId: { toString: () => 'a'.repeat(32) } },
    { ...context, spanId: { toString: () => 'b'.repeat(16) } },
    { get traceId() { throw Error('PRIVATE_GETTER') } }]) observation.linkRateAdmission!(value as unknown as SpanContext)
  observation.linkRateAdmission!(context as unknown as SpanContext); expect(startSpan).not.toHaveBeenCalled()
  context.spanId = 'f'.repeat(16); observation.linkRateAdmission!({ traceId: 'd'.repeat(32), spanId: 'e'.repeat(16), traceFlags: 1 })
  expect(observation.run(parent, () => parents.getStore()?.spanId)).toBe('c'.repeat(16))
  expect((startSpan.mock.calls as any)[0][1].links).toEqual([{ context: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 } }])
  observation.end(200, true); observation.end(500, false); expect(settled).toHaveBeenCalledOnce()
  expect(settled.mock.calls[0]![0]['jevable.http.rate.span_id']).toBe('b'.repeat(16))
  expect(JSON.stringify(settled.mock.calls)).not.toContain('PRIVATE')
})

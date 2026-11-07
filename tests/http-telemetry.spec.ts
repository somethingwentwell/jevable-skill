import { afterEach, expect, it, vi } from 'vitest'
import { createServer, request as httpRequest } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProtobufTraceSerializer, JsonTraceSerializer, ProtobufMetricsSerializer, JsonMetricsSerializer,
  ProtobufLogsSerializer, JsonLogsSerializer } from '@opentelemetry/otlp-transformer'
import { startRuntimeService } from '../src/http/service.ts'
import { startRuntimeServer } from '../src/http/server.ts'
import { LocalRuntime } from '../src/runtime/local.ts'
import { RuntimeTelemetry } from '../src/telemetry/traces.ts'
import { parseTelemetryConfig } from '../src/telemetry/config.ts'
import { PROTOCOL_VERSION, capabilities } from '../src/capabilities.ts'
import { AsyncRunClient } from '../src/http/client.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const nativeDecision = await readFile(new URL('../examples/native-decision.yaml', import.meta.url), 'utf8')
const token = 'a'.repeat(64), parent = '00-11111111111111111111111111111111-2222222222222222-01'
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-jevable-protocol': PROTOCOL_VERSION }
const attrs = (value: any) => Object.fromEntries((value.attributes ?? []).map((a: any) => [a.key,
  a.value.stringValue ?? a.value.intValue ?? a.value.boolValue ?? a.value.doubleValue]))
async function fixture(overrides: Record<string, unknown> = {}) {
  const batches: Record<string, any[]> = { traces: [], metrics: [], logs: [] }, wire: Buffer[] = []
  const traceSerialize = ProtobufTraceSerializer.serializeRequest, metricSerialize = ProtobufMetricsSerializer.serializeRequest,
    logSerialize = ProtobufLogsSerializer.serializeRequest
  vi.spyOn(ProtobufTraceSerializer, 'serializeRequest').mockImplementation(value => {
    batches.traces!.push(JSON.parse(Buffer.from(JsonTraceSerializer.serializeRequest(value)!).toString())); return traceSerialize(value)
  })
  vi.spyOn(ProtobufMetricsSerializer, 'serializeRequest').mockImplementation(value => {
    batches.metrics!.push(JSON.parse(Buffer.from(JsonMetricsSerializer.serializeRequest(value)!).toString())); return metricSerialize(value)
  })
  vi.spyOn(ProtobufLogsSerializer, 'serializeRequest').mockImplementation(value => {
    batches.logs!.push(JSON.parse(Buffer.from(JsonLogsSerializer.serializeRequest(value)!).toString())); return logSerialize(value)
  })
  const collector = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
    wire.push(Buffer.concat(chunks)); res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.end()
  })
  await new Promise<void>((resolve, reject) => { collector.once('error', reject); collector.listen(0, '127.0.0.1', () => { collector.off('error', reject); resolve() }) })
  cleanup.push(() => new Promise<void>(resolve => { collector.close(() => resolve()); collector.closeAllConnections() }))
  const address = collector.address(); if (!address || typeof address === 'string') throw Error('listener')
  const base = `http://127.0.0.1:${address.port}`
  const config = parseTelemetryConfig({ endpoint: base + '/v1/traces', metricsEndpoint: base + '/v1/metrics', logsEndpoint: base + '/v1/logs',
    authentication: { kind: 'none' }, httpRequests: true, intervalMs: 60000, timeoutMs: 1000, flushTimeoutMs: 2000, ...overrides })
  const telemetry = new RuntimeTelemetry(config, () => undefined); cleanup.push(() => telemetry.close())
  const spans = () => batches.traces!.flatMap(b => b.resourceSpans.flatMap((r: any) => r.scopeSpans.flatMap((s: any) => s.spans)))
  const logs = () => batches.logs!.flatMap(b => b.resourceLogs.flatMap((r: any) => r.scopeLogs.flatMap((s: any) => s.logRecords)))
  const metrics = () => batches.metrics!.at(-1)?.resourceMetrics.flatMap((r: any) => r.scopeMetrics.flatMap((s: any) => s.metrics)) ?? []
  return { config, telemetry, spans, logs, metrics, batches, wire }
}
async function service(config: ReturnType<typeof parseTelemetryConfig>, options = {}) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-http-telemetry-'))
  const server = await startRuntimeService({ runtime: { dataDirectory, telemetry: config }, token, actor: 'PRIVATE_ACTOR', ...options })
  cleanup.push(async () => { await server.close(); await server.closed })
  const call = (path = '/v1/operations', body: unknown = { operation: 'projects.list' }, extraHeaders = {}, method = 'POST') =>
    fetch(server.url + path, { method, headers: { ...headers, ...extraHeaders }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) })
  return { server, call }
}

it('keeps request observations off by default and rejects non-boolean opt-ins', () => {
  const base = { endpoint: 'http://127.0.0.1/v1/traces', authentication: { kind: 'none' } }
  expect(parseTelemetryConfig(base).httpRequests).toBe(false)
  expect(() => parseTelemetryConfig({ ...base, httpRequests: 'true' })).toThrow('invalid-command')
})

it.each([0, 1])('keeps asynchronous execution ancestry after HTTP 202 while status/retry remains observation-only, sampling=%s', async sampleRatio => {
  const f = await fixture({ sampleRatio }), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  const source = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'async-telemetry', name: 'Async telemetry' },
    spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
      write: { type: 'llm', config: { provider: 'fixture', model: 'fixture', connection: { mode: 'workspace', id: 'fixture' },
        prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 20, stream: false }, historyScope: 'none',
        execution: { timeoutSeconds: 60, maxAttempts: 1 } } }, end: { type: 'output', config: { value: '${{ nodes.write.output }}' } } },
      edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }] } })
  const execute = vi.fn(async () => { entered.resolve(); await gate.promise; return { output: 'PRIVATE_MODEL_OUTPUT', usage: { tries: 1 } } })
  const server = await startRuntimeService({ runtime: { dataDirectory: await mkdtemp(join(tmpdir(), 'jevable-async-http-otel-')),
    telemetry: f.config, models: { admit() {}, async verify() {}, execute } }, token, actor: 'PRIVATE_ACTOR', asyncRuns: { maxConcurrentRuns: 1 } })
  cleanup.push(async () => { gate.resolve(); await server.close(); await server.closed })
  const id = randomUUID(), client = new AsyncRunClient(server.url, token, server.instanceId)
  const command = { kind: 'workflow' as const, id, yaml: source, input: 'PRIVATE_INPUT' }
  const ancestor = parent.slice(0, -2) + (sampleRatio ? '01' : '00')
  expect(await client.start(command, ancestor)).toMatchObject({ observation: 'created' }); await entered.promise
  const observed = await fetch(server.url + '/v1/async-runs/' + id, { headers: { ...headers, 'x-jevable-instance': server.instanceId, traceparent: parent } })
  expect(observed.status).toBe(200); expect(await observed.json()).toMatchObject({ run: { status: 'executing' } })
  const flush = await fetch(server.url + '/v1/operations', { method: 'POST', headers, body: JSON.stringify({ operation: 'telemetry.flush' }) })
  expect(flush.status).toBe(200); await flush.json()
  const slots = f.metrics().find((metric: any) => metric.name === 'jevable.http.async.slots')
  const discovery = capabilities().workflowRuntime.httpAsyncCapacityTelemetry
  expect(discovery.instrument).toMatchObject({ name: slots.name, unit: slots.unit, monotonic: slots.sum.isMonotonic })
  expect(Object.keys(discovery.pointLabels)).toEqual(Object.keys(attrs(slots.sum.dataPoints[0])))
  expect(slots.sum.dataPoints.map((point: any) => attrs(point)['jevable.http.async.phase']).sort())
    .toEqual([...discovery.pointLabels['jevable.http.async.phase']].sort())
  expect(slots.sum.isMonotonic).toBe(false)
  expect(slots.unit).toBe('{slot}')
  expect(Object.fromEntries(slots.sum.dataPoints.map((point: any) => [attrs(point)['jevable.http.async.phase'], Number(point.asInt ?? point.asDouble)])))
    .toEqual({ admitting: 0, completing: 1 })
  for (const point of slots.sum.dataPoints) expect(Object.keys(attrs(point))).toEqual(['jevable.http.async.phase'])
  gate.resolve()
  await vi.waitFor(async () => { expect((await client.show(id)).run.status).toBe('completed') })
  expect(await client.start(command, ancestor)).toMatchObject({ observation: 'retained' })
  await server.close(); await server.closed
  expect(execute).toHaveBeenCalledTimes(1)
  const settledSlots = f.metrics().find((metric: any) => metric.name === 'jevable.http.async.slots')
  expect(Object.fromEntries(settledSlots.sum.dataPoints.map((point: any) => [attrs(point)['jevable.http.async.phase'], Number(point.asInt ?? point.asDouble)])))
    .toEqual({ admitting: 0, completing: 0 })
  const spans = f.spans(), execution = spans.filter(s => s.name === 'jevable.run'), requests = spans.filter(s => s.name === 'jevable.http.request')
  if (sampleRatio) {
    expect(execution).toHaveLength(1)
    const admission = requests.find(s => attrs(s)['http.response.status_code'] === 202)!
    expect(admission.traceId).toBe('11111111111111111111111111111111'); expect(admission.parentSpanId).toBe('2222222222222222')
    expect(execution[0].parentSpanId).toBe(admission.spanId)
    expect(BigInt(execution[0].endTimeUnixNano)).toBeGreaterThan(BigInt(admission.endTimeUnixNano))
    const reads = requests.filter(s => attrs(s)['http.route'] === '/v1/async-runs/{id}')
    expect(reads.length).toBeGreaterThanOrEqual(2)
    for (const read of reads) expect(read.parentSpanId).toBeUndefined()
  } else expect(spans).toHaveLength(0)
  const points = f.metrics().find((metric: any) => metric.name === 'jevable.http.requests').sum.dataPoints
  expect(points.some((point: any) => attrs(point)['http.route'] === '/v1/async-runs')).toBe(true)
  expect(points.some((point: any) => attrs(point)['http.route'] === '/v1/async-runs/{id}')).toBe(true)
  expect(JSON.stringify(points)).not.toContain(id)
  expect(f.logs().some(log => log.eventName === 'jevable.http.request.ended')).toBe(true)
  expect(JSON.stringify(f.batches)).not.toContain('PRIVATE_'); expect(Buffer.concat(f.wire).includes(Buffer.from('PRIVATE_'))).toBe(false)
})

it.each([false, true])('observes held async admission and releases a readiness refusal, sampling=%s', async sampled => {
  const f = await fixture({ sampleRatio: sampled ? 1 : 0 }), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  const execute = vi.fn(), admit = vi.fn(async () => { entered.resolve(); await gate.promise; throw Error('PRIVATE_READINESS_REFUSAL') })
  const server = await startRuntimeService({ runtime: { dataDirectory: await mkdtemp(join(tmpdir(), 'jevable-async-slots-refusal-')),
    telemetry: f.config, models: { admit, execute, async verify() {} } }, token, actor: 'PRIVATE_ACTOR', asyncRuns: { maxConcurrentRuns: 1 } })
  cleanup.push(async () => { gate.resolve(); await server.close(); await server.closed })
  const raw = (path: string, body: unknown) => fetch(server.url + path, { method: 'POST', headers: { ...headers, 'x-jevable-instance': server.instanceId }, body: JSON.stringify(body) })
  const command = { kind: 'workflow', id: randomUUID(), yaml: nativeDecision, input: 'PRIVATE_INPUT', paused: true }
  const pending = raw('/v1/async-runs', command)
  try {
    await entered.promise
    const flush = await raw('/v1/operations', { operation: 'telemetry.flush' }); expect(flush.status).toBe(200); await flush.json()
    const metric = f.metrics().find((m: any) => m.name === 'jevable.http.async.slots')
    expect(metric.sum.dataPoints).toHaveLength(1)
    expect(attrs(metric.sum.dataPoints[0])).toEqual({ 'jevable.http.async.phase': 'admitting' })
    expect(Number(metric.sum.dataPoints[0].asInt ?? metric.sum.dataPoints[0].asDouble)).toBe(1)
    expect((await raw('/v1/async-runs', { ...command, id: randomUUID() })).status).toBe(429)
  } finally { gate.resolve() }
  const refused = await pending; expect(refused.status).toBe(500); await refused.json()
  await server.close(); await server.closed
  const ended = f.metrics().find((m: any) => m.name === 'jevable.http.async.slots')
  expect(ended.sum.dataPoints).toHaveLength(1)
  expect(Number(ended.sum.dataPoints[0].asInt ?? ended.sum.dataPoints[0].asDouble)).toBe(0)
  expect(execute).not.toHaveBeenCalled(); expect(admit).toHaveBeenCalledOnce()
  expect(JSON.stringify(f.batches)).not.toMatch(/PRIVATE_|READINESS_REFUSAL/)
})

it.each([false, true])('links admitted API, execution, journal and logs only with opt-in=%s', async enabled => {
  const f = await fixture({ httpRequests: enabled }), { server, call } = await service(f.config)
  const id = randomUUID(), command = { operation: 'runs.start', id, yaml: echo, input: 'PRIVATE_INPUT' }
  const response = await call(undefined, command, { traceparent: parent, baggage: 'PRIVATE_BAGGAGE', tracestate: 'PRIVATE_STATE' })
  expect(response.status).toBe(200); const result = (await response.json()).result
  const retry = await call(undefined, command, { traceparent: parent }); expect(retry.status).toBe(200)
  expect((await retry.json()).result).toEqual(result)
  await server.close(); await server.closed
  const api = f.spans().filter(s => s.name === 'jevable.http.request'), execution = f.spans().find(s => s.name === 'jevable.run')
  expect(api).toHaveLength(enabled ? 2 : 0)
  expect(f.spans().filter(s => s.name === 'jevable.run')).toHaveLength(1)
  expect(execution.parentSpanId).toBe(enabled ? api[0].spanId : '2222222222222222')
  if (enabled) {
    expect(api[0].parentSpanId).toBe('2222222222222222'); expect(api[0].kind).toBe(2)
    expect(api[0].traceId).toBe('11111111111111111111111111111111')
    expect(api[0].status?.code ?? 0).toBe(0)
    expect(result.traceSegments[0].parent.spanId).toBe(api[0].spanId)
    expect(attrs(api[0])).toMatchObject({ 'http.response.status_code': 200, 'http.route': '/v1/operations', 'jevable.http.outcome': 'response-finished' })
    const log = f.logs().find(l => l.eventName === 'jevable.http.request.ended' && l.spanId === api[0].spanId)
    expect(log.traceId).toBe(api[0].traceId)
    const points = f.metrics().find((m: any) => m.name === 'jevable.http.requests').sum.dataPoints
    expect(points).toHaveLength(1); expect(Number(points[0].asInt ?? points[0].asDouble)).toBe(2)
    expect(attrs(points[0])).toEqual({ 'http.request.method': 'POST', 'http.route': '/v1/operations', 'jevable.http.status_class': '2xx', 'jevable.http.outcome': 'response-finished' })
  }
  expect(JSON.stringify(f.batches)).not.toContain('PRIVATE_')
  expect(Buffer.concat(f.wire).includes(Buffer.from('PRIVATE_'))).toBe(false)
})

it.each([
  ['unauthorized', '/v1/operations', { authorization: 'Bearer PRIVATE_TOKEN', traceparent: parent }, 'POST', 401],
  ['bad parent', '/v1/operations', { traceparent: 'PRIVATE_INVALID_PARENT' }, 'POST', 400],
  ['origin', '/v1/operations', { origin: 'https://PRIVATE_ORIGIN.example' }, 'POST', 403],
  ['proxy', '/v1/operations', { forwarded: 'PRIVATE_PROXY' }, 'POST', 403],
  ['protocol', '/v1/operations', { 'x-jevable-protocol': 'PRIVATE_PROTOCOL' }, 'POST', 409],
  ['instance', '/v1/operations', { 'x-jevable-instance': 'PRIVATE_INSTANCE' }, 'POST', 409],
  ['unknown', '/PRIVATE_PATH', { traceparent: parent }, 'POST', 404],
  ['query', '/v1/operations?PRIVATE_QUERY', { traceparent: parent }, 'POST', 400],
  ['method', '/v1/operations', {}, 'DELETE', 405],
  ['media', '/v1/operations', { 'content-type': 'text/plain' }, 'POST', 415],
] as const)('observes %s refusal without trusting or leaking inbound metadata', async (_name, path, extra, method, status) => {
  const f = await fixture(), { server, call } = await service(f.config)
  expect((await call(path, undefined, extra, method)).status).toBe(status)
  await server.close(); await server.closed
  const [span] = f.spans(); expect(f.spans()).toHaveLength(1)
  expect(attrs(span)['http.response.status_code']).toBe(status)
  expect(span.parentSpanId).toBeUndefined(); expect(span.traceId).not.toBe('11111111111111111111111111111111')
  expect(span.status?.code ?? 0).toBe(0)
  expect(JSON.stringify(f.batches)).not.toContain('PRIVATE_')
})

it('uses the actual response limit status and does not record a fabricated successful operation', async () => {
  const f = await fixture(), { server, call } = await service(f.config, { maxResponseBytes: 1024 })
  expect((await call('/v1/capabilities', undefined, {}, 'GET')).status).toBe(413)
  await server.close(); await server.closed
  expect(attrs(f.spans()[0])['http.response.status_code']).toBe(413)
})

it('sanitizes server failures and marks 5xx as errors', async () => {
  const f = await fixture(), { server, call } = await service(f.config)
  vi.spyOn(LocalRuntime.prototype, 'projects').mockImplementation(() => { throw new Error('PRIVATE_DATABASE_ERROR') })
  expect((await call()).status).toBe(500)
  await server.close(); await server.closed
  expect(f.spans()[0].status.code).toBe(2)
  expect(attrs(f.spans()[0])['error.type']).toBe('500')
  expect(JSON.stringify(f.batches)).not.toContain('PRIVATE_')
})

it.each(['malformed', 'oversized', 'duplicate'])('observes %s body/header admission without recording content', async kind => {
  const f = await fixture(), { server } = await service(f.config, { maxRequestBytes: 1024 })
  const url = new URL(server.url)
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const rawHeaders = ['Host', url.host, 'Authorization', `Bearer ${token}`, 'Content-Type', 'application/json', 'X-Jevable-Protocol', PROTOCOL_VERSION]
    if (kind === 'duplicate') rawHeaders.push('traceparent', parent, 'traceparent', parent)
    // The server rejects a declared oversize body before reading it. Sending
    // that body races its Connection: close response and can hide the 413
    // behind a client ECONNRESET on loaded hosts. Streamed limits are covered
    // separately in http.spec.ts; this case checks header admission telemetry.
    if (kind === 'oversized') rawHeaders.push('Content-Length', '1025')
    const request = httpRequest(server.url + '/v1/operations', { method: 'POST', headers: rawHeaders }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode))
    })
    request.on('error', reject); request.end(kind === 'oversized' ? undefined : '{PRIVATE_BODY')
  })
  expect(status).toBe(kind === 'oversized' ? 413 : 400)
  await server.close(); await server.closed
  expect(f.spans()).toHaveLength(1); expect(attrs(f.spans()[0])['http.response.status_code']).toBe(status)
  expect(f.spans()[0].parentSpanId).toBeUndefined(); expect(JSON.stringify(f.batches)).not.toContain('PRIVATE_')
})

it('observes HTML/bootstrap/scoped execution/logout without exporting tokens or trusting non-operation parents', async () => {
  const f = await fixture(), { server, call } = await service(f.config, { preview: { source: echo } })
  const page = await call('/', undefined, { traceparent: parent }, 'GET'); expect(page.status).toBe(200); await page.text()
  const boot = await call('/v1/preview/bootstrap', {}, { traceparent: parent }); expect(boot.status).toBe(200)
  const session = (await boot.json()).result
  const scopedHeaders = { authorization: `Bearer ${session.token}`, traceparent: parent }
  const run = await call('/v1/preview/operations', { operation: 'run', id: randomUUID(), input: 'PRIVATE_PREVIEW_INPUT' }, scopedHeaders)
  expect(run.status).toBe(200); await run.json()
  expect((await call('/v1/preview/logout', {}, scopedHeaders)).status).toBe(200)
  expect((await call('/v1/preview/operations', { operation: 'view' }, scopedHeaders)).status).toBe(401)
  await server.close(); await server.closed
  const api = f.spans().filter(s => s.name === 'jevable.http.request'); expect(api).toHaveLength(5)
  for (const span of api) expect(span.parentSpanId).toBe(attrs(span)['http.route'] === '/v1/preview/operations'
    && attrs(span)['http.response.status_code'] === 200 ? '2222222222222222' : undefined)
  expect(JSON.stringify(f.batches)).not.toContain(session.token); expect(JSON.stringify(f.batches)).not.toContain('PRIVATE_')
})

it('does not fail or redispatch an operation when observation creation or settlement throws', async () => {
  let calls = 0, observations = 0
  const server = await startRuntimeServer({ token, actor: 'owner' }, async () => ({
    capabilities: () => ({}), withTraceParent: (_parent, op) => op(),
    observeHttpRequest: () => { if (++observations === 1) throw Error('PRIVATE_DIAGNOSTIC'); return { run: (_parent, op) => op(), end() { throw Error('PRIVATE_DIAGNOSTIC') } } },
    operation: async () => ({ count: ++calls }), close: async () => {},
  }))
  cleanup.push(async () => { await server.close(); await server.closed })
  for (const count of [1, 2]) {
    const response = await fetch(server.url + '/v1/operations', { method: 'POST', headers, body: '{}' })
    expect(response.status).toBe(200); expect((await response.json()).result).toEqual({ count })
  }
  await server.close(); await server.closed; expect(calls).toBe(2)
})

it.each([{ sampleRatio: 0 }, { endpoint: undefined }])('retains unsampled correlation and independent metrics/logs: %j', async overrides => {
  const f = await fixture(overrides), { server, call } = await service(f.config)
  expect((await call()).status).toBe(200)
  await server.close(); await server.closed
  expect(f.spans()).toHaveLength(0); expect(f.logs()).toHaveLength(1)
  expect(f.logs()[0].traceId).toMatch(/^[a-f0-9]{32}$/u)
  expect(f.metrics().find((m: any) => m.name === 'jevable.http.duration').histogram.dataPoints[0].count).toBe(1)
})

it('bounds attacker-controlled labels and settles each request once', async () => {
  const f = await fixture({ endpoint: undefined })
  for (let i = 0; i < 160; i++) {
    const request = f.telemetry.observeHttpRequest('PRIVATE_METHOD_' + i, '/PRIVATE_URL_' + i)!
    request.end(401, true); request.end(500, false)
  }
  await f.telemetry.flush()
  const metric = f.metrics().find((m: any) => m.name === 'jevable.http.requests')
  expect(metric.sum.dataPoints).toHaveLength(1)
  expect(Number(metric.sum.dataPoints[0].asInt ?? metric.sum.dataPoints[0].asDouble)).toBe(160)
  expect(attrs(metric.sum.dataPoints[0])).toEqual({ 'http.request.method': '_OTHER', 'jevable.http.status_class': '4xx', 'jevable.http.outcome': 'response-finished' })
  expect(JSON.stringify(f.batches)).not.toContain('PRIVATE_')
})

it('keeps concurrent parents isolated and waits for disconnected handler settlement during drain', async () => {
  const f = await fixture(), releases: (() => void)[] = []
  const server = await startRuntimeServer({ token, actor: 'owner', maxConcurrentRequests: 2 }, async () => ({
    capabilities: () => ({}), withTraceParent: (parent, op) => f.telemetry.withParent(parent, op),
    observeHttpRequest: (method, path) => f.telemetry.observeHttpRequest(method, path),
    operation: async () => { await new Promise<void>(resolve => releases.push(resolve)); const child = f.telemetry.start('jevable.run', {}); f.telemetry.end(child, 'completed'); return {} },
    close: () => f.telemetry.close().then(() => {}),
  }))
  cleanup.push(async () => { for (const release of releases) release(); await server.close(); await server.closed })
  const request = httpRequest(server.url + '/v1/operations', { method: 'POST', headers: { ...headers, traceparent: parent } })
  request.on('error', () => {}); request.end('{}')
  await vi.waitFor(() => expect(releases).toHaveLength(1))
  const secondParent = '00-33333333333333333333333333333333-4444444444444444-01'
  const second = fetch(server.url + '/v1/operations', { method: 'POST', headers: { ...headers, traceparent: secondParent }, body: '{}' })
  await vi.waitFor(() => expect(releases).toHaveLength(2))
  expect((await fetch(server.url + '/v1/health', { headers })).status).toBe(429)
  request.destroy()
  expect((await server.close(10)).status).toBe('draining')
  releases[1]!(); expect((await second).status).toBe(200)
  releases[0]!(); await server.closed
  const spans = f.spans(), first = spans.find(s => s.name === 'jevable.http.request' && s.traceId === '11111111111111111111111111111111'),
    other = spans.find(s => s.name === 'jevable.http.request' && s.traceId === '33333333333333333333333333333333')
  expect(attrs(first)).toMatchObject({ 'jevable.http.outcome': 'disconnected', 'jevable.http.status_class': 'none', 'error.type': 'client_disconnected' })
  expect(attrs(first)['http.response.status_code']).toBeUndefined(); expect(first.status.code).toBe(2)
  for (const api of [first, other]) expect(spans.find(s => s.name === 'jevable.run' && s.traceId === api.traceId).parentSpanId).toBe(api.spanId)
  expect(spans.filter(s => s.name === 'jevable.http.request')).toHaveLength(3)
})

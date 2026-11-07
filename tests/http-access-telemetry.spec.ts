import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { randomUUID, createHmac } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProtobufTraceSerializer, JsonTraceSerializer, ProtobufMetricsSerializer, JsonMetricsSerializer,
  ProtobufLogsSerializer, JsonLogsSerializer } from '@opentelemetry/otlp-transformer'
import { ROOT_CONTEXT } from '@opentelemetry/api'
import { httpAccessGuard, httpAccessGuardAsync, HTTP_ACCESS_STAGES } from '../src/http/access-observation.ts'
import { observeHttpAccess } from '../src/telemetry/http-access.ts'
import { parseTelemetryConfig } from '../src/telemetry/config.ts'
import { RuntimeTelemetry } from '../src/telemetry/traces.ts'
import { startRuntimeService } from '../src/http/service.ts'
import { LocalRuntime, prepareGrantToken } from '../src/runtime/index.ts'
import { capabilities, httpAccessTelemetryCapability, CORE_VERSION, PROTOCOL_VERSION } from '../src/capabilities.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const api = await readFile(new URL('../examples/api-echo.yaml', import.meta.url), 'utf8')
const token = 'a'.repeat(64), parent = `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Jevable-Protocol': PROTOCOL_VERSION,
  traceparent: parent, baggage: 'PRIVATE_BAGGAGE', tracestate: 'PRIVATE_STATE' }
const attrs = (v: any): Record<string, any> => Object.fromEntries((v.attributes ?? []).map((a: any) => [a.key,
  a.value.stringValue ?? a.value.intValue ?? a.value.boolValue ?? a.value.doubleValue]))
async function fixture(options = {}) {
  const batches: Record<string, any[]> = { traces: [], metrics: [], logs: [] }, wire: Buffer[] = []
  const ts = ProtobufTraceSerializer.serializeRequest, ms = ProtobufMetricsSerializer.serializeRequest, ls = ProtobufLogsSerializer.serializeRequest
  vi.spyOn(ProtobufTraceSerializer, 'serializeRequest').mockImplementation(v => { batches.traces!.push(JSON.parse(Buffer.from(JsonTraceSerializer.serializeRequest(v)!).toString())); return ts(v) })
  vi.spyOn(ProtobufMetricsSerializer, 'serializeRequest').mockImplementation(v => { batches.metrics!.push(JSON.parse(Buffer.from(JsonMetricsSerializer.serializeRequest(v)!).toString())); return ms(v) })
  vi.spyOn(ProtobufLogsSerializer, 'serializeRequest').mockImplementation(v => { batches.logs!.push(JSON.parse(Buffer.from(JsonLogsSerializer.serializeRequest(v)!).toString())); return ls(v) })
  const collector = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
    wire.push(Buffer.concat(chunks)); res.writeHead(200, { 'Content-Type': 'application/x-protobuf' }); res.end() })
  await new Promise<void>((resolve, reject) => { collector.once('error', reject); collector.listen(0, '127.0.0.1', () => { collector.off('error', reject); resolve() }) })
  cleanup.push(() => new Promise<void>(resolve => { collector.close(() => resolve()); collector.closeAllConnections() }))
  const address = collector.address(); if (!address || typeof address === 'string') throw Error('listener')
  const base = `http://127.0.0.1:${address.port}`, config = parseTelemetryConfig({ endpoint: base + '/v1/traces',
    logsEndpoint: base + '/v1/logs', metricsEndpoint: base + '/v1/metrics', authentication: { kind: 'none' },
    httpAccessDecisions: true, httpRequests: false, intervalMs: 60000, timeoutMs: 1000, flushTimeoutMs: 2000, ...options })
  return { config, batches, wire,
    spans: () => batches.traces!.flatMap(b => b.resourceSpans.flatMap((r: any) => r.scopeSpans.flatMap((s: any) => s.spans))),
    logs: () => batches.logs!.flatMap(b => b.resourceLogs.flatMap((r: any) => r.scopeLogs.flatMap((s: any) => s.logRecords))),
    metrics: () => batches.metrics!.at(-1)?.resourceMetrics.flatMap((r: any) => r.scopeMetrics.flatMap((s: any) => s.metrics)) ?? [] }
}
async function service(f: Awaited<ReturnType<typeof fixture>>, options = {}) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-http-access-'))
  const server = await startRuntimeService({ runtime: { dataDirectory, telemetry: f.config }, token, actor: 'PRIVATE_ACTOR', ...options })
  cleanup.push(async () => { await server.close(); await server.closed })
  const call = (extra = {}, path = '/v1/operations', command: unknown = { operation: 'projects.list' }, method = 'POST') =>
    fetch(server.url + path, { method, headers: { ...headers, ...extra }, ...(method === 'GET' ? {} : { body: JSON.stringify(command) }) })
  return { server, call }
}
const accessLogs = (f: Awaited<ReturnType<typeof fixture>>) => f.logs().filter(l => l.eventName === 'jevable.http.access.ended')

describe('optional transport-access observations', () => {
  it('is strict, off by default, independent from HTTP request spans and discoverable on both owner profiles', () => {
    const base = { endpoint: 'http://127.0.0.1/v1/traces', authentication: { kind: 'none' } }
    expect(parseTelemetryConfig(base).httpAccessDecisions).toBe(false)
    expect(parseTelemetryConfig({ ...base, httpAccessDecisions: true }).httpRequests).toBe(false)
    for (const value of ['true', 1, null, {}, []]) expect(() => parseTelemetryConfig({ ...base, httpAccessDecisions: value })).toThrow('invalid-command')
    expect(capabilities().workflowRuntime.httpAccessTelemetry).toEqual(httpAccessTelemetryCapability())
    expect(httpAccessTelemetryCapability().stages).toEqual([...HTTP_ACCESS_STAGES])
    const detached = httpAccessTelemetryCapability(); detached.stages.splice(0)
    expect(httpAccessTelemetryCapability().stages).toHaveLength(13)
  })
  it.each(['normal', 'start-throws', 'end-throws', 'classify-throws'])('preserves exactly one synchronous predicate and its original values/errors: %s', kind => {
    const error = Error('PRIVATE_ORIGINAL'), result = {}, end = vi.fn((_outcome: string) => { if (kind === 'end-throws') throw Error('PRIVATE_DIAGNOSTIC') })
    const observe = vi.fn(() => { if (kind === 'start-throws') throw Error('PRIVATE_DIAGNOSTIC'); return { end } })
    const classify = () => { if (kind === 'classify-throws') throw Error('PRIVATE_CLASSIFIER'); return true }
    const work = vi.fn(() => result); expect(httpAccessGuard(observe, work, classify)).toBe(result); expect(work).toHaveBeenCalledOnce()
    const fail = vi.fn(() => { throw error }); expect(() => httpAccessGuard(observe, fail, classify)).toThrow(error); expect(fail).toHaveBeenCalledOnce()
    if (kind !== 'start-throws') expect(end.mock.calls.map(c => c[0])).toEqual(['admitted', kind === 'classify-throws' ? 'failed' : 'refused'])
  })
  it.each(['normal', 'start-throws', 'end-throws', 'classify-throws'])('preserves exactly one awaited predicate and original rejection: %s', async kind => {
    const error = Error('PRIVATE_ORIGINAL'), result = {}, end = vi.fn((_outcome: string) => { if (kind === 'end-throws') throw Error('PRIVATE_DIAGNOSTIC') })
    const observe = () => { if (kind === 'start-throws') throw Error('PRIVATE_DIAGNOSTIC'); return { end } }
    const classify = () => { if (kind === 'classify-throws') throw Error('PRIVATE_CLASSIFIER'); return true }
    const work = vi.fn(async () => result); expect(await httpAccessGuardAsync(observe, work, classify)).toBe(result); expect(work).toHaveBeenCalledOnce()
    const fail = vi.fn(async () => { throw error }); await expect(httpAccessGuardAsync(observe, fail, classify)).rejects.toBe(error); expect(fail).toHaveBeenCalledOnce()
    if (kind !== 'start-throws') expect(end.mock.calls.map(c => c[0])).toEqual(['admitted', kind === 'classify-throws' ? 'failed' : 'refused'])
  })
  it.each(['admitted', 'refused', 'failed'] as const)('ends one independent root with bounded %s attributes and fixed failure detail', outcome => {
    const span = { setAttributes: vi.fn(), setStatus: vi.fn(), end: vi.fn(), spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }) }
    const tracer = { startSpan: vi.fn((_name: string, _options: unknown, _context: unknown) => span) }, settled = vi.fn(), observation = observeHttpAccess(tracer as any, 'owner-key', settled)
    observation.end(outcome); observation.end('failed')
    expect(tracer.startSpan.mock.calls[0]?.[2]).toBe(ROOT_CONTEXT); expect(span.end).toHaveBeenCalledOnce(); expect(settled).toHaveBeenCalledOnce()
    expect(settled.mock.calls[0]?.[0]).toEqual({ 'jevable.http.access.stage': 'owner-key', 'jevable.http.access.outcome': outcome,
      ...(outcome === 'failed' ? { 'error.type': 'http_access_failed' } : {}) })
    expect(span.setStatus).toHaveBeenCalledTimes(outcome === 'failed' ? 1 : 0)
  })
  it('rejects unknown diagnostic stages, emits nothing after close and does not adopt an explicitly set request parent', async () => {
    const f = await fixture(), telemetry = new RuntimeTelemetry(f.config, () => undefined)
    expect(telemetry.observeHttpAccess('PRIVATE_STAGE' as never)).toBeUndefined()
    telemetry.withParent(parent, () => telemetry.observeHttpAccess('owner-key')?.end('admitted'))
    await telemetry.close(); expect(telemetry.observeHttpAccess('owner-key')).toBeUndefined()
    expect(f.spans()[0].parentSpanId).toBeUndefined(); expect(f.spans()[0].traceId).not.toBe('1'.repeat(32))
  })
  it.each([[false, 0], [false, 1], [true, 0], [true, 1]] as const)('observes entered checks, not HTTP status or mutations, enabled=%s sampled=%s', async (httpAccessDecisions, sampleRatio) => {
    const f = await fixture({ httpAccessDecisions, sampleRatio }), { server, call } = await service(f)
    const projects = vi.spyOn(LocalRuntime.prototype, 'projects')
    for (const [extra, status] of [[{ Authorization: 'Bearer PRIVATE_TOKEN' }, 401], [{ Origin: 'https://PRIVATE_ORIGIN.invalid' }, 403],
      [{ 'X-Jevable-Instance': randomUUID() }, 409], [{ 'X-Jevable-Protocol': 'PRIVATE_PROTOCOL' }, 409]] as const) {
      const response = await call(extra); expect(response.status).toBe(status); await response.json()
    }
    const caps = await call({}, '/v1/capabilities', {}, 'GET'); expect(caps.status).toBe(200)
    expect((await caps.json()).workflowRuntime.httpAccessTelemetry).toEqual(httpAccessTelemetryCapability())
    const good = await call(); expect(good.status).toBe(200); await good.json()
    await server.close(); await server.closed; expect(projects).toHaveBeenCalledOnce()
    const logs = accessLogs(f), spans = f.spans().filter(s => s.name === 'jevable.http.access')
    expect(logs).toHaveLength(httpAccessDecisions ? 17 : 0); expect(spans).toHaveLength(httpAccessDecisions && sampleRatio ? 17 : 0)
    const total = f.metrics().find((m: any) => m.name === 'jevable.http.access.evaluations')
    if (httpAccessDecisions) {
      expect(total.unit).toBe('{evaluation}'); expect(total.sum.isMonotonic).toBe(true)
      expect(total.sum.dataPoints.reduce((n: number, p: any) => n + Number(p.asInt ?? p.asDouble), 0)).toBe(17)
      for (const p of total.sum.dataPoints) expect(Object.keys(attrs(p)).sort()).toEqual(['jevable.http.access.outcome', 'jevable.http.access.stage'])
      const histogram = f.metrics().find((m: any) => m.name === 'jevable.http.access.duration')
      expect(histogram.unit).toBe('s'); expect(histogram.histogram.dataPoints.reduce((n: number, p: any) => n + Number(p.count), 0)).toBe(17)
      for (const log of logs) { expect(log.severityText).toBe('INFO'); expect(attrs(log)['error.type']).toBeUndefined() }
      for (const span of spans) { expect(span.parentSpanId).toBeUndefined(); expect(span.traceId).not.toBe('1'.repeat(32))
        expect(logs.some(l => l.traceId === span.traceId && l.spanId === span.spanId)).toBe(true) }
    } else expect(total).toBeUndefined()
    expect(f.spans().some(s => s.name === 'jevable.http.request')).toBe(false)
    expect(JSON.stringify(f.batches)).not.toMatch(/PRIVATE_|Bearer|authorization/); expect(Buffer.concat(f.wire).includes(Buffer.from('PRIVATE_'))).toBe(false)
  })
  it('distinguishes public preview, local-machine trust and revoked scoped sessions without exposing either credential', async () => {
    const f = await fixture(), { server, call } = await service(f, { preview: { source: echo }, previewAutoConnect: true })
    const bootHeaders = { Authorization: '', Origin: server.url, 'Sec-Fetch-Site': 'same-origin', 'X-Jevable-Instance': server.instanceId }
    // Empty Authorization is still a supplied key and must be refused, never silently ignored.
    const refused = await call(bootHeaders, '/v1/preview/local-bootstrap', {}); expect(refused.status).toBe(403); await refused.json()
    const page = await fetch(server.url + '/'); expect(page.status).toBe(200); await page.text()
    const boot = await fetch(server.url + '/v1/preview/local-bootstrap', { method: 'POST', headers: { 'Content-Type': 'application/json',
      'X-Jevable-Protocol': PROTOCOL_VERSION, Origin: server.url, 'Sec-Fetch-Site': 'same-origin', 'X-Jevable-Instance': server.instanceId }, body: '{}' })
    expect(boot.status).toBe(200); const session = (await boot.json()).result
    const auth = { Authorization: `Bearer ${session.token}` }
    const read = await call(auth, '/v1/preview/operations', { operation: 'runs' }); expect(read.status).toBe(200); await read.json()
    const logout = await call(auth, '/v1/preview/logout', {}); expect(logout.status).toBe(200); await logout.json()
    const expired = await call(auth, '/v1/preview/operations', { operation: 'runs' }); expect(expired.status).toBe(401); await expired.json()
    await server.close(); await server.closed
    const outcomes = accessLogs(f).map(l => attrs(l))
    expect(outcomes.filter(a => a['jevable.http.access.stage'] === 'local-bootstrap').map(a => a['jevable.http.access.outcome'])).toEqual(['refused', 'admitted'])
    expect(outcomes.filter(a => a['jevable.http.access.stage'] === 'preview-session').map(a => a['jevable.http.access.outcome'])).toEqual(['admitted', 'admitted', 'refused'])
    expect(outcomes.some(a => a['jevable.http.access.stage'] === 'owner-key')).toBe(false)
    expect(JSON.stringify(f.batches)).not.toContain(session.token); expect(JSON.stringify(f.batches)).not.toContain(token)
  })
  it('labels an unissued well-formed grant only as syntactically admitted, never as authorized execution', async () => {
    const f = await fixture(), { server, call } = await service(f, { callerOperations: true }), grant = prepareGrantToken(randomUUID())
    const response = await call({ Authorization: `Bearer ${grant.token}`, 'X-Jevable-Instance': server.instanceId }, '/v1/caller/operations',
      { operation: 'read', id: randomUUID(), release: { id: randomUUID(), revision: 'b'.repeat(64), sha256: 'c'.repeat(64) } })
    expect(response.status).toBe(404); await response.json(); await server.close(); await server.closed
    expect(accessLogs(f).map(l => attrs(l)).filter(a => a['jevable.http.access.stage'] === 'grant-token-syntax'))
      .toEqual([{ 'jevable.http.access.stage': 'grant-token-syntax', 'jevable.http.access.outcome': 'admitted', 'jevable.duration.seconds': expect.any(Number) }])
    expect(f.spans().some(s => s.name === 'jevable.run')).toBe(false); expect(JSON.stringify(f.batches)).not.toContain(grant.token)
    expect(JSON.stringify(f.batches)).not.toContain(grant.id)
  })
  it('observes exact-release signature admission/refusal and read-pin checks without replaying a retained message', async () => {
    const f = await fixture(), preparation = await LocalRuntime.open({ dataDirectory: await mkdtemp(join(tmpdir(), 'jevable-access-release-')) })
    const project = preparation.editProject({ operation: 'create', yaml: api, actor: 'PRIVATE_ACTOR', title: 'Private preparation' })
    const artifact = preparation.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision,
      version: '1.0.0', actor: 'PRIVATE_ACTOR', runtime: { version: CORE_VERSION, sha256: 'b'.repeat(64) } }); await preparation.close()
    const keyBytes = Buffer.alloc(32, 9), key = 'whsec_' + keyBytes.toString('base64'), { server, call } = await service(f,
      { release: { snapshot: artifact.snapshot }, asyncRuns: { maxConcurrentRuns: 1 }, webhooks: { source: 'synthetic/access', keys: [key] } })
    const id = 'PRIVATE_MESSAGE', timestamp = String(Math.floor(Date.now() / 1000)), body = JSON.stringify('PRIVATE_INPUT')
    const signature = 'v1,' + createHmac('sha256', keyBytes).update(`${id}.${timestamp}.`).update(body).digest('base64')
    const post = (value: string) => fetch(server.url + '/v1/webhooks', { method: 'POST', headers: { 'Content-Type': 'application/json',
      'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': value }, body })
    const bad = await post('v1,' + Buffer.alloc(32, 1).toString('base64')); expect(bad.status).toBe(401); await bad.json()
    const good = await post(signature); expect(good.status).toBe(202); const run = (await good.json()).run
    const retry = await post(signature); expect(retry.status).toBe(200); await retry.json()
    const pinHeaders = { 'X-Jevable-Instance': server.instanceId, 'X-Jevable-Release-Sha256': artifact.sha256 }
    const wrong = await call({ ...pinHeaders, 'X-Jevable-Release-Sha256': 'f'.repeat(64) }, '/v1/async-runs/' + run.id, {}, 'GET')
    expect(wrong.status).toBe(409); await wrong.json()
    const read = await call(pinHeaders, '/v1/async-runs/' + run.id, {}, 'GET'); expect(read.status).toBe(200); await read.json()
    await server.close(); await server.closed
    expect(accessLogs(f).filter(l => attrs(l)['jevable.http.access.stage'] === 'signed-webhook').map(l => attrs(l)['jevable.http.access.outcome']))
      .toEqual(['refused', 'admitted', 'admitted'])
    expect(accessLogs(f).filter(l => attrs(l)['jevable.http.access.stage'] === 'release-pin').map(l => attrs(l)['jevable.http.access.outcome']))
      .toEqual(['refused', 'admitted'])
    expect(f.spans().filter(s => s.name === 'jevable.run')).toHaveLength(1)
    expect(JSON.stringify(f.batches)).not.toMatch(/PRIVATE_|whsec_|webhook-signature/)
  })
})

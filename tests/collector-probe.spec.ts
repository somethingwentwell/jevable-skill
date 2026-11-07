import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type ServerResponse } from 'node:http'
import { createServer as createHttp2Server, type ServerHttp2Session } from 'node:http2'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalRuntime } from '../src/runtime/local.ts'
import { PostgresRuntime } from '../src/runtime/postgres.ts'
import { RuntimeTelemetry } from '../src/telemetry/traces.ts'
import { collectorProbeReportSchema } from '../src/telemetry/probe.ts'
import { startRuntimeService, RuntimeClient } from '../src/http/index.ts'
import { main } from '../src/cli.ts'
import { fields, metricSums, logRecords } from '../scripts/check-telemetry-package.mjs'
import { ProtobufTraceSerializer, ProtobufLogsSerializer, ProtobufMetricsSerializer } from '@opentelemetry/otlp-transformer'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })
type Received = { url: string; bytes: Buffer; authorization?: string }
async function receiver(reply: (response: ServerResponse, url: string) => void = res => { res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.end() }) {
  const requests: Received[] = [], entered = Promise.withResolvers<void>()
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
    requests.push({ url: req.url!, bytes: Buffer.concat(chunks), ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) })
    entered.resolve(); reply(res, req.url!)
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No fixture listener')
  const origin = `http://127.0.0.1:${address.port}`
  return { requests, entered: entered.promise, origin, config: { endpoint: origin + '/v1/traces', metricsEndpoint: origin + '/v1/metrics',
    logsEndpoint: origin + '/v1/logs', authentication: { kind: 'none' as const }, intervalMs: 60000, timeoutMs: 1000, flushTimeoutMs: 1000 } }
}
async function owner(telemetry?: Parameters<typeof LocalRuntime.open>[0]['telemetry']) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-probe-'))
  const runtime = await LocalRuntime.open({ dataDirectory: directory, ...(telemetry ? { telemetry } : {}) })
  cleanup.push(() => runtime.close()); return { runtime, directory }
}
const wire = (bytes: Buffer): any => fields(bytes)
function spans(bytes: Buffer): any[] {
  return (wire(bytes).get(1) ?? []).flatMap((resource: Buffer) => (wire(resource).get(2) ?? []).flatMap((scope: Buffer) =>
    (wire(scope).get(2) ?? []).map((bytes: Buffer) => { const f = wire(bytes); return { traceId: f.get(1)[0].toString('hex'), spanId: f.get(2)[0].toString('hex'),
      parent: f.get(4)?.[0].toString('hex') ?? '', name: f.get(5)[0].toString() } })))
}
function resource(bytes: Buffer) {
  const envelope = wire(bytes).get(1)[0], attributes = wire(wire(envelope).get(1)[0]).get(1) ?? []
  return Object.fromEntries(attributes.map((b: Buffer) => { const kv = wire(b), v = wire(kv.get(2)[0]);
    return [kv.get(1)[0].toString(), v.has(1) ? v.get(1)[0].toString() : Boolean(v.get(2)[0])] }))
}

describe('explicit standalone Collector probe', () => {
  it('does not discover ambient configuration, run workflows or send without explicit telemetry', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'https://PRIVATE.invalid'); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const { runtime } = await owner(), before = await runtime.activityReport(), report = await runtime.telemetryProbe()
    expect(report).toMatchObject({ status: 'disabled', trace: null, protocol: null, signals: [], execution: 'not-run', retries: false })
    expect(collectorProbeReportSchema.safeParse(report).success).toBe(true); expect(fetch).not.toHaveBeenCalled()
    const after = await runtime.activityReport(); expect({ ...after, observedAt: before.observedAt }).toEqual(before)
  })
  it('receives exactly one correlated synthetic record per signal despite normal sampling zero, without altering queues', async () => {
    const f = await receiver(), { runtime } = await owner({ ...f.config, sampleRatio: 0 })
    const before = runtime.telemetryStatus(), report = await runtime.telemetryProbe()
    expect(report.status).toBe('acknowledged'); expect(report.signals.map(s => s.signal)).toEqual(['traces', 'metrics', 'logs'])
    expect(report.signals.every(s => s.attempted && s.rejected === 0)).toBe(true); expect(f.requests).toHaveLength(3)
    for (const request of f.requests) expect(resource(request.bytes)).toMatchObject({ 'jevable.probe.id': report.id, 'jevable.synthetic': true, 'jevable.storage.kind': 'sqlite' })
    expect(spans(f.requests.find(r => r.url.endsWith('traces'))!.bytes)).toEqual([{ traceId: report.trace!.traceId, spanId: report.trace!.spanId,
      parent: '', name: 'jevable.telemetry.probe' }])
    const log = logRecords(f.requests.find(r => r.url.endsWith('logs'))!.bytes)
    expect(log).toHaveLength(1); expect(log[0]).toMatchObject({ traceId: report.trace!.traceId, spanId: report.trace!.spanId,
      event: 'jevable.telemetry.probe', attributes: { 'jevable.probe.id': report.id } })
    expect(metricSums(f.requests.find(r => r.url.endsWith('metrics'))!.bytes).map((m: any) => ({ name: m.name, points: m.points })))
      .toEqual([{ name: 'jevable.telemetry.probe', points: [{ value: 1, labels: {} }] }])
    expect(runtime.telemetryStatus()).toEqual(before); expect((await runtime.activityReport()).runs.total).toBe(0)
    await runtime.close(); expect(f.requests).toHaveLength(3)
  })
  it('does not flush existing workflow telemetry and creates a fresh non-durable identity per explicit call', async () => {
    const f = await receiver(), telemetry = new RuntimeTelemetry({ endpoint: f.config.endpoint, authentication: { kind: 'none' }, intervalMs: 60000 }, () => undefined)
    cleanup.push(() => telemetry.close()); telemetry.end(telemetry.start('jevable.run', {}), 'completed')
    const before = telemetry.status(), first = await telemetry.probe(), second = await telemetry.probe()
    expect(second.id).not.toBe(first.id); expect(telemetry.status()).toEqual(before)
    expect(f.requests.flatMap(r => spans(r.bytes)).map(s => s.name)).toEqual(['jevable.telemetry.probe', 'jevable.telemetry.probe'])
    await telemetry.flush(); expect(spans(f.requests.at(-1)!.bytes)[0].name).toBe('jevable.run')
  })
  it.each(['traces', 'metrics', 'logs'] as const)('sends only the configured %s signal', async signal => {
    const f = await receiver(), { runtime } = await owner({ [signal === 'traces' ? 'endpoint' : signal + 'Endpoint']: f.origin + '/v1/' + signal,
      authentication: { kind: 'none' } })
    const report = await runtime.telemetryProbe(); expect(report.signals.map(s => s.signal)).toEqual([signal]); expect(f.requests.map(r => r.url)).toEqual(['/v1/' + signal])
  })
  it.each(['traces', 'metrics', 'logs'] as const)('reports %s partial rejection rather than false success, with no collector diagnostic disclosure or retry', async signal => {
    const f = await receiver((res, url) => { res.writeHead(200, { 'content-type': 'application/x-protobuf' });
      res.end(url.endsWith(signal) ? Buffer.from([10, 2, 8, 1]) : undefined) }), { runtime } = await owner(f.config)
    const report = await runtime.telemetryProbe(); expect(report.status).toBe('failed')
    expect(report.signals.find(s => s.signal === signal)).toMatchObject({ outcome: 'rejected', rejected: 1, failure: 'partial-rejection' })
    expect(f.requests).toHaveLength(3); expect(JSON.stringify(report)).not.toContain(f.origin)
  })
  it('preserves partial-success warnings with zero rejection without returning remote text', async () => {
    const privateText = Buffer.from('PRIVATE_COLLECTOR_DIAGNOSTIC'), message = Buffer.concat([Buffer.from([18, privateText.length]), privateText])
    const f = await receiver(res => { res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.end(Buffer.concat([Buffer.from([10, message.length]), message])) })
    const { runtime } = await owner(f.config), report = await runtime.telemetryProbe()
    expect(report.status).toBe('warning'); expect(report.signals.every(s => s.outcome === 'warning' && s.rejected === 0)).toBe(true)
    expect(JSON.stringify(report)).not.toContain('PRIVATE_'); expect(f.requests).toHaveLength(3)
  })
  it.each(['redirect', 'wrong-type', 'malformed', 'oversized', 'impossible-rejection'] as const)('refuses %s responses and never retries', async kind => {
    const f = await receiver(res => {
      res.writeHead(kind === 'redirect' ? 307 : 200, { 'content-type': kind === 'wrong-type' ? 'text/plain' : 'application/x-protobuf', location: 'https://PRIVATE.invalid' })
      res.end(kind === 'malformed' ? Buffer.from([255]) : kind === 'oversized' ? Buffer.alloc(64001) : kind === 'impossible-rejection' ? Buffer.from([10, 2, 8, 2]) : undefined)
    }), { runtime } = await owner(f.config), report = await runtime.telemetryProbe()
    expect(report.status).toBe('failed'); expect(report.signals.every(s => s.failure === 'response')).toBe(true); expect(f.requests).toHaveLength(3)
    expect(JSON.stringify(report)).not.toContain('PRIVATE_')
  })
  it('reserves one probe, protects credential/owner lifetime and aborts without cancelling a workflow', async () => {
    const f = await receiver(() => {}), { runtime } = await owner(f.config), abort = new AbortController()
    const work = runtime.telemetryProbe({ signal: abort.signal }); await f.entered
    await expect(runtime.telemetryProbe()).rejects.toHaveProperty('code', 'busy')
    expect(() => runtime.setCredential('otel/key', 'PRIVATE_KEY', 0, 'fixture')).toThrow('busy')
    await expect(runtime.close()).rejects.toHaveProperty('code', 'busy')
    abort.abort(); const report = await work; expect(report.status).toBe('aborted'); expect(f.requests.length).toBeLessThanOrEqual(3)
    expect((await runtime.activityReport()).runs.total).toBe(0)
    await runtime.close(); await expect(runtime.telemetryProbe()).rejects.toHaveProperty('code', 'closed')
  })
  it('pre-abort reads no credentials and sends no request', async () => {
    const f = await receiver(), key = vi.fn(() => 'PRIVATE_KEY'), telemetry = new RuntimeTelemetry({ ...f.config,
      authentication: { kind: 'bearer', credentialRef: 'otel/key' } }, key), abort = new AbortController()
    cleanup.push(() => telemetry.close()); abort.abort(); const report = await telemetry.probe({ signal: abort.signal })
    expect(report.status).toBe('aborted'); expect(report.signals.every(s => !s.attempted)).toBe(true); expect(key).not.toHaveBeenCalled(); expect(f.requests).toHaveLength(0)
  })
  it('bounds credential resolution and returns redacted failure without actual dispatch', async () => {
    const f = await receiver(), telemetry = new RuntimeTelemetry({ ...f.config, timeoutMs: 20,
      authentication: { kind: 'bearer', credentialRef: 'otel/key' } }, () => new Promise(() => {}))
    cleanup.push(() => telemetry.close()); const report = await telemetry.probe()
    expect(report.status).toBe('aborted'); expect(f.requests).toHaveLength(0); expect(telemetry.busy()).toBe(false)
  })
  it('direct telemetry close aborts and joins its admitted probe before returning', async () => {
    const f = await receiver(() => {}), telemetry = new RuntimeTelemetry(f.config, () => undefined)
    const work = telemetry.probe(); await f.entered; await telemetry.close()
    expect((await work).status).toBe('aborted'); expect(telemetry.busy()).toBe(false)
    await expect(telemetry.probe()).rejects.toHaveProperty('code', 'closed')
  })
  it('isolates individual serialization failure and refuses export while configuration is excluded', async () => {
    const f = await receiver(), telemetry = new RuntimeTelemetry(f.config, () => undefined)
    cleanup.push(() => telemetry.close()); vi.spyOn(ProtobufTraceSerializer, 'serializeRequest').mockImplementation(() => { throw Error('PRIVATE_SERIALIZER') })
    const report = await telemetry.probe(); expect(report.status).toBe('failed'); expect(report.signals[0]).toMatchObject({ attempted: false, outcome: 'not-sent', failure: 'serialization' })
    expect(f.requests).toHaveLength(2); expect(JSON.stringify(report)).not.toContain('PRIVATE_')
    const excluded = new RuntimeTelemetry(f.config, () => undefined, { canExport: () => false }); cleanup.push(() => excluded.close())
    await expect(excluded.probe()).rejects.toHaveProperty('code', 'busy')
  })
  it('PostgreSQL SDK operation-lifetime guards also own the shared probe; this is a domain double, not SQL qualification', async () => {
    const f = await receiver(() => {}), telemetry = new RuntimeTelemetry(f.config, () => undefined, { storage: 'postgres' })
    const runtime = Object.assign(Object.create(PostgresRuntime.prototype), { lifecycle: 'open', operations: 0, configuring: false,
      active: new Map(), flushes: new Set(), journal: { signal: new AbortController().signal, close: vi.fn() }, telemetry }) as PostgresRuntime
    const abort = new AbortController(), work = runtime.telemetryProbe({ signal: abort.signal }); await f.entered
    await expect(runtime.close()).rejects.toHaveProperty('code', 'busy'); abort.abort(); expect((await work).status).toBe('aborted')
    await runtime.close(); await expect(runtime.telemetryProbe()).rejects.toHaveProperty('code', 'closed')
  })
  it('PostgreSQL owner loss aborts an admitted probe even without bearer credential reads; this is a domain signal double', async () => {
    const f = await receiver(() => {}), telemetry = new RuntimeTelemetry(f.config, () => undefined, { storage: 'postgres' }), ownership = new AbortController()
    const runtime = Object.assign(Object.create(PostgresRuntime.prototype), { lifecycle: 'open', operations: 0, configuring: false,
      active: new Map(), flushes: new Set(), journal: { signal: ownership.signal, close: vi.fn() }, telemetry }) as PostgresRuntime
    const work = runtime.telemetryProbe(); await f.entered; ownership.abort()
    expect((await work).status).toBe('aborted'); expect(telemetry.busy()).toBe(false)
    await expect(runtime.telemetryProbe()).rejects.toBeDefined(); await runtime.close()
  })
  it('authenticated management requires strict empty fields and independent synthetic roots', async () => {
    const f = await receiver(), directory = await mkdtemp(join(tmpdir(), 'jevable-probe-api-'))
    const service = await startRuntimeService({ runtime: { dataDirectory: directory, telemetry: f.config }, token: '7'.repeat(64), actor: 'fixture:owner', port: 0 })
    cleanup.push(() => service.close()); const client = new RuntimeClient(service.url, '7'.repeat(64))
    const result = (await client.operation({ operation: 'telemetry.probe' }, '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01') as { result: unknown }).result
    expect(collectorProbeReportSchema.parse(result).status).toBe('acknowledged')
    expect(spans(f.requests.find(r => r.url.endsWith('traces'))!.bytes)[0].parent).toBe('')
    for (const field of ['endpoint', 'actor', 'execute', 'sampleRatio', 'credential', 'namespace'])
      await expect(client.operation({ operation: 'telemetry.probe', [field]: true })).rejects.toHaveProperty('code', 'invalid-command')
    await expect(new RuntimeClient(service.url, '8'.repeat(64)).operation({ operation: 'telemetry.probe' })).rejects.toHaveProperty('code', 'unauthorized')
    expect(f.requests).toHaveLength(3)
  })
  it('local CLI invokes only the configured probe, reports disabled as failure and discovers help without dispatch', async () => {
    const f = await receiver(), directory = await mkdtemp(join(tmpdir(), 'jevable-probe-cli-')), config = join(directory, 'telemetry.json')
    await writeFile(config, JSON.stringify(f.config), { mode: 0o600 })
    const invoke = async (args: string[]) => { let out = '', err = ''; const code = await main(args, { out: s => { out += s }, err: s => { err += s } }); return { code, out, err } }
    const result = await invoke(['telemetry', 'probe', '--data-dir', join(directory, 'state'), '--telemetry-file', config, '--json'])
    expect(result.code).toBe(0); expect(collectorProbeReportSchema.parse(JSON.parse(result.out)).status).toBe('acknowledged'); expect(f.requests).toHaveLength(3)
    expect((await invoke(['telemetry', 'probe', '--data-dir', join(directory, 'disabled'), '--json'])).code).toBe(1)
    const help = await invoke(['help', 'telemetry', 'probe', '--json']); expect(JSON.parse(help.out).execution).toBe('not-dispatched'); expect(f.requests).toHaveLength(3)
    expect((await invoke(['telemetry', 'probe', '--endpoint', f.origin, '--data-dir', directory, '--telemetry-file', '/not-read', '--json'])).code).toBe(2)
  })
  it('uses exact unary gRPC signal methods with the same probe identity and protected bearer', async () => {
    const server = createHttp2Server(), requests: { path: string; bytes: Buffer; authorization: string }[] = [], sessions = new Set<ServerHttp2Session>()
    server.on('session', session => { sessions.add(session); session.on('error', () => {}); session.once('close', () => sessions.delete(session)) })
    server.on('stream', (stream, headers) => { stream.on('error', () => {}); const chunks: Buffer[] = []; stream.on('data', b => chunks.push(Buffer.from(b))); stream.on('end', () => {
      const framed = Buffer.concat(chunks); requests.push({ path: headers[':path']!, bytes: framed.subarray(5), authorization: headers.authorization as string })
      stream.respond({ ':status': 200, 'content-type': 'application/grpc+proto' }, { waitForTrailers: true })
      stream.once('wantTrailers', () => { if (!stream.destroyed) stream.sendTrailers({ 'grpc-status': '0' }) }); stream.end(Buffer.alloc(5))
    }) })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    cleanup.push(async () => { for (const session of sessions) session.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) })
    const address = server.address(); if (!address || typeof address === 'string') throw Error('No listener'); const endpoint = `http://127.0.0.1:${address.port}`
    const telemetry = new RuntimeTelemetry({ endpoint, metricsEndpoint: endpoint, logsEndpoint: endpoint, protocol: 'grpc',
      authentication: { kind: 'bearer', credentialRef: 'otel/key' } }, async () => 'PRIVATE_BEARER'); cleanup.push(() => telemetry.close())
    const report = await telemetry.probe(); expect(report.status).toBe('acknowledged'); expect(requests).toHaveLength(3)
    for (const request of requests) { expect(request.authorization).toBe('Bearer PRIVATE_BEARER'); expect(resource(request.bytes)['jevable.probe.id']).toBe(report.id) }
    expect(requests.map(r => r.path).sort()).toEqual(['logs.v1.LogsService', 'metrics.v1.MetricsService', 'trace.v1.TraceService'].map(s => '/opentelemetry.proto.collector.' + s + '/Export').sort())
    expect(JSON.stringify(report)).not.toContain('PRIVATE_')
  })
  it('rejects changed/foreign/impossible response projections rather than accepting arbitrary owner results', async () => {
    const f = await receiver(), { runtime } = await owner(f.config), report = await runtime.telemetryProbe()
    for (const change of [
      (r: any) => { r.endpoint = 'PRIVATE' }, (r: any) => { r.trace.traceFlags = 0 },
      (r: any) => { r.signals.push(r.signals[0]) }, (r: any) => { r.signals[0].rejected = 2 },
      (r: any) => { r.signals[0].attempted = false }, (r: any) => { r.status = 'failed' },
    ]) { const altered = structuredClone(report); change(altered); expect(collectorProbeReportSchema.safeParse(altered).success).toBe(false) }
  })
})

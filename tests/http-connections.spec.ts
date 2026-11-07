import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createServer, request, Agent } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect, type Socket } from 'node:net'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuntimeTelemetry } from '../src/telemetry/traces.ts'
import { parseTelemetryConfig } from '../src/telemetry/config.ts'
import { startRuntimeService } from '../src/http/service.ts'
import { startRuntimeServer } from '../src/http/server.ts'
import { LocalRuntime } from '../src/runtime/local.ts'
import { PROTOCOL_VERSION } from '../src/capabilities.ts'
import { metricSums, logRecords, fields } from '../scripts/check-telemetry-package.mjs'
import { traceRecords } from '../scripts/check-postgres-telemetry.mjs'
import { createTlsFixture, fixturePort } from '../scripts/tls-fixture.mjs'

const cleanup: (() => Promise<unknown>)[] = []
const token = 'a'.repeat(64), parent = '00-11111111111111111111111111111111-2222222222222222-01'
let credentials: Awaited<ReturnType<typeof createTlsFixture>>
beforeAll(async () => { credentials = await createTlsFixture(await mkdtemp(join(tmpdir(), 'jevable-connections-tls-'))) }, 20000)
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

async function fixture(overrides: Record<string, unknown> = {}, rejected = false) {
  const wire: { path: string; bytes: Buffer }[] = []
  const collector = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
    wire.push({ path: req.url!, bytes: Buffer.concat(chunks) })
    res.writeHead(rejected ? 503 : 200, { 'content-type': 'application/x-protobuf' }); res.end()
  })
  await new Promise<void>(resolve => collector.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { collector.close(() => resolve()); collector.closeAllConnections() }))
  const base = `http://127.0.0.1:${(collector.address() as { port: number }).port}`
  const config = parseTelemetryConfig({ endpoint: base + '/v1/traces', metricsEndpoint: base + '/v1/metrics', logsEndpoint: base + '/v1/logs',
    authentication: { kind: 'none' }, httpConnections: true, intervalMs: 60000, timeoutMs: 500, flushTimeoutMs: 1500, ...overrides })
  const telemetry = new RuntimeTelemetry(config, () => undefined); cleanup.push(() => telemetry.close())
  return { config, telemetry, wire,
    spans: () => wire.filter(r => r.path === '/v1/traces').flatMap(r => traceRecords(r.bytes)),
    logs: () => wire.filter(r => r.path === '/v1/logs').flatMap(r => logRecords(r.bytes)),
    sums: () => wire.filter(r => r.path === '/v1/metrics').flatMap(r => metricSums(r.bytes)),
    histogram: (name: string) => {
      const batch = wire.filter(r => r.path === '/v1/metrics').at(-1)
      if (!batch) return []
      const metrics = (fields(batch.bytes).get(1) ?? []).flatMap((resource: Buffer) => (fields(resource).get(2) ?? [])
        .flatMap((scope: Buffer) => (fields(scope).get(2) ?? []).map((metric: Buffer) => fields(metric))))
      const metric = metrics.find((m: Map<number, any[]>) => m.get(1)![0].toString() === name)
      return metric?.get(9)?.flatMap((hist: Buffer) => (fields(hist).get(1) ?? []).map((point: Buffer) => {
        const value = fields(point); return { count: Number(value.get(4)![0].readBigUInt64LE()), sum: value.get(5)![0].readDoubleLE() }
      })) ?? []
    },
    sum: (name: string) => {
      const metric = wire.filter(r => r.path === '/v1/metrics').flatMap(r => metricSums(r.bytes)).filter(m => m.name === name).at(-1)
      return metric?.points.reduce((n: number, p: any) => n + p.value, 0)
    },
  }
}
async function service(config: ReturnType<typeof parseTelemetryConfig>, https = false, maxConcurrentRequests = 16) {
  const port = https ? await fixturePort() : 0
  const server = await startRuntimeService({ token, actor: 'PRIVATE_ACTOR', maxConcurrentRequests, port,
    runtime: { dataDirectory: await mkdtemp(join(tmpdir(), 'jevable-connections-state-')), telemetry: config },
    ...(https ? { tls: { publicOrigin: `https://127.0.0.1:${port}`, bindAddress: '127.0.0.1', certificateFile: credentials.cert, privateKeyFile: credentials.key } } : {}) })
  cleanup.push(async () => { await server.close(); await server.closed })
  return server
}
async function socket(port: number): Promise<Socket> {
  const peer = connect(port, '127.0.0.1'); peer.on('error', () => {})
  cleanup.push(async () => { peer.destroy() })
  await new Promise<void>((resolve, reject) => { peer.once('connect', resolve); peer.once('error', reject) })
  return peer
}
async function raw(port: number, text: string) {
  const peer = await socket(port), chunks: Buffer[] = []
  peer.on('data', chunk => chunks.push(chunk))
  const closed = new Promise<void>(resolve => peer.once('close', () => resolve()))
  peer.end(text); await closed
  return Buffer.concat(chunks).toString()
}
function call(url: string, agent: Agent | false = false, https = false) {
  return new Promise<number>((resolve, reject) => {
    const req = (https ? httpsRequest : request)(url + '/v1/capabilities', {
      agent: https ? false : agent, ...(https ? { ca: credentials.ca, rejectUnauthorized: true } : {}),
      headers: { authorization: `Bearer ${token}`, traceparent: parent, 'x-jevable-protocol': PROTOCOL_VERSION },
    }, res => { res.resume(); res.once('end', () => resolve(res.statusCode!)) })
    req.on('error', reject); req.end()
  })
}

it('defaults both HTTP opt-ins off and refuses non-boolean connection configuration', () => {
  const base = { endpoint: 'http://127.0.0.1/v1/traces', authentication: { kind: 'none' } }
  expect(parseTelemetryConfig(base)).toMatchObject({ httpRequests: false, httpConnections: false })
  for (const value of ['true', 1, null, {}]) expect(() => parseTelemetryConfig({ ...base, httpConnections: value })).toThrow('invalid-command')
})

it('settles connection observers once with bounded labels and independent root contexts', async () => {
  const f = await fixture()
  for (let i = 0; i < 160; i++) {
    const observation = f.telemetry.withParent(parent, () => f.telemetry.observeHttpConnection('loopback-http'))!
    observation.end(i % 2 === 0); observation.end(false)
  }
  expect(f.telemetry.observeHttpConnection('PRIVATE_TRANSPORT' as never)).toBeUndefined()
  f.telemetry.observeHttpTransportFailure('loopback-http', 'PRIVATE_FAILURE' as never)
  f.telemetry.observeHttpTransportFailure('PRIVATE_TRANSPORT' as never, 'http-parser')
  await f.telemetry.close()
  expect(f.sum('jevable.http.connections.opened')).toBe(160)
  expect(f.sum('jevable.http.connections.ended')).toBe(160)
  expect(f.sum('jevable.http.connections.active')).toBe(0)
  expect(f.sum('jevable.http.transport.failures')).toBeUndefined()
  const duration = f.histogram('jevable.http.connection.duration')
  expect(duration.reduce((sum: number, point: any) => sum + point.count, 0)).toBe(160)
  expect(duration.every((point: any) => Number.isFinite(point.sum) && point.sum >= 0)).toBe(true)
  expect(f.spans()).toHaveLength(160)
  expect(f.spans().every(s => s.parent === undefined && s.traceId !== '11111111111111111111111111111111')).toBe(true)
  const points = f.sums().find(m => m.name === 'jevable.http.connections.ended')!.points
  expect(points).toHaveLength(2)
  expect(points.map((p: any) => p.labels['jevable.http.connection.outcome']).sort()).toEqual(['closed', 'socket-error'])
  expect(Buffer.concat(f.wire.map(r => r.bytes)).includes('PRIVATE_')).toBe(false)
})

it.each([false, true])('keeps server behavior and opt-in independence with connections=%s', async enabled => {
  const f = await fixture({ httpConnections: enabled, httpRequests: true }), server = await service(f.config)
  const agent = new Agent({ keepAlive: true, maxSockets: 1 }); cleanup.push(async () => { agent.destroy() })
  expect(await call(server.url, agent)).toBe(200); expect(await call(server.url, agent)).toBe(200)
  await server.close(); await server.closed
  expect(f.spans().filter(s => s.name === 'jevable.http.request')).toHaveLength(2)
  const connections = f.spans().filter(s => s.name === 'jevable.http.connection')
  expect(connections).toHaveLength(enabled ? 1 : 0)
  if (enabled) {
    expect(f.sum('jevable.http.connections.opened')).toBe(1); expect(f.sum('jevable.http.connections.ended')).toBe(1)
    expect(f.sum('jevable.http.connections.active')).toBe(0)
    const log = f.logs().find(l => l.event === 'jevable.http.connection.ended')!
    expect(log.traceId).toBe(connections[0]!.traceId); expect(log.spanId).toBe(connections[0]!.spanId)
    expect(connections[0]!.parent).toBeUndefined()
  } else expect(f.sums().some(m => m.name.startsWith('jevable.http.connections.'))).toBe(false)
  expect(Buffer.concat(f.wire.map(r => r.bytes)).includes(token)).toBe(false)
})

it.each([{ sampleRatio: 0 }, { endpoint: undefined }])('exports connection logs/metrics independently of trace sampling: %j', async overrides => {
  const f = await fixture(overrides), server = await service(f.config)
  expect(await call(server.url)).toBe(200)
  await server.close(); await server.closed
  expect(f.spans()).toHaveLength(0)
  const log = f.logs()[0]!; expect(f.logs()).toHaveLength(1)
  expect(log.traceId).toMatch(/^[a-f0-9]{32}$/u)
  expect(f.sum('jevable.http.connections.active')).toBe(0); expect(f.sum('jevable.http.connections.ended')).toBe(1)
})

it.each([false, true])('records parser failure before request creation without exposing raw data: https=%s', async https => {
  const f = await fixture(), server = await service(f.config, https)
  let response: string
  const packet = 'PRIVATE_INVALID_METHOD /PRIVATE_PATH HTTP/1.1\r\nHost: PRIVATE_HOST\r\nPRIVATE_INVALID_HEADER\r\n\r\n'
  if (!https) response = await raw(server.listener.port, packet)
  else {
    const { connect: tlsConnect } = await import('node:tls')
    response = await new Promise<string>((resolve, reject) => {
      const peer = tlsConnect({ port: server.listener.port, host: '127.0.0.1', ca: credentials.ca, rejectUnauthorized: true }, () => peer.end(packet))
      cleanup.push(async () => { peer.destroy() }); const chunks: Buffer[] = []
      peer.on('data', data => chunks.push(data)); peer.on('error', reject); peer.on('close', () => resolve(Buffer.concat(chunks).toString()))
    })
  }
  expect(response).toContain('400 Bad Request')
  await server.close(); await server.closed
  expect(f.sum('jevable.http.transport.failures')).toBe(1)
  expect(f.spans().filter(s => s.name === 'jevable.http.request')).toHaveLength(0)
  const failure = f.spans().find(s => s.name === 'jevable.http.transport.failure')!
  expect(failure.attributes['jevable.http.transport.failure']).toBe('http-parser'); expect(failure.parent).toBeUndefined()
  expect(f.sum('jevable.http.connections.opened')).toBe(1); expect(f.sum('jevable.http.connections.active')).toBe(0)
  expect(Buffer.concat(f.wire.map(r => r.bytes)).includes('PRIVATE_')).toBe(false)
})

it('observes an actual TLS handshake failure only once, then preserves verified HTTPS', async () => {
  const f = await fixture(), server = await service(f.config, true)
  await raw(server.listener.port, 'GET /PRIVATE_PATH HTTP/1.1\r\nHost: PRIVATE_HOST\r\n\r\n')
  expect(await call(server.url, false, true)).toBe(200)
  await server.close(); await server.closed
  const failures = f.logs().filter(l => l.event === 'jevable.http.transport.failure')
  expect(failures).toHaveLength(1); expect(failures[0]!.attributes['jevable.http.transport.failure']).toBe('tls-handshake')
  expect(f.sum('jevable.http.transport.failures')).toBe(1)
  expect(f.sum('jevable.http.connections.opened')).toBe(2); expect(f.sum('jevable.http.connections.ended')).toBe(2)
  expect(f.sum('jevable.http.connections.active')).toBe(0)
  expect(Buffer.concat(f.wire.map(r => r.bytes)).includes('PRIVATE_')).toBe(false)
})

it('counts connection-limit drops without fabricating an accepted socket or HTTP request', async () => {
  const f = await fixture(), server = await service(f.config, false, 1)
  const peers: Socket[] = []
  for (let i = 0; i < 4; i++) peers.push(await socket(server.listener.port))
  const extra = await socket(server.listener.port)
  await new Promise<void>(resolve => extra.once('close', () => resolve()))
  for (const peer of peers) peer.end()
  await server.close(); await server.closed
  expect(f.sum('jevable.http.connections.opened')).toBe(4); expect(f.sum('jevable.http.connections.ended')).toBe(4)
  expect(f.sum('jevable.http.connections.active')).toBe(0)
  expect(f.sum('jevable.http.transport.failures')).toBe(1)
  expect(f.logs().find(l => l.event === 'jevable.http.transport.failure')!.attributes['jevable.http.transport.failure']).toBe('connection-limit')
})

it('observes a real client reset during body consumption without running an operation', async () => {
  const f = await fixture({ httpRequests: true }), server = await service(f.config)
  const admitted = vi.spyOn(LocalRuntime.prototype, 'observeHttpRequest')
  const req = request(server.url + '/v1/operations', { method: 'POST', headers: { authorization: `Bearer ${token}`,
    'x-jevable-protocol': PROTOCOL_VERSION, 'content-type': 'application/json', 'content-length': '4096' } })
  req.on('error', () => {}); req.write('{')
  await vi.waitFor(() => expect(admitted).toHaveBeenCalledTimes(1))
  req.socket!.resetAndDestroy()
  await server.close(); await server.closed
  expect(f.sum('jevable.http.connections.active')).toBe(0)
  expect(f.sum('jevable.http.transport.failures')).toBe(1)
  expect(f.logs().find(l => l.event === 'jevable.http.transport.failure')!.attributes['jevable.http.transport.failure']).toBe('http-client')
  expect(f.spans().some(s => s.name === 'jevable.run')).toBe(false)
})

it('waits for a disconnected operation to settle before exporting the final connection count', async () => {
  const f = await fixture({ httpRequests: true })
  let release!: () => void, entered = false, closed = false
  const server = await startRuntimeServer({ token, actor: 'owner' }, async () => ({ capabilities: () => ({}),
    withTraceParent: (parent, op) => f.telemetry.withParent(parent, op),
    observeHttpRequest: (method, path) => f.telemetry.observeHttpRequest(method, path),
    observeHttpConnection: transport => f.telemetry.observeHttpConnection(transport),
    observeHttpTransportFailure: (transport, failure) => f.telemetry.observeHttpTransportFailure(transport, failure),
    operation: async () => { entered = true; await new Promise<void>(resolve => { release = resolve }); return {} },
    close: async () => { await f.telemetry.close(); closed = true },
  }))
  cleanup.push(async () => { release?.(); await server.close(); await server.closed })
  const req = request(server.url + '/v1/operations', { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'x-jevable-protocol': PROTOCOL_VERSION, 'content-type': 'application/json', traceparent: parent,
  } }); req.on('error', () => {}); req.end('{}')
  await vi.waitFor(() => expect(entered).toBe(true)); req.destroy()
  expect((await server.close(10)).status).toBe('draining'); expect(closed).toBe(false)
  release(); await server.closed; expect(closed).toBe(true)
  expect(f.sum('jevable.http.connections.opened')).toBe(1); expect(f.sum('jevable.http.connections.ended')).toBe(1)
  expect(f.sum('jevable.http.connections.active')).toBe(0)
  expect(f.logs().find(l => l.event === 'jevable.http.request.ended')!.attributes['jevable.http.outcome']).toBe('disconnected')
})

it('keeps collector rejection diagnostic-only and retains one committed run across a same-ID retry', async () => {
  const f = await fixture({ httpRequests: true }, true), server = await service(f.config)
  const yaml = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
  const { randomUUID } = await import('node:crypto'), id = randomUUID()
  const body = JSON.stringify({ operation: 'runs.start', id, yaml, input: 'PRIVATE_INPUT' })
  const callRun = async () => {
    const response = await fetch(server.url + '/v1/operations', { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-jevable-protocol': PROTOCOL_VERSION,
    }, body }); expect(response.status).toBe(200); return (await response.json()).result
  }
  const first = await callRun(); expect(first.status).toBe('completed'); expect(await callRun()).toEqual(first)
  await server.close(); await server.closed
  expect(f.spans().filter(s => s.name === 'jevable.run')).toHaveLength(1)
  expect(f.logs().filter(l => l.event === 'jevable.http.connection.ended').length).toBeGreaterThan(0)
  expect(f.sum('jevable.http.connections.active')).toBe(0)
})

it('isolates creation, close and transport-hook failures without changing parsing or shutdown', async () => {
  let opened = 0, ended = 0, calls = 0
  const server = await startRuntimeServer({ token, actor: 'owner' }, async () => ({ capabilities: () => ({}),
    withTraceParent: (_parent, operation) => operation(), operation: async () => ({ calls: ++calls }), close: async () => {},
    observeHttpConnection: () => { if (++opened === 1) throw Error('PRIVATE_OBSERVER'); return { end() { ended++; throw Error('PRIVATE_OBSERVER') } } },
    observeHttpTransportFailure: () => { throw Error('PRIVATE_OBSERVER') },
  }))
  cleanup.push(async () => { await server.close(); await server.closed })
  expect(await call(server.url)).toBe(200)
  expect(await raw(server.listener.port, 'PRIVATE_BROKEN\r\n\r\n')).toContain('400 Bad Request')
  const response = await fetch(server.url + '/v1/operations', { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-jevable-protocol': PROTOCOL_VERSION,
  }, body: '{}' }); expect((await response.json()).result.calls).toBe(1)
  await server.close(); await server.closed
  expect(opened).toBe(3); expect(ended).toBe(2); expect(calls).toBe(1)
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, createSecureServer, constants, type ServerHttp2Stream, type ServerHttp2Session, type IncomingHttpHeaders } from 'node:http2'
import { readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseTelemetryConfig } from '../src/telemetry/config.ts'
import { postOtlp } from '../src/telemetry/otlp.ts'
import { RuntimeTelemetry } from '../src/telemetry/traces.ts'
import { LocalRuntime } from '../src/runtime/local.ts'
import { createTlsFixture } from '../scripts/tls-fixture.mjs'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const frame = (body = Buffer.alloc(0)) => { const bytes = Buffer.alloc(body.length + 5); bytes.writeUInt32BE(body.length, 1); body.copy(bytes, 5); return bytes }
function reply(stream: ServerHttp2Stream, body = Buffer.alloc(0), status = '0') {
  stream.respond({ ':status': 200, 'content-type': 'application/grpc+proto' }, { waitForTrailers: true })
  stream.once('wantTrailers', () => { if (!stream.destroyed) stream.sendTrailers({ 'grpc-status': status }) })
  stream.end(frame(body))
}
async function fixture(respond: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, body: Buffer) => void = stream => reply(stream), tls = false) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-grpc-'))
  const certs = tls ? await createTlsFixture(directory) : undefined
  const server = certs ? createSecureServer({ key: await readFile(certs.key), cert: await readFile(certs.cert) }) : createServer()
  const sessions = new Set<ServerHttp2Session>(), requests: { headers: IncomingHttpHeaders; body: Buffer }[] = []
  server.on('session', session => { sessions.add(session); session.on('error', () => {}); session.once('close', () => sessions.delete(session)) })
  server.on('stream', (stream, headers) => {
    stream.on('error', () => {})
    const chunks: Buffer[] = []
    stream.on('data', chunk => chunks.push(Buffer.from(chunk)))
    stream.on('end', () => { const body = Buffer.concat(chunks); requests.push({ headers, body }); if (!stream.destroyed) respond(stream, headers, body) })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanup.push(() => new Promise<void>(resolve => { for (const session of sessions) session.destroy(); server.close(() => resolve()) }))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('no listener')
  const endpoint = `${tls ? 'https' : 'http'}://127.0.0.1:${address.port}`
  const policy = parseTelemetryConfig({ endpoint, protocol: 'grpc', authentication: { kind: 'none' }, intervalMs: 60000, timeoutMs: 1000, flushTimeoutMs: 1000 })
  return { server, sessions, requests, policy, endpoint, certs }
}
const send = (policy: ReturnType<typeof parseTelemetryConfig>, controller = new AbortController(), credential = () => undefined as string | undefined) =>
  postOtlp(policy.endpoint!, new Uint8Array([1, 2, 3]), policy, credential, controller)

describe('bounded explicit OTLP/gRPC transport', () => {
  it('preserves HTTP defaults and requires explicit origin-only gRPC destinations', () => {
    expect(parseTelemetryConfig({ endpoint: 'https://receiver.example/v1/traces', authentication: { kind: 'none' } }).protocol).toBe('http/protobuf')
    for (const endpoint of ['https://receiver.example', 'http://127.0.0.1:4317/', 'http://[::1]:4317'])
      expect(parseTelemetryConfig({ endpoint, protocol: 'grpc', authentication: { kind: 'none' } }).protocol).toBe('grpc')
    for (const endpoint of ['bad', 'grpc://receiver.example', 'http://remote.example:4317', 'https://receiver.example/v1/traces',
      'https://secret@receiver.example', 'https://receiver.example/?key=secret', 'https://receiver.example/#secret'])
      expect(() => parseTelemetryConfig({ endpoint, protocol: 'grpc', authentication: { kind: 'none' } })).toThrow('invalid-command')
    expect(() => parseTelemetryConfig({ endpoint: 'https://receiver.example', logsEndpoint: 'https://receiver.example/v1/logs',
      protocol: 'grpc', authentication: { kind: 'none' } })).toThrow('invalid-command')
    expect(() => parseTelemetryConfig({ endpoint: 'https://receiver.example', protocol: 'grpc', insecure: true, authentication: { kind: 'none' } })).toThrow('invalid-command')
  })

  it('sends exact unary framing, methods, deadlines and rotated bearer credentials without connection reuse', async () => {
    const f = await fixture(), policy = { ...f.policy, authentication: { kind: 'bearer' as const, credentialRef: 'otel/key' } }
    for (const [signal, service] of [['traces', 'trace.v1.TraceService'], ['metrics', 'metrics.v1.MetricsService'], ['logs', 'logs.v1.LogsService']] as const) {
      await postOtlp(f.endpoint, new Uint8Array([1, 2, 3]), policy, async () => 'PRIVATE_' + signal, new AbortController(), signal)
      const request = f.requests.at(-1)!
      expect(request.headers).toMatchObject({ ':method': 'POST', ':path': '/opentelemetry.proto.collector.' + service + '/Export',
        'content-type': 'application/grpc+proto', te: 'trailers', authorization: 'Bearer PRIVATE_' + signal, 'grpc-accept-encoding': 'identity' })
      expect(request.headers['grpc-timeout']).toMatch(/^\d{1,8}m$/u)
      expect(request.body).toEqual(frame(Buffer.from([1, 2, 3])))
    }
    expect(f.requests).toHaveLength(3)
    await vi.waitFor(() => expect(f.sessions.size).toBe(0))
  })

  it('accepts split envelopes and preserves a partial-success protobuf response', async () => {
    const body = Buffer.from([10, 2, 8, 1])
    const f = await fixture(stream => {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true })
      stream.once('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }))
      const bytes = frame(body); stream.write(bytes.subarray(0, 2)); stream.write(bytes.subarray(2, 4)); stream.end(bytes.subarray(4))
    })
    expect(await send(f.policy)).toEqual(body)
  })

  it('accepts exact request/response size limits without allocating from the peer length', async () => {
    const body = Buffer.alloc(64000, 1), f = await fixture(stream => reply(stream, body))
    expect(await postOtlp(f.endpoint, new Uint8Array(4_000_000), f.policy, () => undefined, new AbortController())).toEqual(body)
    expect(f.requests[0]!.body.length).toBe(4_000_005)
  })

  it('finishes an accepted stream after graceful GOAWAY without making another connection', async () => {
    const f = await fixture(stream => { stream.session!.goaway(constants.NGHTTP2_NO_ERROR, stream.id); reply(stream) })
    expect(await send(f.policy)).toEqual(Buffer.alloc(0)); expect(f.requests).toHaveLength(1)
  })

  it.each(['http-status', 'content-type', 'compressed-header', 'compressed-frame', 'oversize-header', 'oversize-body', 'truncated',
    'extra-message', 'no-message', 'no-status', 'initial-status', 'trailers-only-success', 'trailers-only-error', 'status-error', 'duplicate-status', 'success-details'])(
    'rejects %s once with sanitized diagnostics', async fault => {
      const f = await fixture(stream => {
        if (fault.startsWith('trailers-only')) { stream.respond({ ':status': 200, 'content-type': 'application/grpc',
          'grpc-status': fault === 'trailers-only-success' ? '0' : '14', 'grpc-message': 'PRIVATE_COLLECTOR_ERROR' }, { endStream: true }); return }
        stream.respond({ ':status': fault === 'http-status' ? 503 : 200,
          'content-type': fault === 'content-type' ? 'application/json' : 'application/grpc',
          ...(fault === 'compressed-header' ? { 'grpc-encoding': 'gzip' } : {}),
          ...(fault === 'initial-status' ? { 'grpc-status': '0' } : {}) }, { waitForTrailers: true })
        stream.once('wantTrailers', () => { if (!stream.destroyed) stream.sendTrailers({
          ...(fault === 'no-status' ? {} : { 'grpc-status': fault === 'status-error' ? '14' : fault === 'duplicate-status' ? ['0', '0'] : '0' }),
          'grpc-message': 'PRIVATE_COLLECTOR_ERROR', ...(fault === 'success-details' ? { 'grpc-status-details-bin': 'c2VjcmV0' } : {}),
        }) })
        let body = frame()
        if (fault === 'compressed-frame') body[0] = 1
        if (fault === 'oversize-header') body.writeUInt32BE(64001, 1)
        if (fault === 'oversize-body') body = Buffer.alloc(64006)
        if (fault === 'truncated') body = body.subarray(0, 4)
        if (fault === 'extra-message') body = Buffer.concat([body, frame()])
        if (fault === 'no-message') body = Buffer.alloc(0)
        stream.end(body)
      })
      await expect(send(f.policy)).rejects.toMatchObject({ category: 'response', message: 'response' })
      expect(f.requests).toHaveLength(1)
      await vi.waitFor(() => expect(f.sessions.size).toBe(0))
    })

  it.each(['reset', 'goaway', 'timeout', 'abort'])('bounds %s and closes the connection without retry', async fault => {
    const f = await fixture(stream => {
      if (fault === 'reset') stream.close(constants.NGHTTP2_REFUSED_STREAM)
      if (fault === 'goaway') stream.session!.goaway(constants.NGHTTP2_ENHANCE_YOUR_CALM)
    })
    const controller = new AbortController(), result = send({ ...f.policy, timeoutMs: fault === 'timeout' ? 100 : 1000 }, controller)
    const rejected = expect(result).rejects.toMatchObject({ category: 'transport', message: 'transport' })
    if (fault === 'abort') { await vi.waitFor(() => expect(f.requests.length).toBe(1)); controller.abort() }
    await rejected
    expect(f.requests).toHaveLength(1)
    await vi.waitFor(() => expect(f.sessions.size).toBe(0))
  })

  it('does not connect after pre-abort, failed serialization, missing credentials or a timed-out credential read', async () => {
    const f = await fixture(), controller = new AbortController(); controller.abort()
    await expect(send(f.policy, controller)).rejects.toMatchObject({ category: 'transport' })
    await expect(postOtlp(f.endpoint, new Uint8Array(4_000_001), f.policy, () => undefined, new AbortController())).rejects.toMatchObject({ category: 'serialization' })
    const policy = { ...f.policy, authentication: { kind: 'bearer' as const, credentialRef: 'otel/key' }, timeoutMs: 20 }
    await expect(send(policy)).rejects.toMatchObject({ category: 'transport' })
    let resolve!: (key: string) => void
    await expect(postOtlp(f.endpoint, new Uint8Array([1]), policy, () => new Promise<string>(yes => { resolve = yes }), new AbortController())).rejects.toMatchObject({ category: 'transport' })
    resolve('LATE_PRIVATE_KEY'); await Promise.resolve()
    expect(f.requests).toHaveLength(0); expect(f.sessions.size).toBe(0)
  })

  it('refuses an untrusted TLS server even when an ambient insecure override is present', async () => {
    const f = await fixture(undefined, true)
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0')
    await expect(send(f.policy)).rejects.toMatchObject({ category: 'transport', message: 'transport' })
    expect(f.requests).toHaveLength(0)
  })

  it('exports to a verified TLS receiver using an explicitly provisioned additional CA in a fresh process', async () => {
    const f = await fixture(undefined, true)
    const script = `import { postOtlp } from ${JSON.stringify(new URL('../src/telemetry/otlp.ts', import.meta.url).href)};
      import { parseTelemetryConfig } from ${JSON.stringify(new URL('../src/telemetry/config.ts', import.meta.url).href)};
      const policy = parseTelemetryConfig({protocol:'grpc', endpoint:${JSON.stringify(f.endpoint)}, authentication:{kind:'none'}});
      await postOtlp(policy.endpoint, new Uint8Array([1]), policy, () => undefined, new AbortController());`
    await promisify(execFile)(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', script], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: f.certs!.cert, NODE_TLS_REJECT_UNAUTHORIZED: '1', NODE_OPTIONS: '' }, timeout: 10000,
    })
    expect(f.requests).toHaveLength(1)
    await vi.waitFor(() => expect(f.sessions.size).toBe(0))
  })

  it.each(['success', 'partial', 'reject'] as const)('exports all signals with %s accounting and no private values in status', async mode => {
    const f = await fixture(stream => reply(stream, mode === 'partial' ? Buffer.from([10, 2, 8, 1]) : Buffer.alloc(0), mode === 'reject' ? '14' : '0'))
    const telemetry = new RuntimeTelemetry({ ...f.policy, metricsEndpoint: f.endpoint, logsEndpoint: f.endpoint }, () => undefined)
    cleanup.push(() => telemetry.close())
    telemetry.end(telemetry.start('jevable.run', { 'jevable.operation': 'run' }), 'completed')
    const status = await telemetry.flush()
    expect(status).toMatchObject({ protocol: 'grpc', metrics: { protocol: 'grpc' }, logs: { protocol: 'grpc' } })
    expect(f.requests).toHaveLength(3)
    if (mode === 'success') expect(status).toMatchObject({ exported: 1, logs: { exported: 1 }, metrics: { failedBatches: 0 } })
    if (mode === 'partial') expect(status).toMatchObject({ rejected: 1, lastFailure: 'partial-rejection', logs: { rejected: 1 }, metrics: { rejected: 1 } })
    if (mode === 'reject') expect(status).toMatchObject({ dropped: 1, failedBatches: 1, lastFailure: 'response', logs: { dropped: 1 }, metrics: { failedBatches: 1 } })
    await telemetry.flush(); expect(f.requests).toHaveLength(3)
  })

  it.each(['unsampled', 'metrics-logs-only'])('keeps gRPC metrics/logs and correct protocol discovery with %s traces', async mode => {
    const f = await fixture()
    const { endpoint: omitted, ...common } = f.policy
    const telemetry = new RuntimeTelemetry({ ...common, ...(mode === 'unsampled' ? { endpoint: f.endpoint, sampleRatio: 0 } : {}),
      metricsEndpoint: f.endpoint, logsEndpoint: f.endpoint }, () => undefined)
    cleanup.push(() => telemetry.close())
    telemetry.end(telemetry.start('jevable.run', {}), 'completed')
    expect(await telemetry.flush()).toMatchObject({ protocol: 'grpc', metrics: { protocol: 'grpc', failedBatches: 0 }, logs: { protocol: 'grpc', exported: 1 } })
    expect(f.requests).toHaveLength(2)
    expect(f.requests.some(r => r.headers[':path'] === '/opentelemetry.proto.collector.trace.v1.TraceService/Export')).toBe(false)
  })

  it('drains concurrent flush/close within the shutdown budget and aborts all unresponsive gRPC calls', async () => {
    const f = await fixture(() => {})
    const telemetry = new RuntimeTelemetry({ ...f.policy, metricsEndpoint: f.endpoint, logsEndpoint: f.endpoint,
      timeoutMs: 5000, flushTimeoutMs: 20 }, () => undefined)
    cleanup.push(() => telemetry.close())
    telemetry.end(telemetry.start('jevable.run', {}), 'completed')
    const flushing = telemetry.flush()
    await vi.waitFor(() => expect(f.requests).toHaveLength(3))
    expect(telemetry.busy()).toBe(true)
    const started = performance.now()
    await Promise.all([telemetry.close(), telemetry.close(), flushing])
    expect(performance.now() - started).toBeLessThan(1000)
    expect(telemetry.status()).toMatchObject({ closed: true, inFlight: 0, lastFailure: 'transport',
      logs: { closed: true, inFlight: 0, lastFailure: 'transport' }, metrics: { closed: true, inFlight: 0, lastFailure: 'transport' } })
    expect(telemetry.busy()).toBe(false); expect(f.requests).toHaveLength(3)
    await vi.waitFor(() => expect(f.sessions.size).toBe(0))
  })

  it('keeps workflow results and journals unchanged when a gRPC receiver rejects all signals', async () => {
    const f = await fixture(stream => reply(stream, Buffer.alloc(0), '14'))
    const runtime = await LocalRuntime.open({ dataDirectory: await mkdtemp(join(tmpdir(), 'jevable-grpc-runtime-')),
      telemetry: { ...f.policy, metricsEndpoint: f.endpoint, logsEndpoint: f.endpoint } })
    cleanup.push(() => runtime.close())
    const source = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
    const run = await runtime.run(source, 'PRIVATE_WORKFLOW_PAYLOAD'), history = await runtime.events(run.id)
    expect(run.state.status).toBe('completed')
    await runtime.telemetryFlush()
    expect(await runtime.show(run.id)).toEqual(run); expect(await runtime.events(run.id)).toEqual(history)
    expect(await runtime.run(source, 'PRIVATE_WORKFLOW_PAYLOAD', { id: run.id })).toEqual(run)
    await runtime.telemetryFlush()
    for (const request of f.requests) expect(request.body.includes(Buffer.from('PRIVATE_WORKFLOW_PAYLOAD'))).toBe(false)
  })
})

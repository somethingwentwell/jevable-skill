import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProtobufTraceSerializer, JsonTraceSerializer, ProtobufMetricsSerializer, JsonMetricsSerializer,
  ProtobufLogsSerializer, JsonLogsSerializer } from '@opentelemetry/otlp-transformer'
import { startRuntimeService } from '../src/http/service.ts'
import { PROTOCOL_VERSION } from '../src/capabilities.ts'
import { verifyHttpObservations, type HttpObservationLedger } from '../src/telemetry/index.ts'
import type { HttpRateDebit } from '../src/http/coordinated-rate-limits.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

it.each((['none', 'local', 'coordinated'] as const).flatMap(mode =>
  (['k8s.pod.uid', 'service.instance.id'] as const).map(ownerAttribute => [mode, ownerAttribute] as const)))('joins actual core SDK HTTP serialization across two instances with %s quota and %s owner', async (mode, ownerAttribute) => {
  const batches: Record<'traces' | 'metrics' | 'logs', string[]> = { traces: [], metrics: [], logs: [] }
  const traceSerialize = ProtobufTraceSerializer.serializeRequest, metricSerialize = ProtobufMetricsSerializer.serializeRequest,
    logSerialize = ProtobufLogsSerializer.serializeRequest
  vi.spyOn(ProtobufTraceSerializer, 'serializeRequest').mockImplementation(value => {
    batches.traces.push(Buffer.from(JsonTraceSerializer.serializeRequest(value)!).toString()); return traceSerialize(value)
  })
  vi.spyOn(ProtobufMetricsSerializer, 'serializeRequest').mockImplementation(value => {
    batches.metrics.push(Buffer.from(JsonMetricsSerializer.serializeRequest(value)!).toString()); return metricSerialize(value)
  })
  vi.spyOn(ProtobufLogsSerializer, 'serializeRequest').mockImplementation(value => {
    batches.logs.push(Buffer.from(JsonLogsSerializer.serializeRequest(value)!).toString()); return logSerialize(value)
  })
  const received: Record<string, number> = {}
  const collector = createServer(async (req, res) => {
    let bytes = 0; for await (const chunk of req) bytes += Buffer.byteLength(chunk)
    received[req.url!] = (received[req.url!] ?? 0) + bytes
    res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.end()
  })
  await new Promise<void>((resolve, reject) => { collector.once('error', reject); collector.listen(0, '127.0.0.1', () => {
    collector.off('error', reject); resolve()
  }) })
  cleanup.push(() => new Promise<void>(resolve => { collector.close(() => resolve()); collector.closeAllConnections() }))
  const address = collector.address(); if (!address || typeof address === 'string') throw Error('listener')
  const endpoint = `http://127.0.0.1:${address.port}`, token = 'a'.repeat(64), owners: string[] = [randomUUID(), randomUUID()]
  const policy = { requests: { capacity: 5, refillTokens: 1, refillIntervalMs: 3600000 },
    controls: { capacity: 5, refillTokens: 1, refillIntervalMs: 3600000 } }
  const consume = vi.fn(async (request: HttpRateDebit) => ({ requestId: request.requestId, scope: request.scope,
    policySha256: request.policySha256, lane: request.lane, admitted: true as const }))
  const ledger: HttpObservationLedger = { schemaVersion: 1, ownerAttribute, owners,
    clockDomain: 'shared-unix-milliseconds', intents: [], settlements: [] }
  for (const index of [0, 1]) {
    const server = await startRuntimeService({ runtime: { dataDirectory: await mkdtemp(join(tmpdir(), 'jevable-http-verification-')),
      telemetry: { endpoint: endpoint + '/v1/traces', metricsEndpoint: endpoint + '/v1/metrics', logsEndpoint: endpoint + '/v1/logs',
        authentication: { kind: 'none' }, httpRequests: true, httpAccessDecisions: mode !== 'none', httpResponseContext: true, sampleRatio: 1,
        ...(ownerAttribute === 'k8s.pod.uid' ? { resource: { kubernetes: { podUid: owners[index]! } } } : {}), intervalMs: 60000, timeoutMs: 1000, flushTimeoutMs: 2000 } }, token, actor: 'test',
      ...(mode === 'local' ? { rateLimits: policy } : mode === 'coordinated'
        ? { coordinatedRateLimits: { scope: randomUUID(), policy, timeoutMs: 1000, consume } } : {}) })
    cleanup.push(async () => { await server.close(); await server.closed })
    expect(server.telemetryResource?.serviceInstanceId).toMatch(/^[a-f0-9-]{36}$/)
    expect(server.telemetryResource?.serviceInstanceId).not.toBe(server.instanceId)
    // Capture from startup before any request, never from the signals being verified.
    if (ownerAttribute === 'service.instance.id') owners[index] = server.telemetryResource!.serviceInstanceId
    const ownerId = owners[index]!
    // These resource UUIDs are caller-controlled test metadata, not evidence of actual Kubernetes deployment.
    const calls = index === 0 ? [
      { path: '/v1/health', route: '/v1/health' as const, status: 200 },
      { path: '/v1/health', route: '/v1/health' as const, status: 200 },
      { path: '/v1/capabilities', route: '/v1/capabilities' as const, status: 200 },
      { path: '/unregistered', route: null, status: 404 },
    ] : [{ path: '/v1/health', route: '/v1/health' as const, status: 200 }]
    for (const call of calls) {
      const id = randomUUID(), startedMs = Date.now()
      ledger.intents.push({ id, ownerId, startedMs, method: 'GET', route: call.route })
      const response = await fetch(server.url + call.path, { headers: { authorization: `Bearer ${token}`, 'x-jevable-protocol': PROTOCOL_VERSION } })
      const body = await response.text()
      if (call.path === '/v1/health') expect(JSON.parse(body).runtime.telemetry.resource.serviceInstanceId).toBe(server.telemetryResource!.serviceInstanceId)
      ledger.settlements.push({ id, endedMs: Date.now(), status: response.status,
        context: response.headers.get('x-jevable-traceparent')!, bodyEnded: true })
      expect(response.status).toBe(call.status)
    }
    await server.close(); await server.closed
  }
  const signals = { traces: batches.traces.join('\n'), metrics: batches.metrics.join('\n'), logs: batches.logs.join('\n') }
  const report = verifyHttpObservations(ledger, signals)
  expect(report).toMatchObject({ responseJoins: 5, requestSpans: 5, requestLogs: 5,
    cumulativeRequestTotal: 5, boundedSeries: 4, owners: [{ ownerId: owners[0], responses: 4 }, { ownerId: owners[1], responses: 1 }] })
  if (mode === 'none') expect(report).not.toHaveProperty('rateAdmissionLinks')
  else expect(report.rateAdmissionLinks).toMatchObject({ contexts: 3, sampled: 3, unsampled: 0 })
  expect(consume).toHaveBeenCalledTimes(mode === 'coordinated' ? 3 : 0)
  expect(Object.keys(received).sort()).toEqual(['/v1/logs', '/v1/metrics', '/v1/traces'])
  expect(Object.values(received).every(bytes => bytes > 0)).toBe(true)
  expect(JSON.stringify(signals)).not.toContain(token)
  const incomplete = structuredClone(ledger); incomplete.settlements.pop()
  expect(() => verifyHttpObservations(incomplete, signals)).toThrow('incomplete-evidence')
  // Actual local HTTP and serializer fixture, with a host receipt double for coordinated quota:
  // not actual PostgreSQL, Kubernetes, Collector decoding, quota debit or backend durability proof.
}, 15000)

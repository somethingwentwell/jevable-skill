import { afterEach, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startRuntimeService } from '../src/http/service.ts'
import { startRuntimeServer } from '../src/http/server.ts'
import { parseTelemetryConfig, parseTraceParent } from '../src/telemetry/config.ts'
import { PROTOCOL_VERSION, capabilities, httpResponseContextTelemetryCapability } from '../src/capabilities.ts'
import { fields, logRecords, metricSums } from '../scripts/check-telemetry-package.mjs'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const token = 'a'.repeat(64)
async function receiver() {
  const packets: { path: string; bytes: Buffer }[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk)
    packets.push({ path: request.url!, bytes: Buffer.concat(chunks) })
    response.writeHead(200, { 'content-type': 'application/x-protobuf' }); response.end()
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('listener')
  return { packets, origin: `http://127.0.0.1:${address.port}` }
}
function spans(bytes: Buffer) {
  return (fields(bytes).get(1) ?? []).flatMap((resource: Buffer) => (fields(resource).get(2) ?? []).flatMap((scope: Buffer) =>
    (fields(scope).get(2) ?? []).map((value: Buffer) => {
      const span = fields(value)
      return { traceId: span.get(1)![0].toString('hex'), spanId: span.get(2)![0].toString('hex'),
        parent: span.get(4)?.[0].toString('hex'), name: span.get(5)![0].toString() }
    })))
}
const config = (origin: string, extra = {}) => parseTelemetryConfig({ endpoint: origin + '/v1/traces',
  logsEndpoint: origin + '/v1/logs', metricsEndpoint: origin + '/v1/metrics', authentication: { kind: 'none' },
  httpRequests: true, intervalMs: 60000, timeoutMs: 1000, flushTimeoutMs: 2000, ...extra })

it('requires a separate boolean opt-in and request observations, with no ambient discovery', () => {
  expect(config('http://127.0.0.1').httpResponseContext).toBe(false)
  for (const extra of [{ httpResponseContext: 'true' }, { httpResponseContext: 1 },
    { httpResponseContext: true, httpRequests: false }, { httpResponseContext: true, httpRequests: undefined }]) {
    expect(() => config('http://127.0.0.1', extra)).toThrow('invalid-command')
  }
})

it('reports detached static support without enabling disclosure or changing discovery', () => {
  const first = httpResponseContextTelemetryCapability(), original = structuredClone(first)
  expect(capabilities().workflowRuntime.httpResponseContextTelemetry).toEqual(original)
  first.requires.push('forged'); first.header = 'forged'; first.disclosures.push('forged')
  expect(httpResponseContextTelemetryCapability()).toEqual(original)
  expect(capabilities().workflowRuntime.httpResponseContextTelemetry).toEqual(original)
  expect(original).toMatchObject({ default: false, requires: ['httpRequests'], header: 'X-Jevable-Traceparent',
    readsAndRefusals: 'independent-root; no-inbound-parent-adoption', metricLabels: 'unchanged; no-context-ids' })
})

it.each([false, true])('discloses response correlation only after explicit opt-in=%s', async enabled => {
  const r = await receiver(), service = await startRuntimeService({ token, actor: 'PRIVATE_ACTOR',
    runtime: { dataDirectory: await mkdtemp(join(tmpdir(), 'jevable-response-opt-in-')), telemetry: config(r.origin, { httpResponseContext: enabled }) } })
  cleanup.push(async () => { await service.close(); await service.closed })
  const response = await fetch(service.url + '/v1/health', { headers: { Authorization: `Bearer ${token}`, 'X-Jevable-Protocol': PROTOCOL_VERSION } })
  expect(response.status).toBe(200)
  expect(Boolean(response.headers.get('x-jevable-traceparent'))).toBe(enabled)
  const body = await response.json()
  expect(body.runtime.telemetry.httpResponseContext).toBe(enabled ? true : undefined)
  expect(response.headers.get('x-jevable-traceparent') ?? '').not.toContain(token)
})

it.each([0, 1])('joins an independently declared complete caller population to received wire, sampling=%s', async sampleRatio => {
  const r = await receiver(), service = await startRuntimeService({ token, actor: 'PRIVATE_ACTOR',
    runtime: { dataDirectory: await mkdtemp(join(tmpdir(), 'jevable-response-ledger-')),
      telemetry: config(r.origin, { httpResponseContext: true, sampleRatio }) } })
  cleanup.push(async () => { await service.close(); await service.closed })
  const parent = `00-${'1'.repeat(32)}-${'2'.repeat(16)}-${sampleRatio ? '01' : '00'}`
  // Fixed intents before dispatch, not inferred from observed spans or counters.
  const intents: { path: string; method: 'GET' | 'POST'; status: number; parent: boolean; extra: Record<string, string> }[] = [
    { path: '/v1/health', method: 'GET', status: 200, parent: false, extra: {} },
    { path: '/v1/capabilities', method: 'GET', status: 200, parent: false, extra: {} },
    { path: '/v1/operations', method: 'POST', status: 200, parent: true, extra: {} },
    { path: '/v1/health', method: 'GET', status: 401, parent: false, extra: { Authorization: 'Bearer PRIVATE_WRONG_TOKEN' } },
    { path: '/v1/health', method: 'GET', status: 403, parent: false, extra: { Origin: 'https://PRIVATE_ORIGIN.invalid' } },
    { path: '/PRIVATE_PATH', method: 'GET', status: 404, parent: false, extra: {} },
    { path: '/v1/operations', method: 'POST', status: 400, parent: false, extra: { traceparent: 'PRIVATE_INVALID_PARENT' } },
    { path: '/v1/operations', method: 'POST', status: 200, parent: true, extra: {} },
  ]
  const ledger: { intent: typeof intents[number]; context: ReturnType<typeof parseTraceParent>; body: unknown }[] = []
  for (const intent of intents) {
    const response = await fetch(service.url + intent.path, { method: intent.method,
      headers: { Authorization: `Bearer ${token}`, 'X-Jevable-Protocol': PROTOCOL_VERSION, 'Content-Type': 'application/json',
        traceparent: parent, baggage: 'PRIVATE_BAGGAGE', tracestate: 'PRIVATE_STATE', ...intent.extra },
      ...(intent.method === 'POST' ? { body: JSON.stringify({ operation: 'projects.list' }) } : {}) })
    expect(response.status).toBe(intent.status)
    const header = response.headers.get('x-jevable-traceparent')
    expect(header).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-(00|01)$/u)
    ledger.push({ intent, context: parseTraceParent(header!), body: await response.json() })
  }
  await service.close(); await service.closed
  const receivedSpans = r.packets.filter(p => p.path === '/v1/traces').flatMap(p => spans(p.bytes))
  const logs = r.packets.filter(p => p.path === '/v1/logs').flatMap(p => logRecords(p.bytes))
  expect(receivedSpans).toHaveLength(sampleRatio ? intents.length : 0)
  expect(logs).toHaveLength(intents.length)
  const identities = ledger.map(row => `${row.context!.traceId}/${row.context!.spanId}`)
  expect(new Set(identities).size).toBe(intents.length)
  for (const row of ledger) {
    const context = row.context!, matches = logs.filter(log => log.traceId === context.traceId && log.spanId === context.spanId)
    expect(matches).toHaveLength(1)
    expect(matches[0]!.event).toBe('jevable.http.request.ended')
    expect(matches[0]!.attributes['http.request.method']).toBe(row.intent.method)
    expect(Number(matches[0]!.attributes['http.response.status_code'])).toBe(row.intent.status)
    expect(context.traceFlags).toBe(sampleRatio)
    expect(context.traceId === '1'.repeat(32)).toBe(row.intent.parent)
    if (sampleRatio) {
      const joined = receivedSpans.filter(span => span.traceId === context.traceId && span.spanId === context.spanId)
      expect(joined).toHaveLength(1); expect(joined[0]!.name).toBe('jevable.http.request')
      expect(joined[0]!.parent).toBe(row.intent.parent ? '2'.repeat(16) : undefined)
    }
  }
  const metricPacket = r.packets.filter(p => p.path === '/v1/metrics').at(-1)!
  const count = metricSums(metricPacket.bytes).find(m => m.name === 'jevable.http.requests')!
  expect(count.points.reduce((n, p) => n + p.value, 0)).toBe(intents.length)
  for (const p of count.points) {
    expect(Object.keys(p.labels).sort()).toEqual(['http.request.method', 'jevable.http.outcome', 'jevable.http.status_class',
      ...(p.labels['http.route'] ? ['http.route'] : [])].sort())
    expect(JSON.stringify(p)).not.toMatch(/PRIVATE_|traceId|spanId/)
  }
  expect(Buffer.concat(r.packets.map(p => p.bytes)).includes(Buffer.from('PRIVATE_'))).toBe(false)
  expect(Buffer.concat(r.packets.map(p => p.bytes)).includes(Buffer.from(token))).toBe(false)
  expect(ledger.filter(row => row.intent.parent).map(row => row.body)).toEqual([
    { schemaVersion: 1, instanceId: service.instanceId, result: { schemaVersion: 1, projects: [] } },
    { schemaVersion: 1, instanceId: service.instanceId, result: { schemaVersion: 1, projects: [] } },
  ])
})

it.each(['throw', 'invalid', 'zero', 'injection', 'missing'] as const)('custom diagnostic %s never changes or redispatches work', async mode => {
  let calls = 0
  const service = await startRuntimeServer({ token, actor: 'owner' }, async () => ({ capabilities: () => ({}),
    withTraceParent: (_parent, op) => op(), close: async () => {}, operation: async () => ({ count: ++calls }),
    observeHttpRequest: () => ({ run: (_parent, op) => op(), end() {},
      ...(mode === 'missing' ? {} : { responseTraceparent: () => {
        if (mode === 'throw') throw Error('PRIVATE_DIAGNOSTIC')
        return mode === 'zero' ? `00-${'0'.repeat(32)}-${'1'.repeat(16)}-01`
          : mode === 'injection' ? `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01\r\nAuthorization: PRIVATE_TOKEN` : 'PRIVATE_INVALID'
      } }),
    }),
  }))
  cleanup.push(async () => { await service.close(); await service.closed })
  const response = await fetch(service.url + '/v1/operations', { method: 'POST', headers: {
    Authorization: `Bearer ${token}`, 'X-Jevable-Protocol': PROTOCOL_VERSION, 'Content-Type': 'application/json' }, body: '{}' })
  expect(response.status).toBe(200); expect((await response.json()).result).toEqual({ count: 1 })
  expect(response.headers.get('x-jevable-traceparent')).toBeNull(); expect(calls).toBe(1)
})

it('correlates public HTML and session responses without adopting their inbound parent or leaking the session', async () => {
  const r = await receiver(), source = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'context-preview', name: 'Preview' },
    spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
      end: { type: 'output', config: { value: '${{ inputs }}' } } }, edges: [{ from: 'start', to: 'end' }] } })
  const service = await startRuntimeService({ token, actor: 'PRIVATE_ACTOR', preview: { source },
    runtime: { dataDirectory: await mkdtemp(join(tmpdir(), 'jevable-context-preview-')), telemetry: config(r.origin, { httpResponseContext: true }) } })
  cleanup.push(async () => { await service.close(); await service.closed })
  const parent = `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`, contexts: NonNullable<ReturnType<typeof parseTraceParent>>[] = []
  const capture = (response: Response) => { const context = parseTraceParent(response.headers.get('x-jevable-traceparent')!)!
    expect(context.traceId).not.toBe('1'.repeat(32)); contexts.push(context) }
  const page = await fetch(service.url + '/', { headers: { traceparent: parent } }); expect(page.status).toBe(200); capture(page)
  expect(await page.text()).not.toContain(token)
  const boot = await fetch(service.url + '/v1/preview/bootstrap', { method: 'POST', headers: {
    Authorization: `Bearer ${token}`, 'X-Jevable-Protocol': PROTOCOL_VERSION, 'Content-Type': 'application/json', traceparent: parent }, body: '{}' })
  expect(boot.status).toBe(200); capture(boot); const session = (await boot.json()).result.token
  const logout = await fetch(service.url + '/v1/preview/logout', { method: 'POST', headers: {
    Authorization: `Bearer ${session}`, 'X-Jevable-Protocol': PROTOCOL_VERSION, 'Content-Type': 'application/json', traceparent: parent }, body: '{}' })
  expect(logout.status).toBe(200); capture(logout); await logout.json()
  await service.close(); await service.closed
  const received = r.packets.filter(p => p.path === '/v1/traces').flatMap(p => spans(p.bytes))
  expect(received).toHaveLength(3)
  for (const context of contexts) expect(received.find(span => span.spanId === context.spanId && span.traceId === context.traceId)?.parent).toBeUndefined()
  expect(Buffer.concat(r.packets.map(p => p.bytes)).includes(Buffer.from(session))).toBe(false)
})

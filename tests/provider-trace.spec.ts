import { it, expect, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ConfiguredModels } from '../src/providers/model-calls.ts'
import { modelEvidenceSchema, type ModelEvidence } from '../src/providers/records.ts'
import type { ProviderPersistence } from '../src/providers/persistence.ts'
import { connectionRecordSchema, type ProviderConnection } from '../src/providers/config.ts'
import { compileLocalRun, executionModelPlans } from '../src/runtime/run-evaluator.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { runTrace, type JevableAttemptId } from '../src/runtime/run-types.ts'
import { LocalRuntime } from '../src/runtime/local.ts'
import { ProviderStore } from '../src/providers/store.ts'
import { traceRecords } from '../scripts/check-postgres-telemetry.mjs'
import { metricSums, logRecords } from '../scripts/check-telemetry-package.mjs'

const source = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'trace-model', name: 'Trace model' },
  spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
    model: { type: 'llm', config: { provider: 'fixture', model: 'fixture', connection: { mode: 'workspace', id: 'fixture' },
      prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 10, stream: false }, historyScope: 'none', execution: { maxAttempts: 1, timeoutSeconds: 2 } } },
    output: { type: 'output', config: { value: '${{ nodes.model.output }}' } } }, edges: [{ from: 'start', to: 'model' }, { from: 'model', to: 'output' }] } })
const node = executionModelPlans(compileLocalRun(source, DEFAULT_COMPILER_LIMITS))[0]!
const input = { prompt: 'PRIVATE_INPUT', systemPrompt: '' }, trace = runTrace.parse({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 })
const header = `00-${trace.traceId}-${trace.spanId}-01`
const connection: ProviderConnection = { id: 'fixture', provider: 'fixture', protocol: 'openai-compatible', endpoint: 'http://127.0.0.1:1/v1',
  allowedModels: ['fixture'], authentication: { kind: 'none' }, tokenParameter: 'max_tokens', maxResponseBytes: 10000,
  maxRequestBytes: 10000, maxStreamEvents: 100, maxTimeoutSeconds: 2 }
const completion = { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'output' } }] }
const response = () => new Response(JSON.stringify(completion), { headers: { 'content-type': 'application/json' } })
const id = () => randomUUID() as JevableAttemptId
const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function fixture(propagation?: 'none' | 'w3c') {
  const records: ModelEvidence[] = [], route = { generation: 1, updatedAt: new Date().toISOString(), connection: { ...connection, ...(propagation ? { tracePropagation: propagation } : {}) } }
  const persistence: ProviderPersistence = { connection: async () => route, credential: async () => undefined,
    evidence: async () => records.at(-1), saveEvidence: async record => { records.push(structuredClone(record)) } }
  return { records, route, persistence }
}
it.each([undefined, 'none', 'w3c'] as const)('requires per-connection opt-in and saves the exact outgoing header before dispatch: %s', async propagation => {
  const f = fixture(propagation), calls: Record<string, string>[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    calls.push(options.headers); expect(f.records).toHaveLength(1)
    expect(f.records[0]?.traceparent).toBe(propagation === 'w3c' ? header : undefined)
    expect(f.records[0]?.trace).toEqual(trace)
    return response()
  }))
  await new ConfiguredModels(f.persistence).execute(node, input, id(), undefined, { trace })
  expect(calls[0]?.traceparent).toBe(propagation === 'w3c' ? header : undefined)
  expect(calls[0]?.tracestate).toBeUndefined(); expect(calls[0]?.baggage).toBeUndefined()
  expect(f.records[1]?.traceparent).toBe(f.records[0]?.traceparent)
  expect(f.records[1]?.trace).toEqual(trace)
  expect(JSON.stringify(f.records)).not.toContain('authorization')
})
it('does not invent a header without an explicit runtime context', async () => {
  const f = fixture('w3c'), fetch = vi.fn(async (_url: unknown, _options: any) => response()); vi.stubGlobal('fetch', fetch)
  await new ConfiguredModels(f.persistence).execute(node, input, id())
  expect(fetch.mock.calls[0]?.[1]?.headers.traceparent).toBeUndefined()
  expect(f.records[0]?.traceparent).toBeUndefined()
  expect(f.records[0]?.trace).toBeUndefined()
})
it('clones context before async admission and preserves unsampled flags', async () => {
  const f = fixture('w3c'), admitted = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  f.persistence.connection = async () => { admitted.resolve(); await gate.promise; return f.route }
  const context = { trace: { ...trace, traceFlags: 0 as const } }, fetch = vi.fn(async (_url: unknown, _options: any) => response()); vi.stubGlobal('fetch', fetch)
  const executing = new ConfiguredModels(f.persistence).execute(node, input, id(), undefined, context)
  await admitted.promise; context.trace.spanId = 'c'.repeat(16) as typeof trace.spanId; gate.resolve(); await executing
  expect(f.records[0]?.traceparent).toBe(header.slice(0, -2) + '00')
  expect(f.records[0]?.trace).toEqual({ ...trace, traceFlags: 0 })
  expect(fetch.mock.calls[0]?.[1]?.headers.traceparent).toBe(f.records[0]?.traceparent)
})
it('never dispatches a header/request before durable intent acknowledgement, including lost acknowledgement', async () => {
  const f = fixture('w3c'), fetch = vi.fn(async () => response()); vi.stubGlobal('fetch', fetch)
  f.persistence.saveEvidence = async record => { f.records.push(structuredClone(record)); throw Error('commit uncertain') }
  const models = new ConfiguredModels(f.persistence), attempt = id()
  await expect(models.execute(node, input, attempt, undefined, { trace })).rejects.toThrow('commit uncertain')
  expect(f.records[0]?.traceparent).toBe(header); expect(fetch).not.toHaveBeenCalled()
  expect(f.records[0]?.trace).toEqual(trace)
  await expect(models.execute(node, input, attempt, undefined, { trace })).rejects.toHaveProperty('code', 'uncertain-attempt')
  expect(fetch).not.toHaveBeenCalled()
})
it('retains original correlation across historical inspection and retry after connection policy changes', async () => {
  const f = fixture('w3c'), fetch = vi.fn(async () => response()); vi.stubGlobal('fetch', fetch)
  const models = new ConfiguredModels(f.persistence), attempt = id()
  await models.execute(node, input, attempt, undefined, { trace })
  f.route.connection.tracePropagation = 'none'
  await models.verify(node, attempt, input, 'output')
  expect(await models.execute(node, input, attempt)).toMatchObject({ output: 'output' })
  expect(fetch).toHaveBeenCalledTimes(1); expect(f.records.at(-1)?.traceparent).toBe(header)
})
it('does not follow redirects or send correlation to another endpoint', async () => {
  const f = fixture('w3c'), fetch = vi.fn(async (_url, options) => {
    expect(options.redirect).toBe('manual'); return new Response('', { status: 307, headers: { location: 'https://must-not-contact.invalid/' } })
  }); vi.stubGlobal('fetch', fetch)
  await expect(new ConfiguredModels(f.persistence).execute(node, input, id(), undefined, { trace })).rejects.toHaveProperty('code', 'http-error')
  expect(fetch).toHaveBeenCalledTimes(1); expect(f.records[1]?.traceparent).toBe(header)
})
it.each([{ traceId: '0'.repeat(32) }, { spanId: '0'.repeat(16) }, { traceFlags: 2 }, { traceId: 'A'.repeat(32) }, { baggage: 'PRIVATE' }])('refuses invalid explicit context before storage/network %j', async change => {
  const f = fixture('w3c'), fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  await expect(new ConfiguredModels(f.persistence).execute(node, input, id(), undefined, { trace: { ...trace, ...change } } as never)).rejects.toHaveProperty('code', 'invalid-config')
  expect(fetch).not.toHaveBeenCalled(); expect(f.records).toHaveLength(0)
})
it('preserves old evidence shape and rejects corrupt/policy-inconsistent headers and settlement rewrites', () => {
  const f = fixture('w3c'), evidence: ModelEvidence = { schemaVersion: 1, attemptId: id(), at: new Date().toISOString(), route: f.route,
    request: {}, result: { status: 'pending' }, traceparent: header }
  expect(modelEvidenceSchema.parse(evidence)).toEqual(evidence)
  const { tracePropagation: _policy, ...legacyConnection } = f.route.connection
  const { traceparent: _trace, ...legacy } = evidence; legacy.route = { ...f.route, connection: legacyConnection }
  expect(modelEvidenceSchema.parse(legacy)).toEqual(legacy); expect(connectionRecordSchema.parse(legacy.route)).toEqual(legacy.route)
  for (const bad of ['00-' + '0'.repeat(32) + '-' + trace.spanId + '-01', header.replace('-01', '-03'), header + '\r\nbaggage: secret']) {
    expect(modelEvidenceSchema.safeParse({ ...evidence, traceparent: bad }).success).toBe(false)
  }
  expect(modelEvidenceSchema.safeParse({ ...legacy, traceparent: header }).success).toBe(false)
  const db = new DatabaseSync(':memory:'); cleanup.push(() => db.close())
  db.exec('CREATE TABLE model_calls(attempt_id TEXT PRIMARY KEY, record TEXT NOT NULL)')
  const store = new ProviderStore(db, 100000); store.saveEvidence(evidence)
  const settled = { ...evidence, result: { status: 'completed' as const, output: 'output', usage: { tries: 1 as const }, at: new Date().toISOString() } }
  expect(() => store.saveEvidence({ ...settled, traceparent: header.slice(0,-2) + '00' })).toThrow('conflict')
  store.saveEvidence(settled); expect(store.evidence(evidence.attemptId)?.traceparent).toBe(header)
})
it.each([0, 1])('correlates actual model HTTP, durable evidence and private model span at sampling=%s', async sampleRatio => {
  const requests: any[] = [], spans: any[] = []
  const server = createServer(async (request, reply) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk)
    if (request.url === '/v1/traces') { spans.push(...traceRecords(Buffer.concat(chunks))); reply.writeHead(200, { 'content-type': 'application/x-protobuf' }); reply.end(); return }
    requests.push(request.headers); reply.writeHead(200, { 'content-type': 'application/json' }); reply.end(JSON.stringify(completion))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, directory = await mkdtemp(join(tmpdir(), 'jevable-provider-trace-'))
  const runtime = await LocalRuntime.open({ dataDirectory: directory, telemetry: { endpoint: endpoint + '/traces', sampleRatio,
    authentication: { kind: 'none' }, intervalMs: 60000, timeoutMs: 1000, flushTimeoutMs: 2000 } })
  cleanup.push(() => runtime.close())
  runtime.configureConnection({ ...connection, endpoint, tracePropagation: 'w3c' }, 0, 'fixture')
  const run = await runtime.withTraceParent(header, () => runtime.run(source, 'PRIVATE_INPUT'))
  await runtime.telemetryFlush()
  const nodeTrace = run.state.steps.find(s => s.nodeId === 'model')!.inspection!.trace!
  expect(requests).toHaveLength(1); expect(requests[0].traceparent).toMatch(new RegExp(`^00-${trace.traceId}-[a-f0-9]{16}-0${sampleRatio}$`))
  expect(requests[0].traceparent).not.toContain(nodeTrace.spanId); expect(requests[0].baggage).toBeUndefined(); expect(requests[0].tracestate).toBeUndefined()
  if (sampleRatio) { const model = spans.find(s => s.name === 'jevable.model'); expect(requests[0].traceparent).toBe(`00-${model.traceId}-${model.spanId}-01`); expect(model.parent).toBe(nodeTrace.spanId) }
  else expect(spans).toHaveLength(0)
  await runtime.close()
  const db = new DatabaseSync(join(directory, 'runtime.sqlite'), { readOnly: true }); cleanup.push(() => db.close())
  const record = JSON.parse((db.prepare('SELECT record FROM model_calls').get() as { record: string }).record)
  expect(record.traceparent).toBe(requests[0].traceparent)
  expect(record.trace).toEqual({ traceId: trace.traceId, spanId: requests[0].traceparent.slice(36, 52), traceFlags: sampleRatio })
  const reopened = await LocalRuntime.open({ dataDirectory: directory }); cleanup.push(() => reopened.close())
  expect((await reopened.show(run.id)).state.status).toBe('completed'); expect(requests).toHaveLength(1)
  expect((await reopened.exportRun(run.id)).snapshot.models?.calls[0]).toMatchObject({ trace: record.trace })
})

it.each([
  { sampleRatio: 1, propagate: true, traces: true, outage: false },
  { sampleRatio: 1, propagate: false, traces: true, outage: false },
  { sampleRatio: 0, propagate: true, traces: true, outage: false },
  { sampleRatio: 1, propagate: false, traces: false, outage: false },
  { sampleRatio: 1, propagate: true, traces: true, outage: true },
])('joins retry evidence with child spans, bounded counters and redacted logs: %j', async policy => {
  const requests: any[] = [], signals: { path: string; bytes: Buffer }[] = []
  const server = createServer(async (request, reply) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk)
    if (request.url !== '/v1/chat/completions') {
      signals.push({ path: request.url!, bytes: Buffer.concat(chunks) })
      reply.writeHead(policy.outage ? 503 : 200, { 'content-type': 'application/x-protobuf' }); reply.end(); return
    }
    requests.push(request.headers)
    if (requests.length === 1) { reply.writeHead(503); reply.end('PRIVATE_HTTP_ERROR'); return }
    reply.writeHead(200, { 'content-type': 'application/json' }); reply.end(JSON.stringify(completion))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, directory = await mkdtemp(join(tmpdir(), 'jevable-retry-telemetry-'))
  const telemetry = { ...(policy.traces ? { endpoint: endpoint + '/traces' } : {}), metricsEndpoint: endpoint + '/metrics', logsEndpoint: endpoint + '/logs',
    sampleRatio: policy.sampleRatio, authentication: { kind: 'none' as const }, intervalMs: 60000, timeoutMs: 1000, flushTimeoutMs: 2000 }
  const runtime = await LocalRuntime.open({ dataDirectory: directory, telemetry }); cleanup.push(() => runtime.close())
  runtime.configureConnection({ ...connection, endpoint, tracePropagation: policy.propagate ? 'w3c' : 'none' }, 0, 'fixture')
  const doc = JSON.parse(source); doc.spec.nodes.model.config.execution.maxAttempts = 2
  const run = await runtime.run(JSON.stringify(doc), 'PRIVATE_INPUT')
  await runtime.telemetryFlush(); expect(run.state.status).toBe('completed'); expect(requests).toHaveLength(2)
  const db = new DatabaseSync(join(directory, 'runtime.sqlite'), { readOnly: true }); cleanup.push(() => db.close())
  const evidence = JSON.parse((db.prepare('SELECT record FROM model_calls').get() as { record: string }).record)
  expect(evidence.tries).toHaveLength(2)
  expect(evidence.tries.every((t: any) => runTrace.safeParse(t.trace).success)).toBe(true)
  expect(new Set(evidence.tries.map((t: any) => t.trace.spanId)).size).toBe(2)
  const sampled = policy.traces && policy.sampleRatio === 1
  expect(evidence.tries.map((t: any) => t.trace.traceFlags)).toEqual([Number(sampled), Number(sampled)])
  const spans = signals.filter(s => s.path === '/v1/traces').flatMap(s => traceRecords(s.bytes))
  if (sampled) {
    const model = spans.find((s: any) => s.name === 'jevable.model')!, children = spans.filter((s: any) => s.name === 'jevable.model.try')
    expect(children).toHaveLength(2)
    for (const [index, child] of children.entries()) {
      expect(child.parent).toBe(model.spanId); expect(child.traceId).toBe(model.traceId)
      expect(child.spanId).toBe(evidence.tries[index].trace.spanId)
      expect(child.attributes['jevable.model.try.id']).toBe(evidence.tries[index].id)
      expect(child.attributes['jevable.model.try.dispatched']).toBe(true)
      expect(child.attributes['jevable.model.try.settled']).toBe(true)
      expect(child.attributes['http.response.status_code']).toBe(index ? 200 : 503)
    }
    const backoffs = spans.filter((s: any) => s.name === 'jevable.model.backoff')
    expect(backoffs).toHaveLength(1)
    expect(backoffs[0]).toMatchObject({ parent: model.spanId, traceId: model.traceId, attributes: {
      'jevable.model.try.id': evidence.tries[0].id, 'jevable.model.try.number': 1, 'jevable.model.backoff.delay_ms': 100, 'jevable.outcome': 'completed' } })
  } else expect(spans).toHaveLength(0)
  if (policy.propagate) {
    expect(requests[0].traceparent).toBe(evidence.traceparent); expect(requests[1].traceparent).toBe(evidence.traceparent)
    expect(evidence.tries.every((t: any) => !evidence.traceparent.includes(t.trace.spanId))).toBe(true)
  } else expect(requests.every(r => r.traceparent === undefined)).toBe(true)
  const sums = signals.filter(s => s.path === '/v1/metrics').flatMap(s => metricSums(s.bytes))
  const attempts = sums.find((m: any) => m.name === 'jevable.model.try.attempts')!
  expect(attempts.points).toHaveLength(2)
  for (const point of attempts.points) {
    expect(point.value).toBe(1)
    expect(Object.keys(point.labels).sort()).toEqual(['jevable.model.try.dispatched', 'jevable.model.try.phase', 'jevable.model.try.settled', 'jevable.node.kind', 'jevable.outcome'])
    expect(point.labels['jevable.model.try.dispatched']).toBe(true)
    expect(point.labels['jevable.model.try.settled']).toBe(true)
    expect(point.labels['jevable.outcome']).toBe(point.labels['jevable.model.try.phase'] === 'initial' ? 'failed' : 'completed')
  }
  expect(sums.find((m: any) => m.name === 'jevable.model.calls')!.points.reduce((sum: number, p: any) => sum + p.value, 0)).toBe(1)
  expect(sums.find((m: any) => m.name === 'jevable.model.backoff.waits')!.points).toEqual([{ value: 1, labels: { 'jevable.node.kind': 'llm', 'jevable.outcome': 'completed' } }])
  expect(sums.find((m: any) => m.name === 'jevable.model.backoff.active')!.points).toEqual([{ value: 0, labels: { 'jevable.node.kind': 'llm' } }])
  const logs = signals.filter(s => s.path === '/v1/logs').flatMap(s => logRecords(s.bytes)).filter((l: any) => l.event === 'jevable.model.try.ended')
  expect(logs).toHaveLength(2)
  for (const [index, log] of logs.entries()) {
    expect(log.spanId).toBe(evidence.tries[index].trace.spanId)
    expect(log.attributes['jevable.model.try.id']).toBe(evidence.tries[index].id)
    expect(log.attributes['jevable.model.try.number']).toBe(index + 1)
    expect(log.attributes['jevable.model.try.settled']).toBe(true)
  }
  const backoffLogs = signals.filter(s => s.path === '/v1/logs').flatMap(s => logRecords(s.bytes)).filter((l: any) => l.event === 'jevable.model.backoff.ended')
  expect(backoffLogs).toHaveLength(1)
  expect(backoffLogs[0]!.attributes).toMatchObject({ 'jevable.model.try.id': evidence.tries[0].id, 'jevable.model.try.number': 1,
    'jevable.model.backoff.delay_ms': 100, 'jevable.outcome': 'completed' })
  if (sampled) expect(backoffLogs[0]!.spanId).toBe(spans.find((s: any) => s.name === 'jevable.model.backoff')!.spanId)
  for (const signal of signals) { expect(signal.bytes.includes('PRIVATE_INPUT')).toBe(false); expect(signal.bytes.includes('PRIVATE_HTTP_ERROR')).toBe(false) }
  const count = signals.length
  expect((await runtime.show(run.id)).state.status).toBe('completed'); await runtime.telemetryFlush()
  expect(requests).toHaveLength(2); expect(signals).toHaveLength(count)
  await runtime.close()
  const reopened = await LocalRuntime.open({ dataDirectory: directory, telemetry }); cleanup.push(() => reopened.close())
  expect((await reopened.show(run.id)).state.status).toBe('completed'); await reopened.telemetryFlush()
  expect(requests).toHaveLength(2); expect(signals).toHaveLength(count)
})

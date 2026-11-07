import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { ProtobufLogsSerializer, JsonLogsSerializer } from '@opentelemetry/otlp-transformer'
import { LocalRuntime } from '../src/runtime/local.ts'
import { RunStore } from '../src/runtime/store.ts'
import { RuntimeTelemetry } from '../src/telemetry/traces.ts'
import { parseTelemetryConfig } from '../src/telemetry/config.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers() })
const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const attrs = (record: any) => Object.fromEntries(record.attributes.map((a: any) => [a.key, a.value.stringValue ?? a.value.intValue ?? a.value.doubleValue ?? a.value.boolValue]))
async function fixture(reply?: (res: ServerResponse) => void) {
  const requests: { bytes: Buffer; authorization: string | undefined; url: string | undefined }[] = [], batches: any[] = [], encoded: Uint8Array[] = []
  const serialize = ProtobufLogsSerializer.serializeRequest
  vi.spyOn(ProtobufLogsSerializer, 'serializeRequest').mockImplementation(records => {
    batches.push(JSON.parse(Buffer.from(JsonLogsSerializer.serializeRequest(records)!).toString()))
    const bytes = serialize(records)!; encoded.push(bytes); return bytes
  })
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
    requests.push({ bytes: Buffer.concat(chunks), authorization: req.headers.authorization, url: req.url })
    if (reply) reply(res); else { res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.end() }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('no listener')
  const config = { logsEndpoint: `http://127.0.0.1:${address.port}/v1/logs`, authentication: { kind: 'none' as const },
    intervalMs: 60000, timeoutMs: 100, flushTimeoutMs: 500 }
  const records = () => batches.flatMap(batch => batch.resourceLogs.flatMap((r: any) => r.scopeLogs.flatMap((s: any) => s.logRecords)))
  return { config, requests, batches, encoded, records }
}
async function owner(telemetry?: Parameters<typeof LocalRuntime.open>[0]['telemetry']) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-logs-'))
  const runtime = await LocalRuntime.open({ dataDirectory, ...(telemetry ? { telemetry } : {}) })
  cleanup.push(() => runtime.close()); return { runtime, dataDirectory }
}

it('limits recovery logs to resume observations and validated control identity', async () => {
  const receiver = await fixture(), telemetry = new RuntimeTelemetry(receiver.config, () => undefined)
  cleanup.push(() => telemetry.close())
  for (const requestId of [randomUUID(), 'PRIVATE_INVALID_ID']) {
    const span = telemetry.start('jevable.resume', {})
    span.setAttributes({ 'jevable.control.mode': 'recover', 'jevable.control.request_id': requestId, 'jevable.recovery.settled': true })
    telemetry.end(span, 'paused'); span.end()
  }
  const unrelated = telemetry.start('jevable.model', {})
  unrelated.setAttributes({ 'jevable.control.mode': 'recover', 'jevable.control.request_id': 'PRIVATE_INVALID_ID' })
  telemetry.end(unrelated, 'completed')
  await telemetry.flush()
  const records = receiver.records(); expect(records).toHaveLength(3)
  expect(attrs(records[0])['jevable.control.request_id']).toMatch(/^[a-f0-9-]{36}$/)
  expect(attrs(records[1])).toMatchObject({ 'jevable.control.mode': 'recover', 'jevable.recovery.settled': true })
  expect(attrs(records[1])).not.toHaveProperty('jevable.control.request_id')
  expect(attrs(records[2])).not.toHaveProperty('jevable.control.mode')
  expect(JSON.stringify(receiver.batches)).not.toContain('PRIVATE_')
})

describe('standalone structured execution logs', () => {
  it('logs backoff endings once with validated delay/try metadata and no private payloads or invalid values', async () => {
    const receiver = await fixture(), telemetry = new RuntimeTelemetry(receiver.config, () => undefined)
    cleanup.push(() => telemetry.close())
    const tryId = randomUUID()
    for (const delay of [100, 99, -1, 3_600_001, NaN, 'PRIVATE_DELAY']) {
      const span = telemetry.start('jevable.model.backoff', { 'jevable.node.kind': 'llm', 'jevable.model.try.id': tryId,
        'jevable.model.try.number': 1, 'jevable.model.backoff.delay_ms': delay, 'private.prompt': 'PRIVATE_PROMPT' })
      telemetry.end(span, 'completed'); span.end()
    }
    await telemetry.flush()
    const records = receiver.records(); expect(records).toHaveLength(6)
    expect(records.every(record => record.eventName === 'jevable.model.backoff.ended')).toBe(true)
    expect(attrs(records[0])).toMatchObject({ 'jevable.model.try.id': tryId, 'jevable.model.try.number': 1, 'jevable.model.backoff.delay_ms': 100 })
    for (const record of records.slice(1)) expect(attrs(record)).not.toHaveProperty('jevable.model.backoff.delay_ms')
    expect(records.every(record => Number(attrs(record)['jevable.duration.seconds']) >= 0)).toBe(true)
    expect(JSON.stringify(receiver.batches)).not.toContain('PRIVATE_')
  })

  it('emits a linked cancellation end event without its actor or input payload', async () => {
    const receiver = await fixture(), { runtime } = await owner(receiver.config)
    const waiting = await runtime.run(approval, { message: 'PRIVATE_CANCEL_INPUT' })
    const stopped = runtime.cancel(waiting.id, randomUUID(), 'PRIVATE_CANCEL_ACTOR')
    await runtime.telemetryFlush()
    const record = receiver.records().find(record => attrs(record)['jevable.operation'] === 'cancel')
    expect(record.eventName).toBe('jevable.execution.segment.ended')
    expect(attrs(record)['jevable.outcome']).toBe('cancelled')
    expect(attrs(record)['jevable.previous.span_id']).toBe(waiting.traceSegments![0]!.trace.spanId)
    expect(record.spanId).toBe(stopped.traceSegments!.at(-1)!.trace.spanId)
    expect(JSON.stringify(receiver.batches)).not.toContain('PRIVATE_CANCEL')
  })

  it('exports allowlisted logs with exact saved trace/node correlation and no payloads', async () => {
    const receiver = await fixture()
    vi.stubEnv('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', 'http://invalid.example')
    vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', 'secret=PRIVATE_ENV')
    const { runtime } = await owner(receiver.config), id = randomUUID()
    const run = await runtime.withTraceParent('00-11111111111111111111111111111111-2222222222222222-01', () => runtime.run(echo, 'PRIVATE_INPUT', { id }))
    expect(await runtime.telemetryFlush()).toMatchObject({ signals: ['logs'], logs: { unit: 'log-records', exported: 3, dropped: 0, queued: 0 } })
    expect(receiver.requests).toHaveLength(1); expect(receiver.requests[0]!.url).toBe('/v1/logs')
    expect(receiver.requests[0]!.bytes).toEqual(Buffer.from(receiver.encoded[0]!))
    const records = receiver.records(), segment = records.find(record => record.eventName === 'jevable.execution.segment.ended')
    expect(segment.traceId).toBe(run.traceSegments![0]!.trace.traceId)
    expect(segment.spanId).toBe(run.traceSegments![0]!.trace.spanId)
    expect(segment.traceId).toBe('11111111111111111111111111111111')
    expect(attrs(segment)).toMatchObject({ 'jevable.run.id': id, 'jevable.workflow.revision': run.revision, 'jevable.operation': 'run', 'jevable.outcome': 'completed' })
    for (const step of run.state.steps) {
      const record = records.find(record => attrs(record)['jevable.attempt.id'] === step.inspection!.attemptId)
      expect(record.eventName).toBe('jevable.node.attempt.ended'); expect(record.spanId).toBe(step.inspection!.trace!.spanId)
      expect(record.traceId).toBe(step.inspection!.trace!.traceId)
      expect(Number(attrs(record)['jevable.attempt.number'])).toBe(1)
    }
    for (const record of records) { expect(record.body.stringValue).toBe(record.eventName); expect(record.severityNumber).toBe(9); expect(record.severityText).toBe('INFO') }
    expect(JSON.stringify(receiver.batches)).not.toMatch(/PRIVATE_INPUT|PRIVATE_ENV|Standalone echo/u)
    await runtime.show(id); expect(await runtime.run(echo, 'PRIVATE_INPUT', { id })).toEqual(run)
    await runtime.telemetryFlush(); expect(receiver.requests).toHaveLength(1)
  })

  it('exports logs independently of trace sampling and separates all three exporter health views', async () => {
    const receiver = await fixture(res => { res.writeHead(res.req.url === '/v1/logs' ? 503 : 200, { 'content-type': 'application/x-protobuf' }); res.end() })
    const { runtime } = await owner({ ...receiver.config, sampleRatio: 0,
      endpoint: receiver.config.logsEndpoint.replace('logs', 'traces'), metricsEndpoint: receiver.config.logsEndpoint.replace('logs', 'metrics') })
    expect((await runtime.run(echo, 'completed')).state.status).toBe('completed')
    expect(await runtime.telemetryFlush()).toMatchObject({ signals: ['traces', 'metrics', 'logs'], exported: 0, dropped: 0,
      metrics: { exported: 7, dropped: 0 }, logs: { exported: 0, dropped: 3, failedBatches: 1 } })
    expect(receiver.requests.map(req => req.url).sort()).toEqual(['/v1/logs', '/v1/metrics'])
  })

  it.each(['approve', 'reject'])('links an approval %s log across restart without exporting the actor or review payload', async action => {
    const receiver = await fixture(), { runtime, dataDirectory } = await owner(receiver.config)
    const waiting = await runtime.run(approval, { message: 'PRIVATE_REVIEW' })
    if (waiting.state.status !== 'waiting') throw Error('expected wait')
    await runtime.close()
    const waitLog = receiver.records().find(record => record.eventName === 'jevable.execution.segment.ended')
    expect(attrs(waitLog)['jevable.outcome']).toBe('waiting')
    const restored = await LocalRuntime.open({ dataDirectory, telemetry: receiver.config }); cleanup.push(() => restored.close())
    const settled = await restored.decide(waiting.id, waiting.state.attempt.id, action, 'PRIVATE_ACTOR'); await restored.telemetryFlush()
    const record = receiver.records().find(record => attrs(record)['jevable.operation'] === 'approval')
    expect(record.spanId).toBe(settled.traceSegments![1]!.trace.spanId)
    expect(attrs(record)['jevable.previous.trace_id']).toBe(waiting.traceSegments![0]!.trace.traceId)
    expect(attrs(record)['jevable.previous.span_id']).toBe(waiting.traceSegments![0]!.trace.spanId)
    expect(record.severityNumber).toBe(action === 'approve' ? 9 : 17)
    expect(JSON.stringify(receiver.batches)).not.toMatch(/PRIVATE_REVIEW|PRIVATE_ACTOR/u)
  })

  it.each(['http', 'redirect', 'timeout', 'oversize', 'invalid', 'rejected-count'] as const)('keeps collector %s failure separate from successful execution', async failure => {
    const receiver = await fixture(res => {
      if (failure === 'timeout') return
      res.writeHead(failure === 'http' ? 503 : failure === 'redirect' ? 302 : 200,
        { 'content-type': 'application/x-protobuf', location: 'http://invalid.example' })
      res.end(failure === 'oversize' ? Buffer.alloc(64001) : failure === 'invalid' ? Buffer.from([255]) : failure === 'rejected-count' ? Buffer.from([10, 2, 8, 4]) : Buffer.alloc(0))
    })
    const { runtime } = await owner(receiver.config), id = randomUUID(), run = await runtime.run(echo, 'completed', { id })
    expect(run.state.status).toBe('completed')
    expect(await runtime.telemetryFlush()).toMatchObject({ logs: { failedBatches: 1, exported: 0, dropped: 3 } })
    expect(await runtime.run(echo, 'completed', { id })).toEqual(run)
    await runtime.telemetryFlush(); expect(receiver.requests).toHaveLength(1)
  })

  it('counts partial rejection without retrying the batch', async () => {
    const receiver = await fixture(res => { res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.end(Buffer.from([10, 2, 8, 1])) })
    const { runtime } = await owner(receiver.config); await runtime.run(echo, 'data')
    expect(await runtime.telemetryFlush()).toMatchObject({ logs: { exported: 2, rejected: 1, dropped: 0, lastFailure: 'partial-rejection' } })
    await runtime.telemetryFlush(); expect(receiver.requests).toHaveLength(1)
  })

  it('bounds queue occupancy including in-flight records and aborts unavailable receivers on close', async () => {
    const receiver = await fixture(() => {}), { runtime } = await owner({ ...receiver.config, queueSize: 2, batchSize: 1, timeoutMs: 1000, flushTimeoutMs: 30 })
    await runtime.run(echo, 'data')
    expect(runtime.telemetryStatus()).toMatchObject({ logs: { queued: 2, dropped: 1 } })
    const started = Date.now(); await runtime.close()
    expect(Date.now() - started).toBeLessThan(500)
    expect(runtime.telemetryStatus()).toMatchObject({ logs: { closed: true, dropped: 3, inFlight: 0, queued: 0 } })
  })

  it('contains serialization failure and does not send oversized requests', async () => {
    const receiver = await fixture(), { runtime } = await owner(receiver.config)
    vi.mocked(ProtobufLogsSerializer.serializeRequest).mockReturnValue(new Uint8Array(4_000_001))
    expect((await runtime.run(echo, 'completed')).state.status).toBe('completed')
    expect(await runtime.telemetryFlush()).toMatchObject({ logs: { lastFailure: 'serialization', dropped: 3 } })
    expect(receiver.requests).toHaveLength(0)
  })

  it('flushes newly ended work behind one in-flight batch without duplicate records', async () => {
    const pending: ServerResponse[] = []
    const receiver = await fixture(res => pending.push(res)), { runtime } = await owner({ ...receiver.config, timeoutMs: 2000, flushTimeoutMs: 2000 })
    await runtime.run(echo, 'first')
    const flushing = runtime.telemetryFlush()
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    await runtime.run(echo, 'second')
    const closing = runtime.close()
    expect(pending).toHaveLength(1)
    pending[0]!.writeHead(200, { 'content-type': 'application/x-protobuf' }); pending[0]!.end()
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    pending[1]!.writeHead(200, { 'content-type': 'application/x-protobuf' }); pending[1]!.end()
    await Promise.all([flushing, closing])
    expect(receiver.records()).toHaveLength(6)
    expect(new Set(receiver.records().map(record => record.spanId)).size).toBe(6)
    expect(runtime.telemetryStatus()).toMatchObject({ logs: { closed: true, exported: 6, dropped: 0, queued: 0 } })
  })

  it('exports periodically without requiring a caller flush', async () => {
    const receiver = await fixture(), { runtime } = await owner({ ...receiver.config, intervalMs: 10 })
    await runtime.run(echo, 'periodic')
    await vi.waitFor(() => expect(runtime.telemetryStatus()).toMatchObject({ logs: { exported: 3 } }))
    expect(receiver.records()).toHaveLength(3)
  })

  it('reports uncertain settlement as an error log and preserves the committed attempt identity', async () => {
    const receiver = await fixture(), { runtime } = await owner(receiver.config), id = randomUUID()
    const original = RunStore.prototype.save
    const spy = vi.spyOn(RunStore.prototype, 'save').mockImplementation(function (this: RunStore, record, kind, data) {
      if (kind === 'node-result') throw Error('PRIVATE_DISK_ERROR'); return original.call(this, record, kind, data)
    })
    await expect(runtime.run(echo, 'PRIVATE_INPUT', { id })).rejects.toThrow('PRIVATE_DISK_ERROR'); spy.mockRestore()
    const uncertain = await runtime.show(id); if (uncertain.state.status !== 'executing') throw Error('expected uncertainty')
    await runtime.telemetryFlush()
    const record = receiver.records().find(record => record.eventName === 'jevable.node.attempt.ended')
    expect(record.spanId).toBe(uncertain.state.attempt.trace!.spanId)
    expect(record.severityNumber).toBe(17); expect(attrs(record)['jevable.outcome']).toBe('commit-or-execution-failed')
    expect(JSON.stringify(receiver.batches)).not.toMatch(/PRIVATE_INPUT|PRIVATE_DISK_ERROR/u)
  })

  it('refuses payload attributes, arbitrary events and invalid metadata while retaining bounded model usage', async () => {
    const receiver = await fixture(), telemetry = new RuntimeTelemetry(receiver.config, () => undefined)
    cleanup.push(() => telemetry.close())
    const span = telemetry.start('jevable.model', { 'jevable.run.id': randomUUID(), 'jevable.node.kind': 'llm',
      prompt: 'PRIVATE_PROMPT', actor: 'PRIVATE_ACTOR', 'jevable.node.id': 'x'.repeat(129), 'jevable.attempt.id': 'PRIVATE_NOT_UUID',
      'jevable.workflow.revision': 'PRIVATE_NOT_HASH', 'jevable.loop.id': 'PRIVATE\nCONTROL' })
    span.setAttributes({ 'jevable.model.tries': 1, 'gen_ai.usage.input_tokens': 4, 'gen_ai.usage.output_tokens': 7,
      'jevable.outcome': 'PRIVATE_ARBITRARY_OUTCOME', 'exception.message': 'PRIVATE_EXCEPTION' })
    span.recordException(new Error('PRIVATE_ERROR')); span.addEvent('PRIVATE_EVENT', { secret: 'PRIVATE_EVENT_DATA' })
    span.end(); span.end()
    telemetry.end(telemetry.start('PRIVATE_EVENT_NAME', { secret: 'PRIVATE' }), 'completed')
    telemetry.end(telemetry.start('PRIVATE.run', { secret: 'PRIVATE' }), 'completed')
    await telemetry.flush()
    expect(receiver.records()).toHaveLength(1)
    expect(attrs(receiver.records()[0])).toMatchObject({ 'jevable.outcome': 'other', 'gen_ai.usage.input_tokens': 4,
      'gen_ai.usage.output_tokens': 7, 'jevable.model.tries': 1 })
    expect(JSON.stringify(receiver.batches)).not.toMatch(/PRIVATE|xxxxxxx/u)
  })

  it('resolves rotated protected credentials at export time without leaking secrets', async () => {
    const receiver = await fixture(), { runtime, dataDirectory } = await owner()
    runtime.setCredential('otel/key', 'PRIVATE_OLD_KEY', 0, 'owner'); await runtime.close()
    const logged = await LocalRuntime.open({ dataDirectory, telemetry: { ...receiver.config, authentication: { kind: 'bearer', credentialRef: 'otel/key' } } })
    cleanup.push(() => logged.close()); await logged.run(echo, 'data')
    logged.setCredential('otel/key', 'PRIVATE_NEW_KEY', 1, 'owner'); await logged.telemetryFlush()
    expect(receiver.requests[0]!.authorization).toBe('Bearer PRIVATE_NEW_KEY')
    expect(JSON.stringify(receiver.batches)).not.toMatch(/PRIVATE_OLD_KEY|PRIVATE_NEW_KEY/u)
    expect(JSON.stringify(logged.telemetryStatus())).not.toContain('PRIVATE_')
  })

  it.each(['completed', 'failed'] as const)('records real runtime model %s with exact attempt identity and no generated text or raw error', async outcome => {
    const receiver = await fixture(), dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-model-logs-'))
    const source = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'model', name: 'PRIVATE_MODEL_NAME' },
      spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
        write: { type: 'llm', config: { provider: 'fixture', model: 'fixture-model', connection: { mode: 'workspace', id: 'fixture' },
          prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 20, stream: false },
          execution: { timeoutSeconds: 1, maxAttempts: 1 }, historyScope: 'none' } },
        end: { type: 'output', config: { value: '${{ nodes.write.output }}' } } }, edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }] } })
    const runtime = await LocalRuntime.open({ dataDirectory, telemetry: receiver.config, models: { admit() {}, async verify() {},
      async execute() { if (outcome === 'failed') throw Error('PRIVATE_MODEL_ERROR')
        return { output: 'PRIVATE_MODEL_OUTPUT', usage: { tries: 1, inputTokens: 4, outputTokens: 7 } } } } })
    cleanup.push(() => runtime.close())
    const id = randomUUID()
    if (outcome === 'failed') await expect(runtime.run(source, 'PRIVATE_MODEL_INPUT', { id })).rejects.toThrow('PRIVATE_MODEL_ERROR')
    else expect((await runtime.run(source, 'PRIVATE_MODEL_INPUT', { id })).state.status).toBe('completed')
    const run = await runtime.show(id); await runtime.telemetryFlush()
    const log = receiver.records().find(record => record.eventName === 'jevable.model.call.ended')
    const node = receiver.records().find(record => record.eventName === 'jevable.node.attempt.ended' && attrs(record)['jevable.node.id'] === 'write')
    expect(attrs(log)['jevable.attempt.id']).toBe(attrs(node)['jevable.attempt.id'])
    expect(log.traceId).toBe(node.traceId); expect(log.spanId).not.toBe(node.spanId)
    expect(attrs(log)['jevable.run.id']).toBe(run.id); expect(attrs(log)['jevable.outcome']).toBe(outcome)
    expect(log.severityNumber).toBe(outcome === 'failed' ? 17 : 9)
    if (outcome === 'completed') expect(attrs(log)).toMatchObject({ 'gen_ai.usage.input_tokens': 4, 'gen_ai.usage.output_tokens': 7, 'jevable.model.tries': 1 })
    else expect(attrs(log)['gen_ai.usage.input_tokens']).toBeUndefined()
    expect(JSON.stringify(receiver.batches)).not.toMatch(/PRIVATE_|fixture-model/u)
  })

  it('requires an explicit safe log destination', () => {
    for (const logsEndpoint of ['http://public.example/v1/logs', 'https://user:key@collector.example/v1/logs', 'https://collector.example/v1/logs?key=secret'])
      expect(() => parseTelemetryConfig({ logsEndpoint, authentication: { kind: 'none' } })).toThrow('invalid-command')
  })

  it('honors a configured flush budget above the logger SDK default without a real-time wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(new Error('fixture timeout')), { once: true })
    })))
    const telemetry = new RuntimeTelemetry({ logsEndpoint: 'https://collector.invalid/v1/logs', authentication: { kind: 'none' },
      queueSize: 2, batchSize: 1, timeoutMs: 30000, flushTimeoutMs: 60000, intervalMs: 60000 }, () => undefined)
    cleanup.push(() => telemetry.close())
    telemetry.end(telemetry.start('jevable.run', {}), 'completed')
    telemetry.end(telemetry.start('jevable.run', {}), 'completed')
    let finished = false
    const flush = telemetry.flush().then(() => { finished = true })
    await vi.advanceTimersByTimeAsync(31000)
    expect(finished).toBe(false)
    expect(telemetry.status()).toMatchObject({ logs: { dropped: 1, inFlight: 1 } })
    await vi.advanceTimersByTimeAsync(29000); await flush
    await telemetry.close()
    expect(telemetry.status()).toMatchObject({ logs: { dropped: 2, closed: true } })
  })
})

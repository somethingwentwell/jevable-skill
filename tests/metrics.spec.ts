import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { ProtobufMetricsSerializer, JsonMetricsSerializer } from '@opentelemetry/otlp-transformer'
import { LocalRuntime } from '../src/runtime/local.ts'
import { RunStore } from '../src/runtime/store.ts'
import { RuntimeTelemetry } from '../src/telemetry/traces.ts'
import { parseTelemetryConfig } from '../src/telemetry/config.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const attrs = (point: any) => Object.fromEntries(point.attributes.map((entry: any) => [entry.key, entry.value.stringValue ?? entry.value.intValue ?? entry.value.boolValue]))
const numeric = (point: any) => Number(point.asInt ?? point.asDouble)
async function fixture(reply?: (res: ServerResponse) => void) {
  const requests: { bytes: Buffer; authorization: string | undefined; url: string | undefined }[] = [], batches: any[] = [], encoded: Uint8Array[] = []
  const serialize = ProtobufMetricsSerializer.serializeRequest
  vi.spyOn(ProtobufMetricsSerializer, 'serializeRequest').mockImplementation(metrics => {
    batches.push(JSON.parse(Buffer.from(JsonMetricsSerializer.serializeRequest(metrics)!).toString()))
    const bytes = serialize(metrics)!; encoded.push(bytes); return bytes
  })
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
    requests.push({ bytes: Buffer.concat(chunks), authorization: req.headers.authorization, url: req.url })
    if (reply) reply(res); else { res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.end() }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('no listener')
  const config = { metricsEndpoint: `http://127.0.0.1:${address.port}/v1/metrics`, authentication: { kind: 'none' as const },
    intervalMs: 60000, timeoutMs: 100, flushTimeoutMs: 500 }
  const metrics = (index = batches.length - 1) => batches[index].resourceMetrics.flatMap((r: any) => r.scopeMetrics.flatMap((s: any) => s.metrics))
  const metric = (name: string, index?: number) => metrics(index).find((metric: any) => metric.name === name)
  return { config, requests, batches, encoded, metrics, metric }
}
async function owner(telemetry: Parameters<typeof LocalRuntime.open>[0]['telemetry']) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-metrics-'))
  const runtime = await LocalRuntime.open({ dataDirectory, ...(telemetry ? { telemetry } : {}) })
  cleanup.push(() => runtime.close()); return { runtime, dataDirectory }
}

describe('standalone bounded-cardinality metrics', () => {
  it('observes active backoff separately, ends once and measures wait-only duration with bounded labels', async () => {
    const receiver = await fixture(), telemetry = new RuntimeTelemetry(receiver.config, () => undefined)
    cleanup.push(() => telemetry.close())
    const attributes = { 'jevable.node.kind': 'llm', 'jevable.run.id': randomUUID(), 'jevable.model.try.id': randomUUID(),
      'jevable.model.try.number': 1, 'jevable.model.backoff.delay_ms': 100, 'private.prompt': 'PRIVATE_PROMPT' }
    const span = telemetry.start('jevable.model.backoff', attributes)
    await telemetry.flush()
    expect(receiver.metric('jevable.model.backoff.active').sum.dataPoints.map(numeric)).toEqual([1])
    expect(receiver.metric('jevable.model.backoff.waits')).toBeUndefined()
    expect(receiver.metric('jevable.model.try.attempts')).toBeUndefined()
    telemetry.end(span, 'completed'); span.end()
    await telemetry.flush()
    const waits = receiver.metric('jevable.model.backoff.waits').sum.dataPoints
    expect(waits.map(numeric)).toEqual([1])
    expect(attrs(waits[0])).toEqual({ 'jevable.node.kind': 'llm', 'jevable.outcome': 'completed' })
    expect(receiver.metric('jevable.model.backoff.active').sum.dataPoints.map(numeric)).toEqual([0])
    const duration = receiver.metric('jevable.model.backoff.duration').histogram.dataPoints[0]
    expect(Number(duration.count)).toBe(1); expect(Number(duration.sum)).toBeGreaterThanOrEqual(0)
    expect(attrs(duration)).toEqual(attrs(waits[0]))
    for (const outcome of ['cancelled', 'timeout', 'commit-or-execution-failed', 'PRIVATE_OUTCOME']) {
      const extra = telemetry.start('jevable.model.backoff', { ...attributes, 'jevable.node.kind': 'PRIVATE_KIND' })
      telemetry.end(extra, outcome, true); extra.end()
    }
    await telemetry.flush()
    const all = receiver.metric('jevable.model.backoff.waits').sum.dataPoints
    expect(all.map(numeric).reduce((a: number, b: number) => a + b)).toBe(5)
    expect(all.slice(1).map(attrs)).toEqual(['cancelled', 'timeout', 'commit-or-execution-failed', 'other'].map(outcome => ({ 'jevable.node.kind': 'other', 'jevable.outcome': outcome })))
    expect(receiver.metric('jevable.model.backoff.active').sum.dataPoints.every((p: any) => numeric(p) === 0)).toBe(true)
    expect(JSON.stringify(receiver.batches)).not.toContain('PRIVATE_')
    expect(JSON.stringify(receiver.batches)).not.toContain(attributes['jevable.model.try.id'])
    const count = receiver.requests.length; await telemetry.flush(); expect(receiver.requests).toHaveLength(count)
  })

  it('separates acknowledged and unacknowledged model-try settlement in bounded metric labels', async () => {
    const receiver = await fixture(), telemetry = new RuntimeTelemetry(receiver.config, () => undefined)
    cleanup.push(() => telemetry.close())
    for (const settled of [false, true]) {
      const span = telemetry.start('jevable.model.try', { 'jevable.node.kind': 'llm', 'jevable.model.try.phase': 'initial' })
      span.setAttributes({ 'jevable.model.try.dispatched': true, 'jevable.model.try.settled': settled })
      telemetry.end(span, 'failed', true); span.end()
    }
    await telemetry.flush()
    const points = receiver.metric('jevable.model.try.attempts').sum.dataPoints
    expect(points.map(numeric)).toEqual([1, 1])
    expect(points.map(attrs)).toEqual([false, true].map(settled => ({ 'jevable.node.kind': 'llm', 'jevable.outcome': 'failed',
      'jevable.model.try.phase': 'initial', 'jevable.model.try.dispatched': true, 'jevable.model.try.settled': settled })))
  })

  it('bounds recovery labels and ignores other controls, identities and duplicate ends', async () => {
    const receiver = await fixture(), telemetry = new RuntimeTelemetry(receiver.config, () => undefined)
    cleanup.push(() => telemetry.close())
    for (let n = 0; n < 150; n++) {
      const span = telemetry.start('jevable.resume', { 'jevable.run.id': randomUUID() })
      span.setAttributes({ 'jevable.control.mode': 'recover', 'jevable.control.request_id': randomUUID(), 'jevable.recovery.settled': n % 2 === 0 })
      telemetry.end(span, 'PRIVATE_OUTCOME_' + n); span.end()
    }
    for (const mode of ['step', 'continue', 'PRIVATE_UNKNOWN_MODE']) {
      const span = telemetry.start('jevable.resume', {})
      span.setAttributes({ 'jevable.control.mode': mode, 'jevable.recovery.settled': true }); telemetry.end(span, 'paused')
    }
    const other = telemetry.start('jevable.model', { 'jevable.node.kind': 'llm' })
    other.setAttribute('jevable.control.mode', 'recover'); telemetry.end(other, 'completed')
    await telemetry.flush()
    const points = receiver.metric('jevable.recovery.attempts').sum.dataPoints
    expect(points).toHaveLength(2); expect(points.map(numeric)).toEqual([75, 75])
    expect(points.map(attrs)).toEqual([
      { 'jevable.outcome': 'other', 'jevable.recovery.settled': true },
      { 'jevable.outcome': 'other', 'jevable.recovery.settled': false },
    ])
    expect(JSON.stringify(receiver.batches)).not.toContain('PRIVATE_')
  })
  it('counts an explicit cancellation once under its bounded operation/outcome labels', async () => {
    const receiver = await fixture(), { runtime } = await owner(receiver.config)
    const waiting = await runtime.run(approval, { message: 'PRIVATE_CANCEL_INPUT' })
    const stopped = runtime.cancel(waiting.id, randomUUID(), 'PRIVATE_CANCEL_ACTOR')
    await runtime.telemetryFlush()
    const point = receiver.metric('jevable.execution.segments').sum.dataPoints.find((point: any) => attrs(point)['jevable.operation'] === 'cancel')
    expect(attrs(point)).toEqual({ 'jevable.operation': 'cancel', 'jevable.outcome': 'cancelled' })
    expect(numeric(point)).toBe(1)
    expect(JSON.stringify(receiver.batches)).not.toContain('PRIVATE_CANCEL')
    const count = receiver.requests.length
    runtime.cancel(waiting.id, stopped.cancellation!.id, 'local:retry'); await runtime.telemetryFlush()
    expect(receiver.requests).toHaveLength(count)
  })

  it('exports metrics without traces and does not recount inspection or stable-ID retries', async () => {
    const receiver = await fixture()
    vi.stubEnv('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', 'http://invalid.example')
    vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', 'secret=ENV_SECRET')
    const { runtime } = await owner(receiver.config), id = randomUUID()
    const run = await runtime.run(echo, 'PRIVATE_INPUT', { id })
    expect(run.traceSegments![0]!.trace.traceFlags).toBe(0)
    expect(await runtime.telemetryFlush()).toMatchObject({ signals: ['metrics'], metrics: { successfulBatches: 1, dropped: 0, queued: 0, pendingChanges: false } })
    expect(receiver.requests).toHaveLength(1); expect(receiver.requests[0]!.url).toBe('/v1/metrics')
    expect(receiver.requests[0]!.bytes).toEqual(Buffer.from(receiver.encoded[0]!))
    const segments = receiver.metric('jevable.execution.segments').sum
    expect(segments.aggregationTemporality).toBe(2); expect(segments.isMonotonic).toBe(true)
    expect(segments.dataPoints).toHaveLength(1); expect(numeric(segments.dataPoints[0])).toBe(1)
    expect(attrs(segments.dataPoints[0])).toEqual({ 'jevable.operation': 'run', 'jevable.outcome': 'completed' })
    expect(receiver.metric('jevable.node.attempts').sum.dataPoints.map(numeric)).toEqual([1, 1])
    expect(receiver.metric('jevable.execution.active').sum.dataPoints.map(numeric)).toEqual([0])
    const duration = receiver.metric('jevable.execution.duration').histogram.dataPoints[0]
    expect(Number(duration.count)).toBe(1); expect(duration.sum).toBeGreaterThanOrEqual(0)
    expect(duration.explicitBounds).toEqual([0.001, 0.01, 0.1, 0.5, 1, 5, 10, 30, 60, 300, 3600])
    expect(JSON.stringify(receiver.batches)).not.toMatch(/PRIVATE_INPUT|ENV_SECRET|Standalone echo/u)
    expect(JSON.stringify(receiver.batches)).not.toContain(id)
    await runtime.show(id); expect(await runtime.run(echo, 'PRIVATE_INPUT', { id })).toEqual(run)
    await runtime.telemetryFlush(); expect(receiver.requests).toHaveLength(1)
    await runtime.run(echo, 'another input'); await runtime.telemetryFlush()
    expect(numeric(receiver.metric('jevable.execution.segments').sum.dataPoints[0])).toBe(2)
  })

  it('counts metrics when trace sampling is zero, without trace network traffic', async () => {
    const receiver = await fixture(), { runtime } = await owner({ ...receiver.config, endpoint: receiver.config.metricsEndpoint.replace('metrics', 'traces'), sampleRatio: 0 })
    await runtime.run(echo, 'test')
    expect(await runtime.telemetryFlush()).toMatchObject({ signals: ['traces', 'metrics'], exported: 0, metrics: { successfulBatches: 1 } })
    expect(receiver.requests.map(req => req.url)).toEqual(['/v1/metrics'])
  })

  it('keeps trace failures separate from successful metric export in a combined configuration', async () => {
    const receiver = await fixture(res => { res.writeHead(res.req.url === '/v1/traces' ? 503 : 200, { 'content-type': 'application/x-protobuf' }); res.end() })
    const { runtime } = await owner({ ...receiver.config, endpoint: receiver.config.metricsEndpoint.replace('metrics', 'traces') })
    expect((await runtime.run(echo, 'completed')).state.status).toBe('completed')
    expect(await runtime.telemetryFlush()).toMatchObject({ signals: ['traces', 'metrics'], dropped: 3, exported: 0,
      metrics: { dropped: 0, exported: 7, successfulBatches: 1 } })
    expect(receiver.requests.map(req => req.url).sort()).toEqual(['/v1/metrics', '/v1/traces'])
    expect(numeric(receiver.metric('jevable.execution.segments').sum.dataPoints[0])).toBe(1)
  })

  it('counts wait and approval segments separately across restart without inventing backlog or wait duration', async () => {
    const receiver = await fixture(), { runtime, dataDirectory } = await owner(receiver.config)
    const run = await runtime.run(approval, { message: 'PRIVATE_REVIEW' })
    if (run.state.status !== 'waiting') throw Error('no approval')
    await runtime.close()
    const first = receiver.metric('jevable.execution.segments').sum.dataPoints[0]
    expect(attrs(first)).toEqual({ 'jevable.operation': 'run', 'jevable.outcome': 'waiting' })
    expect(numeric(receiver.metric('jevable.execution.active').sum.dataPoints[0])).toBe(0)
    const restored = await LocalRuntime.open({ dataDirectory, telemetry: receiver.config }); cleanup.push(() => restored.close())
    await restored.decide(run.id, run.state.attempt.id, 'approve', 'PRIVATE_ACTOR'); await restored.telemetryFlush()
    expect(attrs(receiver.metric('jevable.execution.segments').sum.dataPoints[0])).toEqual({ 'jevable.operation': 'approval', 'jevable.outcome': 'completed' })
    expect(numeric(receiver.metric('jevable.execution.segments').sum.dataPoints[0])).toBe(1)
    const resource = (index: number) => Object.fromEntries(receiver.batches[index].resourceMetrics[0].resource.attributes.map((a: any) => [a.key, a.value.stringValue]))
    expect(resource(0)['service.instance.id']).not.toBe(resource(1)['service.instance.id'])
    expect(JSON.stringify(receiver.batches)).not.toMatch(/PRIVATE_REVIEW|PRIVATE_ACTOR/u)
  })

  it.each(['http', 'redirect', 'timeout', 'oversize', 'invalid', 'rejected-count'] as const)('reports collector %s without failing or replaying execution', async failure => {
    const receiver = await fixture(res => {
      if (failure === 'timeout') return
      res.writeHead(failure === 'http' ? 503 : failure === 'redirect' ? 302 : 200,
        { 'content-type': 'application/x-protobuf', location: 'http://invalid.example' })
      res.end(failure === 'oversize' ? Buffer.alloc(64001) : failure === 'invalid' ? Buffer.from([255]) : failure === 'rejected-count' ? Buffer.from([10, 3, 8, 255, 1]) : Buffer.alloc(0))
    })
    const { runtime } = await owner(receiver.config), id = randomUUID(), run = await runtime.run(echo, 'completed', { id })
    expect(run.state.status).toBe('completed')
    expect(await runtime.telemetryFlush()).toMatchObject({ metrics: { failedBatches: 1, exported: 0, dropped: 7, pendingChanges: false } })
    expect(await runtime.run(echo, 'completed', { id })).toEqual(run)
    await runtime.telemetryFlush(); expect(receiver.requests).toHaveLength(1)
  })

  it('accounts for partial rejection and never retries that batch', async () => {
    const receiver = await fixture(res => { res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.end(Buffer.from([10, 2, 8, 1])) })
    const { runtime } = await owner(receiver.config); await runtime.run(echo, 'data')
    expect(await runtime.telemetryFlush()).toMatchObject({ metrics: { exported: 6, rejected: 1, dropped: 0, lastFailure: 'partial-rejection' } })
    await runtime.telemetryFlush(); expect(receiver.requests).toHaveLength(1)
  })

  it('bounds slow-receiver shutdown and leaves no exporter in flight', async () => {
    const receiver = await fixture(() => {}), { runtime } = await owner({ ...receiver.config, timeoutMs: 1000, flushTimeoutMs: 30 })
    await runtime.run(echo, 'data')
    const started = Date.now(); await runtime.close()
    expect(Date.now() - started).toBeLessThan(500)
    expect(runtime.telemetryStatus()).toMatchObject({ metrics: { closed: true, dropped: 7, inFlight: 0, queued: 0 } })
  })

  it('flushes changes made during an in-flight export before closing, without concurrent requests', async () => {
    const pending: ServerResponse[] = []
    const receiver = await fixture(res => pending.push(res)), { runtime } = await owner({ ...receiver.config, timeoutMs: 2000, flushTimeoutMs: 2000 })
    await runtime.run(echo, 'first')
    const first = runtime.telemetryFlush()
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    await runtime.run(echo, 'second')
    const close = runtime.close()
    expect(pending).toHaveLength(1)
    pending[0]!.writeHead(200, { 'content-type': 'application/x-protobuf' }); pending[0]!.end()
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    pending[1]!.writeHead(200, { 'content-type': 'application/x-protobuf' }); pending[1]!.end()
    await Promise.all([first, close])
    expect(numeric(receiver.metric('jevable.execution.segments').sum.dataPoints[0])).toBe(2)
    expect(runtime.telemetryStatus()).toMatchObject({ metrics: { closed: true, abandonedChanges: 0, pendingChanges: false, successfulBatches: 2 } })
  })

  it('periodically exports changed counters in a live owner without an explicit flush', async () => {
    const receiver = await fixture(), { runtime } = await owner({ ...receiver.config, intervalMs: 10 })
    await runtime.run(echo, 'periodic')
    // Cooperative node yields may expose intermediate active/partial snapshots. Await the final cumulative observation.
    await vi.waitFor(() => {
      expect(numeric(receiver.metric('jevable.execution.segments').sum.dataPoints[0])).toBe(1)
      expect(runtime.telemetryStatus()).toMatchObject({ metrics: { pendingChanges: false, inFlight: 0 } })
    })
    const count = receiver.requests.length
    await runtime.close(); expect(receiver.requests).toHaveLength(count)
  })

  it('uses fixed label vocabularies, counts unsampled operations once and records only valid reported usage', async () => {
    const receiver = await fixture(), telemetry = new RuntimeTelemetry(receiver.config, () => undefined)
    cleanup.push(() => telemetry.close())
    for (let n = 0; n < 150; n++) {
      const span = telemetry.start('jevable.node', { 'jevable.node.kind': 'PRIVATE_KIND_' + n, 'jevable.node.id': 'private-node-' + n })
      telemetry.end(span, 'PRIVATE_OUTCOME_' + n); span.end()
    }
    const model = telemetry.start('jevable.model', { 'jevable.node.kind': 'llm', 'jevable.run.id': 'private-run' })
    model.setAttributes({ 'gen_ai.usage.input_tokens': 4, 'gen_ai.usage.output_tokens': 7 }); telemetry.end(model, 'completed')
    const invalid = telemetry.start('jevable.model', { 'jevable.node.kind': 'decision' })
    invalid.setAttributes({ 'gen_ai.usage.input_tokens': NaN, 'gen_ai.usage.output_tokens': -1 }); telemetry.end(invalid, 'failed', true)
    await telemetry.flush()
    const points = receiver.metric('jevable.node.attempts').sum.dataPoints
    expect(points).toHaveLength(1); expect(numeric(points[0])).toBe(150)
    expect(attrs(points[0])).toEqual({ 'jevable.node.kind': 'other', 'jevable.outcome': 'other' })
    expect(receiver.metric('jevable.model.tokens').sum.dataPoints.map(numeric)).toEqual([4, 7])
    expect(JSON.stringify(receiver.batches)).not.toMatch(/PRIVATE_|private-node|private-run/u)
  })

  it.each(['completed', 'failed'] as const)('observes a real runtime model adapter %s with active work and reported usage', async outcome => {
    const receiver = await fixture(), dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-model-metrics-'))
    const source = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'model', name: 'PRIVATE_MODEL_NAME' },
      spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
        write: { type: 'llm', config: { provider: 'fixture', model: 'fixture-model', connection: { mode: 'workspace', id: 'fixture' },
          prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 20, stream: false },
          execution: { timeoutSeconds: 1, maxAttempts: 1 }, historyScope: 'none' } },
        end: { type: 'output', config: { value: '${{ nodes.write.output }}' } } }, edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }] } })
    let finish!: () => void, called = 0
    const gate = new Promise<void>(resolve => { finish = resolve })
    const runtime = await LocalRuntime.open({ dataDirectory, telemetry: receiver.config, models: { admit() {}, async verify() {},
      async execute() { called++; await gate; if (outcome === 'failed') throw Error('PRIVATE_MODEL_ERROR')
        return { output: 'PRIVATE_MODEL_OUTPUT', usage: { tries: 1, inputTokens: 4, outputTokens: 7 } } } } })
    cleanup.push(() => runtime.close())
    const id = randomUUID(), running = runtime.run(source, 'PRIVATE_MODEL_INPUT', { id }).then(run => ({ run }), error => ({ error }))
    await vi.waitFor(() => expect(called).toBe(1)); await runtime.telemetryFlush()
    expect(numeric(receiver.metric('jevable.execution.active').sum.dataPoints[0])).toBe(1)
    expect(receiver.metric('jevable.model.calls')).toBeUndefined()
    finish(); const result = await running; await runtime.telemetryFlush()
    if (outcome === 'completed') { expect(result).toHaveProperty('run.state.status', 'completed'); expect(receiver.metric('jevable.model.tokens').sum.dataPoints.map(numeric)).toEqual([4, 7]) }
    else { expect(result).toHaveProperty('error'); expect(receiver.metric('jevable.model.tokens')).toBeUndefined(); expect((await runtime.show(id)).state.status).toBe('executing') }
    const point = receiver.metric('jevable.model.calls').sum.dataPoints[0]
    expect(numeric(point)).toBe(1); expect(attrs(point)).toEqual({ 'jevable.node.kind': 'llm', 'jevable.outcome': outcome })
    expect(numeric(receiver.metric('jevable.execution.active').sum.dataPoints[0])).toBe(0)
    expect(JSON.stringify(receiver.batches)).not.toMatch(/PRIVATE_|fixture-model/u)
  })

  it('records node settlement failure as uncertain rather than successful', async () => {
    const receiver = await fixture(), { runtime } = await owner(receiver.config), id = randomUUID()
    const original = RunStore.prototype.save
    const spy = vi.spyOn(RunStore.prototype, 'save').mockImplementation(function (this: RunStore, record, kind, data) {
      if (kind === 'node-result') throw Error('PRIVATE_DISK_ERROR'); return original.call(this, record, kind, data)
    })
    await expect(runtime.run(echo, 'private', { id })).rejects.toThrow('PRIVATE_DISK_ERROR'); spy.mockRestore()
    expect((await runtime.show(id)).state.status).toBe('executing'); await runtime.telemetryFlush()
    expect(attrs(receiver.metric('jevable.node.attempts').sum.dataPoints[0])['jevable.outcome']).toBe('commit-or-execution-failed')
    expect(attrs(receiver.metric('jevable.execution.segments').sum.dataPoints[0])['jevable.outcome']).toBe('failed-or-uncertain')
    expect(numeric(receiver.metric('jevable.execution.active').sum.dataPoints[0])).toBe(0)
    expect(JSON.stringify(receiver.batches)).not.toContain('PRIVATE_DISK_ERROR')
  })

  it('authenticates with a protected credential reference, excluding the secret from metrics/status', async () => {
    const receiver = await fixture(), { runtime, dataDirectory } = await owner(undefined)
    runtime.setCredential('otel/key', 'PRIVATE_KEY', 0, 'local:test'); await runtime.close()
    const metered = await LocalRuntime.open({ dataDirectory, telemetry: { ...receiver.config, authentication: { kind: 'bearer', credentialRef: 'otel/key' } } })
    cleanup.push(() => metered.close()); await metered.run(echo, 'data'); await metered.telemetryFlush()
    expect(receiver.requests[0]!.authorization).toBe('Bearer PRIVATE_KEY')
    expect(JSON.stringify(receiver.batches)).not.toContain('PRIVATE_KEY'); expect(JSON.stringify(metered.telemetryStatus())).not.toContain('PRIVATE_KEY')
  })

  it('requires an explicit safe destination for at least one signal', () => {
    expect(() => parseTelemetryConfig({ authentication: { kind: 'none' } })).toThrow('invalid-command')
    for (const metricsEndpoint of ['http://public.example/v1/metrics', 'https://user:key@collector.example/v1/metrics', 'https://collector.example/v1/metrics?key=secret'])
      expect(() => parseTelemetryConfig({ metricsEndpoint, authentication: { kind: 'none' } })).toThrow('invalid-command')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProtobufTraceSerializer, JsonTraceSerializer } from '@opentelemetry/otlp-transformer'
import { LocalRuntime } from '../src/runtime/local.ts'
import { RunStore } from '../src/runtime/store.ts'
import { parseTelemetryConfig, parseTraceParent } from '../src/telemetry/config.ts'
import { startRuntimeService, RuntimeClient } from '../src/http/index.ts'
import { PROTOCOL_VERSION } from '../src/capabilities.ts'
import { randomUUID } from 'node:crypto'
import { executionCheckpointHash } from '../src/runtime/run-types.ts'
import { logRecords, metricSums } from '../scripts/check-telemetry-package.mjs'
import { traceRecords } from '../scripts/check-postgres-telemetry.mjs'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
async function fixture(reply?: (res: ServerResponse) => void) {
  const requests: { bytes: Buffer; authorization: string | undefined; type: string | undefined; url: string | undefined }[] = []
  const batches: any[] = [], encoded: Uint8Array[] = []
  const serialize = ProtobufTraceSerializer.serializeRequest
  vi.spyOn(ProtobufTraceSerializer, 'serializeRequest').mockImplementation(spans => {
    batches.push(JSON.parse(Buffer.from(JsonTraceSerializer.serializeRequest(spans)!).toString()))
    const bytes = serialize(spans)!; encoded.push(bytes); return bytes
  })
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
    requests.push({ bytes: Buffer.concat(chunks), authorization: req.headers.authorization, type: req.headers['content-type'], url: req.url })
    if (reply) reply(res)
    else { res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.end() }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('no listener')
  const config = { endpoint: `http://127.0.0.1:${address.port}/v1/traces`, authentication: { kind: 'none' as const }, intervalMs: 60000, timeoutMs: 100, flushTimeoutMs: 500 }
  return { config, requests, batches, encoded, spans: () => batches.flatMap(batch => batch.resourceSpans.flatMap((r: any) => r.scopeSpans.flatMap((s: any) => s.spans))) }
}
async function owner(telemetry?: Parameters<typeof LocalRuntime.open>[0]['telemetry']) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-traces-'))
  const runtime = await LocalRuntime.open({ dataDirectory, ...(telemetry ? { telemetry } : {}) })
  cleanup.push(() => runtime.close())
  return { runtime, dataDirectory }
}
const attributes = (span: any) => Object.fromEntries(span.attributes.map((entry: any) => [entry.key, entry.value.stringValue ?? entry.value.intValue ?? entry.value.boolValue]))

describe('standalone OTel trace pipeline', () => {
  it.each([0, 1])('preserves admitted async-run ancestry and received sampled trace scope (%i)', async sampleRatio => {
    const receiver = await fixture(), { runtime } = await owner({ ...receiver.config, sampleRatio })
    const id = randomUUID(), parent = '00-11111111111111111111111111111111-2222222222222222-01'
    const admitted = await runtime.withTraceParent(parent, () => runtime.runAsync(echo, 'PRIVATE_ASYNC_INPUT', { id }))
    expect(admitted).toMatchObject({ observation: 'created', run: { state: { status: 'paused', steps: [] } } })
    const result = await admitted.completion
    expect(result.state.status).toBe('completed')
    expect(result.traceSegments?.[0]).toMatchObject({ operation: 'run', parent: { traceId: '1'.repeat(32), spanId: '2'.repeat(16) } })
    await runtime.telemetryFlush()
    const received = receiver.requests.filter(request => request.url === '/v1/traces').flatMap(request => traceRecords(request.bytes))
    const segment = result.traceSegments![0]!
    if (sampleRatio) {
      expect(received).toHaveLength(3)
      const root = received.find(span => span.name === 'jevable.run')!
      expect(root).toMatchObject({ traceId: segment.trace.traceId, spanId: segment.trace.spanId, parent: '2'.repeat(16) })
      for (const step of result.state.steps) {
        const trace = step.inspection!.trace!
        expect(received).toContainEqual(expect.objectContaining({ traceId: trace.traceId, spanId: trace.spanId, parent: root.spanId }))
      }
    } else { expect(received).toEqual([]); expect(segment.trace.traceFlags).toBe(0) }
    const packets = receiver.requests.map(request => request.bytes.toString('hex'))
    const events = await runtime.events(id)
    const retry = await runtime.runAsync(echo, 'PRIVATE_ASYNC_INPUT', { id })
    expect(retry.observation).toBe('retained'); expect(await retry.completion).toEqual(result)
    await runtime.telemetryFlush()
    expect(receiver.requests.map(request => request.bytes.toString('hex'))).toEqual(packets)
    expect(await runtime.events(id)).toEqual(events)
    expect(JSON.stringify(received)).not.toContain('PRIVATE_ASYNC_INPUT')
  })

  it('exports only an explicitly recorded API contract across restart, approval and cancellation, without inferred ingress or metric labels', async () => {
    const receiver = await fixture(), config = { ...receiver.config,
      metricsEndpoint: receiver.config.endpoint.replace('traces', 'metrics'), logsEndpoint: receiver.config.endpoint.replace('traces', 'logs') }
    const { runtime, dataDirectory } = await owner(config)
    const waiting = await runtime.run(approval.replace('[manual]', '[api]'), { message: 'PRIVATE_API_INPUT' }, { triggerMode: 'api' })
    if (waiting.state.status !== 'waiting') throw Error('Expected approval')
    const legacy = await runtime.run(echo, 'PRIVATE_LEGACY_INPUT')
    await runtime.close()
    const reopened = await LocalRuntime.open({ dataDirectory, telemetry: config }); cleanup.push(() => reopened.close())
    await reopened.decide(waiting.id, waiting.state.attempt.id, 'approve', 'PRIVATE_API_ACTOR')
    const cancelled = await reopened.run(echo.replace('[manual]', '[api]'), 'PRIVATE_CANCEL_INPUT', { triggerMode: 'api', paused: true })
    reopened.cancel(cancelled.id, randomUUID(), 'PRIVATE_CANCEL_ACTOR')
    await reopened.telemetryFlush()
    const segments = receiver.spans().filter(span => ['jevable.run', 'jevable.approval', 'jevable.cancel'].includes(span.name))
    expect(segments.filter(span => attributes(span)['jevable.trigger.mode'] === 'api').map(span => span.name)).toEqual(['jevable.run', 'jevable.approval', 'jevable.cancel'])
    expect(attributes(segments.find(span => attributes(span)['jevable.run.id'] === legacy.id))).not.toHaveProperty('jevable.trigger.mode')
    for (const span of segments) {
      const retained = await reopened.show(attributes(span)['jevable.run.id'])
      expect(retained.traceSegments!.some(segment => segment.trace.traceId === span.traceId && segment.trace.spanId === span.spanId)).toBe(true)
    }
    const logs = receiver.requests.filter(r => r.url === '/v1/logs').flatMap(r => logRecords(r.bytes))
      .filter(log => log.event === 'jevable.execution.segment.ended')
    expect(logs.filter(log => log.attributes['jevable.trigger.mode'] === 'api')).toHaveLength(3)
    const metrics = receiver.requests.filter(r => r.url === '/v1/metrics').flatMap(r => metricSums(r.bytes))
    for (const metric of metrics) for (const point of metric.points) expect(point.labels).not.toHaveProperty('jevable.trigger.mode')
    expect(JSON.stringify([receiver.batches, logs, metrics])).not.toContain('PRIVATE_')
  })

  it('correlates scoped approval node/continuation and loop timeout across received signals without payload or metric-ID labels', async () => {
    const receiver = await fixture(), config = { ...receiver.config, metricsEndpoint: receiver.config.endpoint.replace('traces', 'metrics'), logsEndpoint: receiver.config.endpoint.replace('traces', 'logs') }
    const { runtime, dataDirectory } = await owner(config), yaml = await readFile(new URL('../examples/loop-approval.yaml', import.meta.url), 'utf8')
    const first = await runtime.run(yaml, ['PRIVATE_FIRST', 'PRIVATE_SECOND'])
    if (first.state.status !== 'waiting') throw Error('Expected scoped approval')
    await runtime.close(); const reopened = await LocalRuntime.open({ dataDirectory, telemetry: config }); cleanup.push(() => reopened.close())
    const second = await reopened.decide(first.id, first.state.attempt.id, 'approve', 'PRIVATE_ACTOR')
    if (second.state.status !== 'waiting') throw Error('Expected next item')
    await reopened.decide(first.id, second.state.attempt.id, 'reject', 'PRIVATE_ACTOR')
    const timeout = await reopened.run(yaml.replace('timeoutSeconds: 3600', 'timeoutSeconds: 1'), ['PRIVATE_TIMEOUT'])
    if (timeout.state.status !== 'waiting') throw Error('Expected wait')
    try {
      vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(timeout.loopDeadlines.each! + 1)
      await reopened.decide(timeout.id, timeout.state.attempt.id, 'approve', 'PRIVATE_ACTOR')
    } finally { vi.useRealTimers() }
    await reopened.telemetryFlush()
    const spans = receiver.spans().filter(span => span.name === 'jevable.approval')
    expect(spans.map(span => attributes(span)['jevable.loop.index'])).toEqual([0, 1, 0])
    const saved = [...(await reopened.show(first.id)).traceSegments!, ...(await reopened.show(timeout.id)).traceSegments!]
    for (const span of spans) {
      expect(attributes(span)).toMatchObject({ 'jevable.loop.id': 'each', 'jevable.node.id': 'review' })
      expect(saved.some(segment => segment.trace.spanId === span.spanId && segment.trace.traceId === span.traceId)).toBe(true)
      expect(span.links).toHaveLength(1)
    }
    expect(attributes(spans.at(-1))['jevable.outcome']).toBe('failed')
    const logs = receiver.requests.filter(r => r.url === '/v1/logs').flatMap(r => logRecords(r.bytes)).filter(log => log.event === 'jevable.execution.segment.ended' && log.attributes['jevable.loop.id'] === 'each')
    expect(logs).toHaveLength(3)
    for (const log of logs) expect(spans.some(span => span.traceId === log.traceId && span.spanId === log.spanId)).toBe(true)
    const metrics = receiver.requests.filter(r => r.url === '/v1/metrics').flatMap(r => metricSums(r.bytes))
    expect(metrics.length).toBeGreaterThan(0)
    for (const metric of metrics) for (const point of metric.points)
      for (const key of ['jevable.loop.id', 'jevable.loop.index', 'jevable.run.id', 'jevable.attempt.id']) expect(Object.keys(point.labels)).not.toContain(key)
    expect(JSON.stringify([receiver.batches, logs, metrics])).not.toContain('PRIVATE_')
  })

  it('blocks provider mutations during automatic exports even without an explicit flush', async () => {
    let response: ServerResponse | undefined
    const receiver = await fixture(res => { response = res })
    const { runtime } = await owner({ ...receiver.config, intervalMs: 10, timeoutMs: 2000 })
    try {
      await runtime.run(echo, 'private periodic input')
      await vi.waitFor(() => expect(response).toBeDefined(), { timeout: 1000, interval: 5 })
      expect(() => runtime.setCredential('otel/key', 'replacement', 0, 'local:test')).toThrow('busy')
      expect(() => runtime.configureConnection({}, 0, 'local:test')).toThrow('busy')
    } finally { response?.writeHead(200, { 'content-type': 'application/x-protobuf' }); response?.end() }
    await runtime.telemetryFlush()
    expect(runtime.setCredential('otel/key', 'replacement', 0, 'local:test')).toMatchObject({ generation: 1 })
  })

  it('links guarded step/continue segments without emitting spans for paused admission or control retry', async () => {
    const receiver = await fixture(), { runtime } = await owner(receiver.config)
    const paused = await runtime.run(echo, 'PRIVATE_DEBUG_INPUT', { paused: true })
    await runtime.telemetryFlush(); expect(receiver.requests).toHaveLength(0)
    const command = { requestId: randomUUID(), expectedCheckpointSha256: executionCheckpointHash(paused), mode: 'step' as const }
    const step = await runtime.advance(paused.id, command, 'PRIVATE_DEBUG_ACTOR')
    await runtime.telemetryFlush()
    const segment = receiver.spans().find(span => span.name === 'jevable.resume')
    expect(attributes(segment)).toMatchObject({ 'jevable.control.request_id': command.requestId, 'jevable.control.mode': 'step', 'jevable.outcome': 'paused' })
    const batches = receiver.requests.length
    await runtime.advance(paused.id, command, 'PRIVATE_DEBUG_ACTOR'); await runtime.telemetryFlush()
    expect(receiver.requests).toHaveLength(batches)
    await runtime.advance(paused.id, { requestId: randomUUID(), expectedCheckpointSha256: executionCheckpointHash(step), mode: 'continue' }, 'PRIVATE_DEBUG_ACTOR')
    await runtime.telemetryFlush()
    const resumed = receiver.spans().filter(span => span.name === 'jevable.resume')[1]
    expect(resumed.links[0].spanId).toBe(segment.spanId)
    expect(attributes(resumed)['jevable.control.mode']).toBe('continue')
    expect(JSON.stringify(receiver.batches)).not.toContain('PRIVATE_DEBUG')
  })

  it.each(['node-intent', 'node-trace'])('retains pause at %s with trace linkage and no downstream span', async eventKind => {
    const receiver = await fixture(), { runtime, dataDirectory } = await owner(receiver.config)
    const save = RunStore.prototype.save; let pause: ReturnType<LocalRuntime['advance']> | undefined
    const spy = vi.spyOn(RunStore.prototype, 'save').mockImplementation(function(this: RunStore, record, kind, data) {
      save.call(this, record, kind, data)
      if (kind === eventKind && record.state.status === 'executing' && record.state.next === 'start') {
        pause = runtime.advance(record.id, { requestId: randomUUID(), mode: 'pause', expectedCheckpointSha256: executionCheckpointHash(record) }, 'PRIVATE_PAUSE_ACTOR')
      }
    })
    const run = await runtime.run(echo, 'PRIVATE_PAUSE_INPUT'); await pause; spy.mockRestore()
    expect(pause).toBeDefined(); expect(run.state).toMatchObject({ status: 'paused', next: 'result' })
    expect(await runtime.show(run.id)).toEqual(run)
    await runtime.telemetryFlush()
    expect(attributes(receiver.spans().find(span => span.name === 'jevable.run'))).toMatchObject({ 'jevable.pause.reason': 'requested', 'jevable.outcome': 'paused' })
    expect(receiver.spans().filter(span => span.name === 'jevable.node')).toHaveLength(1)
    expect(JSON.stringify(receiver.batches)).not.toContain('PRIVATE_PAUSE')
    await runtime.close()
    const reopened = await LocalRuntime.open({ dataDirectory }); cleanup.push(() => reopened.close())
    expect(await reopened.show(run.id)).toEqual(run)
    expect((await reopened.advance(run.id, { requestId: randomUUID(), mode: 'continue', expectedCheckpointSha256: executionCheckpointHash(run) }, 'local:owner')).state.status).toBe('completed')
  })

  it('exports a breakpoint pause reason without a node-dispatch span or private data', async () => {
    const receiver = await fixture(), { runtime } = await owner(receiver.config)
    const run = await runtime.run(echo, 'PRIVATE_BREAKPOINT_INPUT', { paused: true })
    const hit = await runtime.advance(run.id, { requestId: randomUUID(), expectedCheckpointSha256: executionCheckpointHash(run),
      mode: 'continue', breakpoints: ['start'] }, 'PRIVATE_BREAKPOINT_ACTOR')
    await runtime.telemetryFlush()
    expect(attributes(receiver.spans().find(span => span.name === 'jevable.resume'))).toMatchObject({
      'jevable.pause.reason': 'breakpoint', 'jevable.breakpoint.node_id': 'start', 'jevable.outcome': 'paused' })
    expect(receiver.spans().some(span => span.name === 'jevable.node')).toBe(false)
    expect(JSON.stringify(receiver.batches)).not.toContain('PRIVATE_BREAKPOINT')
    expect(hit.traceSegments).toHaveLength(1)
  })
  it('links an explicit cancellation segment to the waiting run without exporting actor or input', async () => {
    const receiver = await fixture(), { runtime } = await owner(receiver.config)
    const waiting = await runtime.run(approval, { message: 'PRIVATE_CANCEL_INPUT' })
    const cancelled = runtime.cancel(waiting.id, randomUUID(), 'PRIVATE_CANCEL_ACTOR')
    await runtime.telemetryFlush()
    const span = receiver.spans().find(span => span.name === 'jevable.cancel')
    expect(attributes(span)['jevable.outcome']).toBe('cancelled')
    expect(span.links[0].spanId).toBe(waiting.traceSegments![0]!.trace.spanId)
    expect(cancelled.traceSegments?.at(-1)?.trace.spanId).toBe(span.spanId)
    expect(JSON.stringify(receiver.batches)).not.toContain('PRIVATE_CANCEL')
    const count = receiver.requests.length
    runtime.cancel(waiting.id, cancelled.cancellation!.id, 'local:retry'); await runtime.telemetryFlush()
    expect(receiver.requests).toHaveLength(count)
  })

  it('correlates saved test versions without exporting test inputs or expectations', async () => {
    const receiver = await fixture(), { runtime } = await owner(receiver.config)
    const project = runtime.editProject({ operation: 'create', title: 'Test fixture', yaml: echo, actor: 'private-reviewer' })
    const draft = runtime.editTest({ operation: 'create', actor: 'private-reviewer', definition: { title: 'PRIVATE_TEST_NAME',
      project: { id: project.id, generation: 1, revision: project.acceptedRevision }, input: 'PRIVATE_TEST_INPUT',
      expectations: [{ kind: 'status', value: 'completed' }, { kind: 'output-equals', value: 'PRIVATE_EXPECTATION' }] } })
    const accepted = runtime.editTest({ operation: 'accept', id: draft.id, expectedGeneration: 1, reviewedSha256: draft.sha256, actor: 'private-reviewer' })
    const result = await runtime.runTest({ id: accepted.id, generation: 2, sha256: accepted.sha256 }, randomUUID())
    expect(result.assessment).toBe('failed')
    await runtime.telemetryFlush()
    const root = receiver.spans().find(span => span.name === 'jevable.run'), attrs = attributes(root)
    expect(attrs['jevable.test.id']).toBe(accepted.id); expect(Number(attrs['jevable.test.generation'])).toBe(2)
    expect(attrs['jevable.test.sha256']).toBe(accepted.sha256)
    expect(attrs['jevable.outcome']).toBe('completed') // workflow success is distinct from assertion failure
    expect(JSON.stringify(receiver.batches)).not.toMatch(/PRIVATE_TEST|PRIVATE_EXPECTATION|private-reviewer/u)
    const count = receiver.requests.length; await runtime.testResult(result.run.id); await runtime.telemetryFlush()
    expect(receiver.requests).toHaveLength(count)
  })
  it('exports correlated protobuf spans only to the explicit endpoint, without private data', async () => {
    const receiver = await fixture()
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://invalid.example')
    vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', 'secret=ENV_SECRET')
    const { runtime } = await owner(receiver.config)
    const run = await runtime.withTraceParent('00-11111111111111111111111111111111-2222222222222222-01', () => runtime.run(echo, 'PRIVATE_INPUT'))
    const status = await runtime.telemetryFlush()
    expect(status).toMatchObject({ exported: 3, dropped: 0, queued: 0, successfulBatches: 1 })
    expect(receiver.requests).toHaveLength(1)
    expect(receiver.requests[0]).toMatchObject({ url: '/v1/traces', type: 'application/x-protobuf', authorization: undefined })
    expect(receiver.requests[0]!.bytes).toEqual(Buffer.from(receiver.encoded[0]!))
    const spans = receiver.spans(), root = spans.find(span => span.name === 'jevable.run')
    expect(root.traceId).toBe('11111111111111111111111111111111')
    expect(root.parentSpanId).toBe('2222222222222222')
    for (const span of spans.filter(span => span.name === 'jevable.node')) {
      expect(span.parentSpanId).toBe(root.spanId); expect(span.traceId).toBe(root.traceId)
      expect(attributes(span)['jevable.run.id']).toBe(run.id)
      expect(Number(attributes(span)['jevable.attempt.number'])).toBe(1)
    }
    expect(run.traceSegments?.[0]?.trace.spanId).toBe(root.spanId)
    expect(run.traceSegments?.[0]?.parent?.spanId).toBe('2222222222222222')
    expect(run.state.steps.every(step => step.inspection?.trace?.traceId === root.traceId)).toBe(true)
    const evidence = await runtime.exportRun(run.id)
    expect(evidence.snapshot.run.traceSegments).toEqual(run.traceSegments)
    expect(evidence.snapshot.steps.map(step => step.trace)).toEqual(run.state.steps.map(step => step.inspection!.trace))
    expect(evidence.snapshot.run.telemetryDelivery).toBe('not-guaranteed')
    expect(JSON.stringify(evidence)).not.toContain('PRIVATE_INPUT')
    const exported = JSON.stringify(receiver.batches)
    expect(exported).not.toContain('PRIVATE_INPUT'); expect(exported).not.toContain('ENV_SECRET'); expect(exported).not.toContain('Standalone echo')
    const count = receiver.requests.length; await runtime.show(run.id); await runtime.telemetryFlush(); expect(receiver.requests).toHaveLength(count)
  })

  it.each(['approve', 'reject'])('links an approval %s after runtime restart without a long-lived wait span', async action => {
    const receiver = await fixture(), { runtime, dataDirectory } = await owner(receiver.config)
    const waiting = await runtime.run(approval, { message: 'PRIVATE_REVIEW' })
    if (waiting.state.status !== 'waiting') throw Error('expected wait')
    const original = waiting.traceSegments![0]!.trace
    expect(waiting.state.attempt.trace).toBeDefined()
    await runtime.close()
    const restored = await LocalRuntime.open({ dataDirectory, telemetry: receiver.config }); cleanup.push(() => restored.close())
    const settled = await restored.decide(waiting.id, waiting.state.attempt.id, action, 'private-actor')
    await restored.telemetryFlush()
    expect(settled.traceSegments).toHaveLength(2)
    expect(settled.traceSegments![1]!.previous).toEqual(original)
    const resumed = receiver.spans().find(span => span.name === 'jevable.approval')
    expect(resumed.links[0]).toMatchObject({ traceId: original.traceId, spanId: original.spanId })
    expect(resumed.traceId).not.toBe(original.traceId)
    expect(JSON.stringify(receiver.batches)).not.toContain('PRIVATE_REVIEW')
    expect(JSON.stringify(receiver.batches)).not.toContain('private-actor')
  })

  it('counts partial OTLP rejection without replaying a completed workflow', async () => {
    // ExportTraceServiceResponse.partial_success.rejected_spans = 1.
    const receiver = await fixture(res => { res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.end(Buffer.from([10, 2, 8, 1])) })
    const { runtime } = await owner(receiver.config), id = randomUUID()
    const run = await runtime.run(echo, 'completed', { id })
    expect(await runtime.telemetryFlush()).toMatchObject({ exported: 2, rejected: 1, lastFailure: 'partial-rejection' })
    expect(await runtime.run(echo, 'completed', { id })).toEqual(run)
    await runtime.telemetryFlush(); expect(receiver.requests).toHaveLength(1)
  })

  it.each(['http', 'redirect', 'timeout', 'oversize', 'invalid'] as const)('treats collector %s failure as telemetry loss, not execution failure', async failure => {
    const receiver = await fixture(res => {
      if (failure === 'timeout') return
      res.writeHead(failure === 'http' ? 503 : failure === 'redirect' ? 302 : 200,
        { 'content-type': 'application/x-protobuf', location: 'http://invalid.example/collect' })
      res.end(failure === 'oversize' ? Buffer.alloc(64001) : failure === 'invalid' ? Buffer.from([255]) : Buffer.alloc(0))
    })
    const { runtime } = await owner(receiver.config)
    expect((await runtime.run(echo, 'successful workflow')).state.status).toBe('completed')
    expect(await runtime.telemetryFlush()).toMatchObject({ failedBatches: 1, dropped: 3, exported: 0 })
    expect(receiver.requests).toHaveLength(1)
  })

  it('retains the exact completed journal across an exporter outage and owner restart without replay', async () => {
    const receiver = await fixture(res => {
      res.writeHead(503, { 'content-type': 'application/x-protobuf' })
      res.end()
    })
    const { runtime, dataDirectory } = await owner(receiver.config)
    const id = randomUUID()
    const completed = await runtime.run(echo, 'collector outage', { id })
    expect(completed.state.status).toBe('completed')
    const events = await runtime.events(id)
    expect(events.length).toBeGreaterThan(0)
    expect(await runtime.telemetryFlush()).toMatchObject({ failedBatches: 1, dropped: 3, exported: 0 })
    expect(receiver.requests).toHaveLength(1)

    await runtime.close()
    const reopened = await LocalRuntime.open({ dataDirectory })
    cleanup.push(() => reopened.close())
    expect(await reopened.show(id)).toEqual(completed)
    expect(await reopened.events(id)).toEqual(events)
    expect(await reopened.run(echo, 'collector outage', { id })).toEqual(completed)
    expect(await reopened.events(id)).toEqual(events)
    expect(receiver.requests).toHaveLength(1)
  })

  it('completes an approved workflow through an exporter outage without replaying the decision after restart', async () => {
    const receiver = await fixture(res => {
      res.writeHead(503, { 'content-type': 'application/x-protobuf' })
      res.end()
    })
    const { runtime, dataDirectory } = await owner(receiver.config)
    const id = randomUUID(), waiting = await runtime.run(approval, { message: 'PRIVATE_APPROVAL_INPUT' }, { id })
    if (waiting.state.status !== 'waiting') throw Error('Expected approval wait')
    const attemptId = waiting.state.attempt.id
    const waitingEvents = await runtime.events(id)
    expect(waitingEvents.length).toBeGreaterThan(0)
    expect(await runtime.telemetryFlush()).toMatchObject({ failedBatches: 1, exported: 0 })
    const requestsAtWait = receiver.requests.length
    expect(requestsAtWait).toBeGreaterThan(0)

    await runtime.close()
    const replacement = await LocalRuntime.open({ dataDirectory, telemetry: receiver.config })
    cleanup.push(() => replacement.close())
    expect(await replacement.show(id)).toEqual(waiting)
    expect(await replacement.events(id)).toEqual(waitingEvents)
    const completed = await replacement.decide(id, attemptId, 'approve', 'PRIVATE_APPROVAL_ACTOR')
    expect(completed.state).toMatchObject({ status: 'completed', output: 'approve' })
    const completedEvents = await replacement.events(id)
    expect(completedEvents.length).toBeGreaterThan(waitingEvents.length)
    expect(completedEvents.filter(event => event.kind === 'approval-decided')).toHaveLength(1)
    expect(await replacement.telemetryFlush()).toMatchObject({ failedBatches: 1, exported: 0 })
    const requestsAtCompletion = receiver.requests.length
    expect(requestsAtCompletion).toBeGreaterThan(requestsAtWait)

    await replacement.close()
    const reader = await LocalRuntime.open({ dataDirectory, telemetry: receiver.config })
    cleanup.push(() => reader.close())
    expect(await reader.show(id)).toEqual(completed)
    expect(await reader.events(id)).toEqual(completedEvents)
    await expect(reader.decide(id, attemptId, 'approve', 'PRIVATE_APPROVAL_ACTOR')).rejects.toMatchObject({ code: 'conflict' })
    expect(await reader.events(id)).toEqual(completedEvents)
    expect(await reader.telemetryFlush()).toMatchObject({ exported: 0 })
    expect(receiver.requests).toHaveLength(requestsAtCompletion)
    expect(JSON.stringify(completed.traceSegments)).not.toContain('PRIVATE_APPROVAL_')
  })

  it('bounds queue occupancy and shutdown time, including an unavailable collector', async () => {
    const receiver = await fixture(() => {}), { runtime } = await owner({ ...receiver.config, queueSize: 2, batchSize: 1, timeoutMs: 1000, flushTimeoutMs: 30 })
    await runtime.run(echo, 'overflow')
    expect(runtime.telemetryStatus()).toMatchObject({ queued: 2, dropped: 1 })
    const start = Date.now(); await runtime.close()
    expect(Date.now() - start).toBeLessThan(500)
    expect(runtime.telemetryStatus()).toMatchObject({ dropped: 3, queued: 0, inFlight: 0, closed: true })
  })

  it('persists valid unsampled trace identity but exports nothing when sampling is zero', async () => {
    const receiver = await fixture(), { runtime } = await owner({ ...receiver.config, sampleRatio: 0 })
    const run = await runtime.run(echo, 'unsampled')
    expect(run.traceSegments![0]!.trace.traceFlags).toBe(0)
    expect(await runtime.telemetryFlush()).toMatchObject({ exported: 0 })
    expect(receiver.requests).toEqual([])
  })

  it('records node commit failure as an error span and preserves uncertain intent', async () => {
    const receiver = await fixture(), { runtime } = await owner(receiver.config), id = randomUUID()
    const original = RunStore.prototype.save
    const spy = vi.spyOn(RunStore.prototype, 'save').mockImplementation(function (this: RunStore, record, kind, data) {
      if (kind === 'node-result') throw Error('PRIVATE_DISK_ERROR'); return original.call(this, record, kind, data)
    })
    await expect(runtime.run(echo, 'private input', { id })).rejects.toThrow('PRIVATE_DISK_ERROR')
    spy.mockRestore()
    expect((await runtime.show(id)).state.status).toBe('executing')
    await runtime.telemetryFlush()
    const node = receiver.spans().find(span => span.name === 'jevable.node')
    expect(node.status.code).toBe(2)
    expect(attributes(node)['jevable.outcome']).toBe('commit-or-execution-failed')
    expect(JSON.stringify(receiver.batches)).not.toContain('PRIVATE_DISK_ERROR')
  })

  it('correlates a model span with its exact node attempt without exporting generated text', async () => {
    const receiver = await fixture(), dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-model-traces-'))
    const modelSource = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'model', name: 'Model' },
      spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
        write: { type: 'llm', config: { provider: 'fixture', model: 'fixture-model', connection: { mode: 'workspace', id: 'fixture' },
          prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 20, stream: false },
          execution: { timeoutSeconds: 1, maxAttempts: 1 }, historyScope: 'none' } },
        end: { type: 'output', config: { value: '${{ nodes.write.output }}' } } }, edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }] } })
    const runtime = await LocalRuntime.open({ dataDirectory, telemetry: receiver.config, models: { admit() {}, async verify() {},
      async execute() { return { output: 'PRIVATE_MODEL_OUTPUT', usage: { tries: 1, inputTokens: 4, outputTokens: 7 } } } } })
    cleanup.push(() => runtime.close())
    const run = await runtime.run(modelSource, 'PRIVATE_MODEL_INPUT'); await runtime.telemetryFlush()
    const spans = receiver.spans(), model = spans.find(span => span.name === 'jevable.model')
    const node = spans.find(span => span.name === 'jevable.node' && attributes(span)['jevable.node.id'] === 'write')
    expect(model.parentSpanId).toBe(node.spanId)
    expect(attributes(model)['jevable.attempt.id']).toBe(run.state.steps[1]!.inspection!.attemptId)
    expect(Number(attributes(model)['gen_ai.usage.input_tokens'])).toBe(4)
    expect(Number(attributes(model)['gen_ai.usage.output_tokens'])).toBe(7)
    expect(JSON.stringify(receiver.batches)).not.toMatch(/PRIVATE_MODEL_INPUT|PRIVATE_MODEL_OUTPUT/u)
  })

  it('authenticates exporter requests using the independent protected credential store', async () => {
    const receiver = await fixture(), { runtime, dataDirectory } = await owner()
    runtime.setCredential('otel/key', 'PRIVATE_OTLP_KEY', 0, 'local:test'); await runtime.close()
    const traced = await LocalRuntime.open({ dataDirectory, telemetry: { ...receiver.config, authentication: { kind: 'bearer', credentialRef: 'otel/key' } } })
    cleanup.push(() => traced.close())
    await traced.run(echo, 'data'); await traced.telemetryFlush()
    expect(receiver.requests[0]!.authorization).toBe('Bearer PRIVATE_OTLP_KEY')
    expect(JSON.stringify(receiver.batches)).not.toContain('PRIVATE_OTLP_KEY')
    expect(JSON.stringify(traced.telemetryStatus())).not.toContain('PRIVATE_OTLP_KEY')
  })

  it('admits traceparent only after authenticated HTTP boundaries and exposes exporter health', async () => {
    const receiver = await fixture(), dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-http-traces-')), token = 'a'.repeat(64)
    const service = await startRuntimeService({ runtime: { dataDirectory, telemetry: receiver.config }, token, actor: 'owner' })
    cleanup.push(async () => { await service.close(); await service.closed })
    const request = (parent: string) => fetch(service.url + '/v1/operations', { method: 'POST', headers: { authorization: `Bearer ${token}`,
      'x-jevable-protocol': PROTOCOL_VERSION, 'content-type': 'application/json', traceparent: parent,
      baggage: 'secret=PRIVATE_BAGGAGE', tracestate: 'secret=PRIVATE_TRACESTATE' }, body: JSON.stringify({ operation: 'runs.start', id: randomUUID(), yaml: echo, input: 'test' }) })
    expect((await request('invalid')).status).toBe(400)
    expect((await request('00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01')).status).toBe(200)
    const client = new RuntimeClient(service.url, token)
    expect(await client.operation({ operation: 'telemetry.flush' })).toMatchObject({ result: { exported: 3 } })
    expect(await client.operation({ operation: 'telemetry.status' })).toMatchObject({ result: { enabled: true } })
    expect(JSON.stringify(receiver.batches)).not.toMatch(/PRIVATE_BAGGAGE|PRIVATE_TRACESTATE/u)
  })

  it('is disabled by default and rejects invalid destinations or trace identities', async () => {
    const { runtime } = await owner()
    expect(runtime.telemetryStatus()).toEqual({ enabled: false, signals: [] })
    expect((await runtime.run(echo, 'plain')).traceSegments).toBeUndefined()
    for (const endpoint of ['http://public.example/v1/traces', 'https://token@collector.example/v1/traces', 'https://collector.example/v1/traces?key=secret'])
      expect(() => parseTelemetryConfig({ endpoint, authentication: { kind: 'none' } })).toThrow('invalid-command')
    for (const parent of ['00-' + '0'.repeat(32) + '-bbbbbbbbbbbbbbbb-01', '01-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01'])
      expect(() => parseTraceParent(parent)).toThrow('invalid-command')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { LocalRuntime, executionCheckpointHash, type LocalRun, type ExecutionControl } from '../src/runtime/index.ts'
import { RunStore } from '../src/runtime/store.ts'
import { ProviderStore } from '../src/providers/store.ts'
import { main } from '../src/cli.ts'
import { parse } from 'yaml'
import { startRuntimeService, RuntimeClient } from '../src/http/index.ts'
import { ProtobufTraceSerializer, JsonTraceSerializer, ProtobufMetricsSerializer, JsonMetricsSerializer,
  ProtobufLogsSerializer, JsonLogsSerializer } from '@opentelemetry/otlp-transformer'
import { PROTOCOL_VERSION } from '../src/capabilities.ts'

const native = await readFile(new URL('../examples/native-decision.yaml', import.meta.url), 'utf8')
const llm = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'recovery', name: 'Recovery' },
  spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
    judge: { type: 'llm', config: { provider: 'fixture', model: 'your-explicit-model-id', connection: { mode: 'workspace', id: 'native-decisions' },
      prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 20, stream: false }, historyScope: 'none', execution: { timeoutSeconds: 10, maxAttempts: 1 } } },
    result: { type: 'output', config: { value: '${{ nodes.judge.output }}' } } }, edges: [{ from: 'start', to: 'judge' }, { from: 'judge', to: 'result' }] } })
const answers = { team: { type: 'choice', choice: 'billing', probabilities: { billing: 0.75, support: 0.25 }, confidence: 0.6 },
  urgency: { type: 'score', score: 1.6, legend: { '0': 'Routine', '1': 'Soon', '2': 'Immediate' }, probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 }, confidence: 0.8 },
  review: { type: 'noul', noul: 0.9 } }
const actor = 'PRIVATE_RECOVERY_ACTOR'
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
const control = (run: LocalRun, mode: ExecutionControl['mode'] = 'recover'): ExecutionControl => ({
  requestId: randomUUID(), expectedCheckpointSha256: executionCheckpointHash(run), mode })
async function fixture(kind = 'jev', attempts = 1, telemetry: boolean | 'signals' | 'unsampled' | 'metrics-logs' = false) {
  let calls = 0
  const telemetryBytes: Buffer[] = []
  const raw = ' \n' + JSON.stringify({ model: 'saved-native', answers, usage: { input_tokens: 12, output_tokens: 0 } }, null, 2) + '\n'
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk as Buffer)
    if (['/v1/traces', '/v1/metrics', '/v1/logs'].includes(request.url!)) {
      telemetryBytes.push(Buffer.concat(chunks)); response.writeHead(200, { 'content-type': 'application/x-protobuf' }); response.end(); return
    }
    calls++
    if (calls === 1 && attempts > 1) { response.writeHead(503); response.end('{}'); return }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(kind === 'fixture' ? JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'PRIVATE_SAVED_REPLY' } }],
      usage: { prompt_tokens: 12, completion_tokens: 1 } }) : raw)
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('fixture')
  const directory = await mkdtemp(join(tmpdir(), 'jevable-recovery-'))
  const telemetryConfig = { ...(telemetry === 'metrics-logs' ? {} : { endpoint: `http://127.0.0.1:${address.port}/v1/traces` }),
    ...(typeof telemetry === 'string' ? { metricsEndpoint: `http://127.0.0.1:${address.port}/v1/metrics`, logsEndpoint: `http://127.0.0.1:${address.port}/v1/logs` } : {}),
    sampleRatio: telemetry === 'unsampled' ? 0 : 1, authentication: { kind: 'none' as const }, timeoutMs: 1000, intervalMs: 60000 }
  const runtime = await LocalRuntime.open({ dataDirectory: directory, ...(telemetry ? { telemetry: telemetryConfig } : {}) }); cleanup.push(() => runtime.close())
  const config = { id: 'native-decisions', provider: kind, protocol: kind === 'fixture' ? 'openai-compatible' : 'systemone',
    endpoint: `http://127.0.0.1:${address.port}/v1`, allowedModels: ['your-explicit-model-id'], authentication: { kind: 'bearer', credentialRef: 'models/native' },
    maxRequestBytes: 100_000, maxResponseBytes: 100_000, maxTimeoutSeconds: 60,
    ...(kind === 'fixture' ? { tokenParameter: 'max_tokens', maxStreamEvents: 100 } : {}) }
  runtime.configureConnection(config, 0, actor); runtime.setCredential('models/native', 'PRIVATE_RECOVERY_TOKEN', 0, actor)
  const value = parse(kind === 'fixture' ? llm : native)
  value.spec.nodes.judge.config.provider = kind; value.spec.nodes.judge.config.execution.maxAttempts = attempts
  return { runtime, directory, config, raw, source: JSON.stringify(value), calls: () => calls, telemetryBytes, telemetryConfig }
}
async function interrupted(f: Awaited<ReturnType<typeof fixture>>, afterCommit = false, input: unknown = 'PRIVATE_INPUT', triggerMode?: 'api') {
  const save = RunStore.prototype.save
  const fault = vi.spyOn(RunStore.prototype, 'save').mockImplementation(function (this: RunStore, record, kind, data) {
    if (kind === 'node-result' && record.state.steps.some(step => step.nodeId === 'judge')) {
      if (afterCommit) save.call(this, record, kind, data)
      throw Error('lost checkpoint acknowledgement')
    }
    return save.call(this, record, kind, data)
  })
  const id = randomUUID()
  try { await expect(f.runtime.run(f.source, input, { id, ...(triggerMode ? { triggerMode } : {}) })).rejects.toThrow('lost checkpoint acknowledgement') }
  finally { fault.mockRestore() }
  return f.runtime.show(id)
}

describe('guarded recovery from retained model settlements', () => {
  it('retains an explicit API entry through saved-response recovery after owner restart without redispatch', async () => {
    const f = await fixture('fixture'), source = JSON.parse(f.source)
    source.spec.nodes.start.config.modes = ['api']; f.source = JSON.stringify(source)
    await expect(f.runtime.run(f.source, 'PRIVATE_API_INPUT')).rejects.toHaveProperty('code', 'invalid-command')
    expect(f.calls()).toBe(0)
    const pending = await interrupted(f, false, 'PRIVATE_API_INPUT', 'api')
    expect(pending.triggerMode).toBe('api'); expect(pending.state.status).toBe('executing'); expect(f.calls()).toBe(1)
    await f.runtime.close()
    const runtime = await LocalRuntime.open({ dataDirectory: f.directory }); cleanup.push(() => runtime.close())
    const request = control(pending), recovered = await runtime.advance(pending.id, request, actor)
    expect(recovered).toMatchObject({ triggerMode: 'api', state: { status: 'paused', next: 'result' } })
    expect(await runtime.advance(pending.id, request, actor)).toEqual(recovered); expect(f.calls()).toBe(1)
    const done = await runtime.advance(pending.id, control(recovered, 'continue'), actor)
    expect(done).toMatchObject({ triggerMode: 'api', state: { status: 'completed', output: 'PRIVATE_SAVED_REPLY' } })
    expect((await runtime.exportRun(pending.id)).snapshot.run.triggerMode).toBe('api'); expect(f.calls()).toBe(1)
  })

  it.each((['signals', 'unsampled', 'metrics-logs'] as const).flatMap(signals =>
    (['none', 'segment', 'before-node', 'after-node'] as const).map(fault => ({ signals, fault }))))(
    'accounts for recovery without replay ($signals, $fault)', async ({ signals, fault }) => {
      const metricBatches: any[] = [], logBatches: any[] = [], traces: any[] = []
      const metricsSerialize = ProtobufMetricsSerializer.serializeRequest, logsSerialize = ProtobufLogsSerializer.serializeRequest,
        tracesSerialize = ProtobufTraceSerializer.serializeRequest
      vi.spyOn(ProtobufMetricsSerializer, 'serializeRequest').mockImplementation(value => {
        metricBatches.push(JSON.parse(Buffer.from(JsonMetricsSerializer.serializeRequest(value)!).toString())); return metricsSerialize(value)
      })
      vi.spyOn(ProtobufLogsSerializer, 'serializeRequest').mockImplementation(value => {
        logBatches.push(JSON.parse(Buffer.from(JsonLogsSerializer.serializeRequest(value)!).toString())); return logsSerialize(value)
      })
      vi.spyOn(ProtobufTraceSerializer, 'serializeRequest').mockImplementation(value => {
        traces.push(JSON.parse(Buffer.from(JsonTraceSerializer.serializeRequest(value)!).toString())); return tracesSerialize(value)
      })
      const attributes = (p: any) => Object.fromEntries(p.attributes.map((a: any) => [a.key, a.value.stringValue ?? a.value.boolValue ?? a.value.intValue]))
      const metrics = () => metricBatches.at(-1).resourceMetrics.flatMap((r: any) => r.scopeMetrics.flatMap((s: any) => s.metrics))
      const points = (name: string) => metrics().find((m: any) => m.name === name)?.sum?.dataPoints ?? []
      const counts = (name: string) => points(name).map((p: any) => ({ attributes: attributes(p), value: Number(p.asInt ?? p.asDouble) }))
      const logs = () => logBatches.flatMap(b => b.resourceLogs.flatMap((r: any) => r.scopeLogs.flatMap((s: any) => s.logRecords)))
      const f = await fixture('jev', 1, signals), pending = await interrupted(f), request = control(pending)
      await f.runtime.telemetryFlush()
      expect(points('jevable.recovery.attempts')).toEqual([])
      const originalModels = counts('jevable.model.calls'), originalTokens = counts('jevable.model.tokens')
      await expect(f.runtime.advance(pending.id, { ...request, expectedCheckpointSha256: '0'.repeat(64) }, actor)).rejects.toHaveProperty('code', 'conflict')
      const save = RunStore.prototype.save
      const spy = vi.spyOn(RunStore.prototype, 'save').mockImplementation(function(this: RunStore, record, kind, data) {
        if ((fault === 'segment' && kind === 'execution-segment') ||
          (fault.endsWith('node') && kind === 'node-result' && record.state.steps.some(s => s.nodeId === 'judge'))) {
          if (fault === 'after-node') save.call(this, record, kind, data)
          throw Error('PRIVATE_RECOVERY_WRITE_UNCERTAINTY')
        }
        return save.call(this, record, kind, data)
      })
      try {
        if (fault === 'none') expect((await f.runtime.advance(pending.id, request, actor)).state.status).toBe('paused')
        else await expect(f.runtime.advance(pending.id, request, actor)).rejects.toThrow('PRIVATE_RECOVERY_WRITE_UNCERTAINTY')
      } finally { spy.mockRestore() }
      await f.runtime.telemetryFlush()
      const observed = points('jevable.recovery.attempts')
      expect(observed).toHaveLength(1); expect(Number(observed[0].asInt ?? observed[0].asDouble)).toBe(1)
      expect(attributes(observed[0])).toEqual({ 'jevable.outcome': fault === 'none' ? 'paused' : 'failed-or-uncertain', 'jevable.recovery.settled': fault === 'none' })
      const histogram = metrics().find((m: any) => m.name === 'jevable.recovery.duration').histogram.dataPoints
      expect(Number(histogram[0].count)).toBe(1); expect(histogram[0].sum).toBeGreaterThanOrEqual(0)
      expect(counts('jevable.model.calls')).toEqual(originalModels); expect(counts('jevable.model.tokens')).toEqual(originalTokens)
      const event = logs().filter((l: any) => attributes(l)['jevable.control.mode'] === 'recover')
      expect(event).toHaveLength(1)
      expect(attributes(event[0])).toMatchObject({ 'jevable.run.id': pending.id, 'jevable.control.request_id': request.requestId,
        'jevable.control.mode': 'recover', 'jevable.recovery.settled': fault === 'none' })
      expect(event[0].severityText).toBe(fault === 'none' ? 'INFO' : 'ERROR')
      const trace = traces.flatMap(b => b.resourceSpans.flatMap((r: any) => r.scopeSpans.flatMap((s: any) => s.spans)))
        .find((s: any) => attributes(s)['jevable.control.request_id'] === request.requestId)
      if (signals === 'signals') {
        expect(attributes(trace)['jevable.recovery.settled']).toBe(fault === 'none')
        expect(event[0].spanId).toBe(trace.spanId)
      } else expect(traces).toHaveLength(0)
      const before = f.telemetryBytes.length, current = await f.runtime.show(pending.id)
      expect(await f.runtime.advance(pending.id, request, actor)).toEqual(current)
      await f.runtime.telemetryFlush(); expect(f.telemetryBytes).toHaveLength(before); expect(f.calls()).toBe(1)
      for (const bytes of f.telemetryBytes) expect(bytes.toString()).not.toContain('PRIVATE_')
      await f.runtime.close()
      const reopened = await LocalRuntime.open({ dataDirectory: f.directory, telemetry: f.telemetryConfig }); cleanup.push(() => reopened.close())
      const received = f.telemetryBytes.length
      expect(await reopened.show(pending.id)).toEqual(current); await reopened.telemetryFlush()
      expect(f.telemetryBytes).toHaveLength(received); expect(f.calls()).toBe(1)
    })

  it('rejects new recovery on a cancelled run but preserves read-only retries of an admitted recovery', async () => {
    const f = await fixture(), pending = await interrupted(f), request = control(pending)
    await f.runtime.advance(pending.id, request, actor)
    const stopped = await f.runtime.cancel(pending.id, randomUUID(), actor), events = await f.runtime.events(pending.id)
    expect(stopped.state.status).toBe('cancelled')
    expect(await f.runtime.advance(pending.id, request, actor)).toEqual(stopped)
    await expect(f.runtime.advance(pending.id, control(stopped), actor)).rejects.toHaveProperty('code', 'conflict')
    await expect(f.runtime.advance(pending.id, { ...request, requestId: randomUUID() }, actor)).rejects.toHaveProperty('code', 'conflict')
    expect(await f.runtime.events(pending.id)).toEqual(events); expect(f.calls()).toBe(1)
  })

  it.each([true, false])('scoped preview recovery (saved response=%s) never touches foreign runs or redispatches', async savedResponse => {
    const f = await fixture(), foreign = await interrupted(f); await f.runtime.close()
    const token = '6'.repeat(64), service = await startRuntimeService({ runtime: { dataDirectory: f.directory }, token, actor,
      preview: { source: f.source } }); cleanup.push(() => service.close())
    const post = (path: string, command: unknown, credential = token) => fetch(service.url + path, { method: 'POST',
      headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'X-Jevable-Protocol': PROTOCOL_VERSION }, body: JSON.stringify(command) })
    const boot = await post('/v1/preview/bootstrap', {}), session = (await boot.json() as any).result
    const raw = (command: unknown) => post('/v1/preview/operations', command, session.token)
    const operation = async (command: unknown) => { const response = await raw(command); expect(response.status).toBe(200); return (await response.json() as any).result }
    const id = randomUUID(), save = RunStore.prototype.save
    const fault = vi.spyOn(RunStore.prototype, 'save').mockImplementation(function(this: RunStore, record, kind, data) {
      if (kind === 'node-result' && record.state.steps.some(step => step.nodeId === 'judge')) throw Error('fixture checkpoint loss')
      return save.call(this, record, kind, data)
    })
    try { expect((await raw({ operation: 'run', id, input: 'PRIVATE_PREVIEW_INPUT' })).status).toBe(500) }
    finally { fault.mockRestore() }
    const pending = await operation({ operation: 'show', id }); expect(pending.status).toBe('executing'); expect(f.calls()).toBe(2)
    const request = { operation: 'advance', id, mode: 'recover', requestId: randomUUID(), expectedCheckpointSha256: pending.checkpointSha256 }
    expect((await raw({ ...request, id: foreign.id, expectedCheckpointSha256: executionCheckpointHash(foreign) })).status).toBe(404)
    expect((await raw({ ...request, expectedCheckpointSha256: '0'.repeat(64) })).status).toBe(409)
    expect((await raw({ ...request, breakpoints: [] })).status).toBe(400)
    if (!savedResponse) {
      const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'))
      try {
        const row = db.prepare('SELECT record FROM model_calls WHERE attempt_id=?').get(pending.attemptId) as { record: string }, record = JSON.parse(row.record)
        record.result = { status: 'pending' }; db.prepare('UPDATE model_calls SET record=? WHERE attempt_id=?').run(JSON.stringify(record), pending.attemptId)
      } finally { db.close() }
      const rejected = await raw(request); expect(rejected.status).toBe(422); expect((await rejected.json() as any).code).toBe('uncertain-attempt')
      expect(await operation({ operation: 'show', id })).toEqual(pending)
    } else {
      const recovered = await operation(request); expect(recovered.status).toBe('paused'); expect(recovered.steps).toHaveLength(2)
      expect(await operation(request)).toEqual(recovered); expect(f.calls()).toBe(2)
      const waiting = await operation({ ...request, mode: 'continue', requestId: randomUUID(), expectedCheckpointSha256: recovered.checkpointSha256 })
      expect(waiting.status).toBe('waiting'); expect(f.calls()).toBe(2)
      const result = await operation({ operation: 'decide', id, attemptId: waiting.attemptId, action: 'approve' })
      expect(result.output).toEqual(answers)
    }
    expect(f.calls()).toBe(2)
  })

  it('settles only the interrupted loop iteration and preserves its original attempt and loop deadline', async () => {
    const f = await fixture('fixture'), definition = JSON.parse(f.source), judge = definition.spec.nodes.judge
    judge.config.prompt = '${{ loop.item }}'
    definition.spec.inputSchema = { type: 'array', items: { type: 'string' }, maxItems: 2 }
    definition.spec.nodes = { start: definition.spec.nodes.start,
      each: { type: 'loop', config: { mode: 'forEach', items: '${{ inputs }}', maxIterations: 2, timeoutSeconds: 30,
        body: { entry: 'judge', nodes: { judge }, edges: [], exits: [{ from: 'judge', result: '${{ nodes.judge.output }}' }] } } },
      result: { type: 'output', config: { value: '${{ nodes.each.output.results }}' } } }
    definition.spec.edges = [{ from: 'start', to: 'each' }, { from: 'each', port: 'done', to: 'result' }]
    f.source = JSON.stringify(definition)
    const pending = await interrupted(f, false, ['one', 'two'])
    expect(pending.state).toMatchObject({ status: 'executing', scope: { loop: 'each', index: 0 } })
    const recovered = await f.runtime.advance(pending.id, control(pending), actor)
    expect(recovered.state).toMatchObject({ status: 'paused', scope: { loop: 'each', index: 1 } })
    expect(recovered.loopDeadlines).toEqual(pending.loopDeadlines); expect(f.calls()).toBe(1)
    const done = await f.runtime.advance(pending.id, control(recovered, 'continue'), actor)
    expect(done.state).toMatchObject({ status: 'completed', output: ['PRIVATE_SAVED_REPLY', 'PRIVATE_SAVED_REPLY'] }); expect(f.calls()).toBe(2)
    await f.runtime.close()
    const reopened = await LocalRuntime.open({ dataDirectory: f.directory }); cleanup.push(() => reopened.close())
    expect(await reopened.show(pending.id)).toEqual(done); expect(f.calls()).toBe(2)
  })

  it('links an explicit recovery segment without replaying node/model spans or leaking payloads', async () => {
    const batches: any[] = [], serialize = ProtobufTraceSerializer.serializeRequest
    vi.spyOn(ProtobufTraceSerializer, 'serializeRequest').mockImplementation(spans => {
      batches.push(JSON.parse(Buffer.from(JsonTraceSerializer.serializeRequest(spans)!).toString())); return serialize(spans)
    })
    const f = await fixture('jev', 1, true), pending = await interrupted(f)
    await f.runtime.telemetryFlush()
    const before = batches.length, request = control(pending), recovered = await f.runtime.advance(pending.id, request, actor)
    await f.runtime.telemetryFlush()
    const spans = batches.slice(before).flatMap(b => b.resourceSpans.flatMap((r: any) => r.scopeSpans.flatMap((s: any) => s.spans)))
    expect(spans.map(s => s.name)).toEqual(['jevable.resume'])
    const attributes = Object.fromEntries(spans[0].attributes.map((a: any) => [a.key, a.value.stringValue]))
    expect(attributes).toMatchObject({ 'jevable.control.mode': 'recover', 'jevable.control.request_id': request.requestId, 'jevable.outcome': 'paused' })
    expect(spans[0].links[0].spanId).toBe(pending.traceSegments!.at(-1)!.trace.spanId)
    expect(recovered.state.steps.find(s => s.nodeId === 'judge')!.inspection!.trace).toEqual(pending.state.status === 'executing' ? pending.state.attempt.trace : undefined)
    const count = batches.length; await f.runtime.advance(pending.id, request, actor); await f.runtime.telemetryFlush()
    expect(batches).toHaveLength(count); expect(f.calls()).toBe(1)
    expect(f.telemetryBytes.length).toBeGreaterThan(0)
    for (const bytes of f.telemetryBytes) expect(bytes.toString()).not.toContain('PRIVATE_')
  })
  it.each(['jev', 'laya', 'fixture'])('%s recovers one saved answer across restart without current-route admission or downstream execution', async kind => {
    const f = await fixture(kind, 2), pending = await interrupted(f), request = control(pending)
    expect(pending.state.status).toBe('executing'); expect(f.calls()).toBe(2)
    f.runtime.configureConnection({ ...f.config, allowedModels: ['different-model'] }, 1, actor)
    f.runtime.setCredential('models/native', 'ROTATED_NOT_SENT', 1, actor)
    await f.runtime.close()
    const runtime = await LocalRuntime.open({ dataDirectory: f.directory }); cleanup.push(() => runtime.close())
    const recovered = await runtime.advance(pending.id, request, actor)
    expect(recovered.state.status).toBe('paused'); expect(recovered.state.steps).toHaveLength(2)
    const inspection = recovered.state.steps[1]!.inspection!
    expect(inspection.modelOutput).toBe(kind === 'fixture' ? 'PRIVATE_SAVED_REPLY' : f.raw)
    expect(inspection.modelUsage?.tries).toBe(2); expect(inspection).not.toHaveProperty('durationMs')
    expect(inspection).not.toHaveProperty('startedAt'); expect(f.calls()).toBe(2)
    expect(await runtime.advance(pending.id, request, actor)).toEqual(recovered)
    await expect(runtime.advance(pending.id, { ...request, requestId: randomUUID() }, actor)).rejects.toHaveProperty('code', 'conflict')
    await expect(runtime.advance(pending.id, request, 'different actor')).rejects.toHaveProperty('code', 'conflict')
    const metadata = JSON.stringify(await runtime.exportRun(pending.id))
    expect(metadata).toContain('recover'); expect(metadata).not.toContain('PRIVATE_'); expect(metadata).not.toContain('ROTATED_NOT_SENT')
    await expect(runtime.advance(pending.id, control(recovered, 'continue'), actor)).rejects.toHaveProperty('code', 'model-not-allowed')
    runtime.configureConnection(f.config, 2, actor)
    const next = await runtime.advance(pending.id, control(recovered, 'continue'), actor)
    if (kind === 'fixture') expect(next.state).toMatchObject({ status: 'completed', output: 'PRIVATE_SAVED_REPLY' })
    else {
      expect(next.state.status).toBe('waiting')
      if (next.state.status !== 'waiting') throw Error('fixture')
      expect((await runtime.decide(next.id, next.state.attempt.id, 'approve', actor)).state).toMatchObject({ status: 'completed', output: answers })
    }
    expect(f.calls()).toBe(2)
    await runtime.close()
    const again = await LocalRuntime.open({ dataDirectory: f.directory }); cleanup.push(() => again.close())
    expect((await again.advance(pending.id, request, actor)).state.status).toBe('completed'); expect(f.calls()).toBe(2)
  })

  it.each(['missing', 'pending', 'failed'])('refuses %s model evidence without acquiring a new result', async status => {
    const f = await fixture(), pending = await interrupted(f), db = new DatabaseSync(join(f.directory, 'runtime.sqlite'))
    try {
      if (pending.state.status !== 'executing') throw Error('fixture')
      const id = pending.state.attempt.id
      if (status === 'missing') db.prepare('DELETE FROM model_calls WHERE attempt_id=?').run(id)
      else {
        const row = db.prepare('SELECT record FROM model_calls WHERE attempt_id=?').get(id) as { record: string }, record = JSON.parse(row.record)
        record.result = status === 'pending' ? { status } : { status, code: 'timeout', at: new Date().toISOString() }
        db.prepare('UPDATE model_calls SET record=? WHERE attempt_id=?').run(JSON.stringify(record), id)
      }
    } finally { db.close() }
    await expect(f.runtime.advance(pending.id, control(pending), actor)).rejects.toHaveProperty('code', 'uncertain-attempt')
    expect(await f.runtime.show(pending.id)).toEqual(pending); expect(f.calls()).toBe(1)
  })

  it('refuses tampered retained native response evidence before control admission', async () => {
    const f = await fixture(), pending = await interrupted(f), db = new DatabaseSync(join(f.directory, 'runtime.sqlite'))
    try {
      if (pending.state.status !== 'executing') throw Error('fixture')
      const id = pending.state.attempt.id, row = db.prepare('SELECT record FROM model_calls WHERE attempt_id=?').get(id) as { record: string }, record = JSON.parse(row.record)
      record.result.output = record.result.output.replace('saved-native', 'wrong-model')
      db.prepare('UPDATE model_calls SET record=? WHERE attempt_id=?').run(JSON.stringify(record), id)
    } finally { db.close() }
    await expect(f.runtime.advance(pending.id, control(pending), actor)).rejects.toHaveProperty('code', 'corrupt-evidence')
    expect((await f.runtime.show(pending.id)).controlRequests).toBeUndefined(); expect(f.calls()).toBe(1)
  })

  it('does not reinterpret an already committed node result as an uncertain attempt', async () => {
    const f = await fixture(), settled = await interrupted(f, true)
    expect(settled.state.status).toBe('paused')
    await expect(f.runtime.advance(settled.id, control(settled), actor)).rejects.toHaveProperty('code', 'conflict'); expect(f.calls()).toBe(1)
  })

  it('never falls back to execute when a custom adapter has no read-only recovery port', async () => {
    const f = await fixture('fixture'), pending = await interrupted(f); await f.runtime.close()
    const execute = vi.fn(async () => ({ output: 'not authorized', usage: { tries: 1 } }))
    const runtime = await LocalRuntime.open({ dataDirectory: f.directory, models: { admit() {}, execute, async verify() {} } })
    cleanup.push(() => runtime.close())
    await expect(runtime.advance(pending.id, control(pending), actor)).rejects.toHaveProperty('code', 'invalid-command')
    expect(execute).not.toHaveBeenCalled(); expect(f.calls()).toBe(1)
  })

  it('snapshots recovered adapter output before awaiting verification', async () => {
    const f = await fixture('fixture'), pending = await interrupted(f); await f.runtime.close()
    const result = { output: 'PRIVATE_SAVED_REPLY', usage: { tries: 1 } }, execute = vi.fn()
    const runtime = await LocalRuntime.open({ dataDirectory: f.directory, models: {
      admit() {}, execute, async recover() { return result }, async verify(_node, _attempt, _input, output) {
        expect(output).toBe('PRIVATE_SAVED_REPLY'); result.output = 'unverified mutation'
      } } }); cleanup.push(() => runtime.close())
    const recovered = await runtime.advance(pending.id, control(pending), actor)
    expect(recovered.state.steps.find(step => step.nodeId === 'judge')?.output).toBe('PRIVATE_SAVED_REPLY')
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects a corrupt recovery guard on restart even when the saved output remains valid', async () => {
    const f = await fixture(), pending = await interrupted(f)
    await f.runtime.advance(pending.id, control(pending), actor); await f.runtime.close()
    const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'))
    try {
      const row = db.prepare('SELECT record FROM runs WHERE id=?').get(pending.id) as {record: string}, record = JSON.parse(row.record)
      record.controlRequests[0].expectedCheckpointSha256 = '0'.repeat(64)
      db.prepare('UPDATE runs SET record=? WHERE id=?').run(JSON.stringify(record), pending.id)
      db.prepare('UPDATE events SET data=? WHERE run_id=? AND kind=?').run(JSON.stringify(record.controlRequests[0]), pending.id, 'execution-requested')
    } finally { db.close() }
    await expect(LocalRuntime.open({ dataDirectory: f.directory })).rejects.toHaveProperty('code', 'corrupt'); expect(f.calls()).toBe(1)
  })

  it.each([false, true])('lost recovery settlement acknowledgement (committed=%s) retains exact control identity', async committed => {
    const f = await fixture(), pending = await interrupted(f), request = control(pending), save = RunStore.prototype.save
    const fault = vi.spyOn(RunStore.prototype, 'save').mockImplementation(function (this: RunStore, record, kind, data) {
      if (kind === 'node-result') { if (committed) save.call(this, record, kind, data); throw Error('lost recovery acknowledgement') }
      return save.call(this, record, kind, data)
    })
    try { await expect(f.runtime.advance(pending.id, request, actor)).rejects.toThrow('lost recovery acknowledgement') }
    finally { fault.mockRestore() }
    const retained = await f.runtime.advance(pending.id, request, actor)
    expect(retained.state.status).toBe(committed ? 'paused' : 'executing'); expect(f.calls()).toBe(1)
    if (!committed) {
      const settled = await f.runtime.advance(pending.id, control(retained), actor)
      expect(settled.state.status).toBe('paused'); expect(f.calls()).toBe(1)
    }
  })

  it('rejects active execution, stale guards, breakpoint edits and cancelled checkpoints', async () => {
    const f = await fixture(), pending = await interrupted(f), request = control(pending)
    await expect(f.runtime.advance(pending.id, { ...request, expectedCheckpointSha256: '0'.repeat(64) }, actor)).rejects.toHaveProperty('code', 'conflict')
    await expect(f.runtime.advance(pending.id, { ...request, breakpoints: [] }, actor)).rejects.toHaveProperty('code', 'invalid-command')
    const read = ProviderStore.prototype.evidence, entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const held = vi.spyOn(ProviderStore.prototype, 'evidence').mockImplementation(async function (this: ProviderStore, id: string) { entered.resolve(); await release.promise; return read.call(this, id) } as any)
    const recovering = f.runtime.advance(pending.id, request, actor)
    await entered.promise
    await expect(f.runtime.advance(pending.id, request, actor)).rejects.toHaveProperty('code', 'busy')
    const cancelling = f.runtime.cancel(pending.id, randomUUID(), actor)
    release.resolve(); held.mockRestore()
    await cancelling; expect((await recovering).state.status).toBe('cancelled')
    expect((await f.runtime.show(pending.id)).controlRequests).toBeUndefined(); expect(f.calls()).toBe(1)
  })

  it('exposes explicit recover through the authenticated owner API and direct CLI with paused exit semantics', async () => {
    const f = await fixture(), pending = await interrupted(f); await f.runtime.close()
    const token = '7'.repeat(64), service = await startRuntimeService({ runtime: { dataDirectory: f.directory }, token, actor: `local:${userInfo().username}` })
    cleanup.push(() => service.close())
    const client = new RuntimeClient(service.url, token), request = control(pending)
    const result = await client.operation({ operation: 'runs.advance', id: pending.id, ...request }) as any
    expect(result.result.status).toBe('paused'); expect(result.result.lastControl.mode).toBe('recover'); expect(f.calls()).toBe(1)
    await service.close()
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(acknowledgeCliWrite())
    try {
      expect(await main(['runs', 'recover', pending.id, '--request-id', request.requestId, '--checkpoint-sha256', request.expectedCheckpointSha256,
        '--data-dir', f.directory])).toBe(3)
      expect(JSON.parse(output.mock.calls.at(-1)![0] as string).status).toBe('paused')
    } finally { output.mockRestore() }
    expect(f.calls()).toBe(1)
  })
})
import { acknowledgeCliWrite } from './helpers/cli-write.ts'

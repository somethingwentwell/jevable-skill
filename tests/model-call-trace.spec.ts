import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { runInNewContext } from 'node:vm'
import { modelEvidenceSchema, type ModelEvidence } from '../src/providers/records.ts'
import { ProviderStore } from '../src/providers/store.ts'
import { LocalRuntime } from '../src/runtime/local.ts'
import { ModelEvidenceProjection, modelEvidenceTargets } from '../src/runtime/model-evidence.ts'
import { compileLocalRun } from '../src/runtime/run-evaluator.ts'
import { runTrace } from '../src/runtime/run-types.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { modelRequestPlan } from '../src/runtime/model-plan.ts'
import { requestBody } from '../src/providers/openai-wire.ts'
import { createPreview, projectPreviewModelHistory } from '../src/preview/index.ts'
import { traceNavigationTools } from '../src/telemetry/navigation.ts'
import { traceRecords } from '../scripts/check-postgres-telemetry.mjs'
import { logRecords } from '../scripts/check-telemetry-package.mjs'

const at = '2026-10-03T00:00:00.000Z'
const trace = runTrace.parse({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 0 })
const nodeTrace = runTrace.parse({ ...trace, spanId: 'c'.repeat(16) })
const header = `00-${trace.traceId}-${trace.spanId}-00`
const source = (maxAttempts = 1) => JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow',
  metadata: { id: 'model-call-trace', name: 'PRIVATE_SOURCE' }, spec: { inputSchema: { type: 'string' }, nodes: {
    start: { type: 'trigger', config: { modes: ['manual'] } },
    model: { type: 'llm', config: { provider: 'fixture', model: 'PRIVATE_MODEL', connection: { mode: 'workspace', id: 'fixture' },
      prompt: '${{ inputs }}', responseFormat: 'text', historyScope: 'none', generation: { maxTokens: 10, stream: false }, execution: { maxAttempts, timeoutSeconds: 5 } } },
    end: { type: 'output', config: { value: '${{ nodes.model.output }}' } },
  }, edges: [{ from: 'start', to: 'model' }, { from: 'model', to: 'end' }] } })
const connection = { id: 'fixture', provider: 'fixture', protocol: 'openai-compatible' as const, endpoint: 'http://127.0.0.1:1/v1',
  allowedModels: ['PRIVATE_MODEL'], authentication: { kind: 'none' as const }, tokenParameter: 'max_tokens' as const,
  maxRequestBytes: 10000, maxResponseBytes: 10000, maxStreamEvents: 100, maxTimeoutSeconds: 5 }
const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function fixture(maxAttempts = 1) {
  const graph = compileLocalRun(source(maxAttempts), DEFAULT_COMPILER_LIMITS)
  const input = { prompt: 'PRIVATE_INPUT', systemPrompt: '' }
  const event = { kind: 'node-intent', data: { attempt: { id: randomUUID(), nodeId: 'model', prepared: { status: 'ready', input } }, scope: null } }
  const nodeEvent = { kind: 'node-trace', data: { attemptId: event.data.attempt.id, trace: nodeTrace } }
  const target = modelEvidenceTargets(graph, [event, nodeEvent])[0]!, plan = modelRequestPlan(target.plan)
  if (plan.responseFormat === 'systemone-v1') throw Error('Expected Chat Completions fixture')
  const base = { attemptId: target.attempt.id, at, trace, route: { generation: 1, updatedAt: at, connection },
    request: JSON.parse(JSON.stringify(requestBody(plan, input, 'max_tokens'))) as ModelEvidence['request'] }
  const record: ModelEvidence = maxAttempts === 1 ? { ...base, schemaVersion: 1, result: { status: 'pending' } }
    : { ...base, schemaVersion: 2, policy: { kind: 'transient-http-v1', maxAttempts, timeoutSeconds: 5 },
      tries: [{ id: randomUUID(), number: 1, at, trace: runTrace.parse({ ...trace, spanId: 'd'.repeat(16) }), result: { status: 'pending' } }], result: { status: 'pending' } }
  return { graph, target, event, nodeEvent, record }
}

describe('immutable model-call span context', () => {
  it.each([1, 2])('retains a local span independently of outbound propagation in schema %i', maxAttempts => {
    const { record } = fixture(maxAttempts)
    expect(modelEvidenceSchema.parse(record)).toEqual(record)
    expect(record.traceparent).toBeUndefined()
    const withHeader = { ...record, route: { ...record.route, connection: { ...connection, tracePropagation: 'w3c' as const } }, traceparent: header }
    expect(modelEvidenceSchema.parse(withHeader)).toEqual(withHeader)
  })
  it.each([{ traceId: '0'.repeat(32) }, { spanId: '0'.repeat(16) }, { traceFlags: 2 }, { spanId: 'B'.repeat(16) },
    { traceId: 'PRIVATE_INPUT' }, { baggage: 'PRIVATE_DATA' }])('refuses malformed durable context %j', change => {
    const { record } = fixture()
    expect(modelEvidenceSchema.safeParse({ ...record, trace: { ...trace, ...change } }).success).toBe(false)
  })
  it.each(['traceId', 'spanId', 'traceFlags'] as const)('refuses a propagated header that disagrees with local %s', part => {
    const { record } = fixture(), other = { ...trace, [part]: part === 'traceFlags' ? 1 : 'e'.repeat(part === 'traceId' ? 32 : 16) }
    expect(modelEvidenceSchema.safeParse({ ...record, route: { ...record.route, connection: { ...connection, tracePropagation: 'w3c' } },
      traceparent: `00-${other.traceId}-${other.spanId}-0${other.traceFlags}` }).success).toBe(false)
  })
  it.each(['traceId', 'spanId', 'traceFlags'] as const)('refuses a retry child that reuses or disagrees with call %s', part => {
    const { record } = fixture(2)
    if (record.schemaVersion !== 2) throw Error('fixture')
    record.tries[0]!.trace = runTrace.parse({ ...record.tries[0]!.trace, [part]: part === 'spanId' ? trace.spanId : part === 'traceFlags' ? 1 : 'e'.repeat(32) })
    expect(modelEvidenceSchema.safeParse(record).success).toBe(false)
  })
  it.each([1, 2])('does not add, remove or rewrite call context during schema %i settlement', maxAttempts => {
    const { record } = fixture(maxAttempts), db = new DatabaseSync(':memory:'); cleanup.push(() => db.close())
    db.exec('CREATE TABLE model_calls(attempt_id TEXT PRIMARY KEY, record TEXT NOT NULL)')
    const store = new ProviderStore(db, 100000); store.saveEvidence(record)
    const settled: ModelEvidence = record.schemaVersion === 1 ? { ...record, result: { status: 'completed', at, output: 'PRIVATE_OUTPUT', usage: { tries: 1 } } }
      : { ...record, tries: [{ ...record.tries[0]!, result: { status: 'completed', at } }], result: { status: 'completed', at, output: 'PRIVATE_OUTPUT', usage: { tries: 1 } } }
    const { trace: _trace, ...removed } = settled
    expect(() => store.saveEvidence(removed)).toThrow('conflict')
    expect(() => store.saveEvidence({ ...settled, trace: { ...trace, spanId: 'e'.repeat(16) as typeof trace.spanId } })).toThrow('conflict')
    store.saveEvidence(settled); expect(store.evidence(record.attemptId)?.trace).toEqual(trace)
    const legacy = { ...record, attemptId: randomUUID() as typeof record.attemptId }; delete legacy.trace
    store.saveEvidence(legacy)
    expect(() => store.saveEvidence({ ...settled, attemptId: legacy.attemptId })).toThrow('conflict')
  })
  it('keeps header-only historical records unchanged and never derives a call trace from the header', () => {
    const { record, target } = fixture(), legacy = { ...record, route: { ...record.route, connection: { ...connection, tracePropagation: 'w3c' as const } }, traceparent: header }
    delete legacy.trace
    expect(modelEvidenceSchema.parse(legacy)).toEqual(legacy)
    const projection = new ModelEvidenceProjection(); projection.add(target, legacy)
    expect(projection.calls[0]).not.toHaveProperty('trace')
  })
})

describe('model-call evidence and read-only projections', () => {
  it.each([1, 2])('projects only retained call/try context in schema %i without payloads', maxAttempts => {
    const { record, target } = fixture(maxAttempts), projection = new ModelEvidenceProjection()
    projection.add(target, record)
    expect(projection.calls[0]).toMatchObject({ trace, status: 'pending' })
    expect(JSON.stringify(projection.calls)).not.toMatch(/PRIVATE|127\.0\.0\.1|traceparent|dispatched/)
    expect(projection.calls[0]).not.toHaveProperty('nodeTrace')
  })
  it.each(['traceId', 'spanId', 'traceFlags'] as const)('refuses call identity that disagrees with retained node %s', part => {
    const { record, target } = fixture()
    record.trace = runTrace.parse({ ...trace, [part]: part === 'spanId' ? nodeTrace.spanId : part === 'traceFlags' ? 1 : 'e'.repeat(32) })
    expect(() => new ModelEvidenceProjection().add(target, record)).toThrow('corrupt')
  })
  it('refuses duplicate, malformed and contradictory node-trace events instead of guessing a parent', () => {
    const f = fixture()
    for (const events of [[f.event, f.nodeEvent, f.nodeEvent], [f.event, { ...f.nodeEvent, data: { ...f.nodeEvent.data, trace: {} } }],
      [{ ...f.event, data: { ...f.event.data, attempt: { ...f.event.data.attempt, trace } } }, f.nodeEvent]]) {
      expect(() => modelEvidenceTargets(f.graph, events)).toThrow('corrupt')
    }
  })
  it.each([1, 2])('adds only the actual recorded model-call navigation reference for envelope %i', version => {
    const { record, target } = fixture(), projection = new ModelEvidenceProjection(); projection.add(target, record)
    const snapshot = { schemaVersion: version, format: 'jevable.ai/run-evidence', run: { id: randomUUID(), revision: 'a'.repeat(64), status: 'executing' },
      steps: [], journal: [], models: { format: 'jevable.model-history/v1', source: 'configured-model-store', calls: projection.calls },
      privacy: { payloads: 'excluded', actors: 'excluded', credentialStore: 'excluded' } }
    const tools = traceNavigationTools(), reference = tools.project(snapshot).references
    expect(reference).toEqual([{ source: 'model-call', nodeId: 'model', attemptId: record.attemptId, ...trace, url: null }])
    const serialized = runInNewContext(`(${traceNavigationTools.toString()})().project(snapshot)`, { snapshot })
    expect(serialized).toEqual(tools.project(snapshot))
    snapshot.models.calls = [{ ...projection.calls[0]!, trace: undefined } as never]
    expect(tools.project(snapshot).references).toEqual([])
  })
  it.each([1, 2])('admits serialized preview call context for envelope %i and strips private additions', version => {
    const { record, target } = fixture(2), projection = new ModelEvidenceProjection(); projection.add(target, record)
    const preview = createPreview(source(2)), runId = randomUUID()
    const value = { schemaVersion: version, snapshot: { schemaVersion: version, format: 'jevable.ai/run-evidence', run: { id: runId, revision: preview.revision, status: 'executing' },
      models: { format: 'jevable.model-history/v1', source: 'configured-model-store', calls: [{ ...projection.calls[0]!, route: 'PRIVATE_ENDPOINT', trace: { ...trace, baggage: 'PRIVATE' } }] } },
      checksum: { algorithm: 'sha256', encoding: 'JSON.stringify(snapshot)', value: 'a'.repeat(64) } }
    const projected = projectPreviewModelHistory(preview, runId, value)
    expect(projected.calls[0]).toMatchObject({ trace })
    expect(JSON.stringify(projected)).not.toContain('PRIVATE')
    expect(runInNewContext(`(${projectPreviewModelHistory.toString()})(preview,id,value)`, { preview, id: runId, value })).toEqual(projected)
    for (const change of [{ trace: { ...trace, spanId: '0'.repeat(16) } }, { trace: { ...trace, traceFlags: 1 } }, { evidence: 'not-recorded' }]) {
      expect(() => projectPreviewModelHistory(preview, runId, { ...value, snapshot: { ...value.snapshot, models: { ...value.snapshot.models,
        calls: [{ ...value.snapshot.models.calls[0]!, ...change }] } } })).toThrow('cannot be safely matched')
    }
  })
})

it.each([
  { telemetry: true, traces: true, sampleRatio: 1, propagation: 'none' as const },
  { telemetry: true, traces: true, sampleRatio: 1, propagation: 'w3c' as const },
  { telemetry: true, traces: true, sampleRatio: 0, propagation: 'none' as const },
  { telemetry: true, traces: true, sampleRatio: 0, propagation: 'w3c' as const },
  { telemetry: true, traces: false, sampleRatio: 1, propagation: 'none' as const },
  { telemetry: false, traces: false, sampleRatio: 1, propagation: 'w3c' as const },
])('retains the actual call span across owner reopen, with no invented export or propagation: %j', async policy => {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-model-call-trace-')), packets: { path: string; bytes: Buffer }[] = [], requests: Record<string, string>[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: { headers: Record<string, string>; body: Uint8Array }) => {
    if (url.endsWith('/chat/completions')) {
      requests.push(options.headers)
      return new Response(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'PRIVATE_OUTPUT' } }] }), { headers: { 'content-type': 'application/json' } })
    }
    packets.push({ path: new URL(url).pathname, bytes: Buffer.from(options.body) })
    return new Response(new Uint8Array(), { headers: { 'content-type': 'application/x-protobuf' } })
  }))
  const runtime = await LocalRuntime.open({ dataDirectory: directory, ...(policy.telemetry ? { telemetry: {
    ...(policy.traces ? { endpoint: 'http://127.0.0.1:1/v1/traces' } : {}), logsEndpoint: 'http://127.0.0.1:1/v1/logs',
    authentication: { kind: 'none' as const }, sampleRatio: policy.sampleRatio, intervalMs: 60000, timeoutMs: 1000, flushTimeoutMs: 2000,
  } } : {}) }); cleanup.push(() => runtime.close())
  runtime.configureConnection({ ...connection, tracePropagation: policy.propagation }, 0, 'local:fixture')
  const run = await runtime.run(source(), 'PRIVATE_INPUT'), evidence = await runtime.exportRun(run.id)
  const call = evidence.snapshot.models!.calls[0]!
  if (call.evidence !== 'recorded') throw Error('fixture')
  expect(JSON.stringify(evidence)).not.toMatch(/PRIVATE|127\.0\.0\.1/)
  if (policy.telemetry) {
    expect(call.trace).toBeDefined()
    const parent = run.state.steps.find(step => step.nodeId === 'model')!.inspection!.trace!
    expect(call.trace!.traceId).toBe(parent.traceId); expect(call.trace!.spanId).not.toBe(parent.spanId)
    expect(call.trace!.traceFlags).toBe(policy.traces ? policy.sampleRatio : 0)
    expect(requests[0]!.traceparent).toBe(policy.propagation === 'w3c' ? `00-${call.trace!.traceId}-${call.trace!.spanId}-0${call.trace!.traceFlags}` : undefined)
    await runtime.telemetryFlush()
    const spans = packets.filter(packet => packet.path === '/v1/traces').flatMap(packet => traceRecords(packet.bytes))
    if (policy.traces && policy.sampleRatio) expect(spans.find(span => span.name === 'jevable.model')).toMatchObject({ traceId: call.trace!.traceId, spanId: call.trace!.spanId, parent: parent.spanId })
    else expect(spans).toEqual([])
    const logs = packets.filter(packet => packet.path === '/v1/logs').flatMap(packet => logRecords(packet.bytes))
    expect(logs.find(log => log.event === 'jevable.model.call.ended')).toMatchObject({ traceId: call.trace!.traceId, spanId: call.trace!.spanId })
    expect(traceNavigationTools().project(evidence.snapshot).references.find(reference => reference.source === 'model-call')).toMatchObject(call.trace!)
  } else { expect(call).not.toHaveProperty('trace'); expect(requests[0]!.traceparent).toBeUndefined(); expect(packets).toEqual([]) }
  await runtime.close()
  const reopened = await LocalRuntime.open({ dataDirectory: directory }); cleanup.push(() => reopened.close())
  expect(await reopened.exportRun(run.id)).toEqual(evidence); expect(requests).toHaveLength(1)
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalRuntime } from '../src/runtime/local.ts'
import { ModelEvidenceProjection, modelEvidenceTargets } from '../src/runtime/model-evidence.ts'
import { compileLocalRun } from '../src/runtime/run-evaluator.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { requestBody } from '../src/providers/openai-wire.ts'
import { modelRequestPlan } from '../src/runtime/model-plan.ts'
import type { ModelEvidence } from '../src/providers/records.ts'
import type { ProviderConnection } from '../src/providers/config.ts'

const at = '2026-09-30T00:00:00.000Z', input = { prompt: 'PRIVATE_PROMPT', systemPrompt: '' }
const source = (maxAttempts = 3) => JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow',
  metadata: { id: 'history', name: 'PRIVATE_SOURCE' }, spec: { inputSchema: { type: 'string' }, nodes: {
    start: { type: 'trigger', config: { modes: ['manual'] } },
    model: { type: 'llm', config: { provider: 'fixture', model: 'PRIVATE_MODEL', connection: { mode: 'workspace', id: 'fixture' },
      prompt: '${{ inputs }}', responseFormat: 'text', historyScope: 'none', generation: { maxTokens: 20, stream: false }, execution: { maxAttempts, timeoutSeconds: 5 } } },
    end: { type: 'output', config: { value: '${{ nodes.model.output }}' } } }, edges: [{ from: 'start', to: 'model' }, { from: 'model', to: 'end' }] } })
const connection: ProviderConnection = { id: 'fixture', provider: 'fixture', protocol: 'openai-compatible',
  endpoint: 'http://127.0.0.1:1/v1', allowedModels: ['PRIVATE_MODEL'], authentication: { kind: 'bearer', credentialRef: 'PRIVATE/key' },
  tokenParameter: 'max_tokens', maxRequestBytes: 10000, maxResponseBytes: 10000, maxStreamEvents: 100, maxTimeoutSeconds: 5 }
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
async function owner() {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-model-history-'))
  const runtime = await LocalRuntime.open({ dataDirectory }); cleanup.push(() => runtime.close())
  runtime.configureConnection(connection, 0, 'PRIVATE_ACTOR'); runtime.setCredential('PRIVATE/key', 'PRIVATE_TOKEN', 0, 'PRIVATE_ACTOR')
  return { runtime, dataDirectory }
}
const success = () => new Response(JSON.stringify({ id: 'PRIVATE_RESPONSE_ID', model: 'PRIVATE_MODEL',
  usage: { prompt_tokens: 2, completion_tokens: 3 }, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'PRIVATE_OUTPUT' } }] }),
  { headers: { 'content-type': 'application/json' } })
function projectionFixture(maxAttempts = 3) {
  const graph = compileLocalRun(source(maxAttempts), DEFAULT_COMPILER_LIMITS), attemptId = randomUUID()
  const event = { kind: 'node-intent', data: { attempt: { id: attemptId, nodeId: 'model', prepared: { status: 'ready', input } }, scope: null } }
  const target = modelEvidenceTargets(graph, [event])[0]!
  const plan = modelRequestPlan(target.plan)
  if (plan.responseFormat === 'systemone-v1') throw new Error('Expected Chat Completions fixture')
  const base = { attemptId, at, route: { generation: 1, updatedAt: at, connection: structuredClone(connection) },
    request: JSON.parse(JSON.stringify(requestBody(plan, input, 'max_tokens'))) as ModelEvidence['request'] }
  const record: ModelEvidence = maxAttempts === 1 ? { ...base, schemaVersion: 1, result: { status: 'pending' } }
    : { ...base, schemaVersion: 2, policy: { kind: 'transient-http-v1', maxAttempts, timeoutSeconds: 5 },
      tries: [{ id: randomUUID(), number: 1, at, result: { status: 'pending' } }], result: { status: 'pending' } }
  return { graph, event, target, record }
}

describe('metadata-only configured-model history', () => {
  it.each([1, 3])('projects only retained metadata, with no invented dispatch or missing trace: maxAttempts=%i', maxAttempts => {
    const { target, record } = projectionFixture(maxAttempts), projection = new ModelEvidenceProjection()
    projection.add(target, record)
    const call = projection.calls[0]!
    if (call.evidence !== 'recorded') throw Error('fixture')
    expect(call).toMatchObject({ attemptId: record.attemptId, evidence: 'recorded', evidenceSchemaVersion: record.schemaVersion, status: 'pending' })
    expect(JSON.stringify(call)).not.toMatch(/PRIVATE|127\.0\.0\.1|dispatched|durationMs|settledAt|traceId/)
    expect(call.tries?.length).toBe(maxAttempts === 1 ? undefined : 1)
    expect(call.tries?.[0]?.status).toBe(maxAttempts === 1 ? undefined : 'pending')
  })
  it('leaves custom/unrecorded evidence explicit, without claiming zero provider calls', () => {
    const { target } = projectionFixture(), projection = new ModelEvidenceProjection()
    projection.add(target, undefined)
    expect(projection.calls).toEqual([{ nodeId: 'model', attemptId: target.attempt.id, evidence: 'not-recorded' }])
  })
  it.each(['identity', 'request', 'policy', 'route', 'malformed'] as const)('refuses %s corruption even before settlement', fault => {
    const { target, record } = projectionFixture()
    if (record.schemaVersion !== 2) throw Error('fixture')
    if (fault === 'identity') record.attemptId = randomUUID()
    if (fault === 'request') record.request.messages = []
    if (fault === 'policy') record.policy.maxAttempts = 2
    if (fault === 'route') record.route.connection.id = 'different'
    if (fault === 'malformed') record.tries[0]!.number = 2
    expect(() => new ModelEvidenceProjection().add(target, record)).toThrow('corrupt')
  })
  it('caps cumulative record reads and rejects duplicate or unknown intent bindings', () => {
    const { target, record, graph, event } = projectionFixture()
    const projection = new ModelEvidenceProjection(Buffer.byteLength(JSON.stringify(record)))
    projection.add(target, record)
    expect(() => projection.add(target, record)).toThrow('limit')
    expect(() => modelEvidenceTargets(graph, [event, event])).toThrow('corrupt')
    expect(() => modelEvidenceTargets(graph, [{ ...event, data: { ...event.data, attempt: { ...event.data.attempt, nodeId: 'unknown' } } }])).toThrow('corrupt')
  })
  it('retains scheduled backoff and cancellation independently, not as a fictitious second try', () => {
    const { target, record } = projectionFixture()
    if (record.schemaVersion !== 2) throw Error('fixture')
    record.tries[0]!.result = { status: 'failed', code: 'http-error', httpStatus: 503, retryDelayMs: 100, at }
    record.result = { status: 'failed', code: 'cancelled', at }
    const projection = new ModelEvidenceProjection(); projection.add(target, record)
    expect(projection.calls[0]).toMatchObject({ status: 'failed', code: 'cancelled', tries: [
      { number: 1, status: 'failed', code: 'http-error', httpStatus: 503, scheduledDelayMs: 100 } ] })
  })
  it('retains child trace identity without treating the span as a delivery receipt', () => {
    const { target, record } = projectionFixture()
    if (record.schemaVersion !== 2) throw Error('fixture')
    const trace = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 0 } as NonNullable<typeof record.tries[0]['trace']>
    record.tries[0]!.trace = trace
    const projection = new ModelEvidenceProjection(); projection.add(target, record)
    const call = projection.calls[0]!
    if (call.evidence !== 'recorded') throw Error('fixture')
    expect(call.tries?.[0]?.trace).toEqual(trace)
    expect(JSON.stringify(projection.calls)).not.toContain('dispatched')
  })
  it('exports successful retry history with stable checksums across reopen and no further fetch', async () => {
    const { runtime, dataDirectory } = await owner(), fetch = vi.fn(async () => fetch.mock.calls.length === 1 ? new Response('PRIVATE_ERROR', { status: 503 }) : success())
    vi.stubGlobal('fetch', fetch)
    const run = await runtime.run(source(), 'PRIVATE_PROMPT'), result = await runtime.exportRun(run.id)
    expect(result.snapshot.models?.calls).toHaveLength(1)
    expect(result.snapshot.models?.calls[0]).toMatchObject({ nodeId: 'model', status: 'completed', usage: { tries: 2, inputTokens: 2, outputTokens: 3 },
      tries: [{ number: 1, status: 'failed', httpStatus: 503, scheduledDelayMs: 100 }, { number: 2, status: 'completed' }] })
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|PRIVATE\/key|127\.0\.0\.1/)
    expect(result.checksum.value).toBe(createHash('sha256').update(JSON.stringify(result.snapshot)).digest('hex'))
    expect((await runtime.exportRun(run.id, true)).snapshot.models).toEqual(result.snapshot.models)
    await runtime.close()
    const reopened = await LocalRuntime.open({ dataDirectory }); cleanup.push(() => reopened.close())
    expect(await reopened.exportRun(run.id)).toEqual(result); expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('observes a pending try during execution without dispatching a second request', async () => {
    const { runtime } = await owner(), entered = Promise.withResolvers<void>(), response = Promise.withResolvers<Response>()
    const fetch = vi.fn(async () => { entered.resolve(); return response.promise }); vi.stubGlobal('fetch', fetch)
    const id = randomUUID(), running = runtime.run(source(), 'PRIVATE_PROMPT', { id })
    await Promise.race([entered.promise, running.then(() => { throw Error('completed without fetch') })])
    try {
      const evidence = await runtime.exportRun(id)
      expect(evidence.snapshot.run.status).toBe('executing')
      expect(evidence.snapshot.models?.calls[0]).toMatchObject({ status: 'pending', tries: [{ number: 1, status: 'pending' }] })
      expect(fetch).toHaveBeenCalledOnce()
      expect(JSON.stringify(evidence)).not.toContain('PRIVATE_')
    } finally { response.resolve(success()); await running }
  })
  it('exports exhausted failures without resuming the uncertain workflow', async () => {
    const { runtime } = await owner(), fetch = vi.fn(async () => new Response('PRIVATE_ERROR', { status: 503 }))
    vi.stubGlobal('fetch', fetch)
    const id = randomUUID(); await expect(runtime.run(source(2), 'PRIVATE_PROMPT', { id })).rejects.toHaveProperty('code', 'http-error')
    const result = await runtime.exportRun(id)
    expect(result.snapshot.run.status).toBe('executing')
    expect(result.snapshot.models?.calls[0]).toMatchObject({ status: 'failed', code: 'http-error', tries: [
      { number: 1, status: 'failed', scheduledDelayMs: 100 }, { number: 2, status: 'failed' } ] })
    expect(await runtime.exportRun(id)).toEqual(result); expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('keeps separate loop iterations and their retry UUIDs in recorded order', async () => {
    const { runtime } = await owner(), definition = JSON.parse(source(2))
    const model = definition.spec.nodes.model; model.config.prompt = '${{ loop.item }}'
    definition.spec.inputSchema = { type: 'array', items: { type: 'string' }, maxItems: 2 }
    definition.spec.nodes = { start: definition.spec.nodes.start,
      each: { type: 'loop', config: { mode: 'forEach', items: '${{ inputs }}', maxIterations: 2, timeoutSeconds: 30,
        body: { entry: 'model', nodes: { model }, edges: [], exits: [{ from: 'model', result: '${{ nodes.model.output }}' }] } } },
      end: { type: 'output', config: { value: '${{ nodes.each.output.results }}' } } }
    definition.spec.edges = [{ from: 'start', to: 'each' }, { from: 'each', port: 'done', to: 'end' }]
    const fetch = vi.fn(async () => fetch.mock.calls.length % 2 ? new Response(null, { status: 503 }) : success()); vi.stubGlobal('fetch', fetch)
    const run = await runtime.run(JSON.stringify(definition), ['PRIVATE_ONE', 'PRIVATE_TWO'])
    const history = (await runtime.exportRun(run.id)).snapshot.models!
    expect(history.calls.map(call => call.scope)).toEqual([{ loop: 'each', index: 0 }, { loop: 'each', index: 1 }])
    expect(new Set(history.calls.map(call => call.attemptId)).size).toBe(2)
    const tries = history.calls.flatMap(call => call.evidence === 'recorded' ? call.tries ?? [] : [])
    expect(tries.map(attempt => attempt.number)).toEqual([1, 2, 1, 2])
    expect(new Set(tries.map(attempt => attempt.id)).size).toBe(4)
    expect(fetch).toHaveBeenCalledTimes(4); expect(JSON.stringify(history)).not.toContain('PRIVATE_')
  })
})

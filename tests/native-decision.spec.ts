import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, mkdtemp } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { parse } from 'yaml'
import { LocalRuntime } from '../src/runtime/index.ts'
import { ProviderStore } from '../src/providers/store.ts'
import { ConfiguredModels } from '../src/providers/model-calls.ts'
import { connectionSchema, type ProviderConnection } from '../src/providers/config.ts'
import { compileWorkflow, validateDecisionAnswers, type CompiledDecisionPlan } from '../src/workflow/index.ts'
import { DEFAULT_COMPILER_LIMITS as limits } from '../src/limits.ts'
import { modelInput, modelRequestPlan } from '../src/runtime/model-plan.ts'
import { modelValue } from '../src/runtime/model-format.ts'
import { verifyEvidenceRequest } from '../src/providers/evidence-request.ts'
import { modelEvidenceSchema, type ModelEvidence } from '../src/providers/records.ts'
import { releaseRequirements } from '../src/releases/snapshot.ts'
import { runTrace } from '../src/runtime/run-types.ts'
import { startRuntimeService } from '../src/http/index.ts'
import { PROTOCOL_VERSION } from '../src/capabilities.ts'
import { createUsageReport } from '../src/evidence/index.ts'

const example = parse(await readFile(new URL('../examples/native-decision.yaml', import.meta.url), 'utf8'))
const source = (provider = 'jev', attempts = 1) => { const value = structuredClone(example); value.spec.nodes.judge.config.provider = provider;
  value.spec.nodes.judge.config.execution = { maxAttempts: attempts, timeoutSeconds: 2 }; return value }
const plan = (value = source()) => compileWorkflow(value, limits).nodes.find(node => node.id === 'judge')!.plan as CompiledDecisionPlan
function reply(review = 0.1) { return { model: 'resolved-native', answers: {
  team: { type: 'choice', choice: 'billing', probabilities: { billing: 0.75, support: 0.25 }, confidence: 0.6 },
  urgency: { type: 'score', score: 1.6, legend: { '0': 'Routine', '1': 'Soon', '2': 'Immediate' }, probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 }, confidence: 0.8 },
  review: { type: 'noul', noul: review } }, usage: { input_tokens: 12, output_tokens: 0 } } }
const connection = (endpoint: string, provider = 'jev'): ProviderConnection => ({ id: 'native-decisions', provider: provider as 'jev' | 'laya',
  protocol: 'systemone', endpoint, allowedModels: ['your-explicit-model-id'], authentication: { kind: 'bearer', credentialRef: 'models/native' },
  maxRequestBytes: 100_000, maxResponseBytes: 100_000, maxTimeoutSeconds: 5 })
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(send: (response: ServerResponse, number: number) => void = response => {
  response.writeHead(200, { 'content-type': 'application/json' }); response.end(' \n' + JSON.stringify(reply(), null, 2) + '\n')
}) {
  const requests: { url: string | undefined; body: unknown; authorization: string | undefined; traceparent: string | string[] | undefined }[] = []
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += String(chunk)
    requests.push({ url: request.url, body: JSON.parse(raw), authorization: request.headers.authorization, traceparent: request.headers.traceparent })
    send(response, requests.length)
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Fixture address missing')
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()) }))
  return { endpoint: `http://127.0.0.1:${address.port}/v1`, requests }
}
async function owner(config?: ProviderConnection) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-native-')), runtime = await LocalRuntime.open({ dataDirectory })
  cleanup.push(() => runtime.close())
  if (config) { runtime.configureConnection(config, 0, 'fixture'); runtime.setCredential('models/native', 'PRIVATE_TOKEN', 0, 'fixture') }
  return { runtime, dataDirectory }
}

describe('native Decision scoped preview protocol (not browser qualification)', () => {
  it.each(['jev', 'laya'])('%s preserves guarded debugging, approvals, private inspection and reviewed saved tests', async provider => {
    const server = await fixture((response, count) => {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(' \n' + JSON.stringify(reply(count === 1 ? 0.9 : 0.1), null, 2) + '\n')
    })
    const { runtime, dataDirectory } = await owner(connection(server.endpoint, provider)); await runtime.close()
    const token = randomBytes(32).toString('hex')
    const service = await startRuntimeService({ runtime: { dataDirectory }, token, actor: 'fixture:preview', preview: { source: JSON.stringify(source(provider)) } })
    cleanup.push(async () => { await service.close() })
    const post = (path: string, command: unknown, bearer: string) => fetch(service.url + path, { method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'X-Jevable-Protocol': PROTOCOL_VERSION }, body: JSON.stringify(command) })
    const bootstrap = await post('/v1/preview/bootstrap', {}, token); expect(bootstrap.status).toBe(200)
    const session = (await bootstrap.json() as any).result
    const operation = async (command: unknown) => {
      const response = await post('/v1/preview/operations', command, session.token); expect(response.status).toBe(200)
      return (await response.json() as any).result
    }
    const id = randomUUID(), paused = await operation({ operation: 'run', id, input: 'PRIVATE_PREVIEW_INPUT', paused: true })
    const hit = await operation({ operation: 'advance', id, requestId: randomUUID(), mode: 'continue', expectedCheckpointSha256: paused.checkpointSha256, breakpoints: ['judge'] })
    expect(hit.breakpoint.nodeId).toBe('judge'); expect(server.requests).toHaveLength(0)
    const waiting = await operation({ operation: 'advance', id, requestId: randomUUID(), mode: 'continue', expectedCheckpointSha256: hit.checkpointSha256, breakpoints: [] })
    expect(waiting.status).toBe('waiting'); expect(server.requests).toHaveLength(1)
    const evidence = await operation({ operation: 'evidence', id })
    expect(evidence.snapshot.models.calls[0].status).toBe('completed')
    expect(JSON.stringify(evidence)).not.toContain('PRIVATE_PREVIEW_INPUT'); expect(JSON.stringify(evidence)).not.toContain('PRIVATE_TOKEN')
    const inspected = await operation({ operation: 'inspect', id })
    expect(inspected.run.state.steps.find((step: any) => step.nodeId === 'judge').inspection.modelOutput)
      .toBe(' \n' + JSON.stringify(reply(0.9), null, 2) + '\n')
    const review = await operation({ operation: 'approval', id }); expect(review.actions).toContain('approve')
    const done = await operation({ operation: 'decide', id, attemptId: waiting.attemptId, action: 'approve' })
    expect(done.status).toBe('completed'); expect(done.output).toEqual(reply(0.9).answers); expect(server.requests).toHaveLength(1)
    const caseId = randomUUID(), runId = randomUUID()
    const draft = await operation({ operation: 'tests.create', id: caseId, title: 'Native result', input: 'PRIVATE_SAVED_INPUT',
      expectations: [{ kind: 'status', value: 'completed' }, { kind: 'output-equals', value: reply().answers }] })
    const accepted = await operation({ operation: 'tests.accept', id: caseId, expectedGeneration: draft.generation, reviewedSha256: draft.sha256 })
    const command = { operation: 'tests.run', test: { id: caseId, generation: accepted.generation, sha256: accepted.sha256 }, runId }
    const result = await operation(command); expect(result).toMatchObject({ assessment: 'passed', workflowStatus: 'completed', terminal: true })
    expect(await operation(command)).toEqual(result); expect(server.requests).toHaveLength(2)
    await service.close()
    const reopened = await LocalRuntime.open({ dataDirectory }); cleanup.push(() => reopened.close())
    expect((await reopened.show(id)).state).toMatchObject({ status: 'completed', output: reply(0.9).answers })
    expect(await reopened.testResult(runId)).toEqual(result); expect(server.requests).toHaveLength(2)
  })
})

describe('explicit native Decision contract', () => {
  it('compiles native paths and preserves all reported answer values without confidence synthesis or rounding', () => {
    const p = plan(), answers = reply().answers; answers.team.probabilities.billing += 0.000001
    expect(p.answerFormat).toBe('systemone-v1'); expect(validateDecisionAnswers(p, answers, limits.binding.data)).toEqual(answers)
    expect(modelValue(modelRequestPlan(p), JSON.stringify({ ...reply(), answers }), limits.binding.data)).toEqual(answers)
    expect(modelInput(p, { private: 'state' })).toEqual({ prompt: '{"private":"state"}', systemPrompt: '' })
    expect(modelRequestPlan(p)).not.toHaveProperty('generation')
  })
  it('does not silently change the old native or LLM-compatible compiled output schema', async () => {
    const old = parse(await readFile(new URL('../examples/decision.yaml', import.meta.url), 'utf8'))
    const p = plan(old); expect(p.answerFormat).toBeUndefined()
    expect(p.output.definition).toMatchObject({ properties: { needsHuman: { required: ['type', 'probability', 'confidence'] } } })
    expect(() => modelRequestPlan(p)).toThrow()
    const malformed = reply(); (malformed.answers.review as any).confidence = 0.9
    expect(() => modelValue(modelRequestPlan(plan()), JSON.stringify(malformed), limits.binding.data)).toThrow('Native model response')
  })
  it.each(['llm', 'auto', 'unknown'])('does not admit native format for implicit or incompatible route %s', provider => {
    const value = source(provider)
    if (provider === 'llm') value.spec.nodes.judge.config.llm = { provider: 'fixture', generation: { maxTokens: 10, stream: false } }
    expect(() => compileWorkflow(value, limits)).toThrow()
  })
  it.each(['confidence', 'probability'])('rejects unavailable native Noul output binding %s', property => {
    const value = source(); value.spec.nodes.route.config.condition = '${{ nodes.judge.output.review.' + property + ' > 0.5 }}'
    expect(() => compileWorkflow(value, limits)).toThrow()
  })
  it('compiles score probability and rubric bindings with exact level keys', () => {
    const value = source(); value.spec.nodes.result.config.value = '${{ nodes.judge.output.urgency.probabilities["2"] }}'
    expect(() => compileWorkflow(value, limits)).not.toThrow()
  })
  it.each(['tokenParameter', 'maxStreamEvents'])('refuses chat-only connection setting %s', key => {
    expect(connectionSchema.safeParse({ ...connection('https://example.test/v1'), [key]: key === 'tokenParameter' ? 'max_tokens' : 5 }).success).toBe(false)
  })
  it('describes native release requirements without relabeling them as Chat Completions', () => {
    const graph = compileWorkflow(source(), limits)
    const requirements = releaseRequirements({ format: 'jevable.ai/release', schemaVersion: 1, id: randomUUID(), version: '1.0.0',
      createdAt: new Date().toISOString(), createdBy: 'fixture', project: { id: randomUUID(), generation: 1 },
      workflow: graph.source, runtime: { version: '0.1.0-alpha.1', sha256: 'a'.repeat(64) } })
    expect(requirements.protocol).toBe('systemone'); expect(requirements.models[0]).toMatchObject({ protocol: 'systemone', answerFormat: 'systemone-v1' })
  })
})

describe('durable configured native execution', () => {
  it.each(['jev', 'laya'])('executes %s directly at /systemone, retains raw evidence and reopens offline', async provider => {
    const server = await fixture(), { runtime, dataDirectory } = await owner(connection(server.endpoint, provider)), yaml = JSON.stringify(source(provider)), id = randomUUID()
    expect((await runtime.check(yaml)).runtimeReadiness).toBe('ready'); expect(server.requests).toHaveLength(0)
    const run = await runtime.run(yaml, 'PRIVATE_INPUT', { id }); expect(run.state.status).toBe('completed')
    if (run.state.status === 'completed') expect(run.state.output).toEqual(reply().answers)
    expect(server.requests).toEqual([{ url: '/v1/systemone', body: { model: 'your-explicit-model-id', state: 'PRIVATE_INPUT', questions: source(provider).spec.nodes.judge.config.questions },
      authorization: 'Bearer PRIVATE_TOKEN', traceparent: undefined }])
    const raw = run.state.steps.find(step => step.nodeId === 'judge')!.inspection!.modelOutput!
    expect(raw).toBe(' \n' + JSON.stringify(reply(), null, 2) + '\n')
    expect(run.state.steps.find(step => step.nodeId === 'judge')!.inspection!.modelUsage).toEqual({ tries: 1, inputTokens: 12, outputTokens: 0 })
    expect(JSON.stringify(await runtime.exportRun(id))).not.toContain('PRIVATE_INPUT')
    await runtime.close(); const reopened = await LocalRuntime.open({ dataDirectory }); cleanup.push(() => reopened.close())
    expect(await reopened.show(id)).toEqual(run); expect((await reopened.run(yaml, 'PRIVATE_INPUT', { id })).state).toEqual(run.state)
    expect(server.requests).toHaveLength(1)
    const beforeUsage = await reopened.events(id)
    const grouped = await createUsageReport(reopened, { schemaVersion: 1, runs: [{ id, revision: run.revision }], groupBy: 'provider-model' })
    expect(grouped.groups![0]).toMatchObject({ key: { provider, model: 'your-explicit-model-id' },
      summary: { inputTokens: { reportedTokens: '12' }, outputTokens: { reportedTokens: '0' } } })
    expect(JSON.stringify(grouped)).not.toMatch(/PRIVATE_|resolved-native|native-decisions|models\/native/)
    expect(await reopened.events(id)).toEqual(beforeUsage); expect(server.requests).toHaveLength(1)
    expect(JSON.stringify(await reopened.exportRun(id))).not.toMatch(/usageIdentity|modelIdentities|your-explicit-model-id/)
    const db = new DatabaseSync(join(dataDirectory, 'runtime.sqlite'), { readOnly: true })
    try { const record = JSON.parse((db.prepare('SELECT record FROM model_calls WHERE attempt_id=?').get(run.state.steps.find(step => step.nodeId === 'judge')!.inspection!.attemptId!) as {record: string}).record)
      expect(record.result).toMatchObject({ status: 'completed', output: raw, providerModel: 'resolved-native' })
      expect(JSON.stringify(record)).not.toContain('PRIVATE_TOKEN')
    } finally { db.close() }
  })
  it('preserves native approval evidence across explicit owner restart without a second call', async () => {
    const server = await fixture(response => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(reply(0.9))) })
    const { runtime, dataDirectory } = await owner(connection(server.endpoint)), run = await runtime.run(JSON.stringify(source()), 'private')
    expect(run.state.status).toBe('waiting'); await runtime.close()
    const reopened = await LocalRuntime.open({ dataDirectory }); cleanup.push(() => reopened.close())
    const saved = await reopened.show(run.id); expect(saved.state).toEqual(run.state)
    if (saved.state.status !== 'waiting') throw Error('Expected approval')
    const result = await reopened.decide(run.id, saved.state.attempt.id, 'approve', 'fixture:reviewer')
    expect(result.state.status).toBe('completed'); expect(server.requests).toHaveLength(1)
  })
  it('retries only reviewed transient HTTP responses with identical native request and persisted per-try evidence', async () => {
    const server = await fixture((response, number) => { response.writeHead(number === 1 ? 503 : 200, { 'content-type': 'application/json' });
      response.end(number === 1 ? '{"error":"private"}' : JSON.stringify(reply())) })
    const { runtime } = await owner(connection(server.endpoint)), run = await runtime.run(JSON.stringify(source('jev', 2)), 'private')
    expect(run.state.status).toBe('completed'); expect(server.requests).toHaveLength(2); expect(server.requests[0]).toEqual(server.requests[1])
    expect(run.state.steps.find(step => step.nodeId === 'judge')?.inspection?.modelUsage?.tries).toBe(2)
    expect(JSON.stringify(await runtime.exportRun(run.id))).toContain('transient-http-v1')
    await runtime.show(run.id); expect(server.requests).toHaveLength(2)
  })
  it.each(['wrong-protocol', 'wrong-provider', 'missing-credential', 'unlisted-model'])('refuses %s during readiness without dispatch', async mode => {
    const server = await fixture(), config: any = connection(server.endpoint)
    if (mode === 'wrong-protocol') { config.protocol = 'openai-compatible'; config.tokenParameter = 'max_tokens'; config.maxStreamEvents = 100 }
    if (mode === 'wrong-provider') config.provider = 'laya'
    if (mode === 'missing-credential') config.authentication.credentialRef = 'missing/key'
    if (mode === 'unlisted-model') config.allowedModels = ['other']
    const { runtime } = await owner(config)
    expect((await runtime.check(JSON.stringify(source()))).runtimeReadiness).not.toBe('ready')
    await expect(runtime.run(JSON.stringify(source()), 'private')).rejects.toThrow(); expect(server.requests).toHaveLength(0)
  })
  it.each(['invalid-native', 'chat-envelope', 'redirect', 'sse', 'non-retry-status'])('does not repeat or fall back after %s', async mode => {
    const server = await fixture(response => {
      response.writeHead(mode === 'redirect' ? 302 : mode === 'non-retry-status' ? 529 : 200,
        { 'content-type': mode === 'sse' ? 'text/event-stream' : 'application/json', location: 'https://unused.invalid' })
      response.end(JSON.stringify(mode === 'chat-envelope' ? { choices: [] } : { ...reply(), answers: {} }))
    }), { runtime } = await owner(connection(server.endpoint)), id = randomUUID(), yaml = JSON.stringify(source('jev', 3))
    await expect(runtime.run(yaml, 'private', { id })).rejects.toThrow(); expect(server.requests).toHaveLength(1)
    expect((await runtime.run(yaml, 'private', { id })).state.status).toBe('executing'); expect(server.requests).toHaveLength(1)
  })
  it.each(['pending', 'completed'])('does not dispatch or retry past failed %s evidence writes', async stage => {
    const server = await fixture(), { runtime } = await owner(connection(server.endpoint)), save = ProviderStore.prototype.saveEvidence
    vi.spyOn(ProviderStore.prototype, 'saveEvidence').mockImplementation(function (this: ProviderStore, record) {
      if (record.result.status === stage) throw Error('fixture persistence failure'); return save.call(this, record)
    })
    await expect(runtime.run(JSON.stringify(source('jev', 2)), 'private')).rejects.toThrow('fixture persistence failure')
    expect(server.requests).toHaveLength(stage === 'pending' ? 0 : 1)
  })
  it('verifies native usage, raw output and request offline, independently of current credentials', async () => {
    const p = plan(), prepared = modelInput(p, 'private'), records: ModelEvidence[] = [], id = randomUUID()
    const models = new ConfiguredModels({ connection: () => ({ generation: 1, updatedAt: new Date().toISOString(), connection: connection('https://unused.invalid/v1') }),
      credential: () => 'private-token', evidence: () => undefined, saveEvidence: record => { records.push(structuredClone(record)) } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(reply()), { headers: { 'content-type': 'application/json' } })))
    await models.execute(p, prepared, id as any)
    const record = records.at(-1)!; expect(modelEvidenceSchema.safeParse(record).success).toBe(true)
    verifyEvidenceRequest(p, prepared, record)
    for (const field of ['inputTokens', 'outputTokens', 'providerModel', 'responseId', 'request']) {
      const bad: any = structuredClone(record)
      if (field === 'request') bad.request.state = 'different'
      else if (field === 'inputTokens' || field === 'outputTokens') bad.result.usage[field]++
      else bad.result[field] = 'invented'
      expect(() => verifyEvidenceRequest(p, prepared, bad)).toThrow('corrupt-evidence')
    }
  })
  it('propagates only an explicitly enabled recorded trace to the native endpoint', async () => {
    const server = await fixture(), records: ModelEvidence[] = [], config = { ...connection(server.endpoint), tracePropagation: 'w3c' as const }
    const models = new ConfiguredModels({ connection: () => ({ generation: 1, updatedAt: new Date().toISOString(), connection: config }),
      credential: () => 'private-token', evidence: () => undefined, saveEvidence: record => { records.push(structuredClone(record)) } })
    await models.execute(plan(), modelInput(plan(), 'private'), randomUUID() as any, undefined,
      { trace: runTrace.parse({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }) })
    const traceparent = '00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01'
    expect(server.requests[0]?.traceparent).toBe(traceparent); expect(records.every(record => record.traceparent === traceparent)).toBe(true)
    expect(records.at(-1)?.route.connection.protocol).toBe('systemone')
  })
  it('cancels a held native response after durable intent without retry or fallback', async () => {
    const entered = Promise.withResolvers<void>(), server = await fixture(() => { entered.resolve() })
    const { runtime } = await owner(connection(server.endpoint)), id = randomUUID(), yaml = JSON.stringify(source('jev', 3))
    const task = runtime.run(yaml, 'private', { id }); await entered.promise
    runtime.cancel(id, randomUUID(), 'fixture:operator')
    expect((await task).state.status).toBe('cancelled'); expect(server.requests).toHaveLength(1)
    expect((await runtime.run(yaml, 'private', { id })).state.status).toBe('cancelled'); expect(server.requests).toHaveLength(1)
  })
  it('times out a held native reply without initiating another transport try', async () => {
    const server = await fixture(() => {}), { runtime } = await owner(connection(server.endpoint)), value = source('jev', 3)
    value.spec.nodes.judge.config.execution.timeoutSeconds = 1
    await expect(runtime.run(JSON.stringify(value), 'private')).rejects.toMatchObject({ code: 'timeout' })
    expect(server.requests).toHaveLength(1)
  })
  it('refuses unsupported scalar state and oversized request before dispatch', async () => {
    const server = await fixture(), { runtime } = await owner(connection(server.endpoint)), value = source()
    value.spec.inputSchema = { type: 'number' }
    await expect(runtime.run(JSON.stringify(value), 42)).rejects.toMatchObject({ code: 'unsupported-settings' })
    await expect(runtime.run(JSON.stringify(source()), 'x'.repeat(100_000))).rejects.toMatchObject({ code: 'request-too-large' })
    expect(server.requests).toHaveLength(0)
  })
  it('refuses a native response beyond configured limits without persisting a fabricated result', async () => {
    const server = await fixture(response => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(' '.repeat(1100) + JSON.stringify(reply())) })
    const { runtime } = await owner({ ...connection(server.endpoint), maxResponseBytes: 1024 })
    await expect(runtime.run(JSON.stringify(source()), 'private')).rejects.toMatchObject({ code: 'response-too-large' })
    expect(server.requests).toHaveLength(1)
  })
})

import type { ModelCalls, ModelResult, ModelExecutionContext } from '../runtime/model-port.ts'
import { modelRequestPlan, type ModelNodePlan, type PreparedModelInput } from '../runtime/model-plan.ts'
import type { JevableAttemptId } from '../runtime/run-types.ts'
import type { ProviderPersistence } from './persistence.ts'
import { ProviderError } from './config.ts'
import { prepareModelWire } from './model-wire.ts'
import { MAX_MODEL_ATTEMPTS, type ModelEvidence } from './records.ts'
import { runTrace } from '../runtime/run-types.ts'
import { executeRetriedModel } from './retry-model.ts'
import { verifyEvidenceRequest } from './evidence-request.ts'
import { selectBaggage } from '../telemetry/baggage.ts'

/** OpenAI-compatible transport with immutable, secret-free request/response evidence in the private runtime store. */
export class ConfiguredModels implements ModelCalls {
  constructor(private readonly store: ProviderPersistence) {}

  async admit(node: ModelNodePlan) {
    this.store.signal?.throwIfAborted()
    const plan = modelRequestPlan(node)
    if (plan.connection.mode !== 'workspace') throw new ProviderError('unsupported-settings')
    const route = await this.store.connection(plan.connection.id)
    if (!route || route.connection.provider !== plan.provider) throw new ProviderError('missing-connection')
    if (!route.connection.allowedModels.includes(plan.model)) throw new ProviderError('model-not-allowed')
    if ((plan.responseFormat === 'systemone-v1') !== (route.connection.protocol === 'systemone')) throw new ProviderError('unsupported-settings')
    if (plan.responseFormat === 'systemone-v1') prepareModelWire(plan, { prompt: '""', systemPrompt: '' }, route.connection)
    if (!Number.isSafeInteger(plan.execution.maxAttempts) || plan.execution.maxAttempts < 1 || plan.execution.maxAttempts > MAX_MODEL_ATTEMPTS
      || plan.execution.timeoutSeconds > route.connection.maxTimeoutSeconds) throw new ProviderError('unsupported-settings')
    const authentication = route.connection.authentication
    if (authentication.kind === 'bearer' && !await this.store.credential(authentication.credentialRef)) throw new ProviderError('missing-credential')
    this.store.signal?.throwIfAborted()
    return { plan, route }
  }

  async execute(node: ModelNodePlan, input: PreparedModelInput, attemptId: JevableAttemptId, signal?: AbortSignal,
    context?: ModelExecutionContext): Promise<ModelResult> {
    // Clone/validate before any await; caller mutation cannot alter a later durable request.
    node = structuredClone(node); input = structuredClone(input)
    const parsedTrace = context === undefined ? undefined : runTrace.safeParse(context?.trace)
    if (parsedTrace && !parsedTrace.success) throw new ProviderError('invalid-config')
    const trace = parsedTrace?.data
    // Snapshot before awaits; the carrier is never part of durable ModelEvidence or retry seeds.
    let incomingBaggage: string | undefined
    try { incomingBaggage = context?.baggage } catch { /* Unreadable optional carrier is not admitted. */ }
    let startTry: ModelExecutionContext['startTry']
    let startBackoff: ModelExecutionContext['startBackoff']
    try { startTry = context?.startTry } catch { /* Optional diagnostics cannot fail execution. */ }
    try { startBackoff = context?.startBackoff } catch { /* Snapshot optional diagnostics before awaits, without granting dispatch authority. */ }
    const observerContext = trace ? { trace, ...(startTry ? { startTry } : {}), ...(startBackoff ? { startBackoff } : {}) } : undefined
    this.store.signal?.throwIfAborted()
    const existing = await this.store.evidence(attemptId)
    if (existing) {
      if (existing.result.status !== 'completed') throw new ProviderError('uncertain-attempt')
      await this.verify(node, attemptId, input, existing.result.output)
      return { output: existing.result.output, usage: existing.result.usage }
    }
    const { plan, route } = await this.admit(node), connection = route.connection
    const baggage = connection.tracePropagation === 'w3c' && trace
      ? selectBaggage(incomingBaggage, connection.baggageKeys ?? []) : undefined
    const wire = prepareModelWire(plan, input, connection), request = wire.request
    const body = JSON.stringify(request)
    if (Buffer.byteLength(body) > connection.maxRequestBytes) throw new ProviderError('request-too-large')
    const evidence: ModelEvidence = { schemaVersion: 1, attemptId, at: new Date().toISOString(), route,
      request: JSON.parse(body) as ModelEvidence['request'], result: { status: 'pending' },
      ...(trace ? { trace } : {}),
      ...(connection.tracePropagation === 'w3c' && trace ? { traceparent: `00-${trace.traceId}-${trace.spanId}-0${trace.traceFlags}` } : {}) }
    const credential = connection.authentication.kind === 'bearer'
      ? await this.store.credential(connection.authentication.credentialRef) : undefined
    if (connection.authentication.kind === 'bearer' && !credential) throw new ProviderError('missing-credential')
    if (plan.execution.maxAttempts > 1) return executeRetriedModel(this.store, plan, evidence, body, credential, signal, observerContext, wire, baggage)
    // No fetch can precede this acknowledged durable write, and no auth header is included in it.
    await this.store.saveEvidence(evidence)
    this.store.signal?.throwIfAborted()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), plan.execution.timeoutSeconds * 1000)
    const combined = AbortSignal.any([controller.signal, ...signal ? [signal] : [], ...this.store.signal ? [this.store.signal] : []])
    let result, response: Response | undefined
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: wire.accept }
      if (credential !== undefined) headers.authorization = `Bearer ${credential}`
      if (evidence.traceparent !== undefined) headers.traceparent = evidence.traceparent
      if (baggage !== undefined) headers.baggage = baggage
      response = await fetch(`${connection.endpoint}${wire.path}`, { method: 'POST', headers, body, redirect: 'manual', signal: combined })
      if (!response.ok) { await response.body?.cancel(); throw new ProviderError('http-error') }
      result = await wire.read(response)
    } catch (error) {
      // Ownership loss is a storage failure, not a retryable provider transport error.
      this.store.signal?.throwIfAborted()
      const failure = signal?.aborted ? new ProviderError('cancelled') : controller.signal.aborted ? new ProviderError('timeout')
        : error instanceof ProviderError ? error : new ProviderError('transport-error')
      const code = failure.code
      if (!['response-too-large', 'invalid-response', 'http-error', 'transport-error', 'timeout', 'cancelled'].includes(code)) throw failure
      await this.store.saveEvidence({ ...evidence, result: { status: 'failed', code: code as Extract<ModelEvidence['result'], { status: 'failed' }>['code'], at: new Date().toISOString() } })
      throw failure
    } finally {
      clearTimeout(timeout)
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => { /* Cleanup cannot change the retained outcome or trigger a retry. */ })
    }
    // A failed settlement write leaves a pending request. It must never become a retryable transport error.
    this.store.signal?.throwIfAborted()
    await this.store.saveEvidence({ ...evidence, result: { status: 'completed', ...result, at: new Date().toISOString() } })
    return { output: result.output, usage: result.usage }
  }

  /** Historical checks use the retained route, not today's provider permissions or credentials. */
  async recover(node: ModelNodePlan, attemptId: JevableAttemptId, input: PreparedModelInput): Promise<ModelResult> {
    node = structuredClone(node); input = structuredClone(input)
    this.store.signal?.throwIfAborted()
    const evidence = await this.store.evidence(attemptId)
    if (!evidence || evidence.result.status !== 'completed') throw new ProviderError('uncertain-attempt')
    if (evidence.attemptId !== attemptId) throw new ProviderError('corrupt-evidence')
    verifyEvidenceRequest(node, input, evidence)
    this.store.signal?.throwIfAborted()
    return structuredClone({ output: evidence.result.output, usage: evidence.result.usage })
  }

  /** Historical checks use the retained route, not today's provider permissions or credentials. */
  async verify(node: ModelNodePlan, attemptId: JevableAttemptId, input: PreparedModelInput, output: string): Promise<void> {
    const evidence = await this.store.evidence(attemptId)
    if (!evidence || evidence.attemptId !== attemptId || evidence.result.status !== 'completed' || evidence.result.output !== output) throw new ProviderError('corrupt-evidence')
    verifyEvidenceRequest(node, input, evidence)
  }
}

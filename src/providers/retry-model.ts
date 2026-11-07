import type { ModelRequestPlan } from '../runtime/model-plan.ts'
import { randomUUID } from 'node:crypto'
import type { ModelResult, ModelExecutionContext } from '../runtime/model-port.ts'
import type { ProviderPersistence } from './persistence.ts'
import { ProviderError } from './config.ts'
import { RETRYABLE_HTTP_STATUSES, type ModelEvidence, type RetryModelEvidence } from './records.ts'
import type { WireResult } from './openai-wire.ts'
import type { prepareModelWire } from './model-wire.ts'
import { observeModelTry } from './try-observation.ts'
import { observeModelBackoff } from './backoff-observation.ts'

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
  })
}
/** A server-requested delay never causes an earlier retry; a delay outside the remaining budget ends the attempt. */
export function modelRetryDelay(number: number, retryAfter: string | null, now = Date.now()) {
  const backoff = Math.min(2000, 100 * 2 ** (number - 1))
  if (!retryAfter) return backoff
  // Do not shorten a potentially valid but oversized server delay by ignoring it.
  if (retryAfter.length > 128) return Infinity
  const parsed = /^\d+$/u.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now
  return Number.isNaN(parsed) ? backoff : Math.max(backoff, Math.ceil(parsed))
}

/** Only a currently admitted call may advance retries. Restarts and execute() reentry never enter this loop. */
export async function executeRetriedModel(store: ProviderPersistence, plan: ModelRequestPlan,
  seed: Extract<ModelEvidence, { schemaVersion: 1 }>, body: string, credential: string | undefined,
  signal: AbortSignal | undefined, context: ModelExecutionContext | undefined, wire: ReturnType<typeof prepareModelWire>,
  baggage?: string): Promise<ModelResult> {
  const connection = seed.route.connection
  const firstId = randomUUID()
  let observation = observeModelTry(context, firstId, 1), dispatched = false
  let evidence: RetryModelEvidence = { ...seed, schemaVersion: 2,
    policy: { kind: 'transient-http-v1', ...plan.execution },
    tries: [{ id: firstId, number: 1, at: seed.at, ...(observation.trace ? { trace: observation.trace } : {}), result: { status: 'pending' } }], result: { status: 'pending' } }
  const save = async (next: RetryModelEvidence) => { await observation.scope(() => store.saveEvidence(structuredClone(next))); evidence = next; store.signal?.throwIfAborted() }
  try { await save(evidence) }
  catch (error) { observation.end({ outcome: 'commit-or-execution-failed', dispatched: false, settled: false }); throw error }
  const deadline = performance.now() + plan.execution.timeoutSeconds * 1000
  const timer = new AbortController(), timeout = setTimeout(() => timer.abort(), plan.execution.timeoutSeconds * 1000)
  const combined = AbortSignal.any([timer.signal, ...signal ? [signal] : [], ...store.signal ? [store.signal] : []])
  const failure = (error: unknown) => signal?.aborted ? new ProviderError('cancelled') : timer.signal.aborted ? new ProviderError('timeout')
    : error instanceof ProviderError ? error : new ProviderError('transport-error')
  try {
    for (;;) {
      let response: Response | undefined, result: WireResult | undefined, failed: ProviderError | undefined
      let httpStatus: number | undefined, retryAfter: string | null = null
      try {
        combined.throwIfAborted()
        const headers: Record<string, string> = { 'content-type': 'application/json', accept: wire.accept }
        if (credential !== undefined) headers.authorization = `Bearer ${credential}`
        if (evidence.traceparent !== undefined) headers.traceparent = evidence.traceparent
        if (baggage !== undefined) headers.baggage = baggage
        dispatched = true
        response = await fetch(`${connection.endpoint}${wire.path}`, { method: 'POST', headers, body, redirect: 'manual', signal: combined })
        if (!response.ok) {
          httpStatus = response.status; retryAfter = response.headers.get('retry-after')
          throw new ProviderError('http-error')
        }
        result = await wire.read(response)
      } catch (error) {
        store.signal?.throwIfAborted()
        failed = failure(error)
      } finally {
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {})
      }
      store.signal?.throwIfAborted()
      const at = new Date().toISOString(), current = evidence.tries.at(-1)!, number = current.number
      if (result) {
        const completed = { ...result, usage: { ...result.usage, tries: number } }
        await save({ ...evidence, tries: [...evidence.tries.slice(0, -1), { ...current, result: { status: 'completed', at } }],
          result: { status: 'completed', ...completed, at } })
        observation.end({ outcome: 'completed', dispatched, settled: true, httpStatus: response!.status })
        return { output: completed.output, usage: completed.usage }
      }
      if (!failed || !['response-too-large', 'invalid-response', 'http-error', 'transport-error', 'timeout', 'cancelled'].includes(failed.code))
        throw failed ?? new ProviderError('invalid-response')
      const code = failed.code as Extract<ModelEvidence['result'], { status: 'failed' }>['code']
      const delay = modelRetryDelay(number, retryAfter)
      const retry = code === 'http-error' && RETRYABLE_HTTP_STATUSES.some(status => status === httpStatus)
        && number < evidence.policy.maxAttempts && !combined.aborted && delay < deadline - performance.now()
      await save({ ...evidence, tries: [...evidence.tries.slice(0, -1), { ...current, result: { status: 'failed', code, at,
        ...(httpStatus === undefined || code !== 'http-error' ? {} : { httpStatus }), ...(retry ? { retryDelayMs: delay } : {}) } }],
        result: retry ? { status: 'pending' } : { status: 'failed', code, at } })
      observation.end({ outcome: code === 'cancelled' || code === 'timeout' ? code : 'failed', dispatched, settled: true,
        ...(httpStatus === undefined ? {} : { httpStatus }) })
      if (!retry) throw failed
      const backoff = observeModelBackoff(context, current.id, number, delay)
      try { await wait(delay, combined); combined.throwIfAborted(); backoff.end({ outcome: 'completed' }) }
      catch (error) {
        const outcome = store.signal?.aborted ? 'commit-or-execution-failed' : failure(error).code
        backoff.end({ outcome: outcome === 'cancelled' || outcome === 'timeout' || outcome === 'commit-or-execution-failed' ? outcome : 'failed' })
        store.signal?.throwIfAborted()
        const stopped = failure(error)
        // No new request intent exists for a cancellation/deadline during backoff.
        await save({ ...evidence, result: { status: 'failed', code: stopped.code as 'cancelled' | 'timeout', at: new Date().toISOString() } })
        throw stopped
      }
      const nextAt = new Date().toISOString()
      const nextId = randomUUID(); observation = observeModelTry(context, nextId, number + 1); dispatched = false
      const childTrace = observation.trace && !evidence.tries.some(attempt => attempt.trace?.spanId === observation.trace!.spanId) ? observation.trace : undefined
      await save({ ...evidence, tries: [...evidence.tries, { id: nextId, number: number + 1, at: nextAt,
        ...(childTrace ? { trace: childTrace } : {}), result: { status: 'pending' } }] })
    }
  } finally { observation.end({ outcome: 'commit-or-execution-failed', dispatched, settled: false }); clearTimeout(timeout) }
}

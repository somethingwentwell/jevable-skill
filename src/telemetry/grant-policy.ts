import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Attributes, type SpanContext, type Tracer } from '@opentelemetry/api'
import type { GrantPolicyAction, GrantPolicyObservation } from '../access/policy-observation.ts'

export const GRANT_POLICY_METRIC_LABELS = ['jevable.access.action', 'jevable.access.policy.outcome']

/** Policy evaluation is not a mutation receipt, lookup audit or permission to execute later. */
export function observeGrantPolicyDecision(tracer: Tracer, action: GrantPolicyAction, parent: SpanContext | undefined,
  settled: (attributes: Attributes, seconds: number, context: SpanContext, failed: boolean) => void): GrantPolicyObservation {
  const attributes: Attributes = { 'jevable.access.action': action }, started = performance.now()
  const span = tracer.startSpan('jevable.access.policy', { kind: SpanKind.INTERNAL, attributes },
    parent ? trace.setSpanContext(ROOT_CONTEXT, parent) : ROOT_CONTEXT)
  let ended = false
  return { end(outcome) {
    if (ended) return
    ended = true
    try {
      const seconds = Math.max(0, performance.now() - started) / 1000
      if (!['admitted', 'refused', 'failed'].includes(outcome) || !Number.isFinite(seconds)) { span.end(); return }
      const failed = outcome === 'failed', data = { ...attributes, 'jevable.access.policy.outcome': outcome,
        ...(failed ? { 'error.type': 'grant_policy_failed' } : {}) }
      span.setAttributes(data); if (failed) span.setStatus({ code: SpanStatusCode.ERROR })
      span.end(); settled(data, seconds, span.spanContext(), failed)
    } catch { /* Diagnostic failure never changes policy or its original error. */ }
  } }
}

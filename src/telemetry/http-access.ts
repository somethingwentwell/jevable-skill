import { ROOT_CONTEXT, SpanKind, SpanStatusCode, type Attributes, type SpanContext, type Tracer } from '@opentelemetry/api'
import type { HttpAccessStage, HttpAccessObservation } from '../http/access-observation.ts'

export const HTTP_ACCESS_METRIC_LABELS = ['jevable.http.access.stage', 'jevable.http.access.outcome']

/** Pre-authentication roots never adopt request headers, ambient context or baggage. */
export function observeHttpAccess(tracer: Tracer, stage: HttpAccessStage,
  settled: (attributes: Attributes, seconds: number, context: SpanContext, failed: boolean) => void): HttpAccessObservation {
  const attributes = { 'jevable.http.access.stage': stage }, started = performance.now()
  const span = tracer.startSpan('jevable.http.access', { kind: SpanKind.INTERNAL, attributes }, ROOT_CONTEXT)
  let ended = false
  return { traceContext() {
    try { const context = span.spanContext()
      return { traceId: context.traceId, spanId: context.spanId, traceFlags: context.traceFlags }
    } catch { return undefined }
  }, end(outcome) {
    if (ended) return
    ended = true
    try {
      const seconds = Math.max(0, performance.now() - started) / 1000
      if (!['admitted', 'refused', 'failed'].includes(outcome) || !Number.isFinite(seconds)) { span.end(); return }
      const failed = outcome === 'failed', data = { ...attributes, 'jevable.http.access.outcome': outcome,
        ...(failed ? { 'error.type': 'http_access_failed' } : {}) }
      span.setAttributes(data); if (failed) span.setStatus({ code: SpanStatusCode.ERROR })
      span.end(); settled(data, seconds, span.spanContext(), failed)
    } catch { /* Never change admission or its original error. */ }
  } }
}

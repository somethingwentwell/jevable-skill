import type { AsyncLocalStorage } from 'node:async_hooks'
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, TraceFlags, isSpanContextValid, trace, type Attributes, type Span, type SpanContext, type Tracer } from '@opentelemetry/api'
import { parseTraceParent } from './config.ts'

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH'])
const ROUTES = new Set(['/', '/v1/openapi.json', '/v1/capabilities', '/v1/health', '/v1/operations', '/v1/preview/bootstrap', '/v1/preview/operations', '/v1/preview/logout', '/v1/reviewer/decisions', '/v1/caller/operations', '/v1/caller/stream', '/v1/async-runs', '/v1/webhooks'])
export const HTTP_METRIC_LABELS = ['http.request.method', 'http.route', 'jevable.http.status_class', 'jevable.http.outcome']
export interface HttpRequestObservation {
  run<T>(parent: string | undefined, operation: () => T): T
  /** One owned quota observation, linked without starting/adopting an inbound parent. */
  linkRateAdmission?(context: SpanContext | undefined): void
  /** Optional response-only correlation, never an inbound parent or permission. */
  responseTraceparent?(): string | undefined
  end(status: number | undefined, finished: boolean): void
}

/** Owned request instrumentation, not ambient auto-instrumentation. Never retain raw request data. */
export function observeHttpRequest(tracer: Tracer, parents: AsyncLocalStorage<SpanContext | undefined>,
  method: string | undefined, path: string | undefined,
  settled: (attributes: Attributes, seconds: number, context: SpanContext, failed: boolean) => void,
  responseContext = false): HttpRequestObservation {
  const route = path && ROUTES.has(path) ? path
    : path && /^\/v1\/async-runs\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(path) ? '/v1/async-runs/{id}' : undefined
  const attributes: Attributes = { 'http.request.method': method && METHODS.has(method) ? method : '_OTHER',
    ...(route ? { 'http.route': route } : {}) }
  const startTime = Date.now(), started = performance.now()
  let span: Span | undefined, ended = false, rateContext: SpanContext | undefined
  // Defer construction until authenticated propagation is admitted, or create a root on rejection.
  // Its timestamp still covers header admission/body reading, not just operation dispatch.
  const start = (parent?: SpanContext) => span ??= tracer.startSpan('jevable.http.request', {
    kind: SpanKind.SERVER, startTime, attributes,
    ...(rateContext ? { links: [{ context: rateContext }] } : {}),
  }, parent ? trace.setSpanContext(ROOT_CONTEXT, parent) : ROOT_CONTEXT)
  return {
    linkRateAdmission(context) {
      // Fixed one-link bound; never retain traceState, baggage, custom getters or the source object.
      if (ended || span || rateContext || !context) return
      try {
        const { traceId, spanId, traceFlags } = context
        if (typeof traceId !== 'string' || typeof spanId !== 'string'
          || !/^(?!0{32}$)[a-f0-9]{32}$/u.test(traceId) || !/^(?!0{16}$)[a-f0-9]{16}$/u.test(spanId)
          || (traceFlags !== 0 && traceFlags !== 1)) return
        rateContext = { traceId, spanId, traceFlags }
      } catch { /* Best-effort correlation cannot affect admission. */ }
    },
    responseTraceparent() {
      if (!responseContext) return undefined
      try {
        // Called only when emitting headers. Admitted operations already started their
        // span; reads/refusals create an independent root, never adopt a request header.
        const context = start().spanContext()
        if (!isSpanContextValid(context)) return undefined
        return `00-${context.traceId}-${context.spanId}-${context.traceFlags & TraceFlags.SAMPLED ? '01' : '00'}`
      } catch { return undefined } // No diagnostic failure changes response or execution.
    },
    run<T>(parent: string | undefined, operation: () => T): T {
      const admitted = parseTraceParent(parent)
      let context: SpanContext | undefined = admitted
      try { if (!ended) context = start(admitted).spanContext() } catch { /* Diagnostic failure cannot authorize a retry. */ }
      return parents.run(context, operation)
    },
    end(status, finished) {
      if (ended) return
      ended = true
      try {
        const code = Number.isInteger(status) && status! >= 100 && status! <= 599 ? status : undefined
        const failed = !finished || (code !== undefined && code >= 500)
        const data = { ...attributes, ...(code === undefined ? {} : { 'http.response.status_code': code }),
          ...(rateContext ? { 'jevable.http.rate.trace_id': rateContext.traceId,
            'jevable.http.rate.span_id': rateContext.spanId, 'jevable.http.rate.sampled': Boolean(rateContext.traceFlags & TraceFlags.SAMPLED) } : {}),
          'jevable.http.status_class': code === undefined ? 'none' : `${Math.floor(code / 100)}xx`,
          'jevable.http.outcome': finished ? 'response-finished' : 'disconnected',
          ...(!finished ? { 'error.type': 'client_disconnected' } : code !== undefined && code >= 500 ? { 'error.type': String(code) } : {}) }
        const active = start()
        active.setAttributes(data)
        if (failed) active.setStatus({ code: SpanStatusCode.ERROR })
        active.end()
        settled(data, Math.max(0, performance.now() - started) / 1000, active.spanContext(), failed)
      } catch { /* Best-effort signals never change the HTTP response or durable execution. */ }
    },
  }
}

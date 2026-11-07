import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Attributes, type SpanContext, type Tracer } from '@opentelemetry/api'

export type GrantOperation = 'get' | 'page' | 'issue' | 'revoke'
export type GrantOperationOutcome = 'returned' | 'threw'
export const GRANT_OPERATIONS = new Set<GrantOperation>(['get', 'page', 'issue', 'revoke'])
export const GRANT_METRIC_LABELS = ['jevable.grant.operation', 'jevable.grant.outcome']
export interface GrantOperationObservation { end(outcome: GrantOperationOutcome): void }

/** Counts owned administrative API calls, never permission decisions or unique grant mutations. */
export function observeGrantOperation(tracer: Tracer, operation: GrantOperation, parent: SpanContext | undefined,
  settled: (attributes: Attributes, seconds: number, context: SpanContext, failed: boolean) => void): GrantOperationObservation {
  const attributes: Attributes = { 'jevable.grant.operation': operation }, started = performance.now()
  const span = tracer.startSpan('jevable.access.grant', { kind: SpanKind.INTERNAL, attributes },
    parent ? trace.setSpanContext(ROOT_CONTEXT, parent) : ROOT_CONTEXT)
  let ended = false
  return { end(outcome) {
    if (ended) return
    ended = true
    try {
      const failed = outcome === 'threw', seconds = Math.max(0, performance.now() - started) / 1000
      if (!Number.isFinite(seconds)) { span.end(); return }
      const data = { ...attributes, 'jevable.grant.outcome': outcome,
        ...(failed ? { 'error.type': 'grant_operation_threw' } : {}) }
      span.setAttributes(data); if (failed) span.setStatus({ code: SpanStatusCode.ERROR })
      span.end(); settled(data, seconds, span.spanContext(), failed)
    } catch { /* Diagnostics cannot replace an administrative result/error or trigger retry. */ }
  } }
}

/** Preserve synchronous reads and original values/errors; await only owned native Promise results. */
export function observeGrantCall<T>(begin: () => GrantOperationObservation | undefined, work: () => T): T {
  let observation: GrantOperationObservation | undefined
  try { observation = begin() } catch { /* A broken diagnostic hook is not an admission failure. */ }
  const end = (outcome: GrantOperationOutcome) => { try { observation?.end(outcome) } catch { /* Best effort only. */ } }
  try {
    const value = work()
    if (value instanceof Promise) return value.then(result => { end('returned'); return result }, error => { end('threw'); throw error }) as T
    end('returned'); return value
  } catch (error) { end('threw'); throw error }
}

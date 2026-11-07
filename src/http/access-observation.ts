import type { SpanContext } from '@opentelemetry/api'

/** Fixed transport predicates, not durable authorization or operation outcomes. */
export const HTTP_ACCESS_STAGES = ['headers', 'owner-key', 'preview-session', 'local-bootstrap',
  'grant-token-syntax', 'instance', 'protocol', 'release-pin', 'signed-webhook',
  'local-rate-requests', 'local-rate-controls', 'coordinated-rate-requests', 'coordinated-rate-controls'] as const
export type HttpAccessStage = typeof HTTP_ACCESS_STAGES[number]
export type HttpAccessOutcome = 'admitted' | 'refused' | 'failed'
export interface HttpAccessObservation {
  /** Diagnostic identity only; no inbound context or admission authority. */
  traceContext?(): SpanContext | undefined
  end(outcome: HttpAccessOutcome): void
}

/** Invoke the predicate exactly once. Diagnostic adapters cannot replace its result/error. */
export function httpAccessGuard<T>(observe: (() => HttpAccessObservation | undefined) | undefined,
  work: () => T, refused: (error: unknown) => boolean): T {
  let observation: HttpAccessObservation | undefined
  try { observation = observe?.() } catch { /* Diagnostics never grant or deny access. */ }
  const end = (outcome: HttpAccessOutcome) => { try { observation?.end(outcome) } catch { /* Best effort. */ } }
  try { const result = work(); end('admitted'); return result }
  catch (error) { let outcome: HttpAccessOutcome = 'failed'; try { if (refused(error)) outcome = 'refused' } catch { /* Preserve the original error. */ }
    end(outcome); throw error }
}

/** Explicit async boundary; await only the original operation, never a diagnostic callback. */
export async function httpAccessGuardAsync<T>(observe: (() => HttpAccessObservation | undefined) | undefined,
  work: () => Promise<T>, refused: (error: unknown) => boolean): Promise<T> {
  let observation: HttpAccessObservation | undefined
  try { observation = observe?.() } catch { /* Diagnostics never grant or deny access. */ }
  const end = (outcome: HttpAccessOutcome) => { try { observation?.end(outcome) } catch { /* Best effort. */ } }
  try { const result = await work(); end('admitted'); return result }
  catch (error) { let outcome: HttpAccessOutcome = 'failed'; try { if (refused(error)) outcome = 'refused' } catch { /* Preserve the original error. */ }
    end(outcome); throw error }
}

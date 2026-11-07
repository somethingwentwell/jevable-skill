import type { ModelBackoffObservation, ModelExecutionContext } from '../runtime/model-port.ts'

/** Wait diagnostics cannot authorize dispatch, change a budget or replace a persistence/transport outcome. */
export function observeModelBackoff(context: ModelExecutionContext | undefined, afterTryId: string, afterTryNumber: number, delayMs: number) {
  let observer: ModelBackoffObservation | undefined
  try { observer = context?.startBackoff?.({ afterTryId, afterTryNumber, delayMs }) } catch { /* Execution stays authoritative. */ }
  let ended = false
  return { end(result: Parameters<ModelBackoffObservation['end']>[0]) {
    if (ended) return
    ended = true
    try { observer?.end({ ...result }) } catch { /* No telemetry failure may cause replay or mask ownership loss. */ }
  } }
}

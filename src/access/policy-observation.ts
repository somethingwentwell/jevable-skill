import { WorkflowRuntimeError } from '../runtime/errors.ts'
import type { GrantAction } from './actions.ts'

export const GRANT_POLICY_ACTIONS = Object.freeze(['caller.start', 'caller.read', 'caller.control', 'caller.cancel', 'reviewer.approve', 'reviewer.reject', 'reviewer.custom'] as const)
export type GrantPolicyAction = typeof GRANT_POLICY_ACTIONS[number]
export type GrantPolicyOutcome = 'admitted' | 'refused' | 'failed'
export interface GrantPolicyObservation { end(outcome: GrantPolicyOutcome): void }
export type GrantPolicyObserver = (action: GrantPolicyAction) => GrantPolicyObservation | undefined

function label(action: GrantAction): GrantPolicyAction | undefined {
  if (action.kind === 'decision') return action.decision === 'approve' ? 'reviewer.approve' : action.decision === 'reject' ? 'reviewer.reject' : 'reviewer.custom'
  const value = `caller.${action.kind}`
  return GRANT_POLICY_ACTIONS.find(candidate => candidate === value)
}

/** Observe only the synchronous target-policy evaluation. Never replay it or authorize later dispatch. */
export function observeGrantPolicy<T>(action: GrantAction, begin: GrantPolicyObserver | undefined, work: () => T): T {
  let observation: GrantPolicyObservation | undefined
  try { if (begin) { const kind = label(action); if (kind) observation = begin(kind) } } catch { /* Diagnostic admission is independent. */ }
  const end = (outcome: GrantPolicyOutcome) => { try { observation?.end(outcome) } catch { /* Preserve the original policy result/error. */ } }
  try { const value = work(); end('admitted'); return value }
  catch (error) {
    let outcome: GrantPolicyOutcome = 'failed'
    try { if (error instanceof WorkflowRuntimeError && error.code === 'not-found') outcome = 'refused' } catch { /* No arbitrary error fields. */ }
    end(outcome); throw error
  }
}

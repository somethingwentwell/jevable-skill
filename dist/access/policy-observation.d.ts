import type { GrantAction } from './actions.ts';
export declare const GRANT_POLICY_ACTIONS: readonly ["caller.start", "caller.read", "caller.control", "caller.cancel", "reviewer.approve", "reviewer.reject", "reviewer.custom"];
export type GrantPolicyAction = typeof GRANT_POLICY_ACTIONS[number];
export type GrantPolicyOutcome = 'admitted' | 'refused' | 'failed';
export interface GrantPolicyObservation {
    end(outcome: GrantPolicyOutcome): void;
}
export type GrantPolicyObserver = (action: GrantPolicyAction) => GrantPolicyObservation | undefined;
/** Observe only the synchronous target-policy evaluation. Never replay it or authorize later dispatch. */
export declare function observeGrantPolicy<T>(action: GrantAction, begin: GrantPolicyObserver | undefined, work: () => T): T;

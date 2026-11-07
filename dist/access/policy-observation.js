import { WorkflowRuntimeError } from "../runtime/errors.js";
export const GRANT_POLICY_ACTIONS = Object.freeze(['caller.start', 'caller.read', 'caller.control', 'caller.cancel', 'reviewer.approve', 'reviewer.reject', 'reviewer.custom']);
function label(action) {
    if (action.kind === 'decision')
        return action.decision === 'approve' ? 'reviewer.approve' : action.decision === 'reject' ? 'reviewer.reject' : 'reviewer.custom';
    const value = `caller.${action.kind}`;
    return GRANT_POLICY_ACTIONS.find(candidate => candidate === value);
}
/** Observe only the synchronous target-policy evaluation. Never replay it or authorize later dispatch. */
export function observeGrantPolicy(action, begin, work) {
    let observation;
    try {
        if (begin) {
            const kind = label(action);
            if (kind)
                observation = begin(kind);
        }
    }
    catch { /* Diagnostic admission is independent. */ }
    const end = (outcome) => { try {
        observation?.end(outcome);
    }
    catch { /* Preserve the original policy result/error. */ } };
    try {
        const value = work();
        end('admitted');
        return value;
    }
    catch (error) {
        let outcome = 'failed';
        try {
            if (error instanceof WorkflowRuntimeError && error.code === 'not-found')
                outcome = 'refused';
        }
        catch { /* No arbitrary error fields. */ }
        end(outcome);
        throw error;
    }
}

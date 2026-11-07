/** Fixed transport predicates, not durable authorization or operation outcomes. */
export const HTTP_ACCESS_STAGES = ['headers', 'owner-key', 'preview-session', 'local-bootstrap',
    'grant-token-syntax', 'instance', 'protocol', 'release-pin', 'signed-webhook',
    'local-rate-requests', 'local-rate-controls', 'coordinated-rate-requests', 'coordinated-rate-controls'];
/** Invoke the predicate exactly once. Diagnostic adapters cannot replace its result/error. */
export function httpAccessGuard(observe, work, refused) {
    let observation;
    try {
        observation = observe?.();
    }
    catch { /* Diagnostics never grant or deny access. */ }
    const end = (outcome) => { try {
        observation?.end(outcome);
    }
    catch { /* Best effort. */ } };
    try {
        const result = work();
        end('admitted');
        return result;
    }
    catch (error) {
        let outcome = 'failed';
        try {
            if (refused(error))
                outcome = 'refused';
        }
        catch { /* Preserve the original error. */ }
        end(outcome);
        throw error;
    }
}
/** Explicit async boundary; await only the original operation, never a diagnostic callback. */
export async function httpAccessGuardAsync(observe, work, refused) {
    let observation;
    try {
        observation = observe?.();
    }
    catch { /* Diagnostics never grant or deny access. */ }
    const end = (outcome) => { try {
        observation?.end(outcome);
    }
    catch { /* Best effort. */ } };
    try {
        const result = await work();
        end('admitted');
        return result;
    }
    catch (error) {
        let outcome = 'failed';
        try {
            if (refused(error))
                outcome = 'refused';
        }
        catch { /* Preserve the original error. */ }
        end(outcome);
        throw error;
    }
}

import { WorkflowRuntimeError } from "../runtime/errors.js";
const denied = () => new WorkflowRuntimeError('not-found');
/** This projection accepts only an already authenticated, live grant principal
 * and a separately verified retained run. It is not grant authentication.
 * Keep it before any private reviewer response or delegated execution.
 */
export function assertReviewerRelease(principal, run, release) {
    const scope = principal.scope;
    if (scope.kind !== 'reviewer' || scope.runId !== run.id || scope.revision !== run.revision
        || run.revision !== release.revision || run.release?.id !== release.id || run.release.sha256 !== release.sha256)
        throw denied();
}
/** Only the exact still-waiting request, never workflow source, input, steps,
 * output, other inbox entries, credential names or the owner's authority.
 * The caller must reauthenticate the grant after any awaited read.
 */
export function releaseReviewerRequest(principal, run, release, actions, at = new Date().toISOString()) {
    assertReviewerRelease(principal, run, release);
    const scope = principal.scope, state = run.state, time = Date.parse(at);
    if (scope.kind !== 'reviewer' || !Number.isFinite(time) || state.status !== 'waiting' || run.cancellation
        || state.attempt.id !== scope.attemptId || state.attempt.prepared.status !== 'ready'
        || Date.parse(principal.expiresAt) <= time || Date.parse(state.expiresAt) <= time
        || state.scope && (run.loopDeadlines[state.scope.loop] === undefined || run.loopDeadlines[state.scope.loop] <= time)
        || !scope.decisions.length || scope.decisions.some(action => !actions.includes(action)))
        throw denied();
    return { schemaVersion: 1, release: { ...release }, runId: run.id, attemptId: state.attempt.id,
        nodeId: state.next, expiresAt: new Date(Math.min(Date.parse(principal.expiresAt), Date.parse(state.expiresAt), ...(state.scope ? [run.loopDeadlines[state.scope.loop]] : []))).toISOString(),
        actions: [...scope.decisions], review: state.attempt.prepared.input };
}

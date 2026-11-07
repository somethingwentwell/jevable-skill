import type { GrantPrincipal } from '../access/grants.ts';
import type { LocalRun } from '../runtime/run-types.ts';
export interface ReleaseReviewerPin {
    id: string;
    sha256: string;
    revision: string;
    version: string;
}
/** This projection accepts only an already authenticated, live grant principal
 * and a separately verified retained run. It is not grant authentication.
 * Keep it before any private reviewer response or delegated execution.
 */
export declare function assertReviewerRelease(principal: GrantPrincipal, run: LocalRun, release: ReleaseReviewerPin): void;
/** Only the exact still-waiting request, never workflow source, input, steps,
 * output, other inbox entries, credential names or the owner's authority.
 * The caller must reauthenticate the grant after any awaited read.
 */
export declare function releaseReviewerRequest(principal: GrantPrincipal, run: LocalRun, release: ReleaseReviewerPin, actions: readonly string[], at?: string): {
    schemaVersion: 1;
    release: {
        id: string;
        sha256: string;
        revision: string;
        version: string;
    };
    runId: string;
    attemptId: import("../runtime/run-types.ts").JevableAttemptId;
    nodeId: import("../index.ts").NodeId;
    expiresAt: string;
    actions: string[];
    review: import("../index.ts").JsonValue;
};

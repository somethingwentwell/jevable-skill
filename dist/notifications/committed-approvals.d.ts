import type { LocalRun } from '../runtime/run-types.ts';
import { type ApprovalNotificationEvent } from './schema.ts';
import { type AutomaticApprovalPlan } from './automatic-policy.ts';
type Journal = readonly {
    kind: string;
    at: string;
    data: unknown;
}[];
export interface CommittedApprovalCandidate {
    event: ApprovalNotificationEvent;
    plan: AutomaticApprovalPlan;
}
export interface ApprovalCaptureFault {
    code: 'corrupt' | 'conflict' | 'invalid-command' | 'limit';
    runId: string;
    transition: string;
}
/** Internal post-commit bridge only. No transport, credentials, durable admission or public automatic-delivery feature. */
export declare class CommittedApprovalCapture {
    private readonly maxCandidates;
    private readonly policy;
    private readonly destinations;
    private readonly candidates;
    private fault;
    constructor(policy: unknown, destinations: unknown, maxCandidates?: number);
    /** Synchronous and nonthrowing: a diagnostic must never turn an acknowledged workflow commit into a failure. */
    committed(run: LocalRun, events: Journal, transition: string, data: unknown): void;
    /** Storage observation failed after commit. Retain only safe diagnostics; never repair or undo the run. */
    refused(runId: string, transition: string, code?: ApprovalCaptureFault['code']): void;
    /** Read-only, detached and explicitly not a durable delivery receipt. A fault latches admission closed. */
    snapshot(): {
        semantics: "process-local-candidates; no-durable-admission; no-dispatch";
        fault?: ApprovalCaptureFault;
        candidates: CommittedApprovalCandidate[];
    };
}
export {};

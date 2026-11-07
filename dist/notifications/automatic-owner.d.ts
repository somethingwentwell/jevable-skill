import type { LocalRun } from '../runtime/run-types.ts';
import { type ApprovalCaptureFault } from './committed-approvals.ts';
import { type AutomaticAdmissionRecord, type AutomaticFailureCode } from './automatic-admission.ts';
import type { ApprovalNotificationDispatcher } from './dispatcher.ts';
export interface CommittedApprovalObserver {
    committed(run: LocalRun, events: readonly {
        kind: string;
        at: string;
        data: unknown;
    }[], transition: string, data: unknown): void | Promise<void>;
    refused(runId: string, transition: string, code?: ApprovalCaptureFault['code']): void;
}
interface AdmissionPersistence {
    create(record: AutomaticAdmissionRecord): boolean | Promise<boolean>;
    settle(record: AutomaticAdmissionRecord): void | Promise<void>;
}
/** Internal live-commit owner, not a recovered outbox. Only acknowledged *new* reservations can launch a send. */
export declare class AutomaticApprovalOwner implements CommittedApprovalObserver {
    private readonly persistence;
    private readonly dispatcher;
    private readonly maxPending;
    private readonly policy;
    private readonly destinations;
    private readonly tasks;
    private readonly admissions;
    private reservations;
    private sealed;
    private fault;
    constructor(policy: unknown, persistence: AdmissionPersistence, dispatcher: Pick<ApprovalNotificationDispatcher, 'destinations' | 'send'>, maxPending?: number);
    busy(): boolean;
    snapshot(): {
        semantics: "live-commits-only; no-replay; failure-is-not-proof-of-no-effect";
        fault?: {
            code: AutomaticFailureCode;
            requestId?: string;
            runId?: string;
            transition?: string;
        };
        pending: number;
        admitting: number;
        active: number;
        sealed: boolean;
    };
    refused(runId: string, transition: string, failure?: ApprovalCaptureFault['code']): void;
    private failed;
    committed(run: LocalRun, events: readonly {
        kind: string;
        at: string;
        data: unknown;
    }[], transition: string, data: unknown): void | Promise<void>;
    private launch;
    /** Caller seals workflow admission first. Do not abort an accepted external effect or close owned credentials early. */
    drain(): Promise<void>;
}
export {};

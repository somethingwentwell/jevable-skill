import { type LocalRun } from './run-types.ts';
import { ProviderStore } from '../providers/store.ts';
import { ProjectStore } from '../projects/store.ts';
import { ReleaseStore } from '../releases/store.ts';
import { TestStore } from '../testing/store.ts';
import type { RetainedRunMetrics } from './retained-metrics.ts';
import { SQLiteNotificationStore } from '../notifications/sqlite-store.ts';
import { SQLiteGrantStore } from '../access/sqlite-grants.ts';
import { type CallerControlRequest } from '../access/caller-control.ts';
import { type CallerCancellationRequest } from '../access/caller-cancellation.ts';
import type { GrantPrincipal } from '../access/grants.ts';
import type { GrantPolicyObserver } from '../access/policy-observation.ts';
import { type ReviewerDecisionRequest } from '../access/reviewer.ts';
import { type ReviewerTraceObservation } from './reviewer.ts';
import type { CompiledWorkflow, WorkflowCompilerLimits } from '../workflow/index.ts';
import type { SQLiteStatementStatistics } from '../storage/sqlite-statistics.ts';
import { SQLiteAutomaticAdmissionStore } from '../notifications/automatic-sqlite-store.ts';
import { type AutomaticAdmissionLimits } from '../notifications/automatic-admission.ts';
/** Private single-process SQLite store. A crash leaves a lock requiring explicit operator inspection. */
export declare class RunStore {
    private readonly db;
    private readonly lock;
    readonly directory: string;
    private readonly maxRuns;
    private readonly maxRecordBytes;
    private closed;
    private retainedMetrics;
    private grantPolicyObserver;
    private approvalCapture;
    /** Internal source bridge; attach explicitly before live writes, never scan retained history. */
    observeCommittedApprovals(capture: NonNullable<RunStore['approvalCapture']>): void;
    private captureApproval;
    observeGrantPolicy(observer: GrantPolicyObserver): void;
    observeRetainedState(metrics: RetainedRunMetrics): void;
    readonly providers: ProviderStore;
    private constructor();
    static open(directory: string, policy: {
        maxRuns: number;
        maxRecordBytes: number;
    }, sqliteStatements?: SQLiteStatementStatistics): Promise<RunStore>;
    private assertOpen;
    /** Internal opt-in schema capability. Omitted capability keeps schema 18; schema 19 is never downgraded or repaired. */
    automaticAdmissionStore(limits: AutomaticAdmissionLimits, initialize?: boolean): SQLiteAutomaticAdmissionStore;
    /** Read-only startup validation of retained automatic evidence even when live policy is omitted. */
    validateAutomaticAdmissions(): SQLiteAutomaticAdmissionStore | undefined;
    releaseStore(): ReleaseStore;
    grantStore(): SQLiteGrantStore;
    notificationStore(policy: {
        maxDeliveries: number;
        maxEvents: number;
    }): SQLiteNotificationStore;
    testStore(limits: import('../workflow/index.ts').WorkflowCompilerLimits): TestStore;
    projectStore(limits: import('../workflow/index.ts').WorkflowLimits): ProjectStore;
    get(id: string): LocalRun | undefined;
    exists(id: string): boolean;
    /** Filter in SQL before loading payloads: an unrelated run is indistinguishable from an absent run. */
    getCaller(id: string, principal: GrantPrincipal): LocalRun | undefined;
    ids(): string[];
    /** Keyset admission reads only limit + 1 identifiers, never every retained run payload. */
    idPage(after?: string, limit?: number): {
        ids: string[];
        nextCursor: string | null;
    };
    /** Indexed exact-release keyset page. Foreign records are not decoded into application memory. */
    releaseIdPage(value: {
        id: string;
        sha256: string;
        revision: string;
    }, after?: string, limit?: number): {
        ids: string[];
        nextCursor: string | null;
    };
    /** Commit a snapshot and its evidence event together before acknowledging a transition. */
    save(record: LocalRun, kind: string, data?: unknown): void;
    private writeInTransaction;
    /** Recheck the actual retained grant and release in the same transaction as immutable creation evidence. */
    saveCallerCreation(value: LocalRun, token: string): LocalRun;
    /** Caller control intent and writer-derived attribution share a transaction. No execution or recovery here. */
    saveCallerControl(token: string, id: string, value: CallerControlRequest, checked: (record: LocalRun) => CompiledWorkflow, limits: WorkflowCompilerLimits): {
        record: LocalRun;
        admitted: boolean;
    };
    /** Caller-only cancellation admission and evidence share one transaction. Historical retries only observe. */
    saveCallerCancellation(token: string, id: string, value: CallerCancellationRequest, checked: (record: LocalRun) => unknown, parent?: () => import('./run-types.ts').JevableRunTrace | undefined): {
        record: LocalRun;
        admitted: boolean;
    };
    /** Recheck current grant and wait in the same writer transaction; clients never supply the target or actor. */
    saveReviewerDecision(token: string, value: ReviewerDecisionRequest, checked: (record: LocalRun) => CompiledWorkflow, limits: WorkflowCompilerLimits, observe?: (record: LocalRun) => ReviewerTraceObservation | undefined): {
        record: LocalRun;
        data: {
            pauseAfter?: true;
            routes: {
                scope?: {
                    loop: import("../workflow/types.ts").NodeId;
                    index: number;
                };
                stepIndex: number;
                nodeId: import("../workflow/types.ts").NodeId;
                port: string;
            }[];
            scope?: import("./run-evaluator.ts").LoopScope;
            segment?: {
                operation: "cancel" | "approval" | "run" | "resume";
                at: string;
                trace: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                };
                previous?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                } | undefined;
                parent?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                } | undefined;
                cause?: {
                    kind: "cancellation";
                    requestId: string;
                    parent: {
                        traceId: import("./run-trace.ts").JevableTraceId;
                        spanId: import("./run-trace.ts").JevableSpanId;
                        traceFlags: 0 | 1;
                    };
                } | undefined;
            };
            attemptId: import("./run-types.ts").JevableAttemptId;
            nodeId: import("../workflow/types.ts").NodeId;
            decision: {
                kind: "action";
                action: string;
                actor: string;
                at: string;
                delegation: {
                    requestId: string;
                    grantId: string;
                    scope: {
                        kind: "reviewer";
                        runId: string;
                        attemptId: string;
                        revision: string;
                        decisions: string[];
                    };
                    deadline: string;
                    pauseAfter: boolean;
                };
            };
        };
        decision: {
            kind: "action";
            action: string;
            actor: string;
            at: string;
            delegation: {
                requestId: string;
                grantId: string;
                scope: {
                    kind: "reviewer";
                    runId: string;
                    attemptId: string;
                    revision: string;
                    decisions: string[];
                };
                deadline: string;
                pauseAfter: boolean;
            };
        };
    };
    events(id: string): {
        data: unknown;
        sequence: number;
        kind: string;
        at: string;
    }[];
    eventSize(id: string): {
        count: number;
        bytes: number;
    };
    close(): Promise<void>;
}

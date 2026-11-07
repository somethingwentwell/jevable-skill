import { type AsyncRun, type AsyncRunOptions } from './async-run.ts';
import { z } from 'zod';
import { type WorkflowCompilerLimits } from '../workflow/index.ts';
import { type LocalRun } from './run-types.ts';
import { type ExecutionControl, type RunStartOptions } from './control.ts';
import { type CallerCancellationRequest, type CallerCancellationReceipt } from '../access/caller-cancellation.ts';
import { type CallerControlRequest, type CallerControlCheckpoint, type CallerControlReceipt } from '../access/caller-control.ts';
import type { ModelCalls } from './model-port.ts';
import { type ModelDiscoveryOptions } from '../providers/discovery.ts';
import type { ProjectCommand } from '../projects/store.ts';
import type { VendorImportCommand } from '../projects/vendor-import.ts';
import { type ReleaseCreateCommand, type Release } from '../releases/snapshot.ts';
import { type TraceRequestContext } from '../telemetry/baggage.ts';
import { type TelemetryConfig } from '../telemetry/config.ts';
import { type TestCommand, type TestIdentity } from '../testing/schema.ts';
import type { TestErasureRequest } from '../testing/erasure-write.ts';
import type { GenerateTestsRequest } from '../testing/generation-schema.ts';
import { type NotificationRuntimeConfig } from '../notifications/config.ts';
import { type ApprovalNotificationPin, type NotificationRequest, type NotificationRecord } from '../notifications/schema.ts';
import type { AutomaticAdmissionRecord } from '../notifications/automatic-admission.ts';
import { type AutomaticAdmissionPage } from '../notifications/automatic-admission.ts';
import { type NotificationPageRequest } from '../notifications/history.ts';
import { type NotificationReleaseScope } from '../notifications/release-history.ts';
import { type NotificationProjectScope } from '../notifications/project-history.ts';
import type { GrantIssue, GrantRevoke, GrantPageRequest, GrantPrincipal } from '../access/grants.ts';
import { type CallerStartOptions, type CallerRunReceipt, type CallerRunResult } from '../access/caller.ts';
import { type ReviewerDecisionRequest, type ReviewerDecisionReceipt } from '../access/reviewer.ts';
import { type ReleaseReviewerPin } from '../releases/reviewer.ts';
export interface LocalRuntimeOptions {
    dataDirectory: string;
    compilerLimits?: WorkflowCompilerLimits;
    models?: ModelCalls;
    maxRuns?: number;
    maxRecordBytes?: number;
    maxTransitionsPerRun?: number;
    telemetry?: TelemetryConfig;
    notifications?: NotificationRuntimeConfig;
    /** Trusted exact-release startup import for reviewed automatic policy. Not a run or local approval. */
    startupRelease?: Release;
}
/** SDK host for the extracted evaluator; persistence and lifecycle do not involve an agent or UI. */
export declare class LocalRuntime {
    private readonly store;
    private readonly limits;
    private readonly maxTransitions;
    private readonly notificationPolicy;
    private readonly models?;
    private telemetry?;
    private readonly retainedMetrics?;
    private lifecycle;
    private pendingOperations;
    private readonly flushes;
    private closing;
    private readonly active;
    private readonly creatingCallers;
    private readonly controllers;
    private readonly notifications;
    private readonly notificationStore;
    private automaticNotifications;
    private automaticAdmissionLedger;
    private readonly ownedNotificationReads;
    /** Startup attachment only, after verified scopes. Never scan retained history. */
    private enableAutomaticNotifications;
    private constructor();
    static open(options: LocalRuntimeOptions): Promise<LocalRuntime>;
    private assertOpen;
    /** Trusted owner SDK administration only; these records do not enable delegated HTTP access. */
    private grantOperation;
    grant(id: string): import("../access/grants.ts").GrantMetadata;
    grants(page?: GrantPageRequest): import("../access/grants.ts").GrantPage;
    issueGrant(command: GrantIssue): Promise<import("../access/grants.ts").GrantMetadata>;
    revokeGrant(command: GrantRevoke): Promise<import("../access/grants.ts").GrantMetadata>;
    /** Includes readiness and retained-evidence reads, not just active workflow execution. */
    private operation;
    private checked;
    show(id: string): Promise<LocalRun>;
    private notificationRun;
    /** Checked owner-internal read; admitted notification drain may use it after public admission is sealed. */
    private readOwnedRun;
    activityReport(): Promise<{
        schemaVersion: 1;
        storage: "sqlite" | "postgres";
        observedAt: string;
        scope: "selected-owner-retained-data";
        consistency: "single-owner-coherent-observation";
        projects: {
            total: number;
            active: number;
            archived: number;
            origins: {
                authored: number;
                duplicated: number;
                projectBundle: number;
                vendor: number;
            };
        };
        proposals: {
            total: number;
            pending: number;
            accepted: number;
            rejected: number;
            importedHistory: number;
            localActions: {
                proposed: number;
                accepted: number;
                rejected: number;
            };
        };
        imports: {
            projectBundle: number;
            vendor: number;
            basis: "retained-project-origin";
        };
        runs: {
            total: number;
            byStatus: {
                paused: number;
                executing: number;
                waiting: number;
                completed: number;
                failed: number;
                cancelled: number;
            };
            links: {
                project: number;
                release: number;
                unlinked: number;
            };
            triggerSelection: {
                api: number;
                defaultLocal: number;
            };
            firstRetainedRun: {
                id: string;
                revision: string;
                createdAt: string;
                status: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
            } | null;
        };
        privacy: "counts-and-first-run-identifiers; no-payloads-actors-or-credentials";
        execution: "not-started-resumed-approved-or-cancelled";
        billing: false;
        lifetimeTotals: false;
    }>;
    list(): {
        test?: {
            id: string;
            generation: number;
            sha256: string;
        };
        release?: {
            id: string;
            sha256: string;
        };
        project?: {
            id: string;
            generation: number;
        };
        triggerMode?: import("./trigger.ts").ApiTriggerMode;
        id: string;
        revision: string;
        status: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
        createdAt: string;
        updatedAt: string;
    }[];
    /** Bounded metadata page; retains the legacy unpaged list() contract separately. */
    listPage(after?: string, limit?: number): {
        runs: {
            test?: {
                id: string;
                generation: number;
                sha256: string;
            };
            release?: {
                id: string;
                sha256: string;
            };
            project?: {
                id: string;
                generation: number;
            };
            triggerMode?: import("./trigger.ts").ApiTriggerMode;
            id: string;
            revision: string;
            status: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
            createdAt: string;
            updatedAt: string;
        }[];
        nextCursor: string | null;
    };
    /** Exact-release metadata only; explicit pages do not load unrelated retained run payloads. */
    listReleasePage(pin: {
        id: string;
        sha256: string;
        revision: string;
    }, after?: string, limit?: number): {
        runs: {
            test?: {
                id: string;
                generation: number;
                sha256: string;
            };
            release?: {
                id: string;
                sha256: string;
            };
            project?: {
                id: string;
                generation: number;
            };
            triggerMode?: import("./trigger.ts").ApiTriggerMode;
            id: string;
            revision: string;
            status: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
            createdAt: string;
            updatedAt: string;
        }[];
        nextCursor: string | null;
    };
    private metadataPage;
    /** Inspect actual policy and credentials without running nodes or contacting a model. */
    check(yaml: string, triggerMode?: 'api'): Promise<{
        triggerMode?: import("./trigger.ts").ApiTriggerMode;
        schemaVersion: 1;
        status: "invalid";
        runtimeReadiness: "not-checked";
        execution: "not-run";
        diagnostics: {
            code: string;
            message: string;
        }[];
        revision?: never;
        compilerVersion?: never;
        nodeCount?: never;
    } | {
        runtimeReadiness: "ready";
        triggerMode?: import("./trigger.ts").ApiTriggerMode;
        schemaVersion: 1;
        status: "valid";
        revision: import("../workflow/types.ts").RevisionHash;
        compilerVersion: "jevable-compiler/v1alpha1";
        nodeCount: number;
        execution: "not-run";
        diagnostics: never[];
    } | {
        runtimeReadiness: "unavailable";
        diagnostics: {
            code: "invalid-command" | "not-found" | "conflict" | "archived" | "referenced" | "limit" | "busy" | "corrupt" | "closed" | "invalid-config" | "missing-connection" | "model-not-allowed" | "missing-credential" | "unsupported-settings" | "request-too-large" | "response-too-large" | "invalid-response" | "http-error" | "transport-error" | "timeout" | "cancelled" | "uncertain-attempt" | "corrupt-evidence";
            message: string;
        }[];
        triggerMode?: import("./trigger.ts").ApiTriggerMode;
        schemaVersion: 1;
        status: "valid";
        revision: import("../workflow/types.ts").RevisionHash;
        compilerVersion: "jevable-compiler/v1alpha1";
        nodeCount: number;
        execution: "not-run";
    }>;
    connections(): {
        generation: number;
        updatedAt: string;
        connection: {
            protocol: "openai-compatible";
            tokenParameter: "max_tokens" | "max_completion_tokens";
            maxStreamEvents: number;
            id: string;
            provider: string;
            endpoint: string;
            allowedModels: string[];
            authentication: {
                kind: "bearer";
                credentialRef: string;
            } | {
                kind: "none";
            };
            maxResponseBytes: number;
            maxRequestBytes: number;
            maxTimeoutSeconds: number;
            tracePropagation?: "none" | "w3c" | undefined;
            baggageKeys?: string[] | undefined;
        } | {
            protocol: "systemone";
            provider: "jev" | "laya";
            id: string;
            endpoint: string;
            allowedModels: string[];
            authentication: {
                kind: "bearer";
                credentialRef: string;
            } | {
                kind: "none";
            };
            maxResponseBytes: number;
            maxRequestBytes: number;
            maxTimeoutSeconds: number;
            tracePropagation?: "none" | "w3c" | undefined;
            baggageKeys?: string[] | undefined;
        };
    }[];
    discoverModels(id: string, options?: ModelDiscoveryOptions): Promise<{
        schemaVersion: 1;
        connection: {
            id: string;
            generation: number;
            provider: string;
            protocol: "openai-compatible";
        };
        observedAt: string;
        models: {
            id: string;
            allowed: boolean;
        }[];
        permissions: "unchanged";
        scope: "advisory-provider-list; not-execution-readiness";
    }>;
    notificationDestinations(): {
        id: string;
        endpointSha256: string;
    }[];
    /** Metadata only. Configured policy does not grant approval, redelivery or recovery authority. */
    automaticApprovalNotificationStatus(): {
        live: {
            semantics: "live-commits-only; no-replay; failure-is-not-proof-of-no-effect";
            fault?: {
                code: import("../notifications/automatic-admission.ts").AutomaticFailureCode;
                requestId?: string;
                runId?: string;
                transition?: string;
            };
            pending: number;
            admitting: number;
            active: number;
            sealed: boolean;
        } | null;
        policySha256?: string;
        routeCount?: number;
        schemaVersion: 1;
        configured: boolean;
    };
    automaticApprovalAdmissions(page?: AutomaticAdmissionPage): Promise<{
        records: AutomaticAdmissionRecord[];
        nextCursor: string | null;
    }>;
    automaticApprovalAdmission(requestId: string): Promise<AutomaticAdmissionRecord>;
    prepareApprovalNotification(pin: ApprovalNotificationPin, endpointId: string): Promise<{
        endpointId: string;
        endpointSha256: string;
        eventSha256: string;
        event: {
            specversion: "1.0";
            id: string;
            source: "urn:jevable:workflow-runtime";
            type: "ai.jevable.approval.requested" | "ai.jevable.approval.decided" | "ai.jevable.approval.expired" | "ai.jevable.approval.cancelled";
            time: string;
            datacontenttype: "application/json";
            data: {
                runId: string;
                revision: string;
                attemptId: string;
                nodeId: string;
                expiresAt: string;
                scope?: {
                    loop: import("../workflow/types.ts").NodeId;
                    index: number;
                } | undefined;
                loopExpiresAt?: string | undefined;
                release?: {
                    id: string;
                    sha256: string;
                } | undefined;
                project?: {
                    id: string;
                    generation: number;
                } | undefined;
            };
        };
        delivery: "not-attempted";
        runId: string;
        revision: string;
        attemptId: string;
        eventKind?: "cancelled" | "expired" | "requested" | "decided" | undefined;
    }>;
    inspectApprovalNotification(requestId: string): Promise<{
        semantics: "pending-is-not-proof-of-dispatch; HTTP-acceptance-is-not-human-delivery-or-approval";
        schemaVersion: 1;
        request: {
            runId: string;
            revision: string;
            attemptId: string;
            requestId: string;
            endpointId: string;
            endpointSha256: string;
            eventSha256: string;
            eventKind?: "cancelled" | "expired" | "requested" | "decided" | undefined;
            redeliverOf?: string | undefined;
        };
        event: {
            specversion: "1.0";
            id: string;
            source: "urn:jevable:workflow-runtime";
            type: "ai.jevable.approval.requested" | "ai.jevable.approval.decided" | "ai.jevable.approval.expired" | "ai.jevable.approval.cancelled";
            time: string;
            datacontenttype: "application/json";
            data: {
                runId: string;
                revision: string;
                attemptId: string;
                nodeId: string;
                expiresAt: string;
                scope?: {
                    loop: import("../workflow/types.ts").NodeId;
                    index: number;
                } | undefined;
                loopExpiresAt?: string | undefined;
                release?: {
                    id: string;
                    sha256: string;
                } | undefined;
                project?: {
                    id: string;
                    generation: number;
                } | undefined;
            };
        };
        createdAt: string;
        credentialGeneration: number;
        outcome: {
            status: "pending";
        } | {
            status: "settled";
            at: string;
            result: {
                status: "accepted";
                httpStatus: number;
            } | {
                status: "rejected";
                httpStatus: number;
            } | {
                status: "uncertain";
                reason: "invalid-response" | "timeout" | "transport" | "aborted";
            };
        };
        telemetry?: {
            trace: {
                traceId: import("./run-trace.ts").JevableTraceId;
                spanId: import("./run-trace.ts").JevableSpanId;
                traceFlags: 0 | 1;
            };
            workflow?: {
                traceId: import("./run-trace.ts").JevableTraceId;
                spanId: import("./run-trace.ts").JevableSpanId;
                traceFlags: 0 | 1;
            } | undefined;
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
        } | undefined;
    }>;
    abortApprovalNotification(requestId: string): Promise<{
        schemaVersion: 1;
        requestId: string;
        status: "abort-requested" | "not-active";
        receipt: {
            request: {
                runId: string;
                revision: string;
                attemptId: string;
                requestId: string;
                endpointId: string;
                endpointSha256: string;
                eventSha256: string;
                eventKind?: "cancelled" | "expired" | "requested" | "decided" | undefined;
                redeliverOf?: string | undefined;
            };
            schemaVersion: 1;
            createdAt: string;
            event: {
                specversion: "1.0";
                id: string;
                source: "urn:jevable:workflow-runtime";
                type: "ai.jevable.approval.requested" | "ai.jevable.approval.decided" | "ai.jevable.approval.expired" | "ai.jevable.approval.cancelled";
                time: string;
                datacontenttype: "application/json";
                data: {
                    runId: string;
                    revision: string;
                    attemptId: string;
                    nodeId: string;
                    expiresAt: string;
                    scope?: {
                        loop: import("../workflow/types.ts").NodeId;
                        index: number;
                    } | undefined;
                    loopExpiresAt?: string | undefined;
                    release?: {
                        id: string;
                        sha256: string;
                    } | undefined;
                    project?: {
                        id: string;
                        generation: number;
                    } | undefined;
                };
            };
            credentialGeneration: number;
            outcome: {
                status: "pending";
            } | {
                status: "settled";
                at: string;
                result: {
                    status: "accepted";
                    httpStatus: number;
                } | {
                    status: "rejected";
                    httpStatus: number;
                } | {
                    status: "uncertain";
                    reason: "invalid-response" | "timeout" | "transport" | "aborted";
                };
            };
            semantics: "pending-is-not-proof-of-dispatch; HTTP-acceptance-is-not-human-delivery-or-approval";
            telemetry?: {
                trace: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                };
                workflow?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                } | undefined;
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
            } | undefined;
        };
        semantics: "process-local-signal; inspect-retained-send-outcome; no-effect-retraction";
    }>;
    listApprovalNotifications(value: NotificationPageRequest, release?: NotificationReleaseScope): Promise<{
        schemaVersion: 1;
        deliveries: {
            request: {
                runId: string;
                revision: string;
                attemptId: string;
                requestId: string;
                endpointId: string;
                endpointSha256: string;
                eventSha256: string;
                eventKind?: "cancelled" | "expired" | "requested" | "decided" | undefined;
                redeliverOf?: string | undefined;
            };
            createdAt: string;
            outcome: {
                status: "pending";
            } | {
                status: "settled";
                at: string;
                result: {
                    status: "accepted";
                    httpStatus: number;
                } | {
                    status: "rejected";
                    httpStatus: number;
                } | {
                    status: "uncertain";
                    reason: "invalid-response" | "timeout" | "transport" | "aborted";
                };
            };
            trace?: {
                traceId: import("./run-trace.ts").JevableTraceId;
                spanId: import("./run-trace.ts").JevableSpanId;
                traceFlags: 0 | 1;
            } | undefined;
        }[];
        nextCursor: string | null;
        order: "request-id-ascending";
        consistency: "live-keyset; not-a-snapshot";
        semantics: "pending-is-not-proof-of-dispatch; HTTP-acceptance-is-not-human-delivery-or-approval";
        filter?: {
            outcome?: "accepted" | "pending" | "uncertain" | "rejected" | undefined;
            eventKind?: "cancelled" | "expired" | "requested" | "decided" | undefined;
            createdFrom?: string | undefined;
            createdBefore?: string | undefined;
        } | undefined;
    }>;
    listProjectApprovalNotifications(project: NotificationProjectScope, value: NotificationPageRequest): Promise<{
        project: {
            id: string;
            generation: number;
            revision: string;
        };
        schemaVersion: 1;
        deliveries: {
            request: {
                runId: string;
                revision: string;
                attemptId: string;
                requestId: string;
                endpointId: string;
                endpointSha256: string;
                eventSha256: string;
                eventKind?: "cancelled" | "expired" | "requested" | "decided" | undefined;
                redeliverOf?: string | undefined;
            };
            createdAt: string;
            outcome: {
                status: "pending";
            } | {
                status: "settled";
                at: string;
                result: {
                    status: "accepted";
                    httpStatus: number;
                } | {
                    status: "rejected";
                    httpStatus: number;
                } | {
                    status: "uncertain";
                    reason: "invalid-response" | "timeout" | "transport" | "aborted";
                };
            };
            trace?: {
                traceId: import("./run-trace.ts").JevableTraceId;
                spanId: import("./run-trace.ts").JevableSpanId;
                traceFlags: 0 | 1;
            } | undefined;
        }[];
        nextCursor: string | null;
        order: "request-id-ascending";
        consistency: "live-keyset; not-a-snapshot";
        semantics: "pending-is-not-proof-of-dispatch; HTTP-acceptance-is-not-human-delivery-or-approval";
        filter?: {
            outcome?: "accepted" | "pending" | "uncertain" | "rejected" | undefined;
            eventKind?: "cancelled" | "expired" | "requested" | "decided" | undefined;
            createdFrom?: string | undefined;
            createdBefore?: string | undefined;
        } | undefined;
    }>;
    sendApprovalNotification(request: NotificationRequest, actor: string, options?: {
        signal?: AbortSignal;
    }): Promise<NotificationRecord>;
    configureConnection(value: unknown, expectedGeneration: number, actor: string): {
        generation: number;
        updatedAt: string;
        connection: {
            protocol: "openai-compatible";
            tokenParameter: "max_tokens" | "max_completion_tokens";
            maxStreamEvents: number;
            id: string;
            provider: string;
            endpoint: string;
            allowedModels: string[];
            authentication: {
                kind: "bearer";
                credentialRef: string;
            } | {
                kind: "none";
            };
            maxResponseBytes: number;
            maxRequestBytes: number;
            maxTimeoutSeconds: number;
            tracePropagation?: "none" | "w3c" | undefined;
            baggageKeys?: string[] | undefined;
        } | {
            protocol: "systemone";
            provider: "jev" | "laya";
            id: string;
            endpoint: string;
            allowedModels: string[];
            authentication: {
                kind: "bearer";
                credentialRef: string;
            } | {
                kind: "none";
            };
            maxResponseBytes: number;
            maxRequestBytes: number;
            maxTimeoutSeconds: number;
            tracePropagation?: "none" | "w3c" | undefined;
            baggageKeys?: string[] | undefined;
        };
    };
    credentialStatus(ref: string): {
        ref: string;
        configured: boolean;
        generation: number;
        updatedAt?: never;
    } | {
        ref: string;
        configured: boolean;
        generation: number;
        updatedAt: string;
    };
    setCredential(ref: string, value: string, expectedGeneration: number, actor: string): {
        ref: string;
        configured: boolean;
        generation: number;
        updatedAt?: never;
    } | {
        ref: string;
        configured: boolean;
        generation: number;
        updatedAt: string;
    };
    providerAudit(): Record<string, import("node:sqlite").SQLOutputValue>[];
    clearCredential(ref: string, expectedGeneration: number, actor: string): {
        ref: string;
        configured: boolean;
        generation: number;
        updatedAt?: never;
    } | {
        ref: string;
        configured: boolean;
        generation: number;
        updatedAt: string;
    };
    telemetryStatus(): {
        logs?: {
            unit: string;
            queued: number;
            inFlight: number;
            lastSuccessAt: string | null;
            lastFailure: "response" | "transport" | "serialization" | "partial-rejection" | null;
            closed: boolean;
            deliveryGuarantee: string;
            accepted: number;
            exported: number;
            rejected: number;
            dropped: number;
            failedBatches: number;
            successfulBatches: number;
            enabled: boolean;
            protocol: "http/protobuf" | "grpc";
        };
        metrics?: {
            queued: number;
            inFlight: number;
            pendingChanges: boolean;
            abandonedChanges: number;
            lastSuccessAt: string | null;
            lastFailure: "response" | "transport" | "serialization" | "collection" | "partial-rejection" | null;
            closed: boolean;
            accepted: number;
            exported: number;
            rejected: number;
            dropped: number;
            failedBatches: number;
            successfulBatches: number;
            enabled: boolean;
            protocol: "http/protobuf" | "grpc";
            unit: string;
            temporality: string;
        };
        signals: string[];
        sqliteStatementMetrics?: boolean;
        journalTransactions?: boolean;
        storageTransactionMetrics?: boolean;
        storageQueueMetrics?: boolean;
        runtimeWorkMetrics?: boolean;
        grantPolicyDecisions?: boolean;
        grantOperations?: boolean;
        httpConnections: boolean;
        httpResponseContext?: boolean;
        resource: {
            serviceInstanceId: string;
        };
        httpRequests: boolean;
        queued: number;
        inFlight: number;
        lastSuccessAt: string | null;
        lastFailure: "response" | "transport" | "serialization" | "partial-rejection" | null;
        closed: boolean;
        deliveryGuarantee: string;
        accepted: number;
        exported: number;
        rejected: number;
        dropped: number;
        failedBatches: number;
        successfulBatches: number;
        enabled: boolean;
        protocol: "http/protobuf" | "grpc";
    } | {
        logs?: {
            unit: string;
            queued: number;
            inFlight: number;
            lastSuccessAt: string | null;
            lastFailure: "response" | "transport" | "serialization" | "partial-rejection" | null;
            closed: boolean;
            deliveryGuarantee: string;
            accepted: number;
            exported: number;
            rejected: number;
            dropped: number;
            failedBatches: number;
            successfulBatches: number;
            enabled: boolean;
            protocol: "http/protobuf" | "grpc";
        };
        metrics?: {
            queued: number;
            inFlight: number;
            pendingChanges: boolean;
            abandonedChanges: number;
            lastSuccessAt: string | null;
            lastFailure: "response" | "transport" | "serialization" | "collection" | "partial-rejection" | null;
            closed: boolean;
            accepted: number;
            exported: number;
            rejected: number;
            dropped: number;
            failedBatches: number;
            successfulBatches: number;
            enabled: boolean;
            protocol: "http/protobuf" | "grpc";
            unit: string;
            temporality: string;
        };
        signals: string[];
        sqliteStatementMetrics?: boolean;
        journalTransactions?: boolean;
        storageTransactionMetrics?: boolean;
        storageQueueMetrics?: boolean;
        runtimeWorkMetrics?: boolean;
        grantPolicyDecisions?: boolean;
        grantOperations?: boolean;
        httpConnections: boolean;
        httpResponseContext?: boolean;
        resource: {
            serviceInstanceId: string;
        };
        httpRequests: boolean;
        enabled: true;
        protocol: "http/protobuf" | "grpc";
    } | {
        enabled: false;
        signals: never[];
    };
    telemetryProbe(options?: {
        signal?: AbortSignal;
    }): Promise<{
        schemaVersion: 1;
        id: string;
        startedAt: string;
        finishedAt: string;
        status: "failed" | "acknowledged" | "disabled" | "aborted" | "warning";
        protocol: "http/protobuf" | "grpc" | null;
        signals: {
            signal: "metrics" | "traces" | "logs";
            outcome: "failed" | "acknowledged" | "rejected" | "aborted" | "warning" | "not-sent";
            records: 1;
            attempted: boolean;
            rejected: number | null;
            failure: "response" | "transport" | "aborted" | "serialization" | "collection" | "partial-rejection" | null;
        }[];
        trace: {
            traceId: string;
            spanId: string;
            traceFlags: 1;
        } | null;
        execution: "not-run";
        retries: false;
        sampling: "explicit-synthetic; independent-of-workflow-sampling";
        deliveryGuarantee: "collector-response-only; not-backend-storage-or-dashboard";
    }>;
    observeHttpRequest(method: string | undefined, path: string | undefined): import("../telemetry/http.ts").HttpRequestObservation | undefined;
    observeHttpAccess(stage: import('../http/access-observation.ts').HttpAccessStage): import("../http/access-observation.ts").HttpAccessObservation | undefined;
    observeHttpRateSql(operation: import('../http/rate-sql-observation.ts').HttpRateSqlOperation, parent: import('@opentelemetry/api').SpanContext | undefined): import("../http/rate-sql-observation.ts").HttpRateSqlObservation | undefined;
    observeHttpAsyncSlot(): import("../telemetry/async-slots.ts").AsyncSlotObservation | undefined;
    observeTestSuite(identity: import('../testing/suite-observation.ts').SuiteObservationIdentity): import("../testing/suite-observation.ts").SuiteObservation | undefined;
    observeHttpConnection(transport: import('../telemetry/connections.ts').HttpTransport): import("../telemetry/connections.ts").HttpConnectionObservation | undefined;
    observeHttpTransportFailure(transport: import('../telemetry/connections.ts').HttpTransport, failure: import('../telemetry/connections.ts').HttpTransportFailure): void;
    telemetryFlush(): Promise<{
        logs?: {
            unit: string;
            queued: number;
            inFlight: number;
            lastSuccessAt: string | null;
            lastFailure: "response" | "transport" | "serialization" | "partial-rejection" | null;
            closed: boolean;
            deliveryGuarantee: string;
            accepted: number;
            exported: number;
            rejected: number;
            dropped: number;
            failedBatches: number;
            successfulBatches: number;
            enabled: boolean;
            protocol: "http/protobuf" | "grpc";
        };
        metrics?: {
            queued: number;
            inFlight: number;
            pendingChanges: boolean;
            abandonedChanges: number;
            lastSuccessAt: string | null;
            lastFailure: "response" | "transport" | "serialization" | "collection" | "partial-rejection" | null;
            closed: boolean;
            accepted: number;
            exported: number;
            rejected: number;
            dropped: number;
            failedBatches: number;
            successfulBatches: number;
            enabled: boolean;
            protocol: "http/protobuf" | "grpc";
            unit: string;
            temporality: string;
        };
        signals: string[];
        sqliteStatementMetrics?: boolean;
        journalTransactions?: boolean;
        storageTransactionMetrics?: boolean;
        storageQueueMetrics?: boolean;
        runtimeWorkMetrics?: boolean;
        grantPolicyDecisions?: boolean;
        grantOperations?: boolean;
        httpConnections: boolean;
        httpResponseContext?: boolean;
        resource: {
            serviceInstanceId: string;
        };
        httpRequests: boolean;
        queued: number;
        inFlight: number;
        lastSuccessAt: string | null;
        lastFailure: "response" | "transport" | "serialization" | "partial-rejection" | null;
        closed: boolean;
        deliveryGuarantee: string;
        accepted: number;
        exported: number;
        rejected: number;
        dropped: number;
        failedBatches: number;
        successfulBatches: number;
        enabled: boolean;
        protocol: "http/protobuf" | "grpc";
    } | {
        logs?: {
            unit: string;
            queued: number;
            inFlight: number;
            lastSuccessAt: string | null;
            lastFailure: "response" | "transport" | "serialization" | "partial-rejection" | null;
            closed: boolean;
            deliveryGuarantee: string;
            accepted: number;
            exported: number;
            rejected: number;
            dropped: number;
            failedBatches: number;
            successfulBatches: number;
            enabled: boolean;
            protocol: "http/protobuf" | "grpc";
        };
        metrics?: {
            queued: number;
            inFlight: number;
            pendingChanges: boolean;
            abandonedChanges: number;
            lastSuccessAt: string | null;
            lastFailure: "response" | "transport" | "serialization" | "collection" | "partial-rejection" | null;
            closed: boolean;
            accepted: number;
            exported: number;
            rejected: number;
            dropped: number;
            failedBatches: number;
            successfulBatches: number;
            enabled: boolean;
            protocol: "http/protobuf" | "grpc";
            unit: string;
            temporality: string;
        };
        signals: string[];
        sqliteStatementMetrics?: boolean;
        journalTransactions?: boolean;
        storageTransactionMetrics?: boolean;
        storageQueueMetrics?: boolean;
        runtimeWorkMetrics?: boolean;
        grantPolicyDecisions?: boolean;
        grantOperations?: boolean;
        httpConnections: boolean;
        httpResponseContext?: boolean;
        resource: {
            serviceInstanceId: string;
        };
        httpRequests: boolean;
        enabled: true;
        protocol: "http/protobuf" | "grpc";
    } | {
        enabled: false;
        signals: never[];
    }>;
    withTraceParent<T>(parent: string | undefined, operation: () => T): T;
    withTraceContext<T>(value: TraceRequestContext, operation: () => T): T;
    projects(): {
        schemaVersion: 1;
        id: string;
        title: string;
        workflowId: string;
        generation: number;
        acceptedRevision: string;
        archived: boolean;
        createdAt: string;
        updatedAt: string;
    }[];
    project(id: string): import("../projects/ledger.ts").Project;
    editProject(command: ProjectCommand): import("../projects/ledger.ts").Project;
    createVendorImport(command: VendorImportCommand): import("../projects/ledger.ts").Project;
    vendorImport(id: string, inspect?: boolean): {
        privatePayloads: "excluded";
        schemaVersion: 1;
        projectId: string;
        revision: string;
        at: string;
        converter: {
            name: "jevable-owned";
            version: string;
        };
        format: "n8n" | "dify" | "coze" | "zapier" | "make" | "power-automate";
        version: string;
        sourceSha256: string;
        conversionSha256: string;
        conversionRevision: string;
        requestSha256: string;
        sha256: string;
        mappingCounts: {
            exact: number;
            approximate: number;
            unsupported: number;
        };
        transfer: "excluded-from-project-bundles";
        execution: "not-run";
    } | {
        privatePayloads: "included";
        record: {
            schemaVersion: 1;
            projectId: string;
            title: string;
            actor: string;
            at: string;
            source: string;
            conversion: {
                conversionSha256: string;
                schemaVersion: 1;
                converter: {
                    name: "jevable-owned";
                    version: string;
                };
                format: "n8n" | "dify" | "coze" | "zapier" | "make" | "power-automate";
                version: string;
                title: string;
                sourceSha256: string;
                conversionRevision: string;
                yaml: string;
                mappings: {
                    source: string;
                    sourceType: string;
                    kind: "exact" | "approximate" | "unsupported";
                    reason: "loop" | "mapped" | "trigger-mode" | "model-route" | "expression" | "operator" | "code" | "node-type" | "unreachable" | "language";
                    target?: string | undefined;
                }[];
            };
            revision: string;
            requestSha256: string;
        };
        schemaVersion: 1;
        projectId: string;
        revision: string;
        at: string;
        converter: {
            name: "jevable-owned";
            version: string;
        };
        format: "n8n" | "dify" | "coze" | "zapier" | "make" | "power-automate";
        version: string;
        sourceSha256: string;
        conversionSha256: string;
        conversionRevision: string;
        requestSha256: string;
        sha256: string;
        mappingCounts: {
            exact: number;
            approximate: number;
            unsupported: number;
        };
        transfer: "excluded-from-project-bundles";
        execution: "not-run";
    } | null;
    diffProject(id: string, from: string, to: string): {
        approvalChanges: string[];
        from: import("../workflow/types.ts").RevisionHash;
        to: import("../workflow/types.ts").RevisionHash;
        addedNodes: readonly import("../workflow/types.ts").NodeId[];
        removedNodes: readonly import("../workflow/types.ts").NodeId[];
        changedNodes: readonly import("../workflow/types.ts").NodeId[];
        edgesChanged: boolean;
        inputSchemaChanged: boolean;
        metadataChanged: boolean;
        presentationChanged: boolean;
        extensionsChanged: boolean;
    };
    projectDeletions(): {
        schemaVersion: 1;
        id: string;
        generation: number;
        revision: string;
        actor: string;
        at: string;
        status: "deleted";
    }[];
    exportProject(id: string, expectedGeneration: number, reviewedRevision: string, history?: boolean, includeTests?: boolean): {
        version: 1;
        format: "jevable.ai/project-bundle";
        exportedAt: string;
        source: {
            id: string;
            generation: number;
        };
        title: string;
        accepted: {
            revision: string;
            yaml: string;
        };
        history?: {
            schemaVersion: 1;
            id: string;
            revisions: {
                revision: string;
                yaml: string;
            }[];
            changes: ({
                operation: "create";
                title: string;
                revision: string;
                actor: string;
                at: string;
                copiedFrom?: {
                    id: string;
                    generation: number;
                    revision: string;
                } | undefined;
            } | {
                operation: "propose";
                proposalId: string;
                base: string;
                revision: string;
                actor: string;
                at: string;
            } | {
                operation: "accept";
                proposalId: string;
                revision: string;
                approvalChanges: string[];
                actor: string;
                at: string;
            } | {
                operation: "reject";
                proposalId: string;
                revision: string;
                actor: string;
                at: string;
            } | {
                operation: "restore";
                revision: string;
                approvalChanges: string[];
                actor: string;
                at: string;
            } | {
                operation: "rename";
                title: string;
                actor: string;
                at: string;
            } | {
                operation: "archive";
                archived: boolean;
                actor: string;
                at: string;
            } | {
                operation: "import";
                bundleSha256: string;
                sourceProjectId: string;
                sourceGeneration: number;
                historyIncluded: boolean;
                actor: string;
                at: string;
            })[];
            vendorImport?: {
                schemaVersion: 1;
                projectId: string;
                title: string;
                actor: string;
                at: string;
                source: string;
                conversion: {
                    conversionSha256: string;
                    schemaVersion: 1;
                    converter: {
                        name: "jevable-owned";
                        version: string;
                    };
                    format: "n8n" | "dify" | "coze" | "zapier" | "make" | "power-automate";
                    version: string;
                    title: string;
                    sourceSha256: string;
                    conversionRevision: string;
                    yaml: string;
                    mappings: {
                        source: string;
                        sourceType: string;
                        kind: "exact" | "approximate" | "unsupported";
                        reason: "loop" | "mapped" | "trigger-mode" | "model-route" | "expression" | "operator" | "code" | "node-type" | "unreachable" | "language";
                        target?: string | undefined;
                    }[];
                };
                revision: string;
                requestSha256: string;
            } | undefined;
        } | undefined;
    } | {
        version: 2;
        tests: {
            scope: "accepted-revision-latest-definitions";
            excludedOtherRevisions: number;
            cases: {
                source: {
                    id: string;
                    generation: number;
                    sha256: string;
                };
                status: "draft" | "accepted";
                definition: {
                    title: string;
                    project: {
                        id: string;
                        generation: number;
                        revision: string;
                    };
                    input: z.core.util.JSONType;
                    expectations: ({
                        kind: "status";
                        value: "cancelled" | "completed" | "failed" | "waiting";
                    } | {
                        kind: "output-equals";
                        value: z.core.util.JSONType;
                    } | {
                        kind: "failure-code";
                        value: "invalid-node-value" | "loop-limit" | "loop-timeout" | "approval-rejected" | "approval-expired" | "ai-budget";
                    } | {
                        nodeId: string;
                        kind: "node-visited";
                        scope?: {
                            loop: string;
                            index: number;
                        } | undefined;
                    } | {
                        value: z.core.util.JSONType;
                        nodeId: string;
                        kind: "node-output-equals";
                        scope?: {
                            loop: string;
                            index: number;
                        } | undefined;
                    } | {
                        value: string;
                        nodeId: string;
                        kind: "node-port-equals";
                        scope?: {
                            loop: string;
                            index: number;
                        } | undefined;
                    })[];
                    triggerMode?: "api" | undefined;
                };
            }[];
            excludedArchived?: number | undefined;
        };
        format: "jevable.ai/project-bundle";
        exportedAt: string;
        source: {
            id: string;
            generation: number;
        };
        title: string;
        accepted: {
            revision: string;
            yaml: string;
        };
        history?: {
            schemaVersion: 1;
            id: string;
            revisions: {
                revision: string;
                yaml: string;
            }[];
            changes: ({
                operation: "create";
                title: string;
                revision: string;
                actor: string;
                at: string;
                copiedFrom?: {
                    id: string;
                    generation: number;
                    revision: string;
                } | undefined;
            } | {
                operation: "propose";
                proposalId: string;
                base: string;
                revision: string;
                actor: string;
                at: string;
            } | {
                operation: "accept";
                proposalId: string;
                revision: string;
                approvalChanges: string[];
                actor: string;
                at: string;
            } | {
                operation: "reject";
                proposalId: string;
                revision: string;
                actor: string;
                at: string;
            } | {
                operation: "restore";
                revision: string;
                approvalChanges: string[];
                actor: string;
                at: string;
            } | {
                operation: "rename";
                title: string;
                actor: string;
                at: string;
            } | {
                operation: "archive";
                archived: boolean;
                actor: string;
                at: string;
            } | {
                operation: "import";
                bundleSha256: string;
                sourceProjectId: string;
                sourceGeneration: number;
                historyIncluded: boolean;
                actor: string;
                at: string;
            })[];
            vendorImport?: {
                schemaVersion: 1;
                projectId: string;
                title: string;
                actor: string;
                at: string;
                source: string;
                conversion: {
                    conversionSha256: string;
                    schemaVersion: 1;
                    converter: {
                        name: "jevable-owned";
                        version: string;
                    };
                    format: "n8n" | "dify" | "coze" | "zapier" | "make" | "power-automate";
                    version: string;
                    title: string;
                    sourceSha256: string;
                    conversionRevision: string;
                    yaml: string;
                    mappings: {
                        source: string;
                        sourceType: string;
                        kind: "exact" | "approximate" | "unsupported";
                        reason: "loop" | "mapped" | "trigger-mode" | "model-route" | "expression" | "operator" | "code" | "node-type" | "unreachable" | "language";
                        target?: string | undefined;
                    }[];
                };
                revision: string;
                requestSha256: string;
            } | undefined;
        } | undefined;
    };
    inspectProjectImport(json: string): {
        bundle: {
            version: 1;
            format: "jevable.ai/project-bundle";
            exportedAt: string;
            source: {
                id: string;
                generation: number;
            };
            title: string;
            accepted: {
                revision: string;
                yaml: string;
            };
            history?: {
                schemaVersion: 1;
                id: string;
                revisions: {
                    revision: string;
                    yaml: string;
                }[];
                changes: ({
                    operation: "create";
                    title: string;
                    revision: string;
                    actor: string;
                    at: string;
                    copiedFrom?: {
                        id: string;
                        generation: number;
                        revision: string;
                    } | undefined;
                } | {
                    operation: "propose";
                    proposalId: string;
                    base: string;
                    revision: string;
                    actor: string;
                    at: string;
                } | {
                    operation: "accept";
                    proposalId: string;
                    revision: string;
                    approvalChanges: string[];
                    actor: string;
                    at: string;
                } | {
                    operation: "reject";
                    proposalId: string;
                    revision: string;
                    actor: string;
                    at: string;
                } | {
                    operation: "restore";
                    revision: string;
                    approvalChanges: string[];
                    actor: string;
                    at: string;
                } | {
                    operation: "rename";
                    title: string;
                    actor: string;
                    at: string;
                } | {
                    operation: "archive";
                    archived: boolean;
                    actor: string;
                    at: string;
                } | {
                    operation: "import";
                    bundleSha256: string;
                    sourceProjectId: string;
                    sourceGeneration: number;
                    historyIncluded: boolean;
                    actor: string;
                    at: string;
                })[];
                vendorImport?: {
                    schemaVersion: 1;
                    projectId: string;
                    title: string;
                    actor: string;
                    at: string;
                    source: string;
                    conversion: {
                        conversionSha256: string;
                        schemaVersion: 1;
                        converter: {
                            name: "jevable-owned";
                            version: string;
                        };
                        format: "n8n" | "dify" | "coze" | "zapier" | "make" | "power-automate";
                        version: string;
                        title: string;
                        sourceSha256: string;
                        conversionRevision: string;
                        yaml: string;
                        mappings: {
                            source: string;
                            sourceType: string;
                            kind: "exact" | "approximate" | "unsupported";
                            reason: "loop" | "mapped" | "trigger-mode" | "model-route" | "expression" | "operator" | "code" | "node-type" | "unreachable" | "language";
                            target?: string | undefined;
                        }[];
                    };
                    revision: string;
                    requestSha256: string;
                } | undefined;
            } | undefined;
        } | {
            version: 2;
            tests: {
                scope: "accepted-revision-latest-definitions";
                excludedOtherRevisions: number;
                cases: {
                    source: {
                        id: string;
                        generation: number;
                        sha256: string;
                    };
                    status: "draft" | "accepted";
                    definition: {
                        title: string;
                        project: {
                            id: string;
                            generation: number;
                            revision: string;
                        };
                        input: z.core.util.JSONType;
                        expectations: ({
                            kind: "status";
                            value: "cancelled" | "completed" | "failed" | "waiting";
                        } | {
                            kind: "output-equals";
                            value: z.core.util.JSONType;
                        } | {
                            kind: "failure-code";
                            value: "invalid-node-value" | "loop-limit" | "loop-timeout" | "approval-rejected" | "approval-expired" | "ai-budget";
                        } | {
                            nodeId: string;
                            kind: "node-visited";
                            scope?: {
                                loop: string;
                                index: number;
                            } | undefined;
                        } | {
                            value: z.core.util.JSONType;
                            nodeId: string;
                            kind: "node-output-equals";
                            scope?: {
                                loop: string;
                                index: number;
                            } | undefined;
                        } | {
                            value: string;
                            nodeId: string;
                            kind: "node-port-equals";
                            scope?: {
                                loop: string;
                                index: number;
                            } | undefined;
                        })[];
                        triggerMode?: "api" | undefined;
                    };
                }[];
                excludedArchived?: number | undefined;
            };
            format: "jevable.ai/project-bundle";
            exportedAt: string;
            source: {
                id: string;
                generation: number;
            };
            title: string;
            accepted: {
                revision: string;
                yaml: string;
            };
            history?: {
                schemaVersion: 1;
                id: string;
                revisions: {
                    revision: string;
                    yaml: string;
                }[];
                changes: ({
                    operation: "create";
                    title: string;
                    revision: string;
                    actor: string;
                    at: string;
                    copiedFrom?: {
                        id: string;
                        generation: number;
                        revision: string;
                    } | undefined;
                } | {
                    operation: "propose";
                    proposalId: string;
                    base: string;
                    revision: string;
                    actor: string;
                    at: string;
                } | {
                    operation: "accept";
                    proposalId: string;
                    revision: string;
                    approvalChanges: string[];
                    actor: string;
                    at: string;
                } | {
                    operation: "reject";
                    proposalId: string;
                    revision: string;
                    actor: string;
                    at: string;
                } | {
                    operation: "restore";
                    revision: string;
                    approvalChanges: string[];
                    actor: string;
                    at: string;
                } | {
                    operation: "rename";
                    title: string;
                    actor: string;
                    at: string;
                } | {
                    operation: "archive";
                    archived: boolean;
                    actor: string;
                    at: string;
                } | {
                    operation: "import";
                    bundleSha256: string;
                    sourceProjectId: string;
                    sourceGeneration: number;
                    historyIncluded: boolean;
                    actor: string;
                    at: string;
                })[];
                vendorImport?: {
                    schemaVersion: 1;
                    projectId: string;
                    title: string;
                    actor: string;
                    at: string;
                    source: string;
                    conversion: {
                        conversionSha256: string;
                        schemaVersion: 1;
                        converter: {
                            name: "jevable-owned";
                            version: string;
                        };
                        format: "n8n" | "dify" | "coze" | "zapier" | "make" | "power-automate";
                        version: string;
                        title: string;
                        sourceSha256: string;
                        conversionRevision: string;
                        yaml: string;
                        mappings: {
                            source: string;
                            sourceType: string;
                            kind: "exact" | "approximate" | "unsupported";
                            reason: "loop" | "mapped" | "trigger-mode" | "model-route" | "expression" | "operator" | "code" | "node-type" | "unreachable" | "language";
                            target?: string | undefined;
                        }[];
                    };
                    revision: string;
                    requestSha256: string;
                } | undefined;
            } | undefined;
        };
        sha256: string;
    };
    importProject(json: string, reviewedSha256: string, actor: string, newId?: string): import("../projects/ledger.ts").Project;
    deleteProject(id: string, expectedGeneration: number, actor: string): {
        schemaVersion: 1;
        id: string;
        generation: number;
        revision: string;
        actor: string;
        at: string;
        status: "deleted";
    };
    testCases(): {
        status: "draft" | "accepted";
        sha256: string;
        actor: string;
        at: string;
        archived?: boolean;
        id: string;
        generation: number;
        title: string;
        project: {
            id: string;
            generation: number;
            revision: string;
        };
    }[];
    testCase(id: string, generation?: number): import("../testing/schema.ts").TestCase;
    testHistory(id: string): {
        schemaVersion: 1;
        id: string;
        versions: {
            generation: number;
            operation: "create" | "edit" | "accept" | "archive";
            status: "draft" | "accepted";
            definition: {
                title: string;
                project: {
                    id: string;
                    generation: number;
                    revision: string;
                };
                input: z.core.util.JSONType;
                expectations: ({
                    kind: "status";
                    value: "cancelled" | "completed" | "failed" | "waiting";
                } | {
                    kind: "output-equals";
                    value: z.core.util.JSONType;
                } | {
                    kind: "failure-code";
                    value: "invalid-node-value" | "loop-limit" | "loop-timeout" | "approval-rejected" | "approval-expired" | "ai-budget";
                } | {
                    nodeId: string;
                    kind: "node-visited";
                    scope?: {
                        loop: string;
                        index: number;
                    } | undefined;
                } | {
                    value: z.core.util.JSONType;
                    nodeId: string;
                    kind: "node-output-equals";
                    scope?: {
                        loop: string;
                        index: number;
                    } | undefined;
                } | {
                    value: string;
                    nodeId: string;
                    kind: "node-port-equals";
                    scope?: {
                        loop: string;
                        index: number;
                    } | undefined;
                })[];
                triggerMode?: "api" | undefined;
            };
            sha256: string;
            actor: string;
            at: string;
            archived?: boolean | undefined;
        }[];
        importedFrom?: {
            bundleSha256: string;
            source: {
                id: string;
                generation: number;
                sha256: string;
            };
            project: {
                id: string;
                generation: number;
                revision: string;
            };
            status: "draft" | "accepted";
        } | undefined;
    };
    generateTests(command: GenerateTestsRequest): import("../testing/generation-schema.ts").TestGeneration;
    testGeneration(id: string): import("../testing/generation-schema.ts").TestGeneration;
    testGenerations(): {
        caseCount: number;
        sha256: string;
        schemaVersion: 1;
        format: "jevable.ai/test-generation";
        id: string;
        generator: "schema-boundary/v1";
        createdAt: string;
        actor: string;
        request: {
            limit: number;
            project: {
                id: string;
                generation: number;
                revision: string;
            };
            triggerMode?: "api" | undefined;
        };
        status: "review-required" | "no-candidates";
        execution: "not-run";
        expectations: "completion-suggestion-only; review-before-acceptance";
        coverage: "schema-samples-not-branch-proof";
        diagnostics: {
            attempted: number;
            invalid: number;
            skippedBounds: number;
            totalInputBytes: number;
            limitReached: boolean;
            noSeed: boolean;
        };
    }[];
    editTest(command: TestCommand): import("../testing/schema.ts").TestCase;
    eraseTest(command: TestErasureRequest): {
        schemaVersion: 1;
        policy: "archived-draft-v1";
        requestId: string;
        test: {
            id: string;
            generation: number;
            sha256: string;
        };
        historySha256: string;
        project: {
            id: string;
            generation: number;
            revision: string;
        };
        actor: string;
        at: string;
        status: "logically-removed";
        securePhysicalErasure: false;
    };
    testErasure(requestId: string): {
        schemaVersion: 1;
        policy: "archived-draft-v1";
        requestId: string;
        test: {
            id: string;
            generation: number;
            sha256: string;
        };
        historySha256: string;
        project: {
            id: string;
            generation: number;
            revision: string;
        };
        actor: string;
        at: string;
        status: "logically-removed";
        securePhysicalErasure: false;
    };
    testResult(id: string, inspect?: boolean): Promise<{
        schemaVersion: number;
        test: {
            id: string;
            generation: number;
            sha256: string;
        };
        title: string;
        assessment: string;
        workflowStatus: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
        terminal: boolean;
        observedRunUpdatedAt: string;
        evidence: string;
        privateInspection: boolean;
        checks: {
            actual?: unknown;
            expected?: z.core.util.JSONType;
            nodeId?: string;
            scope?: {
                loop: string;
                index: number;
            } | undefined;
            index: number;
            kind: "status" | "output-equals" | "failure-code" | "node-visited" | "node-output-equals" | "node-port-equals";
            matched: boolean;
            available: boolean;
        }[];
        run: {
            steps: {
                startedAt: string | undefined;
                durationMs: number | undefined;
                modelUsage?: {
                    tries: number;
                    inputTokens?: number | undefined;
                    outputTokens?: number | undefined;
                };
                trace?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                };
                port?: string;
                nodeId: import("../workflow/types.ts").NodeId;
                scope: import("./run-evaluator.ts").LoopScope | {
                    loop: import("../workflow/types.ts").NodeId;
                    index: number;
                } | undefined;
                attemptId: import("./run-types.ts").JevableAttemptId | undefined;
            }[];
            nodeId?: import("../workflow/types.ts").NodeId;
            attemptId?: import("./run-types.ts").JevableAttemptId;
            recovery?: string;
            expiresAt?: string;
            code?: import("./run-evaluator.ts").RunFailureCode;
            output?: import("../workflow/types.ts").ReadonlyJsonValue;
            traceSegments?: {
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
            }[];
            telemetryDelivery?: string;
            previousStatus?: "paused" | "waiting" | "executing";
            cancellation?: {
                status: string;
                externalEffects: string;
                id: string;
                actor: string;
                at: string;
                traceParent?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                } | undefined;
                delegation?: {
                    grantId: string;
                    scope: {
                        kind: "caller";
                        release: {
                            id: string;
                            sha256: string;
                            revision: string;
                        };
                        permissions: ("start" | "read" | "control" | "cancel")[];
                    };
                    deadline: string;
                } | undefined;
            };
            test?: {
                id: string;
                generation: number;
                sha256: string;
            };
            release?: {
                id: string;
                sha256: string;
            };
            createdAt: string;
            updatedAt: string;
            project?: {
                id: string;
                generation: number;
            };
            scope?: import("./run-evaluator.ts").LoopScope | {
                loop: import("../workflow/types.ts").NodeId;
                index: number;
            };
            lastControl?: {
                requestId: string;
                mode: "continue" | "step" | "pause" | "recover";
                acknowledgement: string;
            };
            startedPaused?: boolean;
            pause?: never;
            checkpointSha256: string;
            triggerMode?: import("./trigger.ts").ApiTriggerMode;
            schemaVersion: number;
            id: string;
            revision: string;
            status: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
        } | {
            steps: {
                startedAt: string | undefined;
                durationMs: number | undefined;
                modelUsage?: {
                    tries: number;
                    inputTokens?: number | undefined;
                    outputTokens?: number | undefined;
                };
                trace?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                };
                port?: string;
                nodeId: import("../workflow/types.ts").NodeId;
                scope: import("./run-evaluator.ts").LoopScope | {
                    loop: import("../workflow/types.ts").NodeId;
                    index: number;
                } | undefined;
                attemptId: import("./run-types.ts").JevableAttemptId | undefined;
            }[];
            nodeId?: import("../workflow/types.ts").NodeId;
            attemptId?: import("./run-types.ts").JevableAttemptId;
            recovery?: string;
            expiresAt?: string;
            code?: import("./run-evaluator.ts").RunFailureCode;
            output?: import("../workflow/types.ts").ReadonlyJsonValue;
            traceSegments?: {
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
            }[];
            telemetryDelivery?: string;
            previousStatus?: "paused" | "waiting" | "executing";
            cancellation?: {
                status: string;
                externalEffects: string;
                id: string;
                actor: string;
                at: string;
                traceParent?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                } | undefined;
                delegation?: {
                    grantId: string;
                    scope: {
                        kind: "caller";
                        release: {
                            id: string;
                            sha256: string;
                            revision: string;
                        };
                        permissions: ("start" | "read" | "control" | "cancel")[];
                    };
                    deadline: string;
                } | undefined;
            };
            test?: {
                id: string;
                generation: number;
                sha256: string;
            };
            release?: {
                id: string;
                sha256: string;
            };
            createdAt: string;
            updatedAt: string;
            project?: {
                id: string;
                generation: number;
            };
            scope?: import("./run-evaluator.ts").LoopScope | {
                loop: import("../workflow/types.ts").NodeId;
                index: number;
            };
            lastControl?: {
                requestId: string;
                mode: "continue" | "step" | "pause" | "recover";
                acknowledgement: string;
            };
            startedPaused?: boolean;
            pause: {
                requestId: string;
                at: string;
                status: string;
                execution: string;
            };
            checkpointSha256: string;
            triggerMode?: import("./trigger.ts").ApiTriggerMode;
            schemaVersion: number;
            id: string;
            revision: string;
            status: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
        };
    }>;
    runTest(value: TestIdentity, runId: string): Promise<{
        schemaVersion: number;
        test: {
            id: string;
            generation: number;
            sha256: string;
        };
        title: string;
        assessment: string;
        workflowStatus: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
        terminal: boolean;
        observedRunUpdatedAt: string;
        evidence: string;
        privateInspection: boolean;
        checks: {
            actual?: unknown;
            expected?: z.core.util.JSONType;
            nodeId?: string;
            scope?: {
                loop: string;
                index: number;
            } | undefined;
            index: number;
            kind: "status" | "output-equals" | "failure-code" | "node-visited" | "node-output-equals" | "node-port-equals";
            matched: boolean;
            available: boolean;
        }[];
        run: {
            steps: {
                startedAt: string | undefined;
                durationMs: number | undefined;
                modelUsage?: {
                    tries: number;
                    inputTokens?: number | undefined;
                    outputTokens?: number | undefined;
                };
                trace?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                };
                port?: string;
                nodeId: import("../workflow/types.ts").NodeId;
                scope: import("./run-evaluator.ts").LoopScope | {
                    loop: import("../workflow/types.ts").NodeId;
                    index: number;
                } | undefined;
                attemptId: import("./run-types.ts").JevableAttemptId | undefined;
            }[];
            nodeId?: import("../workflow/types.ts").NodeId;
            attemptId?: import("./run-types.ts").JevableAttemptId;
            recovery?: string;
            expiresAt?: string;
            code?: import("./run-evaluator.ts").RunFailureCode;
            output?: import("../workflow/types.ts").ReadonlyJsonValue;
            traceSegments?: {
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
            }[];
            telemetryDelivery?: string;
            previousStatus?: "paused" | "waiting" | "executing";
            cancellation?: {
                status: string;
                externalEffects: string;
                id: string;
                actor: string;
                at: string;
                traceParent?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                } | undefined;
                delegation?: {
                    grantId: string;
                    scope: {
                        kind: "caller";
                        release: {
                            id: string;
                            sha256: string;
                            revision: string;
                        };
                        permissions: ("start" | "read" | "control" | "cancel")[];
                    };
                    deadline: string;
                } | undefined;
            };
            test?: {
                id: string;
                generation: number;
                sha256: string;
            };
            release?: {
                id: string;
                sha256: string;
            };
            createdAt: string;
            updatedAt: string;
            project?: {
                id: string;
                generation: number;
            };
            scope?: import("./run-evaluator.ts").LoopScope | {
                loop: import("../workflow/types.ts").NodeId;
                index: number;
            };
            lastControl?: {
                requestId: string;
                mode: "continue" | "step" | "pause" | "recover";
                acknowledgement: string;
            };
            startedPaused?: boolean;
            pause?: never;
            checkpointSha256: string;
            triggerMode?: import("./trigger.ts").ApiTriggerMode;
            schemaVersion: number;
            id: string;
            revision: string;
            status: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
        } | {
            steps: {
                startedAt: string | undefined;
                durationMs: number | undefined;
                modelUsage?: {
                    tries: number;
                    inputTokens?: number | undefined;
                    outputTokens?: number | undefined;
                };
                trace?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                };
                port?: string;
                nodeId: import("../workflow/types.ts").NodeId;
                scope: import("./run-evaluator.ts").LoopScope | {
                    loop: import("../workflow/types.ts").NodeId;
                    index: number;
                } | undefined;
                attemptId: import("./run-types.ts").JevableAttemptId | undefined;
            }[];
            nodeId?: import("../workflow/types.ts").NodeId;
            attemptId?: import("./run-types.ts").JevableAttemptId;
            recovery?: string;
            expiresAt?: string;
            code?: import("./run-evaluator.ts").RunFailureCode;
            output?: import("../workflow/types.ts").ReadonlyJsonValue;
            traceSegments?: {
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
            }[];
            telemetryDelivery?: string;
            previousStatus?: "paused" | "waiting" | "executing";
            cancellation?: {
                status: string;
                externalEffects: string;
                id: string;
                actor: string;
                at: string;
                traceParent?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                } | undefined;
                delegation?: {
                    grantId: string;
                    scope: {
                        kind: "caller";
                        release: {
                            id: string;
                            sha256: string;
                            revision: string;
                        };
                        permissions: ("start" | "read" | "control" | "cancel")[];
                    };
                    deadline: string;
                } | undefined;
            };
            test?: {
                id: string;
                generation: number;
                sha256: string;
            };
            release?: {
                id: string;
                sha256: string;
            };
            createdAt: string;
            updatedAt: string;
            project?: {
                id: string;
                generation: number;
            };
            scope?: import("./run-evaluator.ts").LoopScope | {
                loop: import("../workflow/types.ts").NodeId;
                index: number;
            };
            lastControl?: {
                requestId: string;
                mode: "continue" | "step" | "pause" | "recover";
                acknowledgement: string;
            };
            startedPaused?: boolean;
            pause: {
                requestId: string;
                at: string;
                status: string;
                execution: string;
            };
            checkpointSha256: string;
            triggerMode?: import("./trigger.ts").ApiTriggerMode;
            schemaVersion: number;
            id: string;
            revision: string;
            status: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
        };
    }>;
    releases(): Release[];
    release(id: string): Release;
    createRelease(value: ReleaseCreateCommand): Release;
    /** Admit an explicit immutable release artifact; its external creator is not a locally authenticated actor. */
    runRelease(value: unknown, input: unknown, options?: RunStartOptions): Promise<LocalRun>;
    runReleaseAsync(value: unknown, input: unknown, options: AsyncRunOptions): Promise<AsyncRun>;
    private startRelease;
    private callerPrincipal;
    /** Experimental direct SDK caller surface. No owner payload or arbitrary source/release options. */
    startWithGrant(token: string, input: unknown, value: CallerStartOptions, context?: import('../access/caller.ts').CallerContext<CallerRunReceipt>): Promise<CallerRunReceipt>;
    /** Reads only this grant's retained run and completed output; never resumes or dispatches. */
    readWithGrant(token: string, value: string, context?: import('../access/caller.ts').CallerContext<CallerRunResult>): Promise<CallerRunResult>;
    /** Experimental caller mutation: admission precedes abort; exact retries never repeat abort or settlement. */
    cancelWithGrant(token: string, value: string, request: CallerCancellationRequest, context?: import('../access/caller.ts').CallerContext<CallerCancellationReceipt>): Promise<CallerCancellationReceipt>;
    /** Control-only opaque checkpoint inspection; never discloses output or dispatches work. */
    controlCheckpointWithGrant(token: string, value: string, context?: import('../access/caller.ts').CallerContext<CallerControlCheckpoint>): Promise<CallerControlCheckpoint>;
    /** Caller execution uses its own writer admission, never an owner advance/action token. */
    advanceWithGrant(token: string, value: string, command: CallerControlRequest, context?: import('../access/caller.ts').CallerContext<CallerControlReceipt>): Promise<CallerControlReceipt>;
    /** Generation and reviewed hash are required; a pending proposal never becomes executable by accident. */
    runProject(id: string, expectedGeneration: number, reviewedRevision: string, input: unknown, options?: RunStartOptions): Promise<LocalRun>;
    runProjectAsync(id: string, expectedGeneration: number, reviewedRevision: string, input: unknown, options: AsyncRunOptions): Promise<AsyncRun>;
    private startProject;
    events(id: string): Promise<{
        data: unknown;
        sequence: number;
        kind: string;
        at: string;
    }[]>;
    /** Bounded read-only observation. Retry reads, never execution, if validation overlaps a transition. */
    exportRun(id: string, includePrivate?: boolean): Promise<{
        schemaVersion: number;
        snapshot: {
            private?: {
                run: LocalRun;
                journal: {
                    sequence: number;
                    kind: string;
                    at: string;
                    data: unknown;
                }[];
            };
            boundary: {
                eventCount: number;
                firstSequence: number | null;
                lastSequence: number | null;
                consistency: string;
                terminal: boolean;
            };
            verification: {
                checkpoint: string;
                settledModels: string;
                authenticity: string;
                execution: string;
            };
            privacy: {
                credentialStore: string;
                identifiers: string;
                modelIdentities?: "included-by-explicit-usage-request";
                payloads: string;
                actors: string;
            };
            models?: {
                calls: ({
                    evidence: "not-recorded";
                    scope?: {
                        loop: import("../workflow/types.ts").NodeId;
                        index: number;
                    };
                    nodeId: import("../workflow/types.ts").NodeId;
                    attemptId: import("./run-types.ts").JevableAttemptId;
                } | {
                    policy?: {
                        kind: "transient-http-v1";
                        maxAttempts: number;
                        timeoutSeconds: number;
                    };
                    tries?: {
                        scheduledDelayMs?: number;
                        httpStatus?: number;
                        code?: "request-too-large" | "response-too-large" | "invalid-response" | "http-error" | "transport-error" | "timeout" | "cancelled";
                        settledAt?: string;
                        trace?: {
                            traceId: import("./run-trace.ts").JevableTraceId;
                            spanId: import("./run-trace.ts").JevableSpanId;
                            traceFlags: 0 | 1;
                        };
                        id: string;
                        number: number;
                        intentAt: string;
                        status: "completed" | "failed" | "pending";
                    }[];
                    usage?: {
                        tries: number;
                        inputTokens?: number | undefined;
                        outputTokens?: number | undefined;
                    } | {
                        tries: 1;
                        inputTokens?: number | undefined;
                        outputTokens?: number | undefined;
                    };
                    code?: "request-too-large" | "response-too-large" | "invalid-response" | "http-error" | "transport-error" | "timeout" | "cancelled";
                    settledAt?: string;
                    status: "completed" | "failed" | "pending";
                    usageIdentity?: {
                        provider: string;
                        model: string;
                    };
                    trace?: {
                        traceId: import("./run-trace.ts").JevableTraceId;
                        spanId: import("./run-trace.ts").JevableSpanId;
                        traceFlags: 0 | 1;
                    };
                    evidence: "recorded";
                    evidenceSchemaVersion: 1 | 2;
                    intentAt: string;
                    scope?: {
                        loop: import("../workflow/types.ts").NodeId;
                        index: number;
                    };
                    nodeId: import("../workflow/types.ts").NodeId;
                    attemptId: import("./run-types.ts").JevableAttemptId;
                })[];
                semantics: "intent-is-not-dispatch; settlement-is-not-workflow-completion; missing-is-not-proof-of-no-call";
                usageIdentities?: "requested-provider-model/v1";
                format: "jevable.model-history/v1";
                source: "configured-model-store";
            };
            schemaVersion: number;
            format: "jevable.ai/run-evidence";
            run: {
                traceSegments?: {
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
                }[];
                telemetryDelivery?: string;
                cancellation?: {
                    traceParent?: {
                        traceId: import("./run-trace.ts").JevableTraceId;
                        spanId: import("./run-trace.ts").JevableSpanId;
                        traceFlags: 0 | 1;
                    };
                    id: string;
                    at: string;
                };
                expiresAt?: string;
                attempt?: {
                    trace?: {
                        traceId: import("./run-trace.ts").JevableTraceId;
                        spanId: import("./run-trace.ts").JevableSpanId;
                        traceFlags: 0 | 1;
                    };
                    id: import("./run-types.ts").JevableAttemptId;
                    nodeId: import("../workflow/types.ts").NodeId;
                };
                previousStatus?: "paused" | "waiting" | "executing";
                externalEffects?: string;
                nodeId?: import("../workflow/types.ts").NodeId;
                code?: import("./run-evaluator.ts").RunFailureCode;
                failedAttempt?: {
                    modelUsage?: {
                        tries: number;
                        inputTokens?: number | undefined;
                        outputTokens?: number | undefined;
                    };
                    durationMs?: number;
                    startedAt?: string;
                    trace?: {
                        traceId: import("./run-trace.ts").JevableTraceId;
                        spanId: import("./run-trace.ts").JevableSpanId;
                        traceFlags: 0 | 1;
                    };
                    attemptId?: import("./run-types.ts").JevableAttemptId;
                };
                scope?: import("./run-evaluator.ts").LoopScope | {
                    loop: import("../workflow/types.ts").NodeId;
                    index: number;
                };
                next?: import("../workflow/types.ts").NodeId;
                test?: {
                    id: string;
                    generation: number;
                    sha256: string;
                };
                release?: {
                    id: string;
                    sha256: string;
                };
                project?: {
                    id: string;
                    generation: number;
                };
                startedPaused?: boolean;
                pause?: never;
                triggerMode?: import("./trigger.ts").ApiTriggerMode;
                id: string;
                revision: string;
                status: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
                createdAt: string;
                updatedAt: string;
            } | {
                traceSegments?: {
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
                }[];
                telemetryDelivery?: string;
                cancellation?: {
                    traceParent?: {
                        traceId: import("./run-trace.ts").JevableTraceId;
                        spanId: import("./run-trace.ts").JevableSpanId;
                        traceFlags: 0 | 1;
                    };
                    id: string;
                    at: string;
                };
                expiresAt?: string;
                attempt?: {
                    trace?: {
                        traceId: import("./run-trace.ts").JevableTraceId;
                        spanId: import("./run-trace.ts").JevableSpanId;
                        traceFlags: 0 | 1;
                    };
                    id: import("./run-types.ts").JevableAttemptId;
                    nodeId: import("../workflow/types.ts").NodeId;
                };
                previousStatus?: "paused" | "waiting" | "executing";
                externalEffects?: string;
                nodeId?: import("../workflow/types.ts").NodeId;
                code?: import("./run-evaluator.ts").RunFailureCode;
                failedAttempt?: {
                    modelUsage?: {
                        tries: number;
                        inputTokens?: number | undefined;
                        outputTokens?: number | undefined;
                    };
                    durationMs?: number;
                    startedAt?: string;
                    trace?: {
                        traceId: import("./run-trace.ts").JevableTraceId;
                        spanId: import("./run-trace.ts").JevableSpanId;
                        traceFlags: 0 | 1;
                    };
                    attemptId?: import("./run-types.ts").JevableAttemptId;
                };
                scope?: import("./run-evaluator.ts").LoopScope | {
                    loop: import("../workflow/types.ts").NodeId;
                    index: number;
                };
                next?: import("../workflow/types.ts").NodeId;
                test?: {
                    id: string;
                    generation: number;
                    sha256: string;
                };
                release?: {
                    id: string;
                    sha256: string;
                };
                project?: {
                    id: string;
                    generation: number;
                };
                startedPaused?: boolean;
                pause: {
                    requestId: string;
                    at: string;
                    status: string;
                    execution: string;
                };
                triggerMode?: import("./trigger.ts").ApiTriggerMode;
                id: string;
                revision: string;
                status: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
                createdAt: string;
                updatedAt: string;
            };
            steps: {
                modelUsage?: {
                    tries: number;
                    inputTokens?: number | undefined;
                    outputTokens?: number | undefined;
                };
                durationMs?: number;
                startedAt?: string;
                trace?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                };
                attemptId?: import("./run-types.ts").JevableAttemptId;
                scope?: import("./run-evaluator.ts").LoopScope | {
                    loop: import("../workflow/types.ts").NodeId;
                    index: number;
                };
                port?: string;
                index: number;
                nodeId: import("../workflow/types.ts").NodeId;
            }[];
            journal: ({
                triggerMode?: import("./trigger.ts").ApiTriggerMode;
                nodeId?: string | undefined;
                attemptId?: string | null | undefined;
                scope?: {
                    loop: import("../workflow/types.ts").NodeId;
                    index: number;
                } | null | undefined;
                trace?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                } | undefined;
                status?: "completed" | "paused" | "failed" | "waiting" | "executing" | undefined;
                sequence: number;
                at: string;
                kind: "loop-timeout" | "approval-decided" | "approval-requested" | "execution-segment" | "execution-requested" | "cancellation-requested" | "node-intent" | "run-cancelled" | "breakpoint-hit" | "node-trace" | "node-result" | "run-created";
            } | {
                configurationRequestId: string;
                checkpointSha256: string;
                nodeId: import("../workflow/types.ts").NodeId;
                stepCount: number;
                at: string;
                scope?: {
                    loop: import("../workflow/types.ts").NodeId;
                    index: number;
                } | undefined;
                sequence: number;
                kind: "loop-timeout" | "approval-decided" | "approval-requested" | "execution-segment" | "execution-requested" | "cancellation-requested" | "node-intent" | "run-cancelled" | "breakpoint-hit" | "node-trace" | "node-result" | "run-created";
            } | {
                requestId: string;
                expectedCheckpointSha256: string;
                mode: "continue" | "step" | "pause" | "recover";
                breakpoints?: string[] | undefined;
                sequence: number;
                at: string;
                kind: "loop-timeout" | "approval-decided" | "approval-requested" | "execution-segment" | "execution-requested" | "cancellation-requested" | "node-intent" | "run-cancelled" | "breakpoint-hit" | "node-trace" | "node-result" | "run-created";
            } | {
                parent?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                };
                previous?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                };
                operation?: "cancel" | "approval" | "run" | "resume";
                trace?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                } | undefined;
                routes?: {
                    stepIndex: number;
                    nodeId: string;
                    port: string;
                    scope?: {
                        loop: string;
                        index: number;
                    } | undefined;
                }[];
                decision: {
                    kind: "expired" | "action";
                    at: string;
                };
                nodeId?: string | undefined;
                attemptId?: string | null | undefined;
                scope?: {
                    loop: import("../workflow/types.ts").NodeId;
                    index: number;
                } | null | undefined;
                status?: "completed" | "paused" | "failed" | "waiting" | "executing" | undefined;
                sequence: number;
                at: string;
                kind: "loop-timeout" | "approval-decided" | "approval-requested" | "execution-segment" | "execution-requested" | "cancellation-requested" | "node-intent" | "run-cancelled" | "breakpoint-hit" | "node-trace" | "node-result" | "run-created";
            } | {
                routes?: {
                    stepIndex: number;
                    nodeId: string;
                    port: string;
                    scope?: {
                        loop: string;
                        index: number;
                    } | undefined;
                }[];
                nodeId?: string | undefined;
                attemptId?: string | null | undefined;
                scope?: {
                    loop: import("../workflow/types.ts").NodeId;
                    index: number;
                } | null | undefined;
                trace?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                } | undefined;
                status?: "completed" | "paused" | "failed" | "waiting" | "executing" | undefined;
                sequence: number;
                at: string;
                kind: "loop-timeout" | "approval-decided" | "approval-requested" | "execution-segment" | "execution-requested" | "cancellation-requested" | "node-intent" | "run-cancelled" | "breakpoint-hit" | "node-trace" | "node-result" | "run-created";
            } | {
                traceParent?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                };
                requestId: string;
                sequence: number;
                at: string;
                kind: "loop-timeout" | "approval-decided" | "approval-requested" | "execution-segment" | "execution-requested" | "cancellation-requested" | "node-intent" | "run-cancelled" | "breakpoint-hit" | "node-trace" | "node-result" | "run-created";
            } | {
                requestId: string;
                previousStatus: "paused" | "waiting" | "executing";
                next: string;
                attemptId: string | null;
                checkpointSha256: string;
                sequence: number;
                at: string;
                kind: "loop-timeout" | "approval-decided" | "approval-requested" | "execution-segment" | "execution-requested" | "cancellation-requested" | "node-intent" | "run-cancelled" | "breakpoint-hit" | "node-trace" | "node-result" | "run-created";
            } | {
                operation: "cancel" | "approval" | "run" | "resume";
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
                sequence: number;
                at: string;
                kind: "loop-timeout" | "approval-decided" | "approval-requested" | "execution-segment" | "execution-requested" | "cancellation-requested" | "node-intent" | "run-cancelled" | "breakpoint-hit" | "node-trace" | "node-result" | "run-created";
            })[];
            nodeAttempts: {
                format: "jevable.node-attempts/v1";
                source: "retained-intents";
                numbering: "per-node-and-loop-scope";
                entries: {
                    number: number;
                    scope?: {
                        loop: import("../workflow/types.ts").NodeId;
                        index: number;
                    };
                    attemptId: string;
                    nodeId: string;
                }[];
            };
        };
        checksum: {
            algorithm: string;
            encoding: string;
            value: string;
        };
    }>;
    /** Explicit usage grouping read; ordinary evidence never includes provider/requested-model identities. */
    exportUsageRun(id: string): Promise<{
        schemaVersion: number;
        snapshot: {
            private?: {
                run: LocalRun;
                journal: {
                    sequence: number;
                    kind: string;
                    at: string;
                    data: unknown;
                }[];
            };
            boundary: {
                eventCount: number;
                firstSequence: number | null;
                lastSequence: number | null;
                consistency: string;
                terminal: boolean;
            };
            verification: {
                checkpoint: string;
                settledModels: string;
                authenticity: string;
                execution: string;
            };
            privacy: {
                credentialStore: string;
                identifiers: string;
                modelIdentities?: "included-by-explicit-usage-request";
                payloads: string;
                actors: string;
            };
            models?: {
                calls: ({
                    evidence: "not-recorded";
                    scope?: {
                        loop: import("../workflow/types.ts").NodeId;
                        index: number;
                    };
                    nodeId: import("../workflow/types.ts").NodeId;
                    attemptId: import("./run-types.ts").JevableAttemptId;
                } | {
                    policy?: {
                        kind: "transient-http-v1";
                        maxAttempts: number;
                        timeoutSeconds: number;
                    };
                    tries?: {
                        scheduledDelayMs?: number;
                        httpStatus?: number;
                        code?: "request-too-large" | "response-too-large" | "invalid-response" | "http-error" | "transport-error" | "timeout" | "cancelled";
                        settledAt?: string;
                        trace?: {
                            traceId: import("./run-trace.ts").JevableTraceId;
                            spanId: import("./run-trace.ts").JevableSpanId;
                            traceFlags: 0 | 1;
                        };
                        id: string;
                        number: number;
                        intentAt: string;
                        status: "completed" | "failed" | "pending";
                    }[];
                    usage?: {
                        tries: number;
                        inputTokens?: number | undefined;
                        outputTokens?: number | undefined;
                    } | {
                        tries: 1;
                        inputTokens?: number | undefined;
                        outputTokens?: number | undefined;
                    };
                    code?: "request-too-large" | "response-too-large" | "invalid-response" | "http-error" | "transport-error" | "timeout" | "cancelled";
                    settledAt?: string;
                    status: "completed" | "failed" | "pending";
                    usageIdentity?: {
                        provider: string;
                        model: string;
                    };
                    trace?: {
                        traceId: import("./run-trace.ts").JevableTraceId;
                        spanId: import("./run-trace.ts").JevableSpanId;
                        traceFlags: 0 | 1;
                    };
                    evidence: "recorded";
                    evidenceSchemaVersion: 1 | 2;
                    intentAt: string;
                    scope?: {
                        loop: import("../workflow/types.ts").NodeId;
                        index: number;
                    };
                    nodeId: import("../workflow/types.ts").NodeId;
                    attemptId: import("./run-types.ts").JevableAttemptId;
                })[];
                semantics: "intent-is-not-dispatch; settlement-is-not-workflow-completion; missing-is-not-proof-of-no-call";
                usageIdentities?: "requested-provider-model/v1";
                format: "jevable.model-history/v1";
                source: "configured-model-store";
            };
            schemaVersion: number;
            format: "jevable.ai/run-evidence";
            run: {
                traceSegments?: {
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
                }[];
                telemetryDelivery?: string;
                cancellation?: {
                    traceParent?: {
                        traceId: import("./run-trace.ts").JevableTraceId;
                        spanId: import("./run-trace.ts").JevableSpanId;
                        traceFlags: 0 | 1;
                    };
                    id: string;
                    at: string;
                };
                expiresAt?: string;
                attempt?: {
                    trace?: {
                        traceId: import("./run-trace.ts").JevableTraceId;
                        spanId: import("./run-trace.ts").JevableSpanId;
                        traceFlags: 0 | 1;
                    };
                    id: import("./run-types.ts").JevableAttemptId;
                    nodeId: import("../workflow/types.ts").NodeId;
                };
                previousStatus?: "paused" | "waiting" | "executing";
                externalEffects?: string;
                nodeId?: import("../workflow/types.ts").NodeId;
                code?: import("./run-evaluator.ts").RunFailureCode;
                failedAttempt?: {
                    modelUsage?: {
                        tries: number;
                        inputTokens?: number | undefined;
                        outputTokens?: number | undefined;
                    };
                    durationMs?: number;
                    startedAt?: string;
                    trace?: {
                        traceId: import("./run-trace.ts").JevableTraceId;
                        spanId: import("./run-trace.ts").JevableSpanId;
                        traceFlags: 0 | 1;
                    };
                    attemptId?: import("./run-types.ts").JevableAttemptId;
                };
                scope?: import("./run-evaluator.ts").LoopScope | {
                    loop: import("../workflow/types.ts").NodeId;
                    index: number;
                };
                next?: import("../workflow/types.ts").NodeId;
                test?: {
                    id: string;
                    generation: number;
                    sha256: string;
                };
                release?: {
                    id: string;
                    sha256: string;
                };
                project?: {
                    id: string;
                    generation: number;
                };
                startedPaused?: boolean;
                pause?: never;
                triggerMode?: import("./trigger.ts").ApiTriggerMode;
                id: string;
                revision: string;
                status: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
                createdAt: string;
                updatedAt: string;
            } | {
                traceSegments?: {
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
                }[];
                telemetryDelivery?: string;
                cancellation?: {
                    traceParent?: {
                        traceId: import("./run-trace.ts").JevableTraceId;
                        spanId: import("./run-trace.ts").JevableSpanId;
                        traceFlags: 0 | 1;
                    };
                    id: string;
                    at: string;
                };
                expiresAt?: string;
                attempt?: {
                    trace?: {
                        traceId: import("./run-trace.ts").JevableTraceId;
                        spanId: import("./run-trace.ts").JevableSpanId;
                        traceFlags: 0 | 1;
                    };
                    id: import("./run-types.ts").JevableAttemptId;
                    nodeId: import("../workflow/types.ts").NodeId;
                };
                previousStatus?: "paused" | "waiting" | "executing";
                externalEffects?: string;
                nodeId?: import("../workflow/types.ts").NodeId;
                code?: import("./run-evaluator.ts").RunFailureCode;
                failedAttempt?: {
                    modelUsage?: {
                        tries: number;
                        inputTokens?: number | undefined;
                        outputTokens?: number | undefined;
                    };
                    durationMs?: number;
                    startedAt?: string;
                    trace?: {
                        traceId: import("./run-trace.ts").JevableTraceId;
                        spanId: import("./run-trace.ts").JevableSpanId;
                        traceFlags: 0 | 1;
                    };
                    attemptId?: import("./run-types.ts").JevableAttemptId;
                };
                scope?: import("./run-evaluator.ts").LoopScope | {
                    loop: import("../workflow/types.ts").NodeId;
                    index: number;
                };
                next?: import("../workflow/types.ts").NodeId;
                test?: {
                    id: string;
                    generation: number;
                    sha256: string;
                };
                release?: {
                    id: string;
                    sha256: string;
                };
                project?: {
                    id: string;
                    generation: number;
                };
                startedPaused?: boolean;
                pause: {
                    requestId: string;
                    at: string;
                    status: string;
                    execution: string;
                };
                triggerMode?: import("./trigger.ts").ApiTriggerMode;
                id: string;
                revision: string;
                status: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
                createdAt: string;
                updatedAt: string;
            };
            steps: {
                modelUsage?: {
                    tries: number;
                    inputTokens?: number | undefined;
                    outputTokens?: number | undefined;
                };
                durationMs?: number;
                startedAt?: string;
                trace?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                };
                attemptId?: import("./run-types.ts").JevableAttemptId;
                scope?: import("./run-evaluator.ts").LoopScope | {
                    loop: import("../workflow/types.ts").NodeId;
                    index: number;
                };
                port?: string;
                index: number;
                nodeId: import("../workflow/types.ts").NodeId;
            }[];
            journal: ({
                triggerMode?: import("./trigger.ts").ApiTriggerMode;
                nodeId?: string | undefined;
                attemptId?: string | null | undefined;
                scope?: {
                    loop: import("../workflow/types.ts").NodeId;
                    index: number;
                } | null | undefined;
                trace?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                } | undefined;
                status?: "completed" | "paused" | "failed" | "waiting" | "executing" | undefined;
                sequence: number;
                at: string;
                kind: "loop-timeout" | "approval-decided" | "approval-requested" | "execution-segment" | "execution-requested" | "cancellation-requested" | "node-intent" | "run-cancelled" | "breakpoint-hit" | "node-trace" | "node-result" | "run-created";
            } | {
                configurationRequestId: string;
                checkpointSha256: string;
                nodeId: import("../workflow/types.ts").NodeId;
                stepCount: number;
                at: string;
                scope?: {
                    loop: import("../workflow/types.ts").NodeId;
                    index: number;
                } | undefined;
                sequence: number;
                kind: "loop-timeout" | "approval-decided" | "approval-requested" | "execution-segment" | "execution-requested" | "cancellation-requested" | "node-intent" | "run-cancelled" | "breakpoint-hit" | "node-trace" | "node-result" | "run-created";
            } | {
                requestId: string;
                expectedCheckpointSha256: string;
                mode: "continue" | "step" | "pause" | "recover";
                breakpoints?: string[] | undefined;
                sequence: number;
                at: string;
                kind: "loop-timeout" | "approval-decided" | "approval-requested" | "execution-segment" | "execution-requested" | "cancellation-requested" | "node-intent" | "run-cancelled" | "breakpoint-hit" | "node-trace" | "node-result" | "run-created";
            } | {
                parent?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                };
                previous?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                };
                operation?: "cancel" | "approval" | "run" | "resume";
                trace?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                } | undefined;
                routes?: {
                    stepIndex: number;
                    nodeId: string;
                    port: string;
                    scope?: {
                        loop: string;
                        index: number;
                    } | undefined;
                }[];
                decision: {
                    kind: "expired" | "action";
                    at: string;
                };
                nodeId?: string | undefined;
                attemptId?: string | null | undefined;
                scope?: {
                    loop: import("../workflow/types.ts").NodeId;
                    index: number;
                } | null | undefined;
                status?: "completed" | "paused" | "failed" | "waiting" | "executing" | undefined;
                sequence: number;
                at: string;
                kind: "loop-timeout" | "approval-decided" | "approval-requested" | "execution-segment" | "execution-requested" | "cancellation-requested" | "node-intent" | "run-cancelled" | "breakpoint-hit" | "node-trace" | "node-result" | "run-created";
            } | {
                routes?: {
                    stepIndex: number;
                    nodeId: string;
                    port: string;
                    scope?: {
                        loop: string;
                        index: number;
                    } | undefined;
                }[];
                nodeId?: string | undefined;
                attemptId?: string | null | undefined;
                scope?: {
                    loop: import("../workflow/types.ts").NodeId;
                    index: number;
                } | null | undefined;
                trace?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                } | undefined;
                status?: "completed" | "paused" | "failed" | "waiting" | "executing" | undefined;
                sequence: number;
                at: string;
                kind: "loop-timeout" | "approval-decided" | "approval-requested" | "execution-segment" | "execution-requested" | "cancellation-requested" | "node-intent" | "run-cancelled" | "breakpoint-hit" | "node-trace" | "node-result" | "run-created";
            } | {
                traceParent?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                };
                requestId: string;
                sequence: number;
                at: string;
                kind: "loop-timeout" | "approval-decided" | "approval-requested" | "execution-segment" | "execution-requested" | "cancellation-requested" | "node-intent" | "run-cancelled" | "breakpoint-hit" | "node-trace" | "node-result" | "run-created";
            } | {
                requestId: string;
                previousStatus: "paused" | "waiting" | "executing";
                next: string;
                attemptId: string | null;
                checkpointSha256: string;
                sequence: number;
                at: string;
                kind: "loop-timeout" | "approval-decided" | "approval-requested" | "execution-segment" | "execution-requested" | "cancellation-requested" | "node-intent" | "run-cancelled" | "breakpoint-hit" | "node-trace" | "node-result" | "run-created";
            } | {
                operation: "cancel" | "approval" | "run" | "resume";
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
                sequence: number;
                at: string;
                kind: "loop-timeout" | "approval-decided" | "approval-requested" | "execution-segment" | "execution-requested" | "cancellation-requested" | "node-intent" | "run-cancelled" | "breakpoint-hit" | "node-trace" | "node-result" | "run-created";
            })[];
            nodeAttempts: {
                format: "jevable.node-attempts/v1";
                source: "retained-intents";
                numbering: "per-node-and-loop-scope";
                entries: {
                    number: number;
                    scope?: {
                        loop: import("../workflow/types.ts").NodeId;
                        index: number;
                    };
                    attemptId: string;
                    nodeId: string;
                }[];
            };
        };
        checksum: {
            algorithm: string;
            encoding: string;
            value: string;
        };
    }>;
    private snapshotEvidence;
    /** Persist before signalling. An active owner returns a request receipt; inspect until it stops. */
    cancel(id: string, requestId: string, actor: string): LocalRun;
    private finishCancellation;
    /** A caller-supplied UUID is the retry identity. Reusing it never re-executes a saved run. */
    run(yaml: string, input: unknown, options?: RunStartOptions): Promise<LocalRun>;
    runAsync(yaml: string, input: unknown, options: AsyncRunOptions): Promise<AsyncRun>;
    private start;
    /** Admit exactly one reviewed control request before dispatch; retry only observes retained state. */
    advance(id: string, command: ExecutionControl, actor: string): Promise<LocalRun>;
    /** Resume only a known safe checkpoint; an uncommitted dispatch requires separate operator recovery. */
    resume(id: string): Promise<LocalRun>;
    /** Authenticate role and action before loading a grant-derived private target. */
    private reviewerPrincipal;
    /** Authenticate before reading a private run and again after the awaited read.
     * This is a trusted release-host port, not an owner-visible operation.
     */
    reviewerReleaseWithGrant(token: string, release: ReleaseReviewerPin): Promise<{
        principal: GrantPrincipal;
        run: LocalRun;
    }>;
    /** Experimental SDK reviewer boundary. An identical request observes current state, never resumes it. */
    decideWithGrant(token: string, value: ReviewerDecisionRequest, context?: import('../access/reviewer.ts').ReviewerDecisionContext): Promise<ReviewerDecisionReceipt>;
    decide(id: string, attemptId: string, action: string, actor: string, options?: {
        pauseAfter?: boolean;
        expireOnly?: boolean;
    }): Promise<LocalRun>;
    /** A durable cancellation takes precedence if a concurrent asynchronous admission check fails. */
    private admitRetained;
    private saveSegment;
    private execute;
    close(): Promise<void>;
}

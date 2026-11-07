import { z } from 'zod';
import type { LocalRuntime } from '../runtime/local.ts';
import type { PostgresRuntime } from '../runtime/postgres.ts';
import type { ReviewerDecisionRequest, ReviewerDecisionContext } from '../access/reviewer.ts';
type Methods = 'check' | 'runRelease' | 'show' | 'events' | 'exportRun' | 'exportUsageRun' | 'advance' | 'cancel' | 'decide' | 'grant' | 'issueGrant' | 'revokeGrant' | 'decideWithGrant' | 'reviewerReleaseWithGrant' | 'notificationDestinations' | 'prepareApprovalNotification' | 'sendApprovalNotification' | 'inspectApprovalNotification' | 'listApprovalNotifications' | 'abortApprovalNotification' | 'automaticApprovalNotificationStatus' | 'automaticApprovalAdmissions' | 'automaticApprovalAdmission';
type ReleaseRuntimeTarget = {
    storage: 'sqlite';
    runtime: Pick<LocalRuntime, Methods | 'list' | 'listReleasePage'>;
} | {
    storage: 'postgres';
    runtime: Pick<PostgresRuntime, Methods | 'listRelease'>;
};
declare const commandSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    operation: z.ZodLiteral<"release.info">;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"release.check">;
    triggerMode: z.ZodOptional<z.ZodLiteral<"api">>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"runs.start">;
    id: z.ZodUUID;
    input: z.ZodJSONSchema;
    paused: z.ZodOptional<z.ZodBoolean>;
    triggerMode: z.ZodOptional<z.ZodLiteral<"api">>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"runs.list">;
    page: z.ZodOptional<z.ZodObject<{
        after: z.ZodOptional<z.ZodUUID>;
        limit: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"runs.show">;
    id: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"runs.inspect">;
    id: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"runs.events">;
    id: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"runs.export">;
    id: z.ZodUUID;
    includePrivate: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"usage.report">;
    selection: z.ZodUnknown;
}, z.core.$strict>, z.ZodObject<{
    requestId: z.ZodUUID;
    expectedCheckpointSha256: z.ZodString;
    mode: z.ZodEnum<{
        continue: "continue";
        step: "step";
        pause: "pause";
        recover: "recover";
    }>;
    breakpoints: z.ZodOptional<z.ZodArray<z.ZodString>>;
    operation: z.ZodLiteral<"runs.advance">;
    id: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"runs.cancel">;
    id: z.ZodUUID;
    requestId: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"approvals.show">;
    id: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"approvals.list">;
    page: z.ZodObject<{
        after: z.ZodOptional<z.ZodUUID>;
        limit: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"notifications.destinations">;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"notifications.automatic-status">;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"notifications.automatic-show">;
    requestId: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"notifications.automatic-list">;
    page: z.ZodObject<{
        after: z.ZodOptional<z.ZodUUID>;
        limit: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"notifications.prepare">;
    pin: z.ZodObject<{
        runId: z.ZodUUID;
        revision: z.ZodString;
        attemptId: z.ZodUUID;
        eventKind: z.ZodOptional<z.ZodEnum<{
            cancelled: "cancelled";
            expired: "expired";
            requested: "requested";
            decided: "decided";
        }>>;
    }, z.core.$strict>;
    endpointId: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"notifications.send">;
    request: z.ZodObject<{
        runId: z.ZodUUID;
        revision: z.ZodString;
        attemptId: z.ZodUUID;
        eventKind: z.ZodOptional<z.ZodEnum<{
            cancelled: "cancelled";
            expired: "expired";
            requested: "requested";
            decided: "decided";
        }>>;
        requestId: z.ZodUUID;
        endpointId: z.ZodString;
        endpointSha256: z.ZodString;
        eventSha256: z.ZodString;
        redeliverOf: z.ZodOptional<z.ZodUUID>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"notifications.show">;
    requestId: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"notifications.abort">;
    requestId: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"notifications.list">;
    page: z.ZodObject<{
        after: z.ZodOptional<z.ZodUUID>;
        limit: z.ZodDefault<z.ZodNumber>;
        filter: z.ZodOptional<z.ZodPipe<z.ZodObject<{
            outcome: z.ZodOptional<z.ZodEnum<{
                accepted: "accepted";
                pending: "pending";
                uncertain: "uncertain";
                rejected: "rejected";
            }>>;
            eventKind: z.ZodOptional<z.ZodEnum<{
                cancelled: "cancelled";
                expired: "expired";
                requested: "requested";
                decided: "decided";
            }>>;
            createdFrom: z.ZodOptional<z.ZodISODateTime>;
            createdBefore: z.ZodOptional<z.ZodISODateTime>;
        }, z.core.$strict>, z.ZodTransform<{
            outcome?: "accepted" | "pending" | "uncertain" | "rejected" | undefined;
            eventKind?: "cancelled" | "expired" | "requested" | "decided" | undefined;
            createdFrom?: string | undefined;
            createdBefore?: string | undefined;
        }, {
            outcome?: "accepted" | "pending" | "uncertain" | "rejected" | undefined;
            eventKind?: "cancelled" | "expired" | "requested" | "decided" | undefined;
            createdFrom?: string | undefined;
            createdBefore?: string | undefined;
        }>>>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"approvals.decide">;
    id: z.ZodUUID;
    attemptId: z.ZodUUID;
    action: z.ZodString;
    pauseAfter: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"reviewers.issue">;
    id: z.ZodUUID;
    tokenSha256: z.ZodString;
    runId: z.ZodUUID;
    attemptId: z.ZodUUID;
    expiresAt: z.ZodISODateTime;
    decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"reviewers.show">;
    id: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"reviewers.revoke">;
    id: z.ZodUUID;
    requestId: z.ZodUUID;
    expectedGeneration: z.ZodLiteral<1>;
}, z.core.$strict>], "operation">;
export type ReleaseOperation = z.input<typeof commandSchema>;
/** Source of truth for the exact-release OpenAPI request body. The HTTP layer
 * adds its separate releaseSha256 envelope before this strict union is parsed.
 */
export declare function releaseOperationJsonSchema(): z.core.ZodStandardJSONSchemaPayload<z.ZodDiscriminatedUnion<[z.ZodObject<{
    operation: z.ZodLiteral<"release.info">;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"release.check">;
    triggerMode: z.ZodOptional<z.ZodLiteral<"api">>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"runs.start">;
    id: z.ZodUUID;
    input: z.ZodJSONSchema;
    paused: z.ZodOptional<z.ZodBoolean>;
    triggerMode: z.ZodOptional<z.ZodLiteral<"api">>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"runs.list">;
    page: z.ZodOptional<z.ZodObject<{
        after: z.ZodOptional<z.ZodUUID>;
        limit: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"runs.show">;
    id: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"runs.inspect">;
    id: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"runs.events">;
    id: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"runs.export">;
    id: z.ZodUUID;
    includePrivate: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"usage.report">;
    selection: z.ZodUnknown;
}, z.core.$strict>, z.ZodObject<{
    requestId: z.ZodUUID;
    expectedCheckpointSha256: z.ZodString;
    mode: z.ZodEnum<{
        continue: "continue";
        step: "step";
        pause: "pause";
        recover: "recover";
    }>;
    breakpoints: z.ZodOptional<z.ZodArray<z.ZodString>>;
    operation: z.ZodLiteral<"runs.advance">;
    id: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"runs.cancel">;
    id: z.ZodUUID;
    requestId: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"approvals.show">;
    id: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"approvals.list">;
    page: z.ZodObject<{
        after: z.ZodOptional<z.ZodUUID>;
        limit: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"notifications.destinations">;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"notifications.automatic-status">;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"notifications.automatic-show">;
    requestId: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"notifications.automatic-list">;
    page: z.ZodObject<{
        after: z.ZodOptional<z.ZodUUID>;
        limit: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"notifications.prepare">;
    pin: z.ZodObject<{
        runId: z.ZodUUID;
        revision: z.ZodString;
        attemptId: z.ZodUUID;
        eventKind: z.ZodOptional<z.ZodEnum<{
            cancelled: "cancelled";
            expired: "expired";
            requested: "requested";
            decided: "decided";
        }>>;
    }, z.core.$strict>;
    endpointId: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"notifications.send">;
    request: z.ZodObject<{
        runId: z.ZodUUID;
        revision: z.ZodString;
        attemptId: z.ZodUUID;
        eventKind: z.ZodOptional<z.ZodEnum<{
            cancelled: "cancelled";
            expired: "expired";
            requested: "requested";
            decided: "decided";
        }>>;
        requestId: z.ZodUUID;
        endpointId: z.ZodString;
        endpointSha256: z.ZodString;
        eventSha256: z.ZodString;
        redeliverOf: z.ZodOptional<z.ZodUUID>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"notifications.show">;
    requestId: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"notifications.abort">;
    requestId: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"notifications.list">;
    page: z.ZodObject<{
        after: z.ZodOptional<z.ZodUUID>;
        limit: z.ZodDefault<z.ZodNumber>;
        filter: z.ZodOptional<z.ZodPipe<z.ZodObject<{
            outcome: z.ZodOptional<z.ZodEnum<{
                accepted: "accepted";
                pending: "pending";
                uncertain: "uncertain";
                rejected: "rejected";
            }>>;
            eventKind: z.ZodOptional<z.ZodEnum<{
                cancelled: "cancelled";
                expired: "expired";
                requested: "requested";
                decided: "decided";
            }>>;
            createdFrom: z.ZodOptional<z.ZodISODateTime>;
            createdBefore: z.ZodOptional<z.ZodISODateTime>;
        }, z.core.$strict>, z.ZodTransform<{
            outcome?: "accepted" | "pending" | "uncertain" | "rejected" | undefined;
            eventKind?: "cancelled" | "expired" | "requested" | "decided" | undefined;
            createdFrom?: string | undefined;
            createdBefore?: string | undefined;
        }, {
            outcome?: "accepted" | "pending" | "uncertain" | "rejected" | undefined;
            eventKind?: "cancelled" | "expired" | "requested" | "decided" | undefined;
            createdFrom?: string | undefined;
            createdBefore?: string | undefined;
        }>>>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"approvals.decide">;
    id: z.ZodUUID;
    attemptId: z.ZodUUID;
    action: z.ZodString;
    pauseAfter: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"reviewers.issue">;
    id: z.ZodUUID;
    tokenSha256: z.ZodString;
    runId: z.ZodUUID;
    attemptId: z.ZodUUID;
    expiresAt: z.ZodISODateTime;
    decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"reviewers.show">;
    id: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"reviewers.revoke">;
    id: z.ZodUUID;
    requestId: z.ZodUUID;
    expectedGeneration: z.ZodLiteral<1>;
}, z.core.$strict>], "operation">>;
/** Admit a notification-only app command before acquiring database ownership.
 * Use the same strict schema as the release service; no caller-supplied release pin or actor.
 */
export declare function parseReleaseNotificationOperation(value: unknown): Extract<z.output<typeof commandSchema>, {
    operation: `notifications.${string}`;
}>;
/** Exact-release execution adapter. No project, source, provider or credential mutations. */
export declare class ReleaseSession {
    private readonly target;
    private readonly actor;
    private readonly automaticDelivery;
    private readonly reviewerDecisions;
    private readonly release;
    readonly pin: Readonly<{
        id: string;
        sha256: string;
        revision: string;
        version: string;
        runtime: Readonly<{
            version: string;
            sha256: string;
        }>;
    }>;
    constructor(target: ReleaseRuntimeTarget, value: unknown, actor: string, automaticDelivery?: boolean, reviewerDecisions?: boolean);
    private get runtime();
    private get reviewerPin();
    capabilities(): {
        schemaVersion: number;
        product: string;
        version: string;
        protocolVersion: string;
        mode: string;
        release: Readonly<{
            id: string;
            sha256: string;
            revision: string;
            version: string;
            runtime: Readonly<{
                version: string;
                sha256: string;
            }>;
        }>;
        storage: string;
        evidence: {
            schemaVersion: number;
            sequenceEncoding: string;
        };
        pagination: {
            operation: string;
            required: boolean;
            defaultLimit: number;
            maxLimit: number;
            cursor: string;
            consistency: string;
        };
        operations: ("usage.report" | "approvals.list" | "notifications.destinations" | "notifications.prepare" | "notifications.send" | "notifications.show" | "notifications.list" | "notifications.abort" | "notifications.automatic-status" | "notifications.automatic-show" | "notifications.automatic-list" | "runs.list" | "runs.start" | "runs.show" | "runs.inspect" | "runs.events" | "runs.export" | "runs.advance" | "runs.cancel" | "approvals.show" | "approvals.decide" | "reviewers.issue" | "release.info" | "release.check" | "reviewers.show" | "reviewers.revoke")[];
        dependencies: {
            desktop: boolean;
            harness: boolean;
            skill: boolean;
            docker: boolean;
        };
        authoring: boolean;
        providerConfiguration: boolean;
        htmlPreview: boolean;
        operatorHtml: boolean;
        remoteAccess: boolean;
        telemetryExport: string;
        telemetryProtocols: string[];
        telemetrySignals: string[];
        runtimeWorkTelemetry: {
            option: string;
            default: boolean;
            configuration: string;
            requires: string[];
            signal: string;
            owners: string[];
            traceSampling: string;
            source: string;
            pointLabels: boolean;
            collection: string[];
            instruments: {
                name: string;
                kind: string;
                unit: string;
                meaning: string;
            }[];
            unavailable: string;
            countSemantics: string;
            reopen: string;
            exclusions: string[];
        };
        httpAsyncCapacityTelemetry: {
            option: string;
            default: boolean;
            configuration: string;
            requires: string[];
            signal: string;
            owners: string[];
            traceSampling: string;
            source: string;
            instrument: {
                name: string;
                kind: string;
                unit: string;
                temporality: string;
                monotonic: boolean;
            };
            pointLabels: {
                'jevable.http.async.phase': string[];
            };
            phases: {
                admitting: string;
                completing: string;
            };
            collection: string[];
            countSemantics: string;
            reopen: string;
            exclusions: string[];
        };
        httpResponseContextTelemetry: {
            option: string;
            default: boolean;
            configuration: string;
            requires: string[];
            header: string;
            format: string;
            context: string;
            owners: string[];
            services: string[];
            disclosures: string[];
            authentication: string;
            readsAndRefusals: string;
            metricLabels: string;
            exclusions: string[];
        };
        httpAccessTelemetry: {
            option: string;
            default: boolean;
            configuration: string;
            owners: string[];
            services: string[];
            stages: ("protocol" | "headers" | "owner-key" | "preview-session" | "local-bootstrap" | "grant-token-syntax" | "instance" | "release-pin" | "signed-webhook" | "local-rate-requests" | "local-rate-controls" | "coordinated-rate-requests" | "coordinated-rate-controls")[];
            outcomes: string[];
            span: string;
            log: string;
            context: string;
            quotaCorrelation: string;
            metrics: string[];
            pointLabels: string[];
            countSemantics: string;
            coordinatedSql: {
                operations: ("begin" | "lock" | "debit" | "commit" | "rollback")[];
                outcomes: string[];
                span: string;
                log: string;
                metrics: string[];
                pointLabels: string[];
                context: string;
                semantics: string;
            };
            exclusions: string[];
        };
        authentication: string;
        reviewerAccess: boolean | {
            enabled: boolean;
            requestPage: string;
            scope: string;
            actions: string;
            tokenStorage: string;
            ownerTokenShared: boolean;
        };
        approvalNotifications: {
            scope: string;
            delivery: string;
            automaticDelivery: boolean;
            eventKinds: string[];
            history: string;
            historyFilters: string;
            configuration: string;
        };
        execution: string;
    };
    private matches;
    private scopedRun;
    /** Delegated browser/API reads use their own bearer and never enter owner operations. */
    reviewerRequest(token: string): Promise<{
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
    }>;
    reviewerDecision(token: string, request: ReviewerDecisionRequest, context: ReviewerDecisionContext): Promise<import("../access/reviewer.ts").ReviewerDecisionReceipt>;
    operation(value: unknown): Promise<unknown>;
}
export {};

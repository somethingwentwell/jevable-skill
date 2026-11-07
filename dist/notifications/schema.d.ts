import { z } from 'zod';
import { type LocalRun } from '../runtime/run-types.ts';
export declare const approvalNotificationKind: z.ZodEnum<{
    cancelled: "cancelled";
    expired: "expired";
    requested: "requested";
    decided: "decided";
}>;
export declare const approvalNotificationPinSchema: z.ZodObject<{
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
export type ApprovalNotificationPin = z.infer<typeof approvalNotificationPinSchema>;
export declare const notificationEndpointSchema: z.ZodObject<{
    id: z.ZodString;
    url: z.ZodString;
    credentialRef: z.ZodString;
    timeoutMs: z.ZodNumber;
}, z.core.$strict>;
export type NotificationEndpoint = z.infer<typeof notificationEndpointSchema>;
export declare const approvalNotificationEventSchema: z.ZodObject<{
    specversion: z.ZodLiteral<"1.0">;
    id: z.ZodString;
    source: z.ZodLiteral<"urn:jevable:workflow-runtime">;
    type: z.ZodEnum<{
        "ai.jevable.approval.requested": "ai.jevable.approval.requested";
        "ai.jevable.approval.decided": "ai.jevable.approval.decided";
        "ai.jevable.approval.expired": "ai.jevable.approval.expired";
        "ai.jevable.approval.cancelled": "ai.jevable.approval.cancelled";
    }>;
    time: z.ZodISODateTime;
    datacontenttype: z.ZodLiteral<"application/json">;
    data: z.ZodObject<{
        runId: z.ZodUUID;
        revision: z.ZodString;
        attemptId: z.ZodUUID;
        nodeId: z.ZodString;
        expiresAt: z.ZodISODateTime;
        scope: z.ZodOptional<z.ZodObject<{
            loop: z.ZodPipe<z.ZodString, z.ZodTransform<import("../index.ts").NodeId, string>>;
            index: z.ZodNumber;
        }, z.core.$strict>>;
        loopExpiresAt: z.ZodOptional<z.ZodISODateTime>;
        release: z.ZodOptional<z.ZodObject<{
            id: z.ZodUUID;
            sha256: z.ZodString;
        }, z.core.$strict>>;
        project: z.ZodOptional<z.ZodObject<{
            id: z.ZodUUID;
            generation: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>;
}, z.core.$strict>;
export type ApprovalNotificationEvent = z.infer<typeof approvalNotificationEventSchema>;
export declare const notificationRequestSchema: z.ZodObject<{
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
export type NotificationRequest = z.infer<typeof notificationRequestSchema>;
export declare function notificationRequestPin({ runId, revision, attemptId, eventKind }: ApprovalNotificationPin): ApprovalNotificationPin;
export declare const notificationResultSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    status: z.ZodLiteral<"accepted">;
    httpStatus: z.ZodNumber;
}, z.core.$strict>, z.ZodObject<{
    status: z.ZodLiteral<"rejected">;
    httpStatus: z.ZodNumber;
}, z.core.$strict>, z.ZodObject<{
    status: z.ZodLiteral<"uncertain">;
    reason: z.ZodEnum<{
        "invalid-response": "invalid-response";
        timeout: "timeout";
        transport: "transport";
        aborted: "aborted";
    }>;
}, z.core.$strict>], "status">;
export type NotificationResult = z.infer<typeof notificationResultSchema>;
export declare const notificationTelemetrySchema: z.ZodObject<{
    trace: z.ZodObject<{
        traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableTraceId, string>>;
        spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableSpanId, string>>;
        traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
    }, z.core.$strict>;
    workflow: z.ZodOptional<z.ZodObject<{
        traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableTraceId, string>>;
        spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableSpanId, string>>;
        traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
    }, z.core.$strict>>;
    previous: z.ZodOptional<z.ZodObject<{
        traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableTraceId, string>>;
        spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableSpanId, string>>;
        traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
    }, z.core.$strict>>;
    parent: z.ZodOptional<z.ZodObject<{
        traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableTraceId, string>>;
        spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableSpanId, string>>;
        traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type NotificationTelemetry = z.infer<typeof notificationTelemetrySchema>;
export declare const notificationRecordSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
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
    event: z.ZodObject<{
        specversion: z.ZodLiteral<"1.0">;
        id: z.ZodString;
        source: z.ZodLiteral<"urn:jevable:workflow-runtime">;
        type: z.ZodEnum<{
            "ai.jevable.approval.requested": "ai.jevable.approval.requested";
            "ai.jevable.approval.decided": "ai.jevable.approval.decided";
            "ai.jevable.approval.expired": "ai.jevable.approval.expired";
            "ai.jevable.approval.cancelled": "ai.jevable.approval.cancelled";
        }>;
        time: z.ZodISODateTime;
        datacontenttype: z.ZodLiteral<"application/json">;
        data: z.ZodObject<{
            runId: z.ZodUUID;
            revision: z.ZodString;
            attemptId: z.ZodUUID;
            nodeId: z.ZodString;
            expiresAt: z.ZodISODateTime;
            scope: z.ZodOptional<z.ZodObject<{
                loop: z.ZodPipe<z.ZodString, z.ZodTransform<import("../index.ts").NodeId, string>>;
                index: z.ZodNumber;
            }, z.core.$strict>>;
            loopExpiresAt: z.ZodOptional<z.ZodISODateTime>;
            release: z.ZodOptional<z.ZodObject<{
                id: z.ZodUUID;
                sha256: z.ZodString;
            }, z.core.$strict>>;
            project: z.ZodOptional<z.ZodObject<{
                id: z.ZodUUID;
                generation: z.ZodNumber;
            }, z.core.$strict>>;
        }, z.core.$strict>;
    }, z.core.$strict>;
    actor: z.ZodString;
    createdAt: z.ZodISODateTime;
    credentialGeneration: z.ZodNumber;
    telemetry: z.ZodOptional<z.ZodObject<{
        trace: z.ZodObject<{
            traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableTraceId, string>>;
            spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableSpanId, string>>;
            traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
        }, z.core.$strict>;
        workflow: z.ZodOptional<z.ZodObject<{
            traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableTraceId, string>>;
            spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableSpanId, string>>;
            traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
        }, z.core.$strict>>;
        previous: z.ZodOptional<z.ZodObject<{
            traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableTraceId, string>>;
            spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableSpanId, string>>;
            traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
        }, z.core.$strict>>;
        parent: z.ZodOptional<z.ZodObject<{
            traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableTraceId, string>>;
            spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableSpanId, string>>;
            traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    outcome: z.ZodDiscriminatedUnion<[z.ZodObject<{
        status: z.ZodLiteral<"pending">;
    }, z.core.$strict>, z.ZodObject<{
        status: z.ZodLiteral<"settled">;
        at: z.ZodISODateTime;
        result: z.ZodDiscriminatedUnion<[z.ZodObject<{
            status: z.ZodLiteral<"accepted">;
            httpStatus: z.ZodNumber;
        }, z.core.$strict>, z.ZodObject<{
            status: z.ZodLiteral<"rejected">;
            httpStatus: z.ZodNumber;
        }, z.core.$strict>, z.ZodObject<{
            status: z.ZodLiteral<"uncertain">;
            reason: z.ZodEnum<{
                "invalid-response": "invalid-response";
                timeout: "timeout";
                transport: "transport";
                aborted: "aborted";
            }>;
        }, z.core.$strict>], "status">;
    }, z.core.$strict>], "status">;
}, z.core.$strict>;
export type NotificationRecord = z.infer<typeof notificationRecordSchema>;
export declare const notificationSemantics: "pending-is-not-proof-of-dispatch; HTTP-acceptance-is-not-human-delivery-or-approval";
export declare const notificationReceiptSchema: z.ZodObject<{
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
    schemaVersion: z.ZodLiteral<1>;
    createdAt: z.ZodISODateTime;
    event: z.ZodObject<{
        specversion: z.ZodLiteral<"1.0">;
        id: z.ZodString;
        source: z.ZodLiteral<"urn:jevable:workflow-runtime">;
        type: z.ZodEnum<{
            "ai.jevable.approval.requested": "ai.jevable.approval.requested";
            "ai.jevable.approval.decided": "ai.jevable.approval.decided";
            "ai.jevable.approval.expired": "ai.jevable.approval.expired";
            "ai.jevable.approval.cancelled": "ai.jevable.approval.cancelled";
        }>;
        time: z.ZodISODateTime;
        datacontenttype: z.ZodLiteral<"application/json">;
        data: z.ZodObject<{
            runId: z.ZodUUID;
            revision: z.ZodString;
            attemptId: z.ZodUUID;
            nodeId: z.ZodString;
            expiresAt: z.ZodISODateTime;
            scope: z.ZodOptional<z.ZodObject<{
                loop: z.ZodPipe<z.ZodString, z.ZodTransform<import("../index.ts").NodeId, string>>;
                index: z.ZodNumber;
            }, z.core.$strict>>;
            loopExpiresAt: z.ZodOptional<z.ZodISODateTime>;
            release: z.ZodOptional<z.ZodObject<{
                id: z.ZodUUID;
                sha256: z.ZodString;
            }, z.core.$strict>>;
            project: z.ZodOptional<z.ZodObject<{
                id: z.ZodUUID;
                generation: z.ZodNumber;
            }, z.core.$strict>>;
        }, z.core.$strict>;
    }, z.core.$strict>;
    credentialGeneration: z.ZodNumber;
    telemetry: z.ZodOptional<z.ZodObject<{
        trace: z.ZodObject<{
            traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableTraceId, string>>;
            spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableSpanId, string>>;
            traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
        }, z.core.$strict>;
        workflow: z.ZodOptional<z.ZodObject<{
            traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableTraceId, string>>;
            spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableSpanId, string>>;
            traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
        }, z.core.$strict>>;
        previous: z.ZodOptional<z.ZodObject<{
            traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableTraceId, string>>;
            spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableSpanId, string>>;
            traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
        }, z.core.$strict>>;
        parent: z.ZodOptional<z.ZodObject<{
            traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableTraceId, string>>;
            spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableSpanId, string>>;
            traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    outcome: z.ZodDiscriminatedUnion<[z.ZodObject<{
        status: z.ZodLiteral<"pending">;
    }, z.core.$strict>, z.ZodObject<{
        status: z.ZodLiteral<"settled">;
        at: z.ZodISODateTime;
        result: z.ZodDiscriminatedUnion<[z.ZodObject<{
            status: z.ZodLiteral<"accepted">;
            httpStatus: z.ZodNumber;
        }, z.core.$strict>, z.ZodObject<{
            status: z.ZodLiteral<"rejected">;
            httpStatus: z.ZodNumber;
        }, z.core.$strict>, z.ZodObject<{
            status: z.ZodLiteral<"uncertain">;
            reason: z.ZodEnum<{
                "invalid-response": "invalid-response";
                timeout: "timeout";
                transport: "transport";
                aborted: "aborted";
            }>;
        }, z.core.$strict>], "status">;
    }, z.core.$strict>], "status">;
    semantics: z.ZodLiteral<"pending-is-not-proof-of-dispatch; HTTP-acceptance-is-not-human-delivery-or-approval">;
}, z.core.$strict>;
export declare function notificationReceipt(value: NotificationRecord): {
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
                loop: import("../index.ts").NodeId;
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
            traceId: import("../runtime/run-trace.ts").JevableTraceId;
            spanId: import("../runtime/run-trace.ts").JevableSpanId;
            traceFlags: 0 | 1;
        };
        workflow?: {
            traceId: import("../runtime/run-trace.ts").JevableTraceId;
            spanId: import("../runtime/run-trace.ts").JevableSpanId;
            traceFlags: 0 | 1;
        } | undefined;
        previous?: {
            traceId: import("../runtime/run-trace.ts").JevableTraceId;
            spanId: import("../runtime/run-trace.ts").JevableSpanId;
            traceFlags: 0 | 1;
        } | undefined;
        parent?: {
            traceId: import("../runtime/run-trace.ts").JevableTraceId;
            spanId: import("../runtime/run-trace.ts").JevableSpanId;
            traceFlags: 0 | 1;
        } | undefined;
    } | undefined;
};
export declare const notificationAbortSemantics: "process-local-signal; inspect-retained-send-outcome; no-effect-retraction";
export declare const notificationAbortResultSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    requestId: z.ZodUUID;
    status: z.ZodEnum<{
        "abort-requested": "abort-requested";
        "not-active": "not-active";
    }>;
    receipt: z.ZodObject<{
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
        schemaVersion: z.ZodLiteral<1>;
        createdAt: z.ZodISODateTime;
        event: z.ZodObject<{
            specversion: z.ZodLiteral<"1.0">;
            id: z.ZodString;
            source: z.ZodLiteral<"urn:jevable:workflow-runtime">;
            type: z.ZodEnum<{
                "ai.jevable.approval.requested": "ai.jevable.approval.requested";
                "ai.jevable.approval.decided": "ai.jevable.approval.decided";
                "ai.jevable.approval.expired": "ai.jevable.approval.expired";
                "ai.jevable.approval.cancelled": "ai.jevable.approval.cancelled";
            }>;
            time: z.ZodISODateTime;
            datacontenttype: z.ZodLiteral<"application/json">;
            data: z.ZodObject<{
                runId: z.ZodUUID;
                revision: z.ZodString;
                attemptId: z.ZodUUID;
                nodeId: z.ZodString;
                expiresAt: z.ZodISODateTime;
                scope: z.ZodOptional<z.ZodObject<{
                    loop: z.ZodPipe<z.ZodString, z.ZodTransform<import("../index.ts").NodeId, string>>;
                    index: z.ZodNumber;
                }, z.core.$strict>>;
                loopExpiresAt: z.ZodOptional<z.ZodISODateTime>;
                release: z.ZodOptional<z.ZodObject<{
                    id: z.ZodUUID;
                    sha256: z.ZodString;
                }, z.core.$strict>>;
                project: z.ZodOptional<z.ZodObject<{
                    id: z.ZodUUID;
                    generation: z.ZodNumber;
                }, z.core.$strict>>;
            }, z.core.$strict>;
        }, z.core.$strict>;
        credentialGeneration: z.ZodNumber;
        telemetry: z.ZodOptional<z.ZodObject<{
            trace: z.ZodObject<{
                traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableTraceId, string>>;
                spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableSpanId, string>>;
                traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
            }, z.core.$strict>;
            workflow: z.ZodOptional<z.ZodObject<{
                traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableTraceId, string>>;
                spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableSpanId, string>>;
                traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
            }, z.core.$strict>>;
            previous: z.ZodOptional<z.ZodObject<{
                traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableTraceId, string>>;
                spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableSpanId, string>>;
                traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
            }, z.core.$strict>>;
            parent: z.ZodOptional<z.ZodObject<{
                traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableTraceId, string>>;
                spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableSpanId, string>>;
                traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        outcome: z.ZodDiscriminatedUnion<[z.ZodObject<{
            status: z.ZodLiteral<"pending">;
        }, z.core.$strict>, z.ZodObject<{
            status: z.ZodLiteral<"settled">;
            at: z.ZodISODateTime;
            result: z.ZodDiscriminatedUnion<[z.ZodObject<{
                status: z.ZodLiteral<"accepted">;
                httpStatus: z.ZodNumber;
            }, z.core.$strict>, z.ZodObject<{
                status: z.ZodLiteral<"rejected">;
                httpStatus: z.ZodNumber;
            }, z.core.$strict>, z.ZodObject<{
                status: z.ZodLiteral<"uncertain">;
                reason: z.ZodEnum<{
                    "invalid-response": "invalid-response";
                    timeout: "timeout";
                    transport: "transport";
                    aborted: "aborted";
                }>;
            }, z.core.$strict>], "status">;
        }, z.core.$strict>], "status">;
        semantics: z.ZodLiteral<"pending-is-not-proof-of-dispatch; HTTP-acceptance-is-not-human-delivery-or-approval">;
    }, z.core.$strict>;
    semantics: z.ZodLiteral<"process-local-signal; inspect-retained-send-outcome; no-effect-retraction">;
}, z.core.$strict>;
export type NotificationAbortResult = z.infer<typeof notificationAbortResultSchema>;
export declare const notificationSha256: (value: unknown) => string;
/** The host must supply a verified core read and its journal; this projection never exposes review payloads. */
export declare function requestedApprovalNotification(value: LocalRun, events: readonly {
    kind: string;
    at: string;
    data: unknown;
}[], pinValue: ApprovalNotificationPin): {
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
            loop: import("../index.ts").NodeId;
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
type ApprovalJournal = readonly {
    kind: string;
    at: string;
    data: unknown;
}[];
/** Recorded lifecycle only: no clock-driven expiry, approval decision, cancellation or workflow continuation. */
export declare function approvalLifecycleNotification(value: LocalRun, events: ApprovalJournal, pinValue: ApprovalNotificationPin): ApprovalNotificationEvent;
/** Only a requested event is a live-wait delivery; settled lifecycle events have no send-time approval deadline. */
export declare function notificationRequiresLiveWait(event: ApprovalNotificationEvent): boolean;
/** A loop wait cannot admit a new notification after either persisted deadline, even before settlement. */
export declare function notificationWaitExpired(event: ApprovalNotificationEvent, at?: number): boolean;
/** Associate retained delivery evidence with verified historical run evidence, even after a wait has settled.
 * Legacy journals lack expiresAt: their receipt retains the observed deadline, not an independent historical proof of it.
 */
export declare function verifyNotificationHistory(record: NotificationRecord, run: LocalRun, events: readonly {
    kind: string;
    at: string;
    data: unknown;
}[]): void;
/** Thin retained lifecycle evidence, shared by delivery receipts and automatic admission. Never expires or sends. */
export declare function verifyApprovalEventHistory(notification: ApprovalNotificationEvent, createdAt: string, run: LocalRun, events: readonly {
    kind: string;
    at: string;
    data: unknown;
}[], pin?: ApprovalNotificationPin): void;
/** Validate stored bytes and all cross-field pins before inspecting or reusing a delivery receipt. */
export declare function inspectNotificationRecord(value: unknown): NotificationRecord;
export {};

import { z } from 'zod';
import { type NotificationRecord } from './schema.ts';
export declare const notificationFilterSchema: z.ZodPipe<z.ZodObject<{
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
}>>;
export type NotificationFilter = z.input<typeof notificationFilterSchema>;
export declare const notificationKeysetPageRequestSchema: z.ZodObject<{
    after: z.ZodOptional<z.ZodUUID>;
    limit: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
export declare const notificationPageRequestSchema: z.ZodObject<{
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
export type NotificationPageRequest = z.input<typeof notificationPageRequestSchema>;
export declare const notificationSummarySchema: z.ZodObject<{
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
    createdAt: z.ZodISODateTime;
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
    trace: z.ZodOptional<z.ZodObject<{
        traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableTraceId, string>>;
        spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableSpanId, string>>;
        traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type NotificationSummary = z.infer<typeof notificationSummarySchema>;
export declare const notificationPageSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    deliveries: z.ZodArray<z.ZodObject<{
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
        createdAt: z.ZodISODateTime;
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
        trace: z.ZodOptional<z.ZodObject<{
            traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableTraceId, string>>;
            spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableSpanId, string>>;
            traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    nextCursor: z.ZodNullable<z.ZodUUID>;
    order: z.ZodLiteral<"request-id-ascending">;
    consistency: z.ZodLiteral<"live-keyset; not-a-snapshot">;
    semantics: z.ZodLiteral<"pending-is-not-proof-of-dispatch; HTTP-acceptance-is-not-human-delivery-or-approval">;
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
export type NotificationPage = z.infer<typeof notificationPageSchema>;
export declare function parseNotificationPage(value: NotificationPageRequest): {
    limit: number;
    after?: string | undefined;
    filter?: {
        outcome?: "accepted" | "pending" | "uncertain" | "rejected" | undefined;
        eventKind?: "cancelled" | "expired" | "requested" | "decided" | undefined;
        createdFrom?: string | undefined;
        createdBefore?: string | undefined;
    } | undefined;
};
/** Metadata only: no event body, actor, credential generation, signing material or private review data. */
export declare function notificationSummary(value: NotificationRecord): NotificationSummary;
/** Used on storage results and untrusted remote CLI replies. UUID order is identity order, never time order. */
export declare function inspectNotificationPage(value: unknown, request: NotificationPageRequest): NotificationPage;
export declare function notificationPage(records: NotificationRecord[], nextCursor: string | null, options: NotificationPageRequest): NotificationPage;
/** Thin retained metadata only. Creation time is admission time, not lifecycle time or delivery proof. */
export declare function notificationMatchesFilter(row: Pick<NotificationRecord, 'request' | 'createdAt' | 'outcome'>, filter: NotificationFilter | undefined): boolean;
export interface NotificationPageReader {
    get(id: string): NotificationRecord | undefined | Promise<NotificationRecord | undefined>;
    page(options: NotificationPageRequest): {
        records: NotificationRecord[];
        nextCursor: string | null;
    } | Promise<{
        records: NotificationRecord[];
        nextCursor: string | null;
    }>;
}
/** Bounded filtered live traversal. Cursors must still match the current query and optional scope. */
export declare function filteredNotificationRecords(reader: NotificationPageReader, pageValue: NotificationPageRequest, scopeMatches?: (record: NotificationRecord) => boolean): Promise<{
    records: {
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
        actor: string;
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
    }[];
    nextCursor: string;
} | {
    records: {
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
        actor: string;
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
    }[];
    nextCursor: null;
}>;

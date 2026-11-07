import { z } from 'zod';
import { type NotificationRecord } from './schema.ts';
import { type NotificationPageRequest } from './history.ts';
export declare const notificationProjectScopeSchema: z.ZodObject<{
    id: z.ZodUUID;
    generation: z.ZodNumber;
    revision: z.ZodString;
}, z.core.$strict>;
export type NotificationProjectScope = z.infer<typeof notificationProjectScopeSchema>;
export declare const projectNotificationPageSchema: z.ZodObject<{
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
    project: z.ZodObject<{
        id: z.ZodUUID;
        generation: z.ZodNumber;
        revision: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>;
export type ProjectNotificationPage = z.infer<typeof projectNotificationPageSchema>;
export declare function parseNotificationProjectScope(value: NotificationProjectScope): NotificationProjectScope;
/** Validate remote metadata and its explicit historical project pin, not today's project generation. */
export declare function inspectProjectNotificationPage(value: unknown, project: NotificationProjectScope, options: NotificationPageRequest): ProjectNotificationPage;
/** Bounded live keyset traversal; foreign identities are never returned as pagination cursors.
 * Event/run provenance is validated by the owner, not inferred from a current project lookup.
 */
export declare function projectNotificationRecords(reader: {
    get(id: string): NotificationRecord | undefined | Promise<NotificationRecord | undefined>;
    page(options: NotificationPageRequest): {
        records: NotificationRecord[];
        nextCursor: string | null;
    } | Promise<{
        records: NotificationRecord[];
        nextCursor: string | null;
    }>;
}, scopeValue: NotificationProjectScope, pageValue: NotificationPageRequest): Promise<{
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

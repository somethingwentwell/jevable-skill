import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { type NotificationRecord } from './schema.ts';
import type { NotificationPersistence } from './dispatcher.ts';
import { type NotificationPageRequest } from './history.ts';
/** Called only inside the owning runtime's explicit schema-initialization transaction. No independent connection/owner. */
export declare function initializeNotificationTables(db: DatabaseSync): void;
declare const policySchema: z.ZodObject<{
    maxDeliveries: z.ZodNumber;
    maxEvents: z.ZodNumber;
}, z.core.$strict>;
/** The caller must exclusively own this database and use one dispatcher. This store never acquires, closes or repairs an owner. */
export declare class SQLiteNotificationStore implements NotificationPersistence {
    private readonly db;
    private readonly policy;
    constructor(db: DatabaseSync, policy: z.infer<typeof policySchema>);
    private decode;
    private decodeRow;
    get(id: string): {
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
    } | undefined;
    page(value: NotificationPageRequest): {
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
        nextCursor: string | null;
    };
    private count;
    private atomic;
    createIntent(value: NotificationRecord): boolean;
    settle(value: NotificationRecord): void;
    /** Verify each stored snapshot against its two-entry maximum journal and predecessor chain on owner activation. */
    validate(checkHistory?: (record: NotificationRecord) => void): void;
}
export {};

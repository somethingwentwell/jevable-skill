import { z } from 'zod';
import { PostgresJournal } from '../storage/postgres.ts';
import { type NotificationRecord } from './schema.ts';
import type { NotificationPersistence } from './dispatcher.ts';
import { type NotificationPageRequest } from './history.ts';
declare const policySchema: z.ZodObject<{
    maxDeliveries: z.ZodNumber;
    maxEvents: z.ZodNumber;
}, z.core.$strict>;
/** One journal owner; all adapters share the domain queue. Never performs external effects inside that queue. */
export declare class PostgresNotificationStore implements NotificationPersistence {
    private readonly journal;
    private readonly checks;
    private readonly policy;
    constructor(journal: PostgresJournal, policy: z.infer<typeof policySchema>, checks?: {
        history?: (record: NotificationRecord) => Promise<void>;
        admission?: (record: NotificationRecord) => Promise<void>;
    });
    private owned;
    private read;
    private head;
    get(id: string): Promise<{
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
    } | undefined>;
    page(value: NotificationPageRequest): Promise<{
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
    }>;
    createIntent(value: NotificationRecord): Promise<boolean>;
    settle(value: NotificationRecord): Promise<void>;
    /** Bounded startup replay of evidence, never dispatch. Validate snapshots and predecessor heads against the full audit. */
    validate(): Promise<void>;
}
export {};

import { type NotificationRecord, type ApprovalNotificationPin, type ApprovalNotificationEvent, type NotificationEndpoint, type NotificationAbortResult } from './schema.ts';
import type { NotificationObservation } from './observation.ts';
/** Implementations need one exclusive owner and atomic create/settle plus an append-only audit journal. */
export interface NotificationPersistence {
    get(requestId: string): unknown | undefined | Promise<unknown | undefined>;
    /** Atomically admit a new request once. Enforce the latest event/endpoint predecessor; false means same ID already exists. */
    createIntent(record: NotificationRecord): boolean | Promise<boolean>;
    /** One pending-to-terminal transition with identical request/event/actor/createdAt; never overwrite settled history. */
    settle(record: NotificationRecord): void | Promise<void>;
}
export interface ApprovalNotificationHost {
    /** Must obtain the verified live wait or explicitly selected recorded lifecycle event. No execution. */
    requested(pin: ApprovalNotificationPin): ApprovalNotificationEvent | Promise<ApprovalNotificationEvent>;
    /** Resolve value and its retained generation atomically; never include the value in a record or response. */
    credential(reference: string): {
        value: string;
        generation: number;
    } | undefined | Promise<{
        value: string;
        generation: number;
    } | undefined>;
    readonly signal?: AbortSignal;
    /** Obtain checked workflow context without external effects. Optional instrumentation must never redispatch or settle a receipt. */
    observeNotification?(record: NotificationRecord, previous?: NotificationRecord): NotificationObservation | undefined | Promise<NotificationObservation | undefined>;
}
/** Internal shared engine; persistence adapters and operator-facing API/CLI integration remain separate. */
export declare class ApprovalNotificationDispatcher {
    private readonly host;
    private readonly persistence;
    private readonly endpoints;
    private readonly active;
    private readonly maxInFlight;
    constructor(host: ApprovalNotificationHost, persistence: NotificationPersistence, values: readonly NotificationEndpoint[], limits?: {
        maxInFlight?: number;
    });
    private endpoint;
    destinations(): {
        id: string;
        endpointSha256: string;
    }[];
    private event;
    /** Preparation is read-only and does not resolve credentials, dispatch, settle expiry or authorize sending. */
    prepare(pinValue: ApprovalNotificationPin, endpointId: string): Promise<{
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
        delivery: "not-attempted";
        runId: string;
        revision: string;
        attemptId: string;
        eventKind?: "cancelled" | "expired" | "requested" | "decided" | undefined;
    }>;
    inspect(requestId: string): Promise<{
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
    }>;
    /** Signal one currently owned delivery; retained pending intents after restart are not repaired or settled. */
    abort(requestId: string): Promise<NotificationAbortResult>;
    /** Explicit initial send or redelivery. Identical IDs read receipts, even after expiry or configuration removal. */
    send(value: unknown, actor: string, options?: {
        signal?: AbortSignal;
    }): Promise<NotificationRecord>;
}

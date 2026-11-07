/** Call inside the adapter's atomic admission transaction with the latest record for this event/endpoint pair. */
export declare function validateNotificationIntent(value: unknown, previousValue?: unknown): {
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
};
/** Call under the same atomic owner/CAS guard as persistence. A terminal receipt cannot be retargeted or rewritten. */
export declare function validateNotificationSettlement(previousValue: unknown, value: unknown): {
    record: {
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
    };
    changed: boolean;
};

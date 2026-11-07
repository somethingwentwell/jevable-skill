import type { LocalRun } from './run-types.ts';
/** Public owner receipt omits private source, inputs and intermediate node payloads. */
export declare function runReceipt(run: LocalRun): {
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
        nodeId: import("../index.ts").NodeId;
        scope: import("./run-evaluator.ts").LoopScope | {
            loop: import("../index.ts").NodeId;
            index: number;
        } | undefined;
        attemptId: import("./run-types.ts").JevableAttemptId | undefined;
    }[];
    nodeId?: import("../index.ts").NodeId;
    attemptId?: import("./run-types.ts").JevableAttemptId;
    recovery?: string;
    expiresAt?: string;
    code?: import("./run-evaluator.ts").RunFailureCode;
    output?: import("../index.ts").ReadonlyJsonValue;
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
        loop: import("../index.ts").NodeId;
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
        nodeId: import("../index.ts").NodeId;
        scope: import("./run-evaluator.ts").LoopScope | {
            loop: import("../index.ts").NodeId;
            index: number;
        } | undefined;
        attemptId: import("./run-types.ts").JevableAttemptId | undefined;
    }[];
    nodeId?: import("../index.ts").NodeId;
    attemptId?: import("./run-types.ts").JevableAttemptId;
    recovery?: string;
    expiresAt?: string;
    code?: import("./run-evaluator.ts").RunFailureCode;
    output?: import("../index.ts").ReadonlyJsonValue;
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
        loop: import("../index.ts").NodeId;
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

import type { LocalRun } from '../runtime/run-types.ts';
import type { TestCase } from './schema.ts';
/** Re-evaluate retained, verified evidence; never invokes models, resumes runs or writes state. */
export declare function testResult(test: TestCase, run: LocalRun, inspect?: boolean): {
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
        expected?: import("zod").JSONType;
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
                traceId: import("../runtime/run-trace.ts").JevableTraceId;
                spanId: import("../runtime/run-trace.ts").JevableSpanId;
                traceFlags: 0 | 1;
            };
            port?: string;
            nodeId: import("../index.ts").NodeId;
            scope: import("../runtime/run-evaluator.ts").LoopScope | {
                loop: import("../index.ts").NodeId;
                index: number;
            } | undefined;
            attemptId: import("../runtime/run-types.ts").JevableAttemptId | undefined;
        }[];
        nodeId?: import("../index.ts").NodeId;
        attemptId?: import("../runtime/run-types.ts").JevableAttemptId;
        recovery?: string;
        expiresAt?: string;
        code?: import("../runtime/run-evaluator.ts").RunFailureCode;
        output?: import("../index.ts").ReadonlyJsonValue;
        traceSegments?: {
            operation: "cancel" | "approval" | "run" | "resume";
            at: string;
            trace: {
                traceId: import("../runtime/run-trace.ts").JevableTraceId;
                spanId: import("../runtime/run-trace.ts").JevableSpanId;
                traceFlags: 0 | 1;
            };
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
            cause?: {
                kind: "cancellation";
                requestId: string;
                parent: {
                    traceId: import("../runtime/run-trace.ts").JevableTraceId;
                    spanId: import("../runtime/run-trace.ts").JevableSpanId;
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
                traceId: import("../runtime/run-trace.ts").JevableTraceId;
                spanId: import("../runtime/run-trace.ts").JevableSpanId;
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
        scope?: import("../runtime/run-evaluator.ts").LoopScope | {
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
        triggerMode?: import("../runtime/trigger.ts").ApiTriggerMode;
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
                traceId: import("../runtime/run-trace.ts").JevableTraceId;
                spanId: import("../runtime/run-trace.ts").JevableSpanId;
                traceFlags: 0 | 1;
            };
            port?: string;
            nodeId: import("../index.ts").NodeId;
            scope: import("../runtime/run-evaluator.ts").LoopScope | {
                loop: import("../index.ts").NodeId;
                index: number;
            } | undefined;
            attemptId: import("../runtime/run-types.ts").JevableAttemptId | undefined;
        }[];
        nodeId?: import("../index.ts").NodeId;
        attemptId?: import("../runtime/run-types.ts").JevableAttemptId;
        recovery?: string;
        expiresAt?: string;
        code?: import("../runtime/run-evaluator.ts").RunFailureCode;
        output?: import("../index.ts").ReadonlyJsonValue;
        traceSegments?: {
            operation: "cancel" | "approval" | "run" | "resume";
            at: string;
            trace: {
                traceId: import("../runtime/run-trace.ts").JevableTraceId;
                spanId: import("../runtime/run-trace.ts").JevableSpanId;
                traceFlags: 0 | 1;
            };
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
            cause?: {
                kind: "cancellation";
                requestId: string;
                parent: {
                    traceId: import("../runtime/run-trace.ts").JevableTraceId;
                    spanId: import("../runtime/run-trace.ts").JevableSpanId;
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
                traceId: import("../runtime/run-trace.ts").JevableTraceId;
                spanId: import("../runtime/run-trace.ts").JevableSpanId;
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
        scope?: import("../runtime/run-evaluator.ts").LoopScope | {
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
        triggerMode?: import("../runtime/trigger.ts").ApiTriggerMode;
        schemaVersion: number;
        id: string;
        revision: string;
        status: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
    };
};

import type { LocalRun } from './run-types.ts';
import type { PostgresRunEvent } from './postgres-reader.ts';
import type { ModelCallEvidence } from './model-evidence.ts';
/** A checked, coherent PostgreSQL observation. v2 preserves BIGINT IDs instead of changing v1's numeric contract. */
export declare function createPostgresRunEvidence(run: LocalRun, events: PostgresRunEvent[], recordVersion: string, includePrivate: boolean, modelCalls?: ModelCallEvidence[], usageIdentities?: boolean): {
    schemaVersion: 2;
    snapshot: {
        private?: {
            run: LocalRun;
            journal: PostgresRunEvent[];
        };
        schemaVersion: 2;
        storage: {
            kind: "postgres";
            recordVersion: string;
        };
        journal: ({
            sequence: string;
            version: string;
            triggerMode?: import("./trigger.ts").ApiTriggerMode;
            nodeId?: string | undefined;
            attemptId?: string | null | undefined;
            scope?: {
                loop: import("../index.ts").NodeId;
                index: number;
            } | null | undefined;
            trace?: {
                traceId: import("./run-trace.ts").JevableTraceId;
                spanId: import("./run-trace.ts").JevableSpanId;
                traceFlags: 0 | 1;
            } | undefined;
            status?: "completed" | "paused" | "failed" | "waiting" | "executing" | undefined;
            at: string;
            kind: "loop-timeout" | "approval-decided" | "approval-requested" | "execution-segment" | "execution-requested" | "cancellation-requested" | "node-intent" | "run-cancelled" | "breakpoint-hit" | "node-trace" | "node-result" | "run-created";
        } | {
            sequence: string;
            version: string;
            configurationRequestId: string;
            checkpointSha256: string;
            nodeId: import("../index.ts").NodeId;
            stepCount: number;
            at: string;
            scope?: {
                loop: import("../index.ts").NodeId;
                index: number;
            } | undefined;
            kind: "loop-timeout" | "approval-decided" | "approval-requested" | "execution-segment" | "execution-requested" | "cancellation-requested" | "node-intent" | "run-cancelled" | "breakpoint-hit" | "node-trace" | "node-result" | "run-created";
        } | {
            sequence: string;
            version: string;
            requestId: string;
            expectedCheckpointSha256: string;
            mode: "continue" | "step" | "pause" | "recover";
            breakpoints?: string[] | undefined;
            at: string;
            kind: "loop-timeout" | "approval-decided" | "approval-requested" | "execution-segment" | "execution-requested" | "cancellation-requested" | "node-intent" | "run-cancelled" | "breakpoint-hit" | "node-trace" | "node-result" | "run-created";
        } | {
            sequence: string;
            version: string;
            parent?: {
                traceId: import("./run-trace.ts").JevableTraceId;
                spanId: import("./run-trace.ts").JevableSpanId;
                traceFlags: 0 | 1;
            };
            previous?: {
                traceId: import("./run-trace.ts").JevableTraceId;
                spanId: import("./run-trace.ts").JevableSpanId;
                traceFlags: 0 | 1;
            };
            operation?: "cancel" | "approval" | "run" | "resume";
            trace?: {
                traceId: import("./run-trace.ts").JevableTraceId;
                spanId: import("./run-trace.ts").JevableSpanId;
                traceFlags: 0 | 1;
            } | undefined;
            routes?: {
                stepIndex: number;
                nodeId: string;
                port: string;
                scope?: {
                    loop: string;
                    index: number;
                } | undefined;
            }[];
            decision: {
                kind: "expired" | "action";
                at: string;
            };
            nodeId?: string | undefined;
            attemptId?: string | null | undefined;
            scope?: {
                loop: import("../index.ts").NodeId;
                index: number;
            } | null | undefined;
            status?: "completed" | "paused" | "failed" | "waiting" | "executing" | undefined;
            at: string;
            kind: "loop-timeout" | "approval-decided" | "approval-requested" | "execution-segment" | "execution-requested" | "cancellation-requested" | "node-intent" | "run-cancelled" | "breakpoint-hit" | "node-trace" | "node-result" | "run-created";
        } | {
            sequence: string;
            version: string;
            routes?: {
                stepIndex: number;
                nodeId: string;
                port: string;
                scope?: {
                    loop: string;
                    index: number;
                } | undefined;
            }[];
            nodeId?: string | undefined;
            attemptId?: string | null | undefined;
            scope?: {
                loop: import("../index.ts").NodeId;
                index: number;
            } | null | undefined;
            trace?: {
                traceId: import("./run-trace.ts").JevableTraceId;
                spanId: import("./run-trace.ts").JevableSpanId;
                traceFlags: 0 | 1;
            } | undefined;
            status?: "completed" | "paused" | "failed" | "waiting" | "executing" | undefined;
            at: string;
            kind: "loop-timeout" | "approval-decided" | "approval-requested" | "execution-segment" | "execution-requested" | "cancellation-requested" | "node-intent" | "run-cancelled" | "breakpoint-hit" | "node-trace" | "node-result" | "run-created";
        } | {
            sequence: string;
            version: string;
            traceParent?: {
                traceId: import("./run-trace.ts").JevableTraceId;
                spanId: import("./run-trace.ts").JevableSpanId;
                traceFlags: 0 | 1;
            };
            requestId: string;
            at: string;
            kind: "loop-timeout" | "approval-decided" | "approval-requested" | "execution-segment" | "execution-requested" | "cancellation-requested" | "node-intent" | "run-cancelled" | "breakpoint-hit" | "node-trace" | "node-result" | "run-created";
        } | {
            sequence: string;
            version: string;
            requestId: string;
            previousStatus: "paused" | "waiting" | "executing";
            next: string;
            attemptId: string | null;
            checkpointSha256: string;
            at: string;
            kind: "loop-timeout" | "approval-decided" | "approval-requested" | "execution-segment" | "execution-requested" | "cancellation-requested" | "node-intent" | "run-cancelled" | "breakpoint-hit" | "node-trace" | "node-result" | "run-created";
        } | {
            sequence: string;
            version: string;
            operation: "cancel" | "approval" | "run" | "resume";
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
            at: string;
            kind: "loop-timeout" | "approval-decided" | "approval-requested" | "execution-segment" | "execution-requested" | "cancellation-requested" | "node-intent" | "run-cancelled" | "breakpoint-hit" | "node-trace" | "node-result" | "run-created";
        })[];
        boundary: {
            sequenceEncoding: "decimal-int64";
            firstSequence: string;
            lastSequence: string;
            eventCount: number;
            consistency: string;
            terminal: boolean;
        };
        privacy: {
            payloads: string;
            actors: string;
            credentialStore: string;
            identifiers: string;
            modelIdentities?: "included-by-explicit-usage-request";
        };
        verification: {
            checkpoint: string;
            settledModels: string;
            authenticity: string;
            execution: string;
        };
        models?: {
            calls: ({
                evidence: "not-recorded";
                scope?: {
                    loop: import("../index.ts").NodeId;
                    index: number;
                };
                nodeId: import("../index.ts").NodeId;
                attemptId: import("./run-types.ts").JevableAttemptId;
            } | {
                policy?: {
                    kind: "transient-http-v1";
                    maxAttempts: number;
                    timeoutSeconds: number;
                };
                tries?: {
                    scheduledDelayMs?: number;
                    httpStatus?: number;
                    code?: "request-too-large" | "response-too-large" | "invalid-response" | "http-error" | "transport-error" | "timeout" | "cancelled";
                    settledAt?: string;
                    trace?: {
                        traceId: import("./run-trace.ts").JevableTraceId;
                        spanId: import("./run-trace.ts").JevableSpanId;
                        traceFlags: 0 | 1;
                    };
                    id: string;
                    number: number;
                    intentAt: string;
                    status: "completed" | "failed" | "pending";
                }[];
                usage?: {
                    tries: number;
                    inputTokens?: number | undefined;
                    outputTokens?: number | undefined;
                } | {
                    tries: 1;
                    inputTokens?: number | undefined;
                    outputTokens?: number | undefined;
                };
                code?: "request-too-large" | "response-too-large" | "invalid-response" | "http-error" | "transport-error" | "timeout" | "cancelled";
                settledAt?: string;
                status: "completed" | "failed" | "pending";
                usageIdentity?: {
                    provider: string;
                    model: string;
                };
                trace?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                };
                evidence: "recorded";
                evidenceSchemaVersion: 1 | 2;
                intentAt: string;
                scope?: {
                    loop: import("../index.ts").NodeId;
                    index: number;
                };
                nodeId: import("../index.ts").NodeId;
                attemptId: import("./run-types.ts").JevableAttemptId;
            })[];
            semantics: "intent-is-not-dispatch; settlement-is-not-workflow-completion; missing-is-not-proof-of-no-call";
            usageIdentities?: "requested-provider-model/v1";
            format: "jevable.model-history/v1";
            source: "configured-model-store";
        };
        format: "jevable.ai/run-evidence";
        run: {
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
            cancellation?: {
                traceParent?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                };
                id: string;
                at: string;
            };
            expiresAt?: string;
            attempt?: {
                trace?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                };
                id: import("./run-types.ts").JevableAttemptId;
                nodeId: import("../index.ts").NodeId;
            };
            previousStatus?: "paused" | "waiting" | "executing";
            externalEffects?: string;
            nodeId?: import("../index.ts").NodeId;
            code?: import("./run-evaluator.ts").RunFailureCode;
            failedAttempt?: {
                modelUsage?: {
                    tries: number;
                    inputTokens?: number | undefined;
                    outputTokens?: number | undefined;
                };
                durationMs?: number;
                startedAt?: string;
                trace?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                };
                attemptId?: import("./run-types.ts").JevableAttemptId;
            };
            scope?: import("./run-evaluator.ts").LoopScope | {
                loop: import("../index.ts").NodeId;
                index: number;
            };
            next?: import("../index.ts").NodeId;
            test?: {
                id: string;
                generation: number;
                sha256: string;
            };
            release?: {
                id: string;
                sha256: string;
            };
            project?: {
                id: string;
                generation: number;
            };
            startedPaused?: boolean;
            pause?: never;
            triggerMode?: import("./trigger.ts").ApiTriggerMode;
            id: string;
            revision: string;
            status: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
            createdAt: string;
            updatedAt: string;
        } | {
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
            cancellation?: {
                traceParent?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                };
                id: string;
                at: string;
            };
            expiresAt?: string;
            attempt?: {
                trace?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                };
                id: import("./run-types.ts").JevableAttemptId;
                nodeId: import("../index.ts").NodeId;
            };
            previousStatus?: "paused" | "waiting" | "executing";
            externalEffects?: string;
            nodeId?: import("../index.ts").NodeId;
            code?: import("./run-evaluator.ts").RunFailureCode;
            failedAttempt?: {
                modelUsage?: {
                    tries: number;
                    inputTokens?: number | undefined;
                    outputTokens?: number | undefined;
                };
                durationMs?: number;
                startedAt?: string;
                trace?: {
                    traceId: import("./run-trace.ts").JevableTraceId;
                    spanId: import("./run-trace.ts").JevableSpanId;
                    traceFlags: 0 | 1;
                };
                attemptId?: import("./run-types.ts").JevableAttemptId;
            };
            scope?: import("./run-evaluator.ts").LoopScope | {
                loop: import("../index.ts").NodeId;
                index: number;
            };
            next?: import("../index.ts").NodeId;
            test?: {
                id: string;
                generation: number;
                sha256: string;
            };
            release?: {
                id: string;
                sha256: string;
            };
            project?: {
                id: string;
                generation: number;
            };
            startedPaused?: boolean;
            pause: {
                requestId: string;
                at: string;
                status: string;
                execution: string;
            };
            triggerMode?: import("./trigger.ts").ApiTriggerMode;
            id: string;
            revision: string;
            status: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
            createdAt: string;
            updatedAt: string;
        };
        steps: {
            modelUsage?: {
                tries: number;
                inputTokens?: number | undefined;
                outputTokens?: number | undefined;
            };
            durationMs?: number;
            startedAt?: string;
            trace?: {
                traceId: import("./run-trace.ts").JevableTraceId;
                spanId: import("./run-trace.ts").JevableSpanId;
                traceFlags: 0 | 1;
            };
            attemptId?: import("./run-types.ts").JevableAttemptId;
            scope?: import("./run-evaluator.ts").LoopScope | {
                loop: import("../index.ts").NodeId;
                index: number;
            };
            port?: string;
            index: number;
            nodeId: import("../index.ts").NodeId;
        }[];
        nodeAttempts: {
            format: "jevable.node-attempts/v1";
            source: "retained-intents";
            numbering: "per-node-and-loop-scope";
            entries: {
                number: number;
                scope?: {
                    loop: import("../index.ts").NodeId;
                    index: number;
                };
                attemptId: string;
                nodeId: string;
            }[];
        };
    };
    checksum: {
        algorithm: "sha256";
        encoding: "JSON.stringify(snapshot)";
        value: string;
    };
};
export type PostgresRunEvidence = ReturnType<typeof createPostgresRunEvidence>;

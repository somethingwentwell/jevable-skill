import { z } from 'zod';
import type { Branded } from '../shared/brand.ts';
import type { JsonValue, NodeId } from '../workflow/index.ts';
import type { RunCheckpoint, RunWaiting } from './run-evaluator.ts';
import { runTrace } from './run-trace.ts';
export { runTrace } from './run-trace.ts';
export type { JevableTraceId, JevableSpanId } from './run-trace.ts';
export type JevableAttemptId = Branded<'JevableAttemptId'>;
export declare const nodeAttempt: z.ZodObject<{
    id: z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>;
    nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
    prepared: z.ZodDiscriminatedUnion<[z.ZodObject<{
        status: z.ZodLiteral<"ready">;
        input: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
    }, z.core.$strict>, z.ZodObject<{
        status: z.ZodLiteral<"invalid-node-value">;
    }, z.core.$strict>], "status">;
    trace: z.ZodOptional<z.ZodLazy<z.ZodObject<{
        traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
        spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
        traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
    }, z.core.$strict>>>;
}, z.core.$strict>;
export declare const approvalDecision: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"action">;
    action: z.ZodString;
    actor: z.ZodString;
    at: z.ZodISODateTime;
    delegation: z.ZodOptional<z.ZodObject<{
        requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        scope: z.ZodObject<{
            kind: z.ZodLiteral<"reviewer">;
            runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
            attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
            revision: z.ZodString;
            decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
        }, z.core.$strict>;
        deadline: z.ZodISODateTime;
        pauseAfter: z.ZodBoolean;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"expired">;
    at: z.ZodISODateTime;
}, z.core.$strict>], "kind">;
export declare const nodeInspection: z.ZodObject<{
    input: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
    trace: z.ZodOptional<z.ZodObject<{
        traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
        spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
        traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
    }, z.core.$strict>>;
    attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>>;
    modelOutput: z.ZodOptional<z.ZodString>;
    approval: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"action">;
        action: z.ZodString;
        actor: z.ZodString;
        at: z.ZodISODateTime;
        delegation: z.ZodOptional<z.ZodObject<{
            requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
            grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
            scope: z.ZodObject<{
                kind: z.ZodLiteral<"reviewer">;
                runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                revision: z.ZodString;
                decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
            }, z.core.$strict>;
            deadline: z.ZodISODateTime;
            pauseAfter: z.ZodBoolean;
        }, z.core.$strict>>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"expired">;
        at: z.ZodISODateTime;
    }, z.core.$strict>], "kind">>;
    startedAt: z.ZodOptional<z.ZodISODateTime>;
    durationMs: z.ZodOptional<z.ZodNumber>;
    modelUsage: z.ZodOptional<z.ZodObject<{
        tries: z.ZodNumber;
        inputTokens: z.ZodOptional<z.ZodNumber>;
        outputTokens: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const loopScope: z.ZodObject<{
    loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
    index: z.ZodNumber;
}, z.core.$strict>;
export declare const checkpointSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    steps: z.ZodArray<z.ZodObject<{
        nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        output: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
        port: z.ZodOptional<z.ZodString>;
        inspection: z.ZodOptional<z.ZodObject<{
            input: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
            trace: z.ZodOptional<z.ZodObject<{
                traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
            }, z.core.$strict>>;
            attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>>;
            modelOutput: z.ZodOptional<z.ZodString>;
            approval: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"action">;
                action: z.ZodString;
                actor: z.ZodString;
                at: z.ZodISODateTime;
                delegation: z.ZodOptional<z.ZodObject<{
                    requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    scope: z.ZodObject<{
                        kind: z.ZodLiteral<"reviewer">;
                        runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        revision: z.ZodString;
                        decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
                    }, z.core.$strict>;
                    deadline: z.ZodISODateTime;
                    pauseAfter: z.ZodBoolean;
                }, z.core.$strict>>;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"expired">;
                at: z.ZodISODateTime;
            }, z.core.$strict>], "kind">>;
            startedAt: z.ZodOptional<z.ZodISODateTime>;
            durationMs: z.ZodOptional<z.ZodNumber>;
            modelUsage: z.ZodOptional<z.ZodObject<{
                tries: z.ZodNumber;
                inputTokens: z.ZodOptional<z.ZodNumber>;
                outputTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        scope: z.ZodOptional<z.ZodObject<{
            loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            index: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    next: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
    scope: z.ZodOptional<z.ZodObject<{
        loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        index: z.ZodNumber;
    }, z.core.$strict>>;
    status: z.ZodLiteral<"paused">;
}, z.core.$strict>, z.ZodObject<{
    status: z.ZodLiteral<"completed">;
    steps: z.ZodArray<z.ZodObject<{
        nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        output: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
        port: z.ZodOptional<z.ZodString>;
        inspection: z.ZodOptional<z.ZodObject<{
            input: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
            trace: z.ZodOptional<z.ZodObject<{
                traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
            }, z.core.$strict>>;
            attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>>;
            modelOutput: z.ZodOptional<z.ZodString>;
            approval: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"action">;
                action: z.ZodString;
                actor: z.ZodString;
                at: z.ZodISODateTime;
                delegation: z.ZodOptional<z.ZodObject<{
                    requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    scope: z.ZodObject<{
                        kind: z.ZodLiteral<"reviewer">;
                        runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        revision: z.ZodString;
                        decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
                    }, z.core.$strict>;
                    deadline: z.ZodISODateTime;
                    pauseAfter: z.ZodBoolean;
                }, z.core.$strict>>;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"expired">;
                at: z.ZodISODateTime;
            }, z.core.$strict>], "kind">>;
            startedAt: z.ZodOptional<z.ZodISODateTime>;
            durationMs: z.ZodOptional<z.ZodNumber>;
            modelUsage: z.ZodOptional<z.ZodObject<{
                tries: z.ZodNumber;
                inputTokens: z.ZodOptional<z.ZodNumber>;
                outputTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        scope: z.ZodOptional<z.ZodObject<{
            loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            index: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    output: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
}, z.core.$strict>, z.ZodObject<{
    status: z.ZodLiteral<"failed">;
    steps: z.ZodArray<z.ZodObject<{
        nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        output: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
        port: z.ZodOptional<z.ZodString>;
        inspection: z.ZodOptional<z.ZodObject<{
            input: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
            trace: z.ZodOptional<z.ZodObject<{
                traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
            }, z.core.$strict>>;
            attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>>;
            modelOutput: z.ZodOptional<z.ZodString>;
            approval: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"action">;
                action: z.ZodString;
                actor: z.ZodString;
                at: z.ZodISODateTime;
                delegation: z.ZodOptional<z.ZodObject<{
                    requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    scope: z.ZodObject<{
                        kind: z.ZodLiteral<"reviewer">;
                        runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        revision: z.ZodString;
                        decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
                    }, z.core.$strict>;
                    deadline: z.ZodISODateTime;
                    pauseAfter: z.ZodBoolean;
                }, z.core.$strict>>;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"expired">;
                at: z.ZodISODateTime;
            }, z.core.$strict>], "kind">>;
            startedAt: z.ZodOptional<z.ZodISODateTime>;
            durationMs: z.ZodOptional<z.ZodNumber>;
            modelUsage: z.ZodOptional<z.ZodObject<{
                tries: z.ZodNumber;
                inputTokens: z.ZodOptional<z.ZodNumber>;
                outputTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        scope: z.ZodOptional<z.ZodObject<{
            loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            index: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
    code: z.ZodEnum<{
        "invalid-node-value": "invalid-node-value";
        "loop-limit": "loop-limit";
        "loop-timeout": "loop-timeout";
        "approval-rejected": "approval-rejected";
        "approval-expired": "approval-expired";
        "ai-budget": "ai-budget";
    }>;
    inspection: z.ZodOptional<z.ZodObject<{
        input: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
        trace: z.ZodOptional<z.ZodObject<{
            traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
            spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
            traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
        }, z.core.$strict>>;
        attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>>;
        modelOutput: z.ZodOptional<z.ZodString>;
        approval: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"action">;
            action: z.ZodString;
            actor: z.ZodString;
            at: z.ZodISODateTime;
            delegation: z.ZodOptional<z.ZodObject<{
                requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                scope: z.ZodObject<{
                    kind: z.ZodLiteral<"reviewer">;
                    runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    revision: z.ZodString;
                    decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
                }, z.core.$strict>;
                deadline: z.ZodISODateTime;
                pauseAfter: z.ZodBoolean;
            }, z.core.$strict>>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"expired">;
            at: z.ZodISODateTime;
        }, z.core.$strict>], "kind">>;
        startedAt: z.ZodOptional<z.ZodISODateTime>;
        durationMs: z.ZodOptional<z.ZodNumber>;
        modelUsage: z.ZodOptional<z.ZodObject<{
            tries: z.ZodNumber;
            inputTokens: z.ZodOptional<z.ZodNumber>;
            outputTokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    scope: z.ZodOptional<z.ZodObject<{
        loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        index: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strict>], "status">;
declare const cancelledState: z.ZodUnion<readonly [z.ZodObject<{
    steps: z.ZodArray<z.ZodObject<{
        nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        output: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
        port: z.ZodOptional<z.ZodString>;
        inspection: z.ZodOptional<z.ZodObject<{
            input: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
            trace: z.ZodOptional<z.ZodObject<{
                traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
            }, z.core.$strict>>;
            attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>>;
            modelOutput: z.ZodOptional<z.ZodString>;
            approval: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"action">;
                action: z.ZodString;
                actor: z.ZodString;
                at: z.ZodISODateTime;
                delegation: z.ZodOptional<z.ZodObject<{
                    requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    scope: z.ZodObject<{
                        kind: z.ZodLiteral<"reviewer">;
                        runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        revision: z.ZodString;
                        decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
                    }, z.core.$strict>;
                    deadline: z.ZodISODateTime;
                    pauseAfter: z.ZodBoolean;
                }, z.core.$strict>>;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"expired">;
                at: z.ZodISODateTime;
            }, z.core.$strict>], "kind">>;
            startedAt: z.ZodOptional<z.ZodISODateTime>;
            durationMs: z.ZodOptional<z.ZodNumber>;
            modelUsage: z.ZodOptional<z.ZodObject<{
                tries: z.ZodNumber;
                inputTokens: z.ZodOptional<z.ZodNumber>;
                outputTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        scope: z.ZodOptional<z.ZodObject<{
            loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            index: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    next: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
    scope: z.ZodOptional<z.ZodObject<{
        loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        index: z.ZodNumber;
    }, z.core.$strict>>;
    status: z.ZodLiteral<"cancelled">;
    previousStatus: z.ZodLiteral<"paused">;
}, z.core.$strict>, z.ZodObject<{
    attempt: z.ZodObject<{
        id: z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>;
        nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        prepared: z.ZodDiscriminatedUnion<[z.ZodObject<{
            status: z.ZodLiteral<"ready">;
            input: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
        }, z.core.$strict>, z.ZodObject<{
            status: z.ZodLiteral<"invalid-node-value">;
        }, z.core.$strict>], "status">;
        trace: z.ZodOptional<z.ZodLazy<z.ZodObject<{
            traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
            spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
            traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
        }, z.core.$strict>>>;
    }, z.core.$strict>;
    steps: z.ZodArray<z.ZodObject<{
        nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        output: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
        port: z.ZodOptional<z.ZodString>;
        inspection: z.ZodOptional<z.ZodObject<{
            input: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
            trace: z.ZodOptional<z.ZodObject<{
                traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
            }, z.core.$strict>>;
            attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>>;
            modelOutput: z.ZodOptional<z.ZodString>;
            approval: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"action">;
                action: z.ZodString;
                actor: z.ZodString;
                at: z.ZodISODateTime;
                delegation: z.ZodOptional<z.ZodObject<{
                    requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    scope: z.ZodObject<{
                        kind: z.ZodLiteral<"reviewer">;
                        runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        revision: z.ZodString;
                        decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
                    }, z.core.$strict>;
                    deadline: z.ZodISODateTime;
                    pauseAfter: z.ZodBoolean;
                }, z.core.$strict>>;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"expired">;
                at: z.ZodISODateTime;
            }, z.core.$strict>], "kind">>;
            startedAt: z.ZodOptional<z.ZodISODateTime>;
            durationMs: z.ZodOptional<z.ZodNumber>;
            modelUsage: z.ZodOptional<z.ZodObject<{
                tries: z.ZodNumber;
                inputTokens: z.ZodOptional<z.ZodNumber>;
                outputTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        scope: z.ZodOptional<z.ZodObject<{
            loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            index: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    next: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
    scope: z.ZodOptional<z.ZodObject<{
        loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        index: z.ZodNumber;
    }, z.core.$strict>>;
    status: z.ZodLiteral<"cancelled">;
    previousStatus: z.ZodLiteral<"executing">;
}, z.core.$strict>, z.ZodObject<{
    steps: z.ZodArray<z.ZodObject<{
        nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        output: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
        port: z.ZodOptional<z.ZodString>;
        inspection: z.ZodOptional<z.ZodObject<{
            input: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
            trace: z.ZodOptional<z.ZodObject<{
                traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
            }, z.core.$strict>>;
            attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>>;
            modelOutput: z.ZodOptional<z.ZodString>;
            approval: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"action">;
                action: z.ZodString;
                actor: z.ZodString;
                at: z.ZodISODateTime;
                delegation: z.ZodOptional<z.ZodObject<{
                    requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    scope: z.ZodObject<{
                        kind: z.ZodLiteral<"reviewer">;
                        runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        revision: z.ZodString;
                        decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
                    }, z.core.$strict>;
                    deadline: z.ZodISODateTime;
                    pauseAfter: z.ZodBoolean;
                }, z.core.$strict>>;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"expired">;
                at: z.ZodISODateTime;
            }, z.core.$strict>], "kind">>;
            startedAt: z.ZodOptional<z.ZodISODateTime>;
            durationMs: z.ZodOptional<z.ZodNumber>;
            modelUsage: z.ZodOptional<z.ZodObject<{
                tries: z.ZodNumber;
                inputTokens: z.ZodOptional<z.ZodNumber>;
                outputTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        scope: z.ZodOptional<z.ZodObject<{
            loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            index: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    next: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
    attempt: z.ZodObject<{
        id: z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>;
        nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        prepared: z.ZodDiscriminatedUnion<[z.ZodObject<{
            status: z.ZodLiteral<"ready">;
            input: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
        }, z.core.$strict>, z.ZodObject<{
            status: z.ZodLiteral<"invalid-node-value">;
        }, z.core.$strict>], "status">;
        trace: z.ZodOptional<z.ZodLazy<z.ZodObject<{
            traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
            spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
            traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
        }, z.core.$strict>>>;
    }, z.core.$strict>;
    expiresAt: z.ZodISODateTime;
    scope: z.ZodOptional<z.ZodObject<{
        loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        index: z.ZodNumber;
    }, z.core.$strict>>;
    status: z.ZodLiteral<"cancelled">;
    previousStatus: z.ZodLiteral<"waiting">;
}, z.core.$strict>]>;
export declare const cancellationRequest: z.ZodObject<{
    id: z.ZodUUID;
    actor: z.ZodString;
    at: z.ZodISODateTime;
    traceParent: z.ZodOptional<z.ZodObject<{
        traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
        spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
        traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
    }, z.core.$strict>>;
    delegation: z.ZodOptional<z.ZodObject<{
        grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        scope: z.ZodObject<{
            kind: z.ZodLiteral<"caller">;
            release: z.ZodObject<{
                id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                sha256: z.ZodString;
                revision: z.ZodString;
            }, z.core.$strict>;
            permissions: z.ZodPipe<z.ZodArray<z.ZodEnum<{
                start: "start";
                read: "read";
                control: "control";
                cancel: "cancel";
            }>>, z.ZodTransform<("start" | "read" | "control" | "cancel")[], ("start" | "read" | "control" | "cancel")[]>>;
        }, z.core.$strict>;
        deadline: z.ZodISODateTime;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const runtimeStateSchema: z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
    steps: z.ZodArray<z.ZodObject<{
        nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        output: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
        port: z.ZodOptional<z.ZodString>;
        inspection: z.ZodOptional<z.ZodObject<{
            input: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
            trace: z.ZodOptional<z.ZodObject<{
                traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
            }, z.core.$strict>>;
            attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>>;
            modelOutput: z.ZodOptional<z.ZodString>;
            approval: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"action">;
                action: z.ZodString;
                actor: z.ZodString;
                at: z.ZodISODateTime;
                delegation: z.ZodOptional<z.ZodObject<{
                    requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    scope: z.ZodObject<{
                        kind: z.ZodLiteral<"reviewer">;
                        runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        revision: z.ZodString;
                        decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
                    }, z.core.$strict>;
                    deadline: z.ZodISODateTime;
                    pauseAfter: z.ZodBoolean;
                }, z.core.$strict>>;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"expired">;
                at: z.ZodISODateTime;
            }, z.core.$strict>], "kind">>;
            startedAt: z.ZodOptional<z.ZodISODateTime>;
            durationMs: z.ZodOptional<z.ZodNumber>;
            modelUsage: z.ZodOptional<z.ZodObject<{
                tries: z.ZodNumber;
                inputTokens: z.ZodOptional<z.ZodNumber>;
                outputTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        scope: z.ZodOptional<z.ZodObject<{
            loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            index: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    next: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
    scope: z.ZodOptional<z.ZodObject<{
        loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        index: z.ZodNumber;
    }, z.core.$strict>>;
    status: z.ZodLiteral<"paused">;
}, z.core.$strict>, z.ZodObject<{
    status: z.ZodLiteral<"completed">;
    steps: z.ZodArray<z.ZodObject<{
        nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        output: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
        port: z.ZodOptional<z.ZodString>;
        inspection: z.ZodOptional<z.ZodObject<{
            input: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
            trace: z.ZodOptional<z.ZodObject<{
                traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
            }, z.core.$strict>>;
            attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>>;
            modelOutput: z.ZodOptional<z.ZodString>;
            approval: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"action">;
                action: z.ZodString;
                actor: z.ZodString;
                at: z.ZodISODateTime;
                delegation: z.ZodOptional<z.ZodObject<{
                    requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    scope: z.ZodObject<{
                        kind: z.ZodLiteral<"reviewer">;
                        runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        revision: z.ZodString;
                        decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
                    }, z.core.$strict>;
                    deadline: z.ZodISODateTime;
                    pauseAfter: z.ZodBoolean;
                }, z.core.$strict>>;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"expired">;
                at: z.ZodISODateTime;
            }, z.core.$strict>], "kind">>;
            startedAt: z.ZodOptional<z.ZodISODateTime>;
            durationMs: z.ZodOptional<z.ZodNumber>;
            modelUsage: z.ZodOptional<z.ZodObject<{
                tries: z.ZodNumber;
                inputTokens: z.ZodOptional<z.ZodNumber>;
                outputTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        scope: z.ZodOptional<z.ZodObject<{
            loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            index: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    output: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
}, z.core.$strict>, z.ZodObject<{
    status: z.ZodLiteral<"failed">;
    steps: z.ZodArray<z.ZodObject<{
        nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        output: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
        port: z.ZodOptional<z.ZodString>;
        inspection: z.ZodOptional<z.ZodObject<{
            input: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
            trace: z.ZodOptional<z.ZodObject<{
                traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
            }, z.core.$strict>>;
            attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>>;
            modelOutput: z.ZodOptional<z.ZodString>;
            approval: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"action">;
                action: z.ZodString;
                actor: z.ZodString;
                at: z.ZodISODateTime;
                delegation: z.ZodOptional<z.ZodObject<{
                    requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    scope: z.ZodObject<{
                        kind: z.ZodLiteral<"reviewer">;
                        runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        revision: z.ZodString;
                        decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
                    }, z.core.$strict>;
                    deadline: z.ZodISODateTime;
                    pauseAfter: z.ZodBoolean;
                }, z.core.$strict>>;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"expired">;
                at: z.ZodISODateTime;
            }, z.core.$strict>], "kind">>;
            startedAt: z.ZodOptional<z.ZodISODateTime>;
            durationMs: z.ZodOptional<z.ZodNumber>;
            modelUsage: z.ZodOptional<z.ZodObject<{
                tries: z.ZodNumber;
                inputTokens: z.ZodOptional<z.ZodNumber>;
                outputTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        scope: z.ZodOptional<z.ZodObject<{
            loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            index: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
    code: z.ZodEnum<{
        "invalid-node-value": "invalid-node-value";
        "loop-limit": "loop-limit";
        "loop-timeout": "loop-timeout";
        "approval-rejected": "approval-rejected";
        "approval-expired": "approval-expired";
        "ai-budget": "ai-budget";
    }>;
    inspection: z.ZodOptional<z.ZodObject<{
        input: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
        trace: z.ZodOptional<z.ZodObject<{
            traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
            spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
            traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
        }, z.core.$strict>>;
        attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>>;
        modelOutput: z.ZodOptional<z.ZodString>;
        approval: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"action">;
            action: z.ZodString;
            actor: z.ZodString;
            at: z.ZodISODateTime;
            delegation: z.ZodOptional<z.ZodObject<{
                requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                scope: z.ZodObject<{
                    kind: z.ZodLiteral<"reviewer">;
                    runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    revision: z.ZodString;
                    decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
                }, z.core.$strict>;
                deadline: z.ZodISODateTime;
                pauseAfter: z.ZodBoolean;
            }, z.core.$strict>>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"expired">;
            at: z.ZodISODateTime;
        }, z.core.$strict>], "kind">>;
        startedAt: z.ZodOptional<z.ZodISODateTime>;
        durationMs: z.ZodOptional<z.ZodNumber>;
        modelUsage: z.ZodOptional<z.ZodObject<{
            tries: z.ZodNumber;
            inputTokens: z.ZodOptional<z.ZodNumber>;
            outputTokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    scope: z.ZodOptional<z.ZodObject<{
        loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        index: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strict>], "status">, z.ZodObject<{
    attempt: z.ZodObject<{
        id: z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>;
        nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        prepared: z.ZodDiscriminatedUnion<[z.ZodObject<{
            status: z.ZodLiteral<"ready">;
            input: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
        }, z.core.$strict>, z.ZodObject<{
            status: z.ZodLiteral<"invalid-node-value">;
        }, z.core.$strict>], "status">;
        trace: z.ZodOptional<z.ZodLazy<z.ZodObject<{
            traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
            spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
            traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
        }, z.core.$strict>>>;
    }, z.core.$strict>;
    steps: z.ZodArray<z.ZodObject<{
        nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        output: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
        port: z.ZodOptional<z.ZodString>;
        inspection: z.ZodOptional<z.ZodObject<{
            input: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
            trace: z.ZodOptional<z.ZodObject<{
                traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
            }, z.core.$strict>>;
            attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>>;
            modelOutput: z.ZodOptional<z.ZodString>;
            approval: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"action">;
                action: z.ZodString;
                actor: z.ZodString;
                at: z.ZodISODateTime;
                delegation: z.ZodOptional<z.ZodObject<{
                    requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    scope: z.ZodObject<{
                        kind: z.ZodLiteral<"reviewer">;
                        runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        revision: z.ZodString;
                        decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
                    }, z.core.$strict>;
                    deadline: z.ZodISODateTime;
                    pauseAfter: z.ZodBoolean;
                }, z.core.$strict>>;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"expired">;
                at: z.ZodISODateTime;
            }, z.core.$strict>], "kind">>;
            startedAt: z.ZodOptional<z.ZodISODateTime>;
            durationMs: z.ZodOptional<z.ZodNumber>;
            modelUsage: z.ZodOptional<z.ZodObject<{
                tries: z.ZodNumber;
                inputTokens: z.ZodOptional<z.ZodNumber>;
                outputTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        scope: z.ZodOptional<z.ZodObject<{
            loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            index: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    next: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
    scope: z.ZodOptional<z.ZodObject<{
        loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        index: z.ZodNumber;
    }, z.core.$strict>>;
    status: z.ZodLiteral<"executing">;
}, z.core.$strict>, z.ZodObject<{
    status: z.ZodLiteral<"waiting">;
    steps: z.ZodArray<z.ZodObject<{
        nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        output: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
        port: z.ZodOptional<z.ZodString>;
        inspection: z.ZodOptional<z.ZodObject<{
            input: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
            trace: z.ZodOptional<z.ZodObject<{
                traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
            }, z.core.$strict>>;
            attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>>;
            modelOutput: z.ZodOptional<z.ZodString>;
            approval: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"action">;
                action: z.ZodString;
                actor: z.ZodString;
                at: z.ZodISODateTime;
                delegation: z.ZodOptional<z.ZodObject<{
                    requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    scope: z.ZodObject<{
                        kind: z.ZodLiteral<"reviewer">;
                        runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        revision: z.ZodString;
                        decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
                    }, z.core.$strict>;
                    deadline: z.ZodISODateTime;
                    pauseAfter: z.ZodBoolean;
                }, z.core.$strict>>;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"expired">;
                at: z.ZodISODateTime;
            }, z.core.$strict>], "kind">>;
            startedAt: z.ZodOptional<z.ZodISODateTime>;
            durationMs: z.ZodOptional<z.ZodNumber>;
            modelUsage: z.ZodOptional<z.ZodObject<{
                tries: z.ZodNumber;
                inputTokens: z.ZodOptional<z.ZodNumber>;
                outputTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        scope: z.ZodOptional<z.ZodObject<{
            loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            index: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    next: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
    attempt: z.ZodObject<{
        id: z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>;
        nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        prepared: z.ZodDiscriminatedUnion<[z.ZodObject<{
            status: z.ZodLiteral<"ready">;
            input: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
        }, z.core.$strict>, z.ZodObject<{
            status: z.ZodLiteral<"invalid-node-value">;
        }, z.core.$strict>], "status">;
        trace: z.ZodOptional<z.ZodLazy<z.ZodObject<{
            traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
            spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
            traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
        }, z.core.$strict>>>;
    }, z.core.$strict>;
    expiresAt: z.ZodISODateTime;
    scope: z.ZodOptional<z.ZodObject<{
        loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        index: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodUnion<readonly [z.ZodObject<{
    steps: z.ZodArray<z.ZodObject<{
        nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        output: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
        port: z.ZodOptional<z.ZodString>;
        inspection: z.ZodOptional<z.ZodObject<{
            input: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
            trace: z.ZodOptional<z.ZodObject<{
                traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
            }, z.core.$strict>>;
            attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>>;
            modelOutput: z.ZodOptional<z.ZodString>;
            approval: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"action">;
                action: z.ZodString;
                actor: z.ZodString;
                at: z.ZodISODateTime;
                delegation: z.ZodOptional<z.ZodObject<{
                    requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    scope: z.ZodObject<{
                        kind: z.ZodLiteral<"reviewer">;
                        runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        revision: z.ZodString;
                        decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
                    }, z.core.$strict>;
                    deadline: z.ZodISODateTime;
                    pauseAfter: z.ZodBoolean;
                }, z.core.$strict>>;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"expired">;
                at: z.ZodISODateTime;
            }, z.core.$strict>], "kind">>;
            startedAt: z.ZodOptional<z.ZodISODateTime>;
            durationMs: z.ZodOptional<z.ZodNumber>;
            modelUsage: z.ZodOptional<z.ZodObject<{
                tries: z.ZodNumber;
                inputTokens: z.ZodOptional<z.ZodNumber>;
                outputTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        scope: z.ZodOptional<z.ZodObject<{
            loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            index: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    next: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
    scope: z.ZodOptional<z.ZodObject<{
        loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        index: z.ZodNumber;
    }, z.core.$strict>>;
    status: z.ZodLiteral<"cancelled">;
    previousStatus: z.ZodLiteral<"paused">;
}, z.core.$strict>, z.ZodObject<{
    attempt: z.ZodObject<{
        id: z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>;
        nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        prepared: z.ZodDiscriminatedUnion<[z.ZodObject<{
            status: z.ZodLiteral<"ready">;
            input: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
        }, z.core.$strict>, z.ZodObject<{
            status: z.ZodLiteral<"invalid-node-value">;
        }, z.core.$strict>], "status">;
        trace: z.ZodOptional<z.ZodLazy<z.ZodObject<{
            traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
            spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
            traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
        }, z.core.$strict>>>;
    }, z.core.$strict>;
    steps: z.ZodArray<z.ZodObject<{
        nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        output: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
        port: z.ZodOptional<z.ZodString>;
        inspection: z.ZodOptional<z.ZodObject<{
            input: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
            trace: z.ZodOptional<z.ZodObject<{
                traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
            }, z.core.$strict>>;
            attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>>;
            modelOutput: z.ZodOptional<z.ZodString>;
            approval: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"action">;
                action: z.ZodString;
                actor: z.ZodString;
                at: z.ZodISODateTime;
                delegation: z.ZodOptional<z.ZodObject<{
                    requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    scope: z.ZodObject<{
                        kind: z.ZodLiteral<"reviewer">;
                        runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        revision: z.ZodString;
                        decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
                    }, z.core.$strict>;
                    deadline: z.ZodISODateTime;
                    pauseAfter: z.ZodBoolean;
                }, z.core.$strict>>;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"expired">;
                at: z.ZodISODateTime;
            }, z.core.$strict>], "kind">>;
            startedAt: z.ZodOptional<z.ZodISODateTime>;
            durationMs: z.ZodOptional<z.ZodNumber>;
            modelUsage: z.ZodOptional<z.ZodObject<{
                tries: z.ZodNumber;
                inputTokens: z.ZodOptional<z.ZodNumber>;
                outputTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        scope: z.ZodOptional<z.ZodObject<{
            loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            index: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    next: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
    scope: z.ZodOptional<z.ZodObject<{
        loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        index: z.ZodNumber;
    }, z.core.$strict>>;
    status: z.ZodLiteral<"cancelled">;
    previousStatus: z.ZodLiteral<"executing">;
}, z.core.$strict>, z.ZodObject<{
    steps: z.ZodArray<z.ZodObject<{
        nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        output: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
        port: z.ZodOptional<z.ZodString>;
        inspection: z.ZodOptional<z.ZodObject<{
            input: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
            trace: z.ZodOptional<z.ZodObject<{
                traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
            }, z.core.$strict>>;
            attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>>;
            modelOutput: z.ZodOptional<z.ZodString>;
            approval: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"action">;
                action: z.ZodString;
                actor: z.ZodString;
                at: z.ZodISODateTime;
                delegation: z.ZodOptional<z.ZodObject<{
                    requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    scope: z.ZodObject<{
                        kind: z.ZodLiteral<"reviewer">;
                        runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        revision: z.ZodString;
                        decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
                    }, z.core.$strict>;
                    deadline: z.ZodISODateTime;
                    pauseAfter: z.ZodBoolean;
                }, z.core.$strict>>;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"expired">;
                at: z.ZodISODateTime;
            }, z.core.$strict>], "kind">>;
            startedAt: z.ZodOptional<z.ZodISODateTime>;
            durationMs: z.ZodOptional<z.ZodNumber>;
            modelUsage: z.ZodOptional<z.ZodObject<{
                tries: z.ZodNumber;
                inputTokens: z.ZodOptional<z.ZodNumber>;
                outputTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        scope: z.ZodOptional<z.ZodObject<{
            loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            index: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    next: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
    attempt: z.ZodObject<{
        id: z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>;
        nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        prepared: z.ZodDiscriminatedUnion<[z.ZodObject<{
            status: z.ZodLiteral<"ready">;
            input: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
        }, z.core.$strict>, z.ZodObject<{
            status: z.ZodLiteral<"invalid-node-value">;
        }, z.core.$strict>], "status">;
        trace: z.ZodOptional<z.ZodLazy<z.ZodObject<{
            traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
            spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
            traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
        }, z.core.$strict>>>;
    }, z.core.$strict>;
    expiresAt: z.ZodISODateTime;
    scope: z.ZodOptional<z.ZodObject<{
        loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        index: z.ZodNumber;
    }, z.core.$strict>>;
    status: z.ZodLiteral<"cancelled">;
    previousStatus: z.ZodLiteral<"waiting">;
}, z.core.$strict>]>]>;
export type JevableNodeAttempt = z.infer<typeof nodeAttempt>;
export type JevableNodeInspection = z.infer<typeof nodeInspection>;
export type JevableRunTrace = z.infer<typeof runTrace>;
export type JevableApprovalDecision = z.infer<typeof approvalDecision>;
export type RuntimeState = RunCheckpoint | RunWaiting | (Omit<Extract<RunCheckpoint, {
    status: 'paused';
}>, 'status'> & {
    status: 'executing';
    attempt: JevableNodeAttempt;
}) | z.infer<typeof cancelledState>;
/** Cancellation retains the exact last checkpoint/intent; it does not fabricate a settled attempt. */
export declare function stoppedCheckpoint(state: RuntimeState): Exclude<RuntimeState, {
    status: 'cancelled';
}>;
export declare function stoppedCheckpointHash(state: RuntimeState): string;
export declare const localRunSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    id: z.ZodUUID;
    revision: z.ZodString;
    yaml: z.ZodString;
    input: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
    createdAt: z.ZodISODateTime;
    updatedAt: z.ZodISODateTime;
    project: z.ZodOptional<z.ZodObject<{
        id: z.ZodUUID;
        generation: z.ZodNumber;
    }, z.core.$strict>>;
    release: z.ZodOptional<z.ZodObject<{
        id: z.ZodUUID;
        sha256: z.ZodString;
    }, z.core.$strict>>;
    test: z.ZodOptional<z.ZodObject<{
        id: z.ZodUUID;
        generation: z.ZodNumber;
        sha256: z.ZodString;
    }, z.core.$strict>>;
    caller: z.ZodOptional<z.ZodObject<{
        grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        actor: z.ZodString;
        at: z.ZodISODateTime;
        scope: z.ZodObject<{
            kind: z.ZodLiteral<"caller">;
            release: z.ZodObject<{
                id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                sha256: z.ZodString;
                revision: z.ZodString;
            }, z.core.$strict>;
            permissions: z.ZodPipe<z.ZodArray<z.ZodEnum<{
                start: "start";
                read: "read";
                control: "control";
                cancel: "cancel";
            }>>, z.ZodTransform<("start" | "read" | "control" | "cancel")[], ("start" | "read" | "control" | "cancel")[]>>;
        }, z.core.$strict>;
    }, z.core.$strict>>;
    triggerMode: z.ZodOptional<z.ZodLiteral<"api">>;
    cancellation: z.ZodOptional<z.ZodObject<{
        id: z.ZodUUID;
        actor: z.ZodString;
        at: z.ZodISODateTime;
        traceParent: z.ZodOptional<z.ZodObject<{
            traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
            spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
            traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
        }, z.core.$strict>>;
        delegation: z.ZodOptional<z.ZodObject<{
            grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
            scope: z.ZodObject<{
                kind: z.ZodLiteral<"caller">;
                release: z.ZodObject<{
                    id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    sha256: z.ZodString;
                    revision: z.ZodString;
                }, z.core.$strict>;
                permissions: z.ZodPipe<z.ZodArray<z.ZodEnum<{
                    start: "start";
                    read: "read";
                    control: "control";
                    cancel: "cancel";
                }>>, z.ZodTransform<("start" | "read" | "control" | "cancel")[], ("start" | "read" | "control" | "cancel")[]>>;
            }, z.core.$strict>;
            deadline: z.ZodISODateTime;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    startedPaused: z.ZodOptional<z.ZodLiteral<true>>;
    controlRequests: z.ZodOptional<z.ZodArray<z.ZodObject<{
        requestId: z.ZodUUID;
        expectedCheckpointSha256: z.ZodString;
        mode: z.ZodEnum<{
            continue: "continue";
            step: "step";
            pause: "pause";
            recover: "recover";
        }>;
        breakpoints: z.ZodOptional<z.ZodArray<z.ZodString>>;
        actor: z.ZodString;
        at: z.ZodISODateTime;
        delegation: z.ZodOptional<z.ZodObject<{
            grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
            scope: z.ZodObject<{
                kind: z.ZodLiteral<"caller">;
                release: z.ZodObject<{
                    id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    sha256: z.ZodString;
                    revision: z.ZodString;
                }, z.core.$strict>;
                permissions: z.ZodPipe<z.ZodArray<z.ZodEnum<{
                    start: "start";
                    read: "read";
                    control: "control";
                    cancel: "cancel";
                }>>, z.ZodTransform<("start" | "read" | "control" | "cancel")[], ("start" | "read" | "control" | "cancel")[]>>;
            }, z.core.$strict>;
            deadline: z.ZodISODateTime;
        }, z.core.$strict>>;
    }, z.core.$strict>>>;
    breakpointHits: z.ZodOptional<z.ZodArray<z.ZodObject<{
        configurationRequestId: z.ZodUUID;
        checkpointSha256: z.ZodString;
        nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        scope: z.ZodOptional<z.ZodObject<{
            loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            index: z.ZodNumber;
        }, z.core.$strict>>;
        stepCount: z.ZodNumber;
        at: z.ZodISODateTime;
    }, z.core.$strict>>>;
    traceSegments: z.ZodOptional<z.ZodArray<z.ZodObject<{
        operation: z.ZodEnum<{
            cancel: "cancel";
            approval: "approval";
            run: "run";
            resume: "resume";
        }>;
        at: z.ZodISODateTime;
        trace: z.ZodObject<{
            traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
            spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
            traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
        }, z.core.$strict>;
        previous: z.ZodOptional<z.ZodObject<{
            traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
            spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
            traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
        }, z.core.$strict>>;
        parent: z.ZodOptional<z.ZodObject<{
            traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
            spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
            traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
        }, z.core.$strict>>;
        cause: z.ZodOptional<z.ZodObject<{
            kind: z.ZodLiteral<"cancellation">;
            requestId: z.ZodUUID;
            parent: z.ZodObject<{
                traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
            }, z.core.$strict>;
        }, z.core.$strict>>;
    }, z.core.$strict>>>;
    state: z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
        steps: z.ZodArray<z.ZodObject<{
            nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            output: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
            port: z.ZodOptional<z.ZodString>;
            inspection: z.ZodOptional<z.ZodObject<{
                input: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
                trace: z.ZodOptional<z.ZodObject<{
                    traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                    spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                    traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
                }, z.core.$strict>>;
                attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>>;
                modelOutput: z.ZodOptional<z.ZodString>;
                approval: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                    kind: z.ZodLiteral<"action">;
                    action: z.ZodString;
                    actor: z.ZodString;
                    at: z.ZodISODateTime;
                    delegation: z.ZodOptional<z.ZodObject<{
                        requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        scope: z.ZodObject<{
                            kind: z.ZodLiteral<"reviewer">;
                            runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                            attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                            revision: z.ZodString;
                            decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
                        }, z.core.$strict>;
                        deadline: z.ZodISODateTime;
                        pauseAfter: z.ZodBoolean;
                    }, z.core.$strict>>;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"expired">;
                    at: z.ZodISODateTime;
                }, z.core.$strict>], "kind">>;
                startedAt: z.ZodOptional<z.ZodISODateTime>;
                durationMs: z.ZodOptional<z.ZodNumber>;
                modelUsage: z.ZodOptional<z.ZodObject<{
                    tries: z.ZodNumber;
                    inputTokens: z.ZodOptional<z.ZodNumber>;
                    outputTokens: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            scope: z.ZodOptional<z.ZodObject<{
                loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
                index: z.ZodNumber;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        next: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        scope: z.ZodOptional<z.ZodObject<{
            loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            index: z.ZodNumber;
        }, z.core.$strict>>;
        status: z.ZodLiteral<"paused">;
    }, z.core.$strict>, z.ZodObject<{
        status: z.ZodLiteral<"completed">;
        steps: z.ZodArray<z.ZodObject<{
            nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            output: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
            port: z.ZodOptional<z.ZodString>;
            inspection: z.ZodOptional<z.ZodObject<{
                input: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
                trace: z.ZodOptional<z.ZodObject<{
                    traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                    spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                    traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
                }, z.core.$strict>>;
                attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>>;
                modelOutput: z.ZodOptional<z.ZodString>;
                approval: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                    kind: z.ZodLiteral<"action">;
                    action: z.ZodString;
                    actor: z.ZodString;
                    at: z.ZodISODateTime;
                    delegation: z.ZodOptional<z.ZodObject<{
                        requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        scope: z.ZodObject<{
                            kind: z.ZodLiteral<"reviewer">;
                            runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                            attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                            revision: z.ZodString;
                            decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
                        }, z.core.$strict>;
                        deadline: z.ZodISODateTime;
                        pauseAfter: z.ZodBoolean;
                    }, z.core.$strict>>;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"expired">;
                    at: z.ZodISODateTime;
                }, z.core.$strict>], "kind">>;
                startedAt: z.ZodOptional<z.ZodISODateTime>;
                durationMs: z.ZodOptional<z.ZodNumber>;
                modelUsage: z.ZodOptional<z.ZodObject<{
                    tries: z.ZodNumber;
                    inputTokens: z.ZodOptional<z.ZodNumber>;
                    outputTokens: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            scope: z.ZodOptional<z.ZodObject<{
                loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
                index: z.ZodNumber;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        output: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
    }, z.core.$strict>, z.ZodObject<{
        status: z.ZodLiteral<"failed">;
        steps: z.ZodArray<z.ZodObject<{
            nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            output: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
            port: z.ZodOptional<z.ZodString>;
            inspection: z.ZodOptional<z.ZodObject<{
                input: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
                trace: z.ZodOptional<z.ZodObject<{
                    traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                    spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                    traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
                }, z.core.$strict>>;
                attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>>;
                modelOutput: z.ZodOptional<z.ZodString>;
                approval: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                    kind: z.ZodLiteral<"action">;
                    action: z.ZodString;
                    actor: z.ZodString;
                    at: z.ZodISODateTime;
                    delegation: z.ZodOptional<z.ZodObject<{
                        requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        scope: z.ZodObject<{
                            kind: z.ZodLiteral<"reviewer">;
                            runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                            attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                            revision: z.ZodString;
                            decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
                        }, z.core.$strict>;
                        deadline: z.ZodISODateTime;
                        pauseAfter: z.ZodBoolean;
                    }, z.core.$strict>>;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"expired">;
                    at: z.ZodISODateTime;
                }, z.core.$strict>], "kind">>;
                startedAt: z.ZodOptional<z.ZodISODateTime>;
                durationMs: z.ZodOptional<z.ZodNumber>;
                modelUsage: z.ZodOptional<z.ZodObject<{
                    tries: z.ZodNumber;
                    inputTokens: z.ZodOptional<z.ZodNumber>;
                    outputTokens: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            scope: z.ZodOptional<z.ZodObject<{
                loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
                index: z.ZodNumber;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        code: z.ZodEnum<{
            "invalid-node-value": "invalid-node-value";
            "loop-limit": "loop-limit";
            "loop-timeout": "loop-timeout";
            "approval-rejected": "approval-rejected";
            "approval-expired": "approval-expired";
            "ai-budget": "ai-budget";
        }>;
        inspection: z.ZodOptional<z.ZodObject<{
            input: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
            trace: z.ZodOptional<z.ZodObject<{
                traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
            }, z.core.$strict>>;
            attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>>;
            modelOutput: z.ZodOptional<z.ZodString>;
            approval: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"action">;
                action: z.ZodString;
                actor: z.ZodString;
                at: z.ZodISODateTime;
                delegation: z.ZodOptional<z.ZodObject<{
                    requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                    scope: z.ZodObject<{
                        kind: z.ZodLiteral<"reviewer">;
                        runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        revision: z.ZodString;
                        decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
                    }, z.core.$strict>;
                    deadline: z.ZodISODateTime;
                    pauseAfter: z.ZodBoolean;
                }, z.core.$strict>>;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"expired">;
                at: z.ZodISODateTime;
            }, z.core.$strict>], "kind">>;
            startedAt: z.ZodOptional<z.ZodISODateTime>;
            durationMs: z.ZodOptional<z.ZodNumber>;
            modelUsage: z.ZodOptional<z.ZodObject<{
                tries: z.ZodNumber;
                inputTokens: z.ZodOptional<z.ZodNumber>;
                outputTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        scope: z.ZodOptional<z.ZodObject<{
            loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            index: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>], "status">, z.ZodObject<{
        attempt: z.ZodObject<{
            id: z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>;
            nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            prepared: z.ZodDiscriminatedUnion<[z.ZodObject<{
                status: z.ZodLiteral<"ready">;
                input: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
            }, z.core.$strict>, z.ZodObject<{
                status: z.ZodLiteral<"invalid-node-value">;
            }, z.core.$strict>], "status">;
            trace: z.ZodOptional<z.ZodLazy<z.ZodObject<{
                traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
            }, z.core.$strict>>>;
        }, z.core.$strict>;
        steps: z.ZodArray<z.ZodObject<{
            nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            output: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
            port: z.ZodOptional<z.ZodString>;
            inspection: z.ZodOptional<z.ZodObject<{
                input: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
                trace: z.ZodOptional<z.ZodObject<{
                    traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                    spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                    traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
                }, z.core.$strict>>;
                attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>>;
                modelOutput: z.ZodOptional<z.ZodString>;
                approval: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                    kind: z.ZodLiteral<"action">;
                    action: z.ZodString;
                    actor: z.ZodString;
                    at: z.ZodISODateTime;
                    delegation: z.ZodOptional<z.ZodObject<{
                        requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        scope: z.ZodObject<{
                            kind: z.ZodLiteral<"reviewer">;
                            runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                            attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                            revision: z.ZodString;
                            decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
                        }, z.core.$strict>;
                        deadline: z.ZodISODateTime;
                        pauseAfter: z.ZodBoolean;
                    }, z.core.$strict>>;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"expired">;
                    at: z.ZodISODateTime;
                }, z.core.$strict>], "kind">>;
                startedAt: z.ZodOptional<z.ZodISODateTime>;
                durationMs: z.ZodOptional<z.ZodNumber>;
                modelUsage: z.ZodOptional<z.ZodObject<{
                    tries: z.ZodNumber;
                    inputTokens: z.ZodOptional<z.ZodNumber>;
                    outputTokens: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            scope: z.ZodOptional<z.ZodObject<{
                loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
                index: z.ZodNumber;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        next: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        scope: z.ZodOptional<z.ZodObject<{
            loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            index: z.ZodNumber;
        }, z.core.$strict>>;
        status: z.ZodLiteral<"executing">;
    }, z.core.$strict>, z.ZodObject<{
        status: z.ZodLiteral<"waiting">;
        steps: z.ZodArray<z.ZodObject<{
            nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            output: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
            port: z.ZodOptional<z.ZodString>;
            inspection: z.ZodOptional<z.ZodObject<{
                input: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
                trace: z.ZodOptional<z.ZodObject<{
                    traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                    spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                    traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
                }, z.core.$strict>>;
                attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>>;
                modelOutput: z.ZodOptional<z.ZodString>;
                approval: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                    kind: z.ZodLiteral<"action">;
                    action: z.ZodString;
                    actor: z.ZodString;
                    at: z.ZodISODateTime;
                    delegation: z.ZodOptional<z.ZodObject<{
                        requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        scope: z.ZodObject<{
                            kind: z.ZodLiteral<"reviewer">;
                            runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                            attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                            revision: z.ZodString;
                            decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
                        }, z.core.$strict>;
                        deadline: z.ZodISODateTime;
                        pauseAfter: z.ZodBoolean;
                    }, z.core.$strict>>;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"expired">;
                    at: z.ZodISODateTime;
                }, z.core.$strict>], "kind">>;
                startedAt: z.ZodOptional<z.ZodISODateTime>;
                durationMs: z.ZodOptional<z.ZodNumber>;
                modelUsage: z.ZodOptional<z.ZodObject<{
                    tries: z.ZodNumber;
                    inputTokens: z.ZodOptional<z.ZodNumber>;
                    outputTokens: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            scope: z.ZodOptional<z.ZodObject<{
                loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
                index: z.ZodNumber;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        next: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        attempt: z.ZodObject<{
            id: z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>;
            nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            prepared: z.ZodDiscriminatedUnion<[z.ZodObject<{
                status: z.ZodLiteral<"ready">;
                input: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
            }, z.core.$strict>, z.ZodObject<{
                status: z.ZodLiteral<"invalid-node-value">;
            }, z.core.$strict>], "status">;
            trace: z.ZodOptional<z.ZodLazy<z.ZodObject<{
                traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
            }, z.core.$strict>>>;
        }, z.core.$strict>;
        expiresAt: z.ZodISODateTime;
        scope: z.ZodOptional<z.ZodObject<{
            loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            index: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>, z.ZodUnion<readonly [z.ZodObject<{
        steps: z.ZodArray<z.ZodObject<{
            nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            output: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
            port: z.ZodOptional<z.ZodString>;
            inspection: z.ZodOptional<z.ZodObject<{
                input: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
                trace: z.ZodOptional<z.ZodObject<{
                    traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                    spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                    traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
                }, z.core.$strict>>;
                attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>>;
                modelOutput: z.ZodOptional<z.ZodString>;
                approval: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                    kind: z.ZodLiteral<"action">;
                    action: z.ZodString;
                    actor: z.ZodString;
                    at: z.ZodISODateTime;
                    delegation: z.ZodOptional<z.ZodObject<{
                        requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        scope: z.ZodObject<{
                            kind: z.ZodLiteral<"reviewer">;
                            runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                            attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                            revision: z.ZodString;
                            decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
                        }, z.core.$strict>;
                        deadline: z.ZodISODateTime;
                        pauseAfter: z.ZodBoolean;
                    }, z.core.$strict>>;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"expired">;
                    at: z.ZodISODateTime;
                }, z.core.$strict>], "kind">>;
                startedAt: z.ZodOptional<z.ZodISODateTime>;
                durationMs: z.ZodOptional<z.ZodNumber>;
                modelUsage: z.ZodOptional<z.ZodObject<{
                    tries: z.ZodNumber;
                    inputTokens: z.ZodOptional<z.ZodNumber>;
                    outputTokens: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            scope: z.ZodOptional<z.ZodObject<{
                loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
                index: z.ZodNumber;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        next: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        scope: z.ZodOptional<z.ZodObject<{
            loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            index: z.ZodNumber;
        }, z.core.$strict>>;
        status: z.ZodLiteral<"cancelled">;
        previousStatus: z.ZodLiteral<"paused">;
    }, z.core.$strict>, z.ZodObject<{
        attempt: z.ZodObject<{
            id: z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>;
            nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            prepared: z.ZodDiscriminatedUnion<[z.ZodObject<{
                status: z.ZodLiteral<"ready">;
                input: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
            }, z.core.$strict>, z.ZodObject<{
                status: z.ZodLiteral<"invalid-node-value">;
            }, z.core.$strict>], "status">;
            trace: z.ZodOptional<z.ZodLazy<z.ZodObject<{
                traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
            }, z.core.$strict>>>;
        }, z.core.$strict>;
        steps: z.ZodArray<z.ZodObject<{
            nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            output: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
            port: z.ZodOptional<z.ZodString>;
            inspection: z.ZodOptional<z.ZodObject<{
                input: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
                trace: z.ZodOptional<z.ZodObject<{
                    traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                    spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                    traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
                }, z.core.$strict>>;
                attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>>;
                modelOutput: z.ZodOptional<z.ZodString>;
                approval: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                    kind: z.ZodLiteral<"action">;
                    action: z.ZodString;
                    actor: z.ZodString;
                    at: z.ZodISODateTime;
                    delegation: z.ZodOptional<z.ZodObject<{
                        requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        scope: z.ZodObject<{
                            kind: z.ZodLiteral<"reviewer">;
                            runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                            attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                            revision: z.ZodString;
                            decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
                        }, z.core.$strict>;
                        deadline: z.ZodISODateTime;
                        pauseAfter: z.ZodBoolean;
                    }, z.core.$strict>>;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"expired">;
                    at: z.ZodISODateTime;
                }, z.core.$strict>], "kind">>;
                startedAt: z.ZodOptional<z.ZodISODateTime>;
                durationMs: z.ZodOptional<z.ZodNumber>;
                modelUsage: z.ZodOptional<z.ZodObject<{
                    tries: z.ZodNumber;
                    inputTokens: z.ZodOptional<z.ZodNumber>;
                    outputTokens: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            scope: z.ZodOptional<z.ZodObject<{
                loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
                index: z.ZodNumber;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        next: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        scope: z.ZodOptional<z.ZodObject<{
            loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            index: z.ZodNumber;
        }, z.core.$strict>>;
        status: z.ZodLiteral<"cancelled">;
        previousStatus: z.ZodLiteral<"executing">;
    }, z.core.$strict>, z.ZodObject<{
        steps: z.ZodArray<z.ZodObject<{
            nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            output: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
            port: z.ZodOptional<z.ZodString>;
            inspection: z.ZodOptional<z.ZodObject<{
                input: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
                trace: z.ZodOptional<z.ZodObject<{
                    traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                    spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                    traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
                }, z.core.$strict>>;
                attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>>;
                modelOutput: z.ZodOptional<z.ZodString>;
                approval: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                    kind: z.ZodLiteral<"action">;
                    action: z.ZodString;
                    actor: z.ZodString;
                    at: z.ZodISODateTime;
                    delegation: z.ZodOptional<z.ZodObject<{
                        requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                        scope: z.ZodObject<{
                            kind: z.ZodLiteral<"reviewer">;
                            runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                            attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                            revision: z.ZodString;
                            decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
                        }, z.core.$strict>;
                        deadline: z.ZodISODateTime;
                        pauseAfter: z.ZodBoolean;
                    }, z.core.$strict>>;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"expired">;
                    at: z.ZodISODateTime;
                }, z.core.$strict>], "kind">>;
                startedAt: z.ZodOptional<z.ZodISODateTime>;
                durationMs: z.ZodOptional<z.ZodNumber>;
                modelUsage: z.ZodOptional<z.ZodObject<{
                    tries: z.ZodNumber;
                    inputTokens: z.ZodOptional<z.ZodNumber>;
                    outputTokens: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            scope: z.ZodOptional<z.ZodObject<{
                loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
                index: z.ZodNumber;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        next: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        attempt: z.ZodObject<{
            id: z.ZodPipe<z.ZodUUID, z.ZodTransform<JevableAttemptId, string>>;
            nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            prepared: z.ZodDiscriminatedUnion<[z.ZodObject<{
                status: z.ZodLiteral<"ready">;
                input: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
            }, z.core.$strict>, z.ZodObject<{
                status: z.ZodLiteral<"invalid-node-value">;
            }, z.core.$strict>], "status">;
            trace: z.ZodOptional<z.ZodLazy<z.ZodObject<{
                traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
            }, z.core.$strict>>>;
        }, z.core.$strict>;
        expiresAt: z.ZodISODateTime;
        scope: z.ZodOptional<z.ZodObject<{
            loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            index: z.ZodNumber;
        }, z.core.$strict>>;
        status: z.ZodLiteral<"cancelled">;
        previousStatus: z.ZodLiteral<"waiting">;
    }, z.core.$strict>]>]>;
    loopDeadlines: z.ZodRecord<z.ZodString, z.ZodNumber>;
}, z.core.$strict>;
export type LocalRun = Omit<z.infer<typeof localRunSchema>, 'state'> & {
    state: RuntimeState;
};
/** Binds an explicit execution action to this run, checkpoint and last admitted control request. */
export declare function executionCheckpointHash(run: LocalRun): string;

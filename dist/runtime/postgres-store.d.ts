import { z } from 'zod';
import { PostgresJournal } from '../storage/postgres.ts';
import { type WorkflowCompilerLimits } from '../workflow/index.ts';
import { type LocalRun } from './run-types.ts';
import type { RetainedRunMetrics } from './retained-metrics.ts';
import { type ActivityProject } from './activity.ts';
import { type JournalConditions } from '../storage/conditions.ts';
import type { CommittedApprovalObserver } from '../notifications/automatic-owner.ts';
export type { PostgresRunEvent } from './postgres-reader.ts';
declare const writeSchema: z.ZodObject<{
    requestId: z.ZodUUID;
    expectedVersion: z.ZodString;
    record: z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        id: z.ZodUUID;
        revision: z.ZodString;
        yaml: z.ZodString;
        input: z.ZodType<import("../shared/values.ts").JsonValue, unknown, z.core.$ZodTypeInternals<import("../shared/values.ts").JsonValue, unknown>>;
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
            nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
            scope: z.ZodOptional<z.ZodObject<{
                loop: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
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
                nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
                output: z.ZodType<import("../shared/values.ts").JsonValue, unknown, z.core.$ZodTypeInternals<import("../shared/values.ts").JsonValue, unknown>>;
                port: z.ZodOptional<z.ZodString>;
                inspection: z.ZodOptional<z.ZodObject<{
                    input: z.ZodOptional<z.ZodType<import("../shared/values.ts").JsonValue, unknown, z.core.$ZodTypeInternals<import("../shared/values.ts").JsonValue, unknown>>>;
                    trace: z.ZodOptional<z.ZodObject<{
                        traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                        spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                        traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
                    }, z.core.$strict>>;
                    attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<import("./run-types.ts").JevableAttemptId, string>>>;
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
                    loop: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
                    index: z.ZodNumber;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            next: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
            scope: z.ZodOptional<z.ZodObject<{
                loop: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
                index: z.ZodNumber;
            }, z.core.$strict>>;
            status: z.ZodLiteral<"paused">;
        }, z.core.$strict>, z.ZodObject<{
            status: z.ZodLiteral<"completed">;
            steps: z.ZodArray<z.ZodObject<{
                nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
                output: z.ZodType<import("../shared/values.ts").JsonValue, unknown, z.core.$ZodTypeInternals<import("../shared/values.ts").JsonValue, unknown>>;
                port: z.ZodOptional<z.ZodString>;
                inspection: z.ZodOptional<z.ZodObject<{
                    input: z.ZodOptional<z.ZodType<import("../shared/values.ts").JsonValue, unknown, z.core.$ZodTypeInternals<import("../shared/values.ts").JsonValue, unknown>>>;
                    trace: z.ZodOptional<z.ZodObject<{
                        traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                        spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                        traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
                    }, z.core.$strict>>;
                    attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<import("./run-types.ts").JevableAttemptId, string>>>;
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
                    loop: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
                    index: z.ZodNumber;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            output: z.ZodType<import("../shared/values.ts").JsonValue, unknown, z.core.$ZodTypeInternals<import("../shared/values.ts").JsonValue, unknown>>;
        }, z.core.$strict>, z.ZodObject<{
            status: z.ZodLiteral<"failed">;
            steps: z.ZodArray<z.ZodObject<{
                nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
                output: z.ZodType<import("../shared/values.ts").JsonValue, unknown, z.core.$ZodTypeInternals<import("../shared/values.ts").JsonValue, unknown>>;
                port: z.ZodOptional<z.ZodString>;
                inspection: z.ZodOptional<z.ZodObject<{
                    input: z.ZodOptional<z.ZodType<import("../shared/values.ts").JsonValue, unknown, z.core.$ZodTypeInternals<import("../shared/values.ts").JsonValue, unknown>>>;
                    trace: z.ZodOptional<z.ZodObject<{
                        traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                        spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                        traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
                    }, z.core.$strict>>;
                    attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<import("./run-types.ts").JevableAttemptId, string>>>;
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
                    loop: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
                    index: z.ZodNumber;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
            code: z.ZodEnum<{
                "invalid-node-value": "invalid-node-value";
                "loop-limit": "loop-limit";
                "loop-timeout": "loop-timeout";
                "approval-rejected": "approval-rejected";
                "approval-expired": "approval-expired";
                "ai-budget": "ai-budget";
            }>;
            inspection: z.ZodOptional<z.ZodObject<{
                input: z.ZodOptional<z.ZodType<import("../shared/values.ts").JsonValue, unknown, z.core.$ZodTypeInternals<import("../shared/values.ts").JsonValue, unknown>>>;
                trace: z.ZodOptional<z.ZodObject<{
                    traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                    spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                    traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
                }, z.core.$strict>>;
                attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<import("./run-types.ts").JevableAttemptId, string>>>;
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
                loop: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
                index: z.ZodNumber;
            }, z.core.$strict>>;
        }, z.core.$strict>], "status">, z.ZodObject<{
            attempt: z.ZodObject<{
                id: z.ZodPipe<z.ZodUUID, z.ZodTransform<import("./run-types.ts").JevableAttemptId, string>>;
                nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
                prepared: z.ZodDiscriminatedUnion<[z.ZodObject<{
                    status: z.ZodLiteral<"ready">;
                    input: z.ZodType<import("../shared/values.ts").JsonValue, unknown, z.core.$ZodTypeInternals<import("../shared/values.ts").JsonValue, unknown>>;
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
                nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
                output: z.ZodType<import("../shared/values.ts").JsonValue, unknown, z.core.$ZodTypeInternals<import("../shared/values.ts").JsonValue, unknown>>;
                port: z.ZodOptional<z.ZodString>;
                inspection: z.ZodOptional<z.ZodObject<{
                    input: z.ZodOptional<z.ZodType<import("../shared/values.ts").JsonValue, unknown, z.core.$ZodTypeInternals<import("../shared/values.ts").JsonValue, unknown>>>;
                    trace: z.ZodOptional<z.ZodObject<{
                        traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                        spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                        traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
                    }, z.core.$strict>>;
                    attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<import("./run-types.ts").JevableAttemptId, string>>>;
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
                    loop: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
                    index: z.ZodNumber;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            next: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
            scope: z.ZodOptional<z.ZodObject<{
                loop: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
                index: z.ZodNumber;
            }, z.core.$strict>>;
            status: z.ZodLiteral<"executing">;
        }, z.core.$strict>, z.ZodObject<{
            status: z.ZodLiteral<"waiting">;
            steps: z.ZodArray<z.ZodObject<{
                nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
                output: z.ZodType<import("../shared/values.ts").JsonValue, unknown, z.core.$ZodTypeInternals<import("../shared/values.ts").JsonValue, unknown>>;
                port: z.ZodOptional<z.ZodString>;
                inspection: z.ZodOptional<z.ZodObject<{
                    input: z.ZodOptional<z.ZodType<import("../shared/values.ts").JsonValue, unknown, z.core.$ZodTypeInternals<import("../shared/values.ts").JsonValue, unknown>>>;
                    trace: z.ZodOptional<z.ZodObject<{
                        traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                        spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                        traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
                    }, z.core.$strict>>;
                    attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<import("./run-types.ts").JevableAttemptId, string>>>;
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
                    loop: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
                    index: z.ZodNumber;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            next: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
            attempt: z.ZodObject<{
                id: z.ZodPipe<z.ZodUUID, z.ZodTransform<import("./run-types.ts").JevableAttemptId, string>>;
                nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
                prepared: z.ZodDiscriminatedUnion<[z.ZodObject<{
                    status: z.ZodLiteral<"ready">;
                    input: z.ZodType<import("../shared/values.ts").JsonValue, unknown, z.core.$ZodTypeInternals<import("../shared/values.ts").JsonValue, unknown>>;
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
                loop: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
                index: z.ZodNumber;
            }, z.core.$strict>>;
        }, z.core.$strict>, z.ZodUnion<readonly [z.ZodObject<{
            steps: z.ZodArray<z.ZodObject<{
                nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
                output: z.ZodType<import("../shared/values.ts").JsonValue, unknown, z.core.$ZodTypeInternals<import("../shared/values.ts").JsonValue, unknown>>;
                port: z.ZodOptional<z.ZodString>;
                inspection: z.ZodOptional<z.ZodObject<{
                    input: z.ZodOptional<z.ZodType<import("../shared/values.ts").JsonValue, unknown, z.core.$ZodTypeInternals<import("../shared/values.ts").JsonValue, unknown>>>;
                    trace: z.ZodOptional<z.ZodObject<{
                        traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                        spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                        traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
                    }, z.core.$strict>>;
                    attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<import("./run-types.ts").JevableAttemptId, string>>>;
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
                    loop: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
                    index: z.ZodNumber;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            next: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
            scope: z.ZodOptional<z.ZodObject<{
                loop: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
                index: z.ZodNumber;
            }, z.core.$strict>>;
            status: z.ZodLiteral<"cancelled">;
            previousStatus: z.ZodLiteral<"paused">;
        }, z.core.$strict>, z.ZodObject<{
            attempt: z.ZodObject<{
                id: z.ZodPipe<z.ZodUUID, z.ZodTransform<import("./run-types.ts").JevableAttemptId, string>>;
                nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
                prepared: z.ZodDiscriminatedUnion<[z.ZodObject<{
                    status: z.ZodLiteral<"ready">;
                    input: z.ZodType<import("../shared/values.ts").JsonValue, unknown, z.core.$ZodTypeInternals<import("../shared/values.ts").JsonValue, unknown>>;
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
                nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
                output: z.ZodType<import("../shared/values.ts").JsonValue, unknown, z.core.$ZodTypeInternals<import("../shared/values.ts").JsonValue, unknown>>;
                port: z.ZodOptional<z.ZodString>;
                inspection: z.ZodOptional<z.ZodObject<{
                    input: z.ZodOptional<z.ZodType<import("../shared/values.ts").JsonValue, unknown, z.core.$ZodTypeInternals<import("../shared/values.ts").JsonValue, unknown>>>;
                    trace: z.ZodOptional<z.ZodObject<{
                        traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                        spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                        traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
                    }, z.core.$strict>>;
                    attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<import("./run-types.ts").JevableAttemptId, string>>>;
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
                    loop: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
                    index: z.ZodNumber;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            next: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
            scope: z.ZodOptional<z.ZodObject<{
                loop: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
                index: z.ZodNumber;
            }, z.core.$strict>>;
            status: z.ZodLiteral<"cancelled">;
            previousStatus: z.ZodLiteral<"executing">;
        }, z.core.$strict>, z.ZodObject<{
            steps: z.ZodArray<z.ZodObject<{
                nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
                output: z.ZodType<import("../shared/values.ts").JsonValue, unknown, z.core.$ZodTypeInternals<import("../shared/values.ts").JsonValue, unknown>>;
                port: z.ZodOptional<z.ZodString>;
                inspection: z.ZodOptional<z.ZodObject<{
                    input: z.ZodOptional<z.ZodType<import("../shared/values.ts").JsonValue, unknown, z.core.$ZodTypeInternals<import("../shared/values.ts").JsonValue, unknown>>>;
                    trace: z.ZodOptional<z.ZodObject<{
                        traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableTraceId, string>>;
                        spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./run-trace.ts").JevableSpanId, string>>;
                        traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
                    }, z.core.$strict>>;
                    attemptId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<import("./run-types.ts").JevableAttemptId, string>>>;
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
                    loop: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
                    index: z.ZodNumber;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            next: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
            attempt: z.ZodObject<{
                id: z.ZodPipe<z.ZodUUID, z.ZodTransform<import("./run-types.ts").JevableAttemptId, string>>;
                nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
                prepared: z.ZodDiscriminatedUnion<[z.ZodObject<{
                    status: z.ZodLiteral<"ready">;
                    input: z.ZodType<import("../shared/values.ts").JsonValue, unknown, z.core.$ZodTypeInternals<import("../shared/values.ts").JsonValue, unknown>>;
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
                loop: z.ZodPipe<z.ZodString, z.ZodTransform<import("../workflow/types.ts").NodeId, string>>;
                index: z.ZodNumber;
            }, z.core.$strict>>;
            status: z.ZodLiteral<"cancelled">;
            previousStatus: z.ZodLiteral<"waiting">;
        }, z.core.$strict>]>]>;
        loopDeadlines: z.ZodRecord<z.ZodString, z.ZodNumber>;
    }, z.core.$strict>;
    kind: z.ZodEnum<{
        "loop-timeout": "loop-timeout";
        "approval-decided": "approval-decided";
        "approval-requested": "approval-requested";
        "execution-segment": "execution-segment";
        "execution-requested": "execution-requested";
        "cancellation-requested": "cancellation-requested";
        "node-intent": "node-intent";
        "run-cancelled": "run-cancelled";
        "breakpoint-hit": "breakpoint-hit";
        "node-trace": "node-trace";
        "node-result": "node-result";
        "run-created": "run-created";
    }>;
    data: z.ZodJSONSchema;
}, z.core.$strict>;
export type PostgresRunWrite = z.input<typeof writeSchema>;
declare const releasePin: z.ZodObject<{
    id: z.ZodUUID;
    sha256: z.ZodString;
    revision: z.ZodString;
}, z.core.$strict>;
/** Experimental execution storage. It commits/validates checkpoints; it never starts or resumes a workflow. */
export declare class PostgresRunStore {
    private readonly journal;
    private readonly limits;
    private readonly maxRecordBytes;
    private readonly maxRuns;
    private readonly retainedMetrics?;
    private readonly reader;
    private approvalCapture;
    /** Internal source bridge. No read/reopen scan, replay or independent owner. */
    observeCommittedApprovals(capture: CommittedApprovalObserver): void;
    constructor(journal: PostgresJournal, limits?: WorkflowCompilerLimits, maxRecordBytes?: number, maxRuns?: number, retainedMetrics?: RetainedRunMetrics | undefined);
    get signal(): AbortSignal;
    /** One domain gate across every source page; verified reads never dispatch a model or workflow. */
    activity(readProjects: () => Promise<ActivityProject[]>): Promise<{
        schemaVersion: 1;
        storage: "sqlite" | "postgres";
        observedAt: string;
        scope: "selected-owner-retained-data";
        consistency: "single-owner-coherent-observation";
        projects: {
            total: number;
            active: number;
            archived: number;
            origins: {
                authored: number;
                duplicated: number;
                projectBundle: number;
                vendor: number;
            };
        };
        proposals: {
            total: number;
            pending: number;
            accepted: number;
            rejected: number;
            importedHistory: number;
            localActions: {
                proposed: number;
                accepted: number;
                rejected: number;
            };
        };
        imports: {
            projectBundle: number;
            vendor: number;
            basis: "retained-project-origin";
        };
        runs: {
            total: number;
            byStatus: {
                paused: number;
                executing: number;
                waiting: number;
                completed: number;
                failed: number;
                cancelled: number;
            };
            links: {
                project: number;
                release: number;
                unlinked: number;
            };
            triggerSelection: {
                api: number;
                defaultLocal: number;
            };
            firstRetainedRun: {
                id: string;
                revision: string;
                createdAt: string;
                status: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
            } | null;
        };
        privacy: "counts-and-first-run-identifiers; no-payloads-actors-or-credentials";
        execution: "not-started-resumed-approved-or-cancelled";
        billing: false;
        lifetimeTotals: false;
    }>;
    private owned;
    private parse;
    get(id: string): Promise<{
        record: LocalRun;
        version: string;
    }>;
    /** Internal caller read/start-retry. No foreign payload is loaded, and expiry is checked after every awaited replay. */
    caller(token: string, id: string, permission: 'start' | 'read' | 'control' | 'cancel', allowNew?: boolean): Promise<{
        record: LocalRun;
        version: string;
    } | undefined>;
    /** Only the authenticated grant supplies this retained run/revision, before any private read. */
    reviewer(token: string, action: string): Promise<{
        principal: import("../access/grants.ts").GrantPrincipal;
        record: LocalRun;
        version: string;
        events: import("./postgres-reader.ts").PostgresRunEvent[];
        graph: import("../workflow/compiler-types.ts").CompiledWorkflow;
    }>;
    events(id: string): Promise<import("./postgres-reader.ts").PostgresRunEvent[]>;
    /** Hold the domain gate across checkpoint, journal, historical references and model verification. */
    evidence(id: string, includePrivate?: boolean, usageIdentities?: boolean): Promise<{
        schemaVersion: 2;
        snapshot: {
            private?: {
                run: LocalRun;
                journal: import("./postgres-reader.ts").PostgresRunEvent[];
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
                    loop: import("../workflow/types.ts").NodeId;
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
                nodeId: import("../workflow/types.ts").NodeId;
                stepCount: number;
                at: string;
                scope?: {
                    loop: import("../workflow/types.ts").NodeId;
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
                    loop: import("../workflow/types.ts").NodeId;
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
                    loop: import("../workflow/types.ts").NodeId;
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
                        loop: import("../workflow/types.ts").NodeId;
                        index: number;
                    };
                    nodeId: import("../workflow/types.ts").NodeId;
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
                        loop: import("../workflow/types.ts").NodeId;
                        index: number;
                    };
                    nodeId: import("../workflow/types.ts").NodeId;
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
                    nodeId: import("../workflow/types.ts").NodeId;
                };
                previousStatus?: "paused" | "waiting" | "executing";
                externalEffects?: string;
                nodeId?: import("../workflow/types.ts").NodeId;
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
                    loop: import("../workflow/types.ts").NodeId;
                    index: number;
                };
                next?: import("../workflow/types.ts").NodeId;
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
                    nodeId: import("../workflow/types.ts").NodeId;
                };
                previousStatus?: "paused" | "waiting" | "executing";
                externalEffects?: string;
                nodeId?: import("../workflow/types.ts").NodeId;
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
                    loop: import("../workflow/types.ts").NodeId;
                    index: number;
                };
                next?: import("../workflow/types.ts").NodeId;
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
                    loop: import("../workflow/types.ts").NodeId;
                    index: number;
                };
                port?: string;
                index: number;
                nodeId: import("../workflow/types.ts").NodeId;
            }[];
            nodeAttempts: {
                format: "jevable.node-attempts/v1";
                source: "retained-intents";
                numbering: "per-node-and-loop-scope";
                entries: {
                    number: number;
                    scope?: {
                        loop: import("../workflow/types.ts").NodeId;
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
    }>;
    list(after?: string, limit?: number): Promise<{
        runs: {
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
            triggerMode?: import("./trigger.ts").ApiTriggerMode;
            id: string;
            version: string;
            revision: string;
            status: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
            createdAt: string;
            updatedAt: string;
        }[];
        nextCursor: string | null;
    }>;
    /** Scoped pages never return an unrelated run identity as their continuation cursor. */
    listRelease(value: z.infer<typeof releasePin>, after?: string, limit?: number): Promise<{
        runs: {
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
            triggerMode?: import("./trigger.ts").ApiTriggerMode;
            id: string;
            version: string;
            revision: string;
            status: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
            createdAt: string;
            updatedAt: string;
        }[];
        nextCursor: string;
    } | {
        runs: {
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
            triggerMode?: import("./trigger.ts").ApiTriggerMode;
            id: string;
            version: string;
            revision: string;
            status: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
            createdAt: string;
            updatedAt: string;
        }[];
        nextCursor: null;
    }>;
    /** Accepts a finite JSON tree, not aliased evaluator objects. Retain the exact command/UUID; retries only retrieve receipts. */
    save(value: PostgresRunWrite, guard?: JournalConditions): Promise<{
        id: string;
        requestSha256: string;
        ownerId: string;
        epoch: string;
        recordedAt: string;
        changes: {
            collection: "projects" | "runs" | "releases" | "access-grants" | "project-deletions" | "release-versions" | "test-cases" | "test-generations" | "provider-connections" | "provider-credentials" | "model-calls" | "approval-deliveries" | "approval-delivery-subjects" | "test-erasures" | "test-erasure-subjects" | "approval-automatic-admissions";
            key: string;
            version: string;
            deleted: boolean;
        }[];
        eventSequences: string[];
    }>;
    /** New caller creation only. Exact historical recovery belongs to the authenticated caller read/retry path. */
    saveCallerCreation(value: PostgresRunWrite, guard: JournalConditions): Promise<{
        id: string;
        requestSha256: string;
        ownerId: string;
        epoch: string;
        recordedAt: string;
        changes: {
            collection: "projects" | "runs" | "releases" | "access-grants" | "project-deletions" | "release-versions" | "test-cases" | "test-generations" | "provider-connections" | "provider-credentials" | "model-calls" | "approval-deliveries" | "approval-delivery-subjects" | "test-erasures" | "test-erasure-subjects" | "approval-automatic-admissions";
            key: string;
            version: string;
            deleted: boolean;
        }[];
        eventSequences: string[];
    }>;
    private saveAdmitted;
}

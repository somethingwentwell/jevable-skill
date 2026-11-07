import type { CompiledWorkflow } from '../workflow/index.ts';
import { type ModelEvidence } from '../providers/records.ts';
/** Select only this run's model intents in journal order, including loop iterations and unsettled attempts. */
export declare function modelEvidenceTargets(graph: CompiledWorkflow, events: readonly {
    kind: string;
    data: unknown;
}[]): {
    nodeTrace?: {
        traceId: import("./run-trace.ts").JevableTraceId;
        spanId: import("./run-trace.ts").JevableSpanId;
        traceFlags: 0 | 1;
    };
    plan: import("../workflow/compiler-types.ts").CompiledLLMPlan | import("../workflow/compiler-types.ts").CompiledDecisionPlan;
    scope?: {
        loop: import("../workflow/types.ts").NodeId;
        index: number;
    };
    attempt: {
        id: import("./run-types.ts").JevableAttemptId;
        nodeId: import("../workflow/types.ts").NodeId;
        prepared: {
            status: "ready";
            input: import("../shared/values.ts").JsonValue;
        } | {
            status: "invalid-node-value";
        };
        trace?: {
            traceId: import("./run-trace.ts").JevableTraceId;
            spanId: import("./run-trace.ts").JevableSpanId;
            traceFlags: 0 | 1;
        } | undefined;
    };
}[];
type Target = ReturnType<typeof modelEvidenceTargets>[number];
/** Separate model-record read budget; never retain private records in the public projection. */
export declare class ModelEvidenceProjection {
    private readonly byteLimit;
    private readonly usageIdentities;
    private bytes;
    readonly calls: ModelCallEvidence[];
    constructor(byteLimit?: number, usageIdentities?: boolean);
    add(target: Target, record: ModelEvidence | undefined): void;
}
declare function projectModelEvidence(target: Target, value: ModelEvidence | undefined, usageIdentities: boolean): {
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
};
export type ModelCallEvidence = ReturnType<typeof projectModelEvidence>;
export {};

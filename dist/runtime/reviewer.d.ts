import { type ReviewerDecisionRequest } from '../access/reviewer.ts';
import type { GrantActionAdmission } from '../access/actions.ts';
import type { CompiledWorkflow, WorkflowCompilerLimits } from '../workflow/index.ts';
import type { LocalRun } from './run-types.ts';
/** Actual private-provider context only. This is never part of a client's decision request. */
export type ReviewerTraceObservation = Pick<NonNullable<LocalRun['traceSegments']>[number], 'trace' | 'parent'>;
/** Pure settlement from authenticated admission and checked retained state. No provider or storage effects. */
export declare function prepareReviewerSettlement(record: LocalRun, events: readonly {
    kind: string;
    data: unknown;
}[], graph: CompiledWorkflow, request: ReviewerDecisionRequest, admission: GrantActionAdmission, limits: WorkflowCompilerLimits, observation?: ReviewerTraceObservation): {
    record: LocalRun;
    data: {
        pauseAfter?: true;
        routes: {
            scope?: {
                loop: import("../workflow/types.ts").NodeId;
                index: number;
            };
            stepIndex: number;
            nodeId: import("../workflow/types.ts").NodeId;
            port: string;
        }[];
        scope?: import("./run-evaluator.ts").LoopScope;
        segment?: {
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
        };
        attemptId: import("./run-types.ts").JevableAttemptId;
        nodeId: import("../workflow/types.ts").NodeId;
        decision: {
            kind: "action";
            action: string;
            actor: string;
            at: string;
            delegation: {
                requestId: string;
                grantId: string;
                scope: {
                    kind: "reviewer";
                    runId: string;
                    attemptId: string;
                    revision: string;
                    decisions: string[];
                };
                deadline: string;
                pauseAfter: boolean;
            };
        };
    };
    decision: {
        kind: "action";
        action: string;
        actor: string;
        at: string;
        delegation: {
            requestId: string;
            grantId: string;
            scope: {
                kind: "reviewer";
                runId: string;
                attemptId: string;
                revision: string;
                decisions: string[];
            };
            deadline: string;
            pauseAfter: boolean;
        };
    };
};

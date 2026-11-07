import type { JevableAttemptId, JevableNodeInspection, JevableRunTrace } from './run-types.ts';
import type { ModelNodePlan, PreparedModelInput } from './model-plan.ts';
export interface ModelResult {
    output: string;
    usage: NonNullable<JevableNodeInspection['modelUsage']>;
}
export interface ModelTryObservation {
    trace?: JevableRunTrace;
    /** Optional synchronous diagnostic scope for this try's persistence work (which may return a Promise).
     * Must invoke work immediately and transparently. The built-in adapter guards exact-once execution,
     * preserves the actual result/error, and falls back without replay if this optional hook fails. */
    withJournalScope?: <T>(work: () => T) => T;
    end(result: {
        outcome: 'completed' | 'failed' | 'cancelled' | 'timeout' | 'commit-or-execution-failed';
        dispatched: boolean;
        settled: boolean;
        httpStatus?: number;
    }): void;
}
export interface ModelBackoffObservation {
    /** Ends the observed wait only, before any following intent or failure-settlement write. */
    end(result: {
        outcome: 'completed' | 'failed' | 'cancelled' | 'timeout' | 'commit-or-execution-failed';
    }): void;
}
export interface ModelExecutionContext {
    trace: JevableRunTrace;
    /** Ephemeral runtime-allowlisted W3C carrier. Built-in transport also requires per-destination approval.
     * Never store this in model evidence, workflow input, logs, attributes or exported artifacts. */
    baggage?: string;
    /** Optional diagnostic lifecycle for retry-enabled calls; it never authorizes dispatch or retries. */
    startTry?: (identity: {
        id: string;
        number: number;
    }) => ModelTryObservation;
    /** Called only after the preceding failed try's retry-delay evidence is acknowledged. No new request is authorized. */
    startBackoff?: (identity: {
        afterTryId: string;
        afterTryNumber: number;
        delayMs: number;
    }) => ModelBackoffObservation;
}
/** A host-supplied adapter; no agent session, desktop settings or harness services are imported. */
export interface ModelCalls {
    /** Refuse unavailable providers or unsupported settings before any workflow step executes; async completion is awaited. */
    admit(node: ModelNodePlan): unknown;
    /** Persist the request and exact response under the attempt ID before returning. Never silently change routes. */
    execute(node: ModelNodePlan, input: PreparedModelInput, attemptId: JevableAttemptId, signal?: AbortSignal, context?: ModelExecutionContext): Promise<ModelResult>;
    /** Read retained model evidence and compare it, without issuing another provider request. */
    verify(node: ModelNodePlan, attemptId: JevableAttemptId, input: PreparedModelInput, output: string): Promise<void>;
    /** Optional read-only recovery: return an already committed exact response, never dispatch, retry or synthesize one. */
    recover?(node: ModelNodePlan, attemptId: JevableAttemptId, input: PreparedModelInput): Promise<ModelResult>;
}

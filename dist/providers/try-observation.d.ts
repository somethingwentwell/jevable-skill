import type { ModelExecutionContext, ModelTryObservation } from '../runtime/model-port.ts';
/** Diagnostics cannot change dispatch/settlement, including when a custom SDK observer throws. */
export declare function observeModelTry(context: ModelExecutionContext | undefined, id: string, number: number): {
    trace: {
        traceId: import("../runtime/run-trace.ts").JevableTraceId;
        spanId: import("../runtime/run-trace.ts").JevableSpanId;
        traceFlags: 0 | 1;
    } | undefined;
    scope<T>(work: () => T): T;
    end(result: Parameters<ModelTryObservation["end"]>[0]): void;
};

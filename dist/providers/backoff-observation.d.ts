import type { ModelBackoffObservation, ModelExecutionContext } from '../runtime/model-port.ts';
/** Wait diagnostics cannot authorize dispatch, change a budget or replace a persistence/transport outcome. */
export declare function observeModelBackoff(context: ModelExecutionContext | undefined, afterTryId: string, afterTryNumber: number, delayMs: number): {
    end(result: Parameters<ModelBackoffObservation["end"]>[0]): void;
};

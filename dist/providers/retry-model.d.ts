import type { ModelRequestPlan } from '../runtime/model-plan.ts';
import type { ModelResult, ModelExecutionContext } from '../runtime/model-port.ts';
import type { ProviderPersistence } from './persistence.ts';
import { type ModelEvidence } from './records.ts';
import type { prepareModelWire } from './model-wire.ts';
/** A server-requested delay never causes an earlier retry; a delay outside the remaining budget ends the attempt. */
export declare function modelRetryDelay(number: number, retryAfter: string | null, now?: number): number;
/** Only a currently admitted call may advance retries. Restarts and execute() reentry never enter this loop. */
export declare function executeRetriedModel(store: ProviderPersistence, plan: ModelRequestPlan, seed: Extract<ModelEvidence, {
    schemaVersion: 1;
}>, body: string, credential: string | undefined, signal: AbortSignal | undefined, context: ModelExecutionContext | undefined, wire: ReturnType<typeof prepareModelWire>, baggage?: string): Promise<ModelResult>;

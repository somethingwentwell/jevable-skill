import type { ModelCalls, ModelResult, ModelExecutionContext } from '../runtime/model-port.ts';
import { type ModelNodePlan, type PreparedModelInput } from '../runtime/model-plan.ts';
import type { JevableAttemptId } from '../runtime/run-types.ts';
import type { ProviderPersistence } from './persistence.ts';
/** OpenAI-compatible transport with immutable, secret-free request/response evidence in the private runtime store. */
export declare class ConfiguredModels implements ModelCalls {
    private readonly store;
    constructor(store: ProviderPersistence);
    admit(node: ModelNodePlan): Promise<{
        plan: import("../runtime/model-plan.ts").ModelRequestPlan;
        route: {
            generation: number;
            updatedAt: string;
            connection: {
                protocol: "openai-compatible";
                tokenParameter: "max_tokens" | "max_completion_tokens";
                maxStreamEvents: number;
                id: string;
                provider: string;
                endpoint: string;
                allowedModels: string[];
                authentication: {
                    kind: "bearer";
                    credentialRef: string;
                } | {
                    kind: "none";
                };
                maxResponseBytes: number;
                maxRequestBytes: number;
                maxTimeoutSeconds: number;
                tracePropagation?: "none" | "w3c" | undefined;
                baggageKeys?: string[] | undefined;
            } | {
                protocol: "systemone";
                provider: "jev" | "laya";
                id: string;
                endpoint: string;
                allowedModels: string[];
                authentication: {
                    kind: "bearer";
                    credentialRef: string;
                } | {
                    kind: "none";
                };
                maxResponseBytes: number;
                maxRequestBytes: number;
                maxTimeoutSeconds: number;
                tracePropagation?: "none" | "w3c" | undefined;
                baggageKeys?: string[] | undefined;
            };
        };
    }>;
    execute(node: ModelNodePlan, input: PreparedModelInput, attemptId: JevableAttemptId, signal?: AbortSignal, context?: ModelExecutionContext): Promise<ModelResult>;
    /** Historical checks use the retained route, not today's provider permissions or credentials. */
    recover(node: ModelNodePlan, attemptId: JevableAttemptId, input: PreparedModelInput): Promise<ModelResult>;
    /** Historical checks use the retained route, not today's provider permissions or credentials. */
    verify(node: ModelNodePlan, attemptId: JevableAttemptId, input: PreparedModelInput, output: string): Promise<void>;
}

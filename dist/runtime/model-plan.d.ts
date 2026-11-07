/** Translate admitted LLM and explicit Decision compatibility instructions into one recorded model request. */
import type { CompiledDecisionPlan, CompiledLLMPlan, ReadonlyJsonValue } from '../workflow/index.ts';
/** Source-owned node types which can request the shared durable model executor. */
export type ModelNodePlan = CompiledLLMPlan | CompiledDecisionPlan;
/** Request fields shared by direct generation and Decision compatibility calls; no invented compiled bindings. */
export type ChatModelRequestPlan = Pick<CompiledLLMPlan, 'provider' | 'model' | 'connection' | 'output' | 'responseFormat' | 'generation' | 'execution'>;
export type NativeModelRequestPlan = Pick<CompiledDecisionPlan, 'provider' | 'model' | 'connection' | 'output' | 'questions' | 'execution'> & {
    responseFormat: 'systemone-v1';
};
export type ModelRequestPlan = ChatModelRequestPlan | NativeModelRequestPlan;
/** One earlier LLM exchange of the same run: the node's resolved prompt and its committed output. */
export interface ModelHistoryExchange {
    nodeId: string;
    prompt: string;
    reply: ReadonlyJsonValue;
}
/**
 * Exact model-visible strings, derived from the saved preparation and immutable source. `history` is present only for
 * the `current-run` scope and holds the bounded projection chosen when the attempt was prepared.
 */
export interface PreparedModelInput {
    prompt: string;
    systemPrompt: string;
    history?: readonly ModelHistoryExchange[];
}
/**
 * Resolve the explicitly selected compatibility protocol without changing providers on failure.
 * @param node - Immutable instructions; native execution requires an explicit versioned answer contract.
 * @returns the same request settings used by dispatch and saved-Session verification.
 */
export declare function modelRequestPlan(node: CompiledLLMPlan): ChatModelRequestPlan;
export declare function modelRequestPlan(node: ModelNodePlan): ModelRequestPlan;
/**
 * Render a request from committed node input; no network, secrets or previous-run history is consulted.
 * @param node - Exact accepted node and question definitions.
 * @param input - Previously validated preparation: prompt fields for LLM or the bound state for Decision.
 * @returns deterministic system/user strings which must be flushed to the Session before dispatch.
 */
export declare function modelInput(node: ModelNodePlan, input: ReadonlyJsonValue): PreparedModelInput;
/**
 * Select the newest whole exchanges that fit the node's history limits; an exchange counts as two messages.
 * @param limits - The node's compiled history limits.
 * @param exchanges - Earlier exchanges visible to the node, oldest first.
 * @returns the kept exchanges, oldest first; selection stops at the first older exchange that does not fit, so the kept
 * history is always the most recent contiguous part of the run.
 */
export declare function modelHistory(limits: {
    readonly maxMessages: number;
    readonly maxBytes: number;
}, exchanges: readonly ModelHistoryExchange[]): ModelHistoryExchange[];
/**
 * Render the user message of a model request.
 * @param input - Saved preparation.
 * @returns the prompt, preceded by one framed JSON block when earlier run exchanges were admitted.
 */
export declare function modelUserContent(input: PreparedModelInput): {
    type: 'text';
    text: string;
}[];

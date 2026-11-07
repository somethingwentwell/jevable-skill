import type { CompiledWorkflow } from '../workflow/index.ts';
/** Top-level workflow extension holding the limit, beside the `jevable.ai/economy` authoring preference. */
export declare const AI_BUDGET_EXTENSION = "jevable.ai/budget";
/**
 * Read the most LLM and Decision steps one run may start, counting each loop iteration; retries of one step are not counted.
 * @param graph - Compiled accepted revision.
 * @returns the limit, or undefined when the revision sets none.
 * @throws WorkflowRuntimeError `invalid-command` when the extension is present but is not `{ maxAiSteps: <whole number ≥ 1> }`.
 */
export declare function aiStepBudget(graph: CompiledWorkflow): number | undefined;

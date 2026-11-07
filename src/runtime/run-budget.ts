/** Reviewed per-run limit on AI steps, read from the accepted source so replay recomputes the same stop. */
import { z } from 'zod'
import type { CompiledWorkflow } from '../workflow/index.ts'
import { WorkflowRuntimeError } from './errors.ts'

/** Top-level workflow extension holding the limit, beside the `jevable.ai/economy` authoring preference. */
export const AI_BUDGET_EXTENSION = 'jevable.ai/budget'

const budget = z.strictObject({ maxAiSteps: z.number().int().min(1).max(1_000_000) })

/**
 * Read the most LLM and Decision steps one run may start, counting each loop iteration; retries of one step are not counted.
 * @param graph - Compiled accepted revision.
 * @returns the limit, or undefined when the revision sets none.
 * @throws WorkflowRuntimeError `invalid-command` when the extension is present but is not `{ maxAiSteps: <whole number ≥ 1> }`.
 */
export function aiStepBudget(graph: CompiledWorkflow): number | undefined {
  const value = graph.source.document.extensions?.[AI_BUDGET_EXTENSION]
  if (value === undefined) return undefined
  const parsed = budget.safeParse(value)
  if (!parsed.success) throw new WorkflowRuntimeError('invalid-command')
  return parsed.data.maxAiSteps
}

import type { CompiledDecisionPlan } from './compiler-types.ts';
import type { WorkflowDecisionAnswer, WorkflowDecisionQuestion } from './decision-types.ts';
import type { CompiledValueSchema, WorkflowDataLimits } from './value-types.ts';
import { type SystemOneAnswer } from './systemone-answers.ts';
/**
 * Compile exact per-question answer fields for downstream typed references.
 * @param questions - Source-admitted questions and their ordered criteria.
 * @param limits - Bounds on the complete generated schema, not just each question.
 * @returns an immutable schema receipt; numeric relationships additionally require validateDecisionAnswers.
 */
export declare function compileDecisionOutput(questions: Readonly<Record<string, WorkflowDecisionQuestion>>, limits: WorkflowDataLimits, answerFormat?: 'systemone-v1'): CompiledValueSchema;
/**
 * Validate normalized provider answers without guessing missing values, coercing or changing probabilities.
 * @param plan - Locally compiled Decision instructions, including their exact output schema receipt.
 * @param value - Adapter-normalized untrusted answers; raw provider envelopes are not accepted.
 * @param limits - Bounds on the complete result including optional explanations.
 * @returns a detached frozen answer map with unit probability mass, maximal choices and expected ordinal scores.
 * @throws WorkflowValueError for invalid data or inconsistent distributions, without exposing provider content.
 */
export declare function validateDecisionAnswers(plan: CompiledDecisionPlan, value: unknown, limits: WorkflowDataLimits): Readonly<Record<string, WorkflowDecisionAnswer | SystemOneAnswer>>;

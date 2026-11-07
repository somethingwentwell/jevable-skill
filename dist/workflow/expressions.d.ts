import type { CompiledExpression, ExpressionEnvironment, ExpressionLimits, ExpressionValues } from './expression-types.ts';
import type { ReadonlyJsonValue } from './types.ts';
/** Safe expression failure; never contains authored expressions or runtime values. */
export declare class WorkflowExpressionError extends Error {
    name: string;
}
/**
 * Compile one expression with literals, typed references, comparisons, boolean operators and exists(reference).
 * Equality is scalar and strict, including when authored with == or !=; no coercion, method calls or JS evaluation occurs.
 * @param source - expression text, without template delimiters.
 * @param environment - trusted schema types, exposing only guaranteed upstream node outputs and the current loop scope.
 * @param limits - explicit byte, instruction, nesting and result budgets; depth cannot exceed 128.
 * @returns a detached frozen instruction tree and the references that need runtime values.
 * @throws WorkflowExpressionError for unsupported syntax, unavailable references, type errors or exceeded budgets.
 */
export declare function compileExpression(source: string, environment: ExpressionEnvironment, limits: ExpressionLimits): CompiledExpression;
/**
 * Evaluate admitted instructions against schema-validated run values, without executing JavaScript.
 * Boolean operators short-circuit; only exists may consume a missing reference. Results are detached and frozen.
 * @param expression - in-process compiled expression; durable or remote data must first be recompiled.
 * @param values - current inputs, completed outputs and optional iteration-local data.
 * @returns a bounded JSON value; errors never expose input data.
 * @throws WorkflowExpressionError for absent/wrongly typed values or oversized results.
 */
export declare function evaluateExpression(expression: CompiledExpression, values: ExpressionValues): ReadonlyJsonValue;

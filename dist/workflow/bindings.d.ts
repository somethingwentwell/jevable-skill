import type { ExpressionEnvironment, ExpressionValues } from './expression-types.ts';
import type { CompiledBinding, WorkflowBindingLimits } from './binding-types.ts';
import type { ReadonlyJsonValue } from './types.ts';
/**
 * Compile JSON with whole-value expressions and scalar-only text interpolation.
 * @param value - unknown JSON binding; `${{ expression }}` preserves its typed value when it occupies the complete string.
 * @param environment - trusted types exposing only values available at this graph position.
 * @param limits - whole binding/data limits and per-expression budgets.
 * @returns detached immutable binding instructions and their structural result type.
 * @throws WorkflowCompileError for malformed interpolation or heterogeneous inline arrays, without exposing authored values.
 */
export declare function compileBinding(value: unknown, environment: ExpressionEnvironment, limits: WorkflowBindingLimits): CompiledBinding;
/**
 * Evaluate a compiled binding while budgeting the complete JSON encoding, including keys and containers.
 * @param binding - local compiled instructions, never unvalidated file or wire data.
 * @param values - schema-validated current run values.
 * @returns a detached frozen JSON value; no context value can be mutated through the result.
 * @throws WorkflowValueError for whole-result budget exhaustion; expression failures retain safe diagnostics.
 */
export declare function evaluateBinding(binding: CompiledBinding, values: ExpressionValues): ReadonlyJsonValue;

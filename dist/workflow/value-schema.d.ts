import type { ReadonlyJsonValue } from './types.ts';
import type { CompiledValueSchema, WorkflowDataLimits } from './value-types.ts';
/**
 * Validate JSON resource limits and return a detached immutable value.
 * @param value - unknown deserialized data; not a hostile in-process Proxy.
 * @param limits - positive byte, value and nesting budgets, with depth at most 128.
 * @returns a frozen JSON copy, without silently dropping unsupported values.
 * @throws WorkflowValueError for invalid budgets, non-JSON data or exceeded limits, without exposing the value.
 */
export declare function admitWorkflowData(value: unknown, limits: WorkflowDataLimits): ReadonlyJsonValue;
/**
 * Compile the supported finite JSON Schema subset and project its declared properties into expression types.
 * Unknown keywords, external/local refs, regexes, formats, schema unions and executable annotations are rejected.
 * @param value - unknown schema data from workflow source.
 * @param limits - schema byte, depth and value budgets.
 * @returns a detached frozen schema and type receipt usable by validateWorkflowValue in this process.
 * @throws WorkflowCompileError for unsupported or inconsistent schemas, without source snippets.
 * @throws WorkflowValueError for invalid JSON data or schema resource budgets.
 */
export declare function compileValueSchema(value: unknown, limits: WorkflowDataLimits): CompiledValueSchema;
/**
 * Validate and snapshot a node input/output with no type coercion or added defaults.
 * @param compiled - schema receipt from compileValueSchema in this process, not deserialized compiled data.
 * @param value - untrusted provider, ingress or persisted JSON data.
 * @param limits - budgets for the complete retained value.
 * @returns a frozen detached value satisfying the complete supported schema.
 * @throws WorkflowValueError for invalid data or an unrecognized receipt; values are never included in diagnostics.
 */
export declare function validateWorkflowValue(compiled: CompiledValueSchema, value: unknown, limits: WorkflowDataLimits): ReadonlyJsonValue;

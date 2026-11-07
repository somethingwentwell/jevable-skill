import type { ExpressionValues } from './expression-types.ts';
import type { CompiledWorkflow, WorkflowCompilerLimits, CompiledRulePlan } from './compiler-types.ts';
import type { ReadonlyJsonValue } from './types.ts';
/**
 * Revalidate source and compile the supported Trigger/LLM/Decision/Rule/Approval/Output graph into immutable local instructions.
 * Provider credentials, egress, capabilities and history authorization are runtime responsibilities, not granted by compilation.
 * @param value - unknown source document, including data loaded from disk, API, import or an AI proposal.
 * @param limits - explicit parser/schema/binding budgets from the consuming host.
 * @returns source-pinned instructions, exact branch destinations and validated input/output schema receipts.
 * @throws WorkflowCompileError for unsupported nodes/settings, incomplete ports or path-dependent references.
 */
export declare function compileWorkflow(value: unknown, limits: WorkflowCompilerLimits): CompiledWorkflow;
/**
 * Parse bounded YAML and compile it through the same admission path as object sources.
 * @param source - exactly one YAML workflow document.
 * @param limits - host-owned source/schema/binding budgets.
 * @returns a source-pinned immutable execution plan, without starting any nodes.
 */
export declare function compileWorkflowYaml(source: string, limits: WorkflowCompilerLimits): CompiledWorkflow;
/**
 * Select exactly one Rule port using strict scalar comparisons and first-match Switch ordering.
 * @param rule - a local compiled If/Else or Switch plan.
 * @param values - schema-validated values available at this node.
 * @param inspect - Optional synchronous observer of the resolved condition or switch value; never receives the full context.
 * @returns a selected port and the safe structural Rule output; no provider or external side effect occurs.
 */
export declare function evaluateRule(rule: CompiledRulePlan, values: ExpressionValues, inspect?: (input: ReadonlyJsonValue) => void): {
    readonly port: string;
    readonly output: ReadonlyJsonValue;
};
/**
 * Select a Rule route from its already resolved input, without evaluating a binding again.
 * @param rule - Compiled routing instructions from the pinned workflow.
 * @param input - The resolved condition or Switch value, admitted by the owning runtime.
 * @returns the selected port and structural output, using the same ordering as evaluateRule.
 */
export declare function evaluateResolvedRule(rule: CompiledRulePlan, input: ReadonlyJsonValue): {
    readonly port: string;
    readonly output: ReadonlyJsonValue;
};

import type { WorkflowDiff, WorkflowLimits, WorkflowSnapshot } from './types.ts';
/**
 * Admit wire/file data and return a detached immutable, canonical source snapshot.
 * Node configuration, typed references, loop bodies and runtime capabilities need further validation before execution.
 * @param value - unknown JSON-compatible source data.
 * @param limits - explicit admission budgets from the consuming service configuration.
 * @returns frozen source, canonical YAML, SHA-256 revision and deterministic outer topological order.
 * @throws WorkflowSourceError for malformed, oversized or structurally invalid sources.
 */
export declare function snapshotWorkflow(value: unknown, limits: WorkflowLimits): WorkflowSnapshot;
/**
 * Parse exactly one YAML document, without custom tags, aliases, duplicate keys or executable constructors.
 * @param source - UTF-8 workflow YAML text.
 * @param limits - explicit parsing and graph budgets.
 * @returns the same immutable source snapshot produced by snapshotWorkflow.
 * @throws WorkflowSourceError without reflecting YAML source excerpts.
 */
export declare function parseWorkflow(source: string, limits: WorkflowLimits): WorkflowSnapshot;
/**
 * Compare admitted revisions without embedding configuration values in the change record.
 * @param before - previous admitted source snapshot.
 * @param after - proposed admitted source snapshot.
 * @returns immutable node and document-section change metadata.
 */
export declare function diffWorkflows(before: WorkflowSnapshot, after: WorkflowSnapshot): WorkflowDiff;

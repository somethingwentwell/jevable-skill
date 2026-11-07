import type { WorkflowLimits } from './types.ts';
/**
 * Reject non-JSON values and excessive nesting before recursive schema operations.
 * @param value - deserialized data, not hostile in-process proxies.
 * @param limits - positive, caller-validated value and nesting budgets.
 * @returns nothing; invalid data throws a safe WorkflowSourceError.
 */
export declare function assertJsonTree(value: unknown, limits: Pick<WorkflowLimits, 'maxValues' | 'maxDepth'>): void;

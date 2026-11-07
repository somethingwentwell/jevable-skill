/** Iterative JSON admission shared by workflow source, schema and runtime value checks. */
import { WorkflowSourceError } from './errors.ts'
import type { WorkflowLimits } from './types.ts'

/**
 * Reject non-JSON values and excessive nesting before recursive schema operations.
 * @param value - deserialized data, not hostile in-process proxies.
 * @param limits - positive, caller-validated value and nesting budgets.
 * @returns nothing; invalid data throws a safe WorkflowSourceError.
 */
export function assertJsonTree(value: unknown, limits: Pick<WorkflowLimits, 'maxValues' | 'maxDepth'>): void {
  const pending = [{ value, depth: 0 }]
  const visited = new WeakSet<object>()
  let count = 0
  for (let current = pending.pop(); current; current = pending.pop()) {
    if (++count > limits.maxValues || current.depth > limits.maxDepth) {
      throw new WorkflowSourceError('Workflow exceeds the configured value or nesting budget.')
    }
    const item = current.value
    if (item === null || typeof item === 'string' || typeof item === 'boolean') continue
    if (typeof item === 'number' && Number.isFinite(item)) continue
    if (typeof item !== 'object' || visited.has(item)) {
      throw new WorkflowSourceError('Workflow must be a finite JSON tree without aliases or cycles.')
    }
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new WorkflowSourceError('Workflow contains a non-JSON object.')
    }
    visited.add(item)
    if (Object.getOwnPropertySymbols(item).length || (Array.isArray(item) && Object.keys(item).length !== item.length)) {
      throw new WorkflowSourceError('Workflow must not contain symbol properties or sparse arrays.')
    }
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (Array.isArray(item) && key === 'length') continue
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
        || (Array.isArray(item) && (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= item.length))) {
        throw new WorkflowSourceError('Workflow must contain enumerable JSON data properties only.')
      }
      if (['__proto__', 'constructor', 'prototype'].includes(key)) {
        throw new WorkflowSourceError('Workflow contains a reserved property name.')
      }
      const child: unknown = descriptor.value
      pending.push({ value: child, depth: current.depth + 1 })
    }
  }
}

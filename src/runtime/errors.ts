/** Workflow runtime errors intentionally exclude source and conversation payloads. */

/** Safe authoring failure with a stable category for host consumers. */
export class WorkflowRuntimeError extends Error {
  /**
   * @param code - Stable failure category for host consumers; `busy` means an operation or owner conflicts with
   *   work currently in progress and a later retry may succeed.
   */
  constructor(readonly code: 'invalid-command' | 'not-found' | 'conflict' | 'archived' | 'referenced' | 'limit' | 'busy' | 'corrupt' | 'closed') {
    super(`Jevable runtime operation failed: ${code}.`)
    this.name = 'WorkflowRuntimeError'
  }
}

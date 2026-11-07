/** Safe workflow admission diagnostics; no source or runtime values are included. */
import type { WorkflowImportFailure } from './import/import-types.ts'
/** Admission failure with diagnostics that do not echo source/configuration values. */
export class WorkflowSourceError extends Error {
  override name = 'WorkflowSourceError'
}

/** Safe rejection of source that cannot be compiled for execution. */
export class WorkflowCompileError extends Error {
  override name = 'WorkflowCompileError'
}

/** Safe rejection of runtime input/output or an invalid schema receipt. */
export class WorkflowValueError extends Error {
  override name = 'WorkflowValueError'
}


/** Safe rejection of an uploaded vendor workflow before any draft is created. */
export class WorkflowImportError extends Error {
  override name = 'WorkflowImportError'
  /**
   * @param code - Stable failure category for host consumers.
   */
  constructor(readonly code: WorkflowImportFailure) { super(`Workflow import failed: ${code}.`) }
}

/** Admission failure with diagnostics that do not echo source/configuration values. */
export class WorkflowSourceError extends Error {
    name = 'WorkflowSourceError';
}
/** Safe rejection of source that cannot be compiled for execution. */
export class WorkflowCompileError extends Error {
    name = 'WorkflowCompileError';
}
/** Safe rejection of runtime input/output or an invalid schema receipt. */
export class WorkflowValueError extends Error {
    name = 'WorkflowValueError';
}
/** Safe rejection of an uploaded vendor workflow before any draft is created. */
export class WorkflowImportError extends Error {
    code;
    name = 'WorkflowImportError';
    /**
     * @param code - Stable failure category for host consumers.
     */
    constructor(code) {
        super(`Workflow import failed: ${code}.`);
        this.code = code;
    }
}

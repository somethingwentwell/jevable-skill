/** Safe workflow admission diagnostics; no source or runtime values are included. */
import type { WorkflowImportFailure } from './import/import-types.ts';
/** Admission failure with diagnostics that do not echo source/configuration values. */
export declare class WorkflowSourceError extends Error {
    name: string;
}
/** Safe rejection of source that cannot be compiled for execution. */
export declare class WorkflowCompileError extends Error {
    name: string;
}
/** Safe rejection of runtime input/output or an invalid schema receipt. */
export declare class WorkflowValueError extends Error {
    name: string;
}
/** Safe rejection of an uploaded vendor workflow before any draft is created. */
export declare class WorkflowImportError extends Error {
    readonly code: WorkflowImportFailure;
    name: string;
    /**
     * @param code - Stable failure category for host consumers.
     */
    constructor(code: WorkflowImportFailure);
}

import { type WorkflowCompilerLimits } from './workflow/index.ts';
/** Offline compilation does not assert model configuration, runtime readiness or successful execution. */
export declare function validateSource(source: string, limits?: WorkflowCompilerLimits): {
    schemaVersion: 1;
    status: "valid";
    revision: import("./workflow/types.ts").RevisionHash;
    compilerVersion: "jevable-compiler/v1alpha1";
    nodeCount: number;
    runtimeReadiness: "not-checked";
    execution: "not-run";
    diagnostics: never[];
} | {
    schemaVersion: 1;
    status: "invalid";
    runtimeReadiness: "not-checked";
    execution: "not-run";
    diagnostics: {
        code: string;
        message: string;
    }[];
    revision?: never;
    compilerVersion?: never;
    nodeCount?: never;
};

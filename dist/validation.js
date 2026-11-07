import { compileWorkflowYaml, WorkflowCompileError, WorkflowExpressionError, WorkflowSourceError, WorkflowValueError } from "./workflow/index.js";
import { DEFAULT_COMPILER_LIMITS } from "./limits.js";
/** Offline compilation does not assert model configuration, runtime readiness or successful execution. */
export function validateSource(source, limits = DEFAULT_COMPILER_LIMITS) {
    try {
        const graph = compileWorkflowYaml(source, limits);
        return { schemaVersion: 1, status: 'valid', revision: graph.source.revision,
            compilerVersion: graph.compilerVersion, nodeCount: graph.nodes.length,
            runtimeReadiness: 'not-checked', execution: 'not-run', diagnostics: [] };
    }
    catch (error) {
        if (![WorkflowCompileError, WorkflowExpressionError, WorkflowSourceError, WorkflowValueError].some(kind => error instanceof kind))
            throw error;
        return { schemaVersion: 1, status: 'invalid',
            runtimeReadiness: 'not-checked', execution: 'not-run',
            diagnostics: [{ code: error.name, message: error.message }] };
    }
}

import { compileWorkflowYaml, WorkflowCompileError, WorkflowExpressionError, WorkflowSourceError, WorkflowValueError,
  type WorkflowCompilerLimits } from './workflow/index.ts'
import { DEFAULT_COMPILER_LIMITS } from './limits.ts'

/** Offline compilation does not assert model configuration, runtime readiness or successful execution. */
export function validateSource(source: string, limits: WorkflowCompilerLimits = DEFAULT_COMPILER_LIMITS) {
  try {
    const graph = compileWorkflowYaml(source, limits)
    return { schemaVersion: 1 as const, status: 'valid' as const, revision: graph.source.revision,
      compilerVersion: graph.compilerVersion, nodeCount: graph.nodes.length,
      runtimeReadiness: 'not-checked' as const, execution: 'not-run' as const, diagnostics: [] }
  } catch (error) {
    if (![WorkflowCompileError, WorkflowExpressionError, WorkflowSourceError, WorkflowValueError].some(kind => error instanceof kind)) throw error
    return { schemaVersion: 1 as const, status: 'invalid' as const,
      runtimeReadiness: 'not-checked' as const, execution: 'not-run' as const,
      diagnostics: [{ code: (error as Error).name, message: (error as Error).message }] }
  }
}

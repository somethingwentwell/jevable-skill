import type { CompiledWorkflow, WorkflowCompilerLimits } from '../workflow/index.ts';
import type { LocalRun } from './run-types.ts';
import type { ModelCalls } from './model-port.ts';
import { type RunCheckpoint } from './run-evaluator.ts';
/** Read committed response evidence and derive one settlement. No new intent, provider request, approval or downstream step. */
export declare function prepareModelRecovery(record: LocalRun, graph: CompiledWorkflow, limits: WorkflowCompilerLimits, models?: ModelCalls): Promise<RunCheckpoint>;

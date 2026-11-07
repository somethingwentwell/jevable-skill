import type { CompiledWorkflow, WorkflowCompilerLimits } from '../workflow/index.ts';
import { type ExecutionControl } from './control.ts';
import { type LocalRun } from './run-types.ts';
export { breakpointConfiguration, breakpointAt, breakpointMetadata } from './breakpoint-metadata.ts';
export declare function validateBreakpoints(graph: CompiledWorkflow, command: ExecutionControl): void;
/** Bind hit history to admitted configuration and compiled checkpoint prefixes. Never execute during replay. */
export declare function checkBreakpointEvidence(run: LocalRun, events: readonly {
    kind: string;
    data: unknown;
}[], graph: CompiledWorkflow, limits: WorkflowCompilerLimits): undefined;

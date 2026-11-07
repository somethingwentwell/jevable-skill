import { z } from 'zod';
import type { CompiledWorkflow, WorkflowCompilerLimits } from '../workflow/index.ts';
import { type LocalRun } from './run-types.ts';
export declare const runEventKind: z.ZodEnum<{
    "loop-timeout": "loop-timeout";
    "approval-decided": "approval-decided";
    "approval-requested": "approval-requested";
    "execution-segment": "execution-segment";
    "execution-requested": "execution-requested";
    "cancellation-requested": "cancellation-requested";
    "node-intent": "node-intent";
    "run-cancelled": "run-cancelled";
    "breakpoint-hit": "breakpoint-hit";
    "node-trace": "node-trace";
    "node-result": "node-result";
    "run-created": "run-created";
}>;
export type RunEventKind = z.infer<typeof runEventKind>;
/** Guard one storage transition. Uses retained values only; never dispatches or approves an action itself. */
export declare function validateRunTransition(before: LocalRun | undefined, next: LocalRun, kind: RunEventKind, data: unknown, graph: CompiledWorkflow, limits: WorkflowCompilerLimits): void;

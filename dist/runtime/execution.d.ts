import type { Span } from '@opentelemetry/api';
import type { CompiledWorkflow, WorkflowCompilerLimits } from '../workflow/index.ts';
import type { RuntimeTelemetry } from '../telemetry/traces.ts';
import type { LocalRun } from './run-types.ts';
import type { RunEventKind } from './run-transition.ts';
import type { ModelCalls } from './model-port.ts';
import type { ExecutionControl } from './control.ts';
type Awaitable<T> = T | Promise<T>;
/** Host retains execution ownership and concurrency guards. Each save commits checkpoint and event together. */
export interface ExecutionPersistence {
    load(id: string): Awaitable<LocalRun>;
    events(id: string): Awaitable<readonly {
        kind: string;
        data: unknown;
    }[]>;
    save(record: LocalRun, kind: RunEventKind, data: unknown): Awaitable<void>;
    saveSegment(record: LocalRun, span: Span | undefined, operation: 'run' | 'resume' | 'approval'): Awaitable<LocalRun>;
    finishCancellation(record: LocalRun): Awaitable<LocalRun>;
}
export interface ExecutionOptions {
    port: ExecutionPersistence;
    initial: LocalRun;
    graph: CompiledWorkflow;
    limits: WorkflowCompilerLimits;
    maxTransitions: number;
    operation: 'run' | 'resume' | 'approval';
    signal: AbortSignal;
    models?: ModelCalls | undefined;
    telemetry?: RuntimeTelemetry | undefined;
    continuedSpan?: Span | undefined;
    budget?: number;
    control?: ExecutionControl | undefined;
}
/** Shared execution loop. Await every persistence boundary; never retry an uncertain write or dispatch. */
export declare function executeWorkflow(options: ExecutionOptions): Promise<LocalRun>;
export {};

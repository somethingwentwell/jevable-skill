import type { RunStartOptions } from './control.ts';
import type { LocalRun } from './run-types.ts';
/** Retain this UUID before submission; admission can commit even if its acknowledgement is lost. */
export interface AsyncRunOptions extends RunStartOptions {
    id: string;
}
export interface AsyncRun {
    /** A new durable checkpoint, or an observation of an identical retained submission. */
    observation: 'created' | 'retained';
    /** Detached admission-time snapshot, not a promise that the workflow is still paused. Private owner data. */
    run: LocalRun;
    /** This invocation's execution/observation. A resolved approval wait is not workflow completion. */
    completion: Promise<LocalRun>;
}
export declare function parseAsyncRunOptions(value: AsyncRunOptions): AsyncRunOptions;
/** Internal callback is reached only after acknowledged durable creation, before first dispatch.
 * No queue, detached owner, timer, automatic resume or error-to-success conversion is introduced.
 */
export declare function admitAsyncRun(start: (created: (run: LocalRun) => void) => Promise<LocalRun>): Promise<AsyncRun>;

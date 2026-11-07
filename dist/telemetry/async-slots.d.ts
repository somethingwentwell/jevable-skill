export type AsyncSlotPhase = 'admitting' | 'completing';
export interface AsyncSlotObservation {
    admitted(): void;
    end(): void;
}
/** Process-local HTTP capacity observation only; never dispatches, cancels or reads a run. */
export declare function observeAsyncSlot(change: (phase: AsyncSlotPhase, delta: 1 | -1) => void): AsyncSlotObservation;

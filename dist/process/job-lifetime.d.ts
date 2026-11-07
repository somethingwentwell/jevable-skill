type JobSignal = 'SIGINT' | 'SIGTERM';
type Signals = {
    on(event: JobSignal, listener: () => void): unknown;
    removeListener(event: JobSignal, listener: () => void): unknown;
};
export declare class JobInterruptedError extends Error {
    constructor();
}
/** An executable job owns signals only while opening, using or closing its direct SDK owner.
 * Signal reception never calls cancel, close or another operation concurrently with admitted work.
 * SDK imports, selected-owner callers and dedicated service/suite/watch lifetimes are unaffected.
 */
export declare class JobLifetime {
    private readonly report;
    private readonly signals;
    private holds;
    private signal;
    private readonly int;
    private readonly term;
    constructor(report: (receipt: unknown) => void, signals?: Signals);
    get exitCode(): 130 | 143 | undefined;
    private interrupt;
    assertAdmission(): void;
    hold(): () => void;
    dispose(): void;
}
export {};

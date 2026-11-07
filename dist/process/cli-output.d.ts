/** Shared executable-output admission. No CLI dispatcher/runtime-state dependency, cancellation or retry. */
export declare const CLI_OUTPUT_LIMITS: Readonly<{
    stdoutBytes: 32000000;
    stderrBytes: 64000;
    pendingBytes: 64000000;
}>;
export type CliIO = {
    out: (text: string) => unknown;
    err: (text: string) => unknown;
};
type Channel = 'stdout' | 'stderr';
type OutputCode = 'output-limit' | 'output-write-failed' | 'output-encoding-failed';
export declare class CliOutputError extends Error {
    readonly code: OutputCode;
    readonly channel: Channel;
    constructor(code: OutputCode, channel: Channel);
}
export declare function encodeCliJson(value: unknown, channel?: Channel, pretty?: boolean): string;
/** Admit a whole UTF-8 response/NDJSON record before its first write. Native writes
 * await callbacks, including asynchronous EPIPE; no stream is ended/destroyed here.
 * Limits bound admitted output and pending writes, not serialization heap or total stream length.
 */
export declare function createCliOutput(custom?: CliIO): {
    io: {
        out: (text: string) => void;
        err: (text: string) => void;
    };
    record: (error: CliOutputError) => CliOutputError;
    readonly error: CliOutputError | undefined;
    finish(): Promise<void>;
};
export {};

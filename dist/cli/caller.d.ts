import { type CliValues } from './runtime.ts';
/** Explicit grant transport selector. No state/backend/Docker or owner discovery. */
export declare function callerSelection(values: CliValues): void;
/** NDJSON observation from one grant-authorized SSE connection; stopping it never cancels the run. */
export declare function callerStreamFromCli(value: string, values: CliValues, out: (line: string) => void, signals?: {
    on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
    removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}): Promise<number>;
export declare function callerFromCli(action: 'start' | 'read' | 'cancel' | 'checkpoint' | 'control', value: string, values: CliValues): Promise<{
    schemaVersion: 1;
    instanceId: string;
    result: import("../access/caller.ts").CallerRunReceipt;
}>;

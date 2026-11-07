import { type CliValues } from './runtime.ts';
/** Pure explicit reviewer selection, never an owner handshake or local state fallback. */
export declare function reviewerSelection(values: CliValues, role?: string): void;
export declare function reviewerFromCli(file: string, values: CliValues): Promise<{
    schemaVersion: 1;
    instanceId: string;
    result: {
        schemaVersion: 1;
        requestId: string;
        runId: string;
        attemptId: string;
        revision: string;
        action: string;
        at: string;
        pauseAfter: boolean;
        status: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
    };
}>;

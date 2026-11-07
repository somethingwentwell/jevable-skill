import { z } from 'zod';
export declare class RunWatchError extends Error {
    readonly code: 'invalid-watch-options' | 'invalid-watch-response' | 'watch-identity-changed' | 'watch-read-failed';
    constructor(code: 'invalid-watch-options' | 'invalid-watch-response' | 'watch-identity-changed' | 'watch-read-failed');
}
declare const receipt: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    id: z.ZodUUID;
    revision: z.ZodString;
    checkpointSha256: z.ZodString;
    status: z.ZodEnum<{
        cancelled: "cancelled";
        completed: "completed";
        paused: "paused";
        failed: "failed";
        waiting: "waiting";
        executing: "executing";
    }>;
    createdAt: z.ZodISODateTime;
    updatedAt: z.ZodISODateTime;
    steps: z.ZodArray<z.ZodUnknown>;
}, z.core.$strip>;
export interface RunWatchOptions {
    intervalMs?: number;
    durationMs?: number;
    follow?: boolean;
    signal?: AbortSignal;
}
export interface RunWatchClient {
    operation(command: {
        operation: 'runs.show';
        id: string;
    }): Promise<unknown>;
}
export interface RunObservation {
    id: string;
    revision: string;
    checkpointSha256: string;
    instanceId: string;
    status: z.infer<typeof receipt>['status'];
    createdAt: string;
    updatedAt: string;
    recordedSteps: number;
}
export type RunWatchReason = 'completed' | 'failed' | 'cancelled' | 'attention' | 'deadline' | 'interrupted';
export type RunWatchEvent = {
    schemaVersion: 1;
    type: 'snapshot';
    observation: RunObservation;
} | {
    schemaVersion: 1;
    type: 'stopped';
    reason: RunWatchReason;
    polls: number;
    last: RunObservation | null;
    execution: 'not-requested';
};
/** Poll only runs.show. A client must bound each read; interruption never cancels the workflow. */
export declare function watchRun(client: RunWatchClient, id: string, options?: RunWatchOptions): AsyncGenerator<RunWatchEvent>;
export {};

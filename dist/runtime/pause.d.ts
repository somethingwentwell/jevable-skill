import { type LocalRun } from './run-types.ts';
type SavedControl = NonNullable<LocalRun['controlRequests']>[number];
/** Pure admission. A pause is durable control intent, never cancellation or settlement. */
export declare function admitPause(record: LocalRun, request: SavedControl): {
    record: LocalRun;
    admitted: boolean;
};
export declare function requestedPause(record: Pick<LocalRun, 'controlRequests'>): {
    requestId: string;
    expectedCheckpointSha256: string;
    mode: "continue" | "step" | "pause" | "recover";
    actor: string;
    at: string;
    breakpoints?: string[] | undefined;
    delegation?: {
        grantId: string;
        scope: {
            kind: "caller";
            release: {
                id: string;
                sha256: string;
                revision: string;
            };
            permissions: ("start" | "read" | "control" | "cancel")[];
        };
        deadline: string;
    } | undefined;
} | undefined;
/** A paused checkpoint is safe; an executing intent is not proof that a worker is alive. */
export declare function pauseMetadata(record: LocalRun): {
    pause?: never;
} | {
    pause: {
        requestId: string;
        at: string;
        status: string;
        execution: string;
    };
};
export {};

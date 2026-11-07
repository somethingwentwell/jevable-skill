import type { LocalRun } from './run-types.ts';
/** Omitted means retain the last explicit configuration; [] explicitly clears it. */
export declare function breakpointConfiguration(run: Pick<LocalRun, 'controlRequests'>): {
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
/** A durable hit at this exact paused position, not merely membership in the breakpoint list. */
export declare function breakpointAt(run: LocalRun): {
    configurationRequestId: string;
    checkpointSha256: string;
    nodeId: import("../index.ts").NodeId;
    stepCount: number;
    at: string;
    scope?: {
        loop: import("../index.ts").NodeId;
        index: number;
    } | undefined;
} | undefined;
export declare function breakpointMetadata(run: LocalRun): {};

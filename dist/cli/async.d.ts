import { type CliValues } from './usage.ts';
/** Select an existing owned service before reading files. No discovery, local storage or Docker fallback. */
export declare function asyncRunSelection(values: CliValues): void;
export declare function asyncRunFromCli(action: 'submit' | 'observe', value: string, values: CliValues, reviewedRelease?: {
    id: string;
    sha256: string;
    revision: string;
}): Promise<{
    format: "jevable.ai/async-run";
    schemaVersion: 1;
    instanceId: string;
    observation: "read" | "created" | "retained";
    run: {
        id: string;
        revision: string;
        status: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
        createdAt: string;
        updatedAt: string;
        triggerMode?: "api" | undefined;
        startedPaused?: true | undefined;
        project?: {
            id: string;
            generation: number;
        } | undefined;
        release?: {
            id: string;
            sha256: string;
        } | undefined;
        test?: {
            id: string;
            generation: number;
            sha256: string;
        } | undefined;
    };
}>;

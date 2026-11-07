import type { DockerOwnerDependencies } from '../docker/index.ts';
import { type CliValues } from './runtime.ts';
/** Portable HTML is offline; reject every supplied runtime option before reading workflow source. */
export declare function portablePreviewSelection(values: CliValues): void;
/** I/O-free admission shared with the dispatcher, before workflow/trace-viewer/config reads. */
export declare function previewSelection(values: CliValues): {
    selection: "local" | "docker" | "remote";
    port: number;
} | {
    selection: "sqlite" | "postgres";
    port: number;
};
/** Explicit target selection. A Docker preview holds no direct SDK owner or host database. */
export declare function startPreviewFromCli(source: string, values: CliValues, observation?: DockerOwnerDependencies): Promise<{
    preview?: {
        project: {
            id: string;
            generation: number;
            revision: string;
        };
        retention: string;
        visualReview: string;
    };
    release?: Readonly<{
        id: string;
        sha256: string;
        revision: string;
        version: string;
        runtime: Readonly<{
            version: string;
            sha256: string;
        }>;
    }>;
    tls?: {
        minimumVersion: string;
        certificateSha256: string;
    };
    listener: {
        address: string;
        port: number;
    };
    telemetryResource?: {
        serviceInstanceId: string;
    };
    url: string;
    instanceId: `${string}-${string}-${string}-${string}-${string}`;
    protocol: string;
    transport: string;
    close: (timeoutMs?: number) => Promise<{
        activeAsyncRuns?: number;
        status: "draining" | "closed";
        activeRequests: number;
    }>;
    closed: Promise<void>;
}>;

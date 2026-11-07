import { type PostgresRuntimeOptions } from '../runtime/postgres.ts';
import { type RuntimeServerOptions } from './server.ts';
import { type TraceViewerConfig } from '../telemetry/navigation.ts';
import { type PreviewProjectPin } from '../preview/project-pin.ts';
export interface PostgresRuntimeServiceOptions extends RuntimeServerOptions {
    runtime: PostgresRuntimeOptions;
    release?: {
        snapshot: unknown;
    };
    /** Retain the fresh project UUID before startup; an uncertain database commit is not retried. */
    preview?: {
        source: string;
        projectId?: string;
        projectPin?: PreviewProjectPin;
        traceViewer?: TraceViewerConfig;
    };
}
/** Explicit PostgreSQL management, scoped loopback preview or exact-release host. No SQLite fallback. */
export declare function startPostgresRuntimeService(value: PostgresRuntimeServiceOptions): Promise<{
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

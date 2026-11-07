import { type LocalRuntimeOptions } from '../runtime/local.ts';
import { type RuntimeServerOptions } from './server.ts';
import { type TraceViewerConfig } from '../telemetry/navigation.ts';
import { type PreviewProjectPin } from '../preview/project-pin.ts';
export interface RuntimeServiceOptions extends RuntimeServerOptions {
    runtime: LocalRuntimeOptions;
    preview?: {
        source: string;
        projectPin?: PreviewProjectPin;
        traceViewer?: TraceViewerConfig;
    };
    release?: {
        snapshot: unknown;
    };
}
/** SQLite host, including separately scoped local preview and exact-release execution modes. */
export declare function startRuntimeService(options: RuntimeServiceOptions): Promise<{
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

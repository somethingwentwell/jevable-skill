import { type RuntimeServerOptions } from './server.ts';
import type { RuntimeOperation } from './operations.ts';
import { type TraceViewerConfig } from '../telemetry/navigation.ts';
import { type PreviewProjectPin } from '../preview/project-pin.ts';
export interface PreviewGatewayOptions extends Omit<RuntimeServerOptions, 'tls' | 'actor'> {
    source: string;
    /** A caller-retained, fresh UUID. Startup may commit this project even if its response is lost. */
    projectId: string;
    /** Optional explicit read-only attachment. Must identify this same projectId. */
    projectPin?: PreviewProjectPin;
    traceViewer?: TraceViewerConfig;
}
export interface PreviewGatewayOwner {
    /** Supply an authenticated, instance-pinned owner. This gateway never discovers or starts one. */
    call(command: RuntimeOperation, traceParent?: string): Promise<unknown>;
}
/** Foreground loopback HTML gateway. Closing it never closes or cancels the remote runtime. */
export declare function startPreviewGateway(options: PreviewGatewayOptions, owner: PreviewGatewayOwner): Promise<{
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

/** Offline Collector configuration packaging. No files, credentials, sockets or owners are opened here. */
import { z } from 'zod';
export declare const COLLECTOR_GATEWAY_PROFILE: "otelcol-contrib-0.136.0";
export declare const COLLECTOR_GATEWAY_OPTIONS_MAX_BYTES = 16384;
export declare const collectorGatewayOptionsSchema: z.ZodObject<{
    profile: z.ZodLiteral<"otelcol-contrib-0.136.0">;
    receiver: z.ZodObject<{
        protocol: z.ZodEnum<{
            "http/protobuf": "http/protobuf";
            grpc: "grpc";
        }>;
        bindAddress: z.ZodEnum<{
            "127.0.0.1": "127.0.0.1";
            "::1": "::1";
            "0.0.0.0": "0.0.0.0";
            "::": "::";
        }>;
        port: z.ZodNumber;
    }, z.core.$strict>;
    backends: z.ZodObject<{
        traces: z.ZodOptional<z.ZodObject<{
            protocol: z.ZodEnum<{
                "http/protobuf": "http/protobuf";
                grpc: "grpc";
            }>;
            endpoint: z.ZodString;
            authentication: z.ZodEnum<{
                none: "none";
                "bearer-file": "bearer-file";
            }>;
            extraCa: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strict>>;
        metrics: z.ZodOptional<z.ZodObject<{
            protocol: z.ZodEnum<{
                "http/protobuf": "http/protobuf";
                grpc: "grpc";
            }>;
            endpoint: z.ZodString;
            authentication: z.ZodEnum<{
                none: "none";
                "bearer-file": "bearer-file";
            }>;
            extraCa: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strict>>;
        logs: z.ZodOptional<z.ZodObject<{
            protocol: z.ZodEnum<{
                "http/protobuf": "http/protobuf";
                grpc: "grpc";
            }>;
            endpoint: z.ZodString;
            authentication: z.ZodEnum<{
                none: "none";
                "bearer-file": "bearer-file";
            }>;
            extraCa: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    enrichment: z.ZodOptional<z.ZodObject<{
        clusterName: z.ZodOptional<z.ZodString>;
        environment: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    memory: z.ZodObject<{
        limitMiB: z.ZodNumber;
        spikeLimitMiB: z.ZodNumber;
    }, z.core.$strict>;
    batch: z.ZodOptional<z.ZodObject<{
        maxRecords: z.ZodNumber;
        timeoutMs: z.ZodNumber;
    }, z.core.$strict>>;
    forwarding: z.ZodObject<{
        queueSize: z.ZodNumber;
        retryMaxElapsedMs: z.ZodNumber;
        persistentQueue: z.ZodOptional<z.ZodObject<{
            directory: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    selfMetrics: z.ZodOptional<z.ZodObject<{
        bindAddress: z.ZodEnum<{
            "127.0.0.1": "127.0.0.1";
            "::1": "::1";
        }>;
        port: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type CollectorGatewayOptions = z.input<typeof collectorGatewayOptionsSchema>;
export type CollectorGatewayPolicy = z.output<typeof collectorGatewayOptionsSchema>;
/** Normalize a detached, bounded selection. Secret bytes and arbitrary Collector components are deliberately not inputs. */
export declare function inspectCollectorGatewayOptions(value: unknown): {
    profile: "otelcol-contrib-0.136.0";
    receiver: {
        protocol: "http/protobuf" | "grpc";
        bindAddress: "127.0.0.1" | "::1" | "0.0.0.0" | "::";
        port: number;
    };
    backends: {
        traces?: {
            protocol: "http/protobuf" | "grpc";
            endpoint: string;
            authentication: "none" | "bearer-file";
            extraCa: boolean;
        } | undefined;
        metrics?: {
            protocol: "http/protobuf" | "grpc";
            endpoint: string;
            authentication: "none" | "bearer-file";
            extraCa: boolean;
        } | undefined;
        logs?: {
            protocol: "http/protobuf" | "grpc";
            endpoint: string;
            authentication: "none" | "bearer-file";
            extraCa: boolean;
        } | undefined;
    };
    memory: {
        limitMiB: number;
        spikeLimitMiB: number;
    };
    forwarding: {
        queueSize: number;
        retryMaxElapsedMs: number;
        persistentQueue?: {
            directory: string;
        } | undefined;
    };
    enrichment?: {
        clusterName?: string | undefined;
        environment?: string | undefined;
    } | undefined;
    batch?: {
        maxRecords: number;
        timeoutMs: number;
    } | undefined;
    selfMetrics?: {
        bindAddress: "127.0.0.1" | "::1";
        port: number;
    } | undefined;
};
/** Pure SDK export. Does not validate credential files, fetch a binary/image, send telemetry or start a Collector. */
export declare function createCollectorGatewayBundle(value: unknown): {
    manifest: {
        schemaVersion: number;
        format: string;
        profile: "otelcol-contrib-0.136.0";
        optionsSha256: string;
        enabledSignals: ("metrics" | "traces" | "logs")[];
        selfMetrics: {
            enabled: boolean;
            bindAddress?: never;
            port?: never;
            transport?: never;
            format?: never;
        } | {
            enabled: boolean;
            bindAddress: "127.0.0.1" | "::1";
            port: number;
            transport: string;
            format: string;
        };
        requiredPrivateFiles: string[];
        execution: string;
        collectorQualification: string;
        clusterQualification: string;
        files: {
            path: string;
            bytes: number;
            sha256: string;
        }[];
    };
    bytes: Uint8Array<ArrayBuffer>;
};

import type { TelemetryPolicy } from './config.ts';
import { type OtlpCredential } from './otlp.ts';
import type { OtlpSignal } from './grpc.ts';
/** Shared bounded record transport for traces/logs; no retry, ambient settings or collector diagnostics. */
export declare class BoundedOtlpQueue<T> {
    private readonly policy;
    private readonly endpoint;
    private readonly credential;
    private readonly serialize;
    private readonly rejected;
    private readonly canExport;
    private readonly signal;
    private queue;
    private timer;
    private pumping;
    private controller;
    private stopped;
    private closing;
    private inFlight;
    private counters;
    private lastSuccessAt;
    private lastFailure;
    constructor(policy: TelemetryPolicy, endpoint: string, credential: OtlpCredential, serialize: (batch: T[]) => Uint8Array | undefined, rejected: (response: Uint8Array) => number, canExport?: () => boolean, signal?: OtlpSignal);
    busy(): boolean;
    enqueue(record: T): void;
    private schedule;
    status(): {
        queued: number;
        inFlight: number;
        lastSuccessAt: string | null;
        lastFailure: "response" | "transport" | "serialization" | "partial-rejection" | null;
        closed: boolean;
        deliveryGuarantee: string;
        accepted: number;
        exported: number;
        rejected: number;
        dropped: number;
        failedBatches: number;
        successfulBatches: number;
        enabled: boolean;
        protocol: "http/protobuf" | "grpc";
    };
    private pump;
    forceFlush(): Promise<void>;
    shutdown(): Promise<void>;
}

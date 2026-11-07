import { z } from 'zod';
declare const resultSchema: z.ZodObject<{
    signal: z.ZodEnum<{
        metrics: "metrics";
        traces: "traces";
        logs: "logs";
    }>;
    outcome: z.ZodEnum<{
        failed: "failed";
        acknowledged: "acknowledged";
        rejected: "rejected";
        aborted: "aborted";
        warning: "warning";
        "not-sent": "not-sent";
    }>;
    records: z.ZodLiteral<1>;
    attempted: z.ZodBoolean;
    rejected: z.ZodNullable<z.ZodNumber>;
    failure: z.ZodNullable<z.ZodEnum<{
        response: "response";
        transport: "transport";
        aborted: "aborted";
        serialization: "serialization";
        collection: "collection";
        "partial-rejection": "partial-rejection";
    }>>;
}, z.core.$strict>;
export declare const collectorProbeReportSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    id: z.ZodUUID;
    startedAt: z.ZodISODateTime;
    finishedAt: z.ZodISODateTime;
    status: z.ZodEnum<{
        failed: "failed";
        acknowledged: "acknowledged";
        disabled: "disabled";
        aborted: "aborted";
        warning: "warning";
    }>;
    protocol: z.ZodNullable<z.ZodEnum<{
        "http/protobuf": "http/protobuf";
        grpc: "grpc";
    }>>;
    signals: z.ZodArray<z.ZodObject<{
        signal: z.ZodEnum<{
            metrics: "metrics";
            traces: "traces";
            logs: "logs";
        }>;
        outcome: z.ZodEnum<{
            failed: "failed";
            acknowledged: "acknowledged";
            rejected: "rejected";
            aborted: "aborted";
            warning: "warning";
            "not-sent": "not-sent";
        }>;
        records: z.ZodLiteral<1>;
        attempted: z.ZodBoolean;
        rejected: z.ZodNullable<z.ZodNumber>;
        failure: z.ZodNullable<z.ZodEnum<{
            response: "response";
            transport: "transport";
            aborted: "aborted";
            serialization: "serialization";
            collection: "collection";
            "partial-rejection": "partial-rejection";
        }>>;
    }, z.core.$strict>>;
    trace: z.ZodNullable<z.ZodObject<{
        traceId: z.ZodString;
        spanId: z.ZodString;
        traceFlags: z.ZodLiteral<1>;
    }, z.core.$strict>>;
    execution: z.ZodLiteral<"not-run">;
    retries: z.ZodLiteral<false>;
    sampling: z.ZodLiteral<"explicit-synthetic; independent-of-workflow-sampling">;
    deliveryGuarantee: z.ZodLiteral<"collector-response-only; not-backend-storage-or-dashboard">;
}, z.core.$strict>;
export type CollectorProbeReport = z.infer<typeof collectorProbeReportSchema>;
export type CollectorProbeSignalResult = z.infer<typeof resultSchema>;
/** Fresh identity per explicit invocation; not a durable or idempotent execution receipt. */
export declare function disabledCollectorProbe(): CollectorProbeReport;
export {};

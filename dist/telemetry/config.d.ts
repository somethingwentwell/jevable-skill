import { z } from 'zod';
export declare const telemetryConfigSchema: z.ZodObject<{
    protocol: z.ZodDefault<z.ZodEnum<{
        "http/protobuf": "http/protobuf";
        grpc: "grpc";
    }>>;
    endpoint: z.ZodOptional<z.ZodString>;
    metricsEndpoint: z.ZodOptional<z.ZodString>;
    exporterMetrics: z.ZodDefault<z.ZodBoolean>;
    retainedStateMetrics: z.ZodDefault<z.ZodBoolean>;
    runtimeWorkMetrics: z.ZodDefault<z.ZodBoolean>;
    storageQueueMetrics: z.ZodDefault<z.ZodBoolean>;
    storageTransactionMetrics: z.ZodDefault<z.ZodBoolean>;
    journalTransactions: z.ZodDefault<z.ZodBoolean>;
    sqliteStatementMetrics: z.ZodDefault<z.ZodBoolean>;
    httpRequests: z.ZodDefault<z.ZodBoolean>;
    httpResponseContext: z.ZodDefault<z.ZodBoolean>;
    httpConnections: z.ZodDefault<z.ZodBoolean>;
    httpAccessDecisions: z.ZodDefault<z.ZodBoolean>;
    grantOperations: z.ZodDefault<z.ZodBoolean>;
    grantPolicyDecisions: z.ZodDefault<z.ZodBoolean>;
    baggageKeys: z.ZodOptional<z.ZodArray<z.ZodString>>;
    logsEndpoint: z.ZodOptional<z.ZodString>;
    authentication: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"none">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"bearer">;
        credentialRef: z.ZodString;
    }, z.core.$strict>], "kind">;
    serviceName: z.ZodDefault<z.ZodString>;
    environment: z.ZodDefault<z.ZodString>;
    resource: z.ZodOptional<z.ZodObject<{
        serviceNamespace: z.ZodOptional<z.ZodString>;
        kubernetes: z.ZodOptional<z.ZodObject<{
            namespace: z.ZodOptional<z.ZodString>;
            podName: z.ZodOptional<z.ZodString>;
            podUid: z.ZodOptional<z.ZodString>;
            containerName: z.ZodOptional<z.ZodString>;
            nodeName: z.ZodOptional<z.ZodString>;
            clusterName: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    sampleRatio: z.ZodDefault<z.ZodNumber>;
    queueSize: z.ZodDefault<z.ZodNumber>;
    batchSize: z.ZodDefault<z.ZodNumber>;
    timeoutMs: z.ZodDefault<z.ZodNumber>;
    flushTimeoutMs: z.ZodDefault<z.ZodNumber>;
    intervalMs: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
export type TelemetryConfig = z.input<typeof telemetryConfigSchema>;
export type TelemetryPolicy = z.output<typeof telemetryConfigSchema>;
export declare function parseTelemetryConfig(value: unknown): TelemetryPolicy;
/** Narrow W3C v00 admission. No ambient context or tracestate is accepted. Baggage has a separate explicit policy. */
export declare function parseTraceParent(value: string | undefined): {
    traceId: string;
    spanId: string;
    traceFlags: number;
    isRemote: boolean;
} | undefined;

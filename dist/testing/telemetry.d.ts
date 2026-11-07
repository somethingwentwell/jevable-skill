import { RuntimeTelemetry } from '../telemetry/traces.ts';
import { type TelemetryConfig } from '../telemetry/config.ts';
import type { OtlpCredential } from '../telemetry/otlp.ts';
import { type TraceRequestContext } from '../telemetry/baggage.ts';
import type { SuiteObservation, SuiteObservationIdentity } from './suite-observation.ts';
/** Client diagnostics never impersonate storage, execution workers, sockets or grant administration. */
export declare function parseSuiteTelemetryConfig(value: unknown): {
    serviceName: string;
    protocol: "http/protobuf" | "grpc";
    exporterMetrics: boolean;
    retainedStateMetrics: boolean;
    runtimeWorkMetrics: boolean;
    storageQueueMetrics: boolean;
    storageTransactionMetrics: boolean;
    journalTransactions: boolean;
    sqliteStatementMetrics: boolean;
    httpRequests: boolean;
    httpResponseContext: boolean;
    httpConnections: boolean;
    httpAccessDecisions: boolean;
    grantOperations: boolean;
    grantPolicyDecisions: boolean;
    authentication: {
        kind: "none";
    } | {
        kind: "bearer";
        credentialRef: string;
    };
    environment: string;
    sampleRatio: number;
    queueSize: number;
    batchSize: number;
    timeoutMs: number;
    flushTimeoutMs: number;
    intervalMs: number;
    endpoint?: string | undefined;
    metricsEndpoint?: string | undefined;
    baggageKeys?: string[] | undefined;
    logsEndpoint?: string | undefined;
    resource?: {
        serviceNamespace?: string | undefined;
        kubernetes?: {
            namespace?: string | undefined;
            podName?: string | undefined;
            podUid?: string | undefined;
            containerName?: string | undefined;
            nodeName?: string | undefined;
            clusterName?: string | undefined;
        } | undefined;
    } | undefined;
};
export interface TestSuiteTelemetry {
    observeTestSuite(identity: SuiteObservationIdentity, context?: Readonly<TraceRequestContext>): SuiteObservation | undefined;
    traceContext(fallback?: Readonly<TraceRequestContext>): Readonly<TraceRequestContext> | undefined;
    withTraceContext<T>(context: TraceRequestContext, work: () => T): T;
    status(): ReturnType<RuntimeTelemetry['status']>;
    flush(): ReturnType<RuntimeTelemetry['flush']>;
    close(): ReturnType<RuntimeTelemetry['close']>;
}
/** Explicit, private client pipeline. No runtime/storage owner, environment discovery or global OTel registration. */
export declare function createTestSuiteTelemetry(config: TelemetryConfig, options?: {
    credential?: OtlpCredential;
}): TestSuiteTelemetry;

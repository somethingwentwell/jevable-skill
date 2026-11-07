import { type CliValues } from './runtime.ts';
export declare const suiteTelemetryFlags: string[];
/** Pure selection guard: these are client diagnostics, never selected-owner configuration. */
export declare function suiteTelemetrySelection(values: CliValues, selection: 'selected' | 'http' | 'local'): void;
/** Validate private client config/key before owner credentials or network. Never consult workflow credential storage. */
export declare function readSuiteTelemetryOptions(values: CliValues): Promise<{
    config: {
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
    credential?: never;
} | {
    config: {
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
    credential: () => string;
} | undefined>;

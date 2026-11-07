export declare function localRuntimeOptions(values: Record<string, string | boolean | undefined>, defaultDirectory?: string): Promise<{
    notifications?: {
        endpoints: {
            id: string;
            url: string;
            credentialRef: string;
            timeoutMs: number;
        }[];
        maxInFlight: number;
        maxDeliveries: number;
        maxEvents: number;
        automatic?: {
            policy: {
                format: "jevable.ai/automatic-approval-policy/v1";
                routes: {
                    scope: {
                        kind: "project";
                        id: string;
                        generation: number;
                        revision: string;
                    } | {
                        kind: "release";
                        id: string;
                        sha256: string;
                        revision: string;
                    };
                    endpointId: string;
                    endpointSha256: string;
                    eventKinds: ("cancelled" | "expired" | "requested" | "decided")[];
                }[];
            };
            reviewedPolicySha256: string;
            maxPending: number;
            maxAdmissions: number;
            maxEvents: number;
        } | undefined;
    };
    dataDirectory: string;
} | {
    telemetry: {
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
        serviceName: string;
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
    notifications?: {
        endpoints: {
            id: string;
            url: string;
            credentialRef: string;
            timeoutMs: number;
        }[];
        maxInFlight: number;
        maxDeliveries: number;
        maxEvents: number;
        automatic?: {
            policy: {
                format: "jevable.ai/automatic-approval-policy/v1";
                routes: {
                    scope: {
                        kind: "project";
                        id: string;
                        generation: number;
                        revision: string;
                    } | {
                        kind: "release";
                        id: string;
                        sha256: string;
                        revision: string;
                    };
                    endpointId: string;
                    endpointSha256: string;
                    eventKinds: ("cancelled" | "expired" | "requested" | "decided")[];
                }[];
            };
            reviewedPolicySha256: string;
            maxPending: number;
            maxAdmissions: number;
            maxEvents: number;
        } | undefined;
    };
    dataDirectory: string;
}>;

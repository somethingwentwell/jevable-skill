export declare class KubernetesCapacityInputError extends Error {
    constructor();
}
/** Pure request-budget diagnostic on explicit snapshots, not scheduler simulation,
 * admission, reservation, topology/security verification, runtime launch or cleanup.
 * Sidecar/init/overhead and resize accounting follow Kubernetes v1.35 helpers.
 */
export declare function inspectKubernetesCapacity(input: {
    nodes: unknown;
    pods: unknown;
    workloadYaml: string;
}): {
    schemaVersion: number;
    kind: string;
    status: "insufficient-capacity" | "no-obvious-request-shortage";
    execution: "not-run";
    clusterMutation: boolean;
    capacityReserved: boolean;
    assessment: "additional-pods-not-replacement-credit";
    accounting: "kubernetes-v1.35-cpu-memory-pod-requests";
    workloads: {
        workload: string;
        replicas: number;
        perPod: {
            cpuMillis: string;
            memoryBytes: string;
            pods: string;
        };
        candidateNodes: string[];
    }[];
    demand: {
        cpuMillis: string;
        memoryBytes: string;
        pods: string;
    };
    nodes: {
        name: string;
        allocatable: {
            cpuMillis: string;
            memoryBytes: string;
            pods: string;
        };
        requested: {
            cpuMillis: string;
            memoryBytes: string;
            pods: string;
        };
        available: {
            cpuMillis: string;
            memoryBytes: string;
            pods: string;
        };
    }[];
    pendingPodsNotReserved: number;
    shortages: {
        workload: string;
        code: string;
        message: string;
    }[];
    limitations: string[];
};

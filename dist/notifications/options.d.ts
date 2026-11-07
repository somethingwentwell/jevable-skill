/** Startup-only configuration for the explicitly selected owner; never an endpoint override on a send request. */
export declare function notificationOptions(values: Record<string, string | boolean | undefined>): Promise<{
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
} | undefined>;

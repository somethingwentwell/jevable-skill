/** Read/capture protected startup input without connecting, initializing or exposing credentials. */
export declare function readCliRateCoordinator(values: Record<string, string | boolean | undefined>): Promise<{
    connection: {
        host: string;
        port: number;
        database: string;
        user: string;
        password: string;
        tls: {
            mode: "verify-full";
            ca?: string | undefined;
        } | {
            mode: "loopback-test";
        };
    };
    scope: string;
    policy: {
        requests: {
            capacity: number;
            refillTokens: number;
            refillIntervalMs: number;
        };
        controls: {
            capacity: number;
            refillTokens: number;
            refillIntervalMs: number;
        };
    };
    initialize: boolean;
    timeoutMs: number;
    statementTimeoutMs: number;
    maxPendingDebits: number;
} | undefined>;

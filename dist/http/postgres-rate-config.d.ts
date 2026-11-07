/** Driver-free shared quota admission; no environment lookup or database I/O. */
import { z } from 'zod';
export declare const postgresHttpRateCoordinatorOptionsSchema: z.ZodObject<{
    connection: z.ZodObject<{
        port: z.ZodNumber;
        host: z.ZodString;
        database: z.ZodString;
        user: z.ZodString;
        password: z.ZodString;
        tls: z.ZodDiscriminatedUnion<[z.ZodObject<{
            mode: z.ZodLiteral<"verify-full">;
            ca: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            mode: z.ZodLiteral<"loopback-test">;
        }, z.core.$strict>], "mode">;
    }, z.core.$strict>;
    scope: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    policy: z.ZodObject<{
        requests: z.ZodObject<{
            capacity: z.ZodNumber;
            refillTokens: z.ZodNumber;
            refillIntervalMs: z.ZodNumber;
        }, z.core.$strict>;
        controls: z.ZodObject<{
            capacity: z.ZodNumber;
            refillTokens: z.ZodNumber;
            refillIntervalMs: z.ZodNumber;
        }, z.core.$strict>;
    }, z.core.$strict>;
    initialize: z.ZodBoolean;
    timeoutMs: z.ZodNumber;
    statementTimeoutMs: z.ZodNumber;
    maxPendingDebits: z.ZodNumber;
}, z.core.$strict>;
export type PostgresHttpRateCoordinatorOptions = z.input<typeof postgresHttpRateCoordinatorOptionsSchema>;
export type PostgresHttpRateCoordinatorCode = 'invalid-config' | 'invalid-command' | 'policy-conflict' | 'uninitialized' | 'version-mismatch' | 'corrupt' | 'capacity' | 'aborted' | 'unavailable' | 'commit-uncertain' | 'closed';
export declare class PostgresHttpRateCoordinatorError extends Error {
    readonly code: PostgresHttpRateCoordinatorCode;
    constructor(code: PostgresHttpRateCoordinatorCode);
}
export declare function parsePostgresHttpRateCoordinatorOptions(value: unknown): {
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
};

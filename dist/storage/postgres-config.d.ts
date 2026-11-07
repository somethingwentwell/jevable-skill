import { z } from 'zod';
export declare const postgresConfigSchema: z.ZodObject<{
    host: z.ZodString;
    port: z.ZodNumber;
    database: z.ZodString;
    user: z.ZodString;
    password: z.ZodString;
    namespace: z.ZodString;
    initialize: z.ZodBoolean;
    tls: z.ZodDiscriminatedUnion<[z.ZodObject<{
        mode: z.ZodLiteral<"verify-full">;
        ca: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        mode: z.ZodLiteral<"loopback-test">;
    }, z.core.$strict>], "mode">;
    maxRecordBytes: z.ZodDefault<z.ZodNumber>;
    maxBatchBytes: z.ZodDefault<z.ZodNumber>;
    maxRecords: z.ZodDefault<z.ZodNumber>;
    maxBatches: z.ZodDefault<z.ZodNumber>;
    maxEvents: z.ZodDefault<z.ZodNumber>;
    statementTimeoutMs: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
export type PostgresJournalOptions = z.input<typeof postgresConfigSchema>;
/** Pure admission shared by startup and read-only diagnostics; never creates a client or connects. */
export declare function parsePostgresConfiguration(value: unknown): {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    namespace: string;
    initialize: boolean;
    tls: {
        mode: "verify-full";
        ca?: string | undefined;
    } | {
        mode: "loopback-test";
    };
    maxRecordBytes: number;
    maxBatchBytes: number;
    maxRecords: number;
    maxBatches: number;
    maxEvents: number;
    statementTimeoutMs: number;
};

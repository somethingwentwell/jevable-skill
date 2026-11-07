import { z } from 'zod';
import { type RuntimeTraceContext } from '../http/client.ts';
import { type RuntimeOperation } from '../http/operations.ts';
import { type DockerOwnerDependencies } from '../docker/index.ts';
import { type CliValues } from './runtime.ts';
export declare const operationFlags: string[];
/** Validate the target before reading credentials or opening any storage. */
export declare function operationSelection(values: CliValues): 'local' | 'docker' | 'remote';
export interface CliOperations {
    readonly storage: 'sqlite' | 'postgres';
    call(command: RuntimeOperation, traceContext?: RuntimeTraceContext): Promise<unknown>;
    close(): Promise<void>;
}
/** Injectable read-only owner observation for tests; production always uses the selected local Docker engine. */
export declare function openCliOperations(values: CliValues, observation?: DockerOwnerDependencies): Promise<CliOperations>;
export declare function operationResult<T>(schema: z.ZodType<T>, value: unknown): T;
export declare const runResultSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    id: z.ZodUUID;
    status: z.ZodEnum<{
        cancelled: "cancelled";
        completed: "completed";
        paused: "paused";
        failed: "failed";
        waiting: "waiting";
        executing: "executing";
    }>;
}, z.core.$strip>;
export declare const testResultSchema: z.ZodObject<{
    assessment: z.ZodEnum<{
        failed: "failed";
        pending: "pending";
        uncertain: "uncertain";
        passed: "passed";
    }>;
    terminal: z.ZodBoolean;
    run: z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        id: z.ZodUUID;
        status: z.ZodEnum<{
            cancelled: "cancelled";
            completed: "completed";
            paused: "paused";
            failed: "failed";
            waiting: "waiting";
            executing: "executing";
        }>;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const resultExit: (run: z.infer<typeof runResultSchema>) => number;
export declare function operationRelease(value: unknown, id: string): import("../releases/snapshot.ts").Release;
/** Enumerate the fresh imported project's case identities through the same bounded API on either backend. */
export declare function importedOperationTests(host: Pick<CliOperations, 'call'>, projectId: string): Promise<{
    id: string;
    generation: number;
    status: "draft" | "accepted";
    sha256: string;
}[]>;

import { z } from 'zod';
import type { AsyncRun } from '../runtime/async-run.ts';
import type { LocalRuntime } from '../runtime/local.ts';
import type { PostgresRuntime } from '../runtime/postgres.ts';
import type { LocalRun } from '../runtime/run-types.ts';
export declare const asyncRunPolicySchema: z.ZodObject<{
    maxConcurrentRuns: z.ZodNumber;
}, z.core.$strict>;
export type AsyncRunPolicy = z.infer<typeof asyncRunPolicySchema>;
export declare const asyncReleasePinSchema: z.ZodObject<{
    id: z.ZodUUID;
    sha256: z.ZodString;
    revision: z.ZodString;
}, z.core.$strict>;
export declare const asyncRunRequestSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    yaml: z.ZodString;
    id: z.ZodUUID;
    input: z.ZodJSONSchema;
    paused: z.ZodOptional<z.ZodBoolean>;
    triggerMode: z.ZodOptional<z.ZodLiteral<"api">>;
    kind: z.ZodLiteral<"workflow">;
}, z.core.$strict>, z.ZodObject<{
    project: z.ZodObject<{
        id: z.ZodUUID;
        generation: z.ZodNumber;
        revision: z.ZodString;
    }, z.core.$strict>;
    id: z.ZodUUID;
    input: z.ZodJSONSchema;
    paused: z.ZodOptional<z.ZodBoolean>;
    triggerMode: z.ZodOptional<z.ZodLiteral<"api">>;
    kind: z.ZodLiteral<"project">;
}, z.core.$strict>, z.ZodObject<{
    release: z.ZodObject<{
        id: z.ZodUUID;
        sha256: z.ZodString;
        revision: z.ZodString;
    }, z.core.$strict>;
    id: z.ZodUUID;
    input: z.ZodJSONSchema;
    paused: z.ZodOptional<z.ZodBoolean>;
    triggerMode: z.ZodOptional<z.ZodLiteral<"api">>;
    kind: z.ZodLiteral<"release">;
}, z.core.$strict>], "kind">;
export type AsyncRunRequest = z.input<typeof asyncRunRequestSchema>;
export declare const asyncRunMetadataSchema: z.ZodObject<{
    id: z.ZodUUID;
    revision: z.ZodString;
    status: z.ZodEnum<{
        cancelled: "cancelled";
        completed: "completed";
        paused: "paused";
        failed: "failed";
        waiting: "waiting";
        executing: "executing";
    }>;
    createdAt: z.ZodISODateTime;
    updatedAt: z.ZodISODateTime;
    triggerMode: z.ZodOptional<z.ZodLiteral<"api">>;
    startedPaused: z.ZodOptional<z.ZodLiteral<true>>;
    project: z.ZodOptional<z.ZodObject<{
        id: z.ZodUUID;
        generation: z.ZodNumber;
    }, z.core.$strict>>;
    release: z.ZodOptional<z.ZodObject<{
        id: z.ZodUUID;
        sha256: z.ZodString;
    }, z.core.$strict>>;
    test: z.ZodOptional<z.ZodObject<{
        id: z.ZodUUID;
        generation: z.ZodNumber;
        sha256: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const asyncRunReceiptSchema: z.ZodObject<{
    format: z.ZodLiteral<"jevable.ai/async-run">;
    schemaVersion: z.ZodLiteral<1>;
    instanceId: z.ZodUUID;
    observation: z.ZodEnum<{
        read: "read";
        created: "created";
        retained: "retained";
    }>;
    run: z.ZodObject<{
        id: z.ZodUUID;
        revision: z.ZodString;
        status: z.ZodEnum<{
            cancelled: "cancelled";
            completed: "completed";
            paused: "paused";
            failed: "failed";
            waiting: "waiting";
            executing: "executing";
        }>;
        createdAt: z.ZodISODateTime;
        updatedAt: z.ZodISODateTime;
        triggerMode: z.ZodOptional<z.ZodLiteral<"api">>;
        startedPaused: z.ZodOptional<z.ZodLiteral<true>>;
        project: z.ZodOptional<z.ZodObject<{
            id: z.ZodUUID;
            generation: z.ZodNumber;
        }, z.core.$strict>>;
        release: z.ZodOptional<z.ZodObject<{
            id: z.ZodUUID;
            sha256: z.ZodString;
        }, z.core.$strict>>;
        test: z.ZodOptional<z.ZodObject<{
            id: z.ZodUUID;
            generation: z.ZodNumber;
            sha256: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
}, z.core.$strict>;
export type AsyncRunReceipt = z.infer<typeof asyncRunReceiptSchema>;
/** Deliberate metadata projection: no source, input/output, actor, node payload or completion promise. */
export declare function asyncRunReceipt(instanceId: string, run: LocalRun, observation: AsyncRunReceipt['observation']): AsyncRunReceipt;
type Methods = 'runAsync' | 'runProjectAsync' | 'runReleaseAsync' | 'show' | 'release';
type Runtime = Pick<LocalRuntime, Methods> | Pick<PostgresRuntime, Methods>;
export interface AsyncRunHost {
    start(value: unknown): Promise<AsyncRun>;
    show(id: string): Promise<LocalRun>;
}
/** Trusted owned SDK adapter only. The HTTP transport independently controls opt-in/authentication/lifetime. */
export declare class AsyncRunSession implements AsyncRunHost {
    private readonly runtime;
    private readonly pinnedRelease;
    constructor(runtime: Runtime, snapshot?: unknown);
    start(value: unknown): Promise<AsyncRun>;
    show(value: string): Promise<LocalRun>;
}
export {};

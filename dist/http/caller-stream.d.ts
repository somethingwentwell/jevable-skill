import { z } from 'zod';
import { type CallerReleasePin } from '../access/caller.ts';
export declare const callerStreamOptionsSchema: z.ZodObject<{
    intervalMs: z.ZodDefault<z.ZodNumber>;
    durationMs: z.ZodDefault<z.ZodNumber>;
    follow: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>;
/** Connection-local observation, not a durable cursor, execution request or output read. */
export declare const callerStreamRequestSchema: z.ZodObject<{
    intervalMs: z.ZodDefault<z.ZodNumber>;
    durationMs: z.ZodDefault<z.ZodNumber>;
    follow: z.ZodDefault<z.ZodBoolean>;
    id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    release: z.ZodObject<{
        id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        sha256: z.ZodString;
        revision: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>;
export type CallerStreamRequest = z.infer<typeof callerStreamRequestSchema>;
export type CallerStreamOptions = z.input<typeof callerStreamOptionsSchema> & {
    signal?: AbortSignal;
};
export declare const callerStreamEventSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    type: z.ZodLiteral<"snapshot">;
    sequence: z.ZodNumber;
    instanceId: z.ZodUUID;
    result: z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        revision: z.ZodString;
        release: z.ZodObject<{
            id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
            sha256: z.ZodString;
        }, z.core.$strict>;
        createdAt: z.ZodISODateTime;
        updatedAt: z.ZodISODateTime;
        status: z.ZodEnum<{
            cancelled: "cancelled";
            completed: "completed";
            paused: "paused";
            failed: "failed";
            waiting: "waiting";
            executing: "executing";
        }>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    type: z.ZodLiteral<"stopped">;
    sequence: z.ZodNumber;
    instanceId: z.ZodUUID;
    reason: z.ZodEnum<{
        cancelled: "cancelled";
        completed: "completed";
        deadline: "deadline";
        failed: "failed";
        attention: "attention";
        interrupted: "interrupted";
        draining: "draining";
        "read-refused": "read-refused";
    }>;
    execution: z.ZodLiteral<"not-requested">;
}, z.core.$strict>], "type">;
export type CallerStreamEvent = z.infer<typeof callerStreamEventSchema>;
export declare class CallerStreamError extends Error {
    constructor();
}
/** Read admission is delegated to the existing SDK on EVERY poll, including unchanged state.
 * Never retain the private completed output, adopt caller trace context or invoke a mutation.
 */
export declare function observeCallerRun(read: () => Promise<unknown>, instanceId: string, request: CallerStreamRequest, signal: AbortSignal): AsyncGenerator<CallerStreamEvent | null>;
export declare function encodeCallerStreamEvent(event: CallerStreamEvent | null): string;
/** Validate an untrusted stream before yielding it. No metadata widening or silent sequence gaps. */
export declare function admitCallerStreamEvent(raw: unknown, instanceId: string, id: string, release: CallerReleasePin, previous?: CallerStreamEvent): CallerStreamEvent;

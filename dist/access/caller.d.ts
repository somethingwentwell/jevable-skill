import { z } from 'zod';
import type { LocalRun } from '../runtime/run-types.ts';
import { type GrantMetadata } from './grants.ts';
import type { GrantActionAdmission } from './actions.ts';
/** Private immutable creation evidence. Never accepted from a caller's start options. */
export declare const callerBindingSchema: z.ZodObject<{
    grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    actor: z.ZodString;
    at: z.ZodISODateTime;
    scope: z.ZodObject<{
        kind: z.ZodLiteral<"caller">;
        release: z.ZodObject<{
            id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
            sha256: z.ZodString;
            revision: z.ZodString;
        }, z.core.$strict>;
        permissions: z.ZodPipe<z.ZodArray<z.ZodEnum<{
            start: "start";
            read: "read";
            control: "control";
            cancel: "cancel";
        }>>, z.ZodTransform<("start" | "read" | "control" | "cancel")[], ("start" | "read" | "control" | "cancel")[]>>;
    }, z.core.$strict>;
}, z.core.$strict>;
export type CallerBinding = z.infer<typeof callerBindingSchema>;
export declare const callerStartOptionsSchema: z.ZodObject<{
    id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    paused: z.ZodOptional<z.ZodBoolean>;
    triggerMode: z.ZodOptional<z.ZodLiteral<"api">>;
}, z.core.$strict>;
export type CallerStartOptions = z.input<typeof callerStartOptionsSchema>;
export declare const callerReleasePinSchema: z.ZodObject<{
    id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    sha256: z.ZodString;
    revision: z.ZodString;
}, z.core.$strict>;
export type CallerReleasePin = z.infer<typeof callerReleasePinSchema>;
export declare const callerStartRequestSchema: z.ZodObject<{
    input: z.ZodJSONSchema;
    options: z.ZodObject<{
        id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        paused: z.ZodOptional<z.ZodBoolean>;
        triggerMode: z.ZodOptional<z.ZodLiteral<"api">>;
    }, z.core.$strict>;
}, z.core.$strict>;
export type CallerStartRequest = z.input<typeof callerStartRequestSchema>;
export declare const callerCancellationRequestSchema: z.ZodObject<{
    requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
}, z.core.$strict>;
export type CallerCancellationRequest = z.input<typeof callerCancellationRequestSchema>;
export declare const callerOperationSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    input: z.ZodJSONSchema;
    options: z.ZodObject<{
        id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        paused: z.ZodOptional<z.ZodBoolean>;
        triggerMode: z.ZodOptional<z.ZodLiteral<"api">>;
    }, z.core.$strict>;
    operation: z.ZodLiteral<"start">;
    release: z.ZodObject<{
        id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        sha256: z.ZodString;
        revision: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"read">;
    release: z.ZodObject<{
        id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        sha256: z.ZodString;
        revision: z.ZodString;
    }, z.core.$strict>;
    id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"cancel">;
    release: z.ZodObject<{
        id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        sha256: z.ZodString;
        revision: z.ZodString;
    }, z.core.$strict>;
    id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    request: z.ZodObject<{
        requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"checkpoint">;
    release: z.ZodObject<{
        id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        sha256: z.ZodString;
        revision: z.ZodString;
    }, z.core.$strict>;
    id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"control">;
    release: z.ZodObject<{
        id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        sha256: z.ZodString;
        revision: z.ZodString;
    }, z.core.$strict>;
    id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    request: z.ZodObject<{
        expectedCheckpointSha256: z.ZodString;
        mode: z.ZodEnum<{
            continue: "continue";
            step: "step";
            pause: "pause";
            recover: "recover";
        }>;
        breakpoints: z.ZodOptional<z.ZodArray<z.ZodString>>;
        requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    }, z.core.$strict>;
}, z.core.$strict>], "operation">;
export type CallerOperation = z.infer<typeof callerOperationSchema>;
/** Trusted host hook, after exact permission/ownership authentication, never HTTP input or authority. */
export type CallerContext<Result> = (release: CallerReleasePin, operation: () => Promise<Result>) => Promise<Result>;
export declare const callerRunReceiptSchema: z.ZodObject<{
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
export declare const callerRunResultSchema: z.ZodObject<{
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
    output: z.ZodOptional<z.ZodJSONSchema>;
}, z.core.$strict>;
export declare function callerBinding(admission: GrantActionAdmission): CallerBinding;
/** Historical consistency, not current authorization. Revocation/expiry never erase admitted provenance. */
export declare function verifyCallerBinding(run: LocalRun, metadata?: GrantMetadata): void;
export interface CallerRunReceipt {
    schemaVersion: 1;
    id: string;
    revision: string;
    release: {
        id: string;
        sha256: string;
    };
    createdAt: string;
    updatedAt: string;
    status: LocalRun['state']['status'];
}
export type CallerRunResult = CallerRunReceipt & {
    output?: Extract<LocalRun['state'], {
        status: 'completed';
    }>['output'];
};
/** Explicit projection: no YAML, input, steps, actors, history, provider details or authority. */
export declare function callerRunReceipt(run: LocalRun): CallerRunReceipt;
export declare function callerRunResult(run: LocalRun): CallerRunResult;

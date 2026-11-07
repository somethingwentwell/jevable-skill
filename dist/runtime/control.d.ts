import { z } from 'zod';
import type { NodeId } from '../workflow/index.ts';
export declare const breakpointListSchema: z.ZodArray<z.ZodString>;
export declare const breakpointHitSchema: z.ZodObject<{
    configurationRequestId: z.ZodUUID;
    checkpointSha256: z.ZodString;
    nodeId: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
    scope: z.ZodOptional<z.ZodObject<{
        loop: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
        index: z.ZodNumber;
    }, z.core.$strict>>;
    stepCount: z.ZodNumber;
    at: z.ZodISODateTime;
}, z.core.$strict>;
export declare const executionControlSchema: z.ZodObject<{
    requestId: z.ZodUUID;
    expectedCheckpointSha256: z.ZodString;
    mode: z.ZodEnum<{
        continue: "continue";
        step: "step";
        pause: "pause";
        recover: "recover";
    }>;
    breakpoints: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
export declare const savedExecutionControlSchema: z.ZodObject<{
    requestId: z.ZodUUID;
    expectedCheckpointSha256: z.ZodString;
    mode: z.ZodEnum<{
        continue: "continue";
        step: "step";
        pause: "pause";
        recover: "recover";
    }>;
    breakpoints: z.ZodOptional<z.ZodArray<z.ZodString>>;
    actor: z.ZodString;
    at: z.ZodISODateTime;
    delegation: z.ZodOptional<z.ZodObject<{
        grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
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
        deadline: z.ZodISODateTime;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type ExecutionControl = z.infer<typeof executionControlSchema>;
export interface RunStartOptions {
    id?: string;
    paused?: boolean;
    triggerMode?: 'api';
}

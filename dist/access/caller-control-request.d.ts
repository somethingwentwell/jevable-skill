import { z } from 'zod';
/** Shared strict input, separate from retained receipt projections to avoid a caller-schema cycle. */
export declare const callerControlRequestSchema: z.ZodObject<{
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
export type CallerControlRequest = z.input<typeof callerControlRequestSchema>;

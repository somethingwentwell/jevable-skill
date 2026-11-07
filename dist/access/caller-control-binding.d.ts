import { z } from 'zod';
/** Private retained attribution, never public control input or a live authorization token. */
export declare const callerControlBindingSchema: z.ZodObject<{
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
}, z.core.$strict>;

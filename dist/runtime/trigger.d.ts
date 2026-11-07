import { z } from 'zod';
/** Omission retains the historical manual/chat entry contract. API is always explicit. */
export declare const apiTriggerModeSchema: z.ZodLiteral<"api">;
export type ApiTriggerMode = z.infer<typeof apiTriggerModeSchema>;
export declare function parseTriggerMode(value: unknown): ApiTriggerMode | undefined;
export declare function triggerMetadata(value: {
    triggerMode?: ApiTriggerMode | undefined;
}): {
    triggerMode?: ApiTriggerMode;
};

import { z } from 'zod';
import { WorkflowRuntimeError } from "./errors.js";
/** Omission retains the historical manual/chat entry contract. API is always explicit. */
export const apiTriggerModeSchema = z.literal('api');
export function parseTriggerMode(value) {
    if (value === undefined)
        return undefined;
    const parsed = apiTriggerModeSchema.safeParse(value);
    if (!parsed.success)
        throw new WorkflowRuntimeError('invalid-command');
    return parsed.data;
}
export function triggerMetadata(value) {
    return value.triggerMode === undefined ? {} : { triggerMode: value.triggerMode };
}

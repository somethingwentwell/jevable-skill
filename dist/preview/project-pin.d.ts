import { z } from 'zod';
import type { WorkflowCompilerLimits } from '../workflow/index.ts';
/** Explicit reviewed existing-project selection, not creation or implicit recovery. */
export declare const previewProjectPinSchema: z.ZodObject<{
    id: z.ZodUUID;
    generation: z.ZodNumber;
    revision: z.ZodString;
}, z.core.$strict>;
export type PreviewProjectPin = z.infer<typeof previewProjectPinSchema>;
/** I/O-free owned admission, before a listener, credentials or storage is opened. */
export declare function admitPreviewProjectPin(source: string, value: unknown, limits?: WorkflowCompilerLimits): PreviewProjectPin;

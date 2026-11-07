import { z } from 'zod';
/** Explicit usage-only projection of the verified requested identity, never endpoint/credentials/response IDs. */
export declare const USAGE_IDENTITY_FORMAT: "requested-provider-model/v1";
export declare const usageIdentitySchema: z.ZodObject<{
    provider: z.ZodString;
    model: z.ZodString;
}, z.core.$strict>;
export type UsageIdentity = z.infer<typeof usageIdentitySchema>;

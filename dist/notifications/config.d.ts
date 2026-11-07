import { z } from 'zod';
declare const configSchema: z.ZodObject<{
    endpoints: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        url: z.ZodString;
        credentialRef: z.ZodString;
        timeoutMs: z.ZodNumber;
    }, z.core.$strict>>>;
    maxInFlight: z.ZodDefault<z.ZodNumber>;
    maxDeliveries: z.ZodDefault<z.ZodNumber>;
    maxEvents: z.ZodDefault<z.ZodNumber>;
    automatic: z.ZodOptional<z.ZodObject<{
        policy: z.ZodObject<{
            format: z.ZodLiteral<"jevable.ai/automatic-approval-policy/v1">;
            routes: z.ZodArray<z.ZodObject<{
                scope: z.ZodDiscriminatedUnion<[z.ZodObject<{
                    kind: z.ZodLiteral<"project">;
                    id: z.ZodUUID;
                    generation: z.ZodNumber;
                    revision: z.ZodString;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"release">;
                    id: z.ZodUUID;
                    sha256: z.ZodString;
                    revision: z.ZodString;
                }, z.core.$strict>], "kind">;
                endpointId: z.ZodString;
                endpointSha256: z.ZodString;
                eventKinds: z.ZodArray<z.ZodEnum<{
                    cancelled: "cancelled";
                    expired: "expired";
                    requested: "requested";
                    decided: "decided";
                }>>;
            }, z.core.$strict>>;
        }, z.core.$strict>;
        reviewedPolicySha256: z.ZodString;
        maxPending: z.ZodDefault<z.ZodNumber>;
        maxAdmissions: z.ZodDefault<z.ZodNumber>;
        maxEvents: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** Explicit startup-only configuration. Missing destinations disable new sends, not retained receipt inspection. */
export type NotificationRuntimeConfig = z.input<typeof configSchema>;
export { configSchema as notificationConfigSchema };
export type NotificationRuntimePolicy = z.output<typeof configSchema>;
export declare function parseNotificationConfig(value: unknown): NotificationRuntimePolicy;

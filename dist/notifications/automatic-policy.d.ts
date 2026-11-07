import { z } from 'zod';
import { type NotificationRequest } from './schema.ts';
declare const policySchema: z.ZodObject<{
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
export { policySchema as automaticApprovalPolicySchema };
export type AutomaticApprovalPolicy = z.infer<typeof policySchema>;
export interface AutomaticApprovalPlan {
    policySha256: string;
    actor: string;
    requests: NotificationRequest[];
    dispatch: 'not-attempted';
}
/** Normalize reviewed routes; no credentials, startup defaults, wildcard scopes or delivery authority. */
export declare function parseAutomaticApprovalPolicy(value: unknown): AutomaticApprovalPolicy;
/** Review metadata only. The startup owner must verify stored scopes separately; this never authorizes human approval. */
export declare function reviewAutomaticApprovalPolicy(value: unknown): {
    policy: {
        format: "jevable.ai/automatic-approval-policy/v1";
        routes: {
            scope: {
                kind: "project";
                id: string;
                generation: number;
                revision: string;
            } | {
                kind: "release";
                id: string;
                sha256: string;
                revision: string;
            };
            endpointId: string;
            endpointSha256: string;
            eventKinds: ("cancelled" | "expired" | "requested" | "decided")[];
        }[];
    };
    policySha256: string;
    scopeVerification: "not-performed";
    dispatch: "not-attempted";
};
/** Structural planning only; the caller must separately verify retained journal evidence and delivery authority. Never send or replay. */
export declare function planAutomaticApprovalNotifications(policyValue: unknown, eventValue: unknown, destinationsValue: unknown): AutomaticApprovalPlan;

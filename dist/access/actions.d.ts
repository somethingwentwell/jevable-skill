import { z } from 'zod';
import { type GrantRecord, type GrantScope } from './grants.ts';
import { type GrantPolicyObserver } from './policy-observation.ts';
/** Only exact delegated actions. Never accept an owner operation, arbitrary source, or a client actor. */
export declare const grantActionSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"start">;
    release: z.ZodObject<{
        id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        sha256: z.ZodString;
        revision: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"read">;
    runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"control">;
    runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"cancel">;
    runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"decision">;
    runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    decision: z.ZodString;
}, z.core.$strict>], "kind">;
export type GrantAction = z.infer<typeof grantActionSchema>;
/** Internal projection of a VERIFIED retained target, never request-supplied ownership or state. */
export declare const grantActionTargetSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"release">;
    release: z.ZodObject<{
        id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        sha256: z.ZodString;
        revision: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"run">;
    runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    revision: z.ZodString;
    release: z.ZodOptional<z.ZodObject<{
        id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        sha256: z.ZodString;
        revision: z.ZodString;
    }, z.core.$strict>>;
    callerGrantId: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>>;
    cancelled: z.ZodBoolean;
    wait: z.ZodOptional<z.ZodObject<{
        attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        expiresAt: z.ZodISODateTime;
        loopExpiresAt: z.ZodOptional<z.ZodISODateTime>;
    }, z.core.$strict>>;
}, z.core.$strict>], "kind">;
export type GrantActionTarget = z.infer<typeof grantActionTargetSchema>;
export interface GrantActionAdmission {
    grantId: string;
    actor: string;
    action: GrantAction;
    scope: GrantScope;
    issuedAt: string;
    admittedAt: string;
    expiresAt: string;
}
export declare function parseGrantAction(value: unknown): GrantAction;
/** A pure policy decision, not permission to execute later. Reapply at the storage admission point. */
export declare function admitGrantAction(record: GrantRecord, proof: {
    id: string;
    tokenSha256: string;
}, action: GrantAction, targetValue: GrantActionTarget, at?: string, observer?: GrantPolicyObserver): GrantActionAdmission;

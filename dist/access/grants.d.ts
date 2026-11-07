import { z } from 'zod';
export declare const GRANT_LIMITS: Readonly<{
    records: 10000;
    bytes: 32768;
    page: 200;
}>;
export declare const grantIdSchema: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
export declare const reviewerDecisionsSchema: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
export declare const grantScopeSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
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
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"reviewer">;
    runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    revision: z.ZodString;
    decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
}, z.core.$strict>], "kind">;
export type GrantScope = z.infer<typeof grantScopeSchema>;
export declare const grantIssueSchema: z.ZodObject<{
    id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    tokenSha256: z.ZodString;
    scope: z.ZodDiscriminatedUnion<[z.ZodObject<{
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
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"reviewer">;
        runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        revision: z.ZodString;
        decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
    }, z.core.$strict>], "kind">;
    expiresAt: z.ZodISODateTime;
    actor: z.ZodString;
}, z.core.$strict>;
export declare const grantRevokeSchema: z.ZodObject<{
    id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    expectedGeneration: z.ZodLiteral<1>;
    actor: z.ZodString;
}, z.core.$strict>;
export declare const grantPageSchema: z.ZodObject<{
    after: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>>;
    limit: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
export declare const grantRecordSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    generation: z.ZodUnion<readonly [z.ZodLiteral<1>, z.ZodLiteral<2>]>;
    tokenSha256: z.ZodString;
    scope: z.ZodDiscriminatedUnion<[z.ZodObject<{
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
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"reviewer">;
        runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        revision: z.ZodString;
        decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
    }, z.core.$strict>], "kind">;
    issuedAt: z.ZodISODateTime;
    issuer: z.ZodString;
    expiresAt: z.ZodISODateTime;
    revocation: z.ZodOptional<z.ZodObject<{
        requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        previousGeneration: z.ZodLiteral<1>;
        actor: z.ZodString;
        at: z.ZodISODateTime;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type GrantRecord = z.infer<typeof grantRecordSchema>;
export type GrantIssue = z.infer<typeof grantIssueSchema>;
export type GrantRevoke = z.infer<typeof grantRevokeSchema>;
export type GrantPageRequest = z.input<typeof grantPageSchema>;
export type GrantMetadata = Omit<GrantRecord, 'tokenSha256'> & {
    observedAt: string;
    status: 'active' | 'expired' | 'revoked';
};
export interface GrantPage {
    schemaVersion: 1;
    observedAt: string;
    grants: GrantMetadata[];
    nextCursor: string | null;
}
export declare const grantMetadataSchema: z.ZodObject<{
    observedAt: z.ZodISODateTime;
    status: z.ZodEnum<{
        expired: "expired";
        active: "active";
        revoked: "revoked";
    }>;
    schemaVersion: z.ZodLiteral<1>;
    id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    generation: z.ZodUnion<readonly [z.ZodLiteral<1>, z.ZodLiteral<2>]>;
    scope: z.ZodDiscriminatedUnion<[z.ZodObject<{
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
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"reviewer">;
        runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        revision: z.ZodString;
        decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
    }, z.core.$strict>], "kind">;
    issuedAt: z.ZodISODateTime;
    issuer: z.ZodString;
    expiresAt: z.ZodISODateTime;
    revocation: z.ZodOptional<z.ZodObject<{
        requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        previousGeneration: z.ZodLiteral<1>;
        actor: z.ZodString;
        at: z.ZodISODateTime;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const grantPageResultSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    observedAt: z.ZodISODateTime;
    grants: z.ZodArray<z.ZodObject<{
        observedAt: z.ZodISODateTime;
        status: z.ZodEnum<{
            expired: "expired";
            active: "active";
            revoked: "revoked";
        }>;
        schemaVersion: z.ZodLiteral<1>;
        id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        generation: z.ZodUnion<readonly [z.ZodLiteral<1>, z.ZodLiteral<2>]>;
        scope: z.ZodDiscriminatedUnion<[z.ZodObject<{
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
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"reviewer">;
            runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
            attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
            revision: z.ZodString;
            decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
        }, z.core.$strict>], "kind">;
        issuedAt: z.ZodISODateTime;
        issuer: z.ZodString;
        expiresAt: z.ZodISODateTime;
        revocation: z.ZodOptional<z.ZodObject<{
            requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
            previousGeneration: z.ZodLiteral<1>;
            actor: z.ZodString;
            at: z.ZodISODateTime;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    nextCursor: z.ZodNullable<z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>>;
}, z.core.$strict>;
export interface GrantPrincipal {
    grantId: string;
    actor: string;
    scope: GrantScope;
    expiresAt: string;
}
declare const historySchema: z.ZodObject<{
    kind: z.ZodEnum<{
        "grant-issued": "grant-issued";
        "grant-revoked": "grant-revoked";
    }>;
    requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    previousSha256: z.ZodNullable<z.ZodString>;
    record: z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        generation: z.ZodUnion<readonly [z.ZodLiteral<1>, z.ZodLiteral<2>]>;
        tokenSha256: z.ZodString;
        scope: z.ZodDiscriminatedUnion<[z.ZodObject<{
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
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"reviewer">;
            runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
            attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
            revision: z.ZodString;
            decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
        }, z.core.$strict>], "kind">;
        issuedAt: z.ZodISODateTime;
        issuer: z.ZodString;
        expiresAt: z.ZodISODateTime;
        revocation: z.ZodOptional<z.ZodObject<{
            requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
            previousGeneration: z.ZodLiteral<1>;
            actor: z.ZodString;
            at: z.ZodISODateTime;
        }, z.core.$strict>>;
    }, z.core.$strict>;
}, z.core.$strict>;
export type GrantHistory = z.infer<typeof historySchema>;
export declare const parseGrantIssue: (value: unknown) => GrantIssue;
export declare const parseGrantRevoke: (value: unknown) => GrantRevoke;
export declare const parseGrantId: (value: unknown) => string;
export declare const parseGrantPage: (value: unknown) => {
    limit: number;
    after?: string | undefined;
};
export declare function inspectGrant(value: unknown): GrantRecord;
export declare const grantRecordHash: (record: GrantRecord) => string;
export declare function issueGrantRecord(command: GrantIssue, at: string): GrantRecord;
export declare function sameGrantIssue(record: GrantRecord, command: GrantIssue): boolean;
export declare function revokeGrantRecord(record: GrantRecord, command: GrantRevoke, at: string): GrantRecord;
export declare function grantHistory(record: GrantRecord, previous?: GrantRecord): GrantHistory;
/** Audit consistency detects accidental/partial substitution, not a signature against a privileged database writer. */
export declare function inspectGrantHistory(record: GrantRecord, values: readonly unknown[]): void;
export declare function grantMetadata(record: GrantRecord, at?: string): GrantMetadata;
/** Prepare and privately persist this before issuance; the owner receives only its digest. No grant is issued here. */
export declare function prepareGrantToken(value: string): {
    id: string;
    token: string;
    tokenSha256: string;
};
/** Syntax/digest is NOT authorization, a permission decision, or constant-time handling of the whole request. */
export declare function grantTokenProof(value: unknown): {
    id: string;
    tokenSha256: string;
} | null;
/** Internal lookup only. Action admission must recheck scope/revocation at its own mutation boundary. */
export declare function grantPrincipal(record: GrantRecord, proof: {
    id: string;
    tokenSha256: string;
}, at?: string): GrantPrincipal | null;
export {};

import { z } from 'zod';
/** Optional website-account client, not workflow ownership, provider discovery or desktop attachment. */
export declare class AccountError extends Error {
    readonly code: 'invalid-config' | 'invalid-authorization' | 'invalid-grant' | 'invalid-code' | 'refused' | 'invalid-response' | 'unavailable' | 'outcome-unknown';
    readonly status?: number | undefined;
    constructor(code: 'invalid-config' | 'invalid-authorization' | 'invalid-grant' | 'invalid-code' | 'refused' | 'invalid-response' | 'unavailable' | 'outcome-unknown', status?: number | undefined);
}
export interface AccountClientOptions {
    issuer: string;
    ca?: string;
    allowLoopbackHttp?: boolean;
    timeoutMs?: number;
    maxResponseBytes?: number;
}
declare const authorizationSchema: z.ZodObject<{
    format: z.ZodLiteral<"jevable.ai/account-authorization/v1">;
    issuer: z.ZodString;
    redirectUri: z.ZodString;
    name: z.ZodString;
    state: z.ZodString;
    verifier: z.ZodString;
    challenge: z.ZodString;
    authorizationUrl: z.ZodString;
}, z.core.$strict>;
declare const grantSchema: z.ZodObject<{
    format: z.ZodLiteral<"jevable.ai/account-grant/v1">;
    issuer: z.ZodString;
    keyId: z.ZodUUID;
    email: z.ZodString;
    key: z.ZodString;
}, z.core.$strict>;
export type AccountAuthorization = z.infer<typeof authorizationSchema>;
/** Contains a secret. Hosts must persist privately and never emit this value in CLI/preview output. */
export type AccountGrant = z.infer<typeof grantSchema>;
declare const statusSchema: z.ZodObject<{
    email: z.ZodString;
    plan: z.ZodNullable<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        billing: z.ZodEnum<{
            monthly: "monthly";
            annual: "annual";
        }>;
        status: z.ZodEnum<{
            active: "active";
            trialing: "trialing";
            past_due: "past_due";
        }>;
        renews_at: z.ZodNullable<z.ZodISODateTime>;
        ends_at: z.ZodNullable<z.ZodISODateTime>;
    }, z.core.$strict>>;
    balance: z.ZodNumber;
    low_balance: z.ZodBoolean;
    low_balance_threshold: z.ZodNumber;
    links: z.ZodObject<{
        top_up: z.ZodString;
        manage_plan: z.ZodString;
        keys: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>;
export type AccountStatus = {
    status: 'unauthorized';
    issuer: string;
    keyId: string;
    revocation: 'not-proven';
} | ({
    status: 'active';
    issuer: string;
    keyId: string;
} & z.infer<typeof statusSchema>);
export declare function inspectAccountAuthorization(value: unknown): AccountAuthorization;
export declare function inspectAccountGrant(value: unknown): AccountGrant;
/** Shared pure admission for transport and durable host intent; never persists the code. */
export declare function admitAccountExchange(issuer: string, value: unknown, code: string, returnedState?: string): {
    format: "jevable.ai/account-authorization/v1";
    issuer: string;
    redirectUri: string;
    name: string;
    state: string;
    verifier: string;
    challenge: string;
    authorizationUrl: string;
};
/** Explicit pinned origin; verified TLS, bounded bodies/deadline, no redirects, cookies, discovery or retries. */
export declare class AccountClient {
    readonly issuer: string;
    private readonly ca;
    private readonly timeoutMs;
    private readonly maxResponseBytes;
    constructor(value: AccountClientOptions);
    /** Pure preparation. The returned verifier is private; only authorizationUrl is suitable for opening. */
    prepareAuthorization(name: string, redirectUri?: string): AccountAuthorization;
    /** Mutating one-time exchange. Host must retain its private intent before dispatch, and never auto-retry uncertainty. */
    exchange(value: unknown, code: string, returnedState?: string): Promise<AccountGrant>;
    private admitGrant;
    status(value: unknown): Promise<AccountStatus>;
    /** Explicit service revocation, not local credential erasure or proof of provider-side cancellation. */
    revoke(value: unknown): Promise<{
        issuer: string;
        keyId: string;
        revoked: true;
    }>;
    private requireSuccess;
    private request;
}
export {};

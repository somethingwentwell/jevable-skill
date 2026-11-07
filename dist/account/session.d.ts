import { z } from 'zod';
import { AccountClient, type AccountStatus } from './client.ts';
export declare class AccountSessionError extends Error {
    readonly code: 'invalid-storage' | 'invalid-pin' | 'corrupt' | 'attempt-recorded' | 'not-active' | 'unavailable' | 'outcome-unknown';
    constructor(code: 'invalid-storage' | 'invalid-pin' | 'corrupt' | 'attempt-recorded' | 'not-active' | 'unavailable' | 'outcome-unknown');
}
declare const sessionPinSchema: z.ZodObject<{
    sessionId: z.ZodUUID;
    authorizationSha256: z.ZodString;
}, z.core.$strict>;
declare const grantPinSchema: z.ZodObject<{
    sessionId: z.ZodUUID;
    authorizationSha256: z.ZodString;
    keyId: z.ZodUUID;
    grantSha256: z.ZodString;
}, z.core.$strict>;
export type AccountSessionPin = z.infer<typeof sessionPinSchema>;
export type AccountGrantPin = z.infer<typeof grantPinSchema>;
export interface AccountSessionInspection {
    pin: AccountSessionPin;
    issuer: string;
    status: 'prepared' | 'exchange-uncertain' | 'exchange-refused' | 'active' | 'revoke-uncertain' | 'revoke-refused' | 'revoked';
    grant: AccountGrantPin | null;
    exchangeRequestId: string | null;
    revokeRequestId: string | null;
    /** Only a recorded success proves revocation; absence/401/refusal never does. */
    revocation: 'not-proven' | 'recorded-success';
}
/**
 * Explicit private POSIX session, independent of workflow state, desktop and server lifecycles.
 * Immutable, exclusively published intent files are synced (including directory entry) before any credential request.
 * Partial writes/crashes retain evidence and refuse; neither open nor inspection retries or erases.
 * This is not encrypted storage or protection from root/a malicious process running as the same user.
 */
export declare class AccountSession {
    #private;
    private constructor();
    /** The caller chooses a fresh path beneath an existing owned 0700 parent. Never replaces a session. */
    static prepare(directory: string, client: AccountClient, name: string, redirectUri?: string): Promise<AccountSession>;
    static open(directory: string, client: AccountClient): Promise<AccountSession>;
    /** Browser-safe link only; the verifier/private authorization record is never returned by this host. */
    authorizationLink(): Promise<{
        pin: AccountSessionPin;
        authorizationUrl: string;
    }>;
    inspect(): Promise<AccountSessionInspection>;
    exchange(value: AccountSessionPin, code: string, returnedState?: string): Promise<AccountSessionInspection>;
    /** Explicit observation; website status may update last-used metadata. No local erasure on 401. */
    status(value: AccountGrantPin): Promise<AccountStatus>;
    /** One explicit attempt per retained grant; a lost/refused result needs inspection, not redispatch. */
    revoke(value: AccountGrantPin): Promise<AccountSessionInspection>;
    private admitPin;
    private admitGrantPin;
    private checkDirectory;
    private read;
    private publish;
    private recordRefusal;
    private snapshot;
    private intent;
    private refusal;
}
export {};

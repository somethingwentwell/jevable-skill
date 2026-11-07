import { z } from 'zod';
import { type ReleaseMessageRuntime } from './messages.ts';
export declare const WEBHOOK_LIMITS: Readonly<{
    bodyBytes: 1000000;
    timestampToleranceSeconds: 300;
    keys: 4;
    signatures: 8;
}>;
export declare const releaseWebhookConfigSchema: z.ZodObject<{
    source: z.ZodString;
    keys: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export type ReleaseWebhookConfig = z.infer<typeof releaseWebhookConfigSchema>;
export interface SignedWebhookRequest {
    id: string;
    timestamp: string;
    signature: string;
    body: Uint8Array;
}
export declare class WebhookAuthenticationError extends Error {
    readonly code = "webhook-unauthorized";
    constructor();
}
/** Standard Webhooks v1 HMAC only. Owns key copies; no listener, I/O or execution. */
export declare class SignedWebhookVerifier {
    private readonly keys;
    private closed;
    constructor(config: ReleaseWebhookConfig);
    verify(value: SignedWebhookRequest): {
        messageId: string;
        input: unknown;
    };
    close(): void;
}
/** Owned SDK intake for one API release. Caller owns capacity, acknowledgement and completion drain. */
export declare class SignedReleaseWebhookSession {
    private readonly verifier;
    private readonly messages;
    constructor(runtime: ReleaseMessageRuntime, snapshot: unknown, config: ReleaseWebhookConfig);
    get release(): {
        id: string;
        sha256: string;
        revision: string;
    };
    runId(messageId: string): string;
    start(value: SignedWebhookRequest): Promise<import("./messages.ts").ReleaseMessageRun>;
    close(): void;
}

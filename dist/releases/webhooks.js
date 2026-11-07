import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { admitWorkflowData } from "../workflow/index.js";
import { DEFAULT_COMPILER_LIMITS } from "../limits.js";
import { ReleaseMessageSession, releaseMessageIdentitySchema } from "./messages.js";
export const WEBHOOK_LIMITS = Object.freeze({ bodyBytes: 1_000_000, timestampToleranceSeconds: 300, keys: 4, signatures: 8 });
const keySchema = z.string().max(94).regex(/^whsec_[A-Za-z0-9+/]+={0,2}$/u).refine(value => {
    const bytes = Buffer.from(value.slice(6), 'base64');
    try {
        return bytes.length >= 24 && bytes.length <= 64 && bytes.toString('base64') === value.slice(6);
    }
    finally {
        bytes.fill(0);
    }
});
export const releaseWebhookConfigSchema = z.strictObject({ source: releaseMessageIdentitySchema.shape.source,
    keys: z.array(keySchema).min(1).max(WEBHOOK_LIMITS.keys).refine(keys => new Set(keys).size === keys.length) });
export class WebhookAuthenticationError extends Error {
    code = 'webhook-unauthorized';
    constructor() { super('webhook-unauthorized'); }
}
/** Standard Webhooks v1 HMAC only. Owns key copies; no listener, I/O or execution. */
export class SignedWebhookVerifier {
    keys;
    closed = false;
    constructor(config) {
        const parsed = releaseWebhookConfigSchema.safeParse(config);
        if (!parsed.success)
            throw new WorkflowRuntimeError('invalid-command');
        this.keys = parsed.data.keys.map(key => Buffer.from(key.slice(6), 'base64'));
    }
    verify(value) {
        if (this.closed)
            throw new WorkflowRuntimeError('closed');
        if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['id', 'timestamp', 'signature', 'body'].includes(key))
            || typeof value.id !== 'string' || !/^[\x21-\x2d\x2f-\x7e]{1,256}$/u.test(value.id)
            || typeof value.timestamp !== 'string' || !/^(0|[1-9][0-9]{0,10})$/u.test(value.timestamp)
            || !Number.isSafeInteger(Number(value.timestamp))
            || Math.abs(Math.floor(Date.now() / 1000) - Number(value.timestamp)) > WEBHOOK_LIMITS.timestampToleranceSeconds
            || typeof value.signature !== 'string' || value.signature.length > WEBHOOK_LIMITS.signatures * 48
            || !(value.body instanceof Uint8Array) || value.body.byteLength > WEBHOOK_LIMITS.bodyBytes)
            throw new WebhookAuthenticationError();
        const parts = value.signature.split(' ');
        if (!parts.length || parts.length > WEBHOOK_LIMITS.signatures || parts.some(part => !/^v1,[A-Za-z0-9+/]{43}=$/u.test(part)))
            throw new WebhookAuthenticationError();
        const signatures = parts.map(part => Buffer.from(part.slice(3), 'base64'));
        if (signatures.some((signature, i) => signature.length !== 32 || signature.toString('base64') !== parts[i].slice(3)))
            throw new WebhookAuthenticationError();
        // Detach before verification; asynchronous callers cannot alter the bytes subsequently parsed.
        const body = Buffer.from(value.body), prefix = `${value.id}.${value.timestamp}.`;
        let authenticated = 0;
        for (const key of this.keys) {
            const expected = createHmac('sha256', key).update(prefix, 'utf8').update(body).digest();
            for (const signature of signatures)
                authenticated |= Number(timingSafeEqual(expected, signature));
            expected.fill(0);
        }
        if (!authenticated)
            throw new WebhookAuthenticationError();
        let input;
        try {
            input = admitWorkflowData(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)), DEFAULT_COMPILER_LIMITS.binding.data);
        }
        catch {
            throw new WorkflowRuntimeError('invalid-command');
        }
        return { messageId: value.id, input };
    }
    close() { this.closed = true; for (const key of this.keys)
        key.fill(0); }
}
/** Owned SDK intake for one API release. Caller owns capacity, acknowledgement and completion drain. */
export class SignedReleaseWebhookSession {
    verifier;
    messages;
    constructor(runtime, snapshot, config) {
        this.verifier = new SignedWebhookVerifier(config);
        try {
            this.messages = new ReleaseMessageSession(runtime, snapshot, config.source);
        }
        catch (error) {
            this.verifier.close();
            throw error;
        }
    }
    get release() { return this.messages.release; }
    runId(messageId) { return this.messages.runId(messageId); }
    async start(value) { return this.messages.start(this.verifier.verify(value)); }
    close() { this.verifier.close(); } // Does not cancel work, close storage, or abandon its completion.
}

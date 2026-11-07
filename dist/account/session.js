import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, link, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccountError, admitAccountExchange, inspectAccountAuthorization, inspectAccountGrant } from "./client.js";
export class AccountSessionError extends Error {
    code;
    constructor(code) {
        super(`Jevable account session failed: ${code}. Inspect retained metadata; never automatically retry an exchange or revocation.`);
        this.code = code;
        this.name = 'AccountSessionError';
    }
}
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const sessionPinSchema = z.strictObject({ sessionId: z.uuid(), authorizationSha256: hash });
const grantPinSchema = sessionPinSchema.extend({ keyId: z.uuid(), grantSha256: hash });
const authorizationRecordSchema = z.strictObject({ format: z.literal('jevable.ai/account-session/v1'), sessionId: z.uuid(), authorization: z.unknown() });
const intentSchema = z.strictObject({ format: z.literal('jevable.ai/account-intent/v1'), sessionId: z.uuid(), authorizationSha256: hash,
    requestId: z.uuid(), operation: z.enum(['exchange', 'revoke']), grant: z.strictObject({ keyId: z.uuid(), sha256: hash }).optional() });
const refusedSchema = z.strictObject({ format: z.literal('jevable.ai/account-refusal/v1'), requestId: z.uuid(), status: z.number().int().min(100).max(599) });
const revokedSchema = z.strictObject({ format: z.literal('jevable.ai/account-revocation/v1'), requestId: z.uuid(), keyId: z.uuid(), revoked: z.literal(true) });
const LIMIT = 32_768;
function privateOwner(stat, directory) {
    // POSIX only until an explicit Windows ACL implementation is qualified. No pretend mode-bit protection.
    return process.platform !== 'win32' && stat.uid === process.getuid?.()
        && (stat.mode & 0o777) === (directory ? 0o700 : 0o600)
        && (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1);
}
async function privateDirectory(path) {
    try {
        const stat = await lstat(path);
        if (!privateOwner(stat, true))
            throw new Error();
        return { dev: stat.dev, ino: stat.ino };
    }
    catch {
        throw new AccountSessionError('invalid-storage');
    }
}
async function syncDirectory(path) {
    const directory = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    try {
        await directory.sync();
    }
    finally {
        await directory.close();
    }
}
async function canonical(path) {
    try {
        return await realpath(path);
    }
    catch {
        throw new AccountSessionError('invalid-storage');
    }
}
/**
 * Explicit private POSIX session, independent of workflow state, desktop and server lifecycles.
 * Immutable, exclusively published intent files are synced (including directory entry) before any credential request.
 * Partial writes/crashes retain evidence and refuse; neither open nor inspection retries or erases.
 * This is not encrypted storage or protection from root/a malicious process running as the same user.
 */
export class AccountSession {
    #directory;
    #identity;
    #authorization;
    #pin;
    #client;
    constructor(directory, identity, authorization, pin, client) {
        this.#directory = directory;
        this.#identity = identity;
        this.#authorization = authorization;
        this.#pin = pin;
        this.#client = client;
    }
    /** The caller chooses a fresh path beneath an existing owned 0700 parent. Never replaces a session. */
    static async prepare(directory, client, name, redirectUri) {
        const authorization = client.prepareAuthorization(name, redirectUri);
        const requested = resolve(directory), parent = dirname(requested);
        await privateDirectory(parent);
        const canonicalParent = await canonical(parent), path = join(canonicalParent, basename(requested));
        try {
            await mkdir(path, { mode: 0o700 });
            await syncDirectory(canonicalParent);
        }
        catch {
            throw new AccountSessionError('invalid-storage');
        }
        const identity = await privateDirectory(path), sessionId = randomUUID();
        const pin = { sessionId, authorizationSha256: sha(authorization) };
        const session = new AccountSession(path, identity, authorization, pin, client);
        await session.publish('authorization.json', { format: 'jevable.ai/account-session/v1', sessionId, authorization });
        return session;
    }
    static async open(directory, client) {
        const requested = resolve(directory), identity = await privateDirectory(requested), path = await canonical(requested);
        const provisional = new AccountSession(path, identity, {}, {}, client);
        const record = authorizationRecordSchema.safeParse(await provisional.read('authorization.json'));
        if (!record.success)
            throw new AccountSessionError('corrupt');
        let authorization;
        try {
            authorization = inspectAccountAuthorization(record.data.authorization);
        }
        catch {
            throw new AccountSessionError('corrupt');
        }
        if (authorization.issuer !== client.issuer)
            throw new AccountSessionError('invalid-pin');
        const pin = { sessionId: record.data.sessionId, authorizationSha256: sha(authorization) };
        const session = new AccountSession(path, identity, authorization, pin, client);
        await session.snapshot();
        return session;
    }
    /** Browser-safe link only; the verifier/private authorization record is never returned by this host. */
    async authorizationLink() {
        const state = await this.snapshot();
        if (state.view.status !== 'prepared')
            throw new AccountSessionError('attempt-recorded');
        return { pin: { ...this.#pin }, authorizationUrl: this.#authorization.authorizationUrl };
    }
    async inspect() { return (await this.snapshot()).view; }
    async exchange(value, code, returnedState) {
        this.admitPin(value);
        // Share the actual transport's pure validation before consuming a durable one-shot intent.
        admitAccountExchange(this.#client.issuer, this.#authorization, code, returnedState);
        const before = await this.snapshot();
        if (before.view.status !== 'prepared')
            throw new AccountSessionError('attempt-recorded');
        const intent = { format: 'jevable.ai/account-intent/v1', ...this.#pin, requestId: randomUUID(), operation: 'exchange' };
        await this.publish('exchange-intent.json', intent);
        let grant;
        try {
            grant = await this.#client.exchange(this.#authorization, code, returnedState);
        }
        catch (error) {
            await this.recordRefusal('exchange-refused.json', intent, error);
            throw error instanceof AccountError ? error : new AccountSessionError('outcome-unknown');
        }
        try {
            await this.publish('grant.json', grant);
            return (await this.snapshot()).view;
        }
        catch {
            throw new AccountSessionError('outcome-unknown');
        }
    }
    /** Explicit observation; website status may update last-used metadata. No local erasure on 401. */
    async status(value) {
        const before = await this.snapshot();
        this.admitGrantPin(value, before.view);
        return this.#client.status(before.grant);
    }
    /** One explicit attempt per retained grant; a lost/refused result needs inspection, not redispatch. */
    async revoke(value) {
        const before = await this.snapshot();
        this.admitGrantPin(value, before.view);
        if (before.view.status !== 'active')
            throw new AccountSessionError('attempt-recorded');
        const intent = { format: 'jevable.ai/account-intent/v1', ...this.#pin, requestId: randomUUID(), operation: 'revoke',
            grant: { keyId: before.grant.keyId, sha256: sha(before.grant) } };
        await this.publish('revoke-intent.json', intent);
        try {
            await this.#client.revoke(before.grant);
        }
        catch (error) {
            await this.recordRefusal('revoke-refused.json', intent, error);
            throw error instanceof AccountError ? error : new AccountSessionError('outcome-unknown');
        }
        try {
            await this.publish('revoked.json', { format: 'jevable.ai/account-revocation/v1', requestId: intent.requestId, keyId: before.grant.keyId, revoked: true });
            return (await this.snapshot()).view;
        }
        catch {
            throw new AccountSessionError('outcome-unknown');
        }
    }
    admitPin(value) {
        const pin = sessionPinSchema.safeParse(value);
        if (!pin.success || pin.data.sessionId !== this.#pin.sessionId || pin.data.authorizationSha256 !== this.#pin.authorizationSha256)
            throw new AccountSessionError('invalid-pin');
    }
    admitGrantPin(value, view) {
        if (!view.grant)
            throw new AccountSessionError('not-active');
        const pin = grantPinSchema.safeParse(value);
        if (!pin.success || Object.keys(pin.data).some(key => pin.data[key] !== view.grant[key]))
            throw new AccountSessionError('invalid-pin');
    }
    async checkDirectory() {
        const current = await privateDirectory(this.#directory);
        if (current.dev !== this.#identity.dev || current.ino !== this.#identity.ino)
            throw new AccountSessionError('invalid-storage');
    }
    async read(name) {
        await this.checkDirectory();
        let file;
        try {
            file = await open(join(this.#directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return undefined;
            throw new AccountSessionError('invalid-storage');
        }
        try {
            const stat = await file.stat();
            if (!privateOwner(stat, false) || stat.size < 1 || stat.size > LIMIT)
                throw new AccountSessionError('invalid-storage');
            const bytes = Buffer.alloc(LIMIT + 1);
            let count = 0;
            while (count < bytes.length) {
                const next = await file.read(bytes, count, bytes.length - count, null);
                if (!next.bytesRead)
                    break;
                count += next.bytesRead;
            }
            if (count > LIMIT)
                throw new AccountSessionError('invalid-storage');
            await this.checkDirectory();
            return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)));
        }
        catch (error) {
            if (error instanceof AccountSessionError)
                throw error;
            throw new AccountSessionError('corrupt');
        }
        finally {
            await file.close();
        }
    }
    async publish(name, value) {
        await this.checkDirectory();
        const bytes = JSON.stringify(value);
        if (Buffer.byteLength(bytes) > LIMIT)
            throw new AccountSessionError('invalid-storage');
        const pending = join(this.#directory, `.${name}.${randomUUID()}.pending`);
        let file;
        try {
            file = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        }
        catch {
            throw new AccountSessionError('unavailable');
        }
        try {
            if (!privateOwner(await file.stat(), false))
                throw new AccountSessionError('invalid-storage');
            await file.writeFile(bytes);
            await file.sync();
        }
        catch {
            throw new AccountSessionError('unavailable');
        }
        finally {
            await file.close();
        }
        try {
            await this.checkDirectory();
            // Link is exclusive even across processes; the final record is never visible partially written.
            await link(pending, join(this.#directory, name));
            await unlink(pending);
            await syncDirectory(this.#directory);
            await this.checkDirectory();
        }
        catch (error) {
            // Retain failed private pending files/entries for inspection. No remote request has begun here.
            if (error.code === 'EEXIST')
                throw new AccountSessionError('attempt-recorded');
            throw new AccountSessionError('unavailable');
        }
    }
    async recordRefusal(name, intent, error) {
        if (!(error instanceof AccountError) || error.code !== 'refused' || error.status === undefined)
            return;
        try {
            await this.publish(name, { format: 'jevable.ai/account-refusal/v1', requestId: intent.requestId, status: error.status });
        }
        catch {
            throw new AccountSessionError('outcome-unknown');
        }
    }
    async snapshot() {
        const record = authorizationRecordSchema.safeParse(await this.read('authorization.json'));
        if (!record.success || record.data.sessionId !== this.#pin.sessionId || sha(record.data.authorization) !== this.#pin.authorizationSha256)
            throw new AccountSessionError('corrupt');
        const exchange = await this.intent('exchange-intent.json', 'exchange'), grantValue = await this.read('grant.json');
        let grant;
        try {
            if (grantValue !== undefined)
                grant = inspectAccountGrant(grantValue);
        }
        catch {
            throw new AccountSessionError('corrupt');
        }
        if (grant && (!exchange || grant.issuer !== this.#client.issuer))
            throw new AccountSessionError('corrupt');
        const exchangeRefused = await this.refusal('exchange-refused.json', exchange);
        if (grant && exchangeRefused)
            throw new AccountSessionError('corrupt');
        const revoke = await this.intent('revoke-intent.json', 'revoke');
        if (revoke && (!grant || revoke.grant?.keyId !== grant.keyId || revoke.grant.sha256 !== sha(grant)))
            throw new AccountSessionError('corrupt');
        const revokeRefused = await this.refusal('revoke-refused.json', revoke), revoked = await this.read('revoked.json');
        if (revoked !== undefined) {
            const result = revokedSchema.safeParse(revoked);
            if (!result.success || !revoke || result.data.requestId !== revoke.requestId || result.data.keyId !== grant?.keyId || revokeRefused)
                throw new AccountSessionError('corrupt');
        }
        const status = revoked !== undefined ? 'revoked' : revokeRefused ? 'revoke-refused' : revoke ? 'revoke-uncertain'
            : grant ? 'active' : exchangeRefused ? 'exchange-refused' : exchange ? 'exchange-uncertain' : 'prepared';
        return { grant, view: { pin: { ...this.#pin }, issuer: this.#client.issuer, status,
                grant: grant ? { ...this.#pin, keyId: grant.keyId, grantSha256: sha(grant) } : null,
                exchangeRequestId: exchange?.requestId ?? null, revokeRequestId: revoke?.requestId ?? null,
                revocation: revoked !== undefined ? 'recorded-success' : 'not-proven' } };
    }
    async intent(name, operation) {
        const value = await this.read(name);
        if (value === undefined)
            return undefined;
        const parsed = intentSchema.safeParse(value);
        if (!parsed.success || parsed.data.operation !== operation || parsed.data.sessionId !== this.#pin.sessionId
            || parsed.data.authorizationSha256 !== this.#pin.authorizationSha256 || (operation === 'exchange' ? parsed.data.grant !== undefined : parsed.data.grant === undefined))
            throw new AccountSessionError('corrupt');
        return parsed.data;
    }
    async refusal(name, intent) {
        const value = await this.read(name);
        if (value === undefined)
            return false;
        const parsed = refusedSchema.safeParse(value);
        if (!parsed.success || !intent || parsed.data.requestId !== intent.requestId)
            throw new AccountSessionError('corrupt');
        return true;
    }
}

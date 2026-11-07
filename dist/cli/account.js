import { AccountClient, AccountSession, AccountSessionError } from "../account/index.js";
import { readSecretFile, readSecretStdin } from "../providers/secret-input.js";
import { readTlsPemFile } from "../http/tls.js";
import { z } from 'zod';
export const ACCOUNT_ACTIONS = ['prepare', 'inspect', 'link', 'exchange', 'status', 'revoke'];
export class AccountCliInputError extends Error {
    constructor() { super('Invalid account selection or protected input. Use help account; no discovery, fallback or automatic retry.'); this.name = 'AccountCliInputError'; }
}
const pinFields = ['session-id', 'authorization-sha256'];
export function accountStrings(action) {
    return ['issuer', 'session-dir', ...(action === 'prepare' ? ['name'] : []),
        ...(['exchange', 'status', 'revoke'].includes(action) ? [...pinFields, 'ca-file', 'timeout-ms'] : []),
        ...(action === 'exchange' ? ['code-file'] : []),
        ...(['status', 'revoke'].includes(action) ? ['key-id', 'grant-sha256'] : []),
        ...(action === 'revoke' ? ['confirm-revoke'] : [])];
}
export function accountBooleans(action) {
    return ['allow-loopback-http', ...(action === 'exchange' ? ['code-stdin', 'confirm-exchange'] : []),
        ...(action === 'status' ? ['include-private'] : [])];
}
/** Pure transport/selection admission before CA, session or code reads. */
export function accountSelection(action, values) {
    try {
        if (typeof values.issuer !== 'string' || typeof values['session-dir'] !== 'string' || !values['session-dir'])
            throw new Error();
        const client = new AccountClient({ issuer: values.issuer, allowLoopbackHttp: values['allow-loopback-http'] === true,
            ...(values['timeout-ms'] === undefined ? {} : { timeoutMs: Number(values['timeout-ms']) }) });
        if (values['ca-file'] !== undefined && !client.issuer.startsWith('https:'))
            throw new Error();
        if (action === 'prepare' && !z.string().min(1).max(40).refine(s => !/[\u0000-\u001f\u007f]/u.test(s)).safeParse(values.name).success)
            throw new Error();
        if (action === 'exchange' && (values['confirm-exchange'] !== true || Number(typeof values['code-file'] === 'string') + Number(values['code-stdin'] === true) !== 1))
            throw new Error();
        if (action === 'revoke' && values['confirm-revoke'] !== values['key-id'])
            throw new Error();
    }
    catch {
        throw new AccountCliInputError();
    }
}
const sessionPin = (values) => ({ sessionId: values['session-id'], authorizationSha256: values['authorization-sha256'] });
const grantPin = (values) => ({ ...sessionPin(values), keyId: values['key-id'], grantSha256: values['grant-sha256'] });
/** No browser/process discovery or workflow owner is opened; code input precedes signal-held admission. */
export async function accountFromCli(action, values, admit) {
    accountSelection(action, values);
    const ca = values['ca-file'] === undefined ? undefined : await readTlsPemFile(values['ca-file']);
    const client = new AccountClient({ issuer: values.issuer, allowLoopbackHttp: values['allow-loopback-http'] === true,
        ...(values['timeout-ms'] === undefined ? {} : { timeoutMs: Number(values['timeout-ms']) }), ...(ca === undefined ? {} : { ca }) });
    const directory = values['session-dir'];
    if (action === 'prepare')
        return admit(async () => {
            const session = await AccountSession.prepare(directory, client, values.name);
            return { schemaVersion: 1, status: 'prepared', ...(await session.authorizationLink()), authorization: 'human-action-required', network: 'not-contacted' };
        });
    const session = await AccountSession.open(directory, client);
    if (action === 'inspect')
        return { schemaVersion: 1, ...(await session.inspect()), network: 'not-contacted' };
    if (action === 'link')
        return { schemaVersion: 1, ...(await session.authorizationLink()), authorization: 'human-action-required', network: 'not-contacted' };
    const view = await session.inspect(), pin = sessionPin(values);
    if (pin.sessionId !== view.pin.sessionId || pin.authorizationSha256 !== view.pin.authorizationSha256)
        throw new AccountSessionError('invalid-pin');
    if (action === 'exchange') {
        if (view.status !== 'prepared')
            throw new AccountSessionError('attempt-recorded');
        let code;
        try {
            code = values['code-stdin'] ? await readSecretStdin() : await readSecretFile(values['code-file']);
        }
        catch {
            throw new AccountCliInputError();
        }
        return admit(async () => ({ schemaVersion: 1, ...(await session.exchange(pin, code)) }));
    }
    const grant = grantPin(values);
    if (!view.grant || Object.keys(grant).some(key => grant[key] !== view.grant[key]))
        throw new AccountSessionError('invalid-pin');
    if (action === 'revoke')
        return admit(async () => ({ schemaVersion: 1, ...(await session.revoke(grant)), localCredentials: 'retained' }));
    return admit(async () => {
        const status = await session.status(grant);
        return values['include-private'] === true ? { schemaVersion: 1, ...status, privacy: 'explicit-private-account-details' }
            : { schemaVersion: 1, status: status.status, issuer: status.issuer, keyId: status.keyId, revocation: 'not-proven', privacy: 'account-details-excluded' };
    });
}

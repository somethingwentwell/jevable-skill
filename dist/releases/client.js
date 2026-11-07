import { RuntimeClient, RuntimeHttpError } from "../http/client.js";
/** Explicit verified endpoint and reviewed release identity. Never discovers a server or retries mutations. */
export class ReleaseClient extends RuntimeClient {
    releaseSha256;
    constructor(endpoint, token, releaseSha256, timeoutMs = 30_000, tls = {}) {
        super(endpoint, token, timeoutMs, 20_000_000, tls);
        this.releaseSha256 = releaseSha256;
        if (!/^[a-f0-9]{64}$/.test(releaseSha256))
            throw new RuntimeHttpError('invalid-config');
    }
    operation(command, traceParent) {
        if (!command || typeof command !== 'object' || Array.isArray(command) || Object.hasOwn(command, 'releaseSha256'))
            throw new RuntimeHttpError('invalid-command');
        return this.request('/v1/operations', { ...command, releaseSha256: this.releaseSha256 }, traceParent);
    }
}

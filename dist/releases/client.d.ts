import { RuntimeClient, type RuntimeClientTlsOptions, type RuntimeTraceContext } from '../http/client.ts';
import type { ReleaseOperation } from './service-session.ts';
/** Explicit verified endpoint and reviewed release identity. Never discovers a server or retries mutations. */
export declare class ReleaseClient extends RuntimeClient<ReleaseOperation> {
    private readonly releaseSha256;
    constructor(endpoint: string, token: string, releaseSha256: string, timeoutMs?: number, tls?: RuntimeClientTlsOptions);
    operation(command: ReleaseOperation, traceParent?: RuntimeTraceContext): Promise<unknown>;
}

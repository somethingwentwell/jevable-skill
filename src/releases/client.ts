import { RuntimeClient, RuntimeHttpError, type RuntimeClientTlsOptions, type RuntimeTraceContext } from '../http/client.ts'
import type { ReleaseOperation } from './service-session.ts'

/** Explicit verified endpoint and reviewed release identity. Never discovers a server or retries mutations. */
export class ReleaseClient extends RuntimeClient<ReleaseOperation> {
  constructor(endpoint: string, token: string, private readonly releaseSha256: string, timeoutMs = 30_000, tls: RuntimeClientTlsOptions = {}) {
    super(endpoint, token, timeoutMs, 20_000_000, tls)
    if (!/^[a-f0-9]{64}$/.test(releaseSha256)) throw new RuntimeHttpError('invalid-config')
  }
  override operation(command: ReleaseOperation, traceParent?: RuntimeTraceContext) {
    if (!command || typeof command !== 'object' || Array.isArray(command) || Object.hasOwn(command, 'releaseSha256'))
      throw new RuntimeHttpError('invalid-command')
    return this.request('/v1/operations', { ...command, releaseSha256: this.releaseSha256 }, traceParent)
  }
}

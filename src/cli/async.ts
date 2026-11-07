import { z } from 'zod'
import { AsyncRunClient, RuntimeHttpError } from '../http/client.ts'
import { asyncRunRequestSchema, asyncReleasePinSchema } from '../http/async-runs.ts'
import { admitWorkflowData } from '../workflow/index.ts'
import { readBoundedFile } from '../files.ts'
import { readSecretFile } from '../providers/secret-input.ts'
import { readTlsPemFile } from '../http/tls.ts'
import { CliStorageUsageError, type CliValues } from './usage.ts'
import { readCliTraceContext } from './trace-context.ts'

/** Select an existing owned service before reading files. No discovery, local storage or Docker fallback. */
export function asyncRunSelection(values: CliValues) {
  let endpoint: URL
  try { endpoint = new URL(values.endpoint as string) } catch { throw new CliStorageUsageError('Provide an explicit reviewed HTTPS origin or private 127.0.0.1 HTTP endpoint.') }
  if (endpoint.username || endpoint.password || endpoint.port === '0' || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
    || endpoint.protocol !== 'https:' && (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port)
    || typeof values['token-file'] !== 'string' || !values['token-file'] || !z.uuid().safeParse(values['instance-id']).success
    || endpoint.protocol !== 'https:' && values['ca-file'] !== undefined
    || ['runtime', 'data-dir', 'storage', 'database-file', 'owner-file', 'owner-sha256', 'container-id', 'telemetry-file', 'notifications-file'].some(key => values[key] !== undefined))
    throw new CliStorageUsageError('Async HTTP operations require an explicit endpoint, reviewed instance UUID and private owner token file; no local/Docker selection, discovery or fallback.')
  const timeout = values['timeout-ms']
  if (timeout !== undefined && (typeof timeout !== 'string' || !/^[1-9][0-9]*$/u.test(timeout)
    || !Number.isSafeInteger(Number(timeout)) || Number(timeout) > 3_600_000))
    throw new CliStorageUsageError('Use --timeout-ms as a canonical integer from 1 to 3600000.')
}

export async function asyncRunFromCli(action: 'submit' | 'observe', value: string, values: CliValues,
  reviewedRelease?: { id: string; sha256: string; revision: string }) {
  asyncRunSelection(values)
  let request, pin, id
  try {
    if (reviewedRelease !== undefined) {
      if (values['release-pin-file'] !== undefined) throw Error()
      pin = asyncReleasePinSchema.parse(reviewedRelease)
    }
    if (values['release-pin-file'] !== undefined) {
      if (typeof values['release-pin-file'] !== 'string' || !values['release-pin-file']) throw Error()
      pin = asyncReleasePinSchema.parse(JSON.parse(await readBoundedFile(values['release-pin-file'], 4096)))
    }
    if (action === 'submit') {
      request = asyncRunRequestSchema.parse(admitWorkflowData(JSON.parse(await readBoundedFile(value, 4_000_000)),
        { maxBytes: 4_000_000, maxDepth: 64, maxValues: 100_000 }))
      if (pin && (request.kind !== 'release' || request.release.id.toLowerCase() !== pin.id.toLowerCase()
        || request.release.sha256 !== pin.sha256 || request.release.revision !== pin.revision)) throw Error()
    } else id = z.uuid().parse(value)
  } catch { throw new RuntimeHttpError('invalid-command') }
  if (action === 'observe' && values['trace-context-file'] !== undefined)
    throw new CliStorageUsageError('Async metadata observation does not adopt an execution trace context.')
  const context = await readCliTraceContext(values['trace-context-file'])
  const token = await readSecretFile(values['token-file'] as string)
  const ca = values['ca-file'] === undefined ? undefined : await readTlsPemFile(values['ca-file'] as string)
  const client = new AsyncRunClient(values.endpoint as string, token, values['instance-id'] as string, {
    timeoutMs: Number(values['timeout-ms'] ?? 30000), ...(ca === undefined ? {} : { ca }), ...(pin === undefined ? {} : { release: pin }),
  })
  return action === 'submit' ? client.start(request!, context) : client.show(id!)
}

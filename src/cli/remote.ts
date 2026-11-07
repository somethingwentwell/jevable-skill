import { z } from 'zod'
import { CORE_VERSION, PROTOCOL_VERSION } from '../capabilities.ts'
import { RuntimeClient, RuntimeHttpError } from '../http/client.ts'
import { readSecretFile } from '../providers/secret-input.ts'
import { readTlsPemFile } from '../http/tls.ts'
import { CliStorageUsageError, type CliValues } from './runtime.ts'

/** Validate explicit remote selection before credentials, storage or network access. */
export function remoteSelection(values: CliValues) {
  if (typeof values.endpoint !== 'string' || !values.endpoint || typeof values['token-file'] !== 'string' || !values['token-file']) {
    throw new CliStorageUsageError('Remote commands require --endpoint https://<authority> and a private --token-file.')
  }
  if (['runtime', 'owner-file', 'owner-sha256', 'container-id', 'storage', 'database-file', 'data-dir', 'telemetry-file', 'notifications-file'].some(key => values[key] !== undefined)) {
    throw new CliStorageUsageError('An explicit --endpoint selects an existing remote service; do not mix local/Docker ownership or storage options.')
  }
  let url: URL
  try { url = new URL(values.endpoint) } catch { throw new CliStorageUsageError('Provide an explicit HTTPS origin, without credentials, path, query or fragment.') }
  if (url.protocol !== 'https:' || url.port === '0' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new CliStorageUsageError('Provide an explicit HTTPS origin, without credentials, path, query or fragment.')
  }
  if (values['instance-id'] !== undefined && !z.uuid().safeParse(values['instance-id']).success) {
    throw new CliStorageUsageError('--instance-id must be a complete reviewed runtime UUID.')
  }
}

/** Read-only handshake, then pin every operation to that instance. No discovery or retry. */
export async function connectRemoteOperations(values: CliValues) {
  remoteSelection(values)
  const token = await readSecretFile(values['token-file'] as string)
  const ca = values['ca-file'] === undefined ? undefined : await readTlsPemFile(values['ca-file'] as string)
  const tls = { ...(ca === undefined ? {} : { ca }),
    ...(values['instance-id'] === undefined ? {} : { expectedInstanceId: values['instance-id'] as string }) }
  const client = new RuntimeClient(values.endpoint as string, token, Number(values['timeout-ms'] ?? 30000), 20_000_000, tls)
  const caps = z.object({ version: z.literal(CORE_VERSION), protocolVersion: z.literal(PROTOCOL_VERSION), instanceId: z.uuid(),
    remoteAccess: z.literal(true), workflowRuntime: z.object({ storage: z.enum(['sqlite', 'postgres']) }),
    api: z.object({ transport: z.literal('direct-https'), servesHtml: z.literal(false), instanceGuard: z.literal('x-jevable-instance'),
      operations: z.object({ storage: z.enum(['sqlite', 'postgres']) }) }),
  }).safeParse(await client.capabilities())
  if (!caps.success || caps.data.workflowRuntime.storage !== caps.data.api.operations.storage) throw new RuntimeHttpError('incompatible-owner')
  if (values['instance-id'] !== undefined && caps.data.instanceId !== values['instance-id']) throw new RuntimeHttpError('instance-mismatch')
  const { instanceId } = caps.data, storage = caps.data.api.operations.storage
  const pinned = new RuntimeClient(values.endpoint as string, token, Number(values['timeout-ms'] ?? 30000), 20_000_000, { ...tls, expectedInstanceId: instanceId })
  const health = z.object({ instanceId: z.literal(instanceId), status: z.literal('ready'),
    runtime: storage === 'postgres' ? z.object({ storage: z.literal('postgres'), database: z.literal('reachable'), state: z.literal('open') })
      : z.object({ storage: z.literal('sqlite') }),
  }).safeParse(await pinned.health())
  if (!health.success) throw new RuntimeHttpError('owner-not-ready')
  return { client: pinned, instanceId, storage }
}

import { z } from 'zod'
import { ReviewerClient, RuntimeHttpError } from '../http/client.ts'
import { reviewerDecisionRequestSchema } from '../access/reviewer.ts'
import { readBoundedFile } from '../files.ts'
import { readSecretFile } from '../providers/secret-input.ts'
import { readTlsPemFile } from '../http/tls.ts'
import { CliStorageUsageError, type CliValues } from './runtime.ts'
import { readCliTraceContext } from './trace-context.ts'

/** Pure explicit reviewer selection, never an owner handshake or local state fallback. */
export function reviewerSelection(values: CliValues, role = 'Reviewer decisions') {
  let endpoint: URL
  try { endpoint = new URL(values.endpoint as string) } catch { throw new CliStorageUsageError('Provide an explicit reviewed HTTPS origin or private 127.0.0.1 HTTP endpoint.') }
  if (endpoint.username || endpoint.password || endpoint.port === '0' || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
    || endpoint.protocol !== 'https:' && (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port)
    || typeof values['token-file'] !== 'string' || !values['token-file'] || !z.uuid().safeParse(values['instance-id']).success
    || endpoint.protocol !== 'https:' && values['ca-file'] !== undefined)
    throw new CliStorageUsageError(`${role} require an explicit reviewed endpoint, instance UUID and private grant token file; no discovery or fallback.`)
}

export async function reviewerFromCli(file: string, values: CliValues) {
  reviewerSelection(values)
  let raw: unknown
  try { raw = JSON.parse(await readBoundedFile(file, 4096)) } catch { throw new RuntimeHttpError('invalid-command') }
  const parsed = reviewerDecisionRequestSchema.safeParse(raw)
  if (!parsed.success) throw new RuntimeHttpError('invalid-command')
  const context = await readCliTraceContext(values['trace-context-file'])
  const token = await readSecretFile(values['token-file'] as string)
  const ca = values['ca-file'] === undefined ? undefined : await readTlsPemFile(values['ca-file'] as string)
  const client = new ReviewerClient(values.endpoint as string, token, values['instance-id'] as string,
    Number(values['timeout-ms'] ?? 30000), 16_384, ca === undefined ? {} : { ca })
  return client.decide(parsed.data, context)
}

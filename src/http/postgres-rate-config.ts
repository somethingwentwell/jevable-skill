/** Driver-free shared quota admission; no environment lookup or database I/O. */
import { z } from 'zod'
import { postgresConfigSchema, parsePostgresConfiguration } from '../storage/postgres-config.ts'
import { httpRateLimitsSchema } from './rate-limits.ts'

const connectionSchema = postgresConfigSchema.pick({ host: true, port: true, database: true, user: true, password: true, tls: true })
export const postgresHttpRateCoordinatorOptionsSchema = z.strictObject({ connection: connectionSchema,
  scope: z.uuid().transform(value => value.toLowerCase()), policy: httpRateLimitsSchema, initialize: z.boolean(),
  timeoutMs: z.number().int().min(100).max(5000), statementTimeoutMs: z.number().int().min(100).max(5000),
  maxPendingDebits: z.number().int().min(1).max(64) })
export type PostgresHttpRateCoordinatorOptions = z.input<typeof postgresHttpRateCoordinatorOptionsSchema>
export type PostgresHttpRateCoordinatorCode = 'invalid-config' | 'invalid-command' | 'policy-conflict' | 'uninitialized'
  | 'version-mismatch' | 'corrupt' | 'capacity' | 'aborted' | 'unavailable' | 'commit-uncertain' | 'closed'
export class PostgresHttpRateCoordinatorError extends Error {
  constructor(readonly code: PostgresHttpRateCoordinatorCode) { super(code) }
}
export function parsePostgresHttpRateCoordinatorOptions(value: unknown) {
  const parsed = postgresHttpRateCoordinatorOptionsSchema.safeParse(value)
  if (!parsed.success || parsed.data.statementTimeoutMs > parsed.data.timeoutMs) throw new PostgresHttpRateCoordinatorError('invalid-config')
  let connection: ReturnType<typeof parsePostgresConfiguration>
  try { connection = parsePostgresConfiguration({ ...parsed.data.connection, namespace: 'http-rate-coordinator', initialize: false }) }
  catch { throw new PostgresHttpRateCoordinatorError('invalid-config') }
  const { host, port, database, user, password, tls } = connection
  return { ...parsed.data, connection: { host, port, database, user, password, tls } }
}

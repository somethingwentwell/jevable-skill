/** Driver-free PostgreSQL admission: inspecting configuration never opens a connection. */
import { isIP } from 'node:net'
import { z } from 'zod'
import { validateCa } from '../http/tls.ts'
import { JournalError } from './errors.ts'

const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/u)
export const postgresConfigSchema = z.strictObject({ host: z.string().min(1).max(253), port: z.number().int().min(1).max(65535),
  database: name, user: name, password: z.string().min(1).max(8192), namespace: name, initialize: z.boolean(),
  tls: z.discriminatedUnion('mode', [z.strictObject({ mode: z.literal('verify-full'), ca: z.string().optional() }),
    z.strictObject({ mode: z.literal('loopback-test') })]),
  maxRecordBytes: z.number().int().min(1024).max(16_000_000).default(4_000_000),
  maxBatchBytes: z.number().int().min(1024).max(32_000_000).default(16_000_000),
  maxRecords: z.number().int().min(1).max(1_000_000).default(100_000),
  maxBatches: z.number().int().min(1).max(1_000_000).default(100_000),
  maxEvents: z.number().int().min(1).max(5_000_000).default(1_000_000),
  statementTimeoutMs: z.number().int().min(100).max(30_000).default(5000) })
export type PostgresJournalOptions = z.input<typeof postgresConfigSchema>

/** Pure admission shared by startup and read-only diagnostics; never creates a client or connects. */
export function parsePostgresConfiguration(value: unknown) {
  const parsed = postgresConfigSchema.safeParse(value)
  if (!parsed.success) throw new JournalError('invalid-config')
  const options = parsed.data
  if ((!isIP(options.host) && !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/u.test(options.host))
    || (options.tls.mode === 'loopback-test' && !['127.0.0.1', '::1'].includes(options.host))) throw new JournalError('invalid-config')
  try { if (options.tls.mode === 'verify-full' && options.tls.ca !== undefined) options.tls.ca = validateCa(options.tls.ca) }
  catch { throw new JournalError('invalid-config') }
  return options
}

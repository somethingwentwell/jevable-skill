import { describe, it, expect } from 'vitest'
import { PostgresJournal, JournalError, type PostgresJournalOptions } from '../src/storage/index.ts'
import { parsePostgresConfiguration as driverParser } from '../src/storage/postgres.ts'
import { parsePostgresConfiguration, postgresConfigSchema } from '../src/storage/postgres-config.ts'

const valid: PostgresJournalOptions = { host: '127.0.0.1', port: 5432, database: 'fixture', user: 'fixture',
  password: 'PRIVATE_PASSWORD', namespace: 'fixture', initialize: false, tls: { mode: 'loopback-test' } }

describe('PostgreSQL explicit configuration admission (no network)', () => {
  it('keeps the existing driver parser identity and default normalization without mutating callers', () => {
    expect(driverParser).toBe(parsePostgresConfiguration)
    const before = structuredClone(valid), parsed = parsePostgresConfiguration(valid)
    expect(valid).toEqual(before)
    expect(parsed).toEqual({ ...valid, maxRecordBytes: 4_000_000, maxBatchBytes: 16_000_000,
      maxRecords: 100_000, maxBatches: 100_000, maxEvents: 1_000_000, statementTimeoutMs: 5000 })
    parsed.tls.mode = 'verify-full'
    expect(valid).toEqual(before)
    expect(parsePostgresConfiguration({ ...valid, host: '::1' }).host).toBe('::1')
    expect(parsePostgresConfiguration({ ...valid, host: 'db.example.org', tls: { mode: 'verify-full' } }).tls).toEqual({ mode: 'verify-full' })
  })

  it.each(['localhost', 'remote.invalid', '/private/socket', '127.0.0.1/path'])('retains semantic host refusal for %s despite projected string shape', host => {
    const config = { ...valid, host }
    expect(postgresConfigSchema.safeParse(config).success).toBe(true)
    expect(() => parsePostgresConfiguration(config)).toThrow(JournalError)
    try { parsePostgresConfiguration(config) } catch (error) {
      expect(error).toMatchObject({ code: 'invalid-config' }); expect(String(error)).not.toContain(host)
    }
  })
  it.each([
    { host: 'localhost' }, { host: 'example.org' }, { host: '/tmp/socket' }, { host: '127.0.0.1/evil' },
    { password: '' }, { user: '' }, { port: 0 }, { database: 'postgres?sslmode=disable' },
    { namespace: '../state' }, { initialize: undefined }, { tls: undefined },
    { connectionString: 'postgresql://private:secret@example.org/database' },
    { tls: { mode: 'verify-full', ca: 'INVALID_PRIVATE_CA' } },
    { tls: { mode: 'verify-full', rejectUnauthorized: false } },
    { maxRecords: 0 }, { maxBatchBytes: 1 }, { statementTimeoutMs: 99 },
  ])('rejects invalid or ambient configuration %j', async patch => {
    await expect(PostgresJournal.open({ ...valid, ...patch } as PostgresJournalOptions)).rejects.toMatchObject({ code: 'invalid-config' })
  })
  it('does not expose connection or workflow content in its public errors', () => {
    for (const code of ['invalid-config', 'unavailable', 'ownership-lost', 'commit-uncertain'] as const) {
      const error = new JournalError(code)
      expect(error.message).toContain(code)
      expect(error.message).not.toMatch(/PRIVATE|postgresql:|password/iu)
      expect(error.cause).toBeUndefined()
    }
  })
})

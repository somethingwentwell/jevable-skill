import { describe, expect, it, vi } from 'vitest'
import { PostgresRuntime, PostgresJournal, type PostgresRuntimeOptions } from '../src/storage/index.ts'

const database = { host: '127.0.0.1', port: 5432, database: 'fixture', user: 'fixture', password: 'PRIVATE_FIXTURE',
  namespace: 'fixture', initialize: false, tls: { mode: 'loopback-test' as const } }
describe('PostgreSQL runtime policy admission without network access', () => {
  it.each([{ maxRuns: 0 }, { maxRuns: 100001 }, { maxTransitionsPerRun: 0 }, { maxTransitionsPerRun: 50001 },
    { telemetry: {} }, { models: {} }, { dataDirectory: '/not-used' }, { desktop: true },
    { notifications: null }, { notifications: { endpoints: [{ url: 'https://receiver.example' }] } },
    { notifications: { maxDeliveries: 0 } }, { notifications: { maxEvents: 1 } },
    { notifications: { maxInFlight: 0 } }, { notifications: { signingKey: 'PRIVATE_KEY' } }])('refuses unsupported or invalid policy %j before opening storage', async patch => {
    const open = vi.spyOn(PostgresJournal, 'open')
    try {
      await expect(PostgresRuntime.open({ database, ...patch } as PostgresRuntimeOptions)).rejects.toMatchObject({ code: 'invalid-command' })
      expect(open).not.toHaveBeenCalled()
    } finally { open.mockRestore() }
  })
  it('inherits the explicit transport policy instead of enabling remote plaintext', async () => {
    await expect(PostgresRuntime.open({ database: { ...database, host: 'example.org' } })).rejects.toMatchObject({ code: 'invalid-config' })
  })
})

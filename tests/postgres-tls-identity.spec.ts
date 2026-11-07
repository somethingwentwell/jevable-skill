import { afterEach, expect, it, vi } from 'vitest'
import Client from 'pg/lib/client.js'
import type { ConnectionOptions, PeerCertificate } from 'node:tls'
import { PostgresJournal } from '../src/storage/postgres.ts'

afterEach(() => vi.restoreAllMocks())
const config = { host: '127.0.0.1', port: 5432, database: 'fixture', user: 'fixture', password: 'PRIVATE_PASSWORD',
  namespace: 'fixture', initialize: false, tls: { mode: 'verify-full' as const } }
async function capturedTls(host: string, tls: typeof config.tls | { mode: 'loopback-test' } = config.tls) {
  let captured: ConnectionOptions | false | undefined
  vi.spyOn(Client.prototype, 'connect').mockImplementation(async function (this: Client) {
    captured = (this as unknown as { connectionParameters: { ssl: ConnectionOptions | false } }).connectionParameters.ssl
    throw Error('Fixture intentionally stops before a network connection')
  })
  vi.spyOn(Client.prototype, 'end').mockResolvedValue(undefined as never)
  const query = vi.spyOn(Client.prototype, 'query')
  await expect(PostgresJournal.open({ ...config, host, tls })).rejects.toMatchObject({ code: 'unavailable' })
  expect(query).not.toHaveBeenCalled()
  return captured
}
const certificate = (subjectaltname: string) => ({ subject: { CN: 'irrelevant.invalid' }, subjectaltname }) as PeerCertificate
it.each([
  ['127.0.0.1', 'IP Address:127.0.0.1'], ['::1', 'IP Address:0:0:0:0:0:0:0:1'],
  ['db.example.org', 'DNS:db.example.org'], ['db.example.org', 'DNS:*.example.org'],
])('verified PostgreSQL identity matches reviewed host %s independently of the driver hostname', async (host, san) => {
  const tls = await capturedTls(host)
  expect(tls).toMatchObject({ rejectUnauthorized: true, minVersion: 'TLSv1.2' })
  expect(tls && tls.checkServerIdentity?.('localhost', certificate(san))).toBeUndefined()
  expect(tls && tls.checkServerIdentity?.('unreviewed.invalid', certificate(san))).toBeUndefined()
})
it.each([
  ['127.0.0.1', 'DNS:localhost'], ['127.0.0.1', 'IP Address:127.0.0.2'], ['::1', 'IP Address:127.0.0.1'],
  ['db.example.org', 'DNS:localhost'], ['db.example.org', 'DNS:other.example.org'],
])('verified PostgreSQL identity refuses an unreviewed certificate for %s', async (host, san) => {
  const tls = await capturedTls(host)
  expect(tls && tls.checkServerIdentity?.('localhost', certificate(san))).toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
})
it('explicit loopback-test remains plaintext and never acquires TLS fallback', async () => {
  expect(await capturedTls('127.0.0.1', { mode: 'loopback-test' })).toBe(false)
})

import { describe, it, expect } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { createServer as httpsServer } from 'node:https'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Test-only existing OpenSSL fixture; no production provisioning or shipped script dependency.
import { createTlsFixture } from '../scripts/tls-fixture.mjs'
import { AccountClient, AccountError, inspectAccountAuthorization, inspectAccountGrant } from '../src/account/index.ts'
const key = 'jvk_' + 'K'.repeat(32), code = 'jvc_' + 'C'.repeat(32), keyId = '01234567-1234-4567-89ab-0123456789ab'
async function fixture(handler: (request: IncomingMessage, response: ServerResponse, origin: string) => void | Promise<void>,
  work: (client: AccountClient, origin: string) => Promise<void>, options: { timeoutMs?: number; maxResponseBytes?: number } = {}) {
  let origin = ''
  const server = createServer((q, r) => { Promise.resolve(handler(q, r, origin)).catch(() => { r.statusCode = 500; r.end() }) })
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes) })
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Fixture address unavailable')
  origin = `http://127.0.0.1:${address.port}`
  try { await work(new AccountClient({ issuer: origin, allowLoopbackHttp: true, ...options }), origin) }
  finally { await new Promise<void>((yes, no) => server.close(error => error ? no(error) : yes())) }
}
const json = (response: ServerResponse, value: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)) }
const grant = (issuer: string) => ({ format: 'jevable.ai/account-grant/v1', issuer, keyId, email: 'synthetic@example.test', key })
const account = (issuer: string) => ({ email: 'synthetic@example.test', plan: null, balance: 1500, low_balance: false, low_balance_threshold: 1000,
  links: { top_up: issuer + '/checkout', manage_plan: issuer + '/console/billing', keys: issuer + '/console/keys' } })
describe('explicit website account contract', () => {
  it('prepares independent PKCE paste URL without any network or verifier/code/key in URL', () => {
    const client = new AccountClient({ issuer: 'https://issuer.example.test' }), a = client.prepareAuthorization('Jevable CLI')
    const url = new URL(a.authorizationUrl)
    expect(a.redirectUri).toBe('urn:jevable:paste'); expect(a.challenge).toBe(createHash('sha256').update(a.verifier).digest('base64url'))
    expect(url.pathname).toBe('/app/authorize'); expect(url.searchParams.get('state')).toBe(a.state)
    expect(url.searchParams.get('redirect_uri')).toBe('urn:jevable:paste'); expect(url.toString()).not.toContain(a.verifier)
    expect(inspectAccountAuthorization(a)).toEqual(a); expect(client.prepareAuthorization('Jevable CLI').verifier).not.toBe(a.verifier)
  })
  for (const issuer of ['http://issuer.example.test', 'http://127.0.0.1:1234', 'https://user:pass@issuer.example.test', 'https://issuer.example.test/path', 'https://issuer.example.test?key=secret', 'https://issuer.example.test#fragment', 'ftp://issuer.example.test'])
    it('rejects invalid/unapproved issuer ' + issuer, () => expect(() => new AccountClient({ issuer })).toThrow(AccountError))
  for (const redirect of ['https://foreign.example/callback', 'http://127.0.0.1/callback', 'http://127.0.0.1:0/callback', 'http://user:pass@127.0.0.1:1234/callback', 'http://127.0.0.1:1234/callback#secret', 'jevable://callback'])
    it('rejects unsafe callback ' + redirect, () => expect(() => new AccountClient({ issuer: 'https://issuer.example.test' }).prepareAuthorization('CLI', redirect)).toThrow(AccountError))
  it('refuses altered challenge, verifier, URL and extra private fields', () => {
    const a = new AccountClient({ issuer: 'https://issuer.example.test' }).prepareAuthorization('CLI')
    for (const v of [{ ...a, challenge: 'X'.repeat(43) }, { ...a, verifier: 'X'.repeat(43) }, { ...a, authorizationUrl: 'https://foreign.example' }, { ...a, token: key }])
      expect(() => inspectAccountAuthorization(v)).toThrow(AccountError)
  })
  it('uses one explicit code/verifier exchange followed by authenticated status and revocation', async () => {
    const calls: string[] = []
    await fixture(async (q, r, origin) => {
      calls.push(q.method + ' ' + q.url)
      if (q.url === '/api/app/token') {
        let bytes = ''; for await (const b of q) bytes += b
        const body = JSON.parse(bytes); expect(body.code).toBe(code); expect(body.redirect_uri).toBe('urn:jevable:paste')
        expect(body.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u); expect(q.headers.authorization).toBeUndefined()
        json(r, { key, key_id: keyId, email: 'synthetic@example.test' })
      } else {
        expect(q.headers.authorization).toBe('Bearer ' + key)
        json(r, q.url === '/api/app/account' ? account(origin) : { revoked: true })
      }
    }, async (client, origin) => {
      const a = client.prepareAuthorization('Jevable CLI'), g = await client.exchange(a, code)
      expect(g).toEqual(grant(origin)); expect(inspectAccountGrant(g)).toEqual(g)
      expect(await client.status(g)).toEqual({ status: 'active', issuer: origin, keyId, ...account(origin) })
      expect(await client.revoke(g)).toEqual({ issuer: origin, keyId, revoked: true })
    })
    expect(calls).toEqual(['POST /api/app/token', 'GET /api/app/account', 'POST /api/app/revoke'])
  })
  it('pins callback state and issuer before network, including malformed Unicode state', async () => {
    let calls = 0
    await fixture((_q, r) => { calls++; json(r, { key, key_id: keyId, email: '' }) }, async (client) => {
      const a = client.prepareAuthorization('CLI', 'http://127.0.0.1:43210/callback')
      for (const state of [undefined, 'X'.repeat(43), '😀'.repeat(43)]) await expect(client.exchange(a, code, state)).rejects.toMatchObject({ code: 'invalid-authorization' })
      const other = new AccountClient({ issuer: 'https://foreign.example.test' })
      await expect(other.exchange(a, code, a.state)).rejects.toMatchObject({ code: 'invalid-authorization' })
      await expect(client.status(grant('https://foreign.example.test'))).rejects.toMatchObject({ code: 'invalid-grant' })
      await expect(client.exchange(a, key, a.state)).rejects.toMatchObject({ code: 'invalid-code' })
      expect((await client.exchange(a, code, a.state)).keyId).toBe(keyId)
    })
    expect(calls).toBe(1)
  })
  it('401 is observed unauthorized without erasing the grant or claiming revocation', async () => {
    await fixture((_q, r) => json(r, { error: key }, 401), async (client, origin) => {
      const g = grant(origin); expect(await client.status(g)).toEqual({ status: 'unauthorized', issuer: origin, keyId, revocation: 'not-proven' }); expect(g.key).toBe(key)
    })
  })
  it('never follows redirects or forwards bearer credentials to another origin', async () => {
    let calls = 0
    await fixture((_q, r, origin) => { calls++; r.writeHead(302, { Location: origin + '/forbidden' }); r.end() }, async (client, origin) => {
      await expect(client.revoke(grant(origin))).rejects.toMatchObject({ code: 'refused', status: 302 })
    }); expect(calls).toBe(1)
  })
  for (const status of [400, 409, 500]) it('no retry or server-message leak on exchange status ' + status, async () => {
    let calls = 0
    await fixture((_q, r) => { calls++; json(r, { error: key + code }, status) }, async client => {
      try { await client.exchange(client.prepareAuthorization('CLI'), code); throw Error('Expected refusal') }
      catch (error) { expect(error).toBeInstanceOf(AccountError); expect(String(error)).not.toContain(key); expect(String(error)).not.toContain(code); expect((error as AccountError).code).toBe(status === 500 ? 'outcome-unknown' : 'refused') }
    }); expect(calls).toBe(1)
  })
  for (const mode of ['invalid-json', 'oversize', 'unexpected-field', 'wrong-content-type', 'dropped'] as const) it('exchange uncertainty is bounded and never retried: ' + mode, async () => {
    let calls = 0
    await fixture((_q, r) => {
      calls++
      if (mode === 'dropped') { r.destroy(); return }
      if (mode === 'unexpected-field') { json(r, { key, key_id: keyId, email: '', secret: key }); return }
      r.writeHead(200, { 'Content-Type': mode === 'wrong-content-type' ? 'text/html' : 'application/json' })
      r.end(mode === 'oversize' ? 'x'.repeat(2048) : mode === 'wrong-content-type' ? JSON.stringify({ key, key_id: keyId, email: '' }) : key)
    }, async client => {
      await expect(client.exchange(client.prepareAuthorization('CLI'), code)).rejects.toMatchObject({ code: 'outcome-unknown' })
    }, { maxResponseBytes: 1024 }); expect(calls).toBe(1)
  })
  it('deadline reports mutation uncertainty and does not retry', async () => {
    let calls = 0
    await fixture(() => { calls++ }, async (client, origin) => {
      await expect(client.revoke(grant(origin))).rejects.toMatchObject({ code: 'outcome-unknown' })
    }, { timeoutMs: 30 }); expect(calls).toBe(1)
  })
  for (const mutation of ['foreign-link', 'untrusted-plan', 'balance-inconsistent', 'unknown-field'] as const) it('rejects unsafe account response ' + mutation, async () => {
    await fixture((_q, r, origin) => {
      const value: Record<string, unknown> = account(origin)
      if (mutation === 'foreign-link') value.links = { ...account(origin).links, keys: 'https://foreign.example.test/console/keys' }
      if (mutation === 'untrusted-plan') value.plan = { status: 'anything' }
      if (mutation === 'balance-inconsistent') value.low_balance = true
      if (mutation === 'unknown-field') value.key = key
      json(r, value)
    }, async (client, origin) => { await expect(client.status(grant(origin))).rejects.toMatchObject({ code: 'invalid-response' }) })
  })
  it('does not clamp a valid negative observed balance to zero or interpret it as money', async () => {
    await fixture((_q, r, origin) => json(r, { ...account(origin), balance: -1, low_balance: true }), async (client, origin) => {
      expect((await client.status(grant(origin)) as { balance: number }).balance).toBe(-1)
    })
  })
  it('exported private-record admission refuses insecure remote origins', () => {
    expect(() => inspectAccountGrant(grant('http://foreign.example.test'))).toThrow(AccountError)
    const a = new AccountClient({ issuer: 'https://issuer.example.test' }).prepareAuthorization('CLI')
    expect(() => inspectAccountAuthorization({ ...a, issuer: 'http://foreign.example.test' })).toThrow(AccountError)
  })
  it('rejects malformed CA before opening any connection', () => expect(() => new AccountClient({ issuer: 'https://issuer.example.test', ca: 'not a certificate' })).toThrow(AccountError))
  it('verified TLS exchange works only with explicitly trusted CA; untrusted/wrong CA send no credential request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-account-tls-')), foreign = join(directory, 'foreign')
    await mkdir(foreign, { mode: 0o700 })
    const tls = await createTlsFixture(directory), wrong = await createTlsFixture(foreign)
    let requests = 0
    const server = httpsServer({ key: await readFile(tls.key), cert: await readFile(tls.cert), minVersion: 'TLSv1.2' }, (_q, r) => { requests++; json(r, { key, key_id: keyId, email: '' }) })
    await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes) })
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Fixture address unavailable')
    const issuer = `https://127.0.0.1:${address.port}`
    try {
      for (const options of [{ issuer }, { issuer, ca: wrong.ca }]) {
        const client = new AccountClient(options)
        await expect(client.exchange(client.prepareAuthorization('CLI'), code)).rejects.toMatchObject({ code: 'outcome-unknown' })
      }
      expect(requests).toBe(0)
      const client = new AccountClient({ issuer, ca: tls.ca })
      expect((await client.exchange(client.prepareAuthorization('CLI'), code)).keyId).toBe(keyId); expect(requests).toBe(1)
    } finally { await new Promise<void>((yes, no) => server.close(error => error ? no(error) : yes())) }
  })
})

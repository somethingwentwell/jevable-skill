import { describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer, type ServerResponse, type IncomingMessage } from 'node:http'
import { spawn } from 'node:child_process'
import { AccountClient } from '../src/account/client.ts'
import { AccountSession, AccountSessionError, type AccountGrantPin } from '../src/account/index.ts'

// Copy the native namespace for scoped fault spies; every unspied operation remains actual POSIX I/O.
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

const code = 'jvc_' + 'C'.repeat(32), key = 'jvk_' + 'K'.repeat(32), keyId = '01234567-1234-4567-89ab-0123456789ab'
const json = (response: ServerResponse, value: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)) }
const result = { key, key_id: keyId, email: 'synthetic@example.test' }
async function privateRoot() { const directory = await fs.mkdtemp(join(tmpdir(), 'jevable-account-session-')); await fs.chmod(directory, 0o700); return directory }
async function fixture(handler: (request: IncomingMessage, response: ServerResponse, origin: string) => void | Promise<void>,
  work: (client: AccountClient, directory: string, origin: string) => Promise<void>) {
  let origin = ''
  const server = createServer((q, r) => { Promise.resolve(handler(q, r, origin)).catch(() => { r.statusCode = 500; r.end() }) })
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes) })
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Fixture address unavailable')
  origin = `http://127.0.0.1:${address.port}`
  try { await work(new AccountClient({ issuer: origin, allowLoopbackHttp: true, timeoutMs: 300 }), join(await privateRoot(), 'session'), origin) }
  finally { vi.restoreAllMocks(); await new Promise<void>((yes, no) => server.close(error => error ? no(error) : yes())) }
}
const pinned = (view: Awaited<ReturnType<AccountSession['inspect']>>): AccountGrantPin => { if (!view.grant) throw Error('Missing fixture grant'); return view.grant }

describe('durable independent account sessions', () => {
  it('prepares and reopens without network, exposes only public link/pin and refuses overwrite', async () => {
    const root = await privateRoot(), directory = join(root, 'session'), client = new AccountClient({ issuer: 'https://issuer.example.test' })
    const session = await AccountSession.prepare(directory, client, 'CLI'), link = await session.authorizationLink()
    const authorization = JSON.parse(await fs.readFile(join(directory, 'authorization.json'), 'utf8')).authorization
    const view = await session.inspect(), reopened = await AccountSession.open(directory, client)
    expect(view.status).toBe('prepared'); expect(view.grant).toBeNull(); expect(view.revocation).toBe('not-proven')
    expect(await reopened.authorizationLink()).toEqual(link); expect(await reopened.inspect()).toEqual(view)
    expect(JSON.stringify({ link, view })).not.toContain(authorization.verifier)
    expect(JSON.stringify(session)).not.toContain(authorization.verifier)
    expect(JSON.stringify(session)).toBe('{}'); expect(Object.keys(session)).toEqual([])
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700)
    expect((await fs.stat(join(directory, 'authorization.json'))).mode & 0o777).toBe(0o600)
    await expect(AccountSession.prepare(directory, client, 'CLI')).rejects.toMatchObject({ code: 'invalid-storage' })
    expect(await session.inspect()).toEqual(view)
  })
  it('persists intent before request, saves private grant and survives reopen/status/revoke without exposing secrets', async () => {
    let calls = 0, directory = ''
    await fixture(async (q, r, origin) => {
      calls++
      if (q.url === '/api/app/token') {
        const intent = JSON.parse(await fs.readFile(join(directory, 'exchange-intent.json'), 'utf8'))
        expect(intent.operation).toBe('exchange'); expect(JSON.stringify(intent)).not.toContain(code)
        expect(q.headers.authorization).toBeUndefined(); json(r, result)
      } else {
        expect(q.headers.authorization).toBe('Bearer ' + key)
        if (q.url === '/api/app/revoke') {
          expect(JSON.parse(await fs.readFile(join(directory, 'revoke-intent.json'), 'utf8')).grant.keyId).toBe(keyId)
          json(r, { revoked: true })
        } else json(r, { email: '', plan: null, balance: 0, low_balance: true, low_balance_threshold: 1000,
          links: { top_up: origin + '/checkout', manage_plan: origin + '/console/billing', keys: origin + '/console/keys' } })
      }
    }, async (client, path) => {
      directory = path
      const session = await AccountSession.prepare(path, client, 'CLI'), prepared = await session.inspect()
      const active = await session.exchange(prepared.pin, code), pin = pinned(active)
      expect(active.status).toBe('active'); expect(JSON.stringify(active)).not.toContain(key)
      const reopened = await AccountSession.open(path, client)
      expect(await reopened.inspect()).toEqual(active); expect((await reopened.status(pin)).status).toBe('active')
      const revoked = await reopened.revoke(pin)
      expect(revoked.status).toBe('revoked'); expect(revoked.revocation).toBe('recorded-success')
      await expect((await AccountSession.open(path, client)).inspect()).resolves.toEqual(revoked)
      expect(JSON.parse(await fs.readFile(join(path, 'grant.json'), 'utf8')).key).toBe(key)
      for (const name of await fs.readdir(path)) {
        expect((await fs.stat(join(path, name))).mode & 0o777).toBe(0o600)
        expect(await fs.readFile(join(path, name), 'utf8')).not.toContain(code)
      }
      await expect(reopened.exchange(prepared.pin, code)).rejects.toMatchObject({ code: 'attempt-recorded' })
      await expect(reopened.revoke(pin)).rejects.toMatchObject({ code: 'attempt-recorded' })
    }); expect(calls).toBe(3)
  })
  it('foreign issuer/session/hash, extra pin fields and invalid code refuse before creating intent or network', async () => {
    let calls = 0
    await fixture((_q, r) => { calls++; json(r, result) }, async (client, path) => {
      const session = await AccountSession.prepare(path, client, 'CLI'), view = await session.inspect()
      for (const pin of [{ ...view.pin, sessionId: keyId }, { ...view.pin, authorizationSha256: 'a'.repeat(64) }, { ...view.pin, key }])
        await expect(session.exchange(pin, code)).rejects.toMatchObject({ code: 'invalid-pin' })
      await expect(session.exchange(view.pin, key)).rejects.toMatchObject({ code: 'invalid-code' })
      await expect(AccountSession.open(path, new AccountClient({ issuer: 'https://foreign.example.test' }))).rejects.toMatchObject({ code: 'invalid-pin' })
      expect(await fs.readdir(path)).toEqual(['authorization.json']); expect((await session.inspect()).status).toBe('prepared')
    }); expect(calls).toBe(0)
  })
  it('two independent instances racing exchange create one intent and send exactly one request', async () => {
    let calls = 0
    await fixture((_q, r) => { calls++; json(r, result) }, async (client, path) => {
      const first = await AccountSession.prepare(path, client, 'CLI'), second = await AccountSession.open(path, client), pin = (await first.inspect()).pin
      const outcomes = await Promise.allSettled([first.exchange(pin, code), second.exchange(pin, code)])
      expect(outcomes.filter(x => x.status === 'fulfilled')).toHaveLength(1)
      const refused = outcomes.find(x => x.status === 'rejected')
      expect(refused?.status === 'rejected' && refused.reason).toBeInstanceOf(AccountSessionError)
      expect((await first.inspect()).status).toBe('active')
    }); expect(calls).toBe(1)
  })
  it('actual separate Node processes share the exclusive intent and send one credential request', async () => {
    let calls = 0
    await fixture((_q, r) => { calls++; json(r, result) }, async (client, path, origin) => {
      const session = await AccountSession.prepare(path, client, 'CLI'), pin = (await session.inspect()).pin
      const source = `
        import { AccountClient } from ${JSON.stringify(new URL('../src/account/client.ts', import.meta.url).href)};
        import { AccountSession } from ${JSON.stringify(new URL('../src/account/session.ts', import.meta.url).href)};
        const client = new AccountClient({ issuer: ${JSON.stringify(origin)}, allowLoopbackHttp: true });
        const session = await AccountSession.open(${JSON.stringify(path)}, client);
        process.send('ready');
        process.once('message', async () => {
          try { await session.exchange(${JSON.stringify(pin)}, ${JSON.stringify(code)}); process.send({ outcome: 'active' }); }
          catch (error) { process.send({ outcome: 'refused', code: error.code }); }
          process.disconnect();
        });`
      const children = [0, 1].map(() => spawn(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }))
      const outcomes: Array<{ outcome: string; code?: string }> = []
      const completed = children.map(child => new Promise<void>((yes, no) => {
        let diagnostics = ''; child.stderr!.on('data', value => { diagnostics += value })
        child.on('error', no)
        child.on('message', value => { if (value !== 'ready') outcomes.push(value as { outcome: string; code?: string }) })
        child.on('exit', exit => exit === 0 ? yes() : no(Error('Synthetic child failed: ' + diagnostics)))
      }))
      await Promise.all(children.map(child => new Promise<void>(yes => child.once('message', () => yes()))))
      for (const child of children) child.send('exchange')
      await Promise.all(completed)
      expect(outcomes.filter(value => value.outcome === 'active')).toHaveLength(1)
      expect(outcomes.filter(value => value.outcome === 'refused')).toHaveLength(1)
      expect((await session.inspect()).status).toBe('active')
    }); expect(calls).toBe(1)
  })
  it('loopback callback state is validated before intent, then retains one matching exchange', async () => {
    let calls = 0
    await fixture((_q, r) => { calls++; json(r, result) }, async (client, path) => {
      const session = await AccountSession.prepare(path, client, 'CLI', 'http://127.0.0.1:43210/callback'), link = await session.authorizationLink()
      for (const state of [undefined, 'X'.repeat(43), '😀'.repeat(43)])
        await expect(session.exchange(link.pin, code, state)).rejects.toMatchObject({ code: 'invalid-authorization' })
      expect(await fs.readdir(path)).toEqual(['authorization.json'])
      const state = new URL(link.authorizationUrl).searchParams.get('state')!
      expect((await session.exchange(link.pin, code, state)).status).toBe('active')
    }); expect(calls).toBe(1)
  })
  it('independent reopened instances racing revocation send one request and retain the original private grant', async () => {
    let calls = 0
    await fixture((q, r) => { calls++; json(r, q.url === '/api/app/token' ? result : { revoked: true }) }, async (client, path) => {
      const first = await AccountSession.prepare(path, client, 'CLI'), pin = pinned(await first.exchange((await first.inspect()).pin, code))
      const second = await AccountSession.open(path, client)
      const outcomes = await Promise.allSettled([first.revoke(pin), second.revoke(pin)])
      expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1)
      expect(outcomes.filter(value => value.status === 'rejected')).toHaveLength(1)
      expect((await first.inspect()).status).toBe('revoked')
      expect(JSON.parse(await fs.readFile(join(path, 'grant.json'), 'utf8')).key).toBe(key)
    }); expect(calls).toBe(2)
  })
  for (const mode of ['drop', 'bad-json', '500'] as const) it('retains exchange uncertainty after ' + mode + ', reopen never dispatches again', async () => {
    let calls = 0
    await fixture((_q, r) => {
      calls++
      if (mode === 'drop') r.destroy()
      else if (mode === '500') json(r, { error: key }, 500)
      else { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(key) }
    }, async (client, path) => {
      const session = await AccountSession.prepare(path, client, 'CLI'), pin = (await session.inspect()).pin
      await expect(session.exchange(pin, code)).rejects.toMatchObject({ code: 'outcome-unknown' })
      const view = await session.inspect(), reopened = await AccountSession.open(path, client)
      expect(view.status).toBe('exchange-uncertain'); expect(view.grant).toBeNull(); expect(view.exchangeRequestId).not.toBeNull()
      expect(await reopened.inspect()).toEqual(view)
      await expect(reopened.exchange(pin, code)).rejects.toMatchObject({ code: 'attempt-recorded' })
      await expect(reopened.authorizationLink()).rejects.toMatchObject({ code: 'attempt-recorded' })
    }); expect(calls).toBe(1)
  })
  for (const status of [400, 409]) it('records only observed exchange refusal ' + status + ', with no secret body or automatic fresh authorization', async () => {
    let calls = 0
    await fixture((_q, r) => { calls++; json(r, { error: key + code }, status) }, async (client, path) => {
      const session = await AccountSession.prepare(path, client, 'CLI'), pin = (await session.inspect()).pin
      await expect(session.exchange(pin, code)).rejects.toMatchObject({ code: 'refused', status })
      const reopened = await AccountSession.open(path, client)
      expect((await reopened.inspect()).status).toBe('exchange-refused')
      const receipt = await fs.readFile(join(path, 'exchange-refused.json'), 'utf8')
      expect(receipt).not.toContain(key); expect(receipt).not.toContain(code)
      await expect(reopened.exchange(pin, code)).rejects.toMatchObject({ code: 'attempt-recorded' })
    }); expect(calls).toBe(1)
  })
  it('failed intent publication sends no request and never overwrites an existing partial intent', async () => {
    let calls = 0
    await fixture((_q, r) => { calls++; json(r, result) }, async (client, path) => {
      const session = await AccountSession.prepare(path, client, 'CLI'), pin = (await session.inspect()).pin
      await fs.writeFile(join(path, 'exchange-intent.json'), '{', { mode: 0o600 })
      await expect(session.exchange(pin, code)).rejects.toMatchObject({ code: 'corrupt' })
      expect(await fs.readFile(join(path, 'exchange-intent.json'), 'utf8')).toBe('{')
      await expect(AccountSession.open(path, client)).rejects.toMatchObject({ code: 'corrupt' })
    }); expect(calls).toBe(0)
  })
  it('failed file fsync before publishing intent prevents dispatch', async () => {
    let calls = 0
    await fixture((_q, r) => { calls++; json(r, result) }, async (client, path) => {
      const session = await AccountSession.prepare(path, client, 'CLI'), pin = (await session.inspect()).pin, original = fs.open
      const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const file = await original(...args)
        if (String(args[0]).includes('.exchange-intent.json.')) vi.spyOn(file, 'sync').mockRejectedValue(Error('synthetic disk failure'))
        return file
      })
      await expect(session.exchange(pin, code)).rejects.toMatchObject({ code: 'unavailable' }); spy.mockRestore()
      expect((await session.inspect()).status).toBe('prepared')
      expect((await fs.readdir(path)).some(name => name.endsWith('.pending'))).toBe(true)
    }); expect(calls).toBe(0)
  })
  it('lost directory fsync acknowledgement blocks dispatch and leaves an inspectable exclusive intent', async () => {
    let calls = 0
    await fixture((_q, r) => { calls++; json(r, result) }, async (client, path) => {
      const session = await AccountSession.prepare(path, client, 'CLI'), pin = (await session.inspect()).pin, original = fs.open, physical = await fs.realpath(path)
      const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const file = await original(...args)
        if (String(args[0]) === physical && (await file.stat()).isDirectory()) vi.spyOn(file, 'sync').mockRejectedValue(Error('synthetic directory sync failure'))
        return file
      })
      await expect(session.exchange(pin, code)).rejects.toMatchObject({ code: 'unavailable' }); spy.mockRestore()
      const reopened = await AccountSession.open(path, client)
      expect((await reopened.inspect()).status).toBe('exchange-uncertain')
      await expect(reopened.exchange(pin, code)).rejects.toMatchObject({ code: 'attempt-recorded' })
    }); expect(calls).toBe(0)
  })
  it('grant publication failure after successful exchange retains uncertainty and private pending grant, never exchanges twice', async () => {
    let calls = 0
    await fixture((_q, r) => { calls++; json(r, result) }, async (client, path) => {
      const session = await AccountSession.prepare(path, client, 'CLI'), pin = (await session.inspect()).pin, original = fs.link
      const spy = vi.spyOn(fs, 'link').mockImplementation(async (...args: Parameters<typeof fs.link>) => {
        if (String(args[1]).endsWith('/grant.json')) throw Error('synthetic grant publication failure')
        return original(...args)
      })
      await expect(session.exchange(pin, code)).rejects.toMatchObject({ code: 'outcome-unknown' }); spy.mockRestore()
      const reopened = await AccountSession.open(path, client)
      expect((await reopened.inspect()).status).toBe('exchange-uncertain')
      await expect(reopened.exchange(pin, code)).rejects.toMatchObject({ code: 'attempt-recorded' })
      const pending = (await fs.readdir(path)).find(name => name.startsWith('.grant.json.') && name.endsWith('.pending'))!
      expect(JSON.parse(await fs.readFile(join(path, pending), 'utf8')).key).toBe(key)
      expect((await fs.stat(join(path, pending))).mode & 0o777).toBe(0o600)
    }); expect(calls).toBe(1)
  })
  for (const mode of ['dropped', 'refused', 'receipt-write'] as const) it('retains key after ' + mode + ' revocation; reopening or 401 does not prove revocation or resend', async () => {
    let calls = 0
    await fixture((q, r) => {
      calls++
      if (q.url === '/api/app/token') json(r, result)
      else if (q.url === '/api/app/account') json(r, { error: key }, 401)
      else if (mode === 'dropped') r.destroy()
      else if (mode === 'refused') json(r, { error: key }, 401)
      else json(r, { revoked: true })
    }, async (client, path) => {
      const session = await AccountSession.prepare(path, client, 'CLI'), pin = pinned(await session.exchange((await session.inspect()).pin, code))
      const original = fs.link
      if (mode === 'receipt-write') vi.spyOn(fs, 'link').mockImplementation(async (...args: Parameters<typeof fs.link>) => {
        if (String(args[1]).endsWith('/revoked.json')) throw Error('synthetic revocation receipt failure')
        return original(...args)
      })
      await expect(session.revoke(pin)).rejects.toMatchObject({ code: mode === 'refused' ? 'refused' : 'outcome-unknown' }); vi.restoreAllMocks()
      const reopened = await AccountSession.open(path, client), before = await reopened.inspect()
      expect(before.status).toBe(mode === 'refused' ? 'revoke-refused' : 'revoke-uncertain')
      expect(before.revocation).toBe('not-proven'); expect((await reopened.status(pin)).status).toBe('unauthorized')
      expect(await reopened.inspect()).toEqual(before)
      expect(JSON.parse(await fs.readFile(join(path, 'grant.json'), 'utf8')).key).toBe(key)
      await expect(reopened.revoke(pin)).rejects.toMatchObject({ code: 'attempt-recorded' })
    }); expect(calls).toBe(3)
  })
  for (const mode of ['public-file', 'symlink', 'hardlink', 'oversize', 'invalid-utf8'] as const) it('refuses unsafe authorization storage: ' + mode, async () => {
    const root = await privateRoot(), directory = join(root, 'session'), client = new AccountClient({ issuer: 'https://issuer.example.test' })
    const session = await AccountSession.prepare(directory, client, 'CLI'), path = join(directory, 'authorization.json')
    if (mode === 'public-file') await fs.chmod(path, 0o644)
    else if (mode === 'symlink') { const retained = join(root, 'retained.json'); await fs.rename(path, retained); await fs.symlink(retained, path) }
    else if (mode === 'hardlink') await fs.link(path, join(root, 'hardlink.json'))
    else await fs.writeFile(path, mode === 'oversize' ? 'x'.repeat(32_769) : Buffer.from([0xff]))
    await expect(session.inspect()).rejects.toBeInstanceOf(AccountSessionError)
    await expect(AccountSession.open(directory, client)).rejects.toBeInstanceOf(AccountSessionError)
  })
  it('rejects public/symlink parents and detects changed session-directory identity without accessing replacement', async () => {
    const root = await privateRoot(), client = new AccountClient({ issuer: 'https://issuer.example.test' })
    const publicDirectory = join(root, 'public'); await fs.mkdir(publicDirectory, { mode: 0o755 })
    await expect(AccountSession.prepare(join(publicDirectory, 'session'), client, 'CLI')).rejects.toMatchObject({ code: 'invalid-storage' })
    const alias = join(root, 'alias'); await fs.symlink(root, alias)
    await expect(AccountSession.prepare(join(alias, 'session'), client, 'CLI')).rejects.toMatchObject({ code: 'invalid-storage' })
    const path = join(root, 'session'), session = await AccountSession.prepare(path, client, 'CLI')
    await fs.rename(path, join(root, 'retained-session')); await fs.mkdir(path, { mode: 0o700 })
    await expect(session.inspect()).rejects.toMatchObject({ code: 'invalid-storage' })
    expect(await fs.readdir(path)).toEqual([])
  })
  it('refuses foreign/corrupt ledger links and grant pins before network or mutation', async () => {
    let calls = 0
    await fixture((_q, r) => { calls++; json(r, result) }, async (client, path) => {
      const session = await AccountSession.prepare(path, client, 'CLI'), active = await session.exchange((await session.inspect()).pin, code), pin = pinned(active)
      for (const bad of [{ ...pin, keyId: '11234567-1234-4567-89ab-0123456789ab' }, { ...pin, grantSha256: 'f'.repeat(64) }, { ...pin, key }])
        await expect(session.revoke(bad)).rejects.toMatchObject({ code: 'invalid-pin' })
      const intentPath = join(path, 'exchange-intent.json'), intent = JSON.parse(await fs.readFile(intentPath, 'utf8'))
      await fs.writeFile(intentPath, JSON.stringify({ ...intent, authorizationSha256: 'f'.repeat(64) }))
      await expect(session.inspect()).rejects.toMatchObject({ code: 'corrupt' })
      await expect(AccountSession.open(path, client)).rejects.toMatchObject({ code: 'corrupt' })
    }); expect(calls).toBe(1)
  })
})

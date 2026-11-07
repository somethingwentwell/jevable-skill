import { describe, it, expect, vi } from 'vitest'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, writeFile, readFile, readdir, chmod, symlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { main } from '../src/cli.ts'

const code = 'jvc_' + 'C'.repeat(32), key = 'jvk_' + 'K'.repeat(32), keyId = '01234567-1234-4567-89ab-0123456789ab'
const otherId = '11234567-1234-4567-89ab-0123456789ab'
const json = (r: ServerResponse, value: unknown, status = 200) => { r.writeHead(status, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(value)) }
async function cli(args: string[]) { let out = '', err = ''; const exit = await main(args, { out: x => { out += x }, err: x => { err += x } }); return { exit, out, err } }
const value = (reply: Awaited<ReturnType<typeof cli>>) => { expect(reply.exit, reply.err).toBe(0); return JSON.parse(reply.out) }
const pinArgs = (pin: { sessionId: string; authorizationSha256: string; keyId?: string; grantSha256?: string }) =>
  ['--session-id', pin.sessionId, '--authorization-sha256', pin.authorizationSha256,
    ...(pin.keyId ? ['--key-id', pin.keyId, '--grant-sha256', pin.grantSha256!] : [])]
async function fixture(work: (common: string[], path: string, codeFile: string, calls: string[], mode: (value: string) => void) => Promise<void>) {
  let origin = '', replyMode = 'happy'; const calls: string[] = []
  const server = createServer((q, r) => {
    calls.push(q.method + ' ' + q.url)
    if (q.url === '/api/app/token') {
      expect(q.headers.authorization).toBeUndefined()
      if (replyMode === 'lost') { r.destroy(); return }
      if (replyMode === 'refused') { json(r, { error: code + key }, 400); return }
      json(r, { key, key_id: keyId, email: 'private@example.test' })
    } else {
      expect(q.headers.authorization).toBe('Bearer ' + key)
      if (replyMode === '401') { json(r, { error: key }, 401); return }
      json(r, q.url === '/api/app/revoke' ? { revoked: true } : { email: 'private@example.test', plan: null, balance: 1500,
        low_balance: false, low_balance_threshold: 1000, links: { top_up: origin + '/checkout', manage_plan: origin + '/console/billing', keys: origin + '/console/keys' } })
    }
  })
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes) })
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Fixture address unavailable')
  origin = `http://127.0.0.1:${address.port}`
  const root = await mkdtemp(join(tmpdir(), 'jevable-account-cli-')), path = join(root, 'session'), file = join(root, 'code')
  await writeFile(file, code + '\n', { mode: 0o600, flag: 'wx' })
  try { await work(['--issuer', origin, '--session-dir', path, '--allow-loopback-http'], path, file, calls, value => { replyMode = value }) }
  finally { vi.restoreAllMocks(); await new Promise<void>((yes, no) => server.close(error => error ? no(error) : yes())) }
}

describe('protected independent account CLI', () => {
  it('offers six real read-only help paths with no secret-argument, browser or workflow-owner options', async () => {
    const index = value(await cli(['help', '--json']))
    expect(index.commands.filter((path: string) => path.startsWith('account '))).toEqual(['account prepare', 'account inspect', 'account link', 'account exchange', 'account status', 'account revoke'])
    // Preserve the prior 129-command catalogue guard and check each exact additive surface.
    const automaticDiagnostics = ['approvals notify automatic-status', 'approvals notify automatic-show', 'approvals notify automatic-list']
    const ownerRecovery = ['runtime lock inspect', 'runtime lock recover', 'runtime lock inspect-recovery', 'runtime lock complete-recovery']
    expect(index.commands.filter((path: string) => !['runtime export-kubernetes', 'kubernetes capacity', 'releases message-id', ...automaticDiagnostics, ...ownerRecovery].includes(path))).toHaveLength(129)
    expect(index.commands.filter((path: string) => ownerRecovery.includes(path))).toEqual(ownerRecovery)
    expect(index.commands.filter((path: string) => automaticDiagnostics.includes(path))).toEqual(automaticDiagnostics)
    expect(index.commands.filter((path: string) => path === 'kubernetes capacity')).toEqual(['kubernetes capacity'])
    expect(index.commands.filter((path: string) => path === 'releases message-id')).toEqual(['releases message-id'])
    expect(index.commands.filter((path: string) => path === 'runtime export-kubernetes')).toEqual(['runtime export-kubernetes'])
    expect(new Set(index.commands).size).toBe(139)
    expect(index.commands).toContain('tests suite coverage')
    for (const action of ['prepare', 'inspect', 'link', 'exchange', 'status', 'revoke']) {
      const report = value(await cli(['help', 'account', action, '--json']))
      expect(report.execution).toBe('not-dispatched'); expect(report.references).toEqual(['references/account.md'])
      for (const variant of report.variants) for (const forbidden of ['code', 'key', 'token', 'data-dir', 'runtime', 'endpoint', 'open-browser'])
        expect(variant.options[forbidden]).toBeUndefined()
    }
  })
  for (const args of [
    ['account'], ['account', 'login'], ['account', 'prepare', '--issuer', 'https://issuer.example.test', '--session-dir', 'never-created'],
    ['account', 'exchange', '--code', code], ['account', 'exchange', code], ['account', 'inspect', '--token', key],
    ['account', 'prepare', '--issuer', 'http://foreign.example.test', '--session-dir', 'never-created', '--name', 'CLI'],
    ['account', 'prepare', '--issuer', 'https://user:secret@issuer.example.test', '--session-dir', 'never-created', '--name', 'CLI'],
    ['account', 'prepare', '--issuer', 'https://issuer.example.test', '--session-dir', 'never-created', '--name', 'CLI', '--data-dir', 'never-created'],
    ['account', 'inspect', '--issuer', 'https://issuer.example.test', '--session-dir', 'never-read', '--ca-file', 'never-read'],
  ]) it('rejects malformed or widened arguments without echoing secrets: ' + args.slice(0, 2).join(' '), async () => {
    const reply = await cli(args); expect(reply.exit).toBe(2); expect(reply.out).toBe('')
    for (const secret of [code, key, 'user:secret', 'never-created', 'never-read']) expect(reply.err).not.toContain(secret)
  })
  it('performs explicit prepare/link/inspect without network and preserves private state on overwrite refusal', async () => {
    await fixture(async (common, path, _file, calls) => {
      const prepared = value(await cli(['account', 'prepare', ...common, '--name', 'CLI']))
      expect(prepared.authorization).toBe('human-action-required'); expect(prepared.network).toBe('not-contacted')
      expect(value(await cli(['account', 'link', ...common])).authorizationUrl).toBe(prepared.authorizationUrl)
      const view = value(await cli(['account', 'inspect', ...common]))
      expect(view.status).toBe('prepared'); expect(view.pin).toEqual(prepared.pin)
      const bytes = await readFile(join(path, 'authorization.json'), 'utf8'), verifier = JSON.parse(bytes).authorization.verifier
      expect(JSON.stringify({ prepared, view })).not.toContain(verifier)
      expect((await cli(['account', 'prepare', ...common, '--name', 'CLI'])).exit).toBe(1)
      expect(await readFile(join(path, 'authorization.json'), 'utf8')).toBe(bytes); expect(calls).toEqual([])
    })
  })
  it('completes protected exchange/status/revoke, hides private status by default and never prints key/code/verifier', async () => {
    await fixture(async (common, path, file, calls) => {
      const prepared = value(await cli(['account', 'prepare', ...common, '--name', 'CLI']))
      const exchange = await cli(['account', 'exchange', ...common, ...pinArgs(prepared.pin), '--code-file', file, '--confirm-exchange'])
      const active = value(exchange); expect(active.status).toBe('active')
      const status = await cli(['account', 'status', ...common, ...pinArgs(active.grant)])
      expect(value(status).privacy).toBe('account-details-excluded'); expect(status.out).not.toContain('private@example.test'); expect(status.out).not.toContain('1500')
      const inspected = value(await cli(['account', 'status', ...common, ...pinArgs(active.grant), '--include-private']))
      expect(inspected.email).toBe('private@example.test'); expect(inspected.balance).toBe(1500)
      const revoked = await cli(['account', 'revoke', ...common, ...pinArgs(active.grant), '--confirm-revoke', keyId])
      expect(value(revoked).status).toBe('revoked'); expect(value(revoked).localCredentials).toBe('retained')
      const verifier = JSON.parse(await readFile(join(path, 'authorization.json'), 'utf8')).authorization.verifier
      for (const reply of [exchange, status, revoked]) for (const secret of [key, code, verifier]) expect(reply.out + reply.err).not.toContain(secret)
      expect(JSON.parse(await readFile(join(path, 'grant.json'), 'utf8')).key).toBe(key)
      expect(calls).toEqual(['POST /api/app/token', 'GET /api/app/account', 'GET /api/app/account', 'POST /api/app/revoke'])
    })
  })
  it('refuses malformed pins, absent consent, mixed code inputs and wrong revocation confirmation before dispatch', async () => {
    await fixture(async (common, path, file, calls) => {
      const prepared = value(await cli(['account', 'prepare', ...common, '--name', 'CLI']))
      const base = ['account', 'exchange', ...common, ...pinArgs(prepared.pin)]
      for (const tail of [['--code-file', file], ['--code-file', file, '--code-stdin', '--confirm-exchange'], ['--confirm-exchange'],
        ['--code-file', file, '--confirm-exchange', '--timeout-ms', '60001'], ['--code-file', file, '--confirm-exchange', '--ca-file', 'never-read']])
        expect((await cli([...base, ...tail])).exit).toBe(2)
      const foreign = await cli(['account', 'exchange', ...common, ...pinArgs({ ...prepared.pin, sessionId: otherId }), '--code-file', 'never-read', '--confirm-exchange'])
      expect(foreign.exit).toBe(2); expect(foreign.err).not.toContain('never-read'); expect(calls).toEqual([])
      const active = value(await cli([...base, '--code-file', file, '--confirm-exchange']))
      expect((await cli(['account', 'revoke', ...common, ...pinArgs(active.grant), '--confirm-revoke', otherId])).exit).toBe(2)
      expect(await readdir(path)).not.toContain('revoke-intent.json'); expect(calls).toEqual(['POST /api/app/token'])
    })
  })
  for (const mode of ['lost', 'refused']) it('retains ' + mode + ' exchange outcome and returns explicit exit codes without replay', async () => {
    await fixture(async (common, _path, file, calls, setMode) => {
      const prepared = value(await cli(['account', 'prepare', ...common, '--name', 'CLI'])); setMode(mode)
      const args = ['account', 'exchange', ...common, ...pinArgs(prepared.pin), '--code-file', file, '--confirm-exchange']
      const first = await cli(args); expect(first.exit).toBe(mode === 'lost' ? 5 : 1); expect(first.out).toBe('')
      expect(first.err).not.toContain(code); expect(first.err).not.toContain(key)
      expect(value(await cli(['account', 'inspect', ...common])).status).toBe(mode === 'lost' ? 'exchange-uncertain' : 'exchange-refused')
      const repeated = await cli(args); expect(repeated.exit).toBe(3); expect(JSON.parse(repeated.err).code).toBe('attempt-recorded')
      expect(calls).toEqual(['POST /api/app/token'])
    })
  })
  it('refuses public/symlink code inputs and preserves prepared state without minting a key', async () => {
    await fixture(async (common, path, file, calls) => {
      const prepared = value(await cli(['account', 'prepare', ...common, '--name', 'CLI'])); await chmod(file, 0o644)
      const reply = await cli(['account', 'exchange', ...common, ...pinArgs(prepared.pin), '--code-file', file, '--confirm-exchange'])
      expect(reply.exit).toBe(2); expect(reply.err).not.toContain(file); expect(calls).toEqual([])
      await chmod(file, 0o600); const alias = join(dirname(file), 'code-alias'); await symlink(file, alias)
      const linked = await cli(['account', 'exchange', ...common, ...pinArgs(prepared.pin), '--code-file', alias, '--confirm-exchange'])
      expect(linked.exit).toBe(2); expect(linked.err).not.toContain(alias); expect(calls).toEqual([])
      expect(await readdir(path)).toEqual(['authorization.json'])
    })
  })
  it('observed 401 hides private errors and neither erases nor proves revocation', async () => {
    await fixture(async (common, path, file, calls, setMode) => {
      const prepared = value(await cli(['account', 'prepare', ...common, '--name', 'CLI']))
      const active = value(await cli(['account', 'exchange', ...common, ...pinArgs(prepared.pin), '--code-file', file, '--confirm-exchange']))
      setMode('401'); const observed = value(await cli(['account', 'status', ...common, ...pinArgs(active.grant)]))
      expect(observed.status).toBe('unauthorized'); expect(observed.revocation).toBe('not-proven')
      expect(JSON.parse(await readFile(join(path, 'grant.json'), 'utf8')).key).toBe(key)
      expect(value(await cli(['account', 'inspect', ...common])).status).toBe('active'); expect(calls).toHaveLength(2)
    })
  })
  it('output failure after exchange retains the private grant; a repeated command never mints again', async () => {
    await fixture(async (common, path, file, calls) => {
      const prepared = value(await cli(['account', 'prepare', ...common, '--name', 'CLI'])), args = ['account', 'exchange', ...common, ...pinArgs(prepared.pin), '--code-file', file, '--confirm-exchange']
      let errors = ''; const exit = await main(args, { out() { throw Error('Synthetic broken output') }, err(x) { errors += x } })
      expect(exit).toBe(5); expect(JSON.parse(errors)).toMatchObject({ code: 'output-write-failed', output: 'not-confirmed-complete' })
      expect(errors).not.toContain(key); expect(JSON.parse(await readFile(join(path, 'grant.json'), 'utf8')).key).toBe(key)
      expect((await cli(args)).exit).toBe(3); expect(calls).toEqual(['POST /api/app/token'])
    })
  })
  it('actual child CLI accepts a piped code, never a secret argument, and returns only metadata', async () => {
    await fixture(async (common, path, _file, calls) => {
      const prepared = value(await cli(['account', 'prepare', ...common, '--name', 'CLI']))
      const program = `import {main} from ${JSON.stringify(new URL('../src/cli.ts', import.meta.url).href)}; process.exitCode=await main(process.argv.slice(1));`
      const child = spawn(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', program, '--',
        'account', 'exchange', ...common, ...pinArgs(prepared.pin), '--code-stdin', '--confirm-exchange'], { stdio: ['pipe', 'pipe', 'pipe'] })
      let out = '', err = ''; child.stdout.on('data', bytes => { out += bytes }); child.stderr.on('data', bytes => { err += bytes })
      const finished = new Promise<number | null>((yes, no) => { child.once('error', no); child.once('close', yes) })
      child.stdin.end(code + '\n'); expect(await finished, err).toBe(0)
      expect(JSON.parse(out).status).toBe('active'); expect(JSON.parse(await readFile(join(path, 'grant.json'), 'utf8')).key).toBe(key)
      for (const secret of [code, key]) expect(out + err).not.toContain(secret)
      expect(calls).toEqual(['POST /api/app/token'])
    })
  })
  it('actual child SIGTERM drains an admitted exchange and persists its key before exiting 143, without replay', async () => {
    let received!: (r: ServerResponse) => void
    const request = new Promise<ServerResponse>(yes => { received = yes })
    let calls = 0
    const server = createServer((_q, r) => { calls++; received(r) })
    await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes) })
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Fixture address unavailable')
    const origin = `http://127.0.0.1:${address.port}`, root = await mkdtemp(join(tmpdir(), 'jevable-account-cli-drain-')), path = join(root, 'session')
    const common = ['--issuer', origin, '--session-dir', path, '--allow-loopback-http']
    try {
      const prepared = value(await cli(['account', 'prepare', ...common, '--name', 'CLI']))
      const program = `import {main} from ${JSON.stringify(new URL('../src/cli.ts', import.meta.url).href)}; process.exitCode=await main(process.argv.slice(1));`
      const child = spawn(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', program, '--',
        'account', 'exchange', ...common, ...pinArgs(prepared.pin), '--code-stdin', '--confirm-exchange'], { stdio: ['pipe', 'pipe', 'pipe'] })
      let out = '', err = '', drained!: () => void
      const draining = new Promise<void>(yes => { drained = yes })
      child.stdout.on('data', bytes => { out += bytes }); child.stderr.on('data', bytes => { err += bytes; if (err.includes('"status":"draining"')) drained() })
      const finished = new Promise<{ exit: number | null; signal: string | null }>((yes, no) => { child.once('error', no); child.once('close', (exit, signal) => yes({ exit, signal })) })
      child.stdin.end(code + '\n'); const response = await request
      expect(child.kill('SIGTERM')).toBe(true); await draining
      expect(child.kill('SIGTERM')).toBe(true); json(response, { key, key_id: keyId, email: '' })
      expect(await finished).toEqual({ exit: 143, signal: null })
      expect(JSON.parse(out).status).toBe('active'); expect(err.match(/"status":"draining"/gu)).toHaveLength(1)
      const inspected = value(await cli(['account', 'inspect', ...common])); expect(inspected.status).toBe('active')
      expect(JSON.parse(await readFile(join(path, 'grant.json'), 'utf8')).key).toBe(key)
      expect(calls).toBe(1); for (const secret of [code, key]) expect(out + err).not.toContain(secret)
    } finally { await new Promise<void>((yes, no) => server.close(error => error ? no(error) : yes())) }
  })
})

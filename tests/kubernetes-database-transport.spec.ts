import { afterAll, expect, it } from 'vitest'
import { mkdtemp, writeFile, chmod, symlink, link, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Socket } from 'node:net'
import { createSecureContext, TLSSocket } from 'node:tls'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { databaseTransportGate } from '../src/deployment/postgres-transport-script.ts'
const exec = promisify(execFile), children: number[] = []
const { createTlsFixture } = await import('../scripts/tls-fixture.mjs')
const directory = await mkdtemp(join(tmpdir(), 'jevable-pg-transport-'))
const tls = await createTlsFixture(directory)
const key = await readFile(tls.key), cert = await readFile(tls.cert)
const script = join(directory, 'gate.mjs'); await writeFile(script, databaseTransportGate)
async function config(port: number, change: Record<string, unknown> = {}) {
  const path = join(await mkdtemp(join(tmpdir(), 'jevable-pg-config-')), 'database.json')
  await writeFile(path, JSON.stringify({ host: '127.0.0.1', port, tls: { mode: 'verify-full', ca: tls.ca },
    user: 'PRIVATE_USER', password: 'PRIVATE_PASSWORD', database: 'PRIVATE_DATABASE', ...change }), { mode: 0o600 })
  return path
}
async function run(path: string, budget = '2') {
  const work = exec(process.execPath, [script, path, budget], { timeout: 5000, maxBuffer: 4096,
    env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8' } })
  children.push(work.child.pid!)
  try { const v = await work; return { code: 0, ...v } }
  catch (error) { const v = error as { code: number; stdout: string; stderr: string }; return { code: v.code, stdout: v.stdout, stderr: v.stderr } }
}
async function server(mode: 'tls' | 'no' | 'stuffed' | 'error' | 'silent' | 'tls-stall' = 'tls', serverCert: Buffer = cert) {
  const sockets = new Set<Socket>(), requests: Buffer[] = []; let authenticatedBytes = 0, handshakes = 0
  const s = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket))
    let input = Buffer.alloc(0)
    const receive = (bytes: Buffer) => {
      input = Buffer.concat([input, bytes]); if (input.length < 8) return
      socket.off('data', receive); requests.push(input)
      if (mode === 'silent') return
      if (mode === 'no') { socket.end('N'); return }
      if (mode === 'stuffed') { socket.end('SPRIVATE_UNTRUSTED_ERROR'); return }
      if (mode === 'error') { socket.end('EPRIVATE_UNTRUSTED_ERROR'); return }
      socket.write('S'); if (mode === 'tls-stall') return
      const secured = new TLSSocket(socket, { isServer: true, secureContext: createSecureContext({ key, cert: serverCert }) })
      sockets.add(secured); secured.on('error', () => {}); secured.on('close', () => sockets.delete(secured))
      secured.on('secure', () => handshakes++); secured.on('data', b => { authenticatedBytes += b.length })
    }
    socket.on('data', receive)
  })
  await new Promise<void>((yes, no) => { s.once('error', no); s.listen(0, '127.0.0.1', yes) })
  return { server: s, port: (s.address() as { port: number }).port, requests,
    summary: () => ({ authenticatedBytes, handshakes }),
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((yes, no) => s.close(e => e ? no(e) : yes())) } }
}
afterAll(() => { for (const pid of children) expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' })) })
it('accepts verified PostgreSQL TLS and sends neither credentials nor StartupMessage/SQL', async () => {
  const s = await server()
  try {
    const result = await run(await config(s.port))
    expect(result.code).toBe(0); expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({ status: 'ready', check: 'postgresql-tls-transport', authentication: 'not-checked', execution: 'not-run' })
    expect(s.requests).toEqual([Buffer.from([0, 0, 0, 8, 4, 210, 22, 47])])
    expect(s.summary().authenticatedBytes).toBe(0)
  } finally { await s.close() }
})
it.each(['no', 'stuffed', 'error'] as const)('refuses %s negotiation without plaintext fallback or untrusted text disclosure', async mode => {
  const s = await server(mode)
  try { const r = await run(await config(s.port)); expect(r.code).toBe(1); expect(r.stdout).toBe(''); expect(JSON.parse(r.stderr).code).toBe('protocol-refused'); expect(r.stderr).not.toContain('PRIVATE'); expect(s.requests).toHaveLength(1) }
  finally { await s.close() }
})
it.each(['silent', 'tls-stall'] as const)('bounds %s peers by the overall monotonic deadline and closes connections', async mode => {
  const s = await server(mode)
  try { const started = performance.now(), r = await run(await config(s.port), '1'); expect(r.code).toBe(1); expect(JSON.parse(r.stderr).code).toBe('deadline'); expect(performance.now() - started).toBeLessThan(2500) }
  finally { await s.close() }
})
it('waits for a delayed listener without authentication or any workflow/runtime retry', async () => {
  const reserve = createServer(); await new Promise<void>((yes, no) => { reserve.once('error', no); reserve.listen(0, '127.0.0.1', yes) })
  const port = (reserve.address() as { port: number }).port; await new Promise<void>(yes => reserve.close(() => yes()))
  const path = await config(port), promise = run(path, '3')
  let live: Awaited<ReturnType<typeof server>> | undefined
  const delayed = new Promise<void>((yes, no) => setTimeout(async () => {
    try {
      live = await server(); await live.close()
      // Rebind the same reviewed endpoint, never select another client destination.
      await new Promise<void>((resolve, reject) => { live!.server.once('error', reject); live!.server.listen(port, '127.0.0.1', resolve) }); yes()
    } catch (e) { no(e) }
  }, 700))
  try { await delayed; expect((await promise).code).toBe(0); expect(live!.requests).toHaveLength(1); expect(live!.summary().authenticatedBytes).toBe(0) }
  finally { if (live) await live.close() }
})
it('fails hostname verification rather than retrying or accepting the configured CA alone', async () => {
  const wrong = join(await mkdtemp(join(tmpdir(), 'jevable-pg-hostname-')), 'wrong.crt')
  await exec('openssl', ['req', '-new', '-x509', '-key', tls.key, '-days', '2', '-subj', '/CN=wrong-test-only', '-addext', 'subjectAltName=DNS:wrong.invalid', '-out', wrong], { timeout: 5000 })
  const wrongCert = await readFile(wrong), s = await server('tls', wrongCert)
  try { const r = await run(await config(s.port, { tls: { mode: 'verify-full', ca: wrongCert.toString() } })); expect(r.code).toBe(1); expect(JSON.parse(r.stderr).code).toBe('tls-refused'); expect(s.requests).toHaveLength(1); expect(r.stderr).not.toContain('127.0.0.1') }
  finally { await s.close() }
})
it('refuses an untrusted CA without retrying the TLS peer', async () => {
  const other = await createTlsFixture(await mkdtemp(join(tmpdir(), 'jevable-pg-other-ca-'))), s = await server()
  try { const r = await run(await config(s.port, { tls: { mode: 'verify-full', ca: other.ca } })); expect(r.code).toBe(1); expect(JSON.parse(r.stderr).code).toBe('tls-refused'); expect(s.requests).toHaveLength(1); expect(s.summary().authenticatedBytes).toBe(0) }
  finally { await s.close() }
})
it.each([{ tls: { mode: 'loopback-test' } }, { tls: { mode: 'verify-full', ca: 'PRIVATE_INVALID_CA' } }, { port: 0 }, { host: 'PRIVATE_HOST/path' }])('refuses invalid configuration before networking: %j', async change => {
  const r = await run(await config(1, change)); expect(r.code).toBe(1); expect(r.stdout).toBe(''); expect(JSON.parse(r.stderr).code).toBe('configuration-invalid'); expect(r.stderr).not.toContain('PRIVATE')
})
it.each(['0', '301', '1.5', '-1', '1e2'])('refuses unsupported wait budget %s', async budget => {
  expect(JSON.parse((await run(await config(1), budget)).stderr).code).toBe('configuration-invalid')
})
it('refuses shared files and symlinks without reading or exposing their contents', async () => {
  const path = await config(1), other = path + '.linked', symbolic = path + '.symlink'; await link(path, other); await symlink(path, symbolic)
  for (const p of [path, symbolic]) expect(JSON.parse((await run(p)).stderr).code).toBe('configuration-invalid')
})
it('refuses a group-readable configuration file', async () => {
  const path = await config(1); await chmod(path, 0o640); expect(JSON.parse((await run(path)).stderr).code).toBe('configuration-invalid')
})

import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, chmod, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes, randomUUID } from 'node:crypto'
import { request, createServer } from 'node:https'
import { connect } from 'node:tls'
import { startRuntimeService, RuntimeClient } from '../src/http/index.ts'
import { tlsOptionsFromFlags, readTlsPemFile } from '../src/http/tls.ts'
import { LocalRuntime } from '../src/runtime/local.ts'
import { ReleaseClient } from '../src/releases/client.ts'
import { CORE_VERSION, PROTOCOL_VERSION } from '../src/capabilities.ts'
import { main } from '../src/cli.ts'
import { createTlsFixture, fixturePort } from '../scripts/tls-fixture.mjs'

let credentials: Awaited<ReturnType<typeof createTlsFixture>>
const cleanup: (() => Promise<unknown>)[] = []
const token = randomBytes(32).toString('hex')
const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
beforeAll(async () => { credentials = await createTlsFixture(await mkdtemp(join(tmpdir(), 'jevable-tls-'))) }, 20000)
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop() })
async function config() {
  const port = await fixturePort()
  return { runtime: { dataDirectory: join(await mkdtemp(join(tmpdir(), 'jevable-tls-state-')), 'data') }, token, actor: 'fixture:tls', port,
    tls: { publicOrigin: `https://127.0.0.1:${port}`, bindAddress: '127.0.0.1', certificateFile: credentials.cert, privateKeyFile: credentials.key } }
}
async function fixture() {
  const options = await config(), service = await startRuntimeService(options)
  cleanup.push(() => service.close())
  return { options, service, client: new RuntimeClient(service.url, token, 2000, 20_000_000, { ca: credentials.ca }) }
}
function raw(url: string, headers: Record<string, string | string[]> = {}, body?: unknown, pathname = '/v1/health') {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request(url + pathname, { ca: credentials.ca, rejectUnauthorized: true, agent: false, servername: '',
      method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Jevable-Protocol': PROTOCOL_VERSION,
        'Content-Type': 'application/json', ...headers } }, res => {
      const chunks: Buffer[] = []
      res.on('data', data => chunks.push(data)); res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }))
    })
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

describe('explicit direct HTTPS transport', () => {
  it('requires trust, preserves exact operation retries, and advertises the selected transport', async () => {
    const f = await fixture()
    await expect(new RuntimeClient(f.service.url, token, 1000).health()).rejects.toHaveProperty('code', 'transport-uncertain')
    expect(await f.client.capabilities()).toMatchObject({ remoteAccess: true, api: { transport: 'direct-https', servesHtml: false } })
    expect(f.service).toMatchObject({ url: f.options.tls.publicOrigin, listener: { port: f.options.port }, tls: { minimumVersion: 'TLSv1.2' } })
    const command = { operation: 'runs.start' as const, id: randomUUID(), yaml: echo, input: 'TLS workflow' }
    const first = await f.client.operation(command)
    expect(first).toMatchObject({ result: { status: 'completed', output: 'TLS workflow' } })
    expect(await f.client.operation(command)).toEqual(first)
    expect((await raw(f.service.url, {}, undefined, '/')).status).toBe(404)
  })

  it('keeps certificate validation enabled even with the unsafe Node environment override', async () => {
    const f = await fixture(), previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED
    try {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
      await expect(new RuntimeClient(f.service.url, token, 1000).health()).rejects.toHaveProperty('code', 'transport-uncertain')
      expect(await f.client.health()).toMatchObject({ status: 'ready' })
    } finally { if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous }
  })

  it('rejects an untrusted CA, hostname mismatch and obsolete TLS versions before HTTP authority is used', async () => {
    const f = await fixture(), other = await createTlsFixture(await mkdtemp(join(tmpdir(), 'jevable-wrong-ca-')))
    await expect(new RuntimeClient(f.service.url, token, 1000, 20_000_000, { ca: other.ca }).health()).rejects.toHaveProperty('code', 'transport-uncertain')
    // Connect directly to the same socket; override only TLS name to exercise actual certificate validation.
    await expect(new Promise((resolve, reject) => {
      const req = request(f.service.url, { ca: credentials.ca, rejectUnauthorized: true, servername: 'wrong.example', agent: false }, resolve)
      req.on('error', reject); req.end()
    })).rejects.toHaveProperty('code', 'ERR_TLS_CERT_ALTNAME_INVALID')
    await expect(new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port: f.options.port, ca: credentials.ca, minVersion: 'TLSv1', maxVersion: 'TLSv1.1' }, () => { socket.destroy(); resolve('connected') })
      socket.on('error', reject)
    })).rejects.toThrow()
  })

  it.each([
    [{ Host: 'foreign.example' }, 403, 'host-rejected'],
    [{ Origin: 'https://foreign.example' }, 403, 'origin-rejected'],
    [{ Authorization: `Bearer ${'0'.repeat(64)}` }, 401, 'unauthorized'],
    [{ 'X-Jevable-Protocol': 'wrong' }, 409, 'protocol-mismatch'],
    [{ Forwarded: 'for=127.0.0.1;proto=https' }, 403, 'proxy-headers-rejected'],
    [{ 'X-Forwarded-For': '127.0.0.1' }, 403, 'proxy-headers-rejected'],
    [{ 'X-Real-IP': '127.0.0.1' }, 403, 'proxy-headers-rejected'],
    [{ Origin: ['https://one.example', 'https://two.example'] }, 400, 'ambiguous-headers'],
  ] as const)('retains transport guards for %j', async (headers, status, code) => {
    const f = await fixture()
    expect(await raw(f.service.url, headers as Record<string, string | string[]>)).toMatchObject({ status, body: { code } })
    expect((await raw(f.service.url, { Origin: f.service.url })).status).toBe(200)
  })

  it.each(['plaintext', 'path', 'ephemeral-port', 'wildcard-name', 'preview', 'extra-option', 'mismatched-name'] as const)(
    'rejects invalid %s configuration before opening storage', async mode => {
      const f = await config()
      if (mode === 'plaintext') f.tls.publicOrigin = f.tls.publicOrigin.replace('https:', 'http:')
      if (mode === 'path') f.tls.publicOrigin += '/path'
      if (mode === 'ephemeral-port') f.port = 0
      if (mode === 'wildcard-name') f.tls.bindAddress = 'localhost'
      if (mode === 'mismatched-name') f.tls.publicOrigin = 'https://wrong.example'
      if (mode === 'extra-option') Object.assign(f.tls, { rejectUnauthorized: false })
      await expect(startRuntimeService({ ...f, ...(mode === 'preview' ? { preview: { source: echo } } : {}) })).rejects.toHaveProperty('code', 'invalid-command')
      // The rejected start must not strand the owner's lock or create a preview project.
      const rt = await LocalRuntime.open(f.runtime)
      expect(rt.projects()).toEqual([]); await rt.close()
    })

  it.each(['permissions', 'symlink', 'mismatched-key', 'too-large', 'directory'] as const)(
    'rejects %s key material without returning PEM or holding the data directory', async mode => {
      const f = await config(), directory = await mkdtemp(join(tmpdir(), 'jevable-tls-invalid-')), key = join(directory, 'key')
      if (mode === 'symlink') await symlink(credentials.key, key)
      else if (mode === 'directory') f.tls.privateKeyFile = directory
      else {
        await writeFile(key, mode === 'too-large' ? 'x'.repeat(262145) : await readFile(credentials.key), { mode: 0o600 })
        if (mode === 'permissions') await chmod(key, 0o644)
        if (mode === 'mismatched-key') f.tls.certificateFile = (await createTlsFixture(directory)).cert
      }
      if (mode !== 'directory') f.tls.privateKeyFile = key
      await expect(startRuntimeService(f)).rejects.toMatchObject({ code: 'invalid-command' })
      const rt = await LocalRuntime.open(f.runtime); await rt.close()
    })

  it('requires every explicit TLS flag and never interprets bind-only as plaintext exposure', async () => {
    expect(tlsOptionsFromFlags({})).toBeUndefined()
    for (const flag of ['public-origin', 'bind-address', 'tls-cert-file', 'tls-key-file']) {
      expect(() => tlsOptionsFromFlags({ [flag]: 'anything' })).toThrow()
      const lines: string[] = []
      const tokenFile = join(await mkdtemp(join(tmpdir(), 'jevable-tls-cli-')), 'token')
      await writeFile(tokenFile, token, { mode: 0o600 })
      const status = await main(['runtime', 'serve', '--token-file', tokenFile, `--${flag}`, 'anything'], { out: value => lines.push(value), err: value => lines.push(value) })
      expect(status).not.toBe(0); expect(lines.join('')).not.toContain(token)
    }
    expect(() => new RuntimeClient('http://example.com:443', token)).toThrow()
    expect(() => new RuntimeClient('http://127.0.0.1:1234', token, 1000, 1024, { ca: credentials.ca })).toThrow()
    expect(() => new RuntimeClient('https://example.com', token, 1000, 1024, { ca: 'invalid' })).toThrow()
    const file = join(await mkdtemp(join(tmpdir(), 'jevable-tls-ca-')), 'ca')
    await symlink(credentials.cert, file)
    await expect(readTlsPemFile(file)).rejects.toHaveProperty('code', 'invalid-command')
  })

  it('keeps public authority separate from a mapped internal listening port', async () => {
    const f = await config()
    f.tls.publicOrigin = 'https://127.0.0.1'
    const service = await startRuntimeService(f); cleanup.push(() => service.close())
    const internal = `https://127.0.0.1:${service.listener.port}`
    expect(service.url).toBe('https://127.0.0.1')
    expect((await raw(internal)).body.code).toBe('host-rejected')
    expect(await raw(internal, { Host: '127.0.0.1', Origin: service.url })).toMatchObject({ status: 200, body: { status: 'ready' } })
  })

  it('preserves exact-release admission, approval waits and evidence across HTTPS owner replacement', async () => {
    const f = await config(), author = await LocalRuntime.open({ dataDirectory: await mkdtemp(join(tmpdir(), 'jevable-tls-author-')) })
    let release
    try {
      const project = author.editProject({ operation: 'create', yaml: approval, title: 'HTTPS approval', actor: 'fixture:author' })
      release = author.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision,
        version: '1.0.0', actor: 'fixture:author', runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
    } finally { await author.close() }
    const start = async () => { const s = await startRuntimeService({ ...f, release: { snapshot: release.snapshot } }); cleanup.push(() => s.close()); return s }
    let service = await start()
    const client = new ReleaseClient(service.url, token, release.sha256, 2000, { ca: credentials.ca })
    const command = { operation: 'runs.start' as const, id: randomUUID(), input: { message: 'TLS approval' } }
    const waiting: any = await client.operation(command)
    expect(waiting.result.status).toBe('waiting')
    await expect(new ReleaseClient(service.url, token, 'b'.repeat(64), 2000, { ca: credentials.ca }).operation(command)).rejects.toHaveProperty('code', 'conflict')
    await service.close(); service = await start()
    expect((await client.operation(command) as any).result).toEqual(waiting.result)
    const done: any = await client.operation({ operation: 'approvals.decide', id: command.id, attemptId: waiting.result.attemptId, action: 'approve' })
    expect(done.result).toMatchObject({ status: 'completed', output: 'approve' })
    const exported: any = await client.operation({ operation: 'runs.export', id: command.id })
    expect(exported.result.snapshot.private).toBeUndefined()
    expect(JSON.stringify(exported)).not.toContain('TLS approval')
    await expect(client.operation({ operation: 'projects.list' } as never)).rejects.toHaveProperty('code', 'invalid-command')
    await service.close()
    const retained = await LocalRuntime.open(f.runtime)
    expect((await retained.show(command.id)).state.status).toBe('completed'); await retained.close()
  })

  it.each(['redirect', 'oversize', 'timeout', 'encoded'] as const)('bounds HTTPS %s and never retries', async mode => {
    let calls = 0
    const server = createServer({ cert: credentials.ca, key: await readFile(credentials.key) }, (_req, res) => {
      calls++; if (mode === 'timeout') return
      res.setHeader('X-Jevable-Protocol', PROTOCOL_VERSION); res.setHeader('Content-Type', 'application/json')
      if (mode === 'redirect') { res.statusCode = 302; res.setHeader('Location', 'https://elsewhere.example') }
      if (mode === 'encoded') res.setHeader('Content-Encoding', 'gzip')
      res.end(JSON.stringify('x'.repeat(mode === 'oversize' ? 2048 : 1)))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
    const address = server.address() as { port: number }
    const client = new RuntimeClient(`https://127.0.0.1:${address.port}`, token, mode === 'timeout' ? 100 : 2000, 1024, { ca: credentials.ca })
    await expect(client.health()).rejects.toHaveProperty('code', { redirect: 'redirect-refused', oversize: 'response-limit', timeout: 'request-timeout', encoded: 'invalid-response' }[mode])
    expect(calls).toBe(1)
  })
})

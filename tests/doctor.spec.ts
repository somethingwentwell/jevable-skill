import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, chmod, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import Client from 'pg/lib/client.js'
import { main } from '../src/cli.ts'
import { doctor, supportedNodeVersion } from '../src/cli/doctor.ts'
import { loadReleaseRuntime } from '../src/packages/release-zip.ts'
import { CORE_VERSION, PROTOCOL_VERSION } from '../src/capabilities.ts'

vi.mock('../src/packages/release-zip.ts', async original => ({ ...await original<typeof import('../src/packages/release-zip.ts')>(), loadReleaseRuntime: vi.fn() }))
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function cli(args: string[]) { let out = '', err = ''; const code = await main(args, { out: value => { out += value }, err: value => { err += value } }); return { code, out, err, report: out ? JSON.parse(out) : undefined } }
const fixture = () => mkdtemp(join(tmpdir(), 'jevable-doctor-'))
const check = (r: Awaited<ReturnType<typeof doctor>>, id: string) => r.checks.find(c => c.id === id)

it.each([['22.19.0', true], ['v22.18.9', false], ['22.20.0', true], ['20.99.0', false], ['24.0.0', true], ['25.9.0', true], ['invalid', false], ['22.19.0-beta', false]])('checks Node %s compatibility', (v, expected) => expect(supportedNodeVersion(v as string)).toBe(expected))

it('checks installation without opening a database, initializing state or contacting ambient services', async () => {
  const connect = vi.spyOn(Client.prototype, 'connect').mockImplementation(() => { throw Error('must not connect') })
  vi.stubEnv('PGHOST', 'private.invalid'); vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'https://private.invalid'); vi.stubEnv('DOCKER_HOST', 'tcp://private.invalid')
  const directory = await fixture(), path = join(directory, 'not-created')
  const r = await doctor({ 'data-dir': path })
  expect(r).toMatchObject({ status: 'attention', mutations: 'none', execution: 'not-run', network: 'none' })
  expect(check(r, 'data-directory')?.code).toBe('absent'); expect(await readdir(directory)).toEqual([])
  expect(vi.mocked(loadReleaseRuntime).mock.calls.map(call => call[0])).toEqual(['sqlite', 'postgres']); expect(connect).not.toHaveBeenCalled()
})

it('reports a broken bundle as failure with actionable sanitized guidance', async () => {
  vi.mocked(loadReleaseRuntime).mockRejectedValueOnce(new Error('PRIVATE_BUNDLE_PATH'))
  const r = await cli(['doctor', '--json']); expect(r.code).toBe(1)
  expect(check(r.report, 'release-sqlite')).toMatchObject({ status: 'fail', code: 'unavailable-or-invalid' })
  expect(r.out + r.err).not.toContain('PRIVATE_BUNDLE_PATH')
})

it('observes a private database and lock without reading or changing either, and never claims a lock is stale', async () => {
  const directory = await fixture(); await chmod(directory, 0o700)
  await writeFile(join(directory, 'runtime.sqlite'), 'PRIVATE_NOT_A_DATABASE', { mode: 0o600 })
  await writeFile(join(directory, 'runtime.lock'), 'PRIVATE_INVALID_LOCK', { mode: 0o600 })
  const before = await lstat(join(directory, 'runtime.sqlite')), result = await doctor({ 'data-dir': directory })
  expect(result.status).toBe('attention'); expect(check(result, 'runtime.lock')?.code).toBe('lock-present')
  expect(check(result, 'runtime.sqlite')?.status).toBe('pass'); expect(JSON.stringify(result)).not.toContain('PRIVATE_')
  expect((await lstat(join(directory, 'runtime.sqlite'))).mtimeMs).toBe(before.mtimeMs)
  expect(await readFile(join(directory, 'runtime.lock'), 'utf8')).toBe('PRIVATE_INVALID_LOCK')
  expect((await readdir(directory)).sort()).toEqual(['runtime.lock', 'runtime.sqlite'])
})

it.skipIf(process.platform === 'win32')('refuses unsafe file metadata without following final symlinks or repairing permissions', async () => {
  const directory = await fixture(), state = join(directory, 'state'), alias = join(directory, 'alias'); await mkdir(state, { mode: 0o700 }); await symlink(state, alias)
  expect(check(await doctor({ 'data-dir': alias }), 'data-directory')?.status).toBe('fail')
  await writeFile(join(state, 'runtime.sqlite'), 'keep', { mode: 0o644 })
  expect(check(await doctor({ 'data-dir': state }), 'runtime.sqlite')?.status).toBe('fail')
  expect((await lstat(join(state, 'runtime.sqlite'))).mode & 0o777).toBe(0o644)
  await chmod(state, 0o755); expect(check(await doctor({ 'data-dir': state }), 'data-directory')?.status).toBe('fail')
  expect((await lstat(state)).mode & 0o777).toBe(0o755)
})

it('validates protected PostgreSQL config with startup admission rules but never connects, even with initialize enabled', async () => {
  const directory = await fixture(), file = join(directory, 'database.json')
  const connect = vi.spyOn(Client.prototype, 'connect').mockImplementation(() => { throw Error('no connection') })
  const config = { host: '127.0.0.1', port: 1, database: 'fixture', user: 'fixture', password: 'PRIVATE_PASSWORD', namespace: 'fixture', initialize: true, tls: { mode: 'loopback-test' } }
  await writeFile(file, JSON.stringify(config), { mode: 0o600 })
  expect(check(await doctor({ storage: 'postgres', 'database-file': file }), 'database-config')?.status).toBe('pass')
  for (const patch of [{ host: 'remote.invalid' }, { tls: { mode: 'verify-full', ca: 'PRIVATE_INVALID_CA' } }, { port: 0 }, { extra: true }]) {
    await writeFile(file, JSON.stringify({ ...config, ...patch }))
    const r = await doctor({ storage: 'postgres', 'database-file': file })
    expect(check(r, 'database-config')?.status).toBe('fail'); expect(JSON.stringify(r)).not.toMatch(/PRIVATE_|remote.invalid/)
  }
  expect(connect).not.toHaveBeenCalled(); expect(await readdir(directory)).toEqual(['database.json'])
})

it('validates telemetry without resolving credentials or sending signals', async () => {
  const directory = await fixture(), file = join(directory, 'telemetry.json')
  const config = { endpoint: 'https://private.invalid/v1/traces', authentication: { kind: 'bearer', credentialRef: 'PRIVATE_REF' } }
  await writeFile(file, JSON.stringify(config), { mode: 0o600 })
  const r = await doctor({ 'telemetry-file': file }); expect(check(r, 'telemetry-config')?.status).toBe('pass'); expect(r.network).toBe('none')
  expect(JSON.stringify(r)).not.toMatch(/private.invalid|PRIVATE_REF/)
  await writeFile(file, JSON.stringify({ ...config, resource: { arbitrary: 'PRIVATE_PAYLOAD' } }))
  const invalid = await doctor({ 'telemetry-file': file }); expect(invalid.status).toBe('failed'); expect(JSON.stringify(invalid)).not.toContain('PRIVATE_PAYLOAD')
})
it.skipIf(process.platform === 'win32')('refuses FIFOs and final symlinks promptly without changing their target', async () => {
  const directory = await fixture(), fifo = join(directory, 'fifo'), original = join(directory, 'original'), alias = join(directory, 'alias')
  await promisify(execFile)('mkfifo', [fifo]); await writeFile(original, '{}'); await symlink(original, alias)
  for (const path of [fifo, alias]) {
    expect(check(await doctor({ 'telemetry-file': path }), 'telemetry-config')?.status).toBe('fail')
    // The bundle loader receives the same guarded reader; verify that path also without opening a real bundle.
    vi.mocked(loadReleaseRuntime).mockImplementationOnce(async (_storage, read) => { await read!(path, 16000); throw Error('Unexpected readable input') })
    expect(check(await doctor({}), 'release-sqlite')?.status).toBe('fail')
  }
  expect(await readFile(original, 'utf8')).toBe('{}')
}, 2000)

it.each([
  ['--storage', 'postgres'], ['--storage', 'docker'], ['--database-file', 'private'], ['--token-file', 'private'], ['--ca-file', 'private'],
  ['--endpoint', 'http://127.0.0.1:1'], ['--endpoint', 'http://127.0.0.1:1', '--token-file', 'private', '--data-dir', 'private'],
  ['--endpoint', 'http://127.0.0.1:1', '--token-file', 'private', '--timeout-ms', '30001'], ['--fix'], ['--runtime', 'docker'],
])('refuses conflicting or unsupported doctor flags before probes: %j', async (...flags) => {
  const r = await cli(['doctor', ...flags]); expect(r.code).toBe(2); expect(loadReleaseRuntime).not.toHaveBeenCalled()
})

it.each(['ready', 'draining', 'version', 'protocol', 'changed', 'invalid', 'unauthorized', 'redirect', 'timeout', 'oversize', 'remote-error',
  'sqlite', 'sqlite-enabled', 'sqlite-invalid', 'postgres', 'postgres-lost', 'foreign-storage'])(
  'reads only explicit service metadata and sanitizes %s outcomes', async mode => {
    const directory = await fixture(), tokenFile = join(directory, 'token'), id = randomUUID(), requests: string[] = []
    const token = 'f'.repeat(64); await writeFile(tokenFile, token, { mode: 0o600 })
    const runtimes: Record<string, unknown> = {
      sqlite: { storage: 'sqlite', telemetry: { enabled: false, signals: [] } },
      'sqlite-enabled': { storage: 'sqlite', telemetry: { enabled: true, signals: ['traces', 'metrics', 'logs'], private: 'PRIVATE_EXPORTER' } },
      'sqlite-invalid': { storage: 'sqlite', telemetry: { enabled: 'true', signals: ['foreign'] } },
      postgres: { storage: 'postgres', database: 'reachable', state: 'open' },
      'postgres-lost': { storage: 'postgres', database: 'unavailable', state: 'closed' },
      'foreign-storage': { storage: 'foreign', telemetry: { enabled: false, signals: [] } },
    }
    const server = createServer((req, res) => {
      requests.push(req.url!); expect(req.method).toBe('GET'); expect(req.headers.authorization).toBe(`Bearer ${token}`)
      if (mode === 'timeout') return
      res.writeHead(mode === 'unauthorized' ? 401 : mode === 'redirect' ? 302 : mode === 'remote-error' ? 500 : 200,
        { 'x-jevable-protocol': mode === 'protocol' ? 'foreign' : PROTOCOL_VERSION, 'content-type': 'application/json', location: '/must-not-follow' })
      if (mode === 'oversize') return res.end(JSON.stringify({ private: 'x'.repeat(260000) }))
      if (mode === 'unauthorized' || mode === 'remote-error') return res.end(JSON.stringify({ code: mode === 'unauthorized' ? 'unauthorized' : 'private-secret', message: 'PRIVATE_REMOTE' }))
      if (req.url === '/v1/capabilities') res.end(JSON.stringify({ schemaVersion: 1, product: 'Jevable core', version: mode === 'version' ? '0.0.0' : CORE_VERSION,
        protocolVersion: PROTOCOL_VERSION, instanceId: id, api: { protocol: PROTOCOL_VERSION }, private: 'PRIVATE_CAPABILITIES' }))
      else res.end(JSON.stringify({ schemaVersion: 1, instanceId: mode === 'changed' ? randomUUID() : id, status: mode === 'invalid' ? 'nonsense' : mode === 'draining' ? 'draining' : 'ready',
        ...(runtimes[mode] ? { runtime: runtimes[mode] } : {}), private: 'PRIVATE_HEALTH' }))
    })
    cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const r = await cli(['doctor', '--endpoint', `http://127.0.0.1:${(server.address() as { port: number }).port}`, '--token-file', tokenFile, '--timeout-ms', mode === 'timeout' ? '20' : '1000'])
    expect(r.code).toBe(['ready', 'draining', 'sqlite', 'sqlite-enabled', 'postgres'].includes(mode) ? 0 : 1)
    expect(check(r.report, 'service')?.code).toBe(({ version: 'version-mismatch', protocol: 'protocol-mismatch', changed: 'instance-changed', invalid: 'invalid-response',
      unauthorized: 'unauthorized', redirect: 'redirect-refused', timeout: 'request-timeout', oversize: 'response-limit', 'remote-error': 'service-unavailable-or-invalid',
      sqlite: 'ready', 'sqlite-enabled': 'ready', postgres: 'ready', 'sqlite-invalid': 'invalid-response', 'postgres-lost': 'invalid-response', 'foreign-storage': 'invalid-response' } as Record<string, string>)[mode] ?? mode)
    expect(requests).toEqual(['ready', 'draining', 'changed', 'invalid'].includes(mode) || runtimes[mode] ? ['/v1/capabilities', '/v1/health'] : ['/v1/capabilities'])
    expect(r.out + r.err).not.toMatch(/PRIVATE_|private-secret|ffffffffffffffff/)
  })

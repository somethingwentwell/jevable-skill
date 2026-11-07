import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, chmod, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readCliRateCoordinator } from '../src/http/cli-rate-coordinator.ts'
import { PostgresHttpRateCoordinatorError } from '../src/http/postgres-rate-config.ts'
import { serveFromCli } from '../src/http/cli-service.ts'
import * as processes from '../src/http/process.ts'
import * as sqlite from '../src/http/service.ts'
import * as postgres from '../src/http/postgres.ts'
import { RuntimeClient } from '../src/http/client.ts'
import { main } from '../src/cli.ts'
import { WorkflowRuntimeError } from '../src/runtime/errors.ts'

const fake = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('../src/http/postgres-rate-limits.ts', async () => ({ PostgresHttpRateCoordinator: { open: fake.open },
  PostgresHttpRateCoordinatorError: (await import('../src/http/postgres-rate-config.ts')).PostgresHttpRateCoordinatorError }))
const token = 'd'.repeat(64), bucket = { capacity: 2, refillTokens: 1, refillIntervalMs: 1000 }
function config() { return { connection: { host: '127.0.0.1', port: 54321, database: 'fixture', user: 'fixture',
  password: 'PRIVATE_COORDINATOR_PASSWORD', tls: { mode: 'loopback-test' } }, scope: String(randomUUID()),
  policy: { requests: bucket, controls: { ...bucket, capacity: 3 } }, initialize: false,
  timeoutMs: 1000, statementTimeoutMs: 500, maxPendingDebits: 4 } }
async function file(value: unknown = config()) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-cli-coordinator-')), path = join(directory, 'coordinator.json')
  await writeFile(path, JSON.stringify(value), { mode: 0o600 }); return { directory, path }
}
function backend(value = config()) {
  const close = vi.fn(async () => {}), consume = vi.fn(async (request: any) => ({ requestId: request.requestId,
    scope: request.scope, policySha256: request.policySha256, lane: request.lane, admitted: true as const }))
  const owner = { close, admission: () => ({ scope: value.scope, policy: structuredClone(value.policy), timeoutMs: value.timeoutMs, consume }) }
  fake.open.mockResolvedValue(owner); return { owner, close, consume }
}
beforeEach(() => { fake.open.mockReset() })
afterEach(() => vi.restoreAllMocks())

describe('protected CLI coordinator input without driver I/O', () => {
  it('does nothing when omitted, and captures an explicit normalized attach configuration', async () => {
    expect(await readCliRateCoordinator({})).toBeUndefined()
    const value = config(); value.scope = value.scope.toUpperCase(); const { path } = await file(value)
    const parsed = await readCliRateCoordinator({ 'rate-coordinator-file': path })
    expect(parsed).toEqual({ ...value, scope: value.scope.toLowerCase() }); expect(fake.open).not.toHaveBeenCalled()
  })
  it.each([true, '', 'absent-private-file'])('refuses an invalid file selection without connecting (%#)', async path => {
    await expect(readCliRateCoordinator({ 'rate-coordinator-file': path })).rejects.toHaveProperty('code', 'invalid-command')
    expect(fake.open).not.toHaveBeenCalled()
  })
  it.each([{ ...config(), initialize: true }, { ...config(), initialize: undefined }, { ...config(), extra: 'PRIVATE' },
    { ...config(), scope: 'invalid' }, { ...config(), timeoutMs: 99 }, { ...config(), statementTimeoutMs: 5001 },
    { ...config(), timeoutMs: 100, statementTimeoutMs: 101 }, { ...config(), maxPendingDebits: 65 },
    { ...config(), connection: { ...config().connection, host: 'remote.invalid' } },
    { ...config(), connection: { ...config().connection, tls: { mode: 'verify-full', ca: 'PRIVATE_BAD_CA' } } },
  ])('refuses operator bootstrap or invalid options before connection/ownership (%#)', async value => {
    const { directory, path } = await file(value)
    await expect(serveFromCli({ 'data-dir': join(directory, 'never-created'), 'rate-coordinator-file': path }, token, () => {})).rejects.toHaveProperty('code', 'invalid-command')
    expect(fake.open).not.toHaveBeenCalled(); expect(await readdir(directory)).not.toContain('never-created')
  })
  it('refuses both quota modes before reading either path', async () => {
    await expect(readCliRateCoordinator({ 'rate-coordinator-file': 'not-read', 'rate-limits-file': 'not-read' })).rejects.toHaveProperty('code', 'invalid-command')
    expect(fake.open).not.toHaveBeenCalled()
  })
  it('refuses malformed/oversized JSON and nonregular files without exposing payloads', async () => {
    const { directory, path } = await file()
    for (const text of ['PRIVATE_NOT_JSON', ' '.repeat(65537)]) {
      await writeFile(path, text); await expect(readCliRateCoordinator({ 'rate-coordinator-file': path })).rejects.toMatchObject({ code: 'invalid-command', message: new WorkflowRuntimeError('invalid-command').message })
    }
    await expect(readCliRateCoordinator({ 'rate-coordinator-file': directory })).rejects.toHaveProperty('code', 'invalid-command')
    expect(fake.open).not.toHaveBeenCalled()
  })
  it.skipIf(process.platform === 'win32')('refuses public-readable and symlinked secret configuration', async () => {
    const { directory, path } = await file(); await chmod(path, 0o644)
    await expect(readCliRateCoordinator({ 'rate-coordinator-file': path })).rejects.toHaveProperty('code', 'invalid-command')
    await chmod(path, 0o600); const link = join(directory, 'link'); await symlink(path, link)
    await expect(readCliRateCoordinator({ 'rate-coordinator-file': link })).rejects.toHaveProperty('code', 'invalid-command')
    expect(fake.open).not.toHaveBeenCalled()
  })
})

describe('local CLI service owns attachment and closes it after its HTTP lifetime (backend double)', () => {
  it('forwards pinned shared admission to a real SQLite HTTP service and closes only after HTTP drain', async () => {
    const value = config(), { directory, path } = await file(value), fixture = backend(value)
    vi.spyOn(processes, 'runServiceProcess').mockImplementation(async begin => {
      const service = await begin(); expect(fixture.close).not.toHaveBeenCalled()
      try {
        const client = new RuntimeClient(service.url, token), caps: any = await client.capabilities()
        expect(caps.api.rateLimits.coordinator.scope).toBe(value.scope)
        expect(fixture.consume).not.toHaveBeenCalled(); await client.health(); expect(fixture.consume).toHaveBeenCalledTimes(1)
      } finally { await service.close(); await service.closed }
      expect(fixture.close).not.toHaveBeenCalled(); return 0
    })
    expect(await serveFromCli({ 'data-dir': join(directory, 'state'), 'rate-coordinator-file': path }, token, () => {})).toBe(0)
    expect(fake.open).toHaveBeenCalledWith(value); expect(fixture.close).toHaveBeenCalledTimes(1)
  })
  it('closes an attached coordinator if workflow owner startup fails', async () => {
    const { directory, path } = await file(), fixture = backend()
    vi.spyOn(processes, 'runServiceProcess').mockImplementation(async begin => { await begin(); return 0 })
    vi.spyOn(sqlite, 'startRuntimeService').mockRejectedValue(Error('owned-storage-startup-failure'))
    await expect(serveFromCli({ 'data-dir': join(directory, 'state'), 'rate-coordinator-file': path }, token, () => {})).rejects.toThrow('owned-storage-startup-failure')
    expect(fixture.close).toHaveBeenCalledTimes(1)
  })
  it('retains backend failure codes but never driver text, and acquires no workflow owner', async () => {
    const { directory, path } = await file(); fake.open.mockRejectedValue(Error('PRIVATE_ENDPOINT_PASSWORD'))
    vi.spyOn(processes, 'runServiceProcess').mockImplementation(async begin => { await begin(); return 0 })
    const start = vi.spyOn(sqlite, 'startRuntimeService')
    await expect(serveFromCli({ 'data-dir': join(directory, 'state'), 'rate-coordinator-file': path }, token, () => {})).rejects.toMatchObject({ code: 'unavailable' })
    expect(start).not.toHaveBeenCalled(); expect(await readdir(directory)).not.toContain('state')
    const known = new PostgresHttpRateCoordinatorError('policy-conflict')
    fake.open.mockRejectedValue(known)
    const refusal = await serveFromCli({ 'data-dir': join(directory, 'state'), 'rate-coordinator-file': path }, token, () => {}).then(() => undefined, error => error)
    expect(refusal).toHaveProperty('code', 'policy-conflict')
    expect(refusal.message).toContain('startup failed: policy-conflict')
    expect(refusal.message).not.toContain('PRIVATE_ENDPOINT_PASSWORD')
  })
  it('forwards quota settings separately from PostgreSQL workflow namespace configuration', async () => {
    const { directory, path } = await file(), fixture = backend(), database = join(directory, 'database.json')
    const databaseOptions = { ...config().connection, namespace: 'explicit_workflow', initialize: false }
    await writeFile(database, JSON.stringify(databaseOptions), { mode: 0o600 })
    vi.spyOn(processes, 'runServiceProcess').mockImplementation(async begin => { await begin(); return 0 })
    const start = vi.spyOn(postgres, 'startPostgresRuntimeService').mockImplementation(async options => {
      expect(options.runtime.database).toEqual(databaseOptions)
      expect(options.coordinatedRateLimits).toMatchObject({ consume: expect.any(Function), scope: expect.any(String) })
      expect(options).not.toHaveProperty('rateLimits'); return {} as never
    })
    expect(await serveFromCli({ storage: 'postgres', 'database-file': database, 'rate-coordinator-file': path }, token, () => {})).toBe(0)
    expect(start).toHaveBeenCalledTimes(1); expect(fixture.close).toHaveBeenCalledTimes(1)
  })
  it('closes the coordinator if the service lifetime or output sink throws', async () => {
    const { directory, path } = await file(), fixture = backend()
    vi.spyOn(processes, 'runServiceProcess').mockImplementation(async begin => {
      const service = await begin(); try { throw Error('output-sink-failure') } finally { await service.close(); await service.closed }
    })
    await expect(serveFromCli({ 'data-dir': join(directory, 'state'), 'rate-coordinator-file': path }, token, () => {})).rejects.toThrow('output-sink-failure')
    expect(fixture.close).toHaveBeenCalledTimes(1)
  })
})

describe('I/O-free flag discovery and profile isolation', () => {
  const invoke = async (args: string[]) => { let out = '', err = ''; const code = await main([...args, '--json'], { out: s => { out += s }, err: s => { err += s } }); return { code, out, err } }
  it.each(['serve', 'start'])('advertises the %s attach flag and its quota-mode exclusion for each supported profile', async action => {
    const result = await invoke(['runtime', action, '--help']); expect(result.code).toBe(0)
    const help = JSON.parse(result.out); expect(help.variants[0].options['rate-coordinator-file']).toBe('string')
    expect(help.notes.join(' ')).toContain('initialize:false')
    if (action === 'start') expect(help.variants[1].options['rate-coordinator-file']).toBe('string')
    expect(fake.open).not.toHaveBeenCalled()
  })
  it.each(['serve', 'start'])('refuses mixed quota mode before credentials for %s', async action => {
    expect((await invoke(['runtime', action, '--token-file', 'not-read', '--rate-limits-file', 'not-read', '--rate-coordinator-file', 'not-read'])).code).toBe(2)
    expect(fake.open).not.toHaveBeenCalled()
  })
  it.each([['run', 'not-read'], ['preview', 'not-read'],
    ['runtime', 'inspect', '--runtime', 'docker'], ['runtime', 'restart', '--runtime', 'docker'], ['runtime', 'stop', '--runtime', 'docker'],
    ['runtime', 'request', 'not-read'], ['runtime', 'status']].map(args => [args]))('refuses the option outside supported startup (%#)', async args => {
    expect((await invoke([...args, '--rate-coordinator-file', 'not-read'])).code).toBe(2); expect(fake.open).not.toHaveBeenCalled()
  })
})

import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runReleaseApp, type ReleaseBackend } from '../src/releases/app.ts'
import { inspectRelease } from '../src/releases/snapshot.ts'
import { compileWorkflowYaml } from '../src/workflow/index.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { createReleaseFiles } from '../src/packages/release-zip.ts'
import { parseTelemetryConfig } from '../src/telemetry/config.ts'
const { parseReleaseTelemetryExamples, parseReleaseCommandReference, releaseGuideInvocation } = await import(new URL('../scripts/release-guide-contract.mjs', import.meta.url).href)

afterEach(() => vi.restoreAllMocks())
const compiled = compileWorkflowYaml(await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8'), DEFAULT_COMPILER_LIMITS)
const bytes = Buffer.from('fixture runtime'), sha256 = createHash('sha256').update(bytes).digest('hex')
const release = inspectRelease({ format: 'jevable.ai/release', schemaVersion: 1, id: randomUUID(), version: '1.0.0',
  createdAt: new Date().toISOString(), createdBy: 'fixture', project: { id: randomUUID(), generation: 1 },
  workflow: { yaml: compiled.source.yaml, revision: compiled.source.revision }, runtime: { version: CORE_VERSION, sha256 } })
function fixture(storage: 'sqlite' | 'postgres') {
  let out = '', err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation(acknowledgeCliWrite(value => { out += value }))
  vi.spyOn(process.stderr, 'write').mockImplementation(acknowledgeCliWrite(value => { err += value }))
  const runtime = { close: vi.fn(async () => {}), connections: vi.fn(async () => [{ id: 'retained' }]) }
  const backend = { storage, open: vi.fn(async () => runtime), serve: vi.fn() } as unknown as ReleaseBackend
  return { backend, runtime, out: () => out, err: () => err }
}
it.each(['sqlite', 'postgres'] as const)('reports the fixed %s backend without opening storage', async storage => {
  const f = fixture(storage)
  expect(await runReleaseApp(f.backend, release.snapshot, ['info'], '/unused')).toBe(0)
  expect(JSON.parse(f.out())).toMatchObject({ storage, dockerRequired: false, authoringApi: false })
  expect(f.backend.open).not.toHaveBeenCalled()
})
it.each(['sqlite', 'postgres'] as const)('prepares an owner-only %s reviewer token without opening storage or printing it', async storage => {
  const f = fixture(storage), directory = await mkdtemp(join(tmpdir(), 'jevable-release-reviewer-token-'))
  const id = randomUUID(), path = join(directory, 'reviewer-token')
  expect(await runReleaseApp(f.backend, release.snapshot, ['reviewer-token', '--id', id, '--output', path], directory)).toBe(0)
  const receipt = JSON.parse(f.out()), saved = (await readFile(path, 'utf8')).trim()
  expect(receipt).toMatchObject({ status: 'prepared-not-issued', id, secret: 'not-displayed', permissions: 'owner-only' })
  expect(saved).toMatch(/^jvg1\.[a-f0-9-]{36}\.[a-f0-9]{64}$/u)
  expect(f.out()).not.toContain(saved)
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect(f.backend.open).not.toHaveBeenCalled()
  expect(await runReleaseApp(f.backend, release.snapshot, ['reviewer-token', '--id', id, '--output', path], directory)).toBe(1)
})
it.each(['sqlite', 'postgres'] as const)('refuses invalid %s notification files before acquiring storage or serving', async storage => {
  const f = fixture(storage), directory = await mkdtemp(join(tmpdir(), 'jevable-notification-admission-'))
  const file = join(directory, 'command.json')
  for (const value of [null, [], { operation: 'runs.start', id: randomUUID(), input: {} },
    { operation: 'notifications.list' }, { operation: 'notifications.list', page: {}, actor: 'spoof' },
    { operation: 'notifications.list', page: {}, releaseSha256: release.sha256 },
    { operation: 'notifications.show', requestId: 'not-a-uuid' },
    { operation: 'notifications.send', request: {} },
    { operation: 'notifications.destinations', invented: true }]) {
    await writeFile(file, JSON.stringify(value))
    const before = f.err().length
    expect(await runReleaseApp(f.backend, release.snapshot, ['notify', file], directory)).toBe(2)
    expect(JSON.parse(f.err().slice(before))).toMatchObject({ status: 'error', code: 'invalid-command' })
  }
  await writeFile(file, '{invalid JSON')
  expect(await runReleaseApp(f.backend, release.snapshot, ['notify', file], directory)).toBe(2)
  expect(await runReleaseApp(f.backend, release.snapshot, ['notify', join(directory, 'missing.json')], directory)).toBe(2)
  expect(f.backend.open).not.toHaveBeenCalled(); expect(f.backend.serve).not.toHaveBeenCalled()
  expect(f.runtime.close).not.toHaveBeenCalled(); expect(f.out()).toBe('')
})
it.each([['postgres', '--data-dir'], ['sqlite', '--database-file']] as const)('refuses mixed profile %s / %s before storage', async (storage, flag) => {
  const f = fixture(storage)
  expect(await runReleaseApp(f.backend, release.snapshot, ['check', flag, '/unused'], '/unused')).toBe(2)
  expect(f.backend.open).not.toHaveBeenCalled()
  expect(JSON.parse(f.err()).code).toBe('invalid-command')
})
it('awaits asynchronous provider reads and closes the exact owner', async () => {
  const f = fixture('postgres')
  expect(await runReleaseApp(f.backend, release.snapshot, ['providers-list', '--database-file', '/private/config'], '/unused')).toBe(0)
  expect(JSON.parse(f.out())).toEqual({ connections: [{ id: 'retained' }] })
  expect(f.runtime.close).toHaveBeenCalledOnce()
})
it.each(['sqlite', 'postgres'] as const)('retains a %s app startup signal and closes without dispatching a direct job', async storage => {
  const f = fixture(storage), before = process.listeners('SIGTERM')
  vi.mocked(f.backend.open).mockImplementation(async () => {
    process.listeners('SIGTERM').find(listener => !before.includes(listener))!('SIGTERM')
    return f.runtime as unknown as Awaited<ReturnType<ReleaseBackend['open']>>
  })
  const flags = storage === 'postgres' ? ['--database-file', '/private/config'] : []
  expect(await runReleaseApp(f.backend, release.snapshot, ['providers-list', ...flags], '/unused')).toBe(143)
  expect(f.runtime.connections).not.toHaveBeenCalled(); expect(f.runtime.close).toHaveBeenCalledOnce()
  expect(f.out()).toBe(''); expect(JSON.parse(f.err())).toMatchObject({ status: 'draining', signal: 'SIGTERM', execution: 'not-cancelled' })
  expect(process.listeners('SIGTERM')).toEqual(before)
})
it.each(['SIGINT', 'SIGTERM'] as const)('drains an admitted app job through %s and ignores repeated signals until close finishes', async signal => {
  const f = fixture('sqlite'), beforeInt = process.listeners('SIGINT'), beforeTerm = process.listeners('SIGTERM')
  const signalJob = () => process.listeners(signal).find(listener => !(signal === 'SIGINT' ? beforeInt : beforeTerm).includes(listener))!(signal)
  f.runtime.connections.mockImplementation(async () => {
    signalJob(); expect(f.runtime.close).not.toHaveBeenCalled()
    return [{ id: 'retained' }]
  })
  f.runtime.close.mockImplementation(async () => { signalJob() })
  expect(await runReleaseApp(f.backend, release.snapshot, ['providers-list'], '/unused')).toBe(signal === 'SIGINT' ? 130 : 143)
  expect(JSON.parse(f.out())).toEqual({ connections: [{ id: 'retained' }] })
  expect(f.err().trim().split('\n')).toHaveLength(1)
  expect(f.runtime.connections).toHaveBeenCalledOnce(); expect(f.runtime.close).toHaveBeenCalledOnce()
  expect(process.listeners('SIGINT')).toEqual(beforeInt); expect(process.listeners('SIGTERM')).toEqual(beforeTerm)
})
it('app owner startup failure removes only its handlers and does not perform a job or invent cleanup', async () => {
  const f = fixture('sqlite'), before = process.listeners('SIGTERM')
  vi.mocked(f.backend.open).mockRejectedValue(Error('PRIVATE_STARTUP_DETAIL'))
  expect(await runReleaseApp(f.backend, release.snapshot, ['providers-list'], '/unused')).toBe(1)
  expect(f.err()).not.toContain('PRIVATE_STARTUP_DETAIL'); expect(f.runtime.close).not.toHaveBeenCalled()
  expect(process.listeners('SIGTERM')).toEqual(before)
})
it.each(['sqlite', 'postgres'] as const)('refuses invalid %s app usage windows before acquiring storage', async storage => {
  const f = fixture(storage)
  for (const flags of [['--from', '2020-01-01T00:00:00.000Z'], ['--before', '2020-01-02T00:00:00.000Z'],
    ['--from', '2020-01-02T00:00:00.000Z', '--before', '2020-01-01T00:00:00.000Z'],
    ['--from', 'bad', '--before', '2020-01-02T00:00:00.000Z']]) {
    expect(await runReleaseApp(f.backend, release.snapshot, ['usage', randomUUID(), ...flags], '/unused')).toBe(2)
  }
  expect(f.backend.open).not.toHaveBeenCalled()
})
it.each(['sqlite', 'postgres'] as const)('refuses invalid %s app usage grouping before acquiring storage', async storage => {
  const f = fixture(storage)
  expect(await runReleaseApp(f.backend, release.snapshot, ['usage', randomUUID(), '--group-by', 'model'], '/unused')).toBe(2)
  expect(f.backend.open).not.toHaveBeenCalled()
})
it.each(['sqlite', 'postgres'] as const)('exports %s-specific instructions and mounts without any database credential material', storage => {
  const files = createReleaseFiles(release, { storage, bytes, notices: Buffer.from('Fixture notice'), identity: release.snapshot.runtime })
  expect(JSON.parse(Buffer.from(files['manifest.json']!).toString()).storage).toBe(storage)
  expect(JSON.parse(Buffer.from(files['configuration.json']!).toString()).storage).toBe(storage)
  const compose = Buffer.from(files['compose.yaml']!).toString()
  expect(compose.includes('--database-file')).toBe(storage === 'postgres')
  expect(compose.includes('--data-dir')).toBe(storage === 'sqlite')
  expect(Object.keys(files)).not.toContain('database.json')
  expect(() => createReleaseFiles(release, { storage, bytes: Buffer.from('replacement'), notices: Buffer.alloc(0), identity: release.snapshot.runtime })).toThrow('conflict')
})

it.each(['sqlite', 'postgres'] as const)('exports complete %s telemetry examples admitted by the real runtime policy and covered by manifest integrity', storage => {
  const files = createReleaseFiles(release, { storage, bytes, notices: Buffer.from('Fixture notice'), identity: release.snapshot.runtime })
  const guide = Buffer.from(files['README.txt']!), examples = parseReleaseTelemetryExamples(guide.toString('utf8'))
  const manifest = JSON.parse(Buffer.from(files['manifest.json']!).toString())
  expect(manifest.files.find((file: { path: string }) => file.path === 'README.txt')).toMatchObject({
    bytes: guide.byteLength, sha256: createHash('sha256').update(guide).digest('hex'),
  })
  for (const protocol of ['http/protobuf', 'grpc'] as const) {
    const policy = parseTelemetryConfig(examples[protocol])
    expect(policy.protocol).toBe(protocol)
    expect(policy.authentication).toEqual({ kind: 'none' })
    for (const url of [policy.endpoint, policy.metricsEndpoint, policy.logsEndpoint]) {
      expect(new URL(url!).protocol).toBe('https:')
      expect(new URL(url!).pathname).toBe(protocol === 'grpc' ? '/' : '/v1/' + (url === policy.endpoint ? 'traces' : url === policy.metricsEndpoint ? 'metrics' : 'logs'))
    }
    expect(() => parseTelemetryConfig({ ...examples[protocol], endpoint: 'http://remote.invalid' })).toThrow('invalid-command')
    if (protocol === 'grpc') expect(() => parseTelemetryConfig({ ...examples[protocol], endpoint: 'https://collector.example/v1/traces' })).toThrow('invalid-command')
  }
})

it.each(['sqlite', 'postgres'] as const)('ships a complete %s command inventory matching the actual app and its storage boundary', async storage => {
  const files = createReleaseFiles(release, { storage, bytes, notices: Buffer.from('Fixture notice'), identity: release.snapshot.runtime })
  const guide = Buffer.from(files['README.txt']!).toString(), commands = parseReleaseCommandReference(guide)
  const f = fixture(storage)
  expect(await runReleaseApp(f.backend, release.snapshot, releaseGuideInvocation(guide, 'info'), '/unused')).toBe(0)
  expect(Object.keys(commands)).toEqual(JSON.parse(f.out()).commands)
  for (const [command, spec] of Object.entries(commands) as [string, { positional?: string; flags: {name: string; required: boolean}[] }][]) {
    const stateful = !['info', 'token', 'reviewer-token', 'status', 'request', 'submit', 'observe', 'event-id', 'event-inbox'].includes(command)
    expect(spec.flags.find(flag => flag.name === 'database-file')).toEqual(stateful && storage === 'postgres' ? { name: 'database-file', type: 'string', required: true } : undefined)
    expect(spec.flags.some(flag => flag.name === 'data-dir')).toBe(stateful && storage === 'sqlite')
    expect(spec.flags.some(flag => flag.name === 'telemetry-file')).toBe(stateful)
    if (command === 'submit' || command === 'observe') {
      for (const name of ['endpoint', 'token-file', 'instance-id'])
        expect(spec.flags.find(flag => flag.name === name)).toEqual({ name, type: 'string', required: true })
      expect(spec.flags.some(flag => flag.name === 'release-pin-file')).toBe(false)
    }
    const before = f.err().length
    expect(await runReleaseApp(f.backend, release.snapshot, [command, '--invented-flag'], '/unused')).toBe(2)
    expect(JSON.parse(f.err().slice(before)).code).toBe('invalid-command')
  }
  expect(f.backend.open).not.toHaveBeenCalled()
  const values = { 'run-uuid': 'retained-run', 'request-id': 'retained-recovery', 'checkpoint-sha256': 'reviewed-hash',
    ...(storage === 'postgres' ? { 'database-file': '/private/database.json' } : { 'data-dir': '/private/state' }) }
  expect(releaseGuideInvocation(guide, 'recover', values)).toEqual(['recover', 'retained-run', '--request-id', 'retained-recovery', '--checkpoint-sha256', 'reviewed-hash', storage === 'postgres' ? '--database-file' : '--data-dir', storage === 'postgres' ? '/private/database.json' : '/private/state'])
  expect(() => releaseGuideInvocation(guide, 'recover', { ...values, 'breakpoints-file': '/wrong' })).toThrow()
  expect(() => releaseGuideInvocation(guide, 'recover', { 'run-uuid': 'retained-run' })).toThrow()
  expect(() => parseReleaseCommandReference(guide.replaceAll('node app.mjs recover ', 'node app.mjs recover ;unsafe '))).toThrow()
})
import { acknowledgeCliWrite } from './helpers/cli-write.ts'

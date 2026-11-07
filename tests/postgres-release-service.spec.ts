import { afterEach, expect, it, vi } from 'vitest'
import { readFile, mkdtemp } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileWorkflowYaml } from '../src/workflow/index.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { CORE_VERSION, capabilities } from '../src/capabilities.ts'
import { inspectRelease } from '../src/releases/snapshot.ts'
import { ReleaseSession } from '../src/releases/service-session.ts'
import { PostgresRuntime } from '../src/runtime/postgres.ts'
import { startPostgresRuntimeService, type PostgresRuntimeServiceOptions } from '../src/http/postgres.ts'
import { main } from '../src/cli.ts'
import { writeArtifact } from '../src/files.ts'

afterEach(() => vi.restoreAllMocks())
const source = compileWorkflowYaml(await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8'), DEFAULT_COMPILER_LIMITS).source
function release() { return inspectRelease({ format: 'jevable.ai/release', schemaVersion: 1, id: randomUUID(), version: '1.0.0',
  createdAt: new Date().toISOString(), createdBy: 'fixture:author', project: { id: randomUUID(), generation: 1 },
  workflow: { yaml: source.yaml, revision: source.revision }, runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } }) }
function fixture() {
  const artifact = release(), runtime = { listRelease: vi.fn(async () => ({ runs: [], nextCursor: null })), show: vi.fn(), events: vi.fn() }
  const session = new ReleaseSession({ storage: 'postgres', runtime } as unknown as ConstructorParameters<typeof ReleaseSession>[0], artifact.snapshot, 'fixture:owner')
  return { artifact, runtime, session, operation: (command: object) => session.operation({ ...command, releaseSha256: artifact.sha256 }) }
}
it.each(['sqlite', 'postgres'] as const)('discovers detached %s release work metrics without authoring, state access or telemetry management authority', async storage => {
  const artifact = release(), runtime = new Proxy({}, { get() { throw Error('Discovery must not access runtime state') } })
  const session = new ReleaseSession({ storage, runtime } as unknown as ConstructorParameters<typeof ReleaseSession>[0], artifact.snapshot, 'fixture:owner')
  const first = session.capabilities(), baseline = capabilities().workflowRuntime.runtimeWorkTelemetry
  expect(first.runtimeWorkTelemetry).toEqual(baseline)
  const capacityBaseline = capabilities().workflowRuntime.httpAsyncCapacityTelemetry
  expect(first.httpAsyncCapacityTelemetry).toEqual(capacityBaseline)
  expect(first).toMatchObject({ dependencies: { desktop: false, harness: false, skill: false }, authoring: false, providerConfiguration: false })
  first.runtimeWorkTelemetry.instruments[0]!.name = 'forged'; first.runtimeWorkTelemetry.requires.push('forged')
  expect(session.capabilities().runtimeWorkTelemetry).toEqual(baseline)
  expect(capabilities().workflowRuntime.runtimeWorkTelemetry).toEqual(baseline)
  first.httpAsyncCapacityTelemetry.instrument.name = 'forged'
  first.httpAsyncCapacityTelemetry.pointLabels['jevable.http.async.phase'].push('forged')
  first.httpAsyncCapacityTelemetry.requires.push('forged')
  expect(session.capabilities().httpAsyncCapacityTelemetry).toEqual(capacityBaseline)
  expect(capabilities().workflowRuntime.httpAsyncCapacityTelemetry).toEqual(capacityBaseline)
  for (const operation of ['telemetry.status', 'telemetry.flush', 'telemetry.configure']) {
    expect(first.operations).not.toContain(operation)
    await expect(session.operation({ operation, releaseSha256: artifact.sha256 })).rejects.toMatchObject({ code: 'invalid-command' })
  }
})
it('requires an explicit PostgreSQL page and passes only the exact release pin to the scoped SDK reader', async () => {
  const f = fixture()
  await expect(f.operation({ operation: 'runs.list' })).rejects.toMatchObject({ code: 'invalid-command' })
  expect(f.runtime.listRelease).not.toHaveBeenCalled()
  expect(await f.operation({ operation: 'runs.list', page: {} })).toMatchObject({ schemaVersion: 2, runs: [], nextCursor: null })
  expect(f.runtime.listRelease).toHaveBeenCalledWith({ id: f.artifact.snapshot.id, sha256: f.artifact.sha256, revision: source.revision }, undefined, 100)
  expect(f.session.capabilities()).toMatchObject({ storage: 'single-owner-postgres', evidence: { schemaVersion: 2 }, authoring: false, pagination: { required: true } })
})
it('keeps the cloned pin after caller mutation and refuses source/configuration substitution before backend calls', async () => {
  const f = fixture(), id = f.artifact.snapshot.id
  f.artifact.snapshot.id = randomUUID()
  expect(await f.operation({ operation: 'release.info' })).toMatchObject({ release: { id } })
  for (const command of [{ operation: 'projects.list' }, { operation: 'credentials.set', ref: 'x', value: 'PRIVATE' },
    { operation: 'runs.start', id: randomUUID(), input: null, yaml: source.yaml }, { operation: 'runs.list', page: { limit: 201 } }]) {
    await expect(f.operation(command)).rejects.toMatchObject({ code: 'invalid-command' })
  }
  await expect(f.session.operation({ operation: 'runs.list', page: {}, releaseSha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'conflict' })
  expect(f.runtime.listRelease).not.toHaveBeenCalled(); expect(f.runtime.show).not.toHaveBeenCalled()
})
it('refuses foreign runs and projects only exact decimal journal metadata', async () => {
  const f = fixture(), id = randomUUID()
  f.runtime.show.mockResolvedValue({ id, revision: source.revision, release: { id: randomUUID(), sha256: f.artifact.sha256 } })
  await expect(f.operation({ operation: 'runs.events', id })).rejects.toMatchObject({ code: 'not-found' })
  expect(f.runtime.events).not.toHaveBeenCalled()
  f.runtime.show.mockResolvedValue({ id, revision: source.revision, release: { id: f.artifact.snapshot.id, sha256: f.artifact.sha256 } })
  f.runtime.events.mockResolvedValue([{ sequence: '9007199254740993', version: '1', kind: 'created', at: 'fixture-time', data: 'PRIVATE' }])
  expect(await f.operation({ operation: 'runs.events', id })).toMatchObject({ schemaVersion: 2, sequenceEncoding: 'decimal-int64',
    events: [{ sequence: '9007199254740993', version: '1', kind: 'created', at: 'fixture-time' }] })
  expect(JSON.stringify(await f.operation({ operation: 'runs.events', id }))).not.toContain('PRIVATE')
})
it.each([null, [], {}, { snapshot: {} }, { snapshot: release().snapshot, extra: true }])('refuses malformed release admission before opening storage: %j', async value => {
  const open = vi.spyOn(PostgresRuntime, 'open')
  await expect(startPostgresRuntimeService({ runtime: {}, token: 'a'.repeat(64), actor: 'fixture', release: value } as unknown as PostgresRuntimeServiceOptions)).rejects.toMatchObject({ code: 'invalid-command' })
  expect(open).not.toHaveBeenCalled()
})
it('requires a reviewed CLI snapshot hash and refuses mismatch before database ownership', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jevable-release-cli-')), token = join(dir, 'token'), path = join(dir, 'snapshot.json'), artifact = release()
  await writeArtifact(token, 'a'.repeat(64)); await writeArtifact(path, JSON.stringify(artifact.snapshot))
  const open = vi.spyOn(PostgresRuntime, 'open')
  for (const [flags, expected] of [[['--release-file', path], 2], [['--release-sha256', artifact.sha256], 2],
    [['--release-file', path, '--release-sha256', '0'.repeat(64)], 1]] as const) {
    let out = '', err = ''
    expect(await main(['runtime', 'serve', '--token-file', token, '--storage', 'postgres', '--database-file', '/must-not-read', ...flags],
      { out: value => { out += value }, err: value => { err += value } })).toBe(expected)
    expect(out).toBe(''); expect(JSON.parse(err).code).toBe(expected === 2 ? 'invalid-input' : 'conflict')
  }
  expect(open).not.toHaveBeenCalled()
})

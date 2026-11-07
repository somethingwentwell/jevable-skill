import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { createTlsFixture, fixturePort } from '../scripts/tls-fixture.mjs'
import { startRuntimeService, RuntimeClient } from '../src/http/index.ts'
import { operationSelection, openCliOperations, importedOperationTests, operationRelease } from '../src/cli/operations.ts'
import { main } from '../src/cli.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { loadReleaseRuntime } from '../src/packages/release-zip.ts'
import { WorkflowRuntimeError } from '../src/runtime/errors.ts'

const mocks = vi.hoisted(() => ({ read: vi.fn(), inspect: vi.fn() }))
vi.mock('../src/docker/index.ts', async importOriginal => ({ ...await importOriginal<typeof import('../src/docker/index.ts')>(),
  readDockerOwner: mocks.read, inspectDockerOwner: mocks.inspect }))
// Byte fixtures validate transport/identity/packaging here, not executable app behavior.
// Real installed-package/container qualification uses the actual bundled runtimes.
vi.mock('../src/packages/release-zip.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/packages/release-zip.ts')>()
  const load = async (storage: 'sqlite' | 'postgres' = 'sqlite') => {
    const bytes = Buffer.from(`export const fixtureStorage=${JSON.stringify(storage)};`)
    return { bytes, storage, notices: Buffer.from('Unit-test runtime fixture'), identity: { version: CORE_VERSION, sha256: createHash('sha256').update(bytes).digest('hex') } }
  }
  return { ...actual, loadReleaseRuntime: load, loadReleaseRuntimeForIdentity: async (identity: { version: string; sha256: string }) => {
    for (const storage of ['sqlite', 'postgres'] as const) { const artifact = await load(storage); if (artifact.identity.version === identity.version && artifact.identity.sha256 === identity.sha256) return artifact }
    throw new WorkflowRuntimeError('conflict')
  } }
})
let tls: Awaited<ReturnType<typeof createTlsFixture>>
const token = '4'.repeat(64), containerId = '5'.repeat(64), ownerHash = '6'.repeat(64)
const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const cleanup: (() => Promise<unknown>)[] = []
beforeAll(async () => { tls = await createTlsFixture(await mkdtemp(join(tmpdir(), 'jevable-command-tls-'))) }, 20000)
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.clearAllMocks() })
async function cli(...args: string[]) {
  let output = '', error = ''
  const exit = await main(args, { out: text => { output += text }, err: text => { error += text } })
  return { exit, output: output ? JSON.parse(output) : undefined, error: error ? JSON.parse(error) : undefined }
}
async function fixture(storage: 'sqlite' | 'postgres' = 'sqlite') {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-command-')), port = await fixturePort(), tokenFile = join(directory, 'token')
  await writeFile(tokenFile, token, { mode: 0o600 })
  const service = await startRuntimeService({ runtime: { dataDirectory: join(directory, 'state') }, token, actor: 'fixture:remote-owner', port,
    tls: { publicOrigin: `https://127.0.0.1:${port}`, bindAddress: '127.0.0.1', certificateFile: tls.cert, privateKeyFile: tls.key } })
  cleanup.push(async () => { await service.close(); await service.closed })
  const client = new RuntimeClient(service.url, token, 3000, 20_000_000, { ca: tls.ca })
  const operation = async (command: Parameters<RuntimeClient['operation']>[0]) => (await client.operation(command) as { result: any }).result
  mocks.read.mockResolvedValue({ fixture: 'owner', storage })
  mocks.inspect.mockResolvedValue({ containerId, status: 'running', resources: { endpoint: service.url }, service: { status: 'ready', instanceId: service.instanceId } })
  const flags = ['--runtime', 'docker', '--owner-file', join(directory, 'owner.json'), '--owner-sha256', ownerHash,
    '--container-id', containerId, '--token-file', tokenFile, '--ca-file', tls.cert]
  const values = Object.fromEntries(Array.from({ length: flags.length / 2 }, (_, i) => [flags[i * 2]!.slice(2), flags[i * 2 + 1]!]))
  const inputFile = join(directory, 'input.json'), sourceFile = join(directory, 'workflow.yaml')
  await writeFile(inputFile, JSON.stringify('Docker command fixture')); await writeFile(sourceFile, echo)
  return { directory, flags, values, operation, service, inputFile, sourceFile }
}
describe('shared direct and selected-owner CLI operations', () => {
  it('selects only the explicitly verified HTTPS owner for a disabled probe without configuring a receiver or local fallback', async () => {
    const f = await fixture(), result = await cli('telemetry', 'probe', ...f.flags)
    expect(result.exit).toBe(1); expect(result.output).toMatchObject({ status: 'disabled', signals: [], execution: 'not-run' })
  })
  it('reads activity from the explicitly selected verified HTTPS owner without opening fallback local state', async () => {
    const f = await fixture()
    expect((await cli('activity', 'report', ...f.flags)).output).toMatchObject({ storage: 'sqlite', runs: { total: 0 } })
    const started = await cli('run', f.sourceFile, '--input', f.inputFile, '--id', randomUUID(), ...f.flags)
    expect(started.exit).toBe(0)
    const report = await cli('activity', 'report', ...f.flags)
    expect(report.exit).toBe(0); expect(report.output.runs).toMatchObject({ total: 1, byStatus: { completed: 1 }, firstRetainedRun: { id: started.output.id } })
    expect(JSON.stringify(report.output)).not.toContain('Docker command fixture')
  })
  it.each([['runs', 'list'], ['tests', 'list'], ['tests', 'generations'], ['projects', 'deletions'], ['providers', 'audit'], ['releases', 'list']])('requires explicit pages for PostgreSQL-owner %s %s', async (command, action) => {
    const f = await fixture('postgres')
    const refused = await cli(command!, action!, ...f.flags)
    expect(refused.exit).toBe(2); expect(refused.error.message).toContain('--page')
    expect((await cli(command!, action!, '--page', ...f.flags)).exit).toBe(0)
  })
  it('defaults a selected PostgreSQL owner release to its backend while allowing an explicit SQLite release', async () => {
    // The HTTPS operation fixture accepts both bundles; this checks CLI selection, not real database execution.
    const f = await fixture('postgres'), project = (await cli('projects', 'create', f.sourceFile, '--title', 'PG owner default', ...f.flags)).output
    for (const explicit of [false, true]) {
      const result = await cli('releases', 'create', project.id, '--id', randomUUID(), '--expected-generation', '1', '--revision', project.acceptedRevision,
        '--version', explicit ? '2.0.0' : '1.0.0', ...(explicit ? ['--runtime-storage', 'sqlite'] : []), ...f.flags)
      expect(result.exit).toBe(0)
      expect(result.output.snapshot.runtime).toEqual((await loadReleaseRuntime(explicit ? 'sqlite' : 'postgres')).identity)
    }
  })
  it.each([
    { runtime: 'unexpected' }, { runtime: 'local', 'owner-file': 'unexpected' }, { runtime: 'local', 'token-file': 'unexpected' },
    { runtime: 'docker' }, { runtime: 'docker', 'data-dir': 'unexpected' }, { runtime: 'docker', storage: 'postgres' },
    { runtime: 'docker', endpoint: 'https://unexpected.invalid' },
  ])('rejects mixed or incomplete selection %j before side effects', values => {
    expect(() => operationSelection(values)).toThrow(); expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.inspect).not.toHaveBeenCalled()
  })
  it('local default and explicit local use the same command path without Docker inspection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-local-command-')), file = join(directory, 'echo.yaml'), input = join(directory, 'input.json')
    await writeFile(file, echo); await writeFile(input, '"local"')
    const result = await cli('run', file, '--input', input, '--data-dir', join(directory, 'state'))
    expect(result.exit).toBe(0)
    expect((await cli('runs', 'show', result.output.id, '--runtime', 'local', '--data-dir', join(directory, 'state'))).output).toEqual(result.output)
    expect(mocks.inspect).not.toHaveBeenCalled()
  })
  it('uses the selected HTTPS owner for readiness, run/retry, control and evidence without opening local state', async () => {
    const f = await fixture(), id = randomUUID()
    expect((await cli('check', f.sourceFile, ...f.flags)).exit).toBe(0)
    const started = await cli('run', f.sourceFile, '--input', f.inputFile, '--id', id, '--paused', ...f.flags)
    expect(started.exit).toBe(3); expect(started.output.status).toBe('paused')
    const continued = await cli('runs', 'continue', id, '--request-id', randomUUID(), '--checkpoint-sha256', started.output.checkpointSha256, ...f.flags)
    expect(continued.exit).toBe(0); expect(continued.output.output).toBe('Docker command fixture')
    expect((await cli('run', f.sourceFile, '--input', f.inputFile, '--id', id, '--paused', ...f.flags)).output).toEqual(continued.output)
    expect((await cli('runs', 'list', ...f.flags)).output.runs).toHaveLength(1)
    expect((await cli('runs', 'events', id, ...f.flags)).output.privatePayloads).toBe('excluded')
    const exported = await cli('runs', 'export', id, '--output', join(f.directory, 'evidence.json'), ...f.flags)
    expect(exported.exit).toBe(0)
    const bytes = await readFile(exported.output.artifact.path)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(exported.output.artifact.sha256)
    expect(bytes.toString()).not.toContain('Docker command fixture')
    // Closing a client must not close the service or release its storage ownership.
    expect((await f.operation({ operation: 'runs.show', id })).status).toBe('completed')
  })
  it('requires a retained run UUID before Docker submission and preserves cancellation semantics', async () => {
    const f = await fixture()
    expect((await cli('run', f.sourceFile, '--input', f.inputFile, ...f.flags)).exit).toBe(2)
    expect(mocks.inspect).not.toHaveBeenCalled()
    const id = randomUUID(), started = await cli('run', f.sourceFile, '--input', f.inputFile, '--id', id, '--paused', ...f.flags)
    expect(started.exit).toBe(3)
    expect((await cli('runs', 'cancel', id, '--request-id', randomUUID(), ...f.flags)).output.status).toBe('cancelled')
    expect((await cli('runs', 'resume', id, ...f.flags)).exit).toBe(1)
  })
  it('approval is explicit, server-attributed and retained independently of the CLI', async () => {
    const f = await fixture(), file = join(f.directory, 'approval.yaml'), id = randomUUID()
    await writeFile(file, approval); await writeFile(f.inputFile, JSON.stringify({ message: 'private approval' }))
    const waiting = await cli('run', file, '--input', f.inputFile, '--id', id, ...f.flags)
    expect(waiting.exit).toBe(3)
    expect((await cli('approvals', 'show', id, ...f.flags)).output.review).toBeTruthy()
    const approved = await cli('approvals', 'decide', id, '--attempt', waiting.output.attemptId, '--action', 'approve', ...f.flags)
    expect(approved.exit).toBe(0); expect(approved.output.output).toBe('approve')
    const privateRun = await f.operation({ operation: 'runs.inspect', id })
    expect(JSON.stringify(privateRun)).toContain('fixture:remote-owner')
  })
  it('saved case generation/review/execution, history, inspection and suite operations use the selected owner', async () => {
    const f = await fixture(), project = await f.operation({ operation: 'projects.command', command: { operation: 'create', title: 'Remote tests', yaml: echo } })
    const file = join(f.directory, 'test.json'), definition = { title: 'Remote test', project: { id: project.id, generation: project.generation, revision: project.acceptedRevision },
      input: 'expected', expectations: [{ kind: 'status', value: 'completed' }, { kind: 'output-equals', value: 'expected' }] }
    await writeFile(file, JSON.stringify(definition))
    const created = await cli('tests', 'create', file, ...f.flags); expect(created.exit).toBe(0)
    const test = created.output, accepted = await cli('tests', 'accept', test.id, '--expected-generation', '1', '--sha256', test.sha256, ...f.flags)
    expect(accepted.exit).toBe(0)
    const id = randomUUID(), run = await cli('tests', 'run', test.id, '--expected-generation', '2', '--sha256', test.sha256, '--id', id, ...f.flags)
    expect(run.exit).toBe(0); expect(run.output.assessment).toBe('passed')
    expect((await cli('tests', 'result', id, '--inspect', ...f.flags)).output.privateInspection).toBe(true)
    expect((await cli('tests', 'history', test.id, ...f.flags)).exit).toBe(0)
    expect((await cli('tests', 'list', '--page', '--limit', '1', ...f.flags)).output.tests).toHaveLength(1)
    const selectionFile = join(f.directory, 'selection.json'), suiteFile = join(f.directory, 'suite.json')
    await writeFile(selectionFile, JSON.stringify({ title: 'Owner suite', failurePolicy: 'stop', tests: [{ id: test.id, generation: 2, sha256: test.sha256 }] }))
    const suite = await cli('tests', 'suite', 'create', selectionFile, '--output', suiteFile)
    expect((await cli('tests', 'suite', 'run', suiteFile, '--suite-sha256', suite.output.sha256, ...f.flags)).output.status).toBe('passed')
    expect((await cli('tests', 'suite', 'result', suiteFile, ...f.flags)).output.status).toBe('passed')
    const generationId = randomUUID()
    expect((await cli('tests', 'generate', project.id, '--expected-generation', String(project.generation), '--revision', project.acceptedRevision,
      '--id', generationId, '--limit', '2', ...f.flags)).exit).toBe(0)
    expect((await cli('tests', 'generation', generationId, ...f.flags)).exit).toBe(0)
    expect((await cli('tests', 'generations', ...f.flags)).output.generations).toHaveLength(1)
  })
  it('authors, reviews, runs, exports and archives projects without bypassing the selected owner', async () => {
    const f = await fixture(), project = await cli('projects', 'create', f.sourceFile, '--title', 'Docker-authored project', ...f.flags)
    expect(project.exit).toBe(0)
    const id = project.output.id
    const proposed = await cli('projects', 'propose', id, '--file', f.sourceFile, '--expected-generation', '1', ...f.flags)
    expect(proposed.exit).toBe(0)
    const proposal = proposed.output.proposals[0]
    expect((await cli('projects', 'accept', id, '--expected-generation', '2', '--proposal-id', proposal.id, '--revision', proposal.revision, ...f.flags)).exit).toBe(0)
    const runId = randomUUID()
    const run = await cli('projects', 'run', id, '--expected-generation', '3', '--revision', proposal.revision, '--input', f.inputFile, '--id', runId, ...f.flags)
    expect(run.exit).toBe(0); expect(run.output.project).toMatchObject({ id, generation: 3 })
    const exported = await cli('projects', 'export', id, '--expected-generation', '3', '--revision', proposal.revision, '--format', 'zip', '--history', '--output', join(f.directory, 'project.zip'), ...f.flags)
    expect(exported.exit).toBe(0); expect(exported.output.runnableRelease).toBe(false)
    const duplicate = await cli('projects', 'duplicate', id, '--expected-generation', '3', '--revision', proposal.revision, '--title', 'Duplicate', ...f.flags)
    expect(duplicate.exit).toBe(0)
    expect((await cli('projects', 'archive', duplicate.output.id, '--expected-generation', '1', ...f.flags)).exit).toBe(0)
    expect((await cli('projects', 'delete', duplicate.output.id, '--expected-generation', '2', '--confirm-delete', duplicate.output.id, ...f.flags)).exit).toBe(0)
    expect((await cli('projects', 'deletions', ...f.flags)).output.deletions).toHaveLength(1)
    expect((await cli('projects', 'list', ...f.flags)).output.projects).toHaveLength(1)
  })
  it('provisions owner credentials through private file input and never echoes their value', async () => {
    const f = await fixture(), file = join(f.directory, 'secret')
    await writeFile(file, 'PRIVATE_PROVIDER_CREDENTIAL', { mode: 0o600 })
    const changed = await cli('credentials', 'set', 'fixture/key', '--file', file, '--expected-generation', '0', ...f.flags)
    expect(changed.exit).toBe(0); expect(JSON.stringify(changed)).not.toContain('PRIVATE_PROVIDER_CREDENTIAL')
    expect((await cli('credentials', 'status', 'fixture/key', ...f.flags)).exit).toBe(0)
    expect((await cli('providers', 'list', ...f.flags)).output.connections).toEqual([])
    expect((await cli('providers', 'audit', ...f.flags)).exit).toBe(0)
  })
  it('imports a reviewed project ZIP and test definitions as fresh drafts into the selected owner without executing', async () => {
    const f = await fixture(), project = (await cli('projects', 'create', f.sourceFile, '--title', 'Transfer source', ...f.flags)).output
    const test = await f.operation({ operation: 'tests.command', command: { operation: 'create', definition: { title: 'Transferred test',
      project: { id: project.id, generation: project.generation, revision: project.acceptedRevision }, input: 'private test input', expectations: [{ kind: 'status', value: 'completed' }] } } })
    await f.operation({ operation: 'tests.command', command: { operation: 'accept', id: test.id, expectedGeneration: 1, reviewedSha256: test.sha256 } })
    const file = join(f.directory, 'transfer.zip'), exported = await cli('projects', 'export', project.id, '--revision', project.acceptedRevision,
      '--expected-generation', '1', '--tests', '--history', '--format', 'zip', '--output', file, ...f.flags)
    expect(exported.exit).toBe(0)
    const review = await cli('import', 'inspect', file, ...f.flags)
    expect(review.exit).toBe(0); expect(review.output.artifactSha256).toBe(exported.output.artifact.sha256)
    expect((await f.operation({ operation: 'projects.list' })).projects).toHaveLength(1)
    const id = randomUUID(), imported = await cli('import', 'project', file, '--reviewed-sha256', review.output.artifactSha256, '--id', id, ...f.flags)
    expect(imported.exit).toBe(0); expect(imported.output.id).toBe(id)
    expect(imported.output.importedTests).toEqual([expect.objectContaining({ status: 'draft', generation: 1 })])
    expect(imported.output.importedTests[0].id).not.toBe(test.id)
    expect((await f.operation({ operation: 'runs.list' })).runs).toHaveLength(0)
    expect((await cli('import', 'project', file, '--reviewed-sha256', review.output.artifactSha256, '--id', id, ...f.flags)).exit).toBe(1)
    mocks.inspect.mockClear()
    expect((await cli('import', 'project', file, '--reviewed-sha256', '0'.repeat(64), '--id', randomUUID(), ...f.flags)).exit).toBe(1)
    expect(mocks.inspect).not.toHaveBeenCalled()
    expect((await cli('import', 'project', file, '--reviewed-sha256', review.output.artifactSha256, ...f.flags)).exit).toBe(2)
  })
  it.each(['sqlite', 'postgres'] as const)('creates and exports an immutable %s release with server-checked runtime identity', async storage => {
    const f = await fixture(), project = (await cli('projects', 'create', f.sourceFile, '--title', 'Release source', ...f.flags)).output
    const id = randomUUID(), args = ['releases', 'create', project.id, '--expected-generation', '1', '--revision', project.acceptedRevision,
      '--version', '1.0.0', '--id', id, '--runtime-storage', storage, ...f.flags]
    const created = await cli(...args)
    expect(created.exit).toBe(0); expect(created.output.snapshot.createdBy).toBe('fixture:remote-owner')
    expect(created.output.snapshot.runtime).toEqual((await loadReleaseRuntime(storage)).identity)
    expect((await cli('releases', 'show', id, ...f.flags)).output).toEqual(created.output)
    const metadata = (await cli('releases', 'list', '--page', '--limit', '1', ...f.flags)).output
    expect(metadata.releases).toHaveLength(1); expect(metadata.releases[0].workflow).toBeUndefined()
    expect((await cli(...args)).exit).toBe(1)
    expect((await cli('releases', 'create', project.id, '--expected-generation', '1', '--revision', project.acceptedRevision, '--version', '2.0.0', ...f.flags)).exit).toBe(2)
    const file = join(f.directory, 'release.zip'), exported = await cli('releases', 'export', id, '--release-sha256', created.output.sha256, '--format', 'zip', '--output', file, ...f.flags)
    expect(exported.exit).toBe(0); expect(exported.output.runtime).toEqual(created.output.snapshot.runtime)
    const before = await readFile(file)
    expect(createHash('sha256').update(before).digest('hex')).toBe(exported.output.artifact.sha256)
    expect((await cli('releases', 'export', id, '--release-sha256', '0'.repeat(64), '--format', 'zip', '--output', file, '--overwrite', ...f.flags)).exit).toBe(1)
    expect(await readFile(file)).toEqual(before)
    expect((await f.operation({ operation: 'runs.list' })).runs).toHaveLength(0)
    expect(() => operationRelease({ ...created.output, sha256: '0'.repeat(64) }, id)).toThrow()
  })
  it('refuses a mismatched release runtime or caller actor before persisting any snapshot', async () => {
    const f = await fixture(), project = (await cli('projects', 'create', f.sourceFile, '--title', 'Release guards', ...f.flags)).output
    const command = { operation: 'releases.create' as const, id: randomUUID(), projectId: project.id, expectedGeneration: 1,
      revision: project.acceptedRevision, version: '1.0.0', runtimeStorage: 'sqlite' as const, runtime: { version: CORE_VERSION, sha256: '0'.repeat(64) } }
    await expect(f.operation(command)).rejects.toMatchObject({ code: 'conflict' })
    await expect(f.operation({ ...command, actor: 'caller-supplied' } as any)).rejects.toMatchObject({ code: 'invalid-command' })
    await expect(f.operation({ ...command, runtime: (await loadReleaseRuntime('sqlite')).identity, runtimeStorage: 'unknown' } as any)).rejects.toMatchObject({ code: 'invalid-command' })
    expect((await cli('releases', 'list', ...f.flags)).output.releases).toEqual([])
  })
  it('bounds imported-test enumeration and rejects repeating page cursors', async () => {
    const projectId = randomUUID(), caseId = randomUUID(), calls: unknown[] = []
    const host = { async call(command: unknown) { calls.push(command); return { schemaVersion: 2, tests: [{ id: caseId, generation: 1, status: 'draft', sha256: 'a'.repeat(64), project: { id: projectId } }], nextCursor: caseId } }, async close() {} }
    await expect(importedOperationTests(host, projectId)).rejects.toMatchObject({ code: 'invalid-response' })
    expect(calls).toHaveLength(2)
  })
  it.each(['container', 'unready', 'instance'])('refuses %s mismatch before executing without starting a new runtime', async fault => {
    const f = await fixture()
    const observed = await mocks.inspect()
    if (fault === 'container') observed.containerId = '0'.repeat(64)
    if (fault === 'unready') observed.service.status = 'draining'
    if (fault === 'instance') observed.service.instanceId = randomUUID()
    mocks.inspect.mockResolvedValue(observed)
    const result = await cli('run', f.sourceFile, '--input', f.inputFile, '--id', randomUUID(), ...f.flags)
    expect(result.exit).toBe(1)
    expect((await f.operation({ operation: 'runs.list' })).runs).toHaveLength(0)
  })
  it('client close leaves the owner service available and checks commands through a pinned instance', async () => {
    const f = await fixture(), host = await openCliOperations(f.values)
    await host.close()
    expect(await host.call({ operation: 'runs.list' })).toMatchObject({ runs: [] })
  })
})

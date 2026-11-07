import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LocalRuntime, executionCheckpointHash } from '../src/runtime/index.ts'
import { runReceipt } from '../src/runtime/receipts.ts'
import { compileLocalRun, compileRuntimeWorkflow } from '../src/runtime/run-evaluator.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { RunLedger } from '../src/runtime/run-ledger.ts'
import { validateRunTransition } from '../src/runtime/run-transition.ts'
import { inspectRelease, releaseRequirements } from '../src/releases/snapshot.ts'
import { createTestSuite, runTestSuite } from '../src/testing/suite.ts'
import { testDefinitionSchema, testHash } from '../src/testing/schema.ts'
import { createEvidenceZip, inspectEvidenceZip } from '../src/evidence/index.ts'
import { RuntimeClient, startRuntimeService } from '../src/http/index.ts'
import { ReleaseClient } from '../src/releases/client.ts'
import { main } from '../src/cli.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const api = await readFile(new URL('../examples/api-echo.yaml', import.meta.url), 'utf8')
const approval = (await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')).replace('[manual]', '[api]')
const mixed = echo.replace('[manual]', '[manual, api]'), cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-api-trigger-')), owner = await LocalRuntime.open({ dataDirectory: directory })
  cleanup.push(() => owner.close()); return { directory, owner }
}
const pin = (value: { id: string; generation: number; sha256: string }) => ({ id: value.id, generation: value.generation, sha256: value.sha256 })
const cli = async (args: string[]) => {
  let out = '', err = ''; const code = await main(args, { out: text => { out += text }, err: text => { err += text } })
  return { code, out, err, value: JSON.parse(out || err) }
}

it('requires explicit api selection and a declared API entry; release admission does not authorize execution', async () => {
  const { owner } = await fixture()
  expect(compileRuntimeWorkflow(api, DEFAULT_COMPILER_LIMITS).nodes[0]!.plan.kind).toBe('trigger')
  expect(() => compileLocalRun(api, DEFAULT_COMPILER_LIMITS)).toThrow('invalid-command')
  expect(compileLocalRun(api, DEFAULT_COMPILER_LIMITS, 'api').nodes).toHaveLength(2)
  expect((await owner.check(api)).runtimeReadiness).toBe('unavailable')
  expect(await owner.check(api, 'api')).toMatchObject({ runtimeReadiness: 'ready', triggerMode: 'api', execution: 'not-run' })
  await expect(owner.run(api, 'PRIVATE')).rejects.toMatchObject({ code: 'invalid-command' })
  for (const source of [echo, echo.replace('[manual]', '[chat]'), echo.replace('[manual]', '[webhook]')]) {
    await expect(owner.run(source, 'PRIVATE', { triggerMode: 'api' })).rejects.toMatchObject({ code: 'invalid-command' })
  }
  expect(owner.list()).toEqual([])
})

it.each([null, false, 1, 'manual', 'chat', 'webhook', {}, ['api']])('refuses malformed or unsupported start mode %j without creating state', async triggerMode => {
  const { owner } = await fixture()
  await expect(owner.run(mixed, 'PRIVATE', { triggerMode } as any)).rejects.toMatchObject({ code: 'invalid-command' })
  await expect(owner.check(mixed, triggerMode as any)).rejects.toMatchObject({ code: 'invalid-command' })
  expect(owner.list()).toEqual([])
})

it('persists exact API identity/creation/evidence, survives reopen and never replays an identical UUID', async () => {
  const f = await fixture(), id = randomUUID(), first = await f.owner.run(api, 'PRIVATE_INPUT', { id, triggerMode: 'api' })
  expect(first.state).toMatchObject({ status: 'completed', output: 'PRIVATE_INPUT' }); expect(first.triggerMode).toBe('api')
  expect(runReceipt(first).triggerMode).toBe('api'); expect(f.owner.list()[0]!.triggerMode).toBe('api')
  const events = await f.owner.events(id), evidence = await f.owner.exportRun(id)
  expect(events[0]!.data).toMatchObject({ triggerMode: 'api' }); expect(evidence.snapshot.run.triggerMode).toBe('api')
  expect(evidence.snapshot.journal[0]).toMatchObject({ kind: 'run-created', triggerMode: 'api' })
  expect(JSON.stringify(evidence)).not.toContain('PRIVATE_INPUT')
  await f.owner.close(); const reopened = await LocalRuntime.open({ dataDirectory: f.directory }); cleanup.push(() => reopened.close())
  expect(await reopened.run(api, 'PRIVATE_INPUT', { id, triggerMode: 'api' })).toEqual(first)
  expect(await reopened.events(id)).toEqual(events)
  await expect(reopened.run(api, 'DIFFERENT', { id, triggerMode: 'api' })).rejects.toMatchObject({ code: 'conflict' })
})

it('preserves legacy omission and refuses changing the retained mode on a mixed-entry retry or transition', async () => {
  const { owner } = await fixture(), legacy = await owner.run(mixed, 'same', { paused: true }), explicit = await owner.run(mixed, 'same', { triggerMode: 'api', paused: true })
  expect(legacy).not.toHaveProperty('triggerMode'); expect(runReceipt(legacy)).not.toHaveProperty('triggerMode')
  expect((await owner.exportRun(legacy.id)).snapshot.journal[0]).not.toHaveProperty('triggerMode')
  await expect(owner.run(mixed, 'same', { id: legacy.id, triggerMode: 'api', paused: true })).rejects.toMatchObject({ code: 'conflict' })
  await expect(owner.run(mixed, 'same', { id: explicit.id, paused: true })).rejects.toMatchObject({ code: 'conflict' })
  const { triggerMode: _mode, ...forged } = explicit
  expect(executionCheckpointHash(explicit)).not.toBe(executionCheckpointHash(forged))
  const graph = compileRuntimeWorkflow(mixed, DEFAULT_COMPILER_LIMITS)
  expect(() => validateRunTransition(explicit, forged, 'execution-segment', {}, graph, DEFAULT_COMPILER_LIMITS)).toThrow('conflict')
  const events = await owner.events(explicit.id)
  expect(() => new RunLedger(DEFAULT_COMPILER_LIMITS).check(forged, { events })).toThrow('corrupt')
})

it('retains API mode through reviewed project execution, archive retry, paused controls and explicit approval', async () => {
  const f = await fixture(), { owner } = f, project = owner.editProject({ operation: 'create', yaml: approval, title: 'API review', actor: 'fixture' })
  const id = randomUUID(), start = await owner.runProject(project.id, project.generation, project.acceptedRevision, { message: 'PRIVATE_REVIEW' }, { id, paused: true, triggerMode: 'api' })
  expect(start.state.status).toBe('paused')
  const wait = await owner.advance(id, { requestId: randomUUID(), expectedCheckpointSha256: executionCheckpointHash(start), mode: 'continue' }, 'fixture')
  expect(wait.state.status).toBe('waiting'); expect(wait.triggerMode).toBe('api')
  if (wait.state.status !== 'waiting') throw Error('Expected explicit review')
  await owner.close()
  const reopened = await LocalRuntime.open({ dataDirectory: f.directory }); cleanup.push(() => reopened.close())
  expect(await reopened.show(id)).toEqual(wait)
  const done = await reopened.decide(id, wait.state.attempt.id, 'approve', 'fixture')
  expect(done.state.status).toBe('completed'); expect(done.triggerMode).toBe('api')
  reopened.editProject({ operation: 'archive', id: project.id, expectedGeneration: project.generation, archived: true, actor: 'fixture' })
  expect(await reopened.runProject(project.id, project.generation, project.acceptedRevision, { message: 'PRIVATE_REVIEW' }, { id, paused: true, triggerMode: 'api' })).toEqual(done)
  await expect(reopened.runProject(project.id, project.generation, project.acceptedRevision, { message: 'PRIVATE_REVIEW' }, { id, paused: true })).rejects.toMatchObject({ code: 'conflict' })
})

it('reviews API test/generation hashes, runs parallel cases without implicit mode selection and transfers draft lineage', async () => {
  const { owner } = await fixture(), project = owner.editProject({ operation: 'create', yaml: api, title: 'API cases', actor: 'fixture' })
  const projectPin = { id: project.id, generation: project.generation, revision: project.acceptedRevision }
  const definition = { title: 'Test', project: projectPin, input: 'PRIVATE_TEST', expectations: [{ kind: 'status' as const, value: 'completed' as const }] }
  const old = testDefinitionSchema.parse(definition), apiDefinition = testDefinitionSchema.parse({ ...definition, triggerMode: 'api' })
  expect(old).not.toHaveProperty('triggerMode'); expect(testHash(old)).not.toBe(testHash(apiDefinition))
  const request = { id: randomUUID(), project: projectPin, actor: 'fixture', limit: 2, triggerMode: 'api' as const }
  const batch = owner.generateTests(request)
  expect(batch.snapshot.request.triggerMode).toBe('api'); expect(batch.snapshot.cases.every(c => c.definition.triggerMode === 'api')).toBe(true)
  expect(owner.list()).toEqual([]); expect(owner.generateTests(request)).toEqual(batch)
  const { triggerMode: _mode, ...changed } = request
  expect(() => owner.generateTests(changed)).toThrow('conflict')
  const tests = batch.snapshot.cases.map(c => pin(owner.editTest({ operation: 'accept', id: c.id, expectedGeneration: 1, reviewedSha256: c.sha256, actor: 'fixture' })))
  const suite = createTestSuite({ title: 'API suite', failurePolicy: 'stop', concurrency: 2, tests })
  const result = await runTestSuite(owner, suite.suite, suite.sha256); expect(result.status).toBe('passed')
  expect(result.entries.every(e => owner.list().find(r => r.id === e.runId)?.triggerMode === 'api')).toBe(true)
  const json = JSON.stringify(owner.exportProject(project.id, project.generation, project.acceptedRevision, false, true))
  const target = await fixture(), review = target.owner.inspectProjectImport(json)
  const imported = target.owner.importProject(json, review.sha256, 'fixture')
  const transferred = target.owner.testCases()
  expect(transferred).toHaveLength(tests.length)
  expect(transferred.every(c => c.status === 'draft' && target.owner.testCase(c.id).definition.triggerMode === 'api')).toBe(true)
  expect(imported.id).not.toBe(project.id)
})

it('preserves API mode in selected evidence ZIP inspection without claiming HTTP ingress or restoring execution', async () => {
  const { owner } = await fixture(), run = await owner.run(api, 'PRIVATE', { triggerMode: 'api' })
  const selection = { schemaVersion: 1 as const, runs: [{ id: run.id, revision: run.revision }] }
  const zip = await createEvidenceZip(owner, selection, false), result = await inspectEvidenceZip(zip.bytes)
  expect(result.runs[0]).toMatchObject({ id: run.id, triggerMode: 'api' }); expect(result.execution).toBe('not-started-by-inspection')
})

it('preserves API entry through scoped loop approval restart, cancellation and guarded controls', async () => {
  const yaml = (await readFile(new URL('../examples/loop-approval.yaml', import.meta.url), 'utf8')).replace('[manual]', '[api]')
  const f = await fixture(), waiting = await f.owner.run(yaml, ['PRIVATE_ONE', 'PRIVATE_TWO'], { triggerMode: 'api' })
  if (waiting.state.status !== 'waiting') throw Error('Expected first item review')
  await f.owner.close()
  const owner = await LocalRuntime.open({ dataDirectory: f.directory }); cleanup.push(() => owner.close())
  const second = await owner.decide(waiting.id, waiting.state.attempt.id, 'approve', 'fixture')
  expect(second).toMatchObject({ triggerMode: 'api', state: { status: 'waiting', scope: { loop: 'each', index: 1 } } })
  const cancelled = owner.cancel(second.id, randomUUID(), 'fixture')
  expect(cancelled).toMatchObject({ triggerMode: 'api', state: { status: 'cancelled' } })
  expect((await owner.exportRun(second.id)).snapshot.run.triggerMode).toBe('api')
  const paused = await owner.run(api, 'PRIVATE_CONTROL', { triggerMode: 'api', paused: true })
  const step = await owner.advance(paused.id, { requestId: randomUUID(), expectedCheckpointSha256: executionCheckpointHash(paused), mode: 'step' }, 'fixture')
  expect(step).toMatchObject({ triggerMode: 'api', state: { status: 'paused', next: 'result' } })
  const done = await owner.advance(paused.id, { requestId: randomUUID(), expectedCheckpointSha256: executionCheckpointHash(step), mode: 'continue' }, 'fixture')
  expect(done).toMatchObject({ triggerMode: 'api', state: { status: 'completed', output: 'PRIVATE_CONTROL' } })
})

it('refuses undeclared API test/generation contracts and keeps legacy test hashes unchanged', async () => {
  const { owner } = await fixture(), project = owner.editProject({ operation: 'create', yaml: echo, title: 'Local only', actor: 'fixture' })
  const projectPin = { id: project.id, generation: project.generation, revision: project.acceptedRevision }
  const definition = { title: 'Existing', project: projectPin, input: 'PRIVATE', expectations: [{ kind: 'status' as const, value: 'completed' as const }] }
  const historical = testDefinitionSchema.parse(definition)
  expect(testHash(historical)).toBe(testHash(testDefinitionSchema.parse({ ...definition, triggerMode: undefined })))
  expect(() => owner.editTest({ operation: 'create', actor: 'fixture', definition: { ...definition, triggerMode: 'api' } })).toThrow('invalid-command')
  expect(() => owner.generateTests({ id: randomUUID(), project: projectPin, actor: 'fixture', limit: 1, triggerMode: 'api' })).toThrow('invalid-command')
  expect(owner.testCases()).toEqual([]); expect(owner.testGenerations()).toEqual([])
})

it('packages an API-only release but refuses a default release start; pins mode under exact-release HTTP guards', async () => {
  const f = await fixture(), project = f.owner.editProject({ operation: 'create', yaml: api, title: 'API release', actor: 'fixture' })
  const release = f.owner.createRelease({ projectId: project.id, expectedGeneration: project.generation, revision: project.acceptedRevision,
    version: '1.0.0', runtime: { version: '0.1.0-alpha.1', sha256: 'a'.repeat(64) }, actor: 'fixture' })
  expect(inspectRelease(release.snapshot)).toEqual(release)
  expect(releaseRequirements(release.snapshot).apiTrigger).toMatchObject({ selection: 'explicit-triggerMode-api', defaultLocal: 'unavailable', ingress: 'not-provisioned' })
  await expect(f.owner.runRelease(release.snapshot, 'PRIVATE')).rejects.toMatchObject({ code: 'invalid-command' })
  const first = await f.owner.runRelease(release.snapshot, 'PRIVATE', { triggerMode: 'api' }); expect(first.triggerMode).toBe('api')
  await f.owner.close()
  const token = 'a'.repeat(64), service = await startRuntimeService({ token, actor: 'fixture', release: { snapshot: release.snapshot }, runtime: { dataDirectory: f.directory } })
  cleanup.push(async () => { await service.close(); await service.closed })
  const client = new ReleaseClient(service.url, token, release.sha256), id = randomUUID()
  expect(await client.operation({ operation: 'release.check', triggerMode: 'api' })).toMatchObject({ result: { runtimeReadiness: 'ready', triggerMode: 'api' } })
  await expect(client.operation({ operation: 'runs.start', id, input: 'PRIVATE' })).rejects.toMatchObject({ code: 'invalid-command' })
  const result = await client.operation({ operation: 'runs.start', id, input: 'PRIVATE', triggerMode: 'api' })
  expect(result).toMatchObject({ result: { id, status: 'completed', triggerMode: 'api' } })
  expect(await client.operation({ operation: 'runs.start', id, input: 'PRIVATE', triggerMode: 'api' })).toEqual(result)
})

it('uses the explicit mode through authenticated management HTTP and refuses undeclared or malformed modes before run creation', async () => {
  const f = await fixture(); await f.owner.close()
  const token = 'a'.repeat(64), service = await startRuntimeService({ token, actor: 'fixture', runtime: { dataDirectory: f.directory } })
  cleanup.push(async () => { await service.close(); await service.closed })
  const client = new RuntimeClient(service.url, token), id = randomUUID(), command = { operation: 'runs.start' as const, id, yaml: api, input: 'PRIVATE', triggerMode: 'api' as const }
  await expect(client.operation({ ...command, triggerMode: 'webhook' } as any)).rejects.toMatchObject({ code: 'invalid-command' })
  await expect(client.operation({ ...command, yaml: echo })).rejects.toMatchObject({ code: 'invalid-command' })
  const result = await client.operation(command); expect(result).toMatchObject({ result: { id, triggerMode: 'api', status: 'completed' } })
  expect(await client.operation(command)).toEqual(result)
})

it('discovers API selection and rejects invalid CLI mode before accessing workflow/state', async () => {
  for (const command of [['run'], ['check'], ['projects', 'run'], ['tests', 'generate']]) {
    const result = await cli(['help', ...command, '--json']); expect(result.code).toBe(0)
    expect(result.value.variants[0].options['trigger-mode']).toBe('string')
    expect(result.value.variants[0].requirements.rules).toContainEqual({ kind: 'choices', flag: 'trigger-mode', values: ['api'] })
  }
  const result = await cli(['run', 'never-read.yaml', '--input', 'never-read.json', '--trigger-mode', 'webhook'])
  expect(result.code).toBe(2); expect(result.value.code).toBe('invalid-input')
})

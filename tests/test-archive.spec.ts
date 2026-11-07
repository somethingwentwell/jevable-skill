import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LocalRuntime } from '../src/runtime/index.ts'
import { TestLedger } from '../src/testing/ledger.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { createTestSuite, runTestSuite } from '../src/testing/suite.ts'
import { createProjectZip, readProjectZip } from '../src/packages/project-zip.ts'
import { RuntimeClient, startRuntimeService } from '../src/http/index.ts'
import { main } from '../src/cli.ts'
import type { TestCase, TestCommand } from '../src/testing/schema.ts'
import { testHash } from '../src/testing/schema.ts'
import { renderTemplate, listTemplates } from '../src/templates/index.ts'
import type { ModelCalls } from '../src/runtime/index.ts'

const yaml = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8'), actor = 'local:archive-fixture'
const closes: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) await close() })
const identity = (t: TestCase) => ({ id: t.id, generation: t.generation, sha256: t.sha256 })
const command = (t: TestCase, archived = true): TestCommand => ({ operation: 'archive', id: t.id,
  expectedGeneration: t.generation, reviewedSha256: t.sha256, archived, actor })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-test-archive-')), owner = await LocalRuntime.open({ dataDirectory: directory })
  closes.push(() => owner.close())
  const project = owner.editProject({ operation: 'create', title: 'Archive fixture', yaml, actor })
  const definition = { title: 'Private saved case', project: { id: project.id, generation: project.generation, revision: project.acceptedRevision },
    input: 'PRIVATE_ARCHIVE_INPUT', expectations: [{ kind: 'status' as const, value: 'completed' as const }] }
  const draft = owner.editTest({ operation: 'create', definition, actor })
  const accept = (t: TestCase) => owner.editTest({ operation: 'accept', id: t.id, expectedGeneration: t.generation, reviewedSha256: t.sha256, actor })
  return { directory, owner, project, definition, draft, accept }
}
const cli = async (args: string[]) => { let out = '', err = ''; const code = await main(args, { out: x => out += x, err: x => err += x }); return { code, out, err } }

describe('append-only saved-test archival', () => {
  it('refuses an archival race during asynchronous model admission before saving a run or dispatching', async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let calls = 0
    const models: ModelCalls = { async admit() { entered.resolve(); await release.promise }, async execute() { calls++; throw Error('Must not dispatch') }, async verify() {} }
    const directory = await mkdtemp(join(tmpdir(), 'jevable-test-archive-race-')), owner = await LocalRuntime.open({ dataDirectory: directory, models }); closes.push(() => owner.close())
    const project = owner.editProject({ operation: 'create', title: 'Admission race', actor,
      yaml: JSON.stringify(renderTemplate('support-reply', { model: { provider: 'fixture', model: 'fixture' } })) })
    const draft = owner.editTest({ operation: 'create', actor, definition: { title: 'Race',
      project: { id: project.id, generation: 1, revision: project.acceptedRevision },
      input: listTemplates().find(t => t.id === 'support-reply')!.sample,
      expectations: [{ kind: 'status', value: 'completed' }] } })
    const accepted = owner.editTest({ operation: 'accept', id: draft.id, expectedGeneration: 1, reviewedSha256: draft.sha256, actor })
    const running = owner.runTest(identity(accepted), randomUUID()), rejected = expect(running).rejects.toMatchObject({ code: 'archived' })
    await entered.promise; owner.editTest(command(accepted)); release.resolve(); await rejected
    expect(calls).toBe(0); expect(owner.list()).toEqual([])
  })
  it('does not cancel/approve an already admitted waiting run and preserves its original assessment definition after explicit approval', async () => {
    const f = await fixture(), approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
    const project = f.owner.editProject({ operation: 'create', title: 'Retained review', yaml: approval, actor })
    const draft = f.owner.editTest({ operation: 'create', actor, definition: { title: 'Wait expected',
      project: { id: project.id, generation: 1, revision: project.acceptedRevision }, input: { message: 'Private review' }, expectations: [{ kind: 'status', value: 'waiting' }] } })
    const accepted = f.accept(draft), id = randomUUID(), result = await f.owner.runTest(identity(accepted), id), events = await f.owner.events(id)
    f.owner.editTest(command(accepted))
    expect(await f.owner.testResult(id)).toEqual(result); expect(await f.owner.events(id)).toEqual(events)
    const run = await f.owner.show(id); if (run.state.status !== 'waiting') throw Error('Expected review')
    await f.owner.decide(id, run.state.attempt.id, 'approve', actor)
    expect(await f.owner.testResult(id)).toMatchObject({ workflowStatus: 'completed', assessment: 'failed', terminal: true, test: identity(accepted) })
  })
  it('validates archive CLI identity/review flags before opening any owner or files', async () => {
    const open = vi.spyOn(LocalRuntime, 'open')
    for (const args of [['tests', 'archive', 'not-a-uuid', '--expected-generation', '1', '--sha256', 'a'.repeat(64)],
      ['tests', 'unarchive', randomUUID(), '--expected-generation', '1'], ['tests', 'archive', randomUUID(), '--sha256', 'a'.repeat(64)]]) {
      expect((await cli(args)).code).not.toBe(0)
    }
    expect(open).not.toHaveBeenCalled()
  })
  it.each(['draft', 'accepted'] as const)('archives/restores %s without altering definition, review/hash or history', async status => {
    const f = await fixture(), original = status === 'draft' ? f.draft : f.accept(f.draft), history = f.owner.testHistory(original.id)
    expect(original).not.toHaveProperty('archived')
    const archived = f.owner.editTest(command(original))
    expect(archived).toMatchObject({ operation: 'archive', archived: true, status, sha256: original.sha256, definition: original.definition, generation: original.generation + 1 })
    expect(f.owner.testCase(original.id, original.generation)).toEqual(original)
    expect(f.owner.testHistory(original.id).versions.slice(0, -1)).toEqual(history.versions)
    expect(f.owner.testCases()[0]).toMatchObject({ archived: true, status }); expect(JSON.stringify(f.owner.testCases())).not.toContain('PRIVATE_ARCHIVE_INPUT')
    expect(() => f.owner.editTest({ operation: 'edit', id: original.id, expectedGeneration: archived.generation, definition: f.definition, actor })).toThrow('archived')
    expect(() => f.accept(archived)).toThrow('archived')
    const restored = f.owner.editTest(command(archived, false))
    expect(restored).toMatchObject({ archived: false, status, sha256: original.sha256, definition: original.definition })
    expect(f.owner.list()).toEqual([]); if (status === 'draft') expect(f.accept(restored).status).toBe('accepted')
  })
  it('requires exact generation/hash/state and strict command fields without partial writes', async () => {
    const f = await fixture(), before = f.owner.testHistory(f.draft.id)
    for (const patch of [{ expectedGeneration: 2 }, { reviewedSha256: '0'.repeat(64) }, { archived: false }])
      expect(() => f.owner.editTest({ ...command(f.draft), ...patch })).toThrow('conflict')
    for (const patch of [{ archived: undefined }, { archived: 'true' }, { erase: true }, { actor: '' }, { reviewedSha256: undefined }])
      expect(() => f.owner.editTest({ ...command(f.draft), ...patch } as never)).toThrow('invalid-command')
    expect(f.owner.testHistory(f.draft.id)).toEqual(before)
    const archived = f.owner.editTest(command(f.draft))
    expect(() => f.owner.editTest(command(f.draft))).toThrow('conflict'); expect(() => f.owner.editTest(command(archived))).toThrow('conflict')
  })
  it('blocks new ordinary/suite runs, retaining original UUID results and requiring restored generation for fresh execution', async () => {
    const f = await fixture(), accepted = f.accept(f.draft), pin = identity(accepted), id = randomUUID()
    const result = await f.owner.runTest(pin, id), originalEvents = await f.owner.events(id), archived = f.owner.editTest(command(accepted))
    await expect(f.owner.runTest(pin, randomUUID())).rejects.toMatchObject({ code: 'archived' })
    await expect(f.owner.runTest(identity(archived), randomUUID())).rejects.toMatchObject({ code: 'archived' })
    expect(await f.owner.runTest(pin, id)).toEqual(result); expect(await f.owner.events(id)).toEqual(originalEvents)
    const suite = createTestSuite({ title: 'Archived admission', failurePolicy: 'stop', tests: [pin] })
    expect(await runTestSuite(f.owner, suite.suite, suite.sha256)).toMatchObject({ status: 'blocked', entries: [{ error: { code: 'archived', stage: 'preflight', execution: 'not-requested' } }] })
    expect(f.owner.list()).toHaveLength(1)
    const restored = f.owner.editTest(command(archived, false))
    await expect(f.owner.runTest(pin, randomUUID())).rejects.toMatchObject({ code: 'conflict' })
    expect(await f.owner.runTest(identity(restored), randomUUID())).toMatchObject({ assessment: 'passed', workflowStatus: 'completed' })
  })
  it('retires stale/archived-project cases without refreshing pins or permitting project deletion', async () => {
    const f = await fixture(), accepted = f.accept(f.draft)
    const renamed = f.owner.editProject({ operation: 'rename', id: f.project.id, expectedGeneration: 1, title: 'Later', actor })
    const archived = f.owner.editTest(command(accepted)), restored = f.owner.editTest(command(archived, false))
    expect(restored.definition.project).toEqual(accepted.definition.project)
    await expect(f.owner.runTest(identity(restored), randomUUID())).rejects.toMatchObject({ code: 'conflict' })
    const project = f.owner.editProject({ operation: 'archive', id: f.project.id, expectedGeneration: renamed.generation, archived: true, actor })
    f.owner.editTest(command(restored)); expect(() => f.owner.deleteProject(project.id, project.generation, actor)).toThrow('referenced')
  })
  it('retains generated original drafts/receipts and archived versions across owner reopen', async () => {
    const f = await fixture(), batch = f.owner.generateTests({ id: randomUUID(), project: f.definition.project, limit: 1, actor })
    const original = f.owner.testCase(batch.snapshot.cases[0]!.id), archived = f.owner.editTest(command(original))
    await f.owner.close(); const owner = await LocalRuntime.open({ dataDirectory: f.directory }); closes.push(() => owner.close())
    expect(owner.testGeneration(batch.snapshot.id)).toEqual(batch); expect(owner.testCase(archived.id)).toEqual(archived)
    expect(owner.testCase(archived.id, 1)).toEqual(original); expect(owner.list()).toEqual([])
  })
  it('excludes archived cases from JSON/ZIP transfers with an exclusion count and unchanged legacy omission', async () => {
    const f = await fixture(), before = f.owner.exportProject(f.project.id, 1, f.project.acceptedRevision, false, true)
    expect(before.version).toBe(2); if (before.version !== 2) throw Error('Expected tests')
    expect(before.tests).not.toHaveProperty('excludedArchived'); f.owner.editTest(command(f.draft))
    const bundle = f.owner.exportProject(f.project.id, 1, f.project.acceptedRevision, true, true)
    if (bundle.version !== 2) throw Error('Expected tests')
    expect(bundle.tests).toMatchObject({ excludedArchived: 1, excludedOtherRevisions: 0, cases: [] })
    const zip = await readProjectZip(createProjectZip(bundle))
    expect(JSON.parse(zip.json).tests).toEqual(bundle.tests)
    const review = f.owner.inspectProjectImport(zip.json), imported = f.owner.importProject(zip.json, review.sha256, actor)
    expect(f.owner.testCases().filter(t => t.project.id === imported.id)).toEqual([]); expect(f.owner.testHistory(f.draft.id).versions).toHaveLength(2)
  })
  it.each(['missing-flag', 'same-state', 'changed-definition', 'changed-review-status', 'edit-while-archived', 'first-version-archive'])(
    'rejects persisted lifecycle corruption: %s', async variant => {
      const f = await fixture(), archived = f.owner.editTest(command(f.draft)), core = new TestLedger(DEFAULT_COMPILER_LIMITS, 4_000_000)
      const record = structuredClone(f.owner.testHistory(archived.id)), last = record.versions.at(-1)!
      if (variant === 'missing-flag') delete last.archived
      if (variant === 'same-state') last.archived = false
      if (variant === 'changed-definition') { last.definition.title = 'Forged'; last.sha256 = testHash(last.definition) }
      if (variant === 'changed-review-status') last.status = 'accepted'
      if (variant === 'edit-while-archived') record.versions.push({ ...record.versions[0]!, generation: 3, operation: 'edit' })
      if (variant === 'first-version-archive') record.versions[0]!.operation = 'archive'
      expect(() => core.decode(record, archived.id, record.versions.length)).toThrow('corrupt')
    })
  it('rolls back a refused SQLite write, retaining the original active case', async () => {
    const f = await fixture(); await f.owner.close(); const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'))
    try { db.exec("CREATE TRIGGER archive_refusal BEFORE UPDATE ON test_cases BEGIN SELECT RAISE(ABORT,'fixture archive refusal'); END;") } finally { db.close() }
    const owner = await LocalRuntime.open({ dataDirectory: f.directory }); closes.push(() => owner.close())
    expect(() => owner.editTest(command(f.draft))).toThrow('fixture archive refusal')
    expect(owner.testCase(f.draft.id)).toEqual(f.draft); expect(owner.testHistory(f.draft.id).versions).toHaveLength(1)
  })
  it('owns HTTP actors and refuses actor overrides or unauthorized lifecycle changes', async () => {
    const f = await fixture(); await f.owner.close()
    const service = await startRuntimeService({ token: 'a'.repeat(64), actor: 'local:archive-host', runtime: { dataDirectory: f.directory } }); closes.push(() => service.close())
    const client = new RuntimeClient(service.url, 'a'.repeat(64)), { actor: _actor, ...body } = command(f.draft)
    const response = await client.operation({ operation: 'tests.command', command: body }) as { result: TestCase }
    expect(response.result).toMatchObject({ archived: true, actor: 'local:archive-host' })
    await expect(client.operation({ operation: 'tests.command', command: command(response.result, false) })).rejects.toMatchObject({ code: 'invalid-command' })
    await expect(new RuntimeClient(service.url, 'b'.repeat(64)).operation({ operation: 'tests.command', command: { ...body, expectedGeneration: 2, archived: false } })).rejects.toThrow()
  })
  it('shares guarded CLI lifecycle and private-free list metadata across separate owners', async () => {
    const f = await fixture(); await f.owner.close(); const flags = ['--data-dir', f.directory, '--json']
    const archived = await cli(['tests', 'archive', f.draft.id, '--expected-generation', '1', '--sha256', f.draft.sha256, ...flags])
    expect(archived.code, archived.err).toBe(0); expect(JSON.parse(archived.out)).toMatchObject({ archived: true, status: 'draft' })
    const list = await cli(['tests', 'list', ...flags]); expect(list.out).not.toContain('PRIVATE_ARCHIVE_INPUT'); expect(JSON.parse(list.out).tests[0]).toMatchObject({ archived: true })
    const restored = await cli(['tests', 'unarchive', f.draft.id, '--expected-generation', '2', '--sha256', f.draft.sha256, ...flags])
    expect(restored.code, restored.err).toBe(0); expect(JSON.parse(restored.out)).toMatchObject({ archived: false, status: 'draft', generation: 3 })
  })
})

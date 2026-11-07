import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LocalRuntime, type TestCase, type TestErasureRequest } from '../src/runtime/index.ts'
import { testHistorySha256 } from '../src/testing/erasure.ts'

const yaml = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8'), actor = 'local:erasure-owner'
const closes: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) await close() })
const identity = (test: TestCase) => ({ id: test.id, generation: test.generation, sha256: test.sha256 })
async function fixture(id?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-test-erasure-sqlite-')), owner = await LocalRuntime.open({ dataDirectory: directory })
  closes.push(() => owner.close())
  const project = owner.editProject({ operation: 'create', title: 'Erasure fixture', yaml, actor })
  const definition = { title: 'PRIVATE_ERASE_CASE_TITLE', project: { id: project.id, generation: 1, revision: project.acceptedRevision },
    input: 'PRIVATE_ERASE_CASE_INPUT', expectations: [{ kind: 'status' as const, value: 'completed' as const }, { kind: 'output-equals' as const, value: 'PRIVATE_ERASE_EXPECTED' }] }
  const draft = owner.editTest({ operation: 'create', ...(id ? { id } : {}), definition, actor })
  const archive = (test: TestCase) => owner.editTest({ operation: 'archive', id: test.id, expectedGeneration: test.generation, reviewedSha256: test.sha256, archived: true, actor })
  const command = (test: TestCase): TestErasureRequest => ({ requestId: randomUUID(), test: identity(test),
    reviewedHistorySha256: testHistorySha256(owner.testHistory(test.id)), actor })
  return { directory, owner, project, definition, draft, archive, command }
}

describe('atomic SQLite archived manual-draft logical removal', () => {
  it('removes private case definitions and retains only reviewed identity/project/actor metadata', async () => {
    const f = await fixture(), archived = f.archive(f.draft), request = f.command(archived), receipt = f.owner.eraseTest(request)
    expect(receipt).toMatchObject({ requestId: request.requestId, test: request.test, historySha256: request.reviewedHistorySha256,
      project: f.definition.project, actor, policy: 'archived-draft-v1', status: 'logically-removed', securePhysicalErasure: false })
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE_ERASE_'); expect(f.owner.testCases()).toEqual([])
    expect(() => f.owner.testCase(f.draft.id)).toThrow('not-found'); expect(() => f.owner.testHistory(f.draft.id)).toThrow('not-found')
    expect(f.owner.testErasure(request.requestId)).toEqual(receipt); expect(f.owner.list()).toEqual([])
    const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'))
    try {
      expect(db.prepare('SELECT record FROM test_cases WHERE id=?').get(f.draft.id)).toBeUndefined()
      expect(JSON.stringify(db.prepare('SELECT * FROM test_erasures').all())).not.toContain('PRIVATE_ERASE_')
    } finally { db.close() }
    receipt.project.id = randomUUID(); receipt.test.generation++
    expect(f.owner.testErasure(request.requestId)).toMatchObject({ project: f.definition.project, test: request.test })
  })
  it('observes the exact original request after an unobserved response and owner reopen without repeating removal', async () => {
    const f = await fixture(), archived = f.archive(f.draft), request = f.command(archived), first = f.owner.eraseTest(request)
    await f.owner.close(); const reopened = await LocalRuntime.open({ dataDirectory: f.directory }); closes.push(() => reopened.close())
    expect(reopened.testErasure(request.requestId)).toEqual(first); expect(reopened.eraseTest(request)).toEqual(first)
    expect(reopened.eraseTest({ ...request, requestId: request.requestId.toUpperCase() })).toEqual(first)
    expect(reopened.testCases()).toEqual([]); expect(reopened.list()).toEqual([])
    const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'))
    try { expect(db.prepare('SELECT count(*) AS count FROM test_erasures').get()).toMatchObject({ count: 1 }) } finally { db.close() }
  })
  it.each(['actor', 'generation', 'sha256', 'history', 'test-id', 'new-request'] as const)('refuses changed %s after committed removal', async variant => {
    const f = await fixture(), archived = f.archive(f.draft), request = f.command(archived), first = f.owner.eraseTest(request), changed = structuredClone(request)
    if (variant === 'actor') changed.actor = 'different owner attribution'
    if (variant === 'generation') changed.test.generation++
    if (variant === 'sha256') changed.test.sha256 = 'b'.repeat(64)
    if (variant === 'history') changed.reviewedHistorySha256 = 'b'.repeat(64)
    if (variant === 'test-id') changed.test.id = randomUUID()
    if (variant === 'new-request') changed.requestId = randomUUID()
    expect(() => f.owner.eraseTest(changed)).toThrow('conflict'); expect(f.owner.testErasure(request.requestId)).toEqual(first)
  })
  it.each(['original', 'uppercase', 'lowercase'] as const)('refuses %s erased identity reuse through case creation', async spelling => {
    const f = await fixture(randomUUID().toUpperCase()), archived = f.archive(f.draft), request = f.command(archived)
    f.owner.eraseTest(request)
    const id = spelling === 'uppercase' ? f.draft.id.toUpperCase() : spelling === 'lowercase' ? f.draft.id.toLowerCase() : f.draft.id
    expect(() => f.owner.editTest({ operation: 'create', id, definition: f.definition, actor })).toThrow('conflict')
    expect(f.owner.testCases()).toEqual([])
  })
  it('does not weaken project deletion guards when retained erasure metadata references its historical revision', async () => {
    const f = await fixture(), request = f.command(f.archive(f.draft)), receipt = f.owner.eraseTest(request)
    const archived = f.owner.editProject({ operation: 'archive', id: f.project.id, expectedGeneration: 1, archived: true, actor })
    expect(() => f.owner.deleteProject(archived.id, archived.generation, actor)).toThrow('referenced')
    expect(f.owner.project(f.project.id).revisions.some(revision => revision.revision === receipt.project.revision)).toBe(true)
  })
  it('requires current full-history and latest-case guards and explicit archival, with no receipt on refusal', async () => {
    const f = await fixture(), active = f.command(f.draft)
    expect(() => f.owner.eraseTest(active)).toThrow('conflict'); expect(() => f.owner.testErasure(active.requestId)).toThrow('not-found')
    const archived = f.archive(f.draft), request = f.command(archived), before = f.owner.testHistory(archived.id)
    for (const patch of [{ test: { ...request.test, generation: 1 } }, { test: { ...request.test, sha256: '0'.repeat(64) } }, { reviewedHistorySha256: '0'.repeat(64) }])
      expect(() => f.owner.eraseTest({ ...request, ...patch })).toThrow('conflict')
    expect(f.owner.testHistory(archived.id)).toEqual(before); expect(() => f.owner.testErasure(request.requestId)).toThrow('not-found')
  })
  it('preserves accepted case history and actual recorded test-run evidence/results', async () => {
    const f = await fixture(), accepted = f.owner.editTest({ operation: 'accept', id: f.draft.id, expectedGeneration: 1, reviewedSha256: f.draft.sha256, actor })
    const id = randomUUID(), result = await f.owner.runTest(identity(accepted), id), events = await f.owner.events(id)
    const archived = f.archive(accepted), request = f.command(archived), history = f.owner.testHistory(archived.id)
    expect(() => f.owner.eraseTest(request)).toThrow('referenced')
    expect(f.owner.testHistory(archived.id)).toEqual(history); expect(await f.owner.testResult(id)).toEqual(result)
    expect(await f.owner.events(id)).toEqual(events); expect(() => f.owner.testErasure(request.requestId)).toThrow('not-found')
  })
  it('preserves an accepted generation even when it has never been run', async () => {
    const f = await fixture(), accepted = f.owner.editTest({ operation: 'accept', id: f.draft.id, expectedGeneration: 1, reviewedSha256: f.draft.sha256, actor })
    const archived = f.archive(accepted), request = f.command(archived)
    expect(() => f.owner.eraseTest(request)).toThrow('referenced'); expect(f.owner.testCase(archived.id)).toEqual(archived)
  })
  it('preserves generated original drafts and their immutable batch receipts', async () => {
    const f = await fixture(), batch = f.owner.generateTests({ id: randomUUID(), project: f.definition.project, limit: 1, actor })
    const item = f.owner.testCase(batch.snapshot.cases[0]!.id), retired = f.archive(item), request = f.command(retired)
    expect(() => f.owner.eraseTest(request)).toThrow('referenced')
    expect(f.owner.testGeneration(batch.snapshot.id)).toEqual(batch); expect(f.owner.testCase(item.id, 1).definition).toEqual(item.definition)
  })
  it('preserves imported draft origin/history even without a local test run', async () => {
    const f = await fixture(), bundle = JSON.stringify(f.owner.exportProject(f.project.id, 1, f.project.acceptedRevision, false, true))
    const review = f.owner.inspectProjectImport(bundle), imported = f.owner.importProject(bundle, review.sha256, actor)
    const item = f.owner.testCases().find(item => item.project.id === imported.id)!, test = f.owner.testCase(item.id), retired = f.archive(test)
    const request = f.command(retired)
    expect(() => f.owner.eraseTest(request)).toThrow('referenced'); expect(f.owner.testCase(item.id)).toHaveProperty('importedFrom')
  })
  it('rolls back both metadata insertion and logical removal on a real SQLite DELETE trigger refusal', async () => {
    const f = await fixture(), archived = f.archive(f.draft), request = f.command(archived)
    const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'))
    try { db.exec("CREATE TRIGGER erased_case_refusal BEFORE DELETE ON test_cases BEGIN SELECT RAISE(ABORT,'fixture erasure refused'); END;") } finally { db.close() }
    expect(() => f.owner.eraseTest(request)).toThrow('fixture erasure refused')
    expect(f.owner.testCase(archived.id)).toEqual(archived); expect(() => f.owner.testErasure(request.requestId)).toThrow('not-found')
  })
  it('rolls back a real metadata receipt insertion failure without removing the case', async () => {
    const f = await fixture(), archived = f.archive(f.draft), request = f.command(archived)
    const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'))
    try { db.exec("CREATE TRIGGER erased_receipt_refusal BEFORE INSERT ON test_erasures BEGIN SELECT RAISE(ABORT,'fixture receipt refused'); END;") } finally { db.close() }
    expect(() => f.owner.eraseTest(request)).toThrow('fixture receipt refused')
    expect(f.owner.testCase(archived.id)).toEqual(archived); expect(() => f.owner.testErasure(request.requestId)).toThrow('not-found')
  })
  it.each(['request-id', 'missing-history', 'references', 'erase', 'actor', 'unknown'] as const)('refuses invalid or client-supplied %s before changing storage', async variant => {
    const f = await fixture(), archived = f.archive(f.draft), command: Record<string, unknown> = { ...f.command(archived) }
    if (variant === 'request-id') command.requestId = 'bad'
    if (variant === 'missing-history') delete command.reviewedHistorySha256
    if (variant === 'references') command.references = { runs: 0, generationBatches: 0, otherReferences: 0 }
    if (variant === 'erase') command.erase = true
    if (variant === 'actor') command.actor = ''
    if (variant === 'unknown') command.authority = 'owner'
    expect(() => f.owner.eraseTest(command as never)).toThrow('invalid-command'); expect(f.owner.testCase(archived.id)).toEqual(archived)
  })
  it('fails closed on corrupt generation evidence instead of treating unknown references as zero', async () => {
    const f = await fixture(), archived = f.archive(f.draft), request = f.command(archived), db = new DatabaseSync(join(f.directory, 'runtime.sqlite'))
    try { db.prepare('INSERT INTO test_generations(id,record) VALUES(?,?)').run(randomUUID(), '{}') } finally { db.close() }
    expect(() => f.owner.eraseTest(request)).toThrow('corrupt'); expect(f.owner.testCase(archived.id)).toEqual(archived)
  })
  it.each(['missing-table', 'changed-receipt', 'recreated-case', 'missing-project'] as const)('refuses retained schema-18 %s corruption on reopen without repairing', async variant => {
    const f = await fixture(), archived = f.archive(f.draft), request = f.command(archived), history = f.owner.testHistory(archived.id)
    f.owner.eraseTest(request); await f.owner.close()
    const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'))
    try {
      if (variant === 'missing-table') db.exec('DROP TABLE test_erasures')
      if (variant === 'changed-receipt') db.prepare("UPDATE test_erasures SET record='{}'").run()
      if (variant === 'recreated-case') db.prepare('INSERT INTO test_cases(id,generation,record) VALUES(?,?,?)').run(archived.id, archived.generation, JSON.stringify(history))
      if (variant === 'missing-project') db.prepare('DELETE FROM projects WHERE id=?').run(f.project.id)
    } finally { db.close() }
    await expect(LocalRuntime.open({ dataDirectory: f.directory })).rejects.toMatchObject({ code: 'corrupt' })
  })
  it('migrates an original schema-17 fixture without losing draft or generated evidence', async () => {
    const f = await fixture(), batch = f.owner.generateTests({ id: randomUUID(), project: f.definition.project, limit: 1, actor })
    await f.owner.close(); const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'))
    try { db.exec('DROP TABLE test_erasures; PRAGMA user_version=17;') } finally { db.close() }
    const reopened = await LocalRuntime.open({ dataDirectory: f.directory }); closes.push(() => reopened.close())
    expect(reopened.testGeneration(batch.snapshot.id)).toEqual(batch); expect(reopened.testCase(f.draft.id)).toEqual(f.draft)
    const check = new DatabaseSync(join(f.directory, 'runtime.sqlite'))
    try { expect(check.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 18 }) } finally { check.close() }
  })
})

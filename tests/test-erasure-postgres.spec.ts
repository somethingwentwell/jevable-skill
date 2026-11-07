import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PostgresJournal, JournalError, type JournalBatch, type JournalCollection } from '../src/storage/postgres.ts'
import { PostgresRuntime } from '../src/runtime/postgres.ts'
import { PostgresTestStore } from '../src/testing/postgres-store.ts'
import { testHistorySha256 } from '../src/testing/erasure.ts'
import { parseNotificationConfig } from '../src/notifications/config.ts'
import { withDomainWrite } from '../src/storage/domain-owner.ts'
import type { TestCase, TestErasureRequest } from '../src/runtime/index.ts'

type Row = { collection: JournalCollection; key: string; version: string; deleted: boolean; value: unknown }
/** Domain/CAS test double ONLY; does not prove SQL locks, rollback or durability. */
class MemoryJournal {
  readonly controller = new AbortController()
  get signal() { return this.controller.signal }
  readonly rows = new Map<string, Row>()
  readonly audit: { sequence: string; batchId: string; collection: JournalCollection; key: string; kind: string; data: unknown }[] = []
  readonly receipts = new Map<string, unknown>()
  commits = 0
  fail?: 'conflict' | 'commit-uncertain'
  hook?: (collection: JournalCollection) => Promise<void>
  key(collection: JournalCollection, key: string) { return collection + '/' + key }
  async get(collection: JournalCollection, key: string) { await this.hook?.(collection); return structuredClone(this.rows.get(this.key(collection, key))) }
  async count(collection: JournalCollection) { return [...this.rows.values()].filter(r => r.collection === collection && !r.deleted).length }
  async testCaseIdentity(id: string) {
    const cases = [...this.rows.values()].filter(r => r.collection === 'test-cases' && r.key.toLowerCase() === id.toLowerCase())
    return { retained: cases.length > 0 || this.rows.has(this.key('test-erasure-subjects', id.toLowerCase())), live: cases.some(r => !r.deleted) }
  }
  async page(collection: JournalCollection, after?: string, limit = 100) {
    const rows = [...this.rows.values()].filter(r => r.collection === collection && !r.deleted && (after === undefined || r.key > after))
      .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    return { records: structuredClone(rows.slice(0, limit)), nextCursor: rows.length > limit ? rows[limit - 1]!.key : null }
  }
  async events(after = '0', limit = 100, collections?: JournalCollection[], key?: string) {
    const events = this.audit.filter(e => BigInt(e.sequence) > BigInt(after) && (!collections || collections.includes(e.collection)) && (key === undefined || e.key === key)).slice(0, limit)
    return { events: structuredClone(events), cursor: events.at(-1)?.sequence ?? after }
  }
  async receipt(id: string) { return structuredClone(this.receipts.get(id)) }
  async commit(batch: JournalBatch) {
    this.signal.throwIfAborted()
    if (this.fail === 'conflict' || this.receipts.has(batch.id)) throw new JournalError('conflict')
    for (const c of batch.changes) {
      const old = this.rows.get(this.key(c.collection, c.key))
      if ((old?.version ?? '0') !== c.expectedVersion || c.operation === 'delete' && (!old || old.deleted)) throw new JournalError('conflict')
    }
    const changes = batch.changes.map(c => ({ collection: c.collection, key: c.key, version: String(BigInt(c.expectedVersion) + 1n), deleted: c.operation === 'delete' }))
    for (const [index, c] of batch.changes.entries()) this.rows.set(this.key(c.collection, c.key), { ...changes[index]!, value: c.operation === 'put' ? structuredClone(c.value) : null })
    const eventSequences = []
    for (const event of batch.events) { const sequence = String(this.audit.length + 1); eventSequences.push(sequence); this.audit.push({ ...structuredClone(event), batchId: batch.id, sequence }) }
    const receipt = { id: batch.id, changes, eventSequences }; this.receipts.set(batch.id, receipt); this.commits++
    if (this.fail === 'commit-uncertain') { this.controller.abort(new JournalError('ownership-lost')); throw new JournalError('commit-uncertain') }
    return structuredClone(receipt)
  }
  async close() {}
}
const yaml = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8'), actor = 'fixture:erasure-owner'
const pin = (test: TestCase) => ({ id: test.id, generation: test.generation, sha256: test.sha256 })
async function fixture() {
  const fake = new MemoryJournal(), journal = fake as unknown as PostgresJournal
  // Private constructor only in this unit fixture; no production injected-journal bypass.
  const owner = Reflect.construct(PostgresRuntime, [journal, 10000, 10000, 4_000_000, parseNotificationConfig({})]) as PostgresRuntime
  const store = new PostgresTestStore(journal)
  const project = await owner.editProject({ operation: 'create', title: 'Synthetic erasure project', yaml, actor })
  const definition = { title: 'PRIVATE_CASE_TITLE', project: { id: project.id, generation: project.generation, revision: project.acceptedRevision },
    input: 'PRIVATE_CASE_INPUT', expectations: [{ kind: 'status' as const, value: 'completed' as const }] }
  const draft = await owner.editTest({ operation: 'create', definition, actor })
  const archive = (item: TestCase) => owner.editTest({ operation: 'archive', id: item.id, expectedGeneration: item.generation, reviewedSha256: item.sha256, archived: true, actor })
  const command = async (test: TestCase): Promise<TestErasureRequest> => ({ requestId: randomUUID(), test: pin(test),
    reviewedHistorySha256: testHistorySha256(await store.history(test.id)), actor })
  return { fake, journal, owner, store, project, definition, draft, archive, command }
}

describe('PostgreSQL SDK archived-draft removal domain (journal double, not SQL)', () => {
  it('preserves exact uppercase saved-case keys for owner reads and removal while refusing identity reuse', async () => {
    const f = await fixture(), id = randomUUID().toUpperCase()
    const draft = await f.owner.editTest({ operation: 'create', id, definition: f.definition, actor })
    expect(await f.owner.testCase(id)).toEqual(draft)
    expect(await f.owner.testHistory(id)).toEqual(await f.store.history(id))
    await expect(f.owner.testCase(id.toLowerCase())).rejects.toHaveProperty('code', 'not-found')
    const archived = await f.archive(draft), request = await f.command(archived)
    expect(await f.owner.testCase(id, 1)).toEqual(draft)
    expect((await f.owner.eraseTest(request)).test.id).toBe(id)
    expect((await f.owner.testErasure(request.requestId)).test.id).toBe(id)
    await expect(f.owner.testHistory(id)).rejects.toHaveProperty('code', 'not-found')
    await expect(f.owner.editTest({ operation: 'create', id: id.toLowerCase(), definition: f.definition, actor })).rejects.toHaveProperty('code', 'conflict')
    await f.owner.close()
  })
  it('preserves uppercase generation-batch keys and rejects malformed owner read IDs', async () => {
    const f = await fixture(), id = randomUUID().toUpperCase()
    const batch = await f.owner.generateTests({ id, project: f.definition.project, limit: 1, actor })
    expect(await f.owner.testGeneration(id)).toEqual(batch)
    await expect(f.owner.testGeneration(id.toLowerCase())).rejects.toHaveProperty('code', 'not-found')
    for (const read of [() => f.owner.testCase('bad'), () => f.owner.testHistory('bad'), () => f.owner.testGeneration('bad')]) {
      await expect(read()).rejects.toHaveProperty('code', 'invalid-command')
    }
    await f.owner.close()
  })
  it('retains one immutable metadata receipt/binding/audit alongside the case tombstone and observes exact retry', async () => {
    const f = await fixture(), archived = await f.archive(f.draft), request = await f.command(archived), before = f.fake.commits
    const receipt = await f.owner.eraseTest(request)
    expect(receipt).toMatchObject({ requestId: request.requestId, test: request.test, historySha256: request.reviewedHistorySha256, project: f.definition.project,
      status: 'logically-removed', securePhysicalErasure: false })
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE_CASE_'); expect(f.fake.commits).toBe(before + 1)
    expect(await f.fake.get('test-cases', f.draft.id)).toMatchObject({ deleted: true, value: null, version: String(archived.generation + 1) })
    expect(await f.owner.testCases()).toEqual({ tests: [], nextCursor: null })
    await expect(f.owner.testHistory(f.draft.id)).rejects.toHaveProperty('code', 'not-found')
    expect(await f.owner.testErasure(request.requestId.toUpperCase())).toEqual(receipt)
    expect(await f.owner.eraseTest(request)).toEqual(receipt); expect(f.fake.commits).toBe(before + 1)
    await new PostgresTestStore(f.journal).validateErasures()
    receipt.test.generation++; expect((await f.owner.testErasure(request.requestId)).test).toEqual(request.test)
  })
  it.each(['actor', 'generation', 'sha256', 'history', 'id', 'request'] as const)('refuses changed %s retries and normalized identity reuse', async variant => {
    const f = await fixture(), request = await f.command(await f.archive(f.draft)); await f.owner.eraseTest(request)
    const changed = structuredClone(request)
    if (variant === 'actor') changed.actor = 'other'
    if (variant === 'generation') changed.test.generation++
    if (variant === 'sha256') changed.test.sha256 = '0'.repeat(64)
    if (variant === 'history') changed.reviewedHistorySha256 = '0'.repeat(64)
    if (variant === 'id') changed.test.id = randomUUID()
    if (variant === 'request') changed.requestId = randomUUID()
    const before = f.fake.commits
    await expect(f.owner.eraseTest(changed)).rejects.toHaveProperty('code', 'conflict')
    for (const id of [f.draft.id, f.draft.id.toUpperCase()]) await expect(f.owner.editTest({ operation: 'create', id, definition: f.definition, actor })).rejects.toHaveProperty('code', 'conflict')
    expect(f.fake.commits).toBe(before)
  })
  it('refuses stale/full-history guards and live or previously accepted histories without commits', async () => {
    const f = await fixture(), live = await f.command(f.draft), before = f.fake.commits
    await expect(f.owner.eraseTest(live)).rejects.toHaveProperty('code', 'conflict'); expect(f.fake.commits).toBe(before)
    const accepted = await f.owner.editTest({ operation: 'accept', id: f.draft.id, expectedGeneration: 1, reviewedSha256: f.draft.sha256, actor })
    const archived = await f.archive(accepted), request = await f.command(archived), history = await f.owner.testHistory(archived.id)
    await expect(f.owner.eraseTest(request)).rejects.toHaveProperty('code', 'referenced')
    await expect(f.owner.eraseTest({ ...request, reviewedHistorySha256: '0'.repeat(64) })).rejects.toHaveProperty('code', 'conflict')
    expect(await f.owner.testHistory(archived.id)).toEqual(history)
  })
  it('preserves actual generated draft definitions and immutable batch evidence', async () => {
    const f = await fixture(), batch = await f.owner.generateTests({ id: randomUUID(), project: f.definition.project, limit: 1, actor })
    const generated = await f.owner.testCase(batch.snapshot.cases[0]!.id), request = await f.command(await f.archive(generated))
    await expect(f.owner.eraseTest(request)).rejects.toHaveProperty('code', 'referenced')
    expect(await f.owner.testGeneration(batch.snapshot.id)).toEqual(batch); expect(await f.owner.testCase(generated.id, 1)).toEqual(generated)
  })
  it('retains removal metadata as a project reference', async () => {
    const f = await fixture(), request = await f.command(await f.archive(f.draft)); await f.owner.eraseTest(request)
    const archived = await f.owner.editProject({ operation: 'archive', id: f.project.id, expectedGeneration: f.project.generation, archived: true, actor })
    await expect(f.owner.deleteProject(f.project.id, archived.generation, actor)).rejects.toHaveProperty('code', 'referenced')
    expect(await f.owner.testErasure(request.requestId)).toHaveProperty('project', f.definition.project)
  })
  it('holds the shared typed-write gate throughout live scanning and commit; competing same-pin removals conflict', async () => {
    const f = await fixture(), request = await f.command(await f.archive(f.draft)), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), order: string[] = []
    f.fake.hook = async collection => { if (collection === 'test-cases') { entered.resolve(); await release.promise } }
    const first = f.owner.eraseTest(request); await entered.promise
    const second = f.owner.eraseTest({ ...request, requestId: randomUUID() }), rejected = expect(second).rejects.toHaveProperty('code', 'conflict')
    const queued = withDomainWrite(f.journal, async () => { order.push('queued') })
    expect(order).toEqual([]); release.resolve(); await first; await rejected; await queued; expect(order).toEqual(['queued'])
  })
  it('does not save a receipt or tombstone on a CAS refusal', async () => {
    const f = await fixture(), archived = await f.archive(f.draft), request = await f.command(archived), before = f.fake.commits
    f.fake.fail = 'conflict'; await expect(f.owner.eraseTest(request)).rejects.toHaveProperty('code', 'conflict')
    expect(await f.owner.testCase(archived.id)).toEqual(archived); expect(await f.fake.get('test-erasures', request.requestId)).toBeUndefined()
    expect(f.fake.commits).toBe(before)
  })
  it.each(['receipt-hash', 'receipt-version', 'subject', 'tombstone', 'project', 'audit', 'batch', 'missing-both', 'live-alias'] as const)('fails closed on retained %s corruption', async damage => {
    const f = await fixture(), request = await f.command(await f.archive(f.draft)); await f.owner.eraseTest(request)
    if (damage === 'receipt-hash') (f.fake.rows.get(f.fake.key('test-erasures', request.requestId))!.value as { sha256: string }).sha256 = '0'.repeat(64)
    if (damage === 'receipt-version') f.fake.rows.get(f.fake.key('test-erasures', request.requestId))!.version = '2'
    if (damage === 'subject') f.fake.rows.delete(f.fake.key('test-erasure-subjects', request.test.id.toLowerCase()))
    if (damage === 'tombstone') f.fake.rows.get(f.fake.key('test-cases', request.test.id))!.version = '1'
    if (damage === 'project') f.fake.rows.delete(f.fake.key('projects', f.project.id))
    if (damage === 'audit') f.fake.audit.find(e => e.collection === 'test-erasures')!.batchId = randomUUID()
    if (damage === 'batch') f.fake.receipts.delete(request.requestId)
    if (damage === 'missing-both') { f.fake.rows.delete(f.fake.key('test-erasure-subjects', request.test.id.toLowerCase())); f.fake.rows.delete(f.fake.key('test-erasures', request.requestId)) }
    if (damage === 'live-alias') f.fake.rows.set(f.fake.key('test-cases', request.test.id.toUpperCase()), { collection: 'test-cases', key: request.test.id.toUpperCase(), version: '1', deleted: false, value: {} })
    await expect(f.store.validateErasures()).rejects.toHaveProperty('code', 'corrupt')
  })
  it('fails closed on corrupt run references instead of treating unknown references as zero', async () => {
    const f = await fixture(), archived = await f.archive(f.draft), request = await f.command(archived), id = randomUUID()
    f.fake.rows.set(f.fake.key('runs', id), { collection: 'runs', key: id, version: '1', deleted: false, value: {} })
    await expect(f.owner.eraseTest(request)).rejects.toHaveProperty('code', 'corrupt')
    expect(await f.owner.testCase(archived.id)).toEqual(archived); expect(await f.fake.get('test-erasures', request.requestId)).toBeUndefined()
  })
  it('rejects owner loss before admission without erasing any retained evidence', async () => {
    const f = await fixture(), request = await f.command(await f.archive(f.draft)), before = f.fake.commits
    f.fake.controller.abort(new JournalError('ownership-lost'))
    await expect(f.store.erase(request)).rejects.toHaveProperty('code', 'ownership-lost'); expect(f.fake.commits).toBe(before)
  })
})

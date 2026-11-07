import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PostgresNotificationStore } from '../src/notifications/postgres-store.ts'
import { PostgresJournal, JournalError, type JournalBatch, type JournalCollection } from '../src/storage/postgres.ts'
import { withDomainWrite } from '../src/storage/domain-owner.ts'
import { notificationSha256, inspectNotificationRecord, type NotificationRecord } from '../src/notifications/schema.ts'
import { WorkflowRuntimeError } from '../src/runtime/errors.ts'
import { projectNotificationRecords } from '../src/notifications/project-history.ts'

/** Domain/CAS test double only. Actual SQL ownership, transactions and durability need the real PostgreSQL qualifier. */
class MemoryJournal {
  readonly abort = new AbortController()
  get signal() { return this.abort.signal }
  rows = new Map<string, { collection: JournalCollection; key: string; version: string; deleted: boolean; value: unknown }>()
  audit: { sequence: string; collection: JournalCollection; key: string; kind: string; data: unknown }[] = []
  fail?: 'conflict' | 'commit-uncertain'
  async get(collection: JournalCollection, key: string) { return structuredClone(this.rows.get(JSON.stringify([collection, key]))) }
  async count(collection: JournalCollection) { return [...this.rows.values()].filter(r => r.collection === collection && !r.deleted).length }
  async page(collection: JournalCollection, after?: string, limit = 100) {
    const rows = [...this.rows.values()].filter(r => r.collection === collection && !r.deleted && (after === undefined || r.key > after))
      .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    return { records: structuredClone(rows.slice(0, limit)), nextCursor: rows.length > limit ? rows[limit - 1]!.key : null }
  }
  async events(after = '0', limit = 100, kinds?: JournalCollection[]) {
    const events = structuredClone(this.audit.filter(e => BigInt(e.sequence) > BigInt(after) && (!kinds || kinds.includes(e.collection))).slice(0, limit))
    return { events, cursor: events.at(-1)?.sequence ?? after }
  }
  async commit(batch: JournalBatch) {
    this.signal.throwIfAborted()
    if (this.fail === 'conflict') throw new JournalError('conflict')
    for (const change of batch.changes) if ((await this.get(change.collection, change.key))?.version !== (change.expectedVersion === '0' ? undefined : change.expectedVersion))
      throw new JournalError('conflict')
    for (const change of batch.changes) this.rows.set(JSON.stringify([change.collection, change.key]), {
      collection: change.collection, key: change.key, version: String(BigInt(change.expectedVersion) + 1n),
      deleted: change.operation === 'delete', value: change.operation === 'put' ? structuredClone(change.value) : null,
    })
    for (const event of batch.events) this.audit.push({ ...structuredClone(event), sequence: String(this.audit.length + 1) })
    if (this.fail === 'commit-uncertain') throw new JournalError('commit-uncertain')
  }
}
function record(previous?: NotificationRecord): NotificationRecord {
  const pin = previous ? { runId: previous.request.runId, revision: previous.request.revision, attemptId: previous.request.attemptId }
    : { runId: randomUUID(), revision: 'a'.repeat(64), attemptId: randomUUID() }
  const core = { source: 'urn:jevable:workflow-runtime', type: 'ai.jevable.approval.requested', time: '2026-10-01T00:00:00.000Z',
    data: { ...pin, nodeId: 'approval', expiresAt: '2026-10-02T00:00:00.000Z' } }
  const event = { specversion: '1.0', id: notificationSha256(core), source: core.source, type: core.type,
    time: core.time, datacontenttype: 'application/json', data: core.data }
  return inspectNotificationRecord({ schemaVersion: 1, request: { ...pin, requestId: randomUUID(), endpointId: 'review',
    endpointSha256: 'b'.repeat(64), eventSha256: notificationSha256(event), ...(previous ? { redeliverOf: previous.request.requestId } : {}) },
  event, actor: 'operator', createdAt: '2026-10-01T01:00:00.000Z', credentialGeneration: 1, outcome: { status: 'pending' } })
}
const settled = (value: NotificationRecord): NotificationRecord => ({ ...structuredClone(value), outcome: {
  status: 'settled', at: '2026-10-01T01:00:01.000Z', result: { status: 'accepted', httpStatus: 202 },
} })
function fixture(policy = { maxDeliveries: 100, maxEvents: 200 }, checks = {}) {
  const fake = new MemoryJournal(), journal = fake as unknown as PostgresJournal
  return { fake, journal, store: new PostgresNotificationStore(journal, policy, checks) }
}
describe('PostgreSQL notification domain adapter', () => {
  it('filters exact historical projects through verified PostgreSQL adapter pages without writes', async () => {
    const history = vi.fn(async () => {}), { store, fake } = fixture(undefined, { history })
    const project = { id: randomUUID(), generation: 3, revision: 'a'.repeat(64) }
    const selected: NotificationRecord[] = [], foreign: NotificationRecord[] = []
    for (let i = 0; i < 5; i++) {
      const original = record(), data = { ...original.event.data, project: { id: project.id, generation: i % 2 ? 2 : 3 } }
      const core = { source: original.event.source, type: original.event.type, time: original.event.time, data }
      const event = { ...original.event, ...core, id: notificationSha256(core) }
      const r = inspectNotificationRecord({ ...original, event, request: { ...original.request, eventSha256: notificationSha256(event) } })
      await store.createIntent(r); (i % 2 ? foreign : selected).push(r)
    }
    selected.sort((a, b) => a.request.requestId < b.request.requestId ? -1 : 1)
    const before = structuredClone(fake.audit), first = await projectNotificationRecords(store, project, { limit: 2 })
    expect(first).toEqual({ records: selected.slice(0, 2), nextCursor: selected[1]!.request.requestId })
    expect(await projectNotificationRecords(store, project, { after: first.nextCursor!, limit: 2 }))
      .toEqual({ records: selected.slice(2), nextCursor: null })
    await expect(projectNotificationRecords(store, project, { after: foreign[0]!.request.requestId }))
      .rejects.toHaveProperty('code', 'not-found')
    expect(history.mock.calls.length).toBeGreaterThanOrEqual(5); expect(fake.audit).toEqual(before)
    history.mockRejectedValue(new WorkflowRuntimeError('corrupt'))
    await expect(projectNotificationRecords(store, project, {})).rejects.toHaveProperty('code', 'corrupt')
  })
  it('pages bounded UUID keysets with verified history, no writes and stable settlement order', async () => {
    const history = vi.fn(async () => {}), { store, fake } = fixture(undefined, { history })
    const records = [record(), record(), record()].sort((a, b) => a.request.requestId < b.request.requestId ? -1 : 1)
    for (const r of [...records].reverse()) await store.createIntent(r)
    const before = structuredClone(fake.audit), first = await store.page({ limit: 2 })
    expect(first.records).toEqual(records.slice(0, 2)); expect(first.nextCursor).toBe(records[1]!.request.requestId)
    expect(history).toHaveBeenCalledTimes(2); expect(fake.audit).toEqual(before)
    await store.settle(settled(records[0]!))
    const last = await store.page({ after: first.nextCursor!, limit: 2 })
    expect(last).toEqual({ records: [records[2]], nextCursor: null })
    expect(await store.page({ after: records[2]!.request.requestId })).toEqual({ records: [], nextCursor: null })
    await expect(store.page({ after: randomUUID() })).rejects.toHaveProperty('code', 'not-found')
    expect(() => store.page({ limit: 201 })).toThrow()
    history.mockRejectedValue(new WorkflowRuntimeError('corrupt'))
    await expect(store.page({})).rejects.toHaveProperty('code', 'corrupt')
  })
  it('holds the shared gate for history reads and detaches page options before awaiting', async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), order: string[] = []
    const { store, journal } = fixture(undefined, { history: async () => { entered.resolve(); await release.promise; order.push('read') } })
    await store.createIntent(record()); await store.createIntent(record())
    const options = { limit: 1 }, page = store.page(options); options.limit = 200
    await entered.promise
    const write = withDomainWrite(journal, async () => { order.push('write') })
    expect(order).toEqual([]); release.resolve()
    expect((await page).records).toHaveLength(1); await write; expect(order).toEqual(['read', 'write'])
  })
  it.each(['key', 'version'])('refuses corrupt paged row %s without returning a partial page', async damage => {
    const { store, fake } = fixture(), first = record(); await store.createIntent(first)
    const row = [...fake.rows.values()].find(r => r.collection === 'approval-deliveries')!
    if (damage === 'key') row.key = randomUUID(); else row.version = '2'
    await expect(store.page({})).rejects.toHaveProperty('code', 'corrupt')
  })
  it('atomically stores intent, predecessor head and audit; settles once and validates a reopened adapter', async () => {
    const { store, fake, journal } = fixture(), first = record()
    expect(await store.createIntent(first)).toBe(true); expect(await store.createIntent(first)).toBe(false)
    await store.settle(settled(first)); await store.settle(settled(first))
    const second = record(first); second.credentialGeneration = 2
    await store.createIntent(second); await store.settle(settled(second)); await store.validate()
    expect(fake.audit.map(e => e.kind)).toEqual(['intent', 'settled', 'intent', 'settled'])
    expect(await store.get(first.request.requestId)).toEqual(settled(first))
    await new PostgresNotificationStore(journal, { maxDeliveries: 100, maxEvents: 200 }).validate()
  })
  it('serializes concurrent initial requests and requires the latest predecessor', async () => {
    const { store } = fixture(), first = record(), rival = structuredClone(first); rival.request.requestId = randomUUID()
    const results = await Promise.allSettled([store.createIntent(first), store.createIntent(rival)])
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected'])
    const second = record(first); await store.createIntent(second)
    await expect(store.createIntent(record(first))).rejects.toHaveProperty('code', 'conflict')
    await store.validate()
  })
  it('holds the shared run-write gate during admission and releases it after failed checks', async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), order: string[] = []
    const { store, journal, fake } = fixture(undefined, { admission: async () => {
      order.push('check'); entered.resolve(); await release.promise; throw new WorkflowRuntimeError('conflict')
    } })
    const admitted = store.createIntent(record()); const rejected = expect(admitted).rejects.toHaveProperty('code', 'conflict')
    await entered.promise
    const write = withDomainWrite(journal, async () => { order.push('run-change') })
    expect(order).toEqual(['check']); release.resolve(); await rejected; await write
    expect(order).toEqual(['check', 'run-change']); expect(fake.audit).toHaveLength(0)
  })
  it('detaches caller input before waiting for admission', async () => {
    const { store } = fixture(), first = record(), before = structuredClone(first)
    const intent = store.createIntent(first); first.actor = 'changed'; await intent
    expect(await store.get(first.request.requestId)).toEqual(before)
  })
  it.each([{ maxDeliveries: 1, maxEvents: 100 }, { maxDeliveries: 100, maxEvents: 2 }])('reserves settlement capacity with %j', async policy => {
    const { store } = fixture(policy), first = record(); await store.createIntent(first)
    await expect(store.createIntent(record())).rejects.toHaveProperty('code', 'limit')
    await store.settle(settled(first)); await store.validate()
  })
  it('preserves uncertain commits as receipts instead of new admissions', async () => {
    const { store, fake } = fixture(), first = record(); fake.fail = 'commit-uncertain'
    await expect(store.createIntent(first)).rejects.toHaveProperty('code', 'commit-uncertain')
    delete fake.fail; expect(await store.createIntent(first)).toBe(false); await store.validate()
    expect(fake.audit).toHaveLength(1)
  })
  it('does not rewrite terminal receipts or immutable intent fields', async () => {
    const { store } = fixture(), first = record(); await store.createIntent(first)
    await expect(store.settle({ ...settled(first), actor: 'changed' })).rejects.toHaveProperty('code', 'conflict')
    await store.settle(settled(first))
    await expect(store.settle({ ...settled(first), outcome: { status: 'settled', at: '2026-10-01T02:00:00.000Z',
      result: { status: 'rejected', httpStatus: 400 } } })).rejects.toHaveProperty('code', 'conflict')
  })
  it('checks historical associations on reads, settlement and activation', async () => {
    const history = vi.fn(async () => {}), { store } = fixture(undefined, { history }), first = record()
    await store.createIntent(first); await store.get(first.request.requestId); await store.settle(settled(first)); await store.validate()
    expect(history).toHaveBeenCalledTimes(3)
    history.mockRejectedValue(new WorkflowRuntimeError('corrupt'))
    await expect(store.get(first.request.requestId)).rejects.toHaveProperty('code', 'corrupt')
  })
  it.each(['missing-intent', 'missing-settlement', 'duplicate-settlement', 'altered-actor', 'bad-version', 'bad-head', 'orphan-head', 'orphan-snapshot', 'deleted'])(
    'refuses damaged retained history: %s', async damage => {
      const { store, fake } = fixture(), first = record(); await store.createIntent(first); await store.settle(settled(first))
      const row = [...fake.rows.values()].find(r => r.collection === 'approval-deliveries')!
      const head = [...fake.rows.values()].find(r => r.collection === 'approval-delivery-subjects')!
      if (damage === 'missing-intent') fake.audit.shift()
      if (damage === 'missing-settlement') fake.audit.pop()
      if (damage === 'duplicate-settlement') fake.audit.push({ ...structuredClone(fake.audit[1]!), sequence: '3' })
      if (damage === 'altered-actor') (fake.audit[0]!.data as NotificationRecord).actor = 'changed'
      if (damage === 'bad-version') row.version = '3'
      if (damage === 'bad-head') (head.value as { requestId: string }).requestId = randomUUID()
      if (damage === 'orphan-head') fake.rows.set('extra-head', { ...head, key: 'c'.repeat(64) })
      if (damage === 'orphan-snapshot') fake.rows.set('extra-row', { ...row, key: randomUUID() })
      if (damage === 'deleted') row.deleted = true
      await expect(store.validate()).rejects.toHaveProperty('code', 'corrupt')
    })
  it('stops when journal ownership is lost without reconnecting', async () => {
    const { store, fake } = fixture(); fake.abort.abort(new JournalError('ownership-lost'))
    await expect(store.createIntent(record())).rejects.toHaveProperty('code', 'ownership-lost')
    expect(fake.audit).toHaveLength(0)
  })
  it('validates multi-page histories and predecessor chains with decimal sequences beyond Number precision', async () => {
    const { store, fake } = fixture({ maxDeliveries: 200, maxEvents: 400 })
    let previous: NotificationRecord | undefined
    for (let i = 0; i < 125; i++) {
      const next = record(previous); await store.createIntent(next); await store.settle(settled(next)); previous = next
    }
    for (const [index, event] of fake.audit.entries()) event.sequence = String(9007199254741000n + BigInt(index) * 3n)
    await store.validate()
    expect(fake.audit).toHaveLength(250)
    expect(await store.get(previous!.request.requestId)).toEqual(settled(previous!))
  })
  it('refuses activation after lowering limits below retained delivery reservations', async () => {
    const { store, journal } = fixture(), first = record()
    await store.createIntent(first); await store.createIntent(record(first))
    await expect(new PostgresNotificationStore(journal, { maxDeliveries: 100, maxEvents: 2 }).validate()).rejects.toHaveProperty('code', 'limit')
  })
  it('rejects a rewritten redelivery fork even when its snapshot matches its own audit', async () => {
    const { store, fake } = fixture(), first = record(), second = record(first), third = record(second)
    await store.createIntent(first); await store.createIntent(second); await store.createIntent(third)
    const row = [...fake.rows.values()].find(r => r.key === third.request.requestId)!
    ;(row.value as NotificationRecord).request.redeliverOf = first.request.requestId
    ;(fake.audit[2]!.data as NotificationRecord).request.redeliverOf = first.request.requestId
    await expect(store.validate()).rejects.toHaveProperty('code', 'corrupt')
  })
})

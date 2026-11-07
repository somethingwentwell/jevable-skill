import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID, createHmac } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { LocalRuntime } from '../src/runtime/local.ts'
import { RunStore } from '../src/runtime/store.ts'
import { PostgresJournal, JournalError, type JournalBatch, type JournalCollection } from '../src/storage/postgres.ts'
import { withDomainWrite } from '../src/storage/domain-owner.ts'
import { CommittedApprovalCapture } from '../src/notifications/committed-approvals.ts'
import { PostgresAutomaticAdmissionStore } from '../src/notifications/automatic-postgres-store.ts'
import { automaticAdmissionFailed, automaticDeliveryRecorded, inspectAutomaticAdmission, prepareAutomaticAdmission,
  type AutomaticAdmissionLimits, type AutomaticAdmissionRecord } from '../src/notifications/automatic-admission.ts'
import { inspectNotificationRecord, notificationSha256, verifyApprovalEventHistory } from '../src/notifications/schema.ts'
import { WorkflowRuntimeError } from '../src/runtime/errors.ts'

const yaml = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const at = '2026-10-02T00:00:00.000Z', later = '2026-10-02T00:00:01.000Z'
const collection = 'approval-automatic-admissions' as const
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); for (const close of cleanups.splice(0).reverse()) await close() })

/** Ledger CAS/domain double only: no claim of actual PostgreSQL transactions, fencing or durability. */
class JournalDouble {
  readonly controller = new AbortController()
  get signal() { return this.controller.signal }
  readonly rows = new Map<string, { collection: JournalCollection; key: string; version: string; deleted: boolean; value: unknown }>()
  readonly audit: (JournalBatch['events'][number] & { sequence: string; batchId: string })[] = []
  fail: 'before' | 'after' | undefined
  async get(_collection: JournalCollection, key: string) { return structuredClone(this.rows.get(key)) }
  async count(_collection: JournalCollection) { return this.rows.size }
  async page(_collection: JournalCollection, after?: string, limit = 100) {
    const rows = [...this.rows.values()].filter(row => after === undefined || row.key > after).sort((a, b) => a.key < b.key ? -1 : 1)
    return { records: structuredClone(rows.slice(0, limit)), nextCursor: rows.length > limit ? rows[limit - 1]!.key : null }
  }
  async events(after: string, limit: number, _collections: JournalCollection[]) {
    const events = structuredClone(this.audit.filter(event => BigInt(event.sequence) > BigInt(after)).slice(0, limit))
    return { events, cursor: events.at(-1)?.sequence ?? after }
  }
  async commit(batch: JournalBatch) {
    this.signal.throwIfAborted()
    if (this.fail === 'before') { this.fail = undefined; throw new JournalError('conflict') }
    for (const change of batch.changes) if ((this.rows.get(change.key)?.version ?? '0') !== change.expectedVersion) throw new JournalError('conflict')
    for (const change of batch.changes) {
      if (change.operation !== 'put') throw new Error('fixture puts only')
      this.rows.set(change.key, { collection: change.collection, key: change.key, version: String(BigInt(change.expectedVersion) + 1n),
        deleted: false, value: structuredClone(change.value) })
    }
    for (const event of batch.events) this.audit.push({ ...structuredClone(event), sequence: String(this.audit.length + 1), batchId: batch.id })
    if (this.fail === 'after') { this.fail = undefined; throw new JournalError('commit-uncertain') }
  }
}
async function fixture(backend: 'sqlite' | 'postgres-double', limits: AutomaticAdmissionLimits = { maxAdmissions: 100, maxEvents: 200 },
  url = 'http://127.0.0.1:9/never-dispatched') {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at)
  const directory = await mkdtemp(join(tmpdir(), 'jevable-automatic-admission-'))
  const owner = await LocalRuntime.open({ dataDirectory: directory,
    notifications: { endpoints: [{ id: 'review', url, credentialRef: 'notification/key', timeoutMs: 1000 }] } })
  cleanups.push(() => owner.close())
  const runStore = (owner as unknown as { store: RunStore }).store
  const project = owner.editProject({ operation: 'create', title: 'Review', yaml, actor: 'PRIVATE_OWNER' })
  const destinations = owner.notificationDestinations(), destination = destinations[0]!
  const policy = { format: 'jevable.ai/automatic-approval-policy/v1', routes: [{
    scope: { kind: 'project', id: project.id, generation: project.generation, revision: project.acceptedRevision },
    endpointId: destination.id, endpointSha256: destination.endpointSha256, eventKinds: ['requested', 'decided', 'expired', 'cancelled'],
  }] }
  const capture = new CommittedApprovalCapture(policy, destinations)
  runStore.observeCommittedApprovals(capture)
  const source = async () => {
    const run = await owner.runProject(project.id, project.generation, project.acceptedRevision, { message: 'PRIVATE_REVIEW_VALUE' })
    const candidate = capture.snapshot().candidates.find(value => value.event.data.runId === run.id)!
    if (!candidate) throw new Error('missing committed candidate')
    return prepareAutomaticAdmission(policy, candidate.event, destinations, candidate.plan.requests[0]!, at)
  }
  const first = await source(), db = (runStore as unknown as { db: DatabaseSync }).db
  const notificationStore = runStore.notificationStore({ maxDeliveries: 100000, maxEvents: 200000 })
  const journal = new JournalDouble()
  const checks = {
    history: async (record: AutomaticAdmissionRecord) => {
      const run = runStore.get(record.request.runId)
      if (!run) throw new WorkflowRuntimeError('corrupt')
      verifyApprovalEventHistory(record.event, record.createdAt, run, runStore.events(run.id))
    },
    delivery: async (id: string) => notificationStore.get(id),
  }
  const ledger = backend === 'sqlite' ? runStore.automaticAdmissionStore(limits, true)
    : new PostgresAutomaticAdmissionStore(journal as unknown as PostgresJournal, limits, checks)
  const delivery = (record = first) => inspectNotificationRecord({ schemaVersion: 1, request: record.request, event: record.event,
    actor: `automatic:${record.policySha256}`, credentialGeneration: 1, createdAt: at, outcome: { status: 'pending' } })
  return { owner, directory, runStore, ledger, journal, db, first, source, delivery, notificationStore, checks }
}

describe('durable automatic approval admission; not a recovered send queue', () => {
  for (const backend of ['sqlite', 'postgres-double'] as const) {
    it(`${backend}: reserves once, refuses reset/retarget and keeps identical terminal retry read-only`, async () => {
      const f = await fixture(backend), original = structuredClone(f.first)
      expect(await f.ledger.create(f.first)).toBe(true)
      expect(await f.ledger.create(f.first)).toBe(false)
      const failed = automaticAdmissionFailed(f.first, 'busy', later)
      await f.ledger.settle(failed); await f.ledger.settle(failed)
      expect(await f.ledger.get(f.first.request.requestId)).toEqual(failed)
      expect(await f.ledger.create(f.first)).toBe(false)
      const reset = Promise.resolve().then(() => f.ledger.settle(f.first))
      await expect(reset).rejects.toHaveProperty('code', 'conflict')
      await expect(Promise.resolve().then(() => f.ledger.settle(automaticAdmissionFailed(f.first, 'closed', later))))
        .rejects.toHaveProperty('code', 'conflict')
      expect(f.first).toEqual(original)
      await f.ledger.validate()
      expect(JSON.stringify(failed)).not.toMatch(/PRIVATE_|whsec_|credentialRef|url|yaml|message/)
    })
    it(`${backend}: can persist a capacity/admission refusal without pretending delivery happened`, async () => {
      const f = await fixture(backend), failed = { ...f.first, outcome: { status: 'failed' as const, at, code: 'busy' as const } }
      expect(await f.ledger.create(failed)).toBe(true)
      expect(await f.ledger.create(failed)).toBe(false)
      expect(await f.ledger.get(failed.request.requestId)).toEqual(failed)
      await f.ledger.validate()
      expect(f.notificationStore.page({}).records).toEqual([])
    })
    it(`${backend}: reserves audit capacity and pages detached stable UUID keys without writes`, async () => {
      const f = await fixture(backend, { maxAdmissions: 2, maxEvents: 4 }), second = await f.source(), third = await f.source()
      await f.ledger.create(f.first); await f.ledger.create(second)
      await expect(Promise.resolve().then(() => f.ledger.create(third))).rejects.toHaveProperty('code', 'limit')
      const ids = [f.first.request.requestId, second.request.requestId].sort()
      const page = await f.ledger.page({ limit: 1 })
      expect(page.records[0]!.request.requestId).toBe(ids[0]); expect(page.nextCursor).toBe(ids[0])
      page.records[0]!.outcome = { status: 'failed', at: later, code: 'closed' }
      const first = await f.ledger.get(ids[0]!)
      expect(first?.outcome.status).toBe('reserved')
      await f.ledger.settle(automaticAdmissionFailed(first!, 'busy', later))
      expect((await f.ledger.page({ after: ids[0]!, limit: 1 })).records[0]!.request.requestId).toBe(ids[1])
      expect(await f.ledger.page({ after: ids[1]!, limit: 1 })).toEqual({ records: [], nextCursor: null })
      await expect(Promise.resolve().then(() => f.ledger.page({ after: randomUUID() }))).rejects.toHaveProperty('code', 'not-found')
      await expect(Promise.resolve().then(() => f.ledger.page({ limit: 201 }))).rejects.toHaveProperty('code', 'invalid-command')
      await f.ledger.validate()
    })
    it(`${backend}: joins a real retained dispatcher intent and refuses invented/mismatched delivery evidence`, async () => {
      const f = await fixture(backend), pending = f.delivery()
      await f.ledger.create(f.first)
      f.notificationStore.createIntent(pending)
      const invented = automaticDeliveryRecorded(f.first, { ...pending, credentialGeneration: 2 }, later)
      await expect(Promise.resolve().then(() => f.ledger.settle(invented))).rejects.toHaveProperty('code', 'corrupt')
      const recorded = automaticDeliveryRecorded(f.first, pending, later)
      await f.ledger.settle(recorded); await f.ledger.validate()
      expect((await f.ledger.get(f.first.request.requestId))?.outcome).toMatchObject({ status: 'delivery-recorded', deliveryStatus: 'pending' })
      // This is actual retained SQLite intent metadata, NOT proof that any transport was attempted.
      const original = f.db.prepare('SELECT record FROM approval_deliveries WHERE id=?').get(pending.request.requestId)!.record as string
      f.db.prepare('UPDATE approval_deliveries SET record=? WHERE id=?').run(JSON.stringify({ ...pending, actor: 'PRIVATE_OTHER_ACTOR' }), pending.request.requestId)
      await expect(Promise.resolve().then(() => f.ledger.get(f.first.request.requestId))).rejects.toHaveProperty('code', 'corrupt')
      f.db.prepare('UPDATE approval_deliveries SET record=? WHERE id=?').run(original, pending.request.requestId)
      await f.ledger.validate()
    })
    it(`${backend}: history refusal rolls back admission without modifying the workflow or delivery journal`, async () => {
      const f = await fixture(backend), before = await f.owner.events(f.first.request.runId)
      if (backend === 'sqlite') {
        const events = f.runStore.events.bind(f.runStore)
        vi.spyOn(f.runStore, 'events').mockImplementation(() => [])
        await expect(Promise.resolve().then(() => f.ledger.create(f.first))).rejects.toHaveProperty('code', 'corrupt')
        vi.restoreAllMocks(); expect(f.runStore.events(f.first.request.runId)).toEqual(events(f.first.request.runId))
      } else f.checks.history = async () => { throw new WorkflowRuntimeError('corrupt') }
      if (backend !== 'sqlite') await expect(Promise.resolve().then(() => f.ledger.create(f.first))).rejects.toHaveProperty('code', 'corrupt')
      expect(await f.owner.events(f.first.request.runId)).toEqual(before)
      expect(f.notificationStore.page({}).records).toEqual([])
      if (backend === 'sqlite') expect(f.db.prepare('SELECT count(*) AS n FROM automatic_approval_admissions').get()!.n).toBe(0)
      else expect(f.journal.rows.size).toBe(0)
    })
  }
  it('SQLite capability migration is explicit, validates before effects and is never downgraded on policy-free reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-automatic-schema-')), owner = await LocalRuntime.open({ dataDirectory: directory })
    cleanups.push(() => owner.close())
    const store = (owner as unknown as { store: RunStore }).store, db = (store as unknown as { db: DatabaseSync }).db
    expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(18)
    expect(() => store.automaticAdmissionStore({ maxAdmissions: 1, maxEvents: 2 })).toThrow('not-found')
    expect(() => store.automaticAdmissionStore({ maxAdmissions: 0, maxEvents: 2 }, true)).toThrow('invalid-command')
    expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(18)
    store.automaticAdmissionStore({ maxAdmissions: 1, maxEvents: 2 }, true)
    expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(19)
    await owner.close()
    const reopened = await LocalRuntime.open({ dataDirectory: directory }); cleanups.push(() => reopened.close())
    const next = (reopened as unknown as { store: RunStore }).store
    expect((next as unknown as { db: DatabaseSync }).db.prepare('PRAGMA user_version').get()!.user_version).toBe(19)
    expect(next.automaticAdmissionStore({ maxAdmissions: 1, maxEvents: 2 }).page()).toEqual({ records: [], nextCursor: null })
  })
  it('SQLite missing schema-19 tables refuse reopen rather than repair; migration DDL failure rolls back', async () => {
    const f = await fixture('sqlite')
    await f.ledger.create(f.first)
    f.db.exec('DROP TABLE automatic_approval_events')
    await f.owner.close()
    await expect(LocalRuntime.open({ dataDirectory: f.directory })).rejects.toHaveProperty('code', 'corrupt')
    const inspect = new DatabaseSync(join(f.directory, 'runtime.sqlite'))
    try {
      expect(inspect.prepare("SELECT name FROM sqlite_master WHERE name='automatic_approval_events'").get()).toBeUndefined()
      expect(inspect.prepare('PRAGMA user_version').get()!.user_version).toBe(19)
    } finally { inspect.close() }
    const directory = await mkdtemp(join(tmpdir(), 'jevable-automatic-schema-refusal-')), owner = await LocalRuntime.open({ dataDirectory: directory })
    cleanups.push(() => owner.close())
    const store = (owner as unknown as { store: RunStore }).store, db = (store as unknown as { db: DatabaseSync }).db
    db.exec('CREATE VIEW automatic_approval_admissions AS SELECT id FROM runs')
    expect(() => store.automaticAdmissionStore({ maxAdmissions: 1, maxEvents: 2 }, true)).toThrow()
    expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(18)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='automatic_approval_events'").get()).toBeUndefined()
  })
  it('SQLite lost admission acknowledgement retains a reserved receipt and never creates another intent on retry/reopen', async () => {
    const f = await fixture('sqlite'), exec = f.db.exec.bind(f.db)
    vi.spyOn(f.db, 'exec').mockImplementation(sql => {
      const result = exec(sql)
      if (sql === 'COMMIT') throw new Error('fixture lost acknowledgement after actual commit')
      return result
    })
    expect(() => f.ledger.create(f.first)).toThrow('fixture lost acknowledgement')
    vi.restoreAllMocks()
    expect((await f.ledger.get(f.first.request.requestId))?.outcome.status).toBe('reserved')
    expect(await f.ledger.create(f.first)).toBe(false)
    const audit = f.db.prepare('SELECT * FROM automatic_approval_events').all()
    await f.owner.close()
    const reopened = await LocalRuntime.open({ dataDirectory: f.directory }); cleanups.push(() => reopened.close())
    const store = (reopened as unknown as { store: RunStore }).store, ledger = store.automaticAdmissionStore({ maxAdmissions: 100, maxEvents: 200 })
    expect(await ledger.get(f.first.request.requestId)).toEqual(f.first)
    expect((store as unknown as { db: DatabaseSync }).db.prepare('SELECT * FROM automatic_approval_events').all()).toEqual(audit)
    expect(store.notificationStore({ maxDeliveries: 100, maxEvents: 200 }).page({}).records).toEqual([])
  })
  it.each(['before', 'after'] as const)('PostgreSQL %s admission acknowledgement failure creates no replay authorization', async fail => {
    const f = await fixture('postgres-double'); f.journal.fail = fail
    await expect(f.ledger.create(f.first)).rejects.toHaveProperty('code', fail === 'before' ? 'conflict' : 'commit-uncertain')
    expect(f.journal.rows.size).toBe(fail === 'before' ? 0 : 1)
    if (fail === 'after') {
      const before = structuredClone(f.journal.audit)
      expect(await f.ledger.create(f.first)).toBe(false)
      expect(f.journal.audit).toEqual(before)
      expect((await f.ledger.get(f.first.request.requestId))?.outcome.status).toBe('reserved')
      await f.ledger.validate()
    }
    expect(f.notificationStore.page({}).records).toEqual([])
  })
  it('PostgreSQL domain serializes simultaneous same-ID creation and capacity; admission clones before await', async () => {
    const f = await fixture('postgres-double', { maxAdmissions: 1, maxEvents: 2 }), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const journal = f.journal as unknown as PostgresJournal
    const gate = withDomainWrite(journal, async () => { entered.resolve(); await release.promise })
    await entered.promise
    const original = structuredClone(f.first), creating = f.ledger.create(f.first)
    f.first.createdAt = later
    release.resolve(); await gate
    expect(await creating).toBe(true)
    expect(await f.ledger.get(original.request.requestId)).toEqual(original)
    expect(await Promise.all([f.ledger.create(original), f.ledger.create(original)])).toEqual([false, false])
    const second = await f.source()
    await expect(f.ledger.create(second)).rejects.toHaveProperty('code', 'limit')
    f.journal.controller.abort()
    await expect(f.ledger.get(original.request.requestId)).rejects.toHaveProperty('name', 'AbortError')
    expect(f.journal.rows.size).toBe(1)
  })
  for (const backend of ['sqlite', 'postgres-double'] as const) it(`${backend}: lost settlement acknowledgement retains the exact terminal record without reset`, async () => {
    const f = await fixture(backend), terminal = automaticAdmissionFailed(f.first, 'uncertain', later)
    await f.ledger.create(f.first)
    if (backend === 'sqlite') {
      const exec = f.db.exec.bind(f.db)
      vi.spyOn(f.db, 'exec').mockImplementation(sql => {
        const result = exec(sql)
        if (sql === 'COMMIT') throw new JournalError('commit-uncertain')
        return result
      })
    } else f.journal.fail = 'after'
    await expect(Promise.resolve().then(() => f.ledger.settle(terminal))).rejects.toHaveProperty('code', 'commit-uncertain')
    vi.restoreAllMocks()
    expect(await f.ledger.get(f.first.request.requestId)).toEqual(terminal)
    await f.ledger.settle(terminal); await f.ledger.validate()
    if (backend === 'sqlite') expect(f.db.prepare('SELECT count(*) AS n FROM automatic_approval_events').get()!.n).toBe(2)
    else expect(f.journal.audit).toHaveLength(2)
    expect(f.notificationStore.page({}).records).toEqual([])
  })
  it('a delivery receipt cannot be recorded before its actual retained intent timestamp', async () => {
    const f = await fixture('sqlite'), delivery = { ...f.delivery(), createdAt: later }
    expect(() => automaticDeliveryRecorded(f.first, delivery, at)).toThrow('corrupt')
  })
  it('actual signed loopback delivery joins the ledger without deciding or replaying the waiting approval', async () => {
    const received: { body: string; valid: boolean }[] = [], secret = 'whsec_' + randomBytes(32).toString('base64')
    const receiver = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString('utf8')
      const expected = 'v1,' + createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
        .update(req.headers['webhook-id'] + '.' + req.headers['webhook-timestamp'] + '.' + body).digest('base64')
      received.push({ body, valid: req.headers['webhook-signature'] === expected }); res.writeHead(202); res.end()
    })
    await new Promise<void>((resolve, reject) => { receiver.once('error', reject); receiver.listen(0, '127.0.0.1', resolve) })
    cleanups.push(() => new Promise<void>(resolve => { receiver.closeAllConnections(); receiver.close(() => resolve()) }))
    const address = receiver.address(); if (!address || typeof address === 'string') throw new Error('fixture listener missing')
    const f = await fixture('sqlite', undefined, `http://127.0.0.1:${address.port}/approval`)
    await f.owner.setCredential('notification/key', secret, 0, 'PRIVATE_OWNER')
    await f.ledger.create(f.first)
    const before = await f.owner.events(f.first.request.runId)
    const delivery = await f.owner.sendApprovalNotification(f.first.request, `automatic:${f.first.policySha256}`)
    await f.ledger.settle(automaticDeliveryRecorded(f.first, delivery, at))
    await f.ledger.validate()
    expect(received).toEqual([{ body: JSON.stringify(f.first.event), valid: true }])
    expect((await f.owner.show(f.first.request.runId)).state.status).toBe('waiting')
    expect(await f.owner.events(f.first.request.runId)).toEqual(before)
    await f.owner.close()
    const reopened = await LocalRuntime.open({ dataDirectory: f.directory }); cleanups.push(() => reopened.close())
    const next = (reopened as unknown as { store: RunStore }).store.automaticAdmissionStore({ maxAdmissions: 100, maxEvents: 200 })
    expect((await next.get(f.first.request.requestId))?.outcome).toMatchObject({ status: 'delivery-recorded', deliveryStatus: 'settled' })
    expect(received).toHaveLength(1)
  })
})

const mutations: [string, (record: any) => void][] = [
  ['policy hash', r => { r.policySha256 = 'c'.repeat(64) }],
  ['request identity', r => { r.request.requestId = randomUUID() }],
  ['event identity', r => { r.event.id = 'd'.repeat(64) }],
  ['run identity', r => { r.request.runId = randomUUID() }],
  ['revision', r => { r.request.revision = 'e'.repeat(64) }],
  ['endpoint fingerprint', r => { r.request.endpointSha256 = 'f'.repeat(64) }],
  ['destination retarget', r => { r.destinations[0].endpointSha256 = 'f'.repeat(64) }],
  ['foreign project', r => { r.policy.routes[0].scope.id = randomUUID() }],
  ['project generation', r => { r.policy.routes[0].scope.generation++ }],
  ['wildcard policy', r => { r.policy.routes[0].scope.kind = 'any' }],
  ['actor override', r => { r.actor = 'PRIVATE_ACTOR' }],
  ['URL override', r => { r.destinations[0].url = 'https://unreviewed.invalid' }],
  ['redelivery', r => { r.request.redeliverOf = randomUUID() }],
  ['omitted lifecycle kind', r => { delete r.request.eventKind }],
  ['changed lifecycle kind', r => { r.request.eventKind = 'decided' }],
  ['private credential value', r => { r.credential = 'PRIVATE_SECRET' }],
  ['before-event capture', r => { r.createdAt = '2026-10-01T00:00:00.000Z' }],
  ['before-capture settlement', r => { r.outcome = { status: 'failed', at: '2026-10-01T00:00:00.000Z', code: 'closed' } }],
  ['private failure message', r => { r.outcome = { status: 'failed', at: later, code: 'busy', message: 'PRIVATE_ERROR' } }],
  ['duplicate destinations', r => { r.destinations.push(r.destinations[0]) }],
]
describe('automatic admission strict provenance and audit refusals', () => {
  it.each(mutations)('refuses %s without source values or credential authority', async (_name, mutate) => {
    const f = await fixture('sqlite'), changed = structuredClone(f.first); mutate(changed)
    expect(() => inspectAutomaticAdmission(changed)).toThrow(WorkflowRuntimeError)
    try { inspectAutomaticAdmission(changed) } catch (error) { expect(error).toHaveProperty('code', 'corrupt') }
  })
  it.each(['missing-create', 'duplicate-create', 'missing-settle', 'unknown-kind', 'orphan-event', 'different-snapshot'] as const)(
    'SQLite refuses %s without reconstruction or reset', async mode => {
      const f = await fixture('sqlite')
      await f.ledger.create(f.first)
      const failed = automaticAdmissionFailed(f.first, 'busy', later)
      await f.ledger.settle(failed)
      if (mode === 'missing-create') f.db.exec("DELETE FROM automatic_approval_events WHERE kind='created'")
      if (mode === 'duplicate-create') f.db.exec("INSERT INTO automatic_approval_events(admission_id,kind,record) SELECT admission_id,kind,record FROM automatic_approval_events WHERE kind='created'")
      if (mode === 'missing-settle') f.db.exec("DELETE FROM automatic_approval_events WHERE kind='settled'")
      if (mode === 'unknown-kind') f.db.exec("UPDATE automatic_approval_events SET kind='reset'")
      if (mode === 'orphan-event') { f.db.exec('PRAGMA foreign_keys=OFF'); f.db.prepare("INSERT INTO automatic_approval_events(admission_id,kind,record) VALUES(?,'created',?)").run(randomUUID(), JSON.stringify(f.first)) }
      if (mode === 'different-snapshot') f.db.prepare('UPDATE automatic_approval_admissions SET record=?').run(JSON.stringify(f.first))
      expect(() => f.ledger.validate()).toThrow('corrupt')
    })
  it.each(['missing-create', 'duplicate-create', 'missing-settle', 'unknown-kind', 'wrong-version', 'wrong-key', 'wrong-collection', 'deleted', 'orphan-event'] as const)(
    'PostgreSQL refuses %s through complete snapshot/audit joins', async mode => {
      const f = await fixture('postgres-double')
      await f.ledger.create(f.first); await f.ledger.settle(automaticAdmissionFailed(f.first, 'busy', later))
      const row = f.journal.rows.get(f.first.request.requestId)!
      if (mode === 'missing-create') f.journal.audit.splice(0, 1)
      if (mode === 'duplicate-create') f.journal.audit.push({ ...f.journal.audit[0]!, sequence: '3' })
      if (mode === 'missing-settle') f.journal.audit.splice(1, 1)
      if (mode === 'unknown-kind') f.journal.audit[0]!.kind = 'reset'
      if (mode === 'wrong-version') row.version = '1'
      if (mode === 'wrong-key') row.key = randomUUID()
      if (mode === 'wrong-collection') row.collection = 'runs'
      if (mode === 'deleted') row.deleted = true
      if (mode === 'orphan-event') f.journal.audit.push({ ...f.journal.audit[0]!, key: randomUUID(), sequence: '3' })
      await expect(f.ledger.validate()).rejects.toHaveProperty('code', 'corrupt')
    })
})

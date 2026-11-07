import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { LocalRuntime } from '../src/runtime/local.ts'
import { PostgresRuntime } from '../src/runtime/postgres.ts'
import { RunStore } from '../src/runtime/store.ts'
import { AutomaticApprovalOwner } from '../src/notifications/automatic-owner.ts'
import { ApprovalNotificationDispatcher } from '../src/notifications/dispatcher.ts'
import { approvalLifecycleNotification } from '../src/notifications/schema.ts'
import { parseNotificationConfig } from '../src/notifications/config.ts'
import { JournalError, type JournalBatch, type JournalCollection } from '../src/storage/postgres.ts'
import { withDomainWrite } from '../src/storage/domain-owner.ts'
import { compileLocalRun } from '../src/runtime/run-evaluator.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { inspectRelease } from '../src/releases/snapshot.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { journalConditionHash } from '../src/storage/conditions.ts'
import { WorkflowRuntimeError } from '../src/runtime/errors.ts'
import type { AutomaticAdmissionRecord } from '../src/notifications/automatic-admission.ts'

const yaml = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const at = '2026-10-10T00:00:00.000Z'
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); for (const close of cleanups.splice(0).reverse()) await close() })
const endpoint = (url = 'http://127.0.0.1:9/unused') => ({ id: 'review', url, credentialRef: 'notification/key', timeoutMs: 1000 })
const policy = (scope: unknown, destination: { id: string; endpointSha256: string }) => ({
  format: 'jevable.ai/automatic-approval-policy/v1', routes: [{ scope, endpointId: destination.id,
    endpointSha256: destination.endpointSha256, eventKinds: ['requested', 'decided', 'expired', 'cancelled'] }],
})
function internals(owner: LocalRuntime) {
  return owner as unknown as { store: RunStore; automaticNotifications: AutomaticApprovalOwner;
    enableAutomaticNotifications(policy: unknown, limits: { maxAdmissions: number; maxEvents: number }, maxPending: number): void }
}
async function sqlite(url?: string, options: { enabled?: boolean; maxPending?: number; maxAdmissions?: number; credential?: boolean; expires?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at)
  const directory = await mkdtemp(join(tmpdir(), 'jevable-automatic-owner-'))
  const owner = await LocalRuntime.open({ dataDirectory: directory, notifications: { endpoints: [endpoint(url)] } })
  cleanups.push(() => owner.close())
  const project = owner.editProject({ operation: 'create', title: 'Review', yaml: options.expires ? yaml.replace('24h', '1s') : yaml, actor: 'PRIVATE_OWNER' })
  if (options.credential !== false) owner.setCredential('notification/key', 'whsec_' + randomBytes(32).toString('base64'), 0, 'PRIVATE_OWNER')
  const p = policy({ kind: 'project', id: project.id, generation: project.generation, revision: project.acceptedRevision }, owner.notificationDestinations()[0]!)
  if (options.enabled !== false) internals(owner).enableAutomaticNotifications(p,
    { maxAdmissions: options.maxAdmissions ?? 100, maxEvents: (options.maxAdmissions ?? 100) * 2 }, options.maxPending ?? 16)
  const admission = () => internals(owner).store.automaticAdmissionStore({ maxAdmissions: 100000, maxEvents: 200000 })
  const start = (id = randomUUID()) => owner.runProject(project.id, project.generation, project.acceptedRevision, { message: 'PRIVATE_REVIEW_VALUE' }, { id })
  return { owner, directory, project, p, start, admission }
}
async function sink(hold = false) {
  const bodies: string[] = [], arrived = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    bodies.push(Buffer.concat(chunks).toString('utf8')); arrived.resolve()
    if (hold) await release.promise
    response.writeHead(202); response.end()
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanups.push(async () => { release.resolve(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture port')
  return { bodies, arrived, release, url: `http://127.0.0.1:${address.port}/approval` }
}

/** Full owner/domain CAS double, not actual SQL, database TLS, fencing or lost-connection qualification. */
class JournalDouble {
  readonly controller = new AbortController()
  get signal() { return this.controller.signal }
  readonly rows = new Map<string, { collection: JournalCollection; key: string; version: string; deleted: boolean; value: unknown }>()
  readonly history: (JournalBatch['events'][number] & { sequence: string; batchId: string; at: string; epoch: string })[] = []
  readonly receipts = new Map<string, unknown>()
  close = vi.fn(async () => {})
  private key(collection: string, key: string) { return JSON.stringify([collection, key]) }
  put(collection: JournalCollection, key: string, value: unknown, version = '1') { this.rows.set(this.key(collection, key), { collection, key, value: structuredClone(value), version, deleted: false }) }
  async get(collection: JournalCollection, key: string) { return structuredClone(this.rows.get(this.key(collection, key))) }
  async exists(collection: JournalCollection, key: string) { return this.rows.has(this.key(collection, key)) }
  async count(collection: JournalCollection) { return [...this.rows.values()].filter(row => row.collection === collection && !row.deleted).length }
  async page(collection: JournalCollection, after?: string, limit = 100) {
    const rows = [...this.rows.values()].filter(row => row.collection === collection && !row.deleted && (!after || row.key > after)).sort((a, b) => a.key < b.key ? -1 : 1)
    return { records: structuredClone(rows.slice(0, limit)), nextCursor: rows.length > limit ? rows[limit - 1]!.key : null }
  }
  async events(after: string, limit: number, collections: JournalCollection[], key?: string) {
    const events = this.history.filter(event => BigInt(event.sequence) > BigInt(after) && collections.includes(event.collection) && (!key || event.key === key)).slice(0, limit)
    return { events: structuredClone(events), cursor: events.at(-1)?.sequence ?? after }
  }
  async receipt(id: string) { return structuredClone(this.receipts.get(id)) }
  async commit(batch: JournalBatch) {
    this.signal.throwIfAborted()
    if (this.receipts.has(batch.id)) return structuredClone(this.receipts.get(batch.id))
    for (const change of batch.changes) if ((this.rows.get(this.key(change.collection, change.key))?.version ?? '0') !== change.expectedVersion) throw new JournalError('conflict')
    const changes = [], eventSequences = []
    for (const change of batch.changes) {
      if (change.operation !== 'put') throw new Error('fixture puts only')
      const version = String(BigInt(change.expectedVersion) + 1n)
      this.put(change.collection, change.key, change.value, version); changes.push({ collection: change.collection, key: change.key, version, deleted: false })
    }
    for (const event of batch.events) {
      const sequence = String(this.history.length + 1); eventSequences.push(sequence)
      this.history.push({ ...structuredClone(event), sequence, batchId: batch.id, at: new Date().toISOString(), epoch: '1' })
    }
    const receipt = { id: batch.id, requestSha256: journalConditionHash(batch), ownerId: randomUUID(), epoch: '1', recordedAt: new Date().toISOString(), changes, eventSequences }
    this.receipts.set(batch.id, receipt); return structuredClone(receipt)
  }
}
async function postgres(url?: string, maxPending = 16) {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at)
  const journal = new JournalDouble(), graph = compileLocalRun(yaml, DEFAULT_COMPILER_LIMITS)
  const release = inspectRelease({ format: 'jevable.ai/release', schemaVersion: 1, id: randomUUID(), version: '1.0.0', createdAt: at,
    createdBy: 'PRIVATE_OWNER', project: { id: randomUUID(), generation: 1 }, workflow: { yaml: graph.source.yaml, revision: graph.source.revision },
    runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
  journal.put('releases', release.snapshot.id, { format: 'jevable.pg-release/v1', ...release })
  journal.put('release-versions', `${release.snapshot.project.id}/1.0.0`, { format: 'jevable.pg-release-version/v1', projectId: release.snapshot.project.id, version: '1.0.0', firstReleaseId: release.snapshot.id })
  const owner = Reflect.construct(PostgresRuntime, [journal, 10000, 10000, 4_000_000, parseNotificationConfig({ endpoints: [endpoint(url)] })]) as PostgresRuntime
  cleanups.push(() => owner.close())
  await owner.setCredential('notification/key', 'whsec_' + randomBytes(32).toString('base64'), 0, 'PRIVATE_OWNER')
  const internal = owner as unknown as { enableAutomaticNotifications(policy: unknown, maxPending: number): void;
    automaticNotifications: AutomaticApprovalOwner; automaticStore: { page(): Promise<{ records: AutomaticAdmissionRecord[] }> } }
  internal.enableAutomaticNotifications(policy({ kind: 'release', id: release.snapshot.id, sha256: release.sha256, revision: graph.source.revision }, owner.notificationDestinations()[0]!), maxPending)
  return { owner, journal, internal, start: () => owner.runRelease(release.snapshot, { message: 'PRIVATE_REVIEW_VALUE' }) }
}

describe('internal live automatic owner; public automatic startup remains disabled', () => {
  for (const backend of ['sqlite', 'postgres-double'] as const) {
    it(`${backend}: one live committed request sends once; shutdown drains before closing storage`, async () => {
      const receiver = await sink(true), f = backend === 'sqlite' ? await sqlite(receiver.url) : await postgres(receiver.url)
      cleanups.push(async () => receiver.release.resolve())
      const run = await f.start(); expect(run.state.status).toBe('waiting')
      await receiver.arrived.promise
      if (backend === 'sqlite') expect(() => f.owner.setCredential('notification/key', randomBytes(32).toString('base64'), 1, 'PRIVATE_OWNER')).toThrow('busy')
      else await expect(f.owner.setCredential('notification/key', randomBytes(32).toString('base64'), 1, 'PRIVATE_OWNER')).rejects.toHaveProperty('code', 'busy')
      let closed = false
      const closing = f.owner.close().then(() => { closed = true })
      await Promise.resolve(); expect(closed).toBe(false)
      await expect(f.owner.show(run.id)).rejects.toHaveProperty('code', 'closed')
      if ('journal' in f) expect(f.journal.close).not.toHaveBeenCalled()
      receiver.release.resolve(); await closing
      expect(receiver.bodies).toHaveLength(1); expect(receiver.bodies[0]).not.toContain('PRIVATE_REVIEW_VALUE')
      if ('journal' in f) {
        expect(f.journal.close).toHaveBeenCalledTimes(1)
        expect((await f.internal.automaticStore.page()).records[0]!.outcome.status).toBe('delivery-recorded')
      } else {
        const reopened = await LocalRuntime.open({ dataDirectory: f.directory }); cleanups.push(() => reopened.close())
        expect((await reopened.show(run.id)).state.status).toBe('waiting')
        expect(internals(reopened).store.automaticAdmissionStore({ maxAdmissions: 100, maxEvents: 200 }).page().records[0]!.outcome.status).toBe('delivery-recorded')
        expect(receiver.bodies).toHaveLength(1)
      }
    })
    it(`${backend}: saturation writes an explicit failed admission without losing the new workflow wait`, async () => {
      const receiver = await sink(true), f = backend === 'sqlite' ? await sqlite(receiver.url, { maxPending: 1 }) : await postgres(receiver.url, 1)
      cleanups.push(async () => receiver.release.resolve())
      await f.start(); await receiver.arrived.promise
      const second = await f.start(); expect(second.state.status).toBe('waiting')
      const rows = 'journal' in f ? (await f.internal.automaticStore.page()).records : f.admission().page().records
      expect(rows.find(row => row.request.runId === second.id)!.outcome).toMatchObject({ status: 'failed', code: 'busy' })
      expect(receiver.bodies).toHaveLength(1)
      receiver.release.resolve(); await f.owner.close()
    })
  }
  it('PostgreSQL admission may reacquire the shared domain gate only after run commit releases it', async () => {
    const receiver = await sink(), f = await postgres(receiver.url)
    const gate = vi.spyOn(f.internal.automaticStore as unknown as { create(record: AutomaticAdmissionRecord): Promise<boolean> }, 'create')
    await f.start(); await f.owner.close()
    expect(gate).toHaveBeenCalledTimes(1); expect(receiver.bodies).toHaveLength(1)
    await withDomainWrite(f.journal as never, async () => {})
  })
  it.each(['decided', 'expired', 'cancelled'] as const)('SQLite projects only the actual committed %s event', async kind => {
    const receiver = await sink(), f = await sqlite(receiver.url, { expires: kind === 'expired' })
    const run = await f.start(); if (run.state.status !== 'waiting') throw new Error('fixture wait')
    // Wait only for owned notification work; this is not a historical scan.
    await internals(f.owner).automaticNotifications.drain()
    // A new explicitly attached owner is not allowed; instead a fresh fixture selects the terminal kind alone.
    await f.owner.close()
    const reopened = await LocalRuntime.open({ dataDirectory: f.directory, notifications: { endpoints: [endpoint(receiver.url)] } }); cleanups.push(() => reopened.close())
    internals(reopened).enableAutomaticNotifications({ ...f.p, routes: f.p.routes.map(route => ({ ...route, eventKinds: [kind] })) }, { maxAdmissions: 100, maxEvents: 200 }, 16)
    if (kind === 'cancelled') await reopened.cancel(run.id, randomUUID(), 'PRIVATE_OWNER')
    else {
      if (kind === 'expired') vi.setSystemTime(Date.parse(at) + 2000)
      await reopened.decide(run.id, run.state.attempt.id, 'approve', 'PRIVATE_REVIEWER')
    }
    await reopened.close()
    expect(receiver.bodies.map(body => JSON.parse(body).type)).toEqual(['ai.jevable.approval.requested', `ai.jevable.approval.${kind}`])
  })
  it('missing signing credentials records a sanitized failure; acknowledged workflow stays waiting', async () => {
    const f = await sqlite(undefined, { credential: false }), run = await f.start()
    await internals(f.owner).automaticNotifications.drain()
    expect(f.admission().page().records[0]!.outcome).toMatchObject({ status: 'failed', code: 'invalid-command' })
    expect((await f.owner.show(run.id)).state.status).toBe('waiting')
  })
  it('admission capacity refusal latches a safe fault, never rewrites or falsely rolls back the run', async () => {
    const g = await sqlite(undefined, { maxAdmissions: 1, credential: false })
    await g.start(); const run = await g.start()
    await g.owner.close()
    expect(run.state.status).toBe('waiting')
    expect(internals(g.owner).automaticNotifications.snapshot().fault).toMatchObject({ code: 'limit' })
  })
  it('omission leaves schema 18 and all reads, elapsed time and reopen send nothing', async () => {
    const receiver = await sink(), f = await sqlite(receiver.url, { enabled: false, expires: true })
    const run = await f.start(); vi.setSystemTime(Date.parse(at) + 2000)
    await f.owner.show(run.id); await f.owner.events(run.id)
    expect(receiver.bodies).toEqual([])
    const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'))
    try { expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 18 }) } finally { db.close() }
    await f.owner.close()
    const reopened = await LocalRuntime.open({ dataDirectory: f.directory, notifications: { endpoints: [endpoint(receiver.url)] } }); cleanups.push(() => reopened.close())
    internals(reopened).enableAutomaticNotifications(f.p, { maxAdmissions: 100, maxEvents: 200 }, 16)
    await reopened.show(run.id); await reopened.events(run.id); await reopened.close()
    expect(receiver.bodies).toEqual([])
  })
  it.each([0, -1, 1.5, 65, NaN])('invalid work capacity %s refuses before SQLite schema migration', async max => {
    const f = await sqlite(undefined, { enabled: false })
    expect(() => internals(f.owner).enableAutomaticNotifications(f.p, { maxAdmissions: 100, maxEvents: 200 }, max)).toThrow('invalid-command')
    const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'))
    try { expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 18 }) } finally { db.close() }
  })
  it.each(['before', 'after'] as const)('uncertain %s reservation acknowledgement never calls dispatcher or resets a row', async when => {
    const f = await sqlite(undefined, { enabled: false }), run = await f.start(), events = internals(f.owner).store.events(run.id), tail = events.at(-1)!
    const rows = new Map<string, AutomaticAdmissionRecord>(), send = vi.fn()
    const dispatcher = new ApprovalNotificationDispatcher({ requested: () => approvalLifecycleNotification(run, events, { runId: run.id, revision: run.revision,
      attemptId: run.state.status === 'waiting' ? run.state.attempt.id : randomUUID() }), credential: () => undefined },
      { get: () => undefined, createIntent: () => false, settle: () => {} }, [endpoint()])
    vi.spyOn(dispatcher, 'send').mockImplementation(send)
    const owner = new AutomaticApprovalOwner(f.p, { create: record => { if (when === 'after') rows.set(record.request.requestId, record); throw new JournalError('commit-uncertain') }, settle: () => {} }, dispatcher)
    owner.committed(run, events, tail.kind, tail.data); await owner.drain()
    expect(send).not.toHaveBeenCalled(); expect(rows.size).toBe(when === 'after' ? 1 : 0)
    expect(owner.snapshot()).toMatchObject({ pending: 0, active: 0, fault: { code: 'uncertain' } })
  })
  it('an existing reservation acknowledgement is read-only, never dispatcher authority', async () => {
    const f = await sqlite(undefined, { enabled: false }), run = await f.start(), events = internals(f.owner).store.events(run.id), tail = events.at(-1)!
    const send = vi.fn(), dispatcher = { destinations: () => f.owner.notificationDestinations(), send }
    const create = vi.fn(() => false), settle = vi.fn()
    const owner = new AutomaticApprovalOwner(f.p, { create, settle }, dispatcher)
    owner.committed(run, events, tail.kind, tail.data); await owner.drain()
    expect(create).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled(); expect(settle).not.toHaveBeenCalled()
  })
  it('drain owns and joins a still-pending asynchronous admission without replay or forgotten work', async () => {
    const f = await sqlite(undefined, { enabled: false }), run = await f.start(), events = internals(f.owner).store.events(run.id), tail = events.at(-1)!
    const ack = Promise.withResolvers<boolean>(), send = vi.fn()
    const owner = new AutomaticApprovalOwner(f.p, { create: () => ack.promise, settle: () => {} },
      { destinations: () => f.owner.notificationDestinations(), send })
    const admission = owner.committed(run, events, tail.kind, tail.data)
    expect(owner.snapshot()).toMatchObject({ pending: 1, admitting: 1, active: 0 })
    let drained = false; const draining = owner.drain().then(() => { drained = true })
    await Promise.resolve(); expect(drained).toBe(false)
    ack.resolve(false); await admission; await draining
    expect(owner.busy()).toBe(false); expect(send).not.toHaveBeenCalled()
  })
  it('SQLite lost terminal acknowledgement remains inspectable and never sends again on reopen', async () => {
    const receiver = await sink(), f = await sqlite(receiver.url)
    const live = internals(f.owner).automaticNotifications as unknown as { persistence: { settle(record: AutomaticAdmissionRecord): void } }
    const settle = live.persistence.settle.bind(live.persistence)
    vi.spyOn(live.persistence, 'settle').mockImplementation(record => { settle(record); throw new JournalError('commit-uncertain') })
    const run = await f.start(); await f.owner.close()
    expect(internals(f.owner).automaticNotifications.snapshot()).toMatchObject({ active: 0, pending: 0, fault: { code: 'uncertain' } })
    expect(receiver.bodies).toHaveLength(1)
    const reopened = await LocalRuntime.open({ dataDirectory: f.directory, notifications: { endpoints: [endpoint(receiver.url)] } }); cleanups.push(() => reopened.close())
    expect((await reopened.show(run.id)).state.status).toBe('waiting')
    expect(internals(reopened).store.automaticAdmissionStore({ maxAdmissions: 100, maxEvents: 200 }).page().records[0]!.outcome.status).toBe('delivery-recorded')
    await reopened.close(); expect(receiver.bodies).toHaveLength(1)
  })
  it('a retained manual predecessor refuses a new automatic initial send rather than treating policy as redelivery', async () => {
    const receiver = await sink(), f = await sqlite(receiver.url, { enabled: false }), run = await f.start()
    if (run.state.status !== 'waiting') throw new Error('fixture wait')
    const prepared = await f.owner.prepareApprovalNotification({ runId: run.id, revision: run.revision, attemptId: run.state.attempt.id, eventKind: 'requested' }, 'review')
    const { event: _event, delivery: _delivery, ...request } = prepared
    await f.owner.sendApprovalNotification({ ...request, requestId: randomUUID() }, 'PRIVATE_OWNER')
    internals(f.owner).enableAutomaticNotifications(f.p, { maxAdmissions: 100, maxEvents: 200 }, 16)
    // Invoke only the internal commit consumer to challenge the predecessor fence; no read/startup path invokes it.
    const events = internals(f.owner).store.events(run.id), tail = events.at(-1)!
    internals(f.owner).automaticNotifications.committed(run, events, tail.kind, tail.data)
    await internals(f.owner).automaticNotifications.drain()
    expect(f.admission().page().records[0]!.outcome).toMatchObject({ status: 'failed', code: 'conflict' })
    expect(receiver.bodies).toHaveLength(1); expect((await f.owner.show(run.id)).state.status).toBe('waiting')
  })
  it('PostgreSQL owner loss is not workflow replay, pending receipt repair or a second POST', async () => {
    const receiver = await sink(true), f = await postgres(receiver.url)
    cleanups.push(async () => receiver.release.resolve())
    const run = await f.start(); await receiver.arrived.promise
    f.journal.controller.abort(new JournalError('ownership-lost'))
    receiver.release.resolve(); await f.owner.close()
    expect(f.internal.automaticNotifications.snapshot().fault).toMatchObject({ code: 'uncertain' })
    expect(receiver.bodies).toHaveLength(1)
    const admission = [...f.journal.rows.values()].find(row => row.collection === 'approval-automatic-admissions')!
    expect((admission.value as AutomaticAdmissionRecord).outcome.status).toBe('reserved')
    expect(run.state.status).toBe('waiting'); expect(f.journal.close).toHaveBeenCalledTimes(1)
  })
})

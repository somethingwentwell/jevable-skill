import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { LocalRuntime, prepareGrantToken } from '../src/runtime/index.ts'
import { PostgresRuntime } from '../src/runtime/postgres.ts'
import { RunStore } from '../src/runtime/store.ts'
import { PostgresRunStore } from '../src/runtime/postgres-store.ts'
import { JournalError, type JournalBatch, type JournalCollection } from '../src/storage/postgres.ts'
import { CommittedApprovalCapture } from '../src/notifications/committed-approvals.ts'
import { parseNotificationConfig } from '../src/notifications/config.ts'
import { compileLocalRun } from '../src/runtime/run-evaluator.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { inspectRelease } from '../src/releases/snapshot.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { journalConditionHash } from '../src/storage/conditions.ts'

const yaml = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const at = '2026-10-02T00:00:00.000Z', endpointSha256 = 'b'.repeat(64)
const destination = { id: 'review', endpointSha256 }
const owners: { close(): Promise<void> }[] = []
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); for (const owner of owners.splice(0).reverse()) await owner.close() })
const policy = (scope: unknown) => ({ format: 'jevable.ai/automatic-approval-policy/v1',
  routes: [{ scope, endpointId: destination.id, endpointSha256, eventKinds: ['requested', 'decided', 'expired', 'cancelled'] }] })
const kinds = (capture: CommittedApprovalCapture) => capture.snapshot().candidates.map(candidate => candidate.event.type)
async function sqlite(maxCandidates = 64) {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at)
  const directory = await mkdtemp(join(tmpdir(), 'jevable-committed-approval-'))
  const owner = await LocalRuntime.open({ dataDirectory: directory }); owners.push(owner)
  const project = owner.editProject({ operation: 'create', title: 'Review', yaml, actor: 'PRIVATE_OWNER' })
  const p = policy({ kind: 'project', id: project.id, generation: project.generation, revision: project.acceptedRevision })
  const capture = new CommittedApprovalCapture(p, [destination], maxCandidates)
  // Internal bridge only. Production SDK exposes no automatic-policy option or capture installation bypass.
  const store = (owner as unknown as { store: RunStore }).store
  store.observeCommittedApprovals(capture)
  const start = (id: string = randomUUID()) => owner.runProject(project.id, project.generation, project.acceptedRevision,
    { message: 'PRIVATE_REVIEW_VALUE' }, { id })
  return { owner, store, project, capture, start, directory, p }
}

/** A new domain/CAS test double, not actual PostgreSQL SQL, locking, durability or lost-connection qualification. */
class JournalDouble {
  readonly signal = new AbortController().signal
  readonly rows = new Map<string, { collection: JournalCollection; key: string; version: string; deleted: boolean; value: unknown }>()
  readonly history: (JournalBatch['events'][number] & { sequence: string; batchId: string; at: string; epoch: string })[] = []
  readonly receipts = new Map<string, unknown>()
  fail: 'before' | 'after' | undefined
  private key(collection: string, key: string) { return JSON.stringify([collection, key]) }
  put(collection: JournalCollection, key: string, value: unknown, version = '1') {
    this.rows.set(this.key(collection, key), { collection, key, value: structuredClone(value), version, deleted: false })
  }
  async get(collection: JournalCollection, key: string) { return structuredClone(this.rows.get(this.key(collection, key))) }
  async exists(collection: JournalCollection, key: string) { return this.rows.has(this.key(collection, key)) }
  async count(collection: JournalCollection) { return [...this.rows.values()].filter(row => row.collection === collection && !row.deleted).length }
  async events(after: string, limit: number, collections: JournalCollection[], key?: string) {
    const events = this.history.filter(event => BigInt(event.sequence) > BigInt(after) && collections.includes(event.collection)
      && (key === undefined || key === event.key)).slice(0, limit)
    return { events: structuredClone(events), cursor: events.at(-1)?.sequence ?? after }
  }
  async receipt(id: string) { return structuredClone(this.receipts.get(id)) }
  async commit(batch: JournalBatch) {
    this.signal.throwIfAborted()
    if (this.fail === 'before') { this.fail = undefined; throw new JournalError('conflict') }
    const existing = this.receipts.get(batch.id)
    if (existing) return structuredClone(existing)
    for (const change of batch.changes)
      if ((this.rows.get(this.key(change.collection, change.key))?.version ?? '0') !== change.expectedVersion) throw new JournalError('conflict')
    const changes = [], eventSequences = []
    for (const change of batch.changes) {
      if (change.operation !== 'put') throw new Error('Fixture supports puts only')
      const version = String(BigInt(change.expectedVersion) + 1n)
      this.put(change.collection, change.key, change.value, version)
      changes.push({ collection: change.collection, key: change.key, version, deleted: false })
    }
    for (const event of batch.events) {
      const sequence = String(this.history.length + 1); eventSequences.push(sequence)
      this.history.push({ ...structuredClone(event), sequence, batchId: batch.id, at, epoch: '1' })
    }
    const receipt = { id: batch.id, requestSha256: journalConditionHash(batch), ownerId: randomUUID(), epoch: '1', recordedAt: at, changes, eventSequences }
    this.receipts.set(batch.id, receipt)
    if (this.fail === 'after') { this.fail = undefined; throw new JournalError('commit-uncertain') }
    return structuredClone(receipt)
  }
  async close() {}
}
async function postgres(maxCandidates = 64) {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at)
  const journal = new JournalDouble(), graph = compileLocalRun(yaml, DEFAULT_COMPILER_LIMITS)
  const release = inspectRelease({ format: 'jevable.ai/release', schemaVersion: 1, id: randomUUID(), version: '1.0.0', createdAt: at,
    createdBy: 'PRIVATE_OWNER', project: { id: randomUUID(), generation: 1 },
    workflow: { yaml: graph.source.yaml, revision: graph.source.revision }, runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
  journal.put('releases', release.snapshot.id, { format: 'jevable.pg-release/v1', ...release })
  journal.put('release-versions', `${release.snapshot.project.id}/1.0.0`, { format: 'jevable.pg-release-version/v1',
    projectId: release.snapshot.project.id, version: '1.0.0', firstReleaseId: release.snapshot.id })
  const owner = Reflect.construct(PostgresRuntime, [journal, 10000, 10000, 4_000_000, parseNotificationConfig({})]) as PostgresRuntime
  owners.push(owner)
  const capture = new CommittedApprovalCapture(policy({ kind: 'release', id: release.snapshot.id, sha256: release.sha256,
    revision: graph.source.revision }), [destination], maxCandidates)
  const store = (owner as unknown as { runs: PostgresRunStore }).runs
  store.observeCommittedApprovals(capture)
  return { owner, journal, store, capture, release, start: (id: string = randomUUID()) => owner.runRelease(release.snapshot, { message: 'PRIVATE_REVIEW_VALUE' }, { id }) }
}

describe('new committed approval capture, without dispatch', () => {
  for (const backend of ['sqlite', 'postgres-double'] as const) {
    const fixture = backend === 'sqlite' ? sqlite : postgres
    it(`${backend}: captures new requested and decided events; reads and exact run retry add none`, async () => {
      const f = await fixture(), run = await f.start()
      if (run.state.status !== 'waiting') throw new Error('Expected approval wait')
      expect(kinds(f.capture)).toEqual(['ai.jevable.approval.requested'])
      const before = f.capture.snapshot()
      await f.owner.show(run.id); await f.owner.events(run.id)
      expect(await f.start(run.id)).toEqual(run)
      expect(f.capture.snapshot()).toEqual(before)
      await f.owner.decide(run.id, run.state.attempt.id, 'approve', 'PRIVATE_REVIEWER')
      expect(kinds(f.capture)).toEqual(['ai.jevable.approval.requested', 'ai.jevable.approval.decided'])
      expect(f.capture.snapshot()).not.toHaveProperty('fault')
      expect(JSON.stringify(f.capture.snapshot())).not.toMatch(/PRIVATE_|yaml|actor.*PRIVATE|message/)
      expect(f.capture.snapshot().candidates.every(candidate => candidate.plan.dispatch === 'not-attempted')).toBe(true)
    })
    it(`${backend}: captures expiry only after a committed expired decision`, async () => {
      const f = await fixture(), run = await f.start()
      if (run.state.status !== 'waiting') throw new Error('Expected approval wait')
      vi.setSystemTime(Date.parse(run.state.expiresAt) + 1)
      await f.owner.show(run.id); await f.owner.events(run.id)
      expect(kinds(f.capture)).toEqual(['ai.jevable.approval.requested'])
      const result = await f.owner.decide(run.id, run.state.attempt.id, 'approve', 'PRIVATE_REVIEWER')
      expect(result.state).toMatchObject({ status: 'failed', code: 'approval-expired' })
      expect(kinds(f.capture)).toEqual(['ai.jevable.approval.requested', 'ai.jevable.approval.expired'])
    })
    it(`${backend}: waiting cancellation is not a decision; capacity faults do not rewrite workflow outcome`, async () => {
      const f = await fixture(), run = await f.start()
      await f.owner.cancel(run.id, randomUUID(), 'PRIVATE_CANCEL_ACTOR')
      expect(kinds(f.capture)).toEqual(['ai.jevable.approval.requested', 'ai.jevable.approval.cancelled'])
      expect((await f.owner.show(run.id)).state.status).toBe('cancelled')
      const bounded = await fixture(1), waiting = await bounded.start()
      if (waiting.state.status !== 'waiting') throw new Error('Expected approval wait')
      await bounded.owner.decide(waiting.id, waiting.state.attempt.id, 'approve', 'PRIVATE_REVIEWER')
      expect((await bounded.owner.show(waiting.id)).state.status).toBe('completed')
      expect(bounded.capture.snapshot()).toMatchObject({ fault: { code: 'limit', runId: waiting.id, transition: 'approval-decided' } })
      expect(bounded.capture.snapshot().candidates).toHaveLength(1)
    })
  }
  it('SQLite reviewer atomic settlement uses the same post-commit boundary', async () => {
    const f = await sqlite(), run = await f.start()
    if (run.state.status !== 'waiting') throw new Error('Expected approval wait')
    const token = prepareGrantToken(randomUUID())
    await f.owner.issueGrant({ id: token.id, tokenSha256: token.tokenSha256, actor: 'PRIVATE_OWNER',
      expiresAt: run.state.expiresAt, scope: { kind: 'reviewer', runId: run.id, attemptId: run.state.attempt.id,
        revision: run.revision, decisions: ['approve'] } })
    const request = { requestId: randomUUID(), action: 'approve' as const, pauseAfter: true }
    await f.owner.decideWithGrant(token.token, request)
    expect(kinds(f.capture)).toEqual(['ai.jevable.approval.requested', 'ai.jevable.approval.decided'])
    const before = f.capture.snapshot()
    await f.owner.decideWithGrant(token.token, request)
    expect(f.capture.snapshot()).toEqual(before)
  })
  it('SQLite rollback emits no candidate and does not backfill on read/reopen', async () => {
    const f = await sqlite(), db = new DatabaseSync(join(f.directory, 'runtime.sqlite'))
    db.exec("CREATE TRIGGER refuse_wait BEFORE INSERT ON events WHEN NEW.kind='approval-requested' BEGIN SELECT RAISE(ABORT,'fixture refusal'); END")
    try { await expect(f.start()).rejects.toThrow('fixture refusal') } finally { db.close() }
    expect(f.capture.snapshot().candidates).toEqual([])
    const ids = f.store.ids()
    await f.owner.close()
    const reopened = await LocalRuntime.open({ dataDirectory: f.directory }); owners.push(reopened)
    const next = new CommittedApprovalCapture(f.p, [destination])
    ;(reopened as unknown as { store: RunStore }).store.observeCommittedApprovals(next)
    for (const id of ids) { await reopened.show(id); await reopened.events(id) }
    expect(next.snapshot().candidates).toEqual([])
    expect(f.capture.snapshot().candidates).toEqual([])
  })
  it('SQLite post-commit observation failure is inspectable and does not report rollback', async () => {
    const f = await sqlite(), events = f.store.events.bind(f.store)
    vi.spyOn(f.store, 'events').mockImplementation(id => {
      const result = events(id)
      if (result.at(-1)?.kind === 'approval-requested') throw new Error('PRIVATE_OBSERVATION_ERROR')
      return result
    })
    const run = await f.start()
    expect(run.state.status).toBe('waiting')
    expect(f.capture.snapshot()).toMatchObject({ candidates: [], fault: { code: 'corrupt', runId: run.id, transition: 'approval-requested' } })
    expect(JSON.stringify(f.capture.snapshot())).not.toContain('PRIVATE_OBSERVATION_ERROR')
    vi.restoreAllMocks()
    expect((await f.owner.show(run.id)).state.status).toBe('waiting')
  })
  it.each(['before', 'after'] as const)('PostgreSQL %s acknowledgement failure never emits or later replays a candidate', async fail => {
    const f = await postgres(), commit = f.journal.commit.bind(f.journal)
    vi.spyOn(f.journal, 'commit').mockImplementation(async batch => {
      if (batch.events.some(event => event.kind === 'approval-requested')) f.journal.fail = fail
      return commit(batch)
    })
    await expect(f.start()).rejects.toHaveProperty('code', fail === 'before' ? 'conflict' : 'commit-uncertain')
    expect(f.capture.snapshot().candidates).toEqual([])
    const row = [...f.journal.rows.values()].find(row => row.collection === 'runs')!
    await f.owner.show(row.key); await f.owner.events(row.key)
    expect(f.capture.snapshot().candidates).toEqual([])
    if (fail === 'after') expect((await f.owner.show(row.key)).state.status).toBe('waiting')
  })
  it('detaches review and snapshots; repeated observation does not add or alter a candidate', async () => {
    const f = await sqlite()
    f.p.routes[0]!.endpointSha256 = 'c'.repeat(64)
    const run = await f.start(), events = f.store.events(run.id), tail = events.at(-1)!
    const before = f.capture.snapshot()
    f.capture.committed(run, events, tail.kind, tail.data)
    expect(f.capture.snapshot()).toEqual(before)
    const changed = f.capture.snapshot(); changed.candidates[0]!.plan.requests[0]!.endpointSha256 = 'd'.repeat(64)
    expect(f.capture.snapshot()).toEqual(before)
    expect(() => f.store.observeCommittedApprovals(f.capture)).toThrow('conflict')
  })
  it('refuses a substituted committed tail without creating a plan or mutating the run', async () => {
    const f = await sqlite(), run = await f.start(), events = f.store.events(run.id), tail = events.at(-1)!
    const capture = new CommittedApprovalCapture(f.p, [destination]), before = structuredClone(run)
    capture.committed(run, events, tail.kind, { attemptId: randomUUID() })
    expect(capture.snapshot()).toMatchObject({ candidates: [], fault: { code: 'corrupt', runId: run.id } })
    expect(run).toEqual(before)
  })
  it('does not select another valid project generation, unscoped execution or a non-waiting cancellation', async () => {
    const f = await sqlite()
    const renamed = f.owner.editProject({ operation: 'rename', id: f.project.id, expectedGeneration: f.project.generation,
      title: 'Renamed', actor: 'PRIVATE_OWNER' })
    await f.owner.runProject(renamed.id, renamed.generation, renamed.acceptedRevision, { message: 'PRIVATE_OTHER_GENERATION' })
    await f.owner.run(yaml, { message: 'PRIVATE_UNSCOPED' })
    const paused = await f.owner.run(yaml, { message: 'PRIVATE_PAUSED' }, { paused: true })
    f.owner.cancel(paused.id, randomUUID(), 'PRIVATE_OWNER')
    expect(f.capture.snapshot()).toEqual({ candidates: [], semantics: 'process-local-candidates; no-durable-admission; no-dispatch' })
  })
  it('PostgreSQL waits for the actual commit acknowledgement before capture and receipt retry never recaptures', async () => {
    const f = await postgres(), commit = f.journal.commit.bind(f.journal)
    const entered = Promise.withResolvers<void>(), ack = Promise.withResolvers<void>()
    vi.spyOn(f.journal, 'commit').mockImplementation(async batch => {
      const receipt = await commit(batch)
      if (batch.events.some(event => event.kind === 'approval-requested')) { entered.resolve(); await ack.promise }
      return receipt
    })
    const observed = vi.spyOn(f.capture, 'committed'), running = f.start()
    try {
      await entered.promise
      expect(f.capture.snapshot().candidates).toEqual([])
      expect(observed).not.toHaveBeenCalled()
    } finally { ack.resolve() }
    const run = await running, event = f.journal.history.at(-1)!
    expect(kinds(f.capture)).toEqual(['ai.jevable.approval.requested'])
    expect(observed).toHaveBeenCalledTimes(1)
    const envelope = event.data as { version: string; data: Record<string, unknown> }
    const before = structuredClone(f.journal.history)
    await f.store.save({ requestId: event.batchId, expectedVersion: String(BigInt(envelope.version) - 1n), record: run,
      kind: 'approval-requested', data: envelope.data as never })
    expect(f.journal.history).toEqual(before)
    expect(observed).toHaveBeenCalledTimes(1)
  })
  it.each([0, -1, 1.5, 100001, NaN])('rejects invalid capture capacity %s without storage or effects', async max => {
    const f = await sqlite()
    expect(() => new CommittedApprovalCapture(f.p, [destination], max)).toThrow('invalid-command')
    expect(f.capture.snapshot().candidates).toEqual([])
  })
})

import { DatabaseSync } from 'node:sqlite'
import { mkdir, open, lstat } from 'node:fs/promises'
import { RuntimeOwnerLock } from './owner-lock.ts'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { localRunSchema, type LocalRun } from './run-types.ts'
import { WorkflowRuntimeError } from './errors.ts'
import { ProviderStore } from '../providers/store.ts'
import { ProjectStore } from '../projects/store.ts'
import { ReleaseStore } from '../releases/store.ts'
import { TestStore } from '../testing/store.ts'
import type { RetainedRunMetrics } from './retained-metrics.ts'
import { initializeNotificationTables, SQLiteNotificationStore } from '../notifications/sqlite-store.ts'
import { initializeGrantTables, SQLiteGrantStore } from '../access/sqlite-grants.ts'
import { callerBinding } from '../access/caller.ts'
import { callerControlRequestSchema, callerControlRetry, callerControlTarget, prepareCallerControl,
  type CallerControlRequest } from '../access/caller-control.ts'
import { validateBreakpoints } from './breakpoints.ts'
import { validateRunTransition } from './run-transition.ts'
import { callerCancellationRequestSchema, callerCancellationRetry, callerCancellationTarget, prepareCallerCancellation,
  type CallerCancellationRequest } from '../access/caller-cancellation.ts'
import type { GrantPrincipal } from '../access/grants.ts'
import type { GrantPolicyObserver } from '../access/policy-observation.ts'
import { isDeepStrictEqual } from 'node:util'
import { triggerMetadata } from './trigger.ts'
import { reviewerDecisionRequestSchema, reviewerTarget, type ReviewerDecisionRequest } from '../access/reviewer.ts'
import { prepareReviewerSettlement, type ReviewerTraceObservation } from './reviewer.ts'
import type { CompiledWorkflow, WorkflowCompilerLimits } from '../workflow/index.ts'
import { observeSQLiteDatabase } from '../storage/sqlite-observation.ts'
import type { SQLiteStatementStatistics } from '../storage/sqlite-statistics.ts'
import type { CommittedApprovalObserver } from '../notifications/automatic-owner.ts'
import { initializeAutomaticAdmissionTables, SQLiteAutomaticAdmissionStore } from '../notifications/automatic-sqlite-store.ts'
import { automaticAdmissionLimits, type AutomaticAdmissionLimits } from '../notifications/automatic-admission.ts'
import { verifyApprovalEventHistory } from '../notifications/schema.ts'

const releasePinSchema = z.strictObject({ id: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/u), revision: z.string().regex(/^[a-f0-9]{64}$/u) })

/** Private single-process SQLite store. A crash leaves a lock requiring explicit operator inspection. */
export class RunStore {
  private closed = false
  private retainedMetrics: RetainedRunMetrics | undefined
  private grantPolicyObserver: GrantPolicyObserver | undefined
  private approvalCapture: Pick<CommittedApprovalObserver, 'refused'> & {
    committed(record: LocalRun, events: ReturnType<RunStore['events']>, kind: string, data: unknown): void
  } | undefined
  /** Internal source bridge; attach explicitly before live writes, never scan retained history. */
  observeCommittedApprovals(capture: NonNullable<RunStore['approvalCapture']>) {
    this.assertOpen()
    if (this.approvalCapture) throw new WorkflowRuntimeError('conflict')
    this.approvalCapture = capture
  }
  private captureApproval(record: LocalRun, kind: string, data: unknown) {
    if (!this.approvalCapture || !['approval-requested', 'approval-decided', 'run-cancelled'].includes(kind)) return
    // SQLite observers must finish admission synchronously; only the owning coordinator retains asynchronous sends.
    try { this.approvalCapture.committed(record, this.events(record.id), kind, data) }
    catch { this.approvalCapture.refused(record.id, kind) }
  }
  observeGrantPolicy(observer: GrantPolicyObserver) { this.grantPolicyObserver = observer }
  observeRetainedState(metrics: RetainedRunMetrics) { this.retainedMetrics = metrics }
  readonly providers: ProviderStore
  private constructor(private readonly db: DatabaseSync,
    private readonly lock: RuntimeOwnerLock, readonly directory: string,
    private readonly maxRuns: number, private readonly maxRecordBytes: number) {
    this.providers = new ProviderStore(db, maxRecordBytes)
  }

  static async open(directory: string, policy: { maxRuns: number; maxRecordBytes: number }, sqliteStatements?: SQLiteStatementStatistics) {
    const path = resolve(directory)
    await mkdir(path, { recursive: true, mode: 0o700 })
    const stat = await lstat(path)
    if (!stat.isDirectory() || (process.platform !== 'win32' && (stat.mode & 0o077))) {
      throw new Error('Runtime data directory must be private (mode 0700) and not a symlink.')
    }
    const lock = await RuntimeOwnerLock.acquire(path)
    let db: DatabaseSync | undefined
    try {
      const databasePath = join(path, 'runtime.sqlite')
      const file = await open(databasePath, 'a', 0o600)
      try {
        const info = await lstat(databasePath)
        if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error('Runtime database must be a private regular file.')
      } finally { await file.close() }
      db = new DatabaseSync(databasePath)
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;')
      const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
      if (![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19].includes(version.user_version)) throw new WorkflowRuntimeError('corrupt')
      if ([16, 17, 18, 19].includes(version.user_version)) {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('approval_deliveries','approval_delivery_events')").all()
        if (tables.length !== 2) throw new WorkflowRuntimeError('corrupt')
      }
      if ([17, 18, 19].includes(version.user_version) && (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('access_grants','access_grant_events')").all().length !== 2))
        throw new WorkflowRuntimeError('corrupt')
      if ([18, 19].includes(version.user_version) && !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test_erasures'").get())
        throw new WorkflowRuntimeError('corrupt')
      if (version.user_version === 19 && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('automatic_approval_admissions','automatic_approval_events')").all().length !== 2)
        throw new WorkflowRuntimeError('corrupt')
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), kind TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_run ON events(run_id, sequence);
        CREATE TABLE IF NOT EXISTS provider_connections (id TEXT PRIMARY KEY, record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS provider_credentials (ref TEXT PRIMARY KEY, record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS model_calls (attempt_id TEXT PRIMARY KEY, record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS provider_audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, subject TEXT NOT NULL, generation INTEGER NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, generation INTEGER NOT NULL, record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS project_deletions (id TEXT PRIMARY KEY, record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS releases (id TEXT PRIMARY KEY, record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS test_cases (id TEXT PRIMARY KEY, generation INTEGER NOT NULL, record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS test_generations (id TEXT PRIMARY KEY, record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS test_erasures (request_id TEXT PRIMARY KEY, test_id TEXT NOT NULL COLLATE NOCASE UNIQUE, record TEXT NOT NULL);
        PRAGMA user_version = 18;`)
      initializeNotificationTables(db)
      initializeGrantTables(db)
      if (version.user_version === 19) db.exec('PRAGMA user_version = 19')
      // An additive expression index preserves the record format and stays atomic with every snapshot write.
      // Build it inside the existing migration transaction; malformed legacy JSON must not leave a partial migration.
      try { db.exec(`CREATE INDEX IF NOT EXISTS runs_release_page ON runs (
        json_extract(record, '$.release.id'), json_extract(record, '$.release.sha256'), json_extract(record, '$.revision'), id
      );`) } catch { throw new WorkflowRuntimeError('corrupt') }
      db.exec('COMMIT;')
      return new RunStore(sqliteStatements ? observeSQLiteDatabase(db, sqliteStatements) : db,
        lock, path, policy.maxRuns, policy.maxRecordBytes)
    } catch (error) {
      try { db?.close() } finally { await lock.release() }; throw error
    }
  }

  private assertOpen() { if (this.closed) throw new WorkflowRuntimeError('closed') }

  /** Internal opt-in schema capability. Omitted capability keeps schema 18; schema 19 is never downgraded or repaired. */
  automaticAdmissionStore(limits: AutomaticAdmissionLimits, initialize = false) {
    this.assertOpen()
    if (!automaticAdmissionLimits.safeParse(limits).success || typeof initialize !== 'boolean') throw new WorkflowRuntimeError('invalid-command')
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version !== 19) {
      if (!initialize || version !== 18) throw new WorkflowRuntimeError('not-found')
      this.db.exec('BEGIN IMMEDIATE')
      try {
        initializeAutomaticAdmissionTables(this.db)
        this.db.exec('PRAGMA user_version = 19; COMMIT')
      } catch (error) { try { this.db.exec('ROLLBACK') } catch { /* Preserve uncertainty. */ } throw error }
    }
    const deliveries = this.notificationStore({ maxDeliveries: 100000, maxEvents: 200000 })
    return new SQLiteAutomaticAdmissionStore(this.db, limits, {
      history: record => {
        const run = this.get(record.request.runId)
        if (!run) throw new WorkflowRuntimeError('corrupt')
        verifyApprovalEventHistory(record.event, record.createdAt, run, this.events(run.id))
      },
      delivery: id => deliveries.get(id),
    })
  }

  /** Read-only startup validation of retained automatic evidence even when live policy is omitted. */
  validateAutomaticAdmissions() {
    this.assertOpen()
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version === 19) return this.automaticAdmissionStore({ maxAdmissions: 100000, maxEvents: 200000 })
  }

  releaseStore() { this.assertOpen(); return new ReleaseStore(this.db, this.maxRecordBytes) }
  grantStore() { this.assertOpen(); return new SQLiteGrantStore(this.db, undefined, this.grantPolicyObserver) }
  notificationStore(policy: { maxDeliveries: number; maxEvents: number }) {
    this.assertOpen(); return new SQLiteNotificationStore(this.db, policy)
  }
  testStore(limits: import('../workflow/index.ts').WorkflowCompilerLimits) { this.assertOpen(); return new TestStore(this.db, limits, this.maxRecordBytes) }

  projectStore(limits: import('../workflow/index.ts').WorkflowLimits) {
    this.assertOpen()
    return new ProjectStore(this.db, limits, this.maxRecordBytes)
  }

  get(id: string): LocalRun | undefined {
    this.assertOpen()
    const row = this.db.prepare('SELECT record FROM runs WHERE id = ?').get(id) as { record: string } | undefined
    if (!row) return undefined
    if (Buffer.byteLength(row.record) > this.maxRecordBytes) throw new WorkflowRuntimeError('limit')
    try { return localRunSchema.parse(JSON.parse(row.record)) }
    catch { this.retainedMetrics?.invalidate(); throw new WorkflowRuntimeError('corrupt') }
  }

  exists(id: string) { this.assertOpen(); return Boolean(this.db.prepare('SELECT 1 FROM runs WHERE id=?').get(id)) }

  /** Filter in SQL before loading payloads: an unrelated run is indistinguishable from an absent run. */
  getCaller(id: string, principal: GrantPrincipal): LocalRun | undefined {
    this.assertOpen()
    if (principal.scope.kind !== 'caller') throw new WorkflowRuntimeError('not-found')
    const pin = principal.scope.release
    const row = this.db.prepare(`SELECT id FROM runs WHERE id=? AND json_extract(record,'$.caller.grantId')=?
      AND json_extract(record,'$.release.id')=? AND json_extract(record,'$.release.sha256')=? AND json_extract(record,'$.revision')=?`)
      .get(id, principal.grantId, pin.id, pin.sha256, pin.revision)
    return row ? this.get(id) : undefined
  }

  ids(): string[] {
    this.assertOpen()
    return (this.db.prepare('SELECT id FROM runs ORDER BY rowid').all() as { id: string }[]).map(row => row.id)
  }

  /** Keyset admission reads only limit + 1 identifiers, never every retained run payload. */
  idPage(after?: string, limit = 100) {
    this.assertOpen()
    if (after !== undefined && !z.uuid().safeParse(after).success || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new WorkflowRuntimeError('invalid-command')
    const rows = this.db.prepare('SELECT id FROM runs WHERE id > ? ORDER BY id LIMIT ?').all(after ?? '', limit + 1) as { id: string }[]
    if (rows.some(row => !z.uuid().safeParse(row.id).success)) throw new WorkflowRuntimeError('corrupt')
    const ids = rows.slice(0, limit).map(row => row.id)
    return { ids, nextCursor: rows.length > limit ? ids.at(-1)! : null }
  }

  /** Indexed exact-release keyset page. Foreign records are not decoded into application memory. */
  releaseIdPage(value: { id: string; sha256: string; revision: string }, after?: string, limit = 100) {
    this.assertOpen()
    const parsed = releasePinSchema.safeParse(value)
    if (!parsed.success || after !== undefined && !z.uuid().safeParse(after).success
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new WorkflowRuntimeError('invalid-command')
    const pin = parsed.data
    if (after !== undefined) {
      const cursor = this.get(after)
      if (!cursor || cursor.id !== after || cursor.revision !== pin.revision || cursor.release?.id !== pin.id
        || cursor.release.sha256 !== pin.sha256) throw new WorkflowRuntimeError('not-found')
    }
    const rows = this.db.prepare(`SELECT id FROM runs WHERE json_extract(record, '$.release.id') = ?
      AND json_extract(record, '$.release.sha256') = ? AND json_extract(record, '$.revision') = ?
      AND id > ? ORDER BY id LIMIT ?`).all(pin.id, pin.sha256, pin.revision, after ?? '', limit + 1) as { id: string }[]
    if (rows.some(row => !z.uuid().safeParse(row.id).success)) throw new WorkflowRuntimeError('corrupt')
    const ids = rows.slice(0, limit).map(row => row.id)
    return { ids, nextCursor: rows.length > limit ? ids.at(-1)! : null }
  }

  /** Commit a snapshot and its evidence event together before acknowledging a transition. */
  save(record: LocalRun, kind: string, data: unknown = {}) {
    this.assertOpen()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.writeInTransaction(record, kind, data)
      this.db.exec('COMMIT')
      this.retainedMetrics?.committed(record, kind)
    } catch (error) {
      this.retainedMetrics?.invalidate()
      try { this.db.exec('ROLLBACK') } catch { /* Preserve the original uncertainty. */ }
      throw error
    }
    this.captureApproval(record, kind, data)
  }

  private writeInTransaction(record: LocalRun, kind: string, data: unknown, guard?: () => void) {
    const encoded = JSON.stringify(localRunSchema.parse(record)), evidence = JSON.stringify(data)
    if (Buffer.byteLength(encoded) > this.maxRecordBytes || Buffer.byteLength(evidence) > this.maxRecordBytes) throw new WorkflowRuntimeError('limit')
    if (!this.get(record.id)) {
      const count = this.db.prepare('SELECT count(*) AS count FROM runs').get() as { count: number }
      if (count.count >= this.maxRuns) throw new WorkflowRuntimeError('limit')
    }
    guard?.()
    this.db.prepare('INSERT INTO runs(id,record) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(record.id, encoded)
    this.db.prepare('INSERT INTO events(run_id,kind,at,data) VALUES(?,?,?,?)').run(record.id, kind, record.updatedAt, evidence)
  }

  /** Recheck the actual retained grant and release in the same transaction as immutable creation evidence. */
  saveCallerCreation(value: LocalRun, token: string): LocalRun {
    this.assertOpen()
    const base = localRunSchema.parse(value)
    if (base.caller || base.project || base.test || !base.release) throw new WorkflowRuntimeError('invalid-command')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (this.exists(base.id)) throw new WorkflowRuntimeError('conflict')
      const release = this.releaseStore().get(base.release.id)
      const pin = { id: release.snapshot.id, sha256: release.sha256, revision: release.snapshot.workflow.revision }
      if (base.release.sha256 !== pin.sha256 || base.revision !== pin.revision || base.yaml !== release.snapshot.workflow.yaml)
        throw new WorkflowRuntimeError('corrupt')
      const action = { kind: 'start' as const, release: pin }, target = { kind: 'release' as const, release: pin }
      const authorize = () => this.grantStore().authorizeInTransaction(token, action, target)
      const admission = authorize(), caller = callerBinding(admission)
      const record: LocalRun = { ...base, caller, createdAt: caller.at, updatedAt: caller.at }
      this.writeInTransaction(record, 'run-created', { revision: record.revision, ...(record.startedPaused ? { startedPaused: true } : {}),
        ...triggerMetadata(record), release: record.release, caller }, () => {
        const final = authorize()
        if (final.grantId !== caller.grantId || !isDeepStrictEqual(final.scope, caller.scope)) throw new WorkflowRuntimeError('conflict')
      })
      this.db.exec('COMMIT')
      this.retainedMetrics?.committed(record, 'run-created')
      return record
    } catch (error) {
      this.retainedMetrics?.invalidate()
      try { this.db.exec('ROLLBACK') } catch { /* Preserve the original uncertainty. */ }
      throw error
    }
  }

  /** Caller control intent and writer-derived attribution share a transaction. No execution or recovery here. */
  saveCallerControl(token: string, id: string, value: CallerControlRequest, checked: (record: LocalRun) => CompiledWorkflow,
    limits: WorkflowCompilerLimits) {
    this.assertOpen()
    const parsed = callerControlRequestSchema.safeParse(value)
    if (!parsed.success || !z.uuid().safeParse(id).success) throw new WorkflowRuntimeError('invalid-command')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const grants = this.grantStore(), principal = grants.lookup(token)
      if (!principal || principal.scope.kind !== 'caller' || !principal.scope.permissions.includes('control')) throw new WorkflowRuntimeError('not-found')
      const previous = this.getCaller(id, principal)
      if (!previous) throw new WorkflowRuntimeError('not-found')
      const graph = checked(previous)
      if (callerControlRetry(previous, parsed.data)) { this.db.exec('COMMIT'); return { record: previous, admitted: false } }
      validateBreakpoints(graph, parsed.data)
      const target = callerControlTarget(previous), action = { kind: 'control' as const, runId: id }
      const authorize = () => grants.authorizeInTransaction(token, action, target), admission = authorize()
      const { record, control } = prepareCallerControl(previous, parsed.data, admission)
      validateRunTransition(previous, record, 'execution-requested', control, graph, limits)
      this.writeInTransaction(record, 'execution-requested', control, () => {
        const final = authorize()
        if (final.grantId !== admission.grantId || !isDeepStrictEqual(final.scope, admission.scope)) throw new WorkflowRuntimeError('conflict')
      })
      this.db.exec('COMMIT'); this.retainedMetrics?.committed(record, 'execution-requested')
      return { record, admitted: true }
    } catch (error) {
      this.retainedMetrics?.invalidate()
      try { this.db.exec('ROLLBACK') } catch { /* Preserve original uncertainty; never dispatch from this writer. */ }
      throw error
    }
  }

  /** Caller-only cancellation admission and evidence share one transaction. Historical retries only observe. */
  saveCallerCancellation(token: string, id: string, value: CallerCancellationRequest, checked: (record: LocalRun) => unknown,
    parent?: () => import('./run-types.ts').JevableRunTrace | undefined) {
    this.assertOpen()
    const parsed = callerCancellationRequestSchema.safeParse(value)
    if (!parsed.success || !z.uuid().safeParse(id).success) throw new WorkflowRuntimeError('invalid-command')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const grants = this.grantStore(), principal = grants.lookup(token)
      if (!principal || principal.scope.kind !== 'caller' || !principal.scope.permissions.includes('cancel')) throw new WorkflowRuntimeError('not-found')
      const previous = this.getCaller(id, principal)
      if (!previous) throw new WorkflowRuntimeError('not-found')
      checked(previous)
      if (callerCancellationRetry(previous, parsed.data)) { this.db.exec('COMMIT'); return { record: previous, admitted: false } }
      const target = callerCancellationTarget(previous), action = { kind: 'cancel' as const, runId: id }
      const authorize = () => grants.authorizeInTransaction(token, action, target), admission = authorize()
      const { record, cancellation } = prepareCallerCancellation(previous, parsed.data, admission, parent?.())
      this.writeInTransaction(record, 'cancellation-requested', cancellation, () => {
        const final = authorize()
        if (final.grantId !== admission.grantId || !isDeepStrictEqual(final.scope, admission.scope)) throw new WorkflowRuntimeError('conflict')
      })
      this.db.exec('COMMIT'); this.retainedMetrics?.committed(record, 'cancellation-requested')
      return { record, admitted: true }
    } catch (error) {
      this.retainedMetrics?.invalidate()
      try { this.db.exec('ROLLBACK') } catch { /* Preserve the original uncertainty. */ }
      throw error
    }
  }

  /** Recheck current grant and wait in the same writer transaction; clients never supply the target or actor. */
  saveReviewerDecision(token: string, value: ReviewerDecisionRequest, checked: (record: LocalRun) => CompiledWorkflow, limits: WorkflowCompilerLimits,
    observe?: (record: LocalRun) => ReviewerTraceObservation | undefined) {
    this.assertOpen()
    const parsed = reviewerDecisionRequestSchema.safeParse(value)
    if (!parsed.success) throw new WorkflowRuntimeError('invalid-command')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const grants = this.grantStore(), principal = grants.lookup(token)
      if (!principal || principal.scope.kind !== 'reviewer' || !principal.scope.decisions.includes(parsed.data.action)) throw new WorkflowRuntimeError('not-found')
      const record = this.get(principal.scope.runId)
      if (!record) throw new WorkflowRuntimeError('not-found')
      const graph = checked(record), events = this.events(record.id), target = reviewerTarget(record, events)
      const action = { kind: 'decision' as const, runId: principal.scope.runId, attemptId: principal.scope.attemptId, decision: parsed.data.action }
      const authorize = () => grants.authorizeInTransaction(token, action, target)
      const admission = authorize(), settlement = prepareReviewerSettlement(record, events, graph, parsed.data, admission, limits, observe?.(record))
      this.writeInTransaction(settlement.record, 'approval-decided', settlement.data, () => {
        const final = authorize()
        if (final.grantId !== admission.grantId || !isDeepStrictEqual(final.scope, admission.scope)) throw new WorkflowRuntimeError('conflict')
      })
      this.db.exec('COMMIT'); this.retainedMetrics?.committed(settlement.record, 'approval-decided')
      this.captureApproval(settlement.record, 'approval-decided', settlement.data)
      return settlement
    } catch (error) {
      this.retainedMetrics?.invalidate()
      try { this.db.exec('ROLLBACK') } catch { /* Preserve the original uncertainty. */ }
      throw error
    }
  }

  events(id: string) {
    this.assertOpen()
    return (this.db.prepare('SELECT sequence,kind,at,data FROM events WHERE run_id = ? ORDER BY sequence').all(id) as {
      sequence: number; kind: string; at: string; data: string
    }[]).map(event => ({ ...event, data: JSON.parse(event.data) as unknown }))
  }

  eventSize(id: string) {
    this.assertOpen()
    return this.db.prepare('SELECT count(*) AS count, coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM events WHERE run_id=?').get(id) as { count: number; bytes: number }
  }

  async close() {
    if (this.closed) return
    this.closed = true
    try { this.db.close() }
    finally { await this.lock.release() }
  }
}

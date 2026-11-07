import { z } from 'zod'
import { PostgresJournal, JournalError, type JournalBatch } from '../storage/postgres.ts'
import { withDomainWrite } from '../storage/domain-owner.ts'
import { DEFAULT_COMPILER_LIMITS } from '../limits.ts'
import { admitWorkflowData, type WorkflowCompilerLimits } from '../workflow/index.ts'
import { localRunSchema, type LocalRun } from './run-types.ts'
import { PostgresRunReader } from './postgres-reader.ts'
import { runEventKind, validateRunTransition } from './run-transition.ts'
import { WorkflowRuntimeError } from './errors.ts'
import { createPostgresRunEvidence } from './postgres-evidence.ts'
import type { RetainedRunMetrics } from './retained-metrics.ts'
import { PostgresProviderStore } from '../providers/postgres-store.ts'
import { modelEvidenceTargets, ModelEvidenceProjection } from './model-evidence.ts'
import { triggerMetadata } from './trigger.ts'
import { ACTIVITY_LIMITS, activityRun, createActivityReport, type ActivityProject, type ActivityRun } from './activity.ts'
import { parseJournalConditions, type JournalConditions } from '../storage/conditions.ts'
import { PostgresGrantStore } from '../access/postgres-grants.ts'
import { verifyReviewerBatchIdentity } from '../access/reviewer.ts'
import { verifyCallerCancellationBatchIdentity } from '../access/caller-cancellation.ts'
import { verifyCallerControlBatchIdentity } from '../access/caller-control.ts'
import { isDeepStrictEqual } from 'node:util'
import type { CommittedApprovalObserver } from '../notifications/automatic-owner.ts'
export type { PostgresRunEvent } from './postgres-reader.ts'
const serial = z.string().regex(/^(0|[1-9][0-9]{0,18})$/u).refine(value => BigInt(value) < 9223372036854775806n)
const writeSchema = z.strictObject({ requestId: z.uuid(), expectedVersion: serial, record: localRunSchema, kind: runEventKind, data: z.json() })
export type PostgresRunWrite = z.input<typeof writeSchema>
const releasePin = z.strictObject({ id: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/u), revision: z.string().regex(/^[a-f0-9]{64}$/u) })
function summary(record: LocalRun, version: string) {
  return { id: record.id, version, revision: record.revision, status: record.state.status, createdAt: record.createdAt, updatedAt: record.updatedAt,
    ...triggerMetadata(record),
    ...(record.project ? { project: record.project } : {}), ...(record.release ? { release: record.release } : {}), ...(record.test ? { test: record.test } : {}) }
}

/** Experimental execution storage. It commits/validates checkpoints; it never starts or resumes a workflow. */
export class PostgresRunStore {
  private readonly reader: PostgresRunReader
  private approvalCapture: CommittedApprovalObserver | undefined
  /** Internal source bridge. No read/reopen scan, replay or independent owner. */
  observeCommittedApprovals(capture: CommittedApprovalObserver) {
    this.journal.signal.throwIfAborted()
    if (this.approvalCapture) throw new WorkflowRuntimeError('conflict')
    this.approvalCapture = capture
  }
  constructor(private readonly journal: PostgresJournal, private readonly limits: WorkflowCompilerLimits = DEFAULT_COMPILER_LIMITS,
    private readonly maxRecordBytes = 4_000_000, private readonly maxRuns = 10000, private readonly retainedMetrics?: RetainedRunMetrics) {
    if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1024 || maxRecordBytes > 16_000_000
      || !Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > 100000) throw new WorkflowRuntimeError('invalid-command')
    this.reader = new PostgresRunReader(journal, limits, maxRecordBytes)
  }
  get signal() { return this.journal.signal }
  /** One domain gate across every source page; verified reads never dispatch a model or workflow. */
  activity(readProjects: () => Promise<ActivityProject[]>) {
    return this.owned(async () => {
      const projects = await readProjects(), runs: ActivityRun[] = [], seen = new Set<string>()
      let after: string | undefined
      do {
        const page = await this.journal.page('runs', after, 100)
        for (const row of page.records) {
          if (seen.has(row.key)) throw new WorkflowRuntimeError('corrupt'); seen.add(row.key)
          if (runs.length >= Math.min(this.maxRuns, ACTIVITY_LIMITS.runs)) throw new WorkflowRuntimeError('limit')
          runs.push(activityRun((await this.reader.read(row.key)).record))
        }
        if (page.nextCursor && after && page.nextCursor <= after) throw new WorkflowRuntimeError('corrupt')
        after = page.nextCursor ?? undefined
      } while (after)
      this.journal.signal.throwIfAborted()
      return createActivityReport('postgres', projects, runs)
    })
  }
  private owned<T>(work: () => Promise<T>) {
    return withDomainWrite(this.journal, async () => {
      try { return await work() }
      catch (error) {
        if (this.journal.signal.aborted || (error instanceof WorkflowRuntimeError || error instanceof JournalError) && error.code === 'corrupt') this.retainedMetrics?.invalidate()
        if (error instanceof JournalError && error.code === 'conflict') throw new WorkflowRuntimeError('conflict'); throw error
      }
    })
  }
  private parse<T>(schema: z.ZodType<T>, value: unknown, corrupt = false): T {
    try { return schema.parse(admitWorkflowData(value, { maxBytes: this.maxRecordBytes, maxDepth: 64, maxValues: 100000 })) }
    catch { throw new WorkflowRuntimeError(corrupt ? 'corrupt' : 'invalid-command') }
  }
  get(id: string) { return this.owned(async () => {
    const { record, version, events } = await this.reader.read(id)
    this.retainedMetrics?.restore(record, events); return { record, version }
  }) }
  /** Internal caller read/start-retry. No foreign payload is loaded, and expiry is checked after every awaited replay. */
  caller(token: string, id: string, permission: 'start' | 'read' | 'control' | 'cancel', allowNew = false) {
    if (!z.uuid().safeParse(id).success || typeof allowNew !== 'boolean' || !['start', 'read', 'control', 'cancel'].includes(permission)
      || allowNew && permission !== 'start') throw new WorkflowRuntimeError('invalid-command')
    const key = id.toLowerCase()
    return this.owned(async () => {
      const grants = new PostgresGrantStore(this.journal), principal = await grants.callerForReadInDomain(token, permission)
      if (principal.scope.kind !== 'caller') throw new WorkflowRuntimeError('not-found')
      const selected = await this.journal.callerRun({ id: key, grantId: principal.grantId, release: principal.scope.release })
      let result: { record: LocalRun; version: string } | undefined
      if (selected) {
        const read = await this.reader.read(key)
        if (read.version !== selected.version || read.record.caller?.grantId !== principal.grantId
          || !isDeepStrictEqual(read.record.caller.scope, principal.scope)) throw new WorkflowRuntimeError('corrupt')
        this.retainedMetrics?.restore(read.record, read.events)
        result = { record: read.record, version: read.version }
      } else if (!allowNew || await this.journal.exists('runs', key)) throw new WorkflowRuntimeError('not-found')
      const final = await grants.callerForReadInDomain(token, permission)
      if (final.grantId !== principal.grantId || !isDeepStrictEqual(final.scope, principal.scope)) throw new WorkflowRuntimeError('not-found')
      return result
    })
  }
  /** Only the authenticated grant supplies this retained run/revision, before any private read. */
  reviewer(token: string, action: string) {
    return this.owned(async () => {
      const grants = new PostgresGrantStore(this.journal), principal = await grants.reviewerForReadInDomain(token, action)
      if (principal.scope.kind !== 'reviewer') throw new WorkflowRuntimeError('not-found')
      const result = await this.reader.read(principal.scope.runId)
      if (result.record.revision !== principal.scope.revision) throw new WorkflowRuntimeError('not-found')
      const final = await grants.reviewerForReadInDomain(token, action)
      if (final.grantId !== principal.grantId || !isDeepStrictEqual(final.scope, principal.scope)) throw new WorkflowRuntimeError('not-found')
      return { ...result, principal: final }
    })
  }
  events(id: string) { return this.owned(async () => (await this.reader.read(id)).events) }
  /** Hold the domain gate across checkpoint, journal, historical references and model verification. */
  evidence(id: string, includePrivate = false, usageIdentities = false) {
    if (typeof includePrivate !== 'boolean' || typeof usageIdentities !== 'boolean') throw new WorkflowRuntimeError('invalid-command')
    return this.owned(async () => {
      const { record, version, events, graph } = await this.reader.read(id)
      const providers = new PostgresProviderStore(this.journal, this.maxRecordBytes), models = new ModelEvidenceProjection(64_000_000, usageIdentities)
      for (const target of modelEvidenceTargets(graph, events)) models.add(target, await providers.evidence(target.attempt.id))
      return createPostgresRunEvidence(record, events, version, includePrivate, models.calls, usageIdentities)
    })
  }
  list(after?: string, limit = 100) {
    return this.owned(async () => {
      const page = await this.journal.page('runs', after, limit), runs = []
      for (const row of page.records) {
        const { record, version, events } = await this.reader.read(row.key)
        this.retainedMetrics?.restore(record, events)
        runs.push(summary(record, version))
      }
      return { runs, nextCursor: page.nextCursor }
    })
  }
  /** Scoped pages never return an unrelated run identity as their continuation cursor. */
  listRelease(value: z.infer<typeof releasePin>, after?: string, limit = 100) {
    const pin = this.parse(releasePin, value)
    if ((after !== undefined && !z.uuid().safeParse(after).success) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new WorkflowRuntimeError('invalid-command')
    const cursor = after?.toLowerCase()
    const matches = (record: LocalRun) => record.release?.id === pin.id && record.release.sha256 === pin.sha256 && record.revision === pin.revision
    return this.owned(async () => {
      if (cursor && !matches((await this.reader.read(cursor)).record)) throw new WorkflowRuntimeError('not-found')
      let scan = cursor, examined = 0
      const runs: ReturnType<typeof summary>[] = []
      do {
        const page = await this.journal.page('runs', scan, 100)
        examined += page.records.length
        if (examined > this.maxRuns) throw new WorkflowRuntimeError('limit')
        for (const row of page.records) {
          const { record, version } = await this.reader.read(row.key)
          if (!matches(record)) continue
          if (runs.length === limit) return { runs, nextCursor: runs.at(-1)!.id }
          runs.push(summary(record, version))
        }
        if (!page.nextCursor) return { runs, nextCursor: null }
        scan = page.nextCursor
      } while (true)
    })
  }
  /** Accepts a finite JSON tree, not aliased evaluator objects. Retain the exact command/UUID; retries only retrieve receipts. */
  save(value: PostgresRunWrite, guard?: JournalConditions) {
    return this.saveAdmitted(value, guard, false)
  }
  /** New caller creation only. Exact historical recovery belongs to the authenticated caller read/retry path. */
  saveCallerCreation(value: PostgresRunWrite, guard: JournalConditions) {
    if (guard === undefined) throw new WorkflowRuntimeError('invalid-command')
    return this.saveAdmitted(value, guard, true)
  }
  private saveAdmitted(value: PostgresRunWrite, guard: JournalConditions | undefined, callerCreation: boolean) {
    const conditions = guard === undefined ? undefined : parseJournalConditions(guard)
    const command = this.parse(writeSchema, value), record = command.record as LocalRun
    const reviewer = verifyReviewerBatchIdentity(command.kind, command.data, command.requestId)
    const callerCancellation = verifyCallerCancellationBatchIdentity(command.kind, command.data, command.requestId)
    const callerControl = verifyCallerControlBatchIdentity(command.kind, command.data, command.requestId)
    if (callerControl && (!conditions || conditions.notBefore !== callerControl.at
      || conditions.expiresAt !== callerControl.delegation.deadline
      || !conditions.records.some(pin => pin.collection === 'access-grants' && pin.key === callerControl.delegation.grantId)
      || !conditions.records.some(pin => pin.collection === 'runs' && pin.key === record.id && pin.version === command.expectedVersion)))
      throw new WorkflowRuntimeError('invalid-command')
    if (callerCancellation && (!conditions || conditions.notBefore !== callerCancellation.at
      || conditions.expiresAt !== callerCancellation.delegation.deadline
      || !conditions.records.some(pin => pin.collection === 'access-grants' && pin.key === callerCancellation.delegation.grantId)
      || !conditions.records.some(pin => pin.collection === 'runs' && pin.key === record.id && pin.version === command.expectedVersion)))
      throw new WorkflowRuntimeError('invalid-command')
    if (reviewer && (!conditions || conditions.notBefore !== reviewer.at || conditions.expiresAt !== reviewer.delegation.deadline
      || !conditions.records.some(pin => pin.collection === 'access-grants' && pin.key === reviewer.delegation.grantId)
      || !conditions.records.some(pin => pin.collection === 'runs' && pin.key === record.id && pin.version === command.expectedVersion)))
      throw new WorkflowRuntimeError('invalid-command')
    if (callerCreation && (command.kind !== 'run-created' || command.expectedVersion !== '0' || !record.caller || !record.release || record.project || record.test))
      throw new WorkflowRuntimeError('invalid-command')
    const version = (BigInt(command.expectedVersion) + 1n).toString()
    const batch: JournalBatch = { id: command.requestId, changes: [{ operation: 'put', collection: 'runs', key: record.id,
      expectedVersion: command.expectedVersion, value: z.json().parse({ format: 'jevable.pg-run/v1', record }) }],
    events: [{ collection: 'runs', key: record.id, kind: command.kind, data: z.json().parse({ format: 'jevable.pg-run-event/v1', version, at: record.updatedAt, data: command.data }) }] }
    let committedEvents: { kind: string; at: string; data: unknown }[] | undefined
    const pending = this.owned(async () => {
      if (callerCreation && await this.journal.exists('runs', record.id)) throw new WorkflowRuntimeError('not-found')
      if (callerCreation && await this.journal.receipt(command.requestId)) throw new WorkflowRuntimeError('conflict')
      if (callerCancellation && await this.journal.receipt(command.requestId)) throw new WorkflowRuntimeError('conflict')
      if (callerControl && await this.journal.receipt(command.requestId)) throw new WorkflowRuntimeError('conflict')
      if (await this.journal.receipt(command.requestId)) return this.journal.commit(batch, conditions)
      const row = callerCreation ? undefined : await this.journal.get('runs', record.id)
      if (row?.deleted || (row?.version ?? '0') !== command.expectedVersion) throw new WorkflowRuntimeError('conflict')
      const before = row ? await this.reader.read(record.id) : undefined
      if (!before && await this.journal.count('runs') >= this.maxRuns) throw new WorkflowRuntimeError('limit')
      if (before && (before.events.length >= 50000 || Buffer.byteLength(JSON.stringify(before.events)) + Buffer.byteLength(JSON.stringify(command.data)) > 64_000_000)) throw new WorkflowRuntimeError('limit')
      const events = [...before?.events ?? [], { kind: command.kind, data: command.data }]
      const graph = await this.reader.checked(record, events, before === undefined)
      validateRunTransition(before?.record, record, command.kind, command.data, graph, this.limits)
      if (command.kind === 'node-intent' && record.state.status === 'executing') {
        const attemptId = record.state.attempt.id
        if (before?.events.some(event => {
          if (event.kind !== 'node-intent' || !event.data || typeof event.data !== 'object') return false
          const attempt: unknown = Reflect.get(event.data, 'attempt')
          return attempt !== null && typeof attempt === 'object' && Reflect.get(attempt, 'id') === attemptId
        })) throw new WorkflowRuntimeError('conflict')
      }
      try {
        const receipt = await this.journal.commit(batch, conditions)
        this.retainedMetrics?.committed(record, command.kind)
        if (this.approvalCapture && ['approval-requested', 'approval-decided', 'run-cancelled'].includes(command.kind))
          committedEvents = [...before?.events ?? [], { kind: command.kind, at: record.updatedAt, data: command.data }]
        return receipt
      } catch (error) { this.retainedMetrics?.invalidate(); throw error }
    })
    return pending.then(async receipt => {
      // Never reacquire the non-reentrant gate, resolve credentials or send inside the run transaction.
      if (committedEvents && this.approvalCapture) {
        try { await this.approvalCapture.committed(record, committedEvents, command.kind, command.data) }
        catch { this.approvalCapture.refused(record.id, command.kind) }
      }
      return receipt
    })
  }
}

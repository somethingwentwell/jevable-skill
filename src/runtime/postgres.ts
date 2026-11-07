import { randomUUID } from 'node:crypto'
import { discoverConfiguredModels, type ModelDiscoveryOptions } from '../providers/discovery.ts'
import { recordedRoutes } from './run-routes.ts'
import { isDeepStrictEqual as same } from 'node:util'
import { z } from 'zod'
import { admitAsyncRun, parseAsyncRunOptions, type AsyncRunOptions } from './async-run.ts'
import { callerCancellationRequestSchema, callerCancellationRetry, callerCancellationTarget, prepareCallerCancellation,
  callerCancellationReceipt, type CallerCancellationRequest, type CallerCancellationReceipt } from '../access/caller-cancellation.ts'
import { callerControlRequestSchema, callerControlCheckpoint, callerControlReceipt, callerControlRetry, assertCallerControlCheckpoint,
  callerControlTarget, prepareCallerControl, type CallerControlRequest, type CallerControlCheckpoint, type CallerControlReceipt } from '../access/caller-control.ts'
import type { Span } from '@opentelemetry/api'
import type { RuntimeTelemetry } from '../telemetry/traces.ts'
import { observeGrantCall, type GrantOperation } from '../telemetry/grants.ts'
import { parseTraceRequestContext, type TraceRequestContext } from '../telemetry/baggage.ts'
import { disabledCollectorProbe } from '../telemetry/probe-report.ts'
import { telemetryConfigSchema, parseTraceParent, type TelemetryConfig } from '../telemetry/config.ts'
import { savedRunTrace } from './run-telemetry.ts'
import { PostgresJournal, type PostgresJournalOptions } from '../storage/postgres.ts'
import { PostgresProviderStore } from '../providers/postgres-store.ts'
import { ConfiguredModels } from '../providers/model-calls.ts'
import { ProviderError } from '../providers/config.ts'
import { DEFAULT_COMPILER_LIMITS as limits } from '../limits.ts'
import { admitWorkflowData, validateWorkflowValue, type CompiledWorkflow } from '../workflow/index.ts'
import { PostgresProjectStore } from '../projects/postgres-store.ts'
import type { VendorImportCommand } from '../projects/vendor-import.ts'
import type { ProjectCommand } from '../projects/ledger.ts'
import { PostgresReleaseStore, type PostgresReleaseCommand } from '../releases/postgres-store.ts'
import { inspectRelease, type Release } from '../releases/snapshot.ts'
import { PostgresTestStore } from '../testing/postgres-store.ts'
import { parseTest, testIdentitySchema, type TestCommand, type TestIdentity } from '../testing/schema.ts'
import type { GenerateTestsRequest } from '../testing/generation-schema.ts'
import type { TestErasureRequest } from '../testing/erasure-write.ts'
import { testResult as assessTest } from '../testing/results.ts'
import { validateSource } from '../validation.ts'
import { PostgresRunStore } from './postgres-store.ts'
import { compileLocalRun, admitExecution, initialCheckpoint, advanceCheckpoint, findNode } from './run-evaluator.ts'
import { executeWorkflow, type ExecutionPersistence } from './execution.ts'
import { validateBreakpoints } from './breakpoints.ts'
import { cancellationRequest, executionCheckpointHash, stoppedCheckpointHash, type LocalRun, type JevableApprovalDecision } from './run-types.ts'
import { cancellationTraceCause } from './run-trace.ts'
import { executionControlSchema, savedExecutionControlSchema, type ExecutionControl, type RunStartOptions } from './control.ts'
import { apiTriggerModeSchema, parseTriggerMode, triggerMetadata } from './trigger.ts'
import { admitPause } from './pause.ts'
import { prepareModelRecovery } from './recovery.ts'
import type { RunEventKind } from './run-transition.ts'
import { WorkflowRuntimeError } from './errors.ts'
import { RetainedRunMetrics } from './retained-metrics.ts'
import { withDomainWrite, domainQueueOccupancy } from '../storage/domain-owner.ts'
import { PostgresRunReader } from './postgres-reader.ts'
import { PostgresNotificationStore } from '../notifications/postgres-store.ts'
import { ApprovalNotificationDispatcher } from '../notifications/dispatcher.ts'
import { PostgresAutomaticAdmissionStore } from '../notifications/automatic-postgres-store.ts'
import { AutomaticApprovalOwner } from '../notifications/automatic-owner.ts'
import { verifyAutomaticStartupScopes, prepareAutomaticStartupRelease, automaticStartupReleaseRead } from '../notifications/automatic-startup.ts'
import type { AutomaticAdmissionPage } from '../notifications/automatic-admission.ts'
import { notificationPage, parseNotificationPage, filteredNotificationRecords, type NotificationPageRequest } from '../notifications/history.ts'
import { releaseNotificationPage, type NotificationReleaseScope } from '../notifications/release-history.ts'
import { projectNotificationRecords, parseNotificationProjectScope, type NotificationProjectScope } from '../notifications/project-history.ts'
import { parseNotificationConfig, type NotificationRuntimeConfig, type NotificationRuntimePolicy } from '../notifications/config.ts'
import { approvalLifecycleNotification, inspectNotificationRecord, notificationRequiresLiveWait, notificationWaitExpired, notificationRequestPin, verifyApprovalEventHistory, verifyNotificationHistory, type ApprovalNotificationPin, type NotificationRequest } from '../notifications/schema.ts'
import { PostgresGrantStore } from '../access/postgres-grants.ts'
import type { GrantIssue, GrantRevoke, GrantPageRequest } from '../access/grants.ts'
import { callerBinding, callerStartOptionsSchema, callerRunReceipt, callerRunResult, type CallerStartOptions, type CallerRunReceipt, type CallerRunResult } from '../access/caller.ts'
import { journalConditionHash } from '../storage/conditions.ts'
import { reviewerDecisionRequestSchema, reviewerRetry, reviewerReceipt, reviewerTarget, type ReviewerDecisionRequest, type ReviewerDecisionReceipt } from '../access/reviewer.ts'
import { assertReviewerRelease, type ReleaseReviewerPin } from '../releases/reviewer.ts'
import { prepareReviewerSettlement } from './reviewer.ts'

const uuid = z.uuid().transform(value => value.toLowerCase())
const startSchema = z.strictObject({ id: uuid.optional(), paused: z.boolean().optional(), triggerMode: apiTriggerModeSchema.optional() })
const policySchema = z.strictObject({ database: z.unknown(), maxRuns: z.number().int().min(1).max(100000).default(10000),
  maxTransitionsPerRun: z.number().int().min(1).max(50000).default(10000), telemetry: telemetryConfigSchema.optional(), notifications: z.unknown().optional(), startupRelease: z.unknown().optional() })
export interface PostgresRuntimeOptions { database: PostgresJournalOptions; maxRuns?: number; maxTransitionsPerRun?: number; telemetry?: TelemetryConfig; notifications?: NotificationRuntimeConfig; startupRelease?: Release }
const invalid = () => new WorkflowRuntimeError('invalid-command')
const identity = (value: string) => { const parsed = uuid.safeParse(value); if (!parsed.success) throw invalid(); return parsed.data }
// Saved test/generation keys retain the caller's spelling; normalizing a read loses that exact key.
const retainedTestIdentity = (value: string) => { const parsed = z.uuid().safeParse(value); if (!parsed.success) throw invalid(); return parsed.data }
type RunPins = Pick<LocalRun, 'project' | 'release' | 'test' | 'triggerMode'>

/** Per-operation optimistic checkpoint cursor; another operation's cancellation cannot be overwritten. */
class RunCursor {
  private journalSpan: Span | undefined
  constructor(private readonly store: PostgresRunStore, private current: { record: LocalRun; version: string },
    private readonly telemetry?: RuntimeTelemetry) {}
  get record() { return this.current.record }
  private scope<T>(work: () => T): T { return this.telemetry ? this.telemetry.withJournalFallback(this.journalSpan, work) : work() }
  async load() { this.current = await this.scope(() => this.store.get(this.record.id)); return this.record }
  async save(record: LocalRun, kind: RunEventKind, data: unknown) {
    // Only owned, schema-checked/evaluator-produced objects reach this boundary. Serialization removes aliases.
    const command = JSON.parse(JSON.stringify({ requestId: randomUUID(), expectedVersion: this.current.version, record, kind, data }))
    await this.scope(() => this.store.save(command))
    this.current = { record: command.record as LocalRun, version: String(BigInt(this.current.version) + 1n) }
    return this.record
  }
  async finishCancellation(record = this.record): Promise<LocalRun> {
    if (!record.cancellation || ['completed', 'failed', 'cancelled'].includes(record.state.status)) return record
    const segment = this.telemetry?.segment(record, 'cancel')
    const settle = async () => {
      let failed = true
      try {
        record = await this.saveSegment(record, segment, 'cancel')
        const prior = record.state as Exclude<LocalRun['state'], { status: 'completed' | 'failed' | 'cancelled' }>
        const state = { ...prior, status: 'cancelled', previousStatus: prior.status } as LocalRun['state']
        const result = await this.save({ ...record, state, updatedAt: new Date().toISOString() }, 'run-cancelled', {
          requestId: record.cancellation!.id, previousStatus: prior.status, next: prior.next,
          attemptId: 'attempt' in prior ? prior.attempt.id : null, checkpointSha256: stoppedCheckpointHash(state),
        })
        failed = false; return result
      } finally { this.telemetry?.end(segment, failed ? 'failed-or-uncertain' : 'cancelled', failed) }
    }
    return this.telemetry ? this.telemetry.withJournalSpan(segment, settle) : settle()
  }
  async saveSegment(record: LocalRun, span: Span | undefined, operation: 'run' | 'resume' | 'approval' | 'cancel') {
    const trace = savedRunTrace(span)
    if (!trace) return record
    if ((record.traceSegments?.length ?? 0) >= 10000) throw new WorkflowRuntimeError('limit')
    const previous = record.traceSegments?.at(-1)?.trace, parent = this.telemetry?.parent()
    const cause = operation === 'cancel' ? cancellationTraceCause(record) : undefined
    const entry = { operation, at: new Date().toISOString(), trace, ...(previous ? { previous } : {}), ...(parent ? { parent } : {}),
      ...(cause ? { cause } : {}) }
    this.journalSpan = span
    const work = () => this.save({ ...record, traceSegments: [...record.traceSegments ?? [], entry] }, 'execution-segment', entry)
    return this.telemetry ? this.telemetry.withJournalSpan(span, work) : work()
  }
  port(): ExecutionPersistence {
    return { load: () => this.load(), events: id => this.scope(() => this.store.events(id)),
      save: async (record, kind, data) => { await this.save(record, kind, data) },
      saveSegment: (record, span, operation) => this.saveSegment(record, span, operation), finishCancellation: record => this.finishCancellation(record) }
  }
}

/** Experimental standalone SDK execution host. Owns its exact PostgreSQL session; never reconnects or redispatches on open. */
export class PostgresRuntime {
  private lifecycle: 'open' | 'closing' | 'closed' = 'open'
  private operations = 0
  private configuring = false
  private closing: Promise<void> | undefined
  private telemetry: RuntimeTelemetry | undefined
  private readonly flushes = new Set<Promise<unknown>>()
  private readonly active = new Map<string, AbortController>()
  private readonly creatingCallers = new Map<string, string>()
  private readonly runs: PostgresRunStore
  private readonly providers: PostgresProviderStore
  private readonly models: ConfiguredModels
  private readonly projectStore: PostgresProjectStore
  private readonly releaseStore: PostgresReleaseStore
  private readonly testStore: PostgresTestStore
  private readonly grantStore: PostgresGrantStore
  private readonly reader: PostgresRunReader
  private constructor(private readonly journal: PostgresJournal, private readonly maxTransitions: number, maxRuns: number, maxRecordBytes: number,
    private readonly notificationPolicy: NotificationRuntimePolicy, retainedMetrics?: RetainedRunMetrics) {
    this.runs = new PostgresRunStore(journal, limits, maxRecordBytes, maxRuns, retainedMetrics)
    this.providers = new PostgresProviderStore(journal, maxRecordBytes)
    this.models = new ConfiguredModels(this.providers)
    this.projectStore = new PostgresProjectStore(journal, limits.source, maxRecordBytes)
    this.releaseStore = new PostgresReleaseStore(journal, maxRecordBytes)
    this.testStore = new PostgresTestStore(journal, limits, maxRecordBytes)
    this.grantStore = new PostgresGrantStore(journal, undefined, action => this.telemetry?.observeGrantPolicy(action))
    const reader = this.reader = new PostgresRunReader(journal, limits, maxRecordBytes)
    this.automaticStore = new PostgresAutomaticAdmissionStore(journal, notificationPolicy.automatic
      ? { maxAdmissions: notificationPolicy.automatic.maxAdmissions, maxEvents: notificationPolicy.automatic.maxEvents }
      : { maxAdmissions: 100000, maxEvents: 200000 }, {
      history: async record => {
        const run = await reader.read(record.request.runId)
        verifyApprovalEventHistory(record.event, record.createdAt, run.record, run.events)
      },
      delivery: async id => {
        const row = await journal.get('approval-deliveries', id)
        if (!row) return undefined
        const record = inspectNotificationRecord(row.value)
        if (row.deleted || row.key !== record.request.requestId || row.version !== (record.outcome.status === 'pending' ? '1' : '2'))
          throw new WorkflowRuntimeError('corrupt')
        return record
      },
    })
    this.notificationStore = new PostgresNotificationStore(journal, {
      maxDeliveries: notificationPolicy.maxDeliveries, maxEvents: notificationPolicy.maxEvents,
    }, {
      history: async record => {
        const run = await reader.read(record.request.runId)
        verifyNotificationHistory(record, run.record, run.events)
      },
      admission: async record => {
        // The shared domain gate excludes run decisions/cancellation until the intent commit has finished.
        const run = await reader.read(record.request.runId)
        verifyNotificationHistory(record, run.record, run.events)
        if (!same(approvalLifecycleNotification(run.record, run.events, notificationRequestPin(record.request)), record.event)
          || notificationRequiresLiveWait(record.event) && notificationWaitExpired(record.event)) throw new WorkflowRuntimeError('conflict')
      },
    })
    this.notifications = new ApprovalNotificationDispatcher({
      signal: journal.signal,
      requested: pin => withDomainWrite(journal, async () => {
        const run = await reader.read(pin.runId)
        return approvalLifecycleNotification(run.record, run.events, pin)
      }),
      credential: ref => this.providers.credentialSnapshot(ref),
      observeNotification: (record, previous) => {
        if (!this.telemetry) return undefined
        return withDomainWrite(journal, async () => this.telemetry?.notification(record, (await reader.read(record.request.runId)).record, previous))
      },
    }, this.notificationStore, notificationPolicy.endpoints, { maxInFlight: notificationPolicy.maxInFlight })
  }
  private readonly notificationStore: PostgresNotificationStore
  private readonly notifications: ApprovalNotificationDispatcher
  private readonly automaticStore: PostgresAutomaticAdmissionStore
  private automaticNotifications: AutomaticApprovalOwner | undefined
  /** Startup attachment after verified scopes. Existing owner supplies storage/dispatcher; never a restart scan. */
  private enableAutomaticNotifications(policy: unknown, maxPending = 16) {
    this.assertOpen()
    if (this.automaticNotifications || this.operations || this.active.size || this.configuring) throw new WorkflowRuntimeError('busy')
    const owner = new AutomaticApprovalOwner(policy, this.automaticStore, this.notifications, maxPending)
    this.runs.observeCommittedApprovals(owner)
    this.automaticNotifications = owner
  }
  static async open(options: PostgresRuntimeOptions): Promise<PostgresRuntime> {
    const policy = policySchema.safeParse(options)
    if (!policy.success) throw invalid()
    const notificationPolicy = parseNotificationConfig(options.notifications === undefined ? {} : options.notifications)
    const startupRelease = prepareAutomaticStartupRelease(options.startupRelease, notificationPolicy.automatic)
    const maxRecordBytes = options.database?.maxRecordBytes ?? 4_000_000
    const journal = await PostgresJournal.open(options.database)
    let telemetry: RuntimeTelemetry | undefined
    try {
      const retained = policy.data.telemetry?.retainedStateMetrics ? new RetainedRunMetrics(policy.data.maxRuns, () => !journal.signal.aborted) : undefined
      const runtime = new PostgresRuntime(journal, policy.data.maxTransitionsPerRun, policy.data.maxRuns, maxRecordBytes, notificationPolicy, retained)
      await runtime.providers.listConnections()
      await runtime.projectStore.list()
      for (const read of [
        (after?: string) => runtime.projectStore.deletions(after),
        (after?: string) => runtime.releaseStore.list(after),
        (after?: string) => runtime.testStore.list(after),
        (after?: string) => runtime.testStore.generations(after),
      ]) {
        let after: string | undefined
        do { after = (await read(after)).nextCursor ?? undefined } while (after)
      }
      let after: string | undefined, count = 0
      do {
        const page = await runtime.runs.list(after)
        count += page.runs.length
        if (count > policy.data.maxRuns) throw new WorkflowRuntimeError('limit')
        after = page.nextCursor ?? undefined
      } while (after)
      await runtime.notificationStore.validate()
      await runtime.automaticStore.validate()
      await runtime.grantStore.validate()
      await runtime.testStore.validateErasures()
      if (notificationPolicy.automatic) await withDomainWrite(journal, () => verifyAutomaticStartupScopes(notificationPolicy.automatic!, {
        project: (id, generation) => runtime.projectStore.get(id, generation),
        release: id => automaticStartupReleaseRead(id, () => runtime.releaseStore.get(id), startupRelease),
      }))
      retained?.ready()
      const telemetryPolicy = policy.data.telemetry
      if (telemetryPolicy) {
        const credential = () => {
          const read = () => telemetryPolicy.authentication.kind === 'bearer'
            ? runtime.providers.credential(telemetryPolicy.authentication.credentialRef) : undefined
          // Exporter credential SQL remains real/counted, but cannot recursively create trace/log work.
          return telemetryPolicy.journalTransactions ? journal.withTransactionObservationsSuppressed(read) : read()
        }
        if (telemetryPolicy.authentication.kind === 'bearer' && !await credential()) throw invalid()
        if (telemetryPolicy.storageTransactionMetrics) journal.enableTransactionMetrics()
        const { RuntimeTelemetry } = await import('../telemetry/traces.ts')
        runtime.telemetry = telemetry = new RuntimeTelemetry(telemetryPolicy, credential, { storage: 'postgres', canExport: () => !runtime.configuring,
          runtimeWork: () => runtime.lifecycle === 'open' && journal.status().state === 'open' && !journal.signal.aborted
            ? { available: true, operations: runtime.operations, runReservations: runtime.active.size } : { available: false },
          storageQueues: () => runtime.lifecycle === 'open' && journal.status().state === 'open' && !journal.signal.aborted
            ? { available: true, domain: domainQueueOccupancy(journal), journal: journal.queueOccupancy() } : { available: false },
          storageTransactions: () => journal.transactionMetrics(),
          ...(retained ? { retainedState: () => retained.snapshot() } : {}) })
        if (telemetryPolicy.journalTransactions) journal.setTransactionObserver(kind => runtime.telemetry?.observeJournalTransaction(kind))
      }
      if (startupRelease) await runtime.releaseStore.put(startupRelease.snapshot, true)
      if (notificationPolicy.automatic) runtime.enableAutomaticNotifications(notificationPolicy.automatic.policy, notificationPolicy.automatic.maxPending)
      return runtime
    } catch (error) {
      try { await telemetry?.close() } finally { await journal.close() }
      throw error
    }
  }
  private assertOpen() {
    if (this.lifecycle !== 'open') throw new WorkflowRuntimeError('closed')
    this.journal.signal.throwIfAborted()
  }
  private async operation<T>(work: () => Promise<T>): Promise<T> {
    this.assertOpen()
    if (this.configuring) throw new WorkflowRuntimeError('busy')
    this.operations++
    try { return await work() } finally { this.operations-- }
  }
  private async configuration<T>(work: () => Promise<T>): Promise<T> {
    this.assertOpen()
    if (this.operations || this.active.size || this.configuring || this.flushes.size || this.automaticNotifications?.busy() || this.telemetry?.busy()) throw new WorkflowRuntimeError('busy')
    this.configuring = true
    try { return await work() } finally { this.configuring = false }
  }
  private async cursor(id: string) { return new RunCursor(this.runs, await this.runs.get(id), this.telemetry) }
  private journalScope<T>(span: Span | undefined, work: () => T): T { return this.telemetry ? this.telemetry.withJournalSpan(span, work) : work() }
  private async existing(id: string) {
    try { return await this.cursor(id) }
    catch (error) { if (error instanceof WorkflowRuntimeError && error.code === 'not-found') return undefined; throw error }
  }
  private async withRun<T>(id: string, work: (controller: AbortController) => Promise<T>): Promise<T> {
    if (this.active.has(id)) throw new WorkflowRuntimeError('busy')
    const controller = new AbortController(); this.active.set(id, controller)
    try { return await work(controller) }
    finally { this.active.delete(id) }
  }
  private async admit(cursor: RunCursor, graph: CompiledWorkflow) {
    try { await admitExecution(graph, this.models) }
    catch (error) {
      try { await cursor.load() } catch { throw error }
      if (!cursor.record.cancellation) throw error
    }
  }
  private async execute(cursor: RunCursor, graph: CompiledWorkflow, controller: AbortController, operation: 'run' | 'resume' | 'approval', budget = Infinity, control?: ExecutionControl, continuedSpan?: Span) {
    return executeWorkflow({ initial: cursor.record, graph, limits, maxTransitions: this.maxTransitions, operation,
      signal: AbortSignal.any([controller.signal, this.journal.signal]), port: cursor.port(), models: this.models, budget, control,
      telemetry: this.telemetry, continuedSpan })
  }

  health() { return this.operation(async () => ({ ...await this.journal.health(), storage: 'postgres' as const,
    activeRuns: this.active.size, telemetry: this.telemetryStatus() })) }
  telemetryStatus() { return this.telemetry?.status() ?? { enabled: false, signals: [] } }
  telemetryProbe(options: { signal?: AbortSignal } = {}) {
    return this.operation(async () => this.telemetry ? this.telemetry.probe({ signal: options.signal
      ? AbortSignal.any([this.journal.signal, options.signal]) : this.journal.signal }) : disabledCollectorProbe())
  }
  observeHttpRequest(method: string | undefined, path: string | undefined) { return this.telemetry?.observeHttpRequest(method, path) }
  observeHttpAccess(stage: import('../http/access-observation.ts').HttpAccessStage) { return this.telemetry?.observeHttpAccess(stage) }
  observeHttpRateSql(operation: import('../http/rate-sql-observation.ts').HttpRateSqlOperation, parent: import('@opentelemetry/api').SpanContext | undefined) { return this.telemetry?.observeHttpRateSql(operation, parent) }
  observeHttpAsyncSlot() { return this.telemetry?.observeHttpAsyncSlot() }
  observeTestSuite(identity: import('../testing/suite-observation.ts').SuiteObservationIdentity) { return this.telemetry?.observeTestSuite(identity) }
  observeHttpConnection(transport: import('../telemetry/connections.ts').HttpTransport) { return this.telemetry?.observeHttpConnection(transport) }
  observeHttpTransportFailure(transport: import('../telemetry/connections.ts').HttpTransport, failure: import('../telemetry/connections.ts').HttpTransportFailure) { this.telemetry?.observeHttpTransportFailure(transport, failure) }
  async telemetryFlush() {
    this.assertOpen()
    if (this.configuring) throw new WorkflowRuntimeError('busy')
    const flushing = this.telemetry ? this.telemetry.flush() : Promise.resolve(this.telemetryStatus())
    this.flushes.add(flushing)
    try { return await flushing } finally { this.flushes.delete(flushing) }
  }
  withTraceParent<T>(parent: string | undefined, operation: () => T): T {
    this.assertOpen(); parseTraceParent(parent)
    return this.telemetry ? this.telemetry.withParent(parent, operation) : operation()
  }
  withTraceContext<T>(value: TraceRequestContext, operation: () => T): T {
    this.assertOpen()
    const context = parseTraceRequestContext(value)
    return this.withTraceParent(context.traceparent, () => this.telemetry ? this.telemetry.withBaggage(context.baggage, operation) : operation())
  }
  show(id: string) { return this.operation(async () => (await this.runs.get(identity(id))).record) }
  list(after?: string, limit = 100) { return this.operation(() => this.runs.list(after, limit)) }
  listRelease(pin: { id: string; sha256: string; revision: string }, after?: string, limit = 100) {
    return this.operation(() => this.runs.listRelease(pin, after, limit))
  }
  events(id: string) { return this.operation(() => this.runs.events(identity(id))) }
  exportRun(id: string, includePrivate = false) { return this.operation(() => this.runs.evidence(identity(id), includePrivate)) }
  exportUsageRun(id: string) { return this.operation(() => this.runs.evidence(identity(id), false, true)) }
  check(yaml: string, triggerMode?: 'api') {
    return this.operation(async () => {
      parseTriggerMode(triggerMode)
      const result = validateSource(yaml, limits)
      if (result.status !== 'valid') return { ...result, ...triggerMetadata({ triggerMode }) }
      try { await admitExecution(compileLocalRun(yaml, limits, triggerMode), this.models); return { ...result, ...triggerMetadata({ triggerMode }), runtimeReadiness: 'ready' as const } }
      catch (error) {
        if (!(error instanceof ProviderError || error instanceof WorkflowRuntimeError)) throw error
        return { ...result, ...triggerMetadata({ triggerMode }), runtimeReadiness: 'unavailable' as const, diagnostics: [{ code: error.code, message: error.message }] }
      }
    })
  }
  connections() { return this.operation(() => this.providers.listConnections()) }
  discoverModels(id: string, options?: ModelDiscoveryOptions) { return this.operation(() => discoverConfiguredModels(this.providers, id, options)) }
  notificationDestinations() { this.assertOpen(); return this.notifications.destinations() }
  automaticApprovalNotificationStatus() {
    this.assertOpen()
    return { schemaVersion: 1 as const, configured: !!this.notificationPolicy.automatic,
      ...(this.notificationPolicy.automatic ? { policySha256: this.notificationPolicy.automatic.reviewedPolicySha256,
        routeCount: this.notificationPolicy.automatic.policy.routes.length } : {}),
      live: this.automaticNotifications?.snapshot() ?? null }
  }
  automaticApprovalAdmissions(page: AutomaticAdmissionPage = {}) { return this.operation(() => this.automaticStore.page(page)) }
  automaticApprovalAdmission(requestId: string) {
    return this.operation(async () => {
      const record = await this.automaticStore.get(requestId)
      if (!record) throw new WorkflowRuntimeError('not-found')
      return record
    })
  }
  prepareApprovalNotification(pin: ApprovalNotificationPin, endpointId: string) {
    return this.operation(() => this.notifications.prepare(pin, endpointId))
  }
  inspectApprovalNotification(requestId: string) { return this.operation(() => this.notifications.inspect(requestId)) }
  abortApprovalNotification(requestId: string) { return this.operation(() => this.notifications.abort(requestId)) }
  listApprovalNotifications(value: NotificationPageRequest, release?: NotificationReleaseScope) {
    const options = parseNotificationPage(value)
    return this.operation(async () => {
      const page = release === undefined ? options.filter === undefined ? await this.notificationStore.page(options)
        : await filteredNotificationRecords(this.notificationStore, options)
        : await releaseNotificationPage(this.notificationStore, release, options)
      return notificationPage(page.records, page.nextCursor, options)
    })
  }
  listProjectApprovalNotifications(project: NotificationProjectScope, value: NotificationPageRequest) {
    const scope = parseNotificationProjectScope(project), options = parseNotificationPage(value)
    return this.operation(async () => {
      const page = await projectNotificationRecords(this.notificationStore, scope, options)
      return { ...notificationPage(page.records, page.nextCursor, options), project: scope }
    })
  }
  sendApprovalNotification(request: NotificationRequest, actor: string, options: { signal?: AbortSignal } = {}) {
    return this.operation(() => this.notifications.send(request, actor, options))
  }
  configureConnection(value: unknown, expectedGeneration: number, actor: string) { return this.configuration(() => this.providers.putConnection(value, expectedGeneration, actor)) }
  credentialStatus(ref: string) { return this.operation(() => this.providers.credentialStatus(ref)) }
  setCredential(ref: string, value: string, expectedGeneration: number, actor: string) { return this.configuration(() => this.providers.setCredential(ref, value, expectedGeneration, actor)) }
  clearCredential(ref: string, expectedGeneration: number, actor: string) { return this.configuration(() => this.providers.clearCredential(ref, expectedGeneration, actor)) }
  providerAudit(after = '0', limit = 100) { return this.operation(() => this.providers.auditEvents(after, limit)) }

  activityReport() { return this.operation(() => this.runs.activity(() => this.projectStore.activity())) }
  /** Trusted owner SDK administration only; action-level delegated authority is a separate boundary. */
  private grantOperation<T>(kind: GrantOperation, work: () => T): T {
    return observeGrantCall(() => this.telemetry?.observeGrantOperation(kind), work)
  }
  grant(id: string) { return this.operation(() => this.grantOperation('get', () => this.grantStore.get(id))) }
  grants(page: GrantPageRequest = {}) { return this.operation(() => this.grantOperation('page', () => this.grantStore.page(page))) }
  issueGrant(command: GrantIssue) {
    return this.operation(() => this.grantOperation('issue', () => this.grantStore.issue(command, async (scope, at) => {
      if (scope.kind === 'caller') {
        const release = await this.releaseStore.get(scope.release.id)
        if (release.sha256 !== scope.release.sha256 || release.snapshot.workflow.revision !== scope.release.revision) throw new WorkflowRuntimeError('conflict')
      } else {
        const run = (await this.reader.read(scope.runId)).record
        if (run.revision !== scope.revision || run.cancellation || run.state.status !== 'waiting'
          || run.state.attempt.id !== scope.attemptId || Date.parse(run.state.expiresAt) <= Date.parse(at)) throw new WorkflowRuntimeError('conflict')
        const graph = compileLocalRun(run.yaml, limits, run.triggerMode)
        const plan = findNode(graph, run.state.next, run.state.scope)?.plan
        if (plan?.kind !== 'humanApproval' || scope.decisions.some(action => !plan.actions.includes(action)))
          throw invalid()
      }
    })))
  }
  revokeGrant(command: GrantRevoke) { return this.operation(() => this.grantOperation('revoke', () => this.grantStore.revoke(command))) }
  projects() { return this.operation(() => this.projectStore.list()) }
  projectDeletion(id: string) { return this.operation(() => this.projectStore.deletion(identity(id))) }
  projectDeletions(after?: string, limit = 100) { return this.operation(() => this.projectStore.deletions(after, limit)) }
  deleteProject(id: string, expectedGeneration: number, actor: string) {
    return this.operation(() => this.projectStore.deleteArchived({ id: identity(id), expectedGeneration, actor }))
  }
  project(id: string, generation?: number) { return this.operation(() => this.projectStore.get(identity(id), generation)) }
  editProject(command: ProjectCommand) { return this.operation(() => this.projectStore.execute(command)) }
  createVendorImport(command: VendorImportCommand) { return this.operation(() => this.projectStore.createVendorImport(command)) }
  vendorImport(id: string, inspect = false) { return this.operation(() => this.projectStore.vendorImport(identity(id), inspect)) }
  diffProject(id: string, from: string, to: string) { return this.operation(() => this.projectStore.diff(identity(id), from, to)) }
  exportProject(id: string, expectedGeneration: number, reviewedRevision: string, history = false, includeTests = false) {
    return this.operation(() => this.projectStore.export(identity(id), expectedGeneration, reviewedRevision, history, includeTests))
  }
  inspectProjectImport(json: string) { return this.operation(async () => this.projectStore.inspectImport(json)) }
  importProject(json: string, reviewedSha256: string, actor: string, newId?: string) {
    return this.operation(() => this.projectStore.import(json, reviewedSha256, actor, newId))
  }
  releases(after?: string, limit = 100) { return this.operation(() => this.releaseStore.list(after, limit)) }
  release(id: string) { return this.operation(() => this.releaseStore.get(identity(id))) }
  createRelease(command: PostgresReleaseCommand) { return this.operation(() => this.releaseStore.create(command)) }
  testCases(after?: string, limit = 100) { return this.operation(() => this.testStore.list(after, limit)) }
  testCase(id: string, generation?: number) { return this.operation(() => this.testStore.get(retainedTestIdentity(id), generation)) }
  testHistory(id: string) { return this.operation(() => this.testStore.history(retainedTestIdentity(id))) }
  editTest(command: TestCommand) { return this.operation(() => this.testStore.execute(command)) }
  eraseTest(command: TestErasureRequest) { return this.operation(() => this.testStore.erase(command)) }
  testErasure(requestId: string) { return this.operation(() => this.testStore.erasure(requestId)) }
  generateTests(command: GenerateTestsRequest) { return this.operation(() => this.testStore.generate(command)) }
  testGeneration(id: string) { return this.operation(() => this.testStore.generation(retainedTestIdentity(id))) }
  testGenerations(after?: string, limit = 100) {
    return this.operation(async () => {
      const page = await this.testStore.generations(after, limit)
      return { generations: page.generations.map(({ snapshot: { cases, ...snapshot }, sha256 }) => ({ ...snapshot, caseCount: cases.length, sha256 })), nextCursor: page.nextCursor }
    })
  }
  private async assess(run: LocalRun, inspect = false) {
    if (!run.test) throw new WorkflowRuntimeError('conflict')
    return assessTest(await this.testStore.get(run.test.id, run.test.generation), run, inspect)
  }
  testResult(id: string, inspect = false) {
    return this.operation(async () => {
      if (typeof inspect !== 'boolean') throw invalid()
      return this.assess((await this.runs.get(identity(id))).record, inspect)
    })
  }

  private options(value: RunStartOptions) {
    const parsed = startSchema.safeParse(value); if (!parsed.success) throw invalid()
    return { id: parsed.data.id ?? randomUUID(), paused: parsed.data.paused === true, ...triggerMetadata(parsed.data) }
  }
  private async retry(id: string, revision: string, input: unknown, paused: boolean, pins: RunPins) {
    const cursor = await this.existing(id)
    if (!cursor) return undefined
    const record = cursor.record
    if (record.revision !== revision || !same(record.input, input) || Boolean(record.startedPaused) !== paused
      || !same(record.project, pins.project) || !same(record.release, pins.release) || !same(record.test, pins.test)
      || record.triggerMode !== pins.triggerMode || record.caller !== undefined) throw new WorkflowRuntimeError('conflict')
    return record
  }
  /** Internal provenance is supplied only by reviewed domain entrypoints, never public start options. */
  private async start(yaml: string, input: unknown, id: string, paused: boolean, pins: RunPins, controller: AbortController, created?: (run: LocalRun) => void) {
    const graph = compileLocalRun(yaml, limits, pins.triggerMode), admitted = validateWorkflowValue(graph.input, input, limits.binding.data)
    const prior = await this.retry(id, graph.source.revision, admitted, paused, pins)
    if (prior) return prior
    await admitExecution(graph, this.models)
    const at = new Date().toISOString(), record: LocalRun = { schemaVersion: 1, id, yaml: graph.source.yaml, revision: graph.source.revision,
      input: structuredClone(admitted) as LocalRun['input'], createdAt: at, updatedAt: at, ...(paused ? { startedPaused: true } : {}),
      state: initialCheckpoint(graph), loopDeadlines: {}, ...pins }
    // The run adapter rechecks current project/test review under the shared domain queue, in the write admission.
    await this.runs.save(JSON.parse(JSON.stringify({ requestId: id, expectedVersion: '0', record, kind: 'run-created',
      data: { revision: record.revision, ...(paused ? { startedPaused: true } : {}), ...pins } })))
    const cursor = await this.cursor(id)
    created?.(cursor.record)
    return paused ? cursor.record : this.execute(cursor, graph, controller, 'run')
  }

  run(yaml: string, input: unknown, options: RunStartOptions = {}) {
    return this.operation(async () => {
      const { id, paused, triggerMode } = this.options(options)
      return this.withRun(id, controller => this.start(yaml, input, id, paused, triggerMetadata({ triggerMode }), controller))
    })
  }

  runAsync(yaml: string, input: unknown, options: AsyncRunOptions) {
    return admitAsyncRun(created => this.operation(async () => {
      const { id, paused, triggerMode } = this.options(parseAsyncRunOptions(options))
      return this.withRun(id, controller => this.start(yaml, input, id, paused, triggerMetadata({ triggerMode }), controller, created))
    }))
  }

  /** Experimental direct SDK caller surface; never imports request source or returns owner run payloads. */
  startWithGrant(token: string, input: unknown, value: CallerStartOptions,
    context?: import('../access/caller.ts').CallerContext<CallerRunReceipt>): Promise<CallerRunReceipt> {
    return this.operation(async () => {
      const parsed = callerStartOptionsSchema.safeParse(value)
      if (!parsed.success || context !== undefined && typeof context !== 'function') throw invalid()
      const captured = admitWorkflowData(input, limits.binding.data)
      const principal = await this.grantStore.lookup(token)
      if (!principal || principal.scope.kind !== 'caller' || !principal.scope.permissions.includes('start')) throw new WorkflowRuntimeError('not-found')
      const id = parsed.data.id, pin = principal.scope.release, paused = parsed.data.paused === true, trigger = triggerMetadata(parsed.data)
      const execute = async () => {
        if (context) {
          const fresh = await this.grantStore.lookup(token)
          if (!fresh || fresh.grantId !== principal.grantId || !same(fresh.scope, principal.scope)) throw new WorkflowRuntimeError('not-found')
        }
        if (this.active.has(id)) {
          if (this.creatingCallers.get(id) !== principal.grantId) await this.runs.caller(token, id, 'start')
          throw new WorkflowRuntimeError('busy')
        }
        return this.withRun(id, async controller => {
          this.creatingCallers.set(id, principal.grantId)
          try {
            const release = await this.releaseStore.get(pin.id)
            if (release.sha256 !== pin.sha256 || release.snapshot.workflow.revision !== pin.revision) throw new WorkflowRuntimeError('corrupt')
            const graph = compileLocalRun(release.snapshot.workflow.yaml, limits, parsed.data.triggerMode), admitted = validateWorkflowValue(graph.input, captured, limits.binding.data)
            const prior = await this.runs.caller(token, id, 'start', true)
            if (prior) {
              if (prior.record.revision !== pin.revision || !same(prior.record.input, admitted)
                || Boolean(prior.record.startedPaused) !== paused || prior.record.triggerMode !== parsed.data.triggerMode) throw new WorkflowRuntimeError('conflict')
              return callerRunReceipt(prior.record)
            }
            await admitExecution(graph, this.models)
            const planned = await this.grantStore.planAction(token, { kind: 'start', release: pin }, async () => {
              const current = await this.releaseStore.get(pin.id), row = await this.journal.get('releases', pin.id)
              if (!row || row.deleted || current.sha256 !== pin.sha256 || current.snapshot.workflow.revision !== pin.revision
                || !same(row.value, { format: 'jevable.pg-release/v1', ...current })) throw new WorkflowRuntimeError('corrupt')
              return { target: { kind: 'release', release: pin },
                condition: { collection: 'releases', key: pin.id, version: row.version, sha256: journalConditionHash(row.value) } }
            })
            const caller = callerBinding(planned.admission), at = caller.at
            const record: LocalRun = { schemaVersion: 1, id, revision: graph.source.revision, yaml: graph.source.yaml,
              input: structuredClone(admitted) as LocalRun['input'], createdAt: at, updatedAt: at, ...(paused ? { startedPaused: true } : {}),
              ...trigger, release: { id: pin.id, sha256: pin.sha256 }, caller, state: initialCheckpoint(graph), loopDeadlines: {} }
            await this.runs.saveCallerCreation(JSON.parse(JSON.stringify({ requestId: id, expectedVersion: '0', record, kind: 'run-created',
              data: { revision: record.revision, ...(paused ? { startedPaused: true } : {}), ...trigger, release: record.release, caller } })), planned.conditions)
            const cursor = await this.cursor(id)
            return callerRunReceipt(paused ? cursor.record : await this.execute(cursor, graph, controller, 'run'))
          } finally { this.creatingCallers.delete(id) }
        })
      }
      return context ? context(structuredClone(pin), execute) : execute()
    })
  }
  /** Read/retry authorization is independent from any stale write receipt; never dispatches execution. */
  readWithGrant(token: string, value: string,
    context?: import('../access/caller.ts').CallerContext<CallerRunResult>): Promise<CallerRunResult> {
    return this.operation(async () => {
      if (context !== undefined && typeof context !== 'function') throw invalid()
      const id = identity(value), result = await this.runs.caller(token, id, 'read')
      if (!result) throw new WorkflowRuntimeError('not-found')
      const pin = result.record.caller!.scope.release
      const execute = async () => {
        const fresh = context ? await this.runs.caller(token, id, 'read') : result
        if (!fresh || fresh.record.caller?.grantId !== result.record.caller?.grantId || !same(fresh.record.caller?.scope, result.record.caller?.scope))
          throw new WorkflowRuntimeError('not-found')
        return callerRunResult(fresh.record)
      }
      return context ? context(structuredClone(pin), execute) : execute()
    })
  }
  /** Caller-only cancellation; guarded journal admission is distinct from observing a saved request. */
  cancelWithGrant(token: string, value: string, request: CallerCancellationRequest,
    context?: import('../access/caller.ts').CallerContext<CallerCancellationReceipt>): Promise<CallerCancellationReceipt> {
    return this.operation(async () => {
      const id = identity(value), parsed = callerCancellationRequestSchema.safeParse(request)
      if (!parsed.success || context !== undefined && typeof context !== 'function') throw invalid()
      const initial = await this.runs.caller(token, id, 'cancel')
      if (!initial) throw new WorkflowRuntimeError('not-found')
      const execute = async () => {
        const current = await this.runs.caller(token, id, 'cancel')
        if (!current || current.record.caller?.grantId !== initial.record.caller?.grantId
          || !same(current.record.caller?.scope, initial.record.caller?.scope)) throw new WorkflowRuntimeError('not-found')
        const retry = callerCancellationRetry(current.record, parsed.data)
        if (retry) return retry
        let retained: Awaited<ReturnType<PostgresRunReader['read']>> | undefined
        const planned = await this.grantStore.planAction(token, { kind: 'cancel', runId: id }, async () => {
          const selected = await this.journal.callerRun({ id, grantId: current.record.caller!.grantId, release: current.record.caller!.scope.release })
          if (!selected) throw new WorkflowRuntimeError('not-found')
          retained = await this.reader.read(id)
          if (selected.version !== retained.version || !same(selected.value, { format: 'jevable.pg-run/v1', record: retained.record }))
            throw new WorkflowRuntimeError('corrupt')
          return { target: callerCancellationTarget(retained.record), condition: { collection: 'runs', key: id, version: selected.version,
            sha256: journalConditionHash(selected.value) } }
        })
        if (!retained) throw new WorkflowRuntimeError('corrupt')
        const settlement = prepareCallerCancellation(retained.record, parsed.data, planned.admission, this.telemetry?.parent())
        await this.runs.save(JSON.parse(JSON.stringify({ requestId: parsed.data.requestId, expectedVersion: retained.version,
          record: settlement.record, kind: 'cancellation-requested', data: settlement.cancellation })), planned.conditions)
        this.active.get(id)?.abort()
        if (this.active.has(id)) return callerCancellationReceipt(settlement.record)
        const cursor = await this.cursor(id)
        return callerCancellationReceipt(await cursor.finishCancellation())
      }
      return context ? context(structuredClone(initial.record.caller!.scope.release), execute) : execute()
    })
  }

  /** Read-only control metadata, not output/read authority or permission to replay work. */
  controlCheckpointWithGrant(token: string, value: string,
    context?: import('../access/caller.ts').CallerContext<CallerControlCheckpoint>): Promise<CallerControlCheckpoint> {
    return this.operation(async () => {
      if (context !== undefined && typeof context !== 'function') throw invalid()
      const id = identity(value), initial = await this.runs.caller(token, id, 'control')
      if (!initial) throw new WorkflowRuntimeError('not-found')
      const execute = async () => {
        const fresh = await this.runs.caller(token, id, 'control')
        if (!fresh || fresh.record.caller?.grantId !== initial.record.caller?.grantId
          || !same(fresh.record.caller?.scope, initial.record.caller?.scope)) throw new WorkflowRuntimeError('not-found')
        return callerControlCheckpoint(fresh.record)
      }
      return context ? context(structuredClone(initial.record.caller!.scope.release), execute) : execute()
    })
  }

  /** Exact guarded caller control admission; model recovery must already be read-only verified. */
  private async admitCallerControl(token: string, id: string, request: CallerControlRequest, original: NonNullable<LocalRun['caller']>) {
    let retained: Awaited<ReturnType<PostgresRunReader['read']>> | undefined
    const planned = await this.grantStore.planAction(token, { kind: 'control', runId: id }, async () => {
      const selected = await this.journal.callerRun({ id, grantId: original.grantId, release: original.scope.release })
      if (!selected) throw new WorkflowRuntimeError('not-found')
      retained = await this.reader.read(id)
      if (selected.version !== retained.version || !same(selected.value, { format: 'jevable.pg-run/v1', record: retained.record }))
        throw new WorkflowRuntimeError('corrupt')
      return { target: callerControlTarget(retained.record), condition: { collection: 'runs', key: id, version: selected.version,
        sha256: journalConditionHash(selected.value) } }
    })
    if (!retained || planned.admission.grantId !== original.grantId || !same(planned.admission.scope, original.scope))
      throw new WorkflowRuntimeError('not-found')
    const result = prepareCallerControl(retained.record, request, planned.admission)
    await this.runs.save(JSON.parse(JSON.stringify({ requestId: request.requestId, expectedVersion: retained.version,
      record: result.record, kind: 'execution-requested', data: result.control })), planned.conditions)
    return result.record
  }

  /** Separately authenticated caller SDK. Retained retries never acquire worker authority or dispatch. */
  advanceWithGrant(token: string, value: string, command: CallerControlRequest,
    context?: import('../access/caller.ts').CallerContext<CallerControlReceipt>): Promise<CallerControlReceipt> {
    return this.operation(async () => {
      const id = identity(value), parsed = callerControlRequestSchema.safeParse(command)
      if (!parsed.success || context !== undefined && typeof context !== 'function') throw invalid()
      const initial = await this.runs.caller(token, id, 'control')
      if (!initial) throw new WorkflowRuntimeError('not-found')
      const request = parsed.data, original = initial.record.caller!, execute = async () => {
        const fresh = await this.runs.caller(token, id, 'control')
        if (!fresh || fresh.record.caller?.grantId !== original.grantId || !same(fresh.record.caller?.scope, original.scope))
          throw new WorkflowRuntimeError('not-found')
        const retry = callerControlRetry(fresh.record, request)
        if (retry) return retry
        if (request.mode === 'pause') return callerControlReceipt(await this.admitCallerControl(token, id, request, original), request.requestId)
        return this.withRun(id, async controller => {
          const cursor = await this.cursor(id), record = cursor.record
          assertCallerControlCheckpoint(record, request)
          const graph = compileLocalRun(record.yaml, limits, record.triggerMode)
          validateBreakpoints(graph, request)
          const next = request.mode === 'recover' ? await prepareModelRecovery(record, graph, limits, this.models) : undefined
          if (request.mode !== 'recover') await this.admit(cursor, graph)
          const admitted = await this.admitCallerControl(token, id, request, original)
          await cursor.load()
          if (cursor.record.cancellation) return callerControlReceipt(await cursor.finishCancellation(), request.requestId)
          if (next) {
            if (admitted.state.status !== 'executing') throw new WorkflowRuntimeError('conflict')
            const prior = admitted.state, segment = this.telemetry?.segment(cursor.record, 'resume')
            segment?.setAttribute('jevable.control.request_id', request.requestId); segment?.setAttribute('jevable.control.mode', 'recover')
            let settled = false
            try {
              await cursor.saveSegment(cursor.record, segment, 'resume'); await cursor.load()
              if (cursor.record.cancellation) return callerControlReceipt(await cursor.finishCancellation(), request.requestId)
              await cursor.save({ ...cursor.record, state: next, updatedAt: new Date().toISOString() }, 'node-result', {
                attemptId: prior.attempt.id, nodeId: prior.next, scope: prior.scope ?? null, status: next.status,
                routes: recordedRoutes(next.steps, prior.steps.length) })
              settled = true; return callerControlReceipt(cursor.record, request.requestId)
            } finally {
              segment?.setAttribute('jevable.recovery.settled', settled)
              this.telemetry?.end(segment, settled ? next.status : 'failed-or-uncertain', !settled || next.status === 'failed')
            }
          }
          return callerControlReceipt(await this.execute(cursor, graph, controller, 'resume', request.mode === 'step' ? 1 : Infinity, request), request.requestId)
        })
      }
      return context ? context(structuredClone(original.scope.release), execute) : execute()
    })
  }

  runProject(value: string, expectedGeneration: number, reviewedRevision: string, input: unknown, options: RunStartOptions = {}) {
    return this.operation(() => this.startProject(value, expectedGeneration, reviewedRevision, input, options))
  }
  runProjectAsync(value: string, expectedGeneration: number, reviewedRevision: string, input: unknown, options: AsyncRunOptions) {
    return admitAsyncRun(created => this.operation(() => this.startProject(value, expectedGeneration, reviewedRevision, input, parseAsyncRunOptions(options), created)))
  }
  private async startProject(value: string, expectedGeneration: number, reviewedRevision: string, input: unknown,
    options: RunStartOptions, created?: (run: LocalRun) => void) {
      const projectId = identity(value), { id, paused, triggerMode } = this.options(options)
      if (!z.number().int().positive().safeParse(expectedGeneration).success || !z.string().regex(/^[a-f0-9]{64}$/u).safeParse(reviewedRevision).success) throw invalid()
      const admitted = admitWorkflowData(input, limits.binding.data), pins = { project: { id: projectId, generation: expectedGeneration }, ...triggerMetadata({ triggerMode }) }
      return this.withRun(id, async controller => {
        const prior = await this.retry(id, reviewedRevision, admitted, paused, pins)
        if (prior) return prior
        const project = await this.projectStore.get(projectId)
        if (project.archived) throw new WorkflowRuntimeError('archived')
        if (project.generation !== expectedGeneration || project.acceptedRevision !== reviewedRevision) throw new WorkflowRuntimeError('conflict')
        return this.start(project.revisions.find(item => item.revision === reviewedRevision)!.yaml, admitted, id, paused, pins, controller, created)
      })
  }
  runRelease(value: unknown, input: unknown, options: RunStartOptions = {}) {
    return this.operation(() => this.startRelease(value, input, options))
  }
  runReleaseAsync(value: unknown, input: unknown, options: AsyncRunOptions) {
    return admitAsyncRun(created => this.operation(() => this.startRelease(value, input, parseAsyncRunOptions(options), created)))
  }
  private async startRelease(value: unknown, input: unknown, options: RunStartOptions, created?: (run: LocalRun) => void) {
      const release = inspectRelease(value), { id, paused, triggerMode } = this.options(options), admitted = admitWorkflowData(input, limits.binding.data)
      compileLocalRun(release.snapshot.workflow.yaml, limits, triggerMode)
      const pins = { release: { id: release.snapshot.id, sha256: release.sha256 }, ...triggerMetadata({ triggerMode }) }
      return this.withRun(id, async controller => {
        const prior = await this.retry(id, release.snapshot.workflow.revision, admitted, paused, pins)
        if (prior) return prior
        await this.releaseStore.put(release.snapshot, true)
        return this.start(release.snapshot.workflow.yaml, admitted, id, paused, pins, controller, created)
      })
  }
  runTest(value: TestIdentity, runId: string) {
    return this.operation(async () => {
      const pin = parseTest(testIdentitySchema, value), id = identity(runId)
      const run = await this.withRun(id, async controller => {
        const prior = await this.existing(id)
        if (prior) { if (!same(prior.record.test, pin)) throw new WorkflowRuntimeError('conflict'); return prior.record }
        const test = await this.testStore.get(pin.id)
        if (test.archived) throw new WorkflowRuntimeError('archived')
        if (test.status !== 'accepted' || test.generation !== pin.generation || test.sha256 !== pin.sha256) throw new WorkflowRuntimeError('conflict')
        const projectPin = test.definition.project, project = await this.projectStore.get(projectPin.id)
        if (project.archived) throw new WorkflowRuntimeError('archived')
        if (project.generation !== projectPin.generation || project.acceptedRevision !== projectPin.revision) throw new WorkflowRuntimeError('conflict')
        return this.start(project.revisions.find(item => item.revision === projectPin.revision)!.yaml, test.definition.input, id, false,
          { project: { id: project.id, generation: project.generation }, test: pin, ...triggerMetadata(test.definition) }, controller)
      })
      return this.assess(run)
    })
  }
  resume(value: string) {
    return this.operation(async () => {
      const id = identity(value)
      return this.withRun(id, async controller => {
        const cursor = await this.cursor(id), graph = compileLocalRun(cursor.record.yaml, limits, cursor.record.triggerMode)
        if (cursor.record.cancellation) return cursor.finishCancellation()
        if (cursor.record.state.status !== 'paused') throw new WorkflowRuntimeError('conflict')
        await this.admit(cursor, graph); await cursor.load()
        if (cursor.record.cancellation) return cursor.finishCancellation()
        return this.execute(cursor, graph, controller, 'resume')
      })
    })
  }
  advance(value: string, command: ExecutionControl, actor: string) {
    return this.operation(async () => {
      const id = identity(value), publicCommand = executionControlSchema.safeParse(command)
      if (!publicCommand.success) throw invalid()
      const parsed = savedExecutionControlSchema.safeParse({ ...publicCommand.data, actor, at: new Date().toISOString() })
      if (!parsed.success) throw invalid()
      if (parsed.data.mode === 'pause') {
        const cursor = await this.cursor(id)
        const request = { ...parsed.data, at: new Date().toISOString() }, result = admitPause(cursor.record, request)
        if (result.admitted) await cursor.save(result.record, 'execution-requested', request)
        return cursor.record
      }
      return this.withRun(id, async controller => {
        const cursor = await this.cursor(id), record = cursor.record
        const saved = record.controlRequests?.find(item => item.requestId === parsed.data.requestId)
        if (saved) { if (!same({ ...saved, at: parsed.data.at }, parsed.data)) throw new WorkflowRuntimeError('conflict'); return record }
        // A new recovery cannot target an already cancelled attempt. Identical admitted
        // request retries above still read its current state, including cancellation.
        if (parsed.data.mode === 'recover' && record.state.status === 'cancelled') throw new WorkflowRuntimeError('conflict')
        if (record.cancellation) return cursor.finishCancellation()
        if (parsed.data.mode === 'recover') {
          const graph = compileLocalRun(record.yaml, limits, record.triggerMode)
          validateBreakpoints(graph, parsed.data)
          if (executionCheckpointHash(record) !== parsed.data.expectedCheckpointSha256) throw new WorkflowRuntimeError('conflict')
          if ((record.controlRequests?.length ?? 0) >= 10000) throw new WorkflowRuntimeError('limit')
          const next = await prepareModelRecovery(record, graph, limits, this.models)
          await cursor.load()
          if (cursor.record.cancellation) return cursor.finishCancellation()
          if (executionCheckpointHash(cursor.record) !== parsed.data.expectedCheckpointSha256 || cursor.record.state.status !== 'executing') throw new WorkflowRuntimeError('conflict')
          const request = { ...parsed.data, at: new Date().toISOString() }, prior = cursor.record.state
          await cursor.save({ ...cursor.record, updatedAt: request.at, controlRequests: [...cursor.record.controlRequests ?? [], request] }, 'execution-requested', request)
          const segment = this.telemetry?.segment(cursor.record, 'resume')
          segment?.setAttribute('jevable.control.request_id', request.requestId); segment?.setAttribute('jevable.control.mode', 'recover')
          let settled = false
          try {
            await cursor.saveSegment(cursor.record, segment, 'resume')
            await cursor.load()
            if (cursor.record.cancellation) return cursor.finishCancellation()
            await cursor.save({ ...cursor.record, state: next, updatedAt: new Date().toISOString() }, 'node-result', {
              attemptId: prior.attempt.id, nodeId: prior.next, scope: prior.scope ?? null, status: next.status, routes: recordedRoutes(next.steps, prior.steps.length) })
            settled = true; return cursor.record
          } finally {
            segment?.setAttribute('jevable.recovery.settled', settled)
            this.telemetry?.end(segment, settled ? next.status : 'failed-or-uncertain', !settled || next.status === 'failed')
          }
        }
        if (record.state.status !== 'paused' || executionCheckpointHash(record) !== parsed.data.expectedCheckpointSha256) throw new WorkflowRuntimeError('conflict')
        if ((record.controlRequests?.length ?? 0) >= 10000) throw new WorkflowRuntimeError('limit')
        const graph = compileLocalRun(record.yaml, limits, record.triggerMode)
        validateBreakpoints(graph, parsed.data)
        await this.admit(cursor, graph); await cursor.load()
        if (cursor.record.cancellation) return cursor.finishCancellation()
        const request = { ...parsed.data, at: new Date().toISOString() }
        await cursor.save({ ...cursor.record, controlRequests: [...cursor.record.controlRequests ?? [], request], updatedAt: request.at }, 'execution-requested', request)
        return this.execute(cursor, graph, controller, 'resume', request.mode === 'step' ? 1 : Infinity, request)
      })
    })
  }
  /** Authenticate before reading a private run and again after the awaited read.
   * This is a trusted release-host port, not an owner-visible operation.
   */
  reviewerReleaseWithGrant(token: string, release: ReleaseReviewerPin) {
    return this.operation(async () => {
      const principal = await this.grantStore.lookup(token)
      if (!principal || principal.scope.kind !== 'reviewer') throw new WorkflowRuntimeError('not-found')
      const run = await this.show(principal.scope.runId)
      const final = await this.grantStore.lookup(token)
      if (!final || final.grantId !== principal.grantId || !same(final.scope, principal.scope)) throw new WorkflowRuntimeError('not-found')
      assertReviewerRelease(final, run, release)
      return { principal: final, run }
    })
  }

  /** Experimental direct SDK reviewer surface; all mutable admission is pinned to the actual grant/run writer commit. */
  decideWithGrant(token: string, value: ReviewerDecisionRequest,
    context?: import('../access/reviewer.ts').ReviewerDecisionContext): Promise<ReviewerDecisionReceipt> {
    return this.operation(async () => {
      const parsed = reviewerDecisionRequestSchema.safeParse(value)
      if (!parsed.success || context !== undefined && typeof context !== 'function') throw invalid()
      const request = parsed.data, authenticated = await this.runs.reviewer(token, request.action), principal = authenticated.principal
      if (principal.scope.kind !== 'reviewer') throw new WorkflowRuntimeError('not-found')
      const scope = principal.scope
      const execute = async () => {
        // A trusted observation hook may await. Reauthenticate even receipt-only reads after it.
        const selected = context ? await this.runs.reviewer(token, request.action) : authenticated
        if (selected.principal.grantId !== principal.grantId || !same(selected.principal.scope, scope)) throw new WorkflowRuntimeError('not-found')
        const prior = reviewerRetry(selected.record, selected.events, selected.principal, request)
        if (prior) return prior
        return this.withRun(scope.runId, async controller => {
          await admitExecution(selected.graph, this.models)
          let segment: Span | undefined
          let decisionCommitted = false
          try {
            let retained: Awaited<ReturnType<PostgresRunReader['read']>> | undefined
            const planned = await this.grantStore.planAction(token, { kind: 'decision', runId: scope.runId, attemptId: scope.attemptId, decision: request.action }, async () => {
              retained = await this.reader.read(scope.runId)
              const row = await this.journal.get('runs', scope.runId)
              if (!row || row.deleted || row.version !== retained.version || !same(row.value, { format: 'jevable.pg-run/v1', record: retained.record })) throw new WorkflowRuntimeError('corrupt')
              return { target: reviewerTarget(retained.record, retained.events),
                condition: { collection: 'runs', key: scope.runId, version: row.version, sha256: journalConditionHash(row.value) } }
            })
            if (!retained) throw new WorkflowRuntimeError('corrupt')
            segment = this.telemetry?.segment(retained.record, 'approval')
            const trace = savedRunTrace(segment), parent = this.telemetry?.parent()
            const settlement = prepareReviewerSettlement(retained.record, retained.events, retained.graph, request, planned.admission, limits,
              trace ? { trace, ...(parent ? { parent } : {}) } : undefined)
            const expectedVersion = retained.version
            await this.journalScope(segment, () => this.runs.save(JSON.parse(JSON.stringify({ requestId: request.requestId, expectedVersion, record: settlement.record,
              kind: 'approval-decided', data: settlement.data })), planned.conditions))
            decisionCommitted = true
            const cursor = await this.journalScope(segment, () => this.cursor(scope.runId))
            if (cursor.record.state.status === 'paused' && !request.pauseAfter) {
              const result = await this.execute(cursor, retained.graph, controller, 'approval', Infinity, undefined, segment)
              return reviewerReceipt(result, settlement.decision)
            }
            this.telemetry?.end(segment, cursor.record.state.status, cursor.record.state.status === 'failed')
            return reviewerReceipt(cursor.record, settlement.decision)
          } catch (error) {
            this.telemetry?.end(segment, 'failed-or-uncertain', true)
            // A cancellation can win after the retained reviewer target was
            // read but before its guarded decision commits. The reviewer must
            // still receive only a refusal, while the owner finishes the
            // already-admitted cancellation without replaying the decision.
            if (!decisionCommitted && error instanceof WorkflowRuntimeError && error.code === 'conflict') {
              let cursor: RunCursor
              try { cursor = await this.cursor(scope.runId) }
              catch (readError) {
                // A competing invalid/corrupt row must not replace the
                // original guarded-write refusal with private read detail.
                if (readError instanceof WorkflowRuntimeError && ['corrupt', 'not-found'].includes(readError.code)) throw error
                throw readError
              }
              if (cursor.record.cancellation) await cursor.finishCancellation()
            }
            throw error
          }
        })
      }
      return context ? context(execute) : execute()
    })
  }

  decide(value: string, attemptId: string, action: string, actor: string, options: { pauseAfter?: boolean; expireOnly?: boolean } = {}) {
    return this.operation(async () => {
      const id = identity(value), parsed = z.strictObject({ pauseAfter: z.boolean().optional(), expireOnly: z.boolean().optional() }).safeParse(options)
      if (!parsed.success || !z.uuid().safeParse(attemptId).success || !z.string().trim().min(1).max(256).safeParse(actor).success) throw invalid()
      return this.withRun(id, async controller => {
        const cursor = await this.cursor(id), graph = compileLocalRun(cursor.record.yaml, limits, cursor.record.triggerMode)
        if (cursor.record.cancellation) return cursor.finishCancellation()
        await this.admit(cursor, graph); await cursor.load()
        if (cursor.record.cancellation) return cursor.finishCancellation()
        const record = cursor.record, state = record.state
        if (state.status !== 'waiting' || state.attempt.id !== attemptId) throw new WorkflowRuntimeError('conflict')
        const node = findNode(graph, state.next, state.scope)
        if (node?.plan.kind !== 'humanApproval' || !node.plan.actions.includes(action)) throw invalid()
        // Guard before the first retained write; a stale expiry observation
        // must not authorize a timely business decision or new trace segment.
        if (parsed.data.expireOnly && Date.now() < Date.parse(state.expiresAt)) throw new WorkflowRuntimeError('conflict')
        const segment = this.telemetry?.segment(record, 'approval')
        try {
          await cursor.saveSegment(record, segment, 'approval')
          const at = new Date().toISOString()
          if (parsed.data.expireOnly && Date.parse(at) < Date.parse(state.expiresAt)) throw new WorkflowRuntimeError('conflict')
          const decision: JevableApprovalDecision = Date.parse(at) >= Date.parse(state.expiresAt) ? { kind: 'expired', at } : { kind: 'action', action, actor, at }
          if (state.scope && Date.parse(at) >= (record.loopDeadlines[state.scope.loop] ?? 0)) {
            await cursor.save({ ...cursor.record, updatedAt: at, state: { status: 'failed', code: 'loop-timeout', nodeId: state.next, scope: state.scope, steps: state.steps } },
              'loop-timeout', { scope: state.scope, attemptId, nodeId: state.next })
            this.telemetry?.end(segment, 'failed', true)
            return cursor.record
          }
          const next = advanceCheckpoint(graph, record.input, { status: 'paused', steps: state.steps, next: state.next, ...(state.scope ? { scope: state.scope } : {}) }, limits.binding.data, undefined, state.attempt, undefined, decision)
          await cursor.save({ ...cursor.record, state: next, updatedAt: at }, 'approval-decided', { attemptId, nodeId: state.next, decision,
            ...(state.scope ? { scope: state.scope } : {}), routes: recordedRoutes(next.steps, state.steps.length), ...(parsed.data.pauseAfter ? { pauseAfter: true } : {}) })
        } catch (error) {
          this.telemetry?.end(segment, 'failed-or-uncertain', true)
          // Cancellation may commit after the last cursor read but before this
          // approval's optimistic write. No downstream node has executed yet.
          // Finish the retained cancellation instead of leaving a waiting run
          // with only cancellation-requested in its journal.
          if (error instanceof WorkflowRuntimeError && error.code === 'conflict') {
            await cursor.load()
            if (cursor.record.cancellation) return cursor.finishCancellation()
          }
          throw error
        }
        if (cursor.record.state.status !== 'paused' || parsed.data.pauseAfter) {
          this.telemetry?.end(segment, cursor.record.state.status, cursor.record.state.status === 'failed'); return cursor.record
        }
        return this.execute(cursor, graph, controller, 'approval', Infinity, undefined, segment)
      })
    })
  }
  cancel(value: string, requestId: string, actor: string) {
    return this.operation(async () => {
      const id = identity(value), parsed = cancellationRequest.safeParse({ id: requestId, actor, at: new Date().toISOString() })
      if (!parsed.success) throw invalid()
      const cursor = await this.cursor(id), record = cursor.record
      if (record.cancellation) { if (record.cancellation.id !== requestId) throw new WorkflowRuntimeError('conflict') }
      else {
        if (['completed', 'failed', 'cancelled'].includes(record.state.status)) throw new WorkflowRuntimeError('conflict')
        const parent = this.telemetry?.parent()
        const cancellation = { ...parsed.data, at: new Date().toISOString(), ...(parent ? { traceParent: parent } : {}) }
        await cursor.save({ ...record, cancellation, updatedAt: cancellation.at }, 'cancellation-requested', cancellation)
      }
      this.active.get(id)?.abort()
      return this.active.has(id) ? cursor.record : cursor.finishCancellation()
    })
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing
    if (this.operations || this.active.size || this.configuring) throw new WorkflowRuntimeError('busy')
    this.lifecycle = 'closing'
    this.closing = (async () => {
      try { await this.automaticNotifications?.drain() }
      finally {
        try { await this.telemetry?.close() }
        finally {
          await Promise.allSettled([...this.flushes])
          try { await this.journal.close() } finally { this.lifecycle = 'closed' }
        }
      }
    })()
    return this.closing
  }
}

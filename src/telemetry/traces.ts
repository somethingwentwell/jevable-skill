import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { ROOT_CONTEXT, trace, SpanStatusCode, type Span, type SpanContext, type Attributes, type TimeInput } from '@opentelemetry/api'
import { TracerProvider, TraceIdRatioBasedSampler, type ReadableSpan, type SpanProcessor } from '@opentelemetry/sdk-trace'
import { resourceFromAttributes, type Resource } from '@opentelemetry/resources'
import { ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer'
import { CORE_VERSION } from '../capabilities.ts'
import { parseTelemetryConfig, parseTraceParent, type TelemetryConfig, type TelemetryPolicy } from './config.ts'
import { runTrace, type LocalRun } from '../runtime/run-types.ts'
import { RuntimeMetrics } from './metrics.ts'
import { RuntimeLogs } from './logs.ts'
import { BoundedOtlpQueue } from './queue.ts'
import type { OtlpCredential } from './otlp.ts'
import type { RetainedMetricSource } from './retained-metrics.ts'
import type { StorageQueueMetricSource } from './storage-queue-metrics.ts'
import type { StorageTransactionMetricSource } from './storage-transaction-metrics.ts'
import type { SQLiteStatementMetricSource } from './sqlite-statement-metrics.ts'
import type { RuntimeWorkMetricSource } from './runtime-work-metrics.ts'
import { observeHttpRequest } from './http.ts'
import { observeHttpAccess } from './http-access.ts'
import { observeHttpRateSql } from './rate-sql.ts'
import { HTTP_RATE_SQL_OPERATIONS, type HttpRateSqlOperation } from '../http/rate-sql-observation.ts'
import { HTTP_ACCESS_STAGES, type HttpAccessStage } from '../http/access-observation.ts'
import { observeAsyncSlot } from './async-slots.ts'
import { observeGrantOperation, GRANT_OPERATIONS, type GrantOperation } from './grants.ts'
import { observeGrantPolicyDecision } from './grant-policy.ts'
import { GRANT_POLICY_ACTIONS, type GrantPolicyAction } from '../access/policy-observation.ts'
import { observeHttpConnection, observeHttpTransportFailure, HTTP_TRANSPORTS, HTTP_TRANSPORT_FAILURES, type HttpTransport, type HttpTransportFailure } from './connections.ts'
import { observeNotification } from './notifications.ts'
import { observeJournalTransaction } from './journal.ts'
import { TRANSACTION_KINDS, type TransactionKind } from '../storage/transaction-statistics.ts'
import type { NotificationRecord } from '../notifications/schema.ts'
import { probeCollector, type CollectorProbeReport } from './probe.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { cancellationTraceCause } from '../runtime/run-trace.ts'
import { parseTraceRequestContext, selectBaggage, type TraceRequestContext } from './baggage.ts'
import { ObservedExecutionSpan } from './span.ts'
import { observeTestSuite } from './suite.ts'
import type { SuiteObservationIdentity } from '../testing/suite-observation.ts'

interface JournalScope { span: Span; parent: SpanContext; previous: JournalScope | undefined }

/** Invalidate scope before forwarding end, including direct node end and diagnostic end faults. */
class JournalScopedSpan extends ObservedExecutionSpan {
  constructor(inner: Span, private readonly release: (span: Span) => void) { super(inner, () => {}) }
  override end(time?: TimeInput) { this.release(this); super.end(time) }
}

/** Bounded, non-retrying trace transport; no environment-derived destination, credentials, diagnostics or payload logs. */
class TraceQueue extends BoundedOtlpQueue<ReadableSpan> implements SpanProcessor {
  constructor(policy: TelemetryPolicy, credential: OtlpCredential, canExport: () => boolean) {
    super(policy, policy.endpoint!, credential, spans => ProtobufTraceSerializer.serializeRequest(spans),
      response => ProtobufTraceSerializer.deserializeResponse(response).partialSuccess?.rejectedSpans ?? 0, canExport)
  }
  onStart() {}
  onEnd(span: ReadableSpan) { this.enqueue(span) }
}

export class RuntimeTelemetry {
  private readonly provider: TracerProvider
  private readonly processor: TraceQueue | undefined
  private readonly metrics: RuntimeMetrics | undefined
  private readonly logs: RuntimeLogs | undefined
  private readonly httpRequests: boolean
  private readonly httpConnections: boolean
  private readonly journalTransactions: boolean
  private readonly protocol: TelemetryPolicy['protocol']
  private closing: Promise<unknown> | undefined
  private readonly policy: TelemetryPolicy
  private readonly resource: Resource
  private readonly serviceInstanceId: string
  private readonly canExport: () => boolean
  private probing: Promise<CollectorProbeReport> | undefined
  private probeController: AbortController | undefined
  private readonly parents = new AsyncLocalStorage<SpanContext | undefined>()
  private readonly journalParents = new AsyncLocalStorage<JournalScope>()
  private readonly journalSpans = new WeakSet<Span>()
  private readonly baggageContext = new AsyncLocalStorage<string | undefined>()
  constructor(config: TelemetryConfig, private readonly credential: OtlpCredential,
    options: { storage?: 'sqlite' | 'postgres'; component?: 'suite-client'; canExport?: () => boolean; retainedState?: RetainedMetricSource; storageQueues?: StorageQueueMetricSource; storageTransactions?: StorageTransactionMetricSource; sqliteStatements?: SQLiteStatementMetricSource; runtimeWork?: RuntimeWorkMetricSource } = {}) {
    const policy = parseTelemetryConfig(config)
    this.policy = policy
    this.protocol = policy.protocol
    this.httpRequests = policy.httpRequests
    this.httpConnections = policy.httpConnections
    this.journalTransactions = policy.journalTransactions && options.storage === 'postgres'
    const canExport = options.canExport ?? (() => true)
    this.canExport = canExport
    this.processor = policy.endpoint ? new TraceQueue(policy, credential, canExport) : undefined
    this.serviceInstanceId = randomUUID()
    const resource = resourceFromAttributes({ 'service.name': policy.serviceName, 'service.version': CORE_VERSION,
      'service.instance.id': this.serviceInstanceId, 'deployment.environment.name': policy.environment,
      ...(policy.resource?.serviceNamespace ? { 'service.namespace': policy.resource.serviceNamespace } : {}),
      ...Object.fromEntries(Object.entries({ namespace: 'k8s.namespace.name', podName: 'k8s.pod.name', podUid: 'k8s.pod.uid',
        containerName: 'k8s.container.name', nodeName: 'k8s.node.name', clusterName: 'k8s.cluster.name' }).flatMap(([key, attribute]) => {
          const value = policy.resource?.kubernetes?.[key as keyof NonNullable<NonNullable<TelemetryPolicy['resource']>['kubernetes']>]
          return value === undefined ? [] : [[attribute, value]]
        })),
      ...(options.storage ? { 'jevable.storage.kind': options.storage } : {}),
      ...(options.component ? { 'jevable.component': options.component } : {}) })
    this.resource = resource
    this.logs = policy.logsEndpoint ? new RuntimeLogs(policy, credential, resource, canExport) : undefined
    this.metrics = policy.metricsEndpoint ? new RuntimeMetrics(policy, credential, resource, canExport, () => ({
      ...(this.processor ? { traces: this.processor.status() } : {}), ...(this.logs ? { logs: this.logs.status() } : {}),
    }), options.retainedState, options.storageQueues, options.storageTransactions, options.sqliteStatements, options.runtimeWork) : undefined
    this.provider = new TracerProvider({ sampler: new TraceIdRatioBasedSampler(policy.endpoint ? policy.sampleRatio : 0), resource,
      spanLimits: { attributeCountLimit: 48, attributeValueLengthLimit: 512, eventCountLimit: 0, linkCountLimit: 4,
        attributePerEventCountLimit: 0, attributePerLinkCountLimit: 0 }, spanProcessors: this.processor ? [this.processor] : [] })
  }
  withParent<T>(value: string | undefined, operation: () => T): T {
    const parent = parseTraceParent(value)
    return this.baggageContext.run(undefined, () => this.parents.run(parent, operation))
  }
  withTraceContext<T>(value: TraceRequestContext, operation: () => T): T {
    const context = parseTraceRequestContext(value)
    return this.withParent(context.traceparent, () => this.withBaggage(context.baggage, operation))
  }
  withBaggage<T>(header: string | undefined, operation: () => T): T {
    const baggage = selectBaggage(header, this.policy.baggageKeys ?? [])
    return this.baggageContext.run(baggage, operation)
  }
  /** Request-local wire carrier only. It must never be added to stored evidence or signals. */
  baggage() { return this.baggageContext.getStore() }
  /** Ephemeral journal ancestry only. Never changes request parent/baggage or retained segment metadata. */
  withJournalSpan<T>(span: Span | undefined, work: () => T): T {
    if (!this.journalTransactions || this.closing || !span || !this.journalSpans.has(span)) return work()
    let parent: SpanContext
    try {
      const value = span.spanContext()
      parent = { traceId: value.traceId, spanId: value.spanId, traceFlags: value.traceFlags & 1 }
    } catch { return work() } // Inspect diagnostics before work; never catch/retry the work itself.
    return this.journalParents.run({ span, parent, previous: this.journalParents.getStore() }, work)
  }
  private journalParent(): SpanContext | undefined {
    for (let scope = this.journalParents.getStore(); scope; scope = scope.previous) {
      if (this.journalSpans.has(scope.span)) return scope.parent
    }
    return undefined
  }
  /** Cursor-level segment context is a fallback, never an override of a narrower node/model scope. */
  withJournalFallback<T>(span: Span | undefined, work: () => T): T {
    return this.journalParent() ? work() : this.withJournalSpan(span, work)
  }
  notification(record: NotificationRecord, run: LocalRun, previous?: NotificationRecord) {
    if (this.closing) return undefined
    try {
      return observeNotification(this.provider.getTracer('jevable.notifications', CORE_VERSION), record, run, previous, this.parents.getStore(),
        (attributes, seconds, context, failed) => {
          this.metrics?.notification(attributes, seconds)
          this.logs?.notification(attributes, seconds, context, failed)
        })
    } catch { return undefined } // Diagnostics never authorize retry or replace a workflow/delivery result.
  }
  observeHttpRequest(method: string | undefined, path: string | undefined) {
    if (!this.httpRequests || this.closing) return undefined
    return observeHttpRequest(this.provider.getTracer('jevable.http', CORE_VERSION), this.parents, method, path,
      (attributes, seconds, context, failed) => {
        this.metrics?.httpRequest(attributes, seconds)
        this.logs?.httpRequest(attributes, seconds, context, failed)
      }, this.policy.httpResponseContext)
  }
  observeGrantOperation(operation: GrantOperation) {
    if (!this.policy.grantOperations || this.closing || !GRANT_OPERATIONS.has(operation)) return undefined
    try {
      return observeGrantOperation(this.provider.getTracer('jevable.access', CORE_VERSION), operation, this.parents.getStore(),
        (attributes, seconds, context, failed) => {
          try { this.metrics?.grantOperation(attributes, seconds) }
          finally { this.logs?.grantOperation(attributes, seconds, context, failed) }
        })
    } catch { return undefined }
  }
  observeHttpAccess(stage: HttpAccessStage) {
    if (!this.policy.httpAccessDecisions || this.closing || !HTTP_ACCESS_STAGES.includes(stage)) return undefined
    try {
      return observeHttpAccess(this.provider.getTracer('jevable.http', CORE_VERSION), stage,
        (attributes, seconds, context, failed) => {
          try { this.metrics?.httpAccess(attributes, seconds) }
          finally { this.logs?.httpAccess(attributes, seconds, context, failed) }
        })
    } catch { return undefined }
  }
  observeHttpRateSql(operation: HttpRateSqlOperation, parent: SpanContext | undefined) {
    if (!this.policy.httpAccessDecisions || this.closing || !HTTP_RATE_SQL_OPERATIONS.includes(operation)) return undefined
    try {
      return observeHttpRateSql(this.provider.getTracer('jevable.http', CORE_VERSION), operation, parent,
        (attributes, seconds, context, failed) => {
          try { this.metrics?.httpRateSql(attributes, seconds) }
          finally { this.logs?.httpRateSql(attributes, seconds, context, failed) }
        })
    } catch { return undefined }
  }
  observeJournalTransaction(kind: TransactionKind) {
    if (!this.journalTransactions || this.closing || !TRANSACTION_KINDS.includes(kind)) return undefined
    try {
      return observeJournalTransaction(this.provider.getTracer('jevable.storage', CORE_VERSION), kind, this.journalParent() ?? this.parents.getStore(),
        (attributes, seconds, context, failed) => this.logs?.journalTransaction(attributes, seconds, context, failed))
    } catch { return undefined }
  }
  observeGrantPolicy(action: GrantPolicyAction) {
    if (!this.policy.grantPolicyDecisions || this.closing || !GRANT_POLICY_ACTIONS.includes(action)) return undefined
    try {
      return observeGrantPolicyDecision(this.provider.getTracer('jevable.access', CORE_VERSION), action, this.parents.getStore(),
        (attributes, seconds, context, failed) => {
          try { this.metrics?.grantPolicy(attributes, seconds) }
          finally { this.logs?.grantPolicy(attributes, seconds, context, failed) }
        })
    } catch { return undefined }
  }
  observeHttpAsyncSlot() {
    if (!this.httpRequests || !this.metrics || this.closing) return undefined
    return observeAsyncSlot((phase, delta) => this.metrics!.asyncSlot(phase, delta))
  }
  observeTestSuite(identity: SuiteObservationIdentity, scope?: (context: SpanContext, work: () => Promise<unknown>) => unknown) {
    if (this.closing) return undefined
    try {
      return observeTestSuite(this.provider.getTracer('jevable.testing', CORE_VERSION), identity, this.parents.getStore(),
        (context, work) => this.parents.run(context, () => scope ? scope(context, work) : work()),
        (attributes, seconds, context, failed) => {
          try { this.metrics?.suite(attributes, seconds) } finally { this.logs?.suite(attributes, seconds, context, failed) }
        }, (policy, before, after) => this.metrics?.suiteCases(policy, before, after))
    } catch { return undefined }
  }
  observeHttpConnection(transport: HttpTransport) {
    if (!this.httpConnections || this.closing || !HTTP_TRANSPORTS.has(transport)) return undefined
    try {
      return observeHttpConnection(this.provider.getTracer('jevable.http', CORE_VERSION), transport,
        attributes => this.metrics?.httpConnectionOpened(attributes),
        (attributes, seconds, context, failed) => {
          try { this.metrics?.httpConnectionEnded(attributes, seconds) } finally { this.logs?.httpConnection(attributes, seconds, context, failed) }
        })
    } catch { return undefined }
  }
  observeHttpTransportFailure(transport: HttpTransport, failure: HttpTransportFailure) {
    if (!this.httpConnections || this.closing || !HTTP_TRANSPORTS.has(transport) || !HTTP_TRANSPORT_FAILURES.has(failure)) return
    try {
      observeHttpTransportFailure(this.provider.getTracer('jevable.http', CORE_VERSION), transport, failure,
        (attributes, _seconds, context) => {
          try { this.metrics?.httpTransportFailure(attributes) } finally { this.logs?.httpTransportFailure(attributes, context) }
        })
    } catch { /* Never change admission, execution or shutdown. */ }
  }
  parent() { const parent = this.parents.getStore(); return parent ? runTrace.parse({ traceId: parent.traceId, spanId: parent.spanId, traceFlags: parent.traceFlags & 1 }) : undefined }
  start(name: string, attributes: Attributes, parent?: SpanContext, previous?: SpanContext, cause?: SpanContext): Span {
    const context = parent ?? this.parents.getStore()
    const links = [previous, cause].filter((value): value is SpanContext => value !== undefined)
      .filter((value, index, all) => !all.slice(0, index).some(other => other.traceId === value.traceId && other.spanId === value.spanId))
    const span = this.provider.getTracer('jevable.workflow', CORE_VERSION).startSpan(name, { attributes,
      ...(links.length ? { links: links.map(context => ({ context })) } : {}) }, context ? trace.setSpanContext(ROOT_CONTEXT, context) : ROOT_CONTEXT)
    const observed = this.metrics?.observe(span, name, attributes) ?? span
    const result = this.logs?.observe(observed, name, attributes, previous) ?? observed
    if (!this.journalTransactions) return result
    const scoped = new JournalScopedSpan(result, span => this.journalSpans.delete(span))
    this.journalSpans.add(scoped)
    return scoped
  }
  segment(run: LocalRun, operation: 'run' | 'resume' | 'approval' | 'cancel'): Span {
    const cause = operation === 'cancel' ? cancellationTraceCause(run) : undefined
    return this.start(`jevable.${operation}`, { 'jevable.run.id': run.id, 'jevable.workflow.revision': run.revision,
      ...(cause ? { 'jevable.cancellation.request_id': cause.requestId,
        'jevable.cancellation.trace_id': cause.parent.traceId, 'jevable.cancellation.span_id': cause.parent.spanId } : {}),
      ...(run.triggerMode === 'api' ? { 'jevable.trigger.mode': 'api' } : {}),
      ...(operation === 'approval' && run.state.status === 'waiting' ? {
        ...(run.state.scope ? { 'jevable.loop.id': run.state.scope.loop, 'jevable.loop.index': run.state.scope.index } : {}),
        'jevable.node.id': run.state.next, 'jevable.attempt.id': run.state.attempt.id } : {}),
      'jevable.runtime.mode': 'local', ...(run.project ? { 'jevable.project.id': run.project.id, 'jevable.project.generation': run.project.generation } : {}),
      ...(run.release ? { 'jevable.release.id': run.release.id, 'jevable.release.sha256': run.release.sha256 } : {}),
      ...(run.test ? { 'jevable.test.id': run.test.id, 'jevable.test.generation': run.test.generation, 'jevable.test.sha256': run.test.sha256 } : {}) },
    undefined, run.traceSegments?.at(-1)?.trace, cause?.parent)
  }
  end(span: Span | undefined, status: string, failed = false) {
    span?.setAttribute('jevable.outcome', status); span?.setStatus({ code: failed ? SpanStatusCode.ERROR : SpanStatusCode.OK }); span?.end()
  }
  status() { return { ...(this.processor?.status() ?? { enabled: true, protocol: this.protocol }),
    resource: { serviceInstanceId: this.serviceInstanceId },
    httpRequests: this.httpRequests,
    ...(this.policy.httpResponseContext ? { httpResponseContext: true } : {}),
    httpConnections: this.httpConnections,
    ...(this.policy.grantOperations ? { grantOperations: true } : {}),
    ...(this.policy.grantPolicyDecisions ? { grantPolicyDecisions: true } : {}),
    ...(this.policy.runtimeWorkMetrics ? { runtimeWorkMetrics: true } : {}),
    ...(this.policy.storageQueueMetrics ? { storageQueueMetrics: true } : {}),
    ...(this.policy.storageTransactionMetrics ? { storageTransactionMetrics: true } : {}),
    ...(this.policy.journalTransactions ? { journalTransactions: this.journalTransactions } : {}),
    ...(this.policy.sqliteStatementMetrics ? { sqliteStatementMetrics: true } : {}),
    signals: [...(this.processor ? ['traces'] : []), ...(this.metrics ? ['metrics'] : []), ...(this.logs ? ['logs'] : [])],
    ...(this.metrics ? { metrics: this.metrics.status() } : {}), ...(this.logs ? { logs: this.logs.status() } : {}) } }
  async flush() { await Promise.all([this.processor?.forceFlush(), this.metrics?.flush(), this.logs?.flush()]); return this.status() }
  async probe(options: { signal?: AbortSignal } = {}): Promise<CollectorProbeReport> {
    if (this.closing) throw new WorkflowRuntimeError('closed')
    if (this.probing || !this.canExport()) throw new WorkflowRuntimeError('busy')
    const controller = new AbortController(), abort = () => controller.abort()
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener('abort', abort, { once: true })
    this.probeController = controller
    const work = probeCollector(this.policy, this.credential, this.resource, controller)
    this.probing = work
    try { return await work }
    finally { options.signal?.removeEventListener('abort', abort); this.probing = undefined; this.probeController = undefined }
  }
  busy() { return Boolean(this.probing || this.processor?.busy() || this.metrics?.busy() || this.logs?.busy()) }
  async close() {
    this.probeController?.abort()
    await (this.closing ??= Promise.all([this.provider.shutdown(), this.metrics?.close(), this.logs?.close(), this.probing]))
    return this.status()
  }
}

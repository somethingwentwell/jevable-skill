import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ROOT_CONTEXT, trace, SpanStatusCode } from '@opentelemetry/api';
import { TracerProvider, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer';
import { CORE_VERSION } from "../capabilities.js";
import { parseTelemetryConfig, parseTraceParent } from "./config.js";
import { runTrace } from "../runtime/run-types.js";
import { RuntimeMetrics } from "./metrics.js";
import { RuntimeLogs } from "./logs.js";
import { BoundedOtlpQueue } from "./queue.js";
import { observeHttpRequest } from "./http.js";
import { observeHttpAccess } from "./http-access.js";
import { observeHttpRateSql } from "./rate-sql.js";
import { HTTP_RATE_SQL_OPERATIONS } from "../http/rate-sql-observation.js";
import { HTTP_ACCESS_STAGES } from "../http/access-observation.js";
import { observeAsyncSlot } from "./async-slots.js";
import { observeGrantOperation, GRANT_OPERATIONS } from "./grants.js";
import { observeGrantPolicyDecision } from "./grant-policy.js";
import { GRANT_POLICY_ACTIONS } from "../access/policy-observation.js";
import { observeHttpConnection, observeHttpTransportFailure, HTTP_TRANSPORTS, HTTP_TRANSPORT_FAILURES } from "./connections.js";
import { observeNotification } from "./notifications.js";
import { observeJournalTransaction } from "./journal.js";
import { TRANSACTION_KINDS } from "../storage/transaction-statistics.js";
import { probeCollector } from "./probe.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { cancellationTraceCause } from "../runtime/run-trace.js";
import { parseTraceRequestContext, selectBaggage } from "./baggage.js";
import { ObservedExecutionSpan } from "./span.js";
import { observeTestSuite } from "./suite.js";
/** Invalidate scope before forwarding end, including direct node end and diagnostic end faults. */
class JournalScopedSpan extends ObservedExecutionSpan {
    release;
    constructor(inner, release) {
        super(inner, () => { });
        this.release = release;
    }
    end(time) { this.release(this); super.end(time); }
}
/** Bounded, non-retrying trace transport; no environment-derived destination, credentials, diagnostics or payload logs. */
class TraceQueue extends BoundedOtlpQueue {
    constructor(policy, credential, canExport) {
        super(policy, policy.endpoint, credential, spans => ProtobufTraceSerializer.serializeRequest(spans), response => ProtobufTraceSerializer.deserializeResponse(response).partialSuccess?.rejectedSpans ?? 0, canExport);
    }
    onStart() { }
    onEnd(span) { this.enqueue(span); }
}
export class RuntimeTelemetry {
    credential;
    provider;
    processor;
    metrics;
    logs;
    httpRequests;
    httpConnections;
    journalTransactions;
    protocol;
    closing;
    policy;
    resource;
    serviceInstanceId;
    canExport;
    probing;
    probeController;
    parents = new AsyncLocalStorage();
    journalParents = new AsyncLocalStorage();
    journalSpans = new WeakSet();
    baggageContext = new AsyncLocalStorage();
    constructor(config, credential, options = {}) {
        this.credential = credential;
        const policy = parseTelemetryConfig(config);
        this.policy = policy;
        this.protocol = policy.protocol;
        this.httpRequests = policy.httpRequests;
        this.httpConnections = policy.httpConnections;
        this.journalTransactions = policy.journalTransactions && options.storage === 'postgres';
        const canExport = options.canExport ?? (() => true);
        this.canExport = canExport;
        this.processor = policy.endpoint ? new TraceQueue(policy, credential, canExport) : undefined;
        this.serviceInstanceId = randomUUID();
        const resource = resourceFromAttributes({ 'service.name': policy.serviceName, 'service.version': CORE_VERSION,
            'service.instance.id': this.serviceInstanceId, 'deployment.environment.name': policy.environment,
            ...(policy.resource?.serviceNamespace ? { 'service.namespace': policy.resource.serviceNamespace } : {}),
            ...Object.fromEntries(Object.entries({ namespace: 'k8s.namespace.name', podName: 'k8s.pod.name', podUid: 'k8s.pod.uid',
                containerName: 'k8s.container.name', nodeName: 'k8s.node.name', clusterName: 'k8s.cluster.name' }).flatMap(([key, attribute]) => {
                const value = policy.resource?.kubernetes?.[key];
                return value === undefined ? [] : [[attribute, value]];
            })),
            ...(options.storage ? { 'jevable.storage.kind': options.storage } : {}),
            ...(options.component ? { 'jevable.component': options.component } : {}) });
        this.resource = resource;
        this.logs = policy.logsEndpoint ? new RuntimeLogs(policy, credential, resource, canExport) : undefined;
        this.metrics = policy.metricsEndpoint ? new RuntimeMetrics(policy, credential, resource, canExport, () => ({
            ...(this.processor ? { traces: this.processor.status() } : {}), ...(this.logs ? { logs: this.logs.status() } : {}),
        }), options.retainedState, options.storageQueues, options.storageTransactions, options.sqliteStatements, options.runtimeWork) : undefined;
        this.provider = new TracerProvider({ sampler: new TraceIdRatioBasedSampler(policy.endpoint ? policy.sampleRatio : 0), resource,
            spanLimits: { attributeCountLimit: 48, attributeValueLengthLimit: 512, eventCountLimit: 0, linkCountLimit: 4,
                attributePerEventCountLimit: 0, attributePerLinkCountLimit: 0 }, spanProcessors: this.processor ? [this.processor] : [] });
    }
    withParent(value, operation) {
        const parent = parseTraceParent(value);
        return this.baggageContext.run(undefined, () => this.parents.run(parent, operation));
    }
    withTraceContext(value, operation) {
        const context = parseTraceRequestContext(value);
        return this.withParent(context.traceparent, () => this.withBaggage(context.baggage, operation));
    }
    withBaggage(header, operation) {
        const baggage = selectBaggage(header, this.policy.baggageKeys ?? []);
        return this.baggageContext.run(baggage, operation);
    }
    /** Request-local wire carrier only. It must never be added to stored evidence or signals. */
    baggage() { return this.baggageContext.getStore(); }
    /** Ephemeral journal ancestry only. Never changes request parent/baggage or retained segment metadata. */
    withJournalSpan(span, work) {
        if (!this.journalTransactions || this.closing || !span || !this.journalSpans.has(span))
            return work();
        let parent;
        try {
            const value = span.spanContext();
            parent = { traceId: value.traceId, spanId: value.spanId, traceFlags: value.traceFlags & 1 };
        }
        catch {
            return work();
        } // Inspect diagnostics before work; never catch/retry the work itself.
        return this.journalParents.run({ span, parent, previous: this.journalParents.getStore() }, work);
    }
    journalParent() {
        for (let scope = this.journalParents.getStore(); scope; scope = scope.previous) {
            if (this.journalSpans.has(scope.span))
                return scope.parent;
        }
        return undefined;
    }
    /** Cursor-level segment context is a fallback, never an override of a narrower node/model scope. */
    withJournalFallback(span, work) {
        return this.journalParent() ? work() : this.withJournalSpan(span, work);
    }
    notification(record, run, previous) {
        if (this.closing)
            return undefined;
        try {
            return observeNotification(this.provider.getTracer('jevable.notifications', CORE_VERSION), record, run, previous, this.parents.getStore(), (attributes, seconds, context, failed) => {
                this.metrics?.notification(attributes, seconds);
                this.logs?.notification(attributes, seconds, context, failed);
            });
        }
        catch {
            return undefined;
        } // Diagnostics never authorize retry or replace a workflow/delivery result.
    }
    observeHttpRequest(method, path) {
        if (!this.httpRequests || this.closing)
            return undefined;
        return observeHttpRequest(this.provider.getTracer('jevable.http', CORE_VERSION), this.parents, method, path, (attributes, seconds, context, failed) => {
            this.metrics?.httpRequest(attributes, seconds);
            this.logs?.httpRequest(attributes, seconds, context, failed);
        }, this.policy.httpResponseContext);
    }
    observeGrantOperation(operation) {
        if (!this.policy.grantOperations || this.closing || !GRANT_OPERATIONS.has(operation))
            return undefined;
        try {
            return observeGrantOperation(this.provider.getTracer('jevable.access', CORE_VERSION), operation, this.parents.getStore(), (attributes, seconds, context, failed) => {
                try {
                    this.metrics?.grantOperation(attributes, seconds);
                }
                finally {
                    this.logs?.grantOperation(attributes, seconds, context, failed);
                }
            });
        }
        catch {
            return undefined;
        }
    }
    observeHttpAccess(stage) {
        if (!this.policy.httpAccessDecisions || this.closing || !HTTP_ACCESS_STAGES.includes(stage))
            return undefined;
        try {
            return observeHttpAccess(this.provider.getTracer('jevable.http', CORE_VERSION), stage, (attributes, seconds, context, failed) => {
                try {
                    this.metrics?.httpAccess(attributes, seconds);
                }
                finally {
                    this.logs?.httpAccess(attributes, seconds, context, failed);
                }
            });
        }
        catch {
            return undefined;
        }
    }
    observeHttpRateSql(operation, parent) {
        if (!this.policy.httpAccessDecisions || this.closing || !HTTP_RATE_SQL_OPERATIONS.includes(operation))
            return undefined;
        try {
            return observeHttpRateSql(this.provider.getTracer('jevable.http', CORE_VERSION), operation, parent, (attributes, seconds, context, failed) => {
                try {
                    this.metrics?.httpRateSql(attributes, seconds);
                }
                finally {
                    this.logs?.httpRateSql(attributes, seconds, context, failed);
                }
            });
        }
        catch {
            return undefined;
        }
    }
    observeJournalTransaction(kind) {
        if (!this.journalTransactions || this.closing || !TRANSACTION_KINDS.includes(kind))
            return undefined;
        try {
            return observeJournalTransaction(this.provider.getTracer('jevable.storage', CORE_VERSION), kind, this.journalParent() ?? this.parents.getStore(), (attributes, seconds, context, failed) => this.logs?.journalTransaction(attributes, seconds, context, failed));
        }
        catch {
            return undefined;
        }
    }
    observeGrantPolicy(action) {
        if (!this.policy.grantPolicyDecisions || this.closing || !GRANT_POLICY_ACTIONS.includes(action))
            return undefined;
        try {
            return observeGrantPolicyDecision(this.provider.getTracer('jevable.access', CORE_VERSION), action, this.parents.getStore(), (attributes, seconds, context, failed) => {
                try {
                    this.metrics?.grantPolicy(attributes, seconds);
                }
                finally {
                    this.logs?.grantPolicy(attributes, seconds, context, failed);
                }
            });
        }
        catch {
            return undefined;
        }
    }
    observeHttpAsyncSlot() {
        if (!this.httpRequests || !this.metrics || this.closing)
            return undefined;
        return observeAsyncSlot((phase, delta) => this.metrics.asyncSlot(phase, delta));
    }
    observeTestSuite(identity, scope) {
        if (this.closing)
            return undefined;
        try {
            return observeTestSuite(this.provider.getTracer('jevable.testing', CORE_VERSION), identity, this.parents.getStore(), (context, work) => this.parents.run(context, () => scope ? scope(context, work) : work()), (attributes, seconds, context, failed) => {
                try {
                    this.metrics?.suite(attributes, seconds);
                }
                finally {
                    this.logs?.suite(attributes, seconds, context, failed);
                }
            }, (policy, before, after) => this.metrics?.suiteCases(policy, before, after));
        }
        catch {
            return undefined;
        }
    }
    observeHttpConnection(transport) {
        if (!this.httpConnections || this.closing || !HTTP_TRANSPORTS.has(transport))
            return undefined;
        try {
            return observeHttpConnection(this.provider.getTracer('jevable.http', CORE_VERSION), transport, attributes => this.metrics?.httpConnectionOpened(attributes), (attributes, seconds, context, failed) => {
                try {
                    this.metrics?.httpConnectionEnded(attributes, seconds);
                }
                finally {
                    this.logs?.httpConnection(attributes, seconds, context, failed);
                }
            });
        }
        catch {
            return undefined;
        }
    }
    observeHttpTransportFailure(transport, failure) {
        if (!this.httpConnections || this.closing || !HTTP_TRANSPORTS.has(transport) || !HTTP_TRANSPORT_FAILURES.has(failure))
            return;
        try {
            observeHttpTransportFailure(this.provider.getTracer('jevable.http', CORE_VERSION), transport, failure, (attributes, _seconds, context) => {
                try {
                    this.metrics?.httpTransportFailure(attributes);
                }
                finally {
                    this.logs?.httpTransportFailure(attributes, context);
                }
            });
        }
        catch { /* Never change admission, execution or shutdown. */ }
    }
    parent() { const parent = this.parents.getStore(); return parent ? runTrace.parse({ traceId: parent.traceId, spanId: parent.spanId, traceFlags: parent.traceFlags & 1 }) : undefined; }
    start(name, attributes, parent, previous, cause) {
        const context = parent ?? this.parents.getStore();
        const links = [previous, cause].filter((value) => value !== undefined)
            .filter((value, index, all) => !all.slice(0, index).some(other => other.traceId === value.traceId && other.spanId === value.spanId));
        const span = this.provider.getTracer('jevable.workflow', CORE_VERSION).startSpan(name, { attributes,
            ...(links.length ? { links: links.map(context => ({ context })) } : {}) }, context ? trace.setSpanContext(ROOT_CONTEXT, context) : ROOT_CONTEXT);
        const observed = this.metrics?.observe(span, name, attributes) ?? span;
        const result = this.logs?.observe(observed, name, attributes, previous) ?? observed;
        if (!this.journalTransactions)
            return result;
        const scoped = new JournalScopedSpan(result, span => this.journalSpans.delete(span));
        this.journalSpans.add(scoped);
        return scoped;
    }
    segment(run, operation) {
        const cause = operation === 'cancel' ? cancellationTraceCause(run) : undefined;
        return this.start(`jevable.${operation}`, { 'jevable.run.id': run.id, 'jevable.workflow.revision': run.revision,
            ...(cause ? { 'jevable.cancellation.request_id': cause.requestId,
                'jevable.cancellation.trace_id': cause.parent.traceId, 'jevable.cancellation.span_id': cause.parent.spanId } : {}),
            ...(run.triggerMode === 'api' ? { 'jevable.trigger.mode': 'api' } : {}),
            ...(operation === 'approval' && run.state.status === 'waiting' ? {
                ...(run.state.scope ? { 'jevable.loop.id': run.state.scope.loop, 'jevable.loop.index': run.state.scope.index } : {}),
                'jevable.node.id': run.state.next, 'jevable.attempt.id': run.state.attempt.id
            } : {}),
            'jevable.runtime.mode': 'local', ...(run.project ? { 'jevable.project.id': run.project.id, 'jevable.project.generation': run.project.generation } : {}),
            ...(run.release ? { 'jevable.release.id': run.release.id, 'jevable.release.sha256': run.release.sha256 } : {}),
            ...(run.test ? { 'jevable.test.id': run.test.id, 'jevable.test.generation': run.test.generation, 'jevable.test.sha256': run.test.sha256 } : {}) }, undefined, run.traceSegments?.at(-1)?.trace, cause?.parent);
    }
    end(span, status, failed = false) {
        span?.setAttribute('jevable.outcome', status);
        span?.setStatus({ code: failed ? SpanStatusCode.ERROR : SpanStatusCode.OK });
        span?.end();
    }
    status() {
        return { ...(this.processor?.status() ?? { enabled: true, protocol: this.protocol }),
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
            ...(this.metrics ? { metrics: this.metrics.status() } : {}), ...(this.logs ? { logs: this.logs.status() } : {}) };
    }
    async flush() { await Promise.all([this.processor?.forceFlush(), this.metrics?.flush(), this.logs?.flush()]); return this.status(); }
    async probe(options = {}) {
        if (this.closing)
            throw new WorkflowRuntimeError('closed');
        if (this.probing || !this.canExport())
            throw new WorkflowRuntimeError('busy');
        const controller = new AbortController(), abort = () => controller.abort();
        if (options.signal?.aborted)
            abort();
        else
            options.signal?.addEventListener('abort', abort, { once: true });
        this.probeController = controller;
        const work = probeCollector(this.policy, this.credential, this.resource, controller);
        this.probing = work;
        try {
            return await work;
        }
        finally {
            options.signal?.removeEventListener('abort', abort);
            this.probing = undefined;
            this.probeController = undefined;
        }
    }
    busy() { return Boolean(this.probing || this.processor?.busy() || this.metrics?.busy() || this.logs?.busy()); }
    async close() {
        this.probeController?.abort();
        await (this.closing ??= Promise.all([this.provider.shutdown(), this.metrics?.close(), this.logs?.close(), this.probing]));
        return this.status();
    }
}

import { ROOT_CONTEXT } from '@opentelemetry/api';
import { AggregationTemporality, AggregationType, InstrumentType, MeterProvider, MetricReader, createAllowListAttributesProcessor } from '@opentelemetry/sdk-metrics';
import { ProtobufMetricsSerializer } from '@opentelemetry/otlp-transformer';
import { CORE_VERSION } from "../capabilities.js";
import { boundedFlush, ExportFailure, postOtlp } from "./otlp.js";
import { ObservedExecutionSpan } from "./span.js";
import { EXPORTER_HEALTH_LABELS, installExporterHealthMetrics } from "./exporter-health.js";
import { RETAINED_METRIC_LABELS, installRetainedMetrics, omitUnavailableRetainedMetrics } from "./retained-metrics.js";
import { HTTP_METRIC_LABELS } from "./http.js";
import { HTTP_ACCESS_METRIC_LABELS } from "./http-access.js";
import { HTTP_RATE_SQL_METRIC_LABELS } from "./rate-sql.js";
import { CONNECTION_METRIC_LABELS } from "./connections.js";
import { NOTIFICATION_METRIC_LABELS } from "./notifications.js";
import { STORAGE_QUEUE_LABELS, installStorageQueueMetrics, omitUnavailableStorageQueueMetrics } from "./storage-queue-metrics.js";
import { STORAGE_TRANSACTION_LABELS, installStorageTransactionMetrics, omitUnavailableStorageTransactionMetrics } from "./storage-transaction-metrics.js";
import { SQLITE_STATEMENT_LABELS, installSQLiteStatementMetrics, omitUnavailableSQLiteStatementMetrics } from "./sqlite-statement-metrics.js";
import { GRANT_METRIC_LABELS } from "./grants.js";
import { GRANT_POLICY_METRIC_LABELS } from "./grant-policy.js";
import { installRuntimeWorkMetrics, omitUnavailableRuntimeWorkMetrics } from "./runtime-work-metrics.js";
import { SUITE_METRIC_LABELS, SUITE_CASE_METRIC_LABELS } from "./suite.js";
const LABELS = ['jevable.operation', 'jevable.node.kind', 'jevable.outcome', 'jevable.token.direction', 'jevable.model.try.phase', 'jevable.model.try.dispatched', 'jevable.model.try.settled', 'jevable.recovery.settled', 'jevable.http.async.phase', ...HTTP_RATE_SQL_METRIC_LABELS, ...HTTP_ACCESS_METRIC_LABELS, ...HTTP_METRIC_LABELS, ...CONNECTION_METRIC_LABELS, ...NOTIFICATION_METRIC_LABELS, ...GRANT_METRIC_LABELS, ...GRANT_POLICY_METRIC_LABELS, ...SUITE_METRIC_LABELS, ...SUITE_CASE_METRIC_LABELS];
const OUTCOMES = new Set(['completed', 'paused', 'waiting', 'stopped', 'cancelled', 'failed', 'invalid-node-value',
    'commit-or-execution-failed', 'failed-or-uncertain', 'timeout']);
const KINDS = new Set(['trigger', 'output', 'ifElse', 'switch', 'decision', 'llm', 'humanApproval', 'loop', 'custom']);
/** Cumulative snapshots, one in flight, no queued snapshots or automatic retries. */
class RuntimeMetricReader extends MetricReader {
    policy;
    credential;
    canExport;
    enrichStorageTransactions = () => { };
    enrichSQLiteStatements = () => { };
    timer;
    exporting;
    controller;
    stopped = false;
    generation = 0;
    attemptedGeneration = 0;
    inFlight = 0;
    abandonedChanges = 0;
    counters = { accepted: 0, exported: 0, rejected: 0, dropped: 0, failedBatches: 0, successfulBatches: 0 };
    lastSuccessAt = null;
    lastFailure = null;
    collectionStatus;
    constructor(policy, credential, canExport) {
        super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE, cardinalitySelector: () => 128 });
        this.policy = policy;
        this.credential = credential;
        this.canExport = canExport;
    }
    changed() { if (!this.stopped)
        this.generation++; }
    setStorageTransactionEnrichment(enrich) { this.enrichStorageTransactions = enrich; }
    setSQLiteStatementEnrichment(enrich) { this.enrichSQLiteStatements = enrich; }
    busy() { return Boolean(this.exporting); }
    healthSnapshot() { return this.collectionStatus ?? this.status(); }
    status() {
        return { enabled: true, protocol: this.policy.protocol, unit: 'data-points', temporality: 'cumulative', ...this.counters,
            queued: 0, inFlight: this.inFlight, pendingChanges: this.generation !== this.attemptedGeneration, abandonedChanges: this.abandonedChanges,
            lastSuccessAt: this.lastSuccessAt, lastFailure: this.lastFailure, closed: this.stopped && !this.exporting };
    }
    onInitialized() { this.schedule(); }
    schedule() {
        if (this.stopped || this.timer)
            return;
        this.timer = setTimeout(() => { this.timer = undefined; void this.exportSnapshot().finally(() => this.schedule()); }, this.policy.intervalMs);
        this.timer.unref();
    }
    exportSnapshot() {
        if (this.exporting)
            return this.exporting;
        if (!this.canExport() || (!(this.policy.exporterMetrics || this.policy.retainedStateMetrics || this.policy.runtimeWorkMetrics || this.policy.storageQueueMetrics || this.policy.storageTransactionMetrics || this.policy.sqliteStatementMetrics) && this.generation === this.attemptedGeneration))
            return Promise.resolve();
        const generation = this.generation;
        this.exporting = (async () => {
            let points = 0;
            // Exporter self-observation describes the state before this snapshot's
            // attempt. Its own outcome can only appear in a later collection.
            this.collectionStatus = this.status();
            this.lastFailure = null;
            try {
                const result = await this.collect({ timeoutMillis: this.policy.timeoutMs });
                if (result.errors.length) {
                    this.lastFailure = 'collection';
                    throw new Error();
                }
                omitUnavailableRetainedMetrics(result.resourceMetrics);
                omitUnavailableRuntimeWorkMetrics(result.resourceMetrics);
                omitUnavailableStorageQueueMetrics(result.resourceMetrics);
                omitUnavailableStorageTransactionMetrics(result.resourceMetrics);
                this.enrichStorageTransactions(result.resourceMetrics);
                omitUnavailableSQLiteStatementMetrics(result.resourceMetrics);
                this.enrichSQLiteStatements(result.resourceMetrics);
                points = result.resourceMetrics.scopeMetrics.reduce((sum, scope) => sum + scope.metrics.reduce((n, metric) => n + metric.dataPoints.length, 0), 0);
                if (!points)
                    return;
                this.inFlight = points;
                this.counters.accepted += points;
                let bytes;
                try {
                    bytes = ProtobufMetricsSerializer.serializeRequest(result.resourceMetrics);
                }
                catch {
                    throw new ExportFailure('serialization');
                }
                this.controller = new AbortController();
                const response = await postOtlp(this.policy.metricsEndpoint, bytes, this.policy, this.credential, this.controller, 'metrics');
                let rejected;
                try {
                    rejected = ProtobufMetricsSerializer.deserializeResponse(response).partialSuccess?.rejectedDataPoints ?? 0;
                }
                catch {
                    throw new ExportFailure('response');
                }
                if (!Number.isSafeInteger(rejected) || rejected < 0 || rejected > points)
                    throw new ExportFailure('response');
                this.counters.exported += points - rejected;
                this.counters.rejected += rejected;
                this.counters.successfulBatches++;
                this.lastSuccessAt = new Date().toISOString();
                this.lastFailure = rejected ? 'partial-rejection' : null;
            }
            catch (error) {
                this.counters.failedBatches++;
                this.counters.dropped += points;
                this.lastFailure ??= error instanceof ExportFailure ? error.category : 'collection';
            }
            finally {
                this.inFlight = 0;
                this.controller = undefined;
                this.attemptedGeneration = generation;
                this.collectionStatus = undefined;
            }
        })().finally(() => { this.exporting = undefined; });
        return this.exporting;
    }
    async flushChanges() {
        const target = this.generation;
        let expired = false;
        const work = (async () => {
            // Exactly one health sample per explicit flush, plus any outstanding
            // execution updates. Exporter counter changes never mark new work dirty.
            if (this.policy.exporterMetrics || this.policy.retainedStateMetrics || this.policy.runtimeWorkMetrics || this.policy.storageQueueMetrics || this.policy.storageTransactionMetrics || this.policy.sqliteStatementMetrics)
                await this.exportSnapshot();
            while (!expired && this.canExport() && this.attemptedGeneration < target)
                await this.exportSnapshot();
        })();
        try {
            await boundedFlush(work, this.policy.flushTimeoutMs);
        }
        finally {
            expired = true;
        }
    }
    async onForceFlush() { if (!this.stopped)
        await this.flushChanges(); }
    async onShutdown() {
        this.stopped = true;
        clearTimeout(this.timer);
        this.timer = undefined;
        await this.flushChanges();
        this.controller?.abort();
        await this.exporting;
        this.abandonedChanges = this.generation - this.attemptedGeneration;
    }
}
export class RuntimeMetrics {
    reader;
    provider;
    totals;
    durations;
    active;
    backoffActive;
    tokens;
    httpTotal;
    httpDuration;
    httpAccessTotal;
    httpAccessDuration;
    httpRateSqlTotal;
    httpRateSqlDuration;
    asyncSlots;
    grantTotal;
    grantDuration;
    grantPolicyTotal;
    grantPolicyDuration;
    connectionOpened;
    connectionEnded;
    connectionActive;
    connectionDuration;
    transportFailures;
    notificationTotal;
    notificationDuration;
    suiteTotal;
    suiteDuration;
    suiteCasesActive;
    suiteCasesSettled;
    closing;
    constructor(policy, credential, resource, canExport = () => true, peerHealth = () => ({}), retainedState = () => ({ available: false }), storageQueues = () => ({ available: false }), storageTransactions = () => ({ available: false }), sqliteStatements = () => ({ available: false }), runtimeWork = () => ({ available: false })) {
        this.reader = new RuntimeMetricReader(policy, credential, canExport);
        this.provider = new MeterProvider({ resource, readers: [this.reader], sdkMetricsEnabled: false, views: [
                ...[InstrumentType.OBSERVABLE_COUNTER, InstrumentType.OBSERVABLE_GAUGE].map(instrumentType => ({
                    // The SDK reserves one slot for overflow; retain all sixteen fixed groups.
                    instrumentName: 'jevable.storage.sqlite.*', instrumentType, aggregationCardinalityLimit: 17,
                    attributesProcessors: [createAllowListAttributesProcessor(SQLITE_STATEMENT_LABELS)]
                })),
                ...[InstrumentType.OBSERVABLE_COUNTER, InstrumentType.OBSERVABLE_GAUGE].map(instrumentType => ({
                    instrumentName: 'jevable.storage.journal.*', instrumentType, aggregationCardinalityLimit: 8,
                    attributesProcessors: [createAllowListAttributesProcessor(STORAGE_TRANSACTION_LABELS)]
                })),
                { instrumentName: 'jevable.storage.queue.*', instrumentType: InstrumentType.OBSERVABLE_GAUGE, aggregationCardinalityLimit: 8,
                    attributesProcessors: [createAllowListAttributesProcessor(STORAGE_QUEUE_LABELS)] },
                { instrumentName: 'jevable.runtime.work.*', instrumentType: InstrumentType.OBSERVABLE_GAUGE, aggregationCardinalityLimit: 2,
                    attributesProcessors: [createAllowListAttributesProcessor([])] },
                { instrumentName: 'jevable.retained.*', instrumentType: InstrumentType.OBSERVABLE_GAUGE, aggregationCardinalityLimit: 128,
                    attributesProcessors: [createAllowListAttributesProcessor(RETAINED_METRIC_LABELS)] },
                ...[InstrumentType.OBSERVABLE_COUNTER, InstrumentType.OBSERVABLE_GAUGE].map(instrumentType => ({
                    instrumentName: 'jevable.telemetry.*', instrumentType, aggregationCardinalityLimit: 128,
                    attributesProcessors: [createAllowListAttributesProcessor(EXPORTER_HEALTH_LABELS)]
                })),
                { instrumentName: '*', instrumentType: InstrumentType.COUNTER, aggregationCardinalityLimit: 128,
                    attributesProcessors: [createAllowListAttributesProcessor(LABELS)] },
                { instrumentName: '*', instrumentType: InstrumentType.UP_DOWN_COUNTER, aggregationCardinalityLimit: 128,
                    attributesProcessors: [createAllowListAttributesProcessor(LABELS)] },
                { instrumentName: '*', instrumentType: InstrumentType.HISTOGRAM, aggregationCardinalityLimit: 128,
                    attributesProcessors: [createAllowListAttributesProcessor(LABELS)],
                    aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
                        options: { boundaries: [0.001, 0.01, 0.1, 0.5, 1, 5, 10, 30, 60, 300, 3600], recordMinMax: true } } },
            ] });
        const meter = this.provider.getMeter('jevable.workflow', CORE_VERSION);
        this.suiteTotal = meter.createCounter('jevable.test.suite.invocations', { description: 'Ended explicit suite run/result observations, including retained-only invocations; not unique batches, executed cases or completed workflows', unit: '{invocation}' });
        this.suiteDuration = meter.createHistogram('jevable.test.suite.duration', { description: 'Suite invocation through per-run report, including preflight and awaiting admitted peers; not human wait or provider duration', unit: 's' });
        this.suiteCasesActive = meter.createUpDownCounter('jevable.test.suite.cases.active', { description: 'Process-local new cases waiting for dispatch or awaiting an admitted host call in current suite invocations; excludes preflight, retained runs, approval backlog and distributed workers', unit: '{case}' });
        this.suiteCasesSettled = meter.createCounter('jevable.test.suite.cases.settled', { description: 'Settled suite dispatch calls, including failed or uncertain submissions; not unique cases, workflow completions or successful assertions', unit: '{case}' });
        this.grantTotal = meter.createCounter('jevable.access.grant.calls', { description: 'Ended owned grant administration calls, including retries; not authorization decisions or unique mutations', unit: '{call}' });
        this.grantDuration = meter.createHistogram('jevable.access.grant.duration', { description: 'Owned grant administration call through return/throw, including storage queue wait; not proof of commit or client receipt', unit: 's' });
        this.grantPolicyTotal = meter.createCounter('jevable.access.policy.evaluations', { description: 'Ended synchronous target-policy evaluations; not request totals, mutation receipts or preliminary token lookups', unit: '{evaluation}' });
        this.grantPolicyDuration = meter.createHistogram('jevable.access.policy.duration', { description: 'Synchronous retained-target policy evaluation only; excludes token lookup, queue wait and later writes', unit: 's' });
        this.notificationTotal = meter.createCounter('jevable.notification.attempts', { description: 'Ended explicit-send observations, including uncertain admission; not unique deliveries or human receipts', unit: '{attempt}' });
        this.notificationDuration = meter.createHistogram('jevable.notification.duration', { description: 'Explicit-send observation through persistence acknowledgement, excluding preparation and credential lookup', unit: 's' });
        this.httpTotal = meter.createCounter('jevable.http.requests', { description: 'Ended HTTP handler/response observations, not committed operations', unit: '{request}' });
        this.httpDuration = meter.createHistogram('jevable.http.duration', { description: 'Time until both handler and response settle; not proof of client receipt', unit: 's' });
        this.httpAccessTotal = meter.createCounter('jevable.http.access.evaluations', { description: 'Ended entered transport predicates, not unique requests, granted workflow authority or committed actions', unit: '{evaluation}' });
        this.httpAccessDuration = meter.createHistogram('jevable.http.access.duration', { description: 'Entered transport predicate only; signed-webhook admission includes bounded body reading', unit: 's' });
        this.httpRateSqlTotal = meter.createCounter('jevable.http.rate.sql.operations', { description: 'Ended entered quota SQL calls, not unique debits or durable workflow receipts', unit: '{operation}' });
        this.httpRateSqlDuration = meter.createHistogram('jevable.http.rate.sql.duration', { description: 'Quota SQL call until driver acknowledgement/failure, excluding queue wait; uncertain COMMIT is not a rollback', unit: 's' });
        this.asyncSlots = meter.createUpDownCounter('jevable.http.async.slots', { description: 'Currently held process-local async HTTP capacity slots by admission/completion phase; not unique runs, queued jobs or distributed workers', unit: '{slot}' });
        this.connectionOpened = meter.createCounter('jevable.http.connections.opened', { description: 'Observed accepted TCP sockets, including pre-handshake sockets; not requests or peers', unit: '{connection}' });
        this.connectionEnded = meter.createCounter('jevable.http.connections.ended', { description: 'Observed TCP socket close events; not HTTP or workflow outcomes', unit: '{connection}' });
        this.connectionActive = meter.createUpDownCounter('jevable.http.connections.active', { description: 'Currently observed TCP sockets in this owner, including TLS handshakes', unit: '{connection}' });
        this.connectionDuration = meter.createHistogram('jevable.http.connection.duration', { description: 'Accepted TCP socket until close; includes handshake and keep-alive time, not request latency', unit: 's' });
        this.transportFailures = meter.createCounter('jevable.http.transport.failures', { description: 'Emitted parser, client transport and TLS handshake failures; not unique requests or rejected peers', unit: '{failure}' });
        this.totals = {
            segment: meter.createCounter('jevable.execution.segments', { description: 'Ended execution segments, not unique runs', unit: '{segment}' }),
            node: meter.createCounter('jevable.node.attempts', { description: 'Ended node attempts including uncertain settlement', unit: '{attempt}' }),
            model: meter.createCounter('jevable.model.calls', { description: 'Ended model adapter calls; not provider HTTP retry counts', unit: '{call}' }),
            try: meter.createCounter('jevable.model.try.attempts', { description: 'Ended transport-try observations for retry-enabled calls, including unacknowledged intents; not proof of provider receipt', unit: '{attempt}' }),
            backoff: meter.createCounter('jevable.model.backoff.waits', { description: 'Ended retry-backoff wait observations after acknowledged retry-delay evidence; not transport tries or unique calls', unit: '{wait}' }),
            recovery: meter.createCounter('jevable.recovery.attempts', { description: 'Ended admitted saved-response recovery observations; not rejected requests or unique recovered runs', unit: '{attempt}' }),
        };
        this.durations = {
            segment: meter.createHistogram('jevable.execution.duration', { description: 'Active execution-segment duration, excluding human wait', unit: 's' }),
            node: meter.createHistogram('jevable.node.duration', { description: 'Node attempt duration through settlement', unit: 's' }),
            model: meter.createHistogram('jevable.model.duration', { description: 'Model adapter call duration', unit: 's' }),
            try: meter.createHistogram('jevable.model.try.duration', { description: 'Retry-enabled transport try through evidence settlement, excluding backoff', unit: 's' }),
            backoff: meter.createHistogram('jevable.model.backoff.duration', { description: 'Observed retry-backoff wait duration, excluding subsequent evidence writes or dispatch', unit: 's' }),
            recovery: meter.createHistogram('jevable.recovery.duration', { description: 'Admitted saved-response recovery observation through node settlement, excluding original model execution', unit: 's' }),
        };
        this.active = meter.createUpDownCounter('jevable.execution.active', { description: 'Active execution segments in this process, not approval backlog', unit: '{segment}' });
        this.backoffActive = meter.createUpDownCounter('jevable.model.backoff.active', { description: 'Currently observed retry-backoff waits in this process; not worker capacity or a scheduler queue', unit: '{wait}' });
        this.tokens = meter.createCounter('jevable.model.tokens', { description: 'Reported model tokens; missing usage is not estimated', unit: '{token}' });
        if (policy.exporterMetrics)
            installExporterHealthMetrics(meter, () => ({ ...peerHealth(), metrics: this.reader.healthSnapshot() }));
        if (policy.retainedStateMetrics)
            installRetainedMetrics(meter, retainedState);
        if (policy.runtimeWorkMetrics)
            installRuntimeWorkMetrics(meter, runtimeWork);
        if (policy.storageQueueMetrics)
            installStorageQueueMetrics(meter, storageQueues);
        if (policy.storageTransactionMetrics)
            this.reader.setStorageTransactionEnrichment(installStorageTransactionMetrics(meter, storageTransactions));
        if (policy.sqliteStatementMetrics)
            this.reader.setSQLiteStatementEnrichment(installSQLiteStatementMetrics(meter, sqliteStatements));
    }
    observe(span, name, attributes) {
        const operation = name.startsWith('jevable.') ? name.slice('jevable.'.length) : '';
        const category = ['run', 'resume', 'approval', 'cancel'].includes(operation) ? 'segment' : operation === 'node' ? 'node' : operation === 'model' ? 'model' : operation === 'model.try' ? 'try' : operation === 'model.backoff' ? 'backoff' : undefined;
        if (!category || this.closing)
            return span;
        const kind = attributes['jevable.node.kind'];
        const labels = category === 'segment' ? { 'jevable.operation': operation } : { 'jevable.node.kind': typeof kind === 'string' && KINDS.has(kind) ? kind : 'other' };
        const started = performance.now();
        if (category === 'segment') {
            this.active.add(1, labels, ROOT_CONTEXT);
            this.reader.changed();
        }
        if (category === 'backoff') {
            this.backoffActive.add(1, labels, ROOT_CONTEXT);
            this.reader.changed();
        }
        return new ObservedExecutionSpan(span, ({ outcome, usage, modelTry, recovery }) => {
            const settled = { ...labels, 'jevable.outcome': OUTCOMES.has(outcome) ? outcome : 'other', ...(category === 'try' ? {
                    'jevable.model.try.phase': attributes['jevable.model.try.phase'] === 'initial' ? 'initial' : attributes['jevable.model.try.phase'] === 'retry' ? 'retry' : 'other',
                    'jevable.model.try.dispatched': modelTry.dispatched === true, 'jevable.model.try.settled': modelTry.settled === true
                } : {}) };
            this.totals[category].add(1, settled, ROOT_CONTEXT);
            const duration = Math.max(0, performance.now() - started) / 1000;
            this.durations[category].record(duration, settled, ROOT_CONTEXT);
            if (operation === 'resume' && recovery.mode === 'recover') {
                const labels = { 'jevable.outcome': OUTCOMES.has(outcome) ? outcome : 'other', 'jevable.recovery.settled': recovery.settled === true };
                this.totals.recovery.add(1, labels, ROOT_CONTEXT);
                this.durations.recovery.record(duration, labels, ROOT_CONTEXT);
            }
            if (category === 'segment')
                this.active.add(-1, labels, ROOT_CONTEXT);
            if (category === 'backoff')
                this.backoffActive.add(-1, labels, ROOT_CONTEXT);
            if (category === 'model')
                for (const direction of ['input', 'output']) {
                    const value = usage[direction];
                    if (Number.isSafeInteger(value) && value >= 0)
                        this.tokens.add(value, { ...labels, 'jevable.token.direction': direction }, ROOT_CONTEXT);
                }
            this.reader.changed();
        });
    }
    status() { return this.reader.status(); }
    suite(attributes, seconds) {
        if (this.closing)
            return;
        const labels = Object.fromEntries(SUITE_METRIC_LABELS.map(key => [key, attributes[key]]));
        this.suiteTotal.add(1, labels, ROOT_CONTEXT);
        this.suiteDuration.record(seconds, labels, ROOT_CONTEXT);
        this.reader.changed();
    }
    suiteCases(policy, before, after) {
        if (this.closing)
            return;
        const labels = { 'jevable.suite.failure_policy': policy };
        for (const phase of ['waiting', 'running'])
            this.suiteCasesActive.add(after[phase] - before[phase], { ...labels, 'jevable.suite.case.phase': phase }, ROOT_CONTEXT);
        const settled = after.settled - before.settled;
        if (settled > 0)
            this.suiteCasesSettled.add(settled, labels, ROOT_CONTEXT);
        this.reader.changed();
    }
    notification(attributes, seconds) {
        if (this.closing)
            return;
        const labels = Object.fromEntries(NOTIFICATION_METRIC_LABELS.map(key => [key, attributes[key]]));
        this.notificationTotal.add(1, labels, ROOT_CONTEXT);
        this.notificationDuration.record(seconds, labels, ROOT_CONTEXT);
        this.reader.changed();
    }
    httpRequest(attributes, seconds) {
        if (this.closing)
            return;
        const labels = Object.fromEntries(HTTP_METRIC_LABELS.filter(key => attributes[key] !== undefined).map(key => [key, attributes[key]]));
        this.httpTotal.add(1, labels, ROOT_CONTEXT);
        this.httpDuration.record(seconds, labels, ROOT_CONTEXT);
        this.reader.changed();
    }
    grantOperation(attributes, seconds) {
        if (this.closing)
            return;
        this.grantTotal.add(1, attributes, ROOT_CONTEXT);
        this.grantDuration.record(seconds, attributes, ROOT_CONTEXT);
        this.reader.changed();
    }
    httpAccess(attributes, seconds) {
        if (this.closing)
            return;
        const labels = Object.fromEntries(HTTP_ACCESS_METRIC_LABELS.map(key => [key, attributes[key]]));
        this.httpAccessTotal.add(1, labels, ROOT_CONTEXT);
        this.httpAccessDuration.record(seconds, labels, ROOT_CONTEXT);
        this.reader.changed();
    }
    httpRateSql(attributes, seconds) {
        if (this.closing)
            return;
        const labels = Object.fromEntries(HTTP_RATE_SQL_METRIC_LABELS.map(key => [key, attributes[key]]));
        this.httpRateSqlTotal.add(1, labels, ROOT_CONTEXT);
        this.httpRateSqlDuration.record(seconds, labels, ROOT_CONTEXT);
        this.reader.changed();
    }
    grantPolicy(attributes, seconds) {
        if (this.closing)
            return;
        this.grantPolicyTotal.add(1, attributes, ROOT_CONTEXT);
        this.grantPolicyDuration.record(seconds, attributes, ROOT_CONTEXT);
        this.reader.changed();
    }
    httpConnectionOpened(attributes) {
        if (this.closing)
            return;
        this.connectionOpened.add(1, attributes, ROOT_CONTEXT);
        this.connectionActive.add(1, attributes, ROOT_CONTEXT);
        this.reader.changed();
    }
    httpConnectionEnded(attributes, seconds) {
        if (this.closing)
            return;
        this.connectionEnded.add(1, attributes, ROOT_CONTEXT);
        this.connectionDuration.record(seconds, attributes, ROOT_CONTEXT);
        this.connectionActive.add(-1, { 'jevable.http.transport': attributes['jevable.http.transport'] }, ROOT_CONTEXT);
        this.reader.changed();
    }
    httpTransportFailure(attributes) {
        if (this.closing)
            return;
        this.transportFailures.add(1, attributes, ROOT_CONTEXT);
        this.reader.changed();
    }
    asyncSlot(phase, delta) {
        if (this.closing)
            return;
        this.asyncSlots.add(delta, { 'jevable.http.async.phase': phase }, ROOT_CONTEXT);
        this.reader.changed();
    }
    busy() { return this.reader.busy(); }
    async flush() { if (!this.closing)
        await this.provider.forceFlush(); }
    close() { return this.closing ??= this.provider.shutdown(); }
}

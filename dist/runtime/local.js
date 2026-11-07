import { randomUUID, createHash } from 'node:crypto';
import { admitAsyncRun, parseAsyncRunOptions } from "./async-run.js";
import { ACTIVITY_LIMITS, activityRun, createActivityReport } from "./activity.js";
import { recordedRoutes } from "./run-routes.js";
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { DEFAULT_COMPILER_LIMITS } from "../limits.js";
import { compileWorkflowYaml, validateWorkflowValue, admitWorkflowData } from "../workflow/index.js";
import { RunStore } from "./store.js";
import { WorkflowRuntimeError } from "./errors.js";
import { advanceCheckpoint, admitExecution, executionModelPlans, compileLocalRun, findNode, initialCheckpoint, verifyModelResults } from "./run-evaluator.js";
import { RunLedger } from "./run-ledger.js";
import { executeWorkflow } from "./execution.js";
import { validateBreakpoints } from "./breakpoints.js";
import { approvalDecision, cancellationRequest, stoppedCheckpoint, stoppedCheckpointHash, executionCheckpointHash } from "./run-types.js";
import { cancellationTraceCause } from "./run-trace.js";
import { executionControlSchema, savedExecutionControlSchema } from "./control.js";
import { callerCancellationRequestSchema, callerCancellationReceipt } from "../access/caller-cancellation.js";
import { callerControlRequestSchema, callerControlCheckpoint, callerControlReceipt, callerControlRetry, assertCallerControlCheckpoint } from "../access/caller-control.js";
import { parseTriggerMode, triggerMetadata } from "./trigger.js";
import { admitPause } from "./pause.js";
import { prepareModelRecovery } from "./recovery.js";
import { ConfiguredModels } from "../providers/model-calls.js";
import { discoverConfiguredModels } from "../providers/discovery.js";
import { ProviderError } from "../providers/config.js";
import { validateSource } from "../validation.js";
import { inspectRelease, releaseCreateCommandSchema } from "../releases/snapshot.js";
import { observeGrantCall } from "../telemetry/grants.js";
import { parseTraceRequestContext } from "../telemetry/baggage.js";
import { disabledCollectorProbe } from "../telemetry/probe-report.js";
import { parseTelemetryConfig, parseTraceParent } from "../telemetry/config.js";
import { savedRunTrace } from "./run-telemetry.js";
import { testIdentitySchema, parseTest, transferredTestsSchema } from "../testing/schema.js";
import { validateTestSource } from "../testing/validate.js";
import { createRunEvidence, RUN_EVIDENCE_LIMITS } from "./evidence.js";
import { testResult } from "../testing/results.js";
import { RetainedRunMetrics } from "./retained-metrics.js";
import { modelEvidenceTargets, ModelEvidenceProjection } from "./model-evidence.js";
import { ApprovalNotificationDispatcher } from "../notifications/dispatcher.js";
import { parseNotificationConfig } from "../notifications/config.js";
import { approvalLifecycleNotification, notificationRequiresLiveWait, notificationWaitExpired, notificationRequestPin, verifyNotificationHistory } from "../notifications/schema.js";
import { AsyncLocalStorage } from 'node:async_hooks';
import { AutomaticApprovalOwner } from "../notifications/automatic-owner.js";
import { parseAutomaticAdmissionPage } from "../notifications/automatic-admission.js";
import { verifyAutomaticStartupScopes, prepareAutomaticStartupRelease, automaticStartupReleaseRead } from "../notifications/automatic-startup.js";
import { notificationPage, parseNotificationPage, filteredNotificationRecords } from "../notifications/history.js";
import { releaseNotificationPage } from "../notifications/release-history.js";
import { projectNotificationRecords, parseNotificationProjectScope } from "../notifications/project-history.js";
import { callerStartOptionsSchema, callerRunReceipt, callerRunResult } from "../access/caller.js";
import { reviewerDecisionRequestSchema, reviewerGrantIds, reviewerRetry, reviewerReceipt } from "../access/reviewer.js";
import { assertReviewerRelease } from "../releases/reviewer.js";
import { SQLiteStatementStatistics } from "../storage/sqlite-statistics.js";
// JavaScript callers may supply extra keys: never forward project/release/test provenance through public options.
const startOptions = (options) => {
    const triggerMode = parseTriggerMode(options.triggerMode);
    return { ...(options.id === undefined ? {} : { id: options.id }), ...(options.paused === undefined ? {} : { paused: options.paused }),
        ...triggerMetadata({ triggerMode }) };
};
/** SDK host for the extracted evaluator; persistence and lifecycle do not involve an agent or UI. */
export class LocalRuntime {
    store;
    limits;
    maxTransitions;
    notificationPolicy;
    models;
    telemetry;
    retainedMetrics;
    lifecycle = 'open';
    pendingOperations = 0;
    flushes = new Set();
    closing;
    active = new Set();
    creatingCallers = new Map();
    controllers = new Map();
    notifications;
    notificationStore;
    automaticNotifications;
    automaticAdmissionLedger;
    ownedNotificationReads = new AsyncLocalStorage();
    /** Startup attachment only, after verified scopes. Never scan retained history. */
    enableAutomaticNotifications(policy, limits, maxPending = 16) {
        this.assertOpen();
        if (this.automaticNotifications || this.pendingOperations || this.active.size)
            throw new WorkflowRuntimeError('busy');
        // Validate policy and work bounds before the explicit schema migration.
        const persistence = { create: (record) => admission.create(record),
            settle: (record) => admission.settle(record) };
        const owner = new AutomaticApprovalOwner(policy, persistence, {
            destinations: () => this.notifications.destinations(),
            send: (...args) => this.ownedNotificationReads.run(true, () => this.notifications.send(...args)),
        }, maxPending);
        const admission = this.store.automaticAdmissionStore(limits, true);
        this.store.observeCommittedApprovals(owner);
        this.automaticNotifications = owner;
        this.automaticAdmissionLedger = admission;
    }
    constructor(store, limits, maxTransitions, notificationPolicy, models, telemetry, retainedMetrics) {
        this.store = store;
        this.limits = limits;
        this.maxTransitions = maxTransitions;
        this.notificationPolicy = notificationPolicy;
        this.models = models;
        this.telemetry = telemetry;
        this.retainedMetrics = retainedMetrics;
        this.notificationStore = store.notificationStore({ maxDeliveries: notificationPolicy.maxDeliveries, maxEvents: notificationPolicy.maxEvents });
        this.notifications = new ApprovalNotificationDispatcher({
            requested: async (pin) => {
                const run = await this.notificationRun(pin.runId);
                if (!isDeepStrictEqual(run, store.get(pin.runId)))
                    throw new WorkflowRuntimeError('conflict');
                return approvalLifecycleNotification(run, store.events(run.id), pin);
            },
            credential: ref => store.providers.credentialSnapshot(ref),
            observeNotification: async (record, previous) => {
                if (!this.telemetry)
                    return undefined;
                const run = await this.notificationRun(record.request.runId);
                if (!isDeepStrictEqual(run, store.get(run.id)))
                    throw new WorkflowRuntimeError('conflict');
                return this.telemetry.notification(record, run, previous);
            },
        }, {
            get: async (id) => {
                const record = this.notificationStore.get(id);
                if (record) {
                    if (!store.get(record.request.runId))
                        throw new WorkflowRuntimeError('corrupt');
                    const run = await this.notificationRun(record.request.runId);
                    if (!isDeepStrictEqual(run, store.get(run.id)))
                        throw new WorkflowRuntimeError('conflict');
                    verifyNotificationHistory(record, run, store.events(run.id));
                }
                return record;
            },
            createIntent: record => {
                // Synchronous final check shares the sole owner with the atomic intent commit: no stale-wait admission across awaits.
                const run = store.get(record.request.runId);
                if (!run)
                    throw new WorkflowRuntimeError('not-found');
                this.checked(run);
                verifyNotificationHistory(record, run, store.events(run.id));
                if (notificationRequiresLiveWait(record.event) && notificationWaitExpired(record.event)
                    || !isDeepStrictEqual(approvalLifecycleNotification(run, store.events(run.id), notificationRequestPin(record.request)), record.event))
                    throw new WorkflowRuntimeError('conflict');
                return this.notificationStore.createIntent(record);
            },
            settle: record => this.notificationStore.settle(record),
        }, notificationPolicy.endpoints, { maxInFlight: notificationPolicy.maxInFlight });
    }
    static async open(options) {
        const policy = { maxRuns: options.maxRuns ?? 10_000, maxRecordBytes: options.maxRecordBytes ?? 16_000_000,
            maxTransitions: options.maxTransitionsPerRun ?? 10_000 };
        if (Object.values(policy).some(value => !Number.isSafeInteger(value) || value < 1))
            throw new WorkflowRuntimeError('invalid-command');
        const telemetryPolicy = options.telemetry === undefined ? undefined : parseTelemetryConfig(options.telemetry);
        // This diagnostic hook belongs to PostgreSQL's journal; never claim SQLite journal coverage.
        if (telemetryPolicy?.journalTransactions)
            throw new WorkflowRuntimeError('invalid-command');
        const notificationPolicy = parseNotificationConfig(options.notifications === undefined ? {} : options.notifications);
        const startupRelease = prepareAutomaticStartupRelease(options.startupRelease, notificationPolicy.automatic);
        const sqliteStatements = telemetryPolicy?.sqliteStatementMetrics ? new SQLiteStatementStatistics() : undefined;
        const store = await RunStore.open(options.dataDirectory, policy, sqliteStatements);
        let telemetry;
        try {
            const retained = telemetryPolicy?.retainedStateMetrics ? new RetainedRunMetrics(policy.maxRuns) : undefined;
            const runtime = new LocalRuntime(store, options.compilerLimits ?? DEFAULT_COMPILER_LIMITS, policy.maxTransitions, notificationPolicy, options.models ?? new ConfiguredModels(store.providers), undefined, retained);
            // Validate before making saved runs available. Interrupted intent remains uncertain; opening never executes it.
            runtime.projects();
            runtime.projectDeletions();
            runtime.releases();
            runtime.testCases();
            runtime.testGenerations();
            store.testStore(runtime.limits).erasures();
            store.grantStore().validate();
            for (const id of store.ids()) {
                const record = await runtime.show(id);
                retained?.restore(record, store.events(id));
            }
            runtime.notificationStore.validate(record => {
                const run = store.get(record.request.runId);
                if (!run)
                    throw new WorkflowRuntimeError('corrupt');
                verifyNotificationHistory(record, run, store.events(run.id));
            });
            runtime.automaticAdmissionLedger = store.validateAutomaticAdmissions();
            if (notificationPolicy.automatic)
                await verifyAutomaticStartupScopes(notificationPolicy.automatic, {
                    project: (id, generation) => store.projectStore(runtime.limits.source).get(id, generation),
                    release: id => automaticStartupReleaseRead(id, () => store.releaseStore().get(id), startupRelease),
                });
            if (notificationPolicy.automatic && runtime.automaticAdmissionLedger)
                runtime.automaticAdmissionLedger = store.automaticAdmissionStore({
                    maxAdmissions: notificationPolicy.automatic.maxAdmissions, maxEvents: notificationPolicy.automatic.maxEvents,
                });
            if (retained) {
                retained.ready();
                store.observeRetainedState(retained);
            }
            if (telemetryPolicy) {
                const credential = () => telemetryPolicy.authentication.kind === 'bearer'
                    ? store.providers.credential(telemetryPolicy.authentication.credentialRef) : undefined;
                if (telemetryPolicy.authentication.kind === 'bearer' && !credential())
                    throw new WorkflowRuntimeError('invalid-command');
                const { RuntimeTelemetry } = await import("../telemetry/traces.js");
                telemetry = new RuntimeTelemetry(telemetryPolicy, credential, { storage: 'sqlite',
                    runtimeWork: () => runtime.lifecycle === 'open'
                        ? { available: true, operations: runtime.pendingOperations, runReservations: runtime.active.size } : { available: false },
                    ...(retained ? { retainedState: () => retained.snapshot() } : {}),
                    ...(sqliteStatements ? { sqliteStatements: () => sqliteStatements.snapshot() } : {}) });
                runtime.telemetry = telemetry;
                if (telemetryPolicy.grantPolicyDecisions)
                    store.observeGrantPolicy(action => runtime.telemetry?.observeGrantPolicy(action));
            }
            // Retain the immutable candidate only after all scope/credential readiness checks.
            // Startup never executes its workflow or scans old approval history.
            if (startupRelease)
                store.releaseStore().put(startupRelease.snapshot, true);
            if (notificationPolicy.automatic)
                runtime.enableAutomaticNotifications(notificationPolicy.automatic.policy, { maxAdmissions: notificationPolicy.automatic.maxAdmissions, maxEvents: notificationPolicy.automatic.maxEvents }, notificationPolicy.automatic.maxPending);
            return runtime;
        }
        catch (error) {
            try {
                await telemetry?.close();
            }
            finally {
                await store.close();
            }
            throw error;
        }
    }
    assertOpen() {
        if (this.lifecycle !== 'open')
            throw new WorkflowRuntimeError('closed');
    }
    /** Trusted owner SDK administration only; these records do not enable delegated HTTP access. */
    grantOperation(kind, work) {
        return observeGrantCall(() => this.telemetry?.observeGrantOperation(kind), work);
    }
    grant(id) { this.assertOpen(); return this.grantOperation('get', () => this.store.grantStore().get(id)); }
    grants(page = {}) { this.assertOpen(); return this.grantOperation('page', () => this.store.grantStore().page(page)); }
    issueGrant(command) {
        return this.operation(() => this.grantOperation('issue', () => this.store.grantStore().issue(command, (scope, at) => {
            if (scope.kind === 'caller') {
                const release = this.store.releaseStore().get(scope.release.id);
                if (release.sha256 !== scope.release.sha256 || release.snapshot.workflow.revision !== scope.release.revision)
                    throw new WorkflowRuntimeError('conflict');
            }
            else {
                const run = this.store.get(scope.runId);
                if (!run)
                    throw new WorkflowRuntimeError('not-found');
                const graph = this.checked(run);
                if (run.revision !== scope.revision || run.cancellation || run.state.status !== 'waiting'
                    || run.state.attempt.id !== scope.attemptId || Date.parse(run.state.expiresAt) <= Date.parse(at))
                    throw new WorkflowRuntimeError('conflict');
                const plan = findNode(graph, run.state.next, run.state.scope)?.plan;
                if (plan?.kind !== 'humanApproval' || scope.decisions.some(action => !plan.actions.includes(action)))
                    throw new WorkflowRuntimeError('invalid-command');
            }
        })));
    }
    revokeGrant(command) { return this.operation(() => this.grantOperation('revoke', () => this.store.grantStore().revoke(command))); }
    /** Includes readiness and retained-evidence reads, not just active workflow execution. */
    async operation(work) {
        this.assertOpen();
        this.pendingOperations++;
        try {
            return await work();
        }
        catch (error) {
            if (error instanceof WorkflowRuntimeError && error.code === 'corrupt')
                this.retainedMetrics?.invalidate();
            throw error;
        }
        finally {
            this.pendingOperations--;
        }
    }
    checked(record) {
        let reviewerBindings = false;
        try {
            const events = this.store.events(record.id), ids = reviewerGrantIds(record, events);
            reviewerBindings = ids.length !== 0;
            return new RunLedger(this.limits).check(record, {
                events, reviewerGrants: ids.map(id => this.store.grantStore().get(id)),
                ...(record.project ? { project: this.store.projectStore(this.limits.source).get(record.project.id, record.project.generation) } : {}),
                ...(record.release ? { release: this.store.releaseStore().get(record.release.id) } : {}),
                ...(record.test ? { test: this.store.testStore(this.limits).get(record.test.id, record.test.generation) } : {}),
                ...(record.caller ? { grant: this.store.grantStore().get(record.caller.grantId) } : {}),
            });
        }
        catch (error) {
            this.retainedMetrics?.invalidate();
            if ((record.caller || reviewerBindings) && error instanceof WorkflowRuntimeError && error.code === 'not-found')
                throw new WorkflowRuntimeError('corrupt');
            throw error;
        }
    }
    async show(id) {
        return this.operation(() => this.readOwnedRun(id));
    }
    notificationRun(id) {
        // Only the bounded owning task uses this path; concurrent manual sends retain the public observation boundary.
        return this.ownedNotificationReads.getStore() ? this.readOwnedRun(id) : this.show(id);
    }
    /** Checked owner-internal read; admitted notification drain may use it after public admission is sealed. */
    async readOwnedRun(id) {
        if (!z.uuid().safeParse(id).success)
            throw new WorkflowRuntimeError('invalid-command');
        const record = this.store.get(id);
        if (!record)
            throw new WorkflowRuntimeError('not-found');
        const graph = this.checked(record);
        const state = stoppedCheckpoint(record.state);
        await verifyModelResults(graph, state.status === 'waiting' || state.status === 'executing'
            ? { status: 'paused', steps: state.steps, next: state.next, ...(state.scope ? { scope: state.scope } : {}) } : state, this.models);
        return record;
    }
    activityReport() {
        return this.operation(async () => {
            const projects = this.store.projectStore(this.limits.source).activity(), ids = this.store.ids();
            if (projects.length > ACTIVITY_LIMITS.projects || ids.length > ACTIVITY_LIMITS.runs)
                throw new WorkflowRuntimeError('limit');
            const fingerprints = new Map(), runs = [];
            const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
            for (const id of ids) {
                const run = await this.show(id);
                fingerprints.set(id, fingerprint(run));
                runs.push(activityRun(run));
            }
            // No awaits here: all captured sources coexist at this final observation.
            if (!isDeepStrictEqual(ids, this.store.ids()) || !isDeepStrictEqual(projects, this.store.projectStore(this.limits.source).activity()))
                throw new WorkflowRuntimeError('conflict');
            for (const id of ids)
                if (fingerprint(this.store.get(id)) !== fingerprints.get(id))
                    throw new WorkflowRuntimeError('conflict');
            return createActivityReport('sqlite', projects, runs);
        });
    }
    list() {
        this.assertOpen();
        return this.store.ids().map(id => {
            const run = this.store.get(id);
            return { id, revision: run.revision, status: run.state.status, createdAt: run.createdAt, updatedAt: run.updatedAt,
                ...triggerMetadata(run), ...(run.project ? { project: run.project } : {}), ...(run.release ? { release: run.release } : {}), ...(run.test ? { test: run.test } : {}) };
        });
    }
    /** Bounded metadata page; retains the legacy unpaged list() contract separately. */
    listPage(after, limit = 100) {
        this.assertOpen();
        return this.metadataPage(this.store.idPage(after, limit));
    }
    /** Exact-release metadata only; explicit pages do not load unrelated retained run payloads. */
    listReleasePage(pin, after, limit = 100) {
        this.assertOpen();
        const result = this.metadataPage(this.store.releaseIdPage(pin, after, limit));
        if (result.runs.some(run => run.revision !== pin.revision || run.release?.id !== pin.id
            || run.release.sha256 !== pin.sha256))
            throw new WorkflowRuntimeError('corrupt');
        return result;
    }
    metadataPage(page) {
        const runs = page.ids.map(id => {
            const run = this.store.get(id);
            if (!run || run.id !== id)
                throw new WorkflowRuntimeError('corrupt');
            return { id, revision: run.revision, status: run.state.status, createdAt: run.createdAt, updatedAt: run.updatedAt,
                ...triggerMetadata(run), ...(run.project ? { project: run.project } : {}), ...(run.release ? { release: run.release } : {}), ...(run.test ? { test: run.test } : {}) };
        });
        return { runs, nextCursor: page.nextCursor };
    }
    /** Inspect actual policy and credentials without running nodes or contacting a model. */
    async check(yaml, triggerMode) {
        return this.operation(async () => {
            parseTriggerMode(triggerMode);
            const validation = validateSource(yaml, this.limits);
            if (validation.status !== 'valid')
                return { ...validation, ...triggerMetadata({ triggerMode }) };
            try {
                await admitExecution(compileLocalRun(yaml, this.limits, triggerMode), this.models);
                return { ...validation, ...triggerMetadata({ triggerMode }), runtimeReadiness: 'ready' };
            }
            catch (error) {
                if (!(error instanceof ProviderError || error instanceof WorkflowRuntimeError))
                    throw error;
                return { ...validation, ...triggerMetadata({ triggerMode }), runtimeReadiness: 'unavailable',
                    diagnostics: [{ code: error.code, message: error.message }] };
            }
        });
    }
    connections() { this.assertOpen(); return this.store.providers.listConnections(); }
    discoverModels(id, options) { return this.operation(() => discoverConfiguredModels(this.store.providers, id, options)); }
    notificationDestinations() { this.assertOpen(); return this.notifications.destinations(); }
    /** Metadata only. Configured policy does not grant approval, redelivery or recovery authority. */
    automaticApprovalNotificationStatus() {
        this.assertOpen();
        return { schemaVersion: 1, configured: !!this.notificationPolicy.automatic,
            ...(this.notificationPolicy.automatic ? { policySha256: this.notificationPolicy.automatic.reviewedPolicySha256,
                routeCount: this.notificationPolicy.automatic.policy.routes.length } : {}),
            live: this.automaticNotifications?.snapshot() ?? null };
    }
    automaticApprovalAdmissions(page = {}) {
        return this.operation(() => {
            const parsed = parseAutomaticAdmissionPage(page);
            if (!this.automaticAdmissionLedger) {
                if (parsed.after)
                    throw new WorkflowRuntimeError('not-found');
                return { records: [], nextCursor: null };
            }
            return this.automaticAdmissionLedger.page(parsed);
        });
    }
    automaticApprovalAdmission(requestId) {
        return this.operation(() => {
            if (!z.uuid().safeParse(requestId).success)
                throw new WorkflowRuntimeError('invalid-command');
            const record = this.automaticAdmissionLedger?.get(requestId);
            if (!record)
                throw new WorkflowRuntimeError('not-found');
            return record;
        });
    }
    prepareApprovalNotification(pin, endpointId) {
        return this.operation(() => this.notifications.prepare(pin, endpointId));
    }
    inspectApprovalNotification(requestId) {
        return this.operation(() => this.notifications.inspect(requestId));
    }
    abortApprovalNotification(requestId) { return this.operation(() => this.notifications.abort(requestId)); }
    listApprovalNotifications(value, release) {
        const options = parseNotificationPage(value);
        return this.operation(async () => {
            const page = release === undefined ? options.filter === undefined ? this.notificationStore.page(options)
                : await filteredNotificationRecords(this.notificationStore, options)
                : await releaseNotificationPage(this.notificationStore, release, options);
            for (const record of page.records) {
                if (!this.store.get(record.request.runId))
                    throw new WorkflowRuntimeError('corrupt');
                const run = await this.show(record.request.runId);
                if (!isDeepStrictEqual(run, this.store.get(run.id)))
                    throw new WorkflowRuntimeError('conflict');
                verifyNotificationHistory(record, run, this.store.events(run.id));
            }
            return notificationPage(page.records, page.nextCursor, options);
        });
    }
    listProjectApprovalNotifications(project, value) {
        const scope = parseNotificationProjectScope(project), options = parseNotificationPage(value);
        return this.operation(async () => {
            const page = await projectNotificationRecords(this.notificationStore, scope, options);
            for (const record of page.records) {
                if (!this.store.get(record.request.runId))
                    throw new WorkflowRuntimeError('corrupt');
                const run = await this.show(record.request.runId);
                if (!isDeepStrictEqual(run, this.store.get(run.id)))
                    throw new WorkflowRuntimeError('conflict');
                verifyNotificationHistory(record, run, this.store.events(run.id));
            }
            return { ...notificationPage(page.records, page.nextCursor, options), project: scope };
        });
    }
    sendApprovalNotification(request, actor, options = {}) {
        return this.operation(() => this.notifications.send(request, actor, options));
    }
    configureConnection(value, expectedGeneration, actor) {
        this.assertOpen();
        if (this.pendingOperations || this.active.size || this.flushes.size || this.automaticNotifications?.busy() || this.telemetry?.busy())
            throw new WorkflowRuntimeError('busy');
        return this.store.providers.putConnection(value, expectedGeneration, actor);
    }
    credentialStatus(ref) { this.assertOpen(); return this.store.providers.credentialStatus(ref); }
    setCredential(ref, value, expectedGeneration, actor) {
        this.assertOpen();
        if (this.pendingOperations || this.active.size || this.flushes.size || this.automaticNotifications?.busy() || this.telemetry?.busy())
            throw new WorkflowRuntimeError('busy');
        return this.store.providers.setCredential(ref, value, expectedGeneration, actor);
    }
    providerAudit() { this.assertOpen(); return this.store.providers.auditEvents(); }
    clearCredential(ref, expectedGeneration, actor) {
        this.assertOpen();
        if (this.pendingOperations || this.active.size || this.flushes.size || this.automaticNotifications?.busy() || this.telemetry?.busy())
            throw new WorkflowRuntimeError('busy');
        return this.store.providers.clearCredential(ref, expectedGeneration, actor);
    }
    telemetryStatus() { return this.telemetry?.status() ?? { enabled: false, signals: [] }; }
    telemetryProbe(options = {}) {
        return this.operation(() => this.telemetry ? this.telemetry.probe(options) : disabledCollectorProbe());
    }
    observeHttpRequest(method, path) { return this.telemetry?.observeHttpRequest(method, path); }
    observeHttpAccess(stage) { return this.telemetry?.observeHttpAccess(stage); }
    observeHttpRateSql(operation, parent) { return this.telemetry?.observeHttpRateSql(operation, parent); }
    observeHttpAsyncSlot() { return this.telemetry?.observeHttpAsyncSlot(); }
    observeTestSuite(identity) { return this.telemetry?.observeTestSuite(identity); }
    observeHttpConnection(transport) { return this.telemetry?.observeHttpConnection(transport); }
    observeHttpTransportFailure(transport, failure) { this.telemetry?.observeHttpTransportFailure(transport, failure); }
    async telemetryFlush() {
        this.assertOpen();
        const flushing = this.telemetry ? this.telemetry.flush() : Promise.resolve(this.telemetryStatus());
        this.flushes.add(flushing);
        try {
            return await flushing;
        }
        finally {
            this.flushes.delete(flushing);
        }
    }
    withTraceParent(parent, operation) {
        this.assertOpen();
        parseTraceParent(parent);
        return this.telemetry ? this.telemetry.withParent(parent, operation) : operation();
    }
    withTraceContext(value, operation) {
        this.assertOpen();
        const context = parseTraceRequestContext(value);
        return this.withTraceParent(context.traceparent, () => this.telemetry ? this.telemetry.withBaggage(context.baggage, operation) : operation());
    }
    projects() { this.assertOpen(); return this.store.projectStore(this.limits.source).list(); }
    project(id) { this.assertOpen(); return this.store.projectStore(this.limits.source).get(id); }
    editProject(command) { this.assertOpen(); return this.store.projectStore(this.limits.source).execute(command); }
    createVendorImport(command) { this.assertOpen(); return this.store.projectStore(this.limits.source).createVendorImport(command); }
    vendorImport(id, inspect = false) { this.assertOpen(); return this.store.projectStore(this.limits.source).vendorImport(id, inspect); }
    diffProject(id, from, to) { this.assertOpen(); return this.store.projectStore(this.limits.source).diff(id, from, to); }
    projectDeletions() { this.assertOpen(); return this.store.projectStore(this.limits.source).deletions(); }
    exportProject(id, expectedGeneration, reviewedRevision, history = false, includeTests = false) {
        this.assertOpen();
        if (typeof includeTests !== 'boolean')
            throw new WorkflowRuntimeError('invalid-command');
        let tests;
        if (includeTests) {
            const all = this.testCases().filter(item => item.project.id === id);
            tests = parseTest(transferredTestsSchema, { scope: 'accepted-revision-latest-definitions',
                excludedOtherRevisions: all.filter(item => item.project.revision !== reviewedRevision).length,
                ...(all.some(item => item.archived && item.project.revision === reviewedRevision)
                    ? { excludedArchived: all.filter(item => item.archived && item.project.revision === reviewedRevision).length } : {}),
                cases: all.filter(item => !item.archived && item.project.revision === reviewedRevision).map(item => ({
                    source: { id: item.id, generation: item.generation, sha256: item.sha256 }, status: item.status,
                    definition: this.testCase(item.id).definition
                })) }, 16_000_000);
        }
        return this.store.projectStore(this.limits.source).export(id, expectedGeneration, reviewedRevision, history, tests);
    }
    inspectProjectImport(json) {
        this.assertOpen();
        const review = this.store.projectStore(this.limits.source).inspectImport(json);
        if (review.bundle.version === 2 && review.bundle.tests.cases.length) {
            const graph = compileWorkflowYaml(review.bundle.accepted.yaml, this.limits);
            for (const item of review.bundle.tests.cases) {
                parseTest(transferredTestsSchema.shape.cases.element, item);
                validateTestSource(item.definition, graph, this.limits);
            }
        }
        return review;
    }
    importProject(json, reviewedSha256, actor, newId) {
        this.assertOpen();
        const { bundle } = this.inspectProjectImport(json);
        return this.store.projectStore(this.limits.source).import(json, reviewedSha256, actor, newId, project => {
            if (bundle.version === 2)
                this.store.testStore(this.limits).importDrafts(bundle.tests, { id: project.id, generation: project.generation, revision: project.acceptedRevision }, reviewedSha256, actor);
        });
    }
    deleteProject(id, expectedGeneration, actor) {
        this.assertOpen();
        if (this.releases().some(release => release.snapshot.project.id === id))
            throw new WorkflowRuntimeError('referenced');
        if (this.testCases().some(test => test.project.id === id))
            throw new WorkflowRuntimeError('referenced');
        if (this.testGenerations().some(batch => batch.request.project.id === id))
            throw new WorkflowRuntimeError('referenced');
        if (this.store.testStore(this.limits).erasures().some(receipt => receipt.project.id === id))
            throw new WorkflowRuntimeError('referenced');
        return this.store.projectStore(this.limits.source).deleteArchived({ id, expectedGeneration, actor });
    }
    testCases() { this.assertOpen(); return this.store.testStore(this.limits).list(); }
    testCase(id, generation) { this.assertOpen(); return this.store.testStore(this.limits).get(id, generation); }
    testHistory(id) { this.assertOpen(); return this.store.testStore(this.limits).history(id); }
    generateTests(command) { this.assertOpen(); return this.store.testStore(this.limits).generate(command); }
    testGeneration(id) { this.assertOpen(); return this.store.testStore(this.limits).generation(id); }
    testGenerations() { this.assertOpen(); return this.store.testStore(this.limits).generations().map(({ snapshot: { cases, ...snapshot }, sha256 }) => ({ ...snapshot, caseCount: cases.length, sha256 })); }
    editTest(command) { this.assertOpen(); return this.store.testStore(this.limits).execute(command); }
    eraseTest(command) { this.assertOpen(); return this.store.testStore(this.limits).erase(command); }
    testErasure(requestId) { this.assertOpen(); return this.store.testStore(this.limits).erasure(requestId); }
    async testResult(id, inspect = false) {
        return this.operation(async () => {
            const run = await this.show(id);
            if (!run.test)
                throw new WorkflowRuntimeError('conflict');
            return testResult(this.testCase(run.test.id, run.test.generation), run, inspect);
        });
    }
    async runTest(value, runId) {
        return this.operation(async () => {
            const identity = parseTest(testIdentitySchema, value);
            if (!z.uuid().safeParse(runId).success)
                throw new WorkflowRuntimeError('invalid-command');
            const saved = this.store.get(runId);
            if (saved) {
                if (!isDeepStrictEqual(saved.test, identity))
                    throw new WorkflowRuntimeError('conflict');
                return this.testResult(runId);
            }
            const test = this.testCase(identity.id);
            if (test.archived)
                throw new WorkflowRuntimeError('archived');
            if (test.status !== 'accepted' || test.generation !== identity.generation || test.sha256 !== identity.sha256)
                throw new WorkflowRuntimeError('conflict');
            const pin = test.definition.project, project = this.project(pin.id);
            if (project.archived)
                throw new WorkflowRuntimeError('archived');
            if (project.generation !== pin.generation || project.acceptedRevision !== pin.revision)
                throw new WorkflowRuntimeError('conflict');
            const source = project.revisions.find(item => item.revision === pin.revision);
            await this.start(source.yaml, test.definition.input, { id: runId, project: { id: pin.id, generation: pin.generation }, test: identity,
                ...triggerMetadata(test.definition) });
            return this.testResult(runId);
        });
    }
    releases() { this.assertOpen(); return this.store.releaseStore().list(); }
    release(id) { this.assertOpen(); return this.store.releaseStore().get(id); }
    createRelease(value) {
        this.assertOpen();
        const parsed = releaseCreateCommandSchema.safeParse(value);
        if (!parsed.success)
            throw new WorkflowRuntimeError('invalid-command');
        const command = parsed.data;
        const project = this.project(command.projectId);
        if (project.archived)
            throw new WorkflowRuntimeError('archived');
        if (project.generation !== command.expectedGeneration || project.acceptedRevision !== command.revision)
            throw new WorkflowRuntimeError('conflict');
        if (this.releases().some(release => release.snapshot.project.id === command.projectId && release.snapshot.version === command.version))
            throw new WorkflowRuntimeError('conflict');
        return this.store.releaseStore().put({ format: 'jevable.ai/release', schemaVersion: 1, id: command.id ?? randomUUID(),
            version: command.version, createdAt: new Date().toISOString(), createdBy: command.actor,
            project: { id: project.id, generation: project.generation }, workflow: project.revisions.find(item => item.revision === command.revision), runtime: command.runtime,
            ...(command.notes === undefined ? {} : { notes: command.notes }) });
    }
    /** Admit an explicit immutable release artifact; its external creator is not a locally authenticated actor. */
    async runRelease(value, input, options = {}) {
        return this.operation(() => this.startRelease(value, input, options));
    }
    runReleaseAsync(value, input, options) {
        return admitAsyncRun(created => this.operation(() => this.startRelease(value, input, parseAsyncRunOptions(options), created)));
    }
    async startRelease(value, input, options, created) {
        const release = inspectRelease(value);
        const selected = startOptions(options);
        compileLocalRun(release.snapshot.workflow.yaml, this.limits, selected.triggerMode);
        this.store.releaseStore().put(release.snapshot, true);
        return this.start(release.snapshot.workflow.yaml, input, { ...selected, release: { id: release.snapshot.id, sha256: release.sha256 } }, undefined, created);
    }
    callerPrincipal(token, permission) {
        const principal = this.store.grantStore().lookup(token);
        if (!principal || principal.scope.kind !== 'caller' || !principal.scope.permissions.includes(permission))
            throw new WorkflowRuntimeError('not-found');
        return principal;
    }
    /** Experimental direct SDK caller surface. No owner payload or arbitrary source/release options. */
    startWithGrant(token, input, value, context) {
        return this.operation(async () => {
            const parsed = callerStartOptionsSchema.safeParse(value);
            if (!parsed.success || context !== undefined && typeof context !== 'function')
                throw new WorkflowRuntimeError('invalid-command');
            const principal = this.callerPrincipal(token, 'start');
            if (principal.scope.kind !== 'caller')
                throw new WorkflowRuntimeError('not-found');
            const pin = principal.scope.release;
            const captured = admitWorkflowData(input, this.limits.binding.data);
            const execute = async () => {
                const fresh = this.callerPrincipal(token, 'start');
                if (fresh.grantId !== principal.grantId || !isDeepStrictEqual(fresh.scope, principal.scope))
                    throw new WorkflowRuntimeError('not-found');
                const release = this.release(pin.id);
                if (release.sha256 !== pin.sha256 || release.snapshot.workflow.revision !== pin.revision)
                    throw new WorkflowRuntimeError('corrupt');
                const selected = { id: parsed.data.id,
                    ...(parsed.data.paused === undefined ? {} : { paused: parsed.data.paused }),
                    ...(parsed.data.triggerMode === undefined ? {} : { triggerMode: parsed.data.triggerMode }) };
                const run = await this.start(release.snapshot.workflow.yaml, captured, { ...selected, release: { id: pin.id, sha256: pin.sha256 } }, { token, principal: fresh });
                return callerRunReceipt(run);
            };
            return context ? context(structuredClone(pin), execute) : execute();
        });
    }
    /** Reads only this grant's retained run and completed output; never resumes or dispatches. */
    readWithGrant(token, value, context) {
        return this.operation(async () => {
            const parsed = z.uuid().safeParse(value);
            if (!parsed.success || context !== undefined && typeof context !== 'function')
                throw new WorkflowRuntimeError('invalid-command');
            const id = parsed.data.toLowerCase(), principal = this.callerPrincipal(token, 'read');
            if (!this.store.getCaller(id, principal))
                throw new WorkflowRuntimeError('not-found');
            if (principal.scope.kind !== 'caller')
                throw new WorkflowRuntimeError('not-found');
            const execute = async () => {
                const fresh = this.callerPrincipal(token, 'read');
                if (fresh.grantId !== principal.grantId || !isDeepStrictEqual(fresh.scope, principal.scope) || !this.store.getCaller(id, fresh))
                    throw new WorkflowRuntimeError('not-found');
                const run = await this.show(id);
                const final = this.callerPrincipal(token, 'read');
                if (final.grantId !== principal.grantId || !isDeepStrictEqual(final.scope, principal.scope))
                    throw new WorkflowRuntimeError('not-found');
                return callerRunResult(run);
            };
            return context ? context(structuredClone(principal.scope.release), execute) : execute();
        });
    }
    /** Experimental caller mutation: admission precedes abort; exact retries never repeat abort or settlement. */
    cancelWithGrant(token, value, request, context) {
        return this.operation(async () => {
            const id = z.uuid().transform(value => value.toLowerCase()).safeParse(value), parsed = callerCancellationRequestSchema.safeParse(request);
            if (!id.success || !parsed.success || context !== undefined && typeof context !== 'function')
                throw new WorkflowRuntimeError('invalid-command');
            const principal = this.callerPrincipal(token, 'cancel');
            if (principal.scope.kind !== 'caller' || !this.store.getCaller(id.data, principal))
                throw new WorkflowRuntimeError('not-found');
            const execute = async () => {
                const fresh = this.callerPrincipal(token, 'cancel');
                if (fresh.grantId !== principal.grantId || !isDeepStrictEqual(fresh.scope, principal.scope))
                    throw new WorkflowRuntimeError('not-found');
                const result = this.store.saveCallerCancellation(token, id.data, parsed.data, record => this.checked(record), () => this.telemetry?.parent());
                if (!result.admitted)
                    return callerCancellationReceipt(result.record);
                this.controllers.get(id.data)?.abort();
                return callerCancellationReceipt(this.active.has(id.data) ? result.record : this.finishCancellation(result.record));
            };
            return context ? context(structuredClone(principal.scope.release), execute) : execute();
        });
    }
    /** Control-only opaque checkpoint inspection; never discloses output or dispatches work. */
    controlCheckpointWithGrant(token, value, context) {
        return this.operation(async () => {
            const parsed = z.uuid().transform(value => value.toLowerCase()).safeParse(value);
            if (!parsed.success || context !== undefined && typeof context !== 'function')
                throw new WorkflowRuntimeError('invalid-command');
            const id = parsed.data, principal = this.callerPrincipal(token, 'control');
            if (principal.scope.kind !== 'caller' || !this.store.getCaller(id, principal))
                throw new WorkflowRuntimeError('not-found');
            const execute = async () => {
                const fresh = this.callerPrincipal(token, 'control');
                if (fresh.grantId !== principal.grantId || !isDeepStrictEqual(fresh.scope, principal.scope) || !this.store.getCaller(id, fresh))
                    throw new WorkflowRuntimeError('not-found');
                const record = await this.show(id), final = this.callerPrincipal(token, 'control');
                if (final.grantId !== principal.grantId || !isDeepStrictEqual(final.scope, principal.scope))
                    throw new WorkflowRuntimeError('not-found');
                return callerControlCheckpoint(record);
            };
            return context ? context(structuredClone(principal.scope.release), execute) : execute();
        });
    }
    /** Caller execution uses its own writer admission, never an owner advance/action token. */
    advanceWithGrant(token, value, command, context) {
        return this.operation(async () => {
            const id = z.uuid().transform(value => value.toLowerCase()).safeParse(value), parsed = callerControlRequestSchema.safeParse(command);
            if (!id.success || !parsed.success || context !== undefined && typeof context !== 'function')
                throw new WorkflowRuntimeError('invalid-command');
            const principal = this.callerPrincipal(token, 'control');
            if (principal.scope.kind !== 'caller' || !this.store.getCaller(id.data, principal))
                throw new WorkflowRuntimeError('not-found');
            const request = parsed.data, execute = async () => {
                const fresh = this.callerPrincipal(token, 'control');
                if (fresh.grantId !== principal.grantId || !isDeepStrictEqual(fresh.scope, principal.scope))
                    throw new WorkflowRuntimeError('not-found');
                const selected = this.store.getCaller(id.data, fresh);
                if (!selected)
                    throw new WorkflowRuntimeError('not-found');
                this.checked(selected);
                const retry = callerControlRetry(selected, request);
                if (retry)
                    return retry; // Also valid while the original admitted worker is active.
                if (request.mode === 'pause') {
                    const result = this.store.saveCallerControl(token, id.data, request, record => this.checked(record), this.limits);
                    return callerControlReceipt(result.record, request.requestId);
                }
                if (this.active.has(id.data))
                    throw new WorkflowRuntimeError('busy');
                this.active.add(id.data);
                let record, graph;
                try {
                    record = await this.show(id.data);
                    graph = this.checked(record);
                    assertCallerControlCheckpoint(record, request);
                    validateBreakpoints(graph, request);
                    const next = request.mode === 'recover' ? await prepareModelRecovery(record, graph, this.limits, this.models) : undefined;
                    if (request.mode !== 'recover')
                        await this.admitRetained(graph, id.data);
                    // The writer freshly checks token, exact checkpoint, legal state and deadline after all awaits.
                    const result = this.store.saveCallerControl(token, id.data, request, current => this.checked(current), this.limits);
                    record = result.record;
                    if (!result.admitted)
                        return callerControlReceipt(record, request.requestId);
                    if (next) {
                        if (record.state.status !== 'executing')
                            throw new WorkflowRuntimeError('conflict');
                        const prior = record.state, segment = this.telemetry?.segment(record, 'resume');
                        segment?.setAttribute('jevable.control.request_id', request.requestId);
                        segment?.setAttribute('jevable.control.mode', 'recover');
                        let settled = false;
                        try {
                            record = this.saveSegment(record, segment, 'resume');
                            record = { ...record, state: next, updatedAt: new Date().toISOString() };
                            this.store.save(record, 'node-result', { attemptId: prior.attempt.id, nodeId: prior.next, scope: prior.scope ?? null,
                                status: next.status, routes: recordedRoutes(next.steps, prior.steps.length) });
                            settled = true;
                            return callerControlReceipt(record, request.requestId);
                        }
                        finally {
                            segment?.setAttribute('jevable.recovery.settled', settled);
                            this.telemetry?.end(segment, settled ? next.status : 'failed-or-uncertain', !settled || next.status === 'failed');
                        }
                    }
                }
                finally {
                    this.active.delete(id.data);
                }
                const result = await this.execute(record, graph, 'resume', undefined, request.mode === 'step' ? 1 : Infinity, request);
                return callerControlReceipt(result, request.requestId);
            };
            return context ? context(structuredClone(principal.scope.release), execute) : execute();
        });
    }
    /** Generation and reviewed hash are required; a pending proposal never becomes executable by accident. */
    async runProject(id, expectedGeneration, reviewedRevision, input, options = {}) {
        return this.operation(() => this.startProject(id, expectedGeneration, reviewedRevision, input, options));
    }
    runProjectAsync(id, expectedGeneration, reviewedRevision, input, options) {
        return admitAsyncRun(created => this.operation(() => this.startProject(id, expectedGeneration, reviewedRevision, input, parseAsyncRunOptions(options), created)));
    }
    async startProject(id, expectedGeneration, reviewedRevision, input, options, created) {
        options = startOptions(options);
        if (options.paused !== undefined && typeof options.paused !== 'boolean')
            throw new WorkflowRuntimeError('invalid-command');
        // Recover a lost response using the original run identity even if the project has since changed.
        if (options.id) {
            const saved = this.store.get(options.id);
            if (saved) {
                if (saved.test || saved.project?.id !== id || saved.project.generation !== expectedGeneration || saved.revision !== reviewedRevision
                    || Boolean(saved.startedPaused) !== Boolean(options.paused) || saved.triggerMode !== options.triggerMode
                    || !isDeepStrictEqual(saved.input, input))
                    throw new WorkflowRuntimeError('conflict');
                return this.show(options.id);
            }
        }
        const project = this.project(id);
        if (project.generation !== expectedGeneration || project.acceptedRevision !== reviewedRevision)
            throw new WorkflowRuntimeError('conflict');
        if (project.archived)
            throw new WorkflowRuntimeError('archived');
        const source = project.revisions.find(item => item.revision === reviewedRevision);
        return this.start(source.yaml, input, { ...startOptions(options), project: { id, generation: expectedGeneration } }, undefined, created);
    }
    async events(id) {
        return this.operation(async () => {
            await this.show(id);
            return this.store.events(id);
        });
    }
    /** Bounded read-only observation. Retry reads, never execution, if validation overlaps a transition. */
    async exportRun(id, includePrivate = false) {
        return this.snapshotEvidence(id, includePrivate, false);
    }
    /** Explicit usage grouping read; ordinary evidence never includes provider/requested-model identities. */
    exportUsageRun(id) { return this.snapshotEvidence(id, false, true); }
    async snapshotEvidence(id, includePrivate, usageIdentities) {
        return this.operation(async () => {
            if (!z.uuid().safeParse(id).success || typeof includePrivate !== 'boolean')
                throw new WorkflowRuntimeError('invalid-command');
            for (let attempt = 0; attempt < RUN_EVIDENCE_LIMITS.snapshotAttempts; attempt++) {
                const size = this.store.eventSize(id);
                if (size.count > RUN_EVIDENCE_LIMITS.events || size.bytes > RUN_EVIDENCE_LIMITS.journalBytes)
                    throw new WorkflowRuntimeError('limit');
                const run = await this.show(id);
                if (!isDeepStrictEqual(run, this.store.get(id)))
                    continue;
                // These synchronous reads share the exclusive owner's event-loop turn. No execution can interleave here.
                const events = this.store.events(id), models = new ModelEvidenceProjection(64_000_000, usageIdentities);
                for (const target of modelEvidenceTargets(this.checked(run), events))
                    models.add(target, this.store.providers.evidence(target.attempt.id));
                return createRunEvidence(run, events, includePrivate, models.calls, usageIdentities);
            }
            throw new WorkflowRuntimeError('busy');
        });
    }
    /** Persist before signalling. An active owner returns a request receipt; inspect until it stops. */
    cancel(id, requestId, actor) {
        this.assertOpen();
        if (!z.uuid().safeParse(id).success)
            throw new WorkflowRuntimeError('invalid-command');
        const parsed = cancellationRequest.safeParse({ id: requestId, actor, at: new Date().toISOString() });
        if (!parsed.success)
            throw new WorkflowRuntimeError('invalid-command');
        let record = this.store.get(id);
        if (!record)
            throw new WorkflowRuntimeError('not-found');
        this.checked(record);
        if (record.cancellation) {
            if (record.cancellation.id !== requestId)
                throw new WorkflowRuntimeError('conflict');
        }
        else {
            if (['completed', 'failed', 'cancelled'].includes(record.state.status))
                throw new WorkflowRuntimeError('conflict');
            const parent = this.telemetry?.parent(), cancellation = { ...parsed.data, ...(parent ? { traceParent: parent } : {}) };
            record = { ...record, cancellation, updatedAt: cancellation.at };
            this.store.save(record, 'cancellation-requested', cancellation);
        }
        this.controllers.get(id)?.abort();
        return this.active.has(id) ? record : this.finishCancellation(record);
    }
    finishCancellation(record) {
        if (!record.cancellation || record.state.status === 'cancelled' || record.state.status === 'completed' || record.state.status === 'failed')
            return record;
        const segment = this.telemetry?.segment(record, 'cancel');
        let failed = true;
        try {
            record = this.saveSegment(record, segment, 'cancel');
            const state = record.state;
            const next = { ...record, updatedAt: new Date().toISOString(),
                state: { ...state, status: 'cancelled', previousStatus: state.status } };
            this.store.save(next, 'run-cancelled', { requestId: record.cancellation.id, previousStatus: state.status,
                next: state.next, attemptId: 'attempt' in state ? state.attempt.id : null, checkpointSha256: stoppedCheckpointHash(state) });
            failed = false;
            return next;
        }
        finally {
            this.telemetry?.end(segment, failed ? 'failed-or-uncertain' : 'cancelled', failed);
        }
    }
    /** A caller-supplied UUID is the retry identity. Reusing it never re-executes a saved run. */
    async run(yaml, input, options = {}) {
        return this.operation(async () => {
            return this.start(yaml, input, startOptions(options));
        });
    }
    runAsync(yaml, input, options) {
        return admitAsyncRun(created => this.operation(() => this.start(yaml, input, parseAsyncRunOptions(options), undefined, created)));
    }
    async start(yaml, input, options, delegated, created) {
        if (options.paused !== undefined && typeof options.paused !== 'boolean')
            throw new WorkflowRuntimeError('invalid-command');
        const id = options.id ?? randomUUID();
        if (!z.uuid().safeParse(id).success)
            throw new WorkflowRuntimeError('invalid-command');
        if (this.active.has(id)) {
            if (delegated && this.creatingCallers.get(id) !== delegated.principal.grantId && !this.store.getCaller(id, delegated.principal))
                throw new WorkflowRuntimeError('not-found');
            throw new WorkflowRuntimeError('busy');
        }
        const graph = compileLocalRun(yaml, this.limits, parseTriggerMode(options.triggerMode));
        const admitted = validateWorkflowValue(graph.input, input, this.limits.binding.data);
        const existing = delegated ? this.store.getCaller(id, delegated.principal) : this.store.get(id);
        if (delegated && !existing && this.store.exists(id))
            throw new WorkflowRuntimeError('not-found');
        if (existing) {
            if (existing.revision !== graph.source.revision || !isDeepStrictEqual(existing.input, admitted)
                || !isDeepStrictEqual(existing.project, options.project) || !isDeepStrictEqual(existing.release, options.release)
                || !isDeepStrictEqual(existing.test, options.test) || Boolean(existing.startedPaused) !== Boolean(options.paused)
                || existing.triggerMode !== options.triggerMode || existing.caller?.grantId !== delegated?.principal.grantId)
                throw new WorkflowRuntimeError('conflict');
            const run = await this.show(id);
            if (delegated)
                this.callerPrincipal(delegated.token, 'start');
            return run;
        }
        this.active.add(id);
        if (delegated)
            this.creatingCallers.set(id, delegated.principal.grantId);
        let record;
        try {
            if (executionModelPlans(graph).length)
                await admitExecution(graph, this.models);
            // Async admission cannot silently consume a stale review or changed saved-test definition.
            if (options.project) {
                const project = this.project(options.project.id);
                if (project.archived || project.generation !== options.project.generation || project.acceptedRevision !== graph.source.revision)
                    throw new WorkflowRuntimeError('conflict');
            }
            if (options.test) {
                const test = this.testCase(options.test.id);
                if (test.archived)
                    throw new WorkflowRuntimeError('archived');
                if (test.status !== 'accepted' || test.generation !== options.test.generation || test.sha256 !== options.test.sha256)
                    throw new WorkflowRuntimeError('conflict');
            }
            const at = new Date().toISOString();
            record = { schemaVersion: 1, id, revision: graph.source.revision, yaml: graph.source.yaml,
                input: structuredClone(admitted), createdAt: at, updatedAt: at, ...(options.paused ? { startedPaused: true } : {}), ...triggerMetadata(options),
                state: initialCheckpoint(graph), loopDeadlines: {}, ...(options.project ? { project: options.project } : {}), ...(options.release ? { release: options.release } : {}), ...(options.test ? { test: options.test } : {}) };
            if (delegated)
                record = this.store.saveCallerCreation(record, delegated.token);
            else
                this.store.save(record, 'run-created', { revision: record.revision, ...(record.startedPaused ? { startedPaused: true } : {}), ...triggerMetadata(record), ...(record.project ? { project: record.project } : {}), ...(record.release ? { release: record.release } : {}), ...(record.test ? { test: record.test } : {}) });
        }
        finally {
            this.creatingCallers.delete(id);
            this.active.delete(id);
        }
        created?.(record);
        if (options.paused)
            return record;
        return this.execute(record, graph, 'run');
    }
    /** Admit exactly one reviewed control request before dispatch; retry only observes retained state. */
    async advance(id, command, actor) {
        return this.operation(async () => {
            const publicCommand = executionControlSchema.safeParse(command);
            if (!publicCommand.success)
                throw new WorkflowRuntimeError('invalid-command');
            const parsed = savedExecutionControlSchema.safeParse({ ...publicCommand.data, actor, at: new Date().toISOString() });
            if (!z.uuid().safeParse(id).success || !parsed.success)
                throw new WorkflowRuntimeError('invalid-command');
            if (parsed.data.mode === 'pause') {
                const record = this.store.get(id);
                if (!record)
                    throw new WorkflowRuntimeError('not-found');
                this.checked(record);
                const result = admitPause(record, parsed.data);
                if (result.admitted)
                    this.store.save(result.record, 'execution-requested', parsed.data);
                return result.record;
            }
            if (this.active.has(id))
                throw new WorkflowRuntimeError('busy');
            this.active.add(id);
            let record, graph;
            try {
                await this.show(id);
                record = this.store.get(id);
                graph = this.checked(record);
                const saved = record.controlRequests?.find(request => request.requestId === parsed.data.requestId);
                if (saved) {
                    if (!isDeepStrictEqual({ ...saved, at: parsed.data.at }, parsed.data))
                        throw new WorkflowRuntimeError('conflict');
                    return record;
                }
                if (record.cancellation && record.state.status !== 'cancelled')
                    return this.finishCancellation(record);
                if (parsed.data.mode === 'recover') {
                    validateBreakpoints(graph, parsed.data);
                    if (record.cancellation || executionCheckpointHash(record) !== parsed.data.expectedCheckpointSha256)
                        throw new WorkflowRuntimeError('conflict');
                    if ((record.controlRequests?.length ?? 0) >= 10000)
                        throw new WorkflowRuntimeError('limit');
                    const next = await prepareModelRecovery(record, graph, this.limits, this.models);
                    record = this.store.get(id);
                    if (record.cancellation)
                        return this.finishCancellation(record);
                    if (executionCheckpointHash(record) !== parsed.data.expectedCheckpointSha256 || record.state.status !== 'executing')
                        throw new WorkflowRuntimeError('conflict');
                    const request = { ...parsed.data, at: new Date().toISOString() }, prior = record.state;
                    record = { ...record, updatedAt: request.at, controlRequests: [...record.controlRequests ?? [], request] };
                    this.store.save(record, 'execution-requested', request);
                    const segment = this.telemetry?.segment(record, 'resume');
                    segment?.setAttribute('jevable.control.request_id', request.requestId);
                    segment?.setAttribute('jevable.control.mode', 'recover');
                    let settled = false;
                    try {
                        record = this.saveSegment(record, segment, 'resume');
                        record = { ...record, state: next, updatedAt: new Date().toISOString() };
                        this.store.save(record, 'node-result', { attemptId: prior.attempt.id, nodeId: prior.next, scope: prior.scope ?? null,
                            status: next.status, routes: recordedRoutes(next.steps, prior.steps.length) });
                        settled = true;
                        return record;
                    }
                    finally {
                        segment?.setAttribute('jevable.recovery.settled', settled);
                        this.telemetry?.end(segment, settled ? next.status : 'failed-or-uncertain', !settled || next.status === 'failed');
                    }
                }
                if (record.state.status !== 'paused' || record.cancellation || executionCheckpointHash(record) !== parsed.data.expectedCheckpointSha256)
                    throw new WorkflowRuntimeError('conflict');
                if ((record.controlRequests?.length ?? 0) >= 10000)
                    throw new WorkflowRuntimeError('limit');
                validateBreakpoints(graph, parsed.data);
                await this.admitRetained(graph, id);
                record = this.store.get(id);
                if (record.cancellation)
                    return this.finishCancellation(record);
                if (executionCheckpointHash(record) !== parsed.data.expectedCheckpointSha256)
                    throw new WorkflowRuntimeError('conflict');
                record = { ...record, controlRequests: [...record.controlRequests ?? [], parsed.data], updatedAt: parsed.data.at };
                this.store.save(record, 'execution-requested', parsed.data);
            }
            finally {
                this.active.delete(id);
            }
            return this.execute(record, graph, 'resume', undefined, parsed.data.mode === 'step' ? 1 : Infinity, parsed.data);
        });
    }
    /** Resume only a known safe checkpoint; an uncommitted dispatch requires separate operator recovery. */
    async resume(id) {
        return this.operation(async () => {
            if (this.active.has(id))
                throw new WorkflowRuntimeError('busy');
            this.active.add(id);
            let record, graph;
            try {
                record = await this.show(id);
                record = this.store.get(id);
                if (record.state.status === 'cancelled')
                    throw new WorkflowRuntimeError('conflict');
                if (record.cancellation)
                    return this.finishCancellation(record);
                if (record.state.status !== 'paused')
                    throw new WorkflowRuntimeError('conflict');
                graph = this.checked(record);
                await this.admitRetained(graph, id);
                record = this.store.get(id);
                if (record.cancellation)
                    return this.finishCancellation(record);
            }
            finally {
                this.active.delete(id);
            }
            return this.execute(record, graph, 'resume');
        });
    }
    /** Authenticate role and action before loading a grant-derived private target. */
    reviewerPrincipal(token, action) {
        const principal = this.store.grantStore().lookup(token);
        if (!principal || principal.scope.kind !== 'reviewer' || !principal.scope.decisions.includes(action))
            throw new WorkflowRuntimeError('not-found');
        return principal;
    }
    /** Authenticate before reading a private run and again after the awaited read.
     * This is a trusted release-host port, not an owner-visible operation.
     */
    reviewerReleaseWithGrant(token, release) {
        return this.operation(async () => {
            const principal = this.store.grantStore().lookup(token);
            if (!principal || principal.scope.kind !== 'reviewer')
                throw new WorkflowRuntimeError('not-found');
            const run = await this.show(principal.scope.runId);
            const final = this.store.grantStore().lookup(token);
            if (!final || final.grantId !== principal.grantId || !isDeepStrictEqual(final.scope, principal.scope))
                throw new WorkflowRuntimeError('not-found');
            assertReviewerRelease(final, run, release);
            return { principal: final, run };
        });
    }
    /** Experimental SDK reviewer boundary. An identical request observes current state, never resumes it. */
    decideWithGrant(token, value, context) {
        return this.operation(async () => {
            const parsed = reviewerDecisionRequestSchema.safeParse(value);
            if (!parsed.success || context !== undefined && typeof context !== 'function')
                throw new WorkflowRuntimeError('invalid-command');
            const request = parsed.data, principal = this.reviewerPrincipal(token, request.action);
            if (principal.scope.kind !== 'reviewer')
                throw new WorkflowRuntimeError('not-found');
            const id = principal.scope.runId;
            const execute = async () => {
                const record = await this.show(id), final = this.reviewerPrincipal(token, request.action);
                if (final.grantId !== principal.grantId || !isDeepStrictEqual(final.scope, principal.scope))
                    throw new WorkflowRuntimeError('not-found');
                const prior = reviewerRetry(record, this.store.events(id), final, request);
                if (prior)
                    return prior;
                if (this.active.has(id))
                    throw new WorkflowRuntimeError('busy');
                this.active.add(id);
                let settlement, segment;
                try {
                    const graph = this.checked(record);
                    await admitExecution(graph, this.models);
                    settlement = this.store.saveReviewerDecision(token, request, current => this.checked(current), this.limits, current => {
                        segment = this.telemetry?.segment(current, 'approval');
                        const trace = savedRunTrace(segment), parent = this.telemetry?.parent();
                        return trace ? { trace, ...(parent ? { parent } : {}) } : undefined;
                    });
                }
                catch (error) {
                    this.telemetry?.end(segment, 'failed-or-uncertain', true);
                    throw error;
                }
                finally {
                    this.active.delete(id);
                }
                try {
                    if (settlement.record.state.status === 'paused' && !request.pauseAfter) {
                        const result = await this.execute(settlement.record, this.checked(settlement.record), 'approval', segment);
                        return reviewerReceipt(result, settlement.decision);
                    }
                    this.telemetry?.end(segment, settlement.record.state.status, settlement.record.state.status === 'failed');
                    return reviewerReceipt(settlement.record, settlement.decision);
                }
                catch (error) {
                    this.telemetry?.end(segment, 'failed-or-uncertain', true);
                    throw error;
                }
            };
            return context ? context(execute) : execute();
        });
    }
    async decide(id, attemptId, action, actor, options = {}) {
        return this.operation(async () => {
            if (options.pauseAfter !== undefined && typeof options.pauseAfter !== 'boolean'
                || options.expireOnly !== undefined && typeof options.expireOnly !== 'boolean')
                throw new WorkflowRuntimeError('invalid-command');
            const pauseAfter = options.pauseAfter === true;
            if (this.active.has(id))
                throw new WorkflowRuntimeError('busy');
            this.active.add(id);
            let record, graph, segment;
            try {
                record = await this.show(id);
                record = this.store.get(id);
                if (record.state.status === 'cancelled')
                    throw new WorkflowRuntimeError('conflict');
                if (record.cancellation)
                    return this.finishCancellation(record);
                graph = this.checked(record);
                await this.admitRetained(graph, id);
                record = this.store.get(id);
                if (record.cancellation)
                    return this.finishCancellation(record);
                const state = record.state;
                if (state.status !== 'waiting' || state.attempt.id !== attemptId)
                    throw new WorkflowRuntimeError('conflict');
                const node = findNode(graph, state.next, state.scope);
                if (node?.plan.kind !== 'humanApproval' || !node.plan.actions.includes(action))
                    throw new WorkflowRuntimeError('invalid-command');
                const at = new Date().toISOString();
                // An expiry-only UI action must never turn into a timely approval if
                // the clock moves backwards or the observed deadline was stale.
                if (options.expireOnly && Date.parse(at) < Date.parse(state.expiresAt))
                    throw new WorkflowRuntimeError('conflict');
                segment = this.telemetry?.segment(record, 'approval');
                record = this.saveSegment(record, segment, 'approval');
                if (state.scope && Date.parse(at) >= (record.loopDeadlines[state.scope.loop] ?? 0)) {
                    record = { ...record, updatedAt: at, state: { status: 'failed', code: 'loop-timeout', nodeId: state.next, scope: state.scope, steps: state.steps } };
                    this.store.save(record, 'loop-timeout', { scope: state.scope, attemptId, nodeId: state.next });
                    this.telemetry?.end(segment, 'failed', true);
                    return record;
                }
                const decision = approvalDecision.parse(Date.parse(at) >= Date.parse(state.expiresAt)
                    ? { kind: 'expired', at } : { kind: 'action', action, actor, at });
                const next = advanceCheckpoint(graph, record.input, { status: 'paused', next: state.next, steps: state.steps, ...(state.scope ? { scope: state.scope } : {}) }, this.limits.binding.data, undefined, state.attempt, undefined, decision);
                record = { ...record, state: next, updatedAt: at };
                // The approval evidence and continuation commit in one SQLite transaction.
                this.store.save(record, 'approval-decided', { attemptId, nodeId: state.next, decision, ...(state.scope ? { scope: state.scope } : {}), routes: recordedRoutes(next.steps, state.steps.length), ...(pauseAfter ? { pauseAfter: true } : {}) });
            }
            catch (error) {
                this.telemetry?.end(segment, 'failed-or-uncertain', true);
                throw error;
            }
            finally {
                this.active.delete(id);
            }
            if (record.state.status !== 'paused' || pauseAfter) {
                this.telemetry?.end(segment, record.state.status, record.state.status === 'failed');
                return record;
            }
            return this.execute(record, graph, 'approval', segment);
        });
    }
    /** A durable cancellation takes precedence if a concurrent asynchronous admission check fails. */
    async admitRetained(graph, id) {
        try {
            await admitExecution(graph, this.models);
        }
        catch (error) {
            if (!this.store.get(id)?.cancellation)
                throw error;
        }
    }
    saveSegment(record, span, operation) {
        const trace = savedRunTrace(span);
        if (!trace)
            return record;
        if ((record.traceSegments?.length ?? 0) >= 10000)
            throw new WorkflowRuntimeError('limit');
        const previous = record.traceSegments?.at(-1)?.trace;
        const parent = this.telemetry?.parent();
        const cause = operation === 'cancel' ? cancellationTraceCause(record) : undefined;
        const entry = { operation, at: new Date().toISOString(), trace, ...(previous ? { previous } : {}), ...(parent ? { parent } : {}),
            ...(cause ? { cause } : {}) };
        const next = { ...record, traceSegments: [...record.traceSegments ?? [], entry] };
        this.store.save(next, 'execution-segment', entry);
        return next;
    }
    async execute(initial, graph, operation, continuedSpan, budget = Infinity, control) {
        if (this.active.has(initial.id))
            throw new WorkflowRuntimeError('busy');
        this.active.add(initial.id);
        const controller = new AbortController();
        this.controllers.set(initial.id, controller);
        let observed = initial;
        try {
            return await executeWorkflow({ initial, graph, operation, continuedSpan, budget, control,
                limits: this.limits, maxTransitions: this.maxTransitions, models: this.models, telemetry: this.telemetry, signal: controller.signal,
                port: {
                    load: id => {
                        const run = this.store.get(id);
                        if (!run)
                            throw new WorkflowRuntimeError('not-found');
                        observed = run;
                        return run;
                    },
                    events: id => this.store.events(id),
                    save: (record, kind, data) => {
                        if (!isDeepStrictEqual(this.store.get(record.id), observed))
                            throw new WorkflowRuntimeError('conflict');
                        this.store.save(record, kind, data);
                        observed = record;
                    },
                    saveSegment: (record, span, kind) => {
                        if (!isDeepStrictEqual(this.store.get(record.id), observed))
                            throw new WorkflowRuntimeError('conflict');
                        observed = this.saveSegment(record, span, kind);
                        return observed;
                    },
                    finishCancellation: record => this.finishCancellation(record),
                } });
        }
        finally {
            this.controllers.delete(initial.id);
            this.active.delete(initial.id);
        }
    }
    async close() {
        if (this.closing)
            return this.closing;
        if (this.pendingOperations || this.active.size)
            throw new WorkflowRuntimeError('busy');
        // Admission closes synchronously, before any asynchronous telemetry or storage shutdown.
        this.lifecycle = 'closing';
        this.closing = (async () => {
            try {
                await this.automaticNotifications?.drain();
            }
            finally {
                try {
                    await this.telemetry?.close();
                }
                finally {
                    // Telemetry shutdown bounds/aborts its own exports. Join admitted flush callers before releasing credentials/storage.
                    await Promise.allSettled([...this.flushes]);
                    try {
                        await this.store.close();
                    }
                    finally {
                        this.lifecycle = 'closed';
                    }
                }
            }
        })();
        return this.closing;
    }
}

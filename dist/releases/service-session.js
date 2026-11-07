import { z } from 'zod';
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { runReceipt } from "../runtime/receipts.js";
import { executionControlSchema } from "../runtime/control.js";
import { apiTriggerModeSchema, triggerMetadata } from "../runtime/trigger.js";
import { inspectRelease, releaseGraph, releaseRequirements } from "./snapshot.js";
import { CORE_VERSION, PROTOCOL_VERSION, runtimeWorkTelemetryCapability, httpAsyncCapacityTelemetryCapability, httpResponseContextTelemetryCapability, httpAccessTelemetryCapability } from "../capabilities.js";
import { recordPageSchema } from "../http/pagination.js";
import { createApprovalInbox } from "../runtime/approval-inbox.js";
import { approvalNotificationPinSchema, notificationRequestSchema, notificationReceipt } from "../notifications/schema.js";
import { notificationPageRequestSchema } from "../notifications/history.js";
import { reference } from "../providers/config.js";
import { automaticAdmissionPage } from "../notifications/automatic-admission.js";
import { automaticDiagnostic, automaticDiagnosticPage, automaticDiagnosticMatches } from "../notifications/automatic-diagnostics.js";
import { DEFAULT_COMPILER_LIMITS } from "../limits.js";
import { releaseReviewerRequest } from "./reviewer.js";
import { reviewerDecisionsSchema } from "../access/grants.js";
const id = z.uuid();
const commandSchema = z.discriminatedUnion('operation', [
    z.strictObject({ operation: z.literal('release.info') }),
    z.strictObject({ operation: z.literal('release.check'), triggerMode: apiTriggerModeSchema.optional() }),
    z.strictObject({ operation: z.literal('runs.start'), id, input: z.json(), paused: z.boolean().optional(), triggerMode: apiTriggerModeSchema.optional() }),
    z.strictObject({ operation: z.literal('runs.list'), page: recordPageSchema.optional() }),
    z.strictObject({ operation: z.literal('runs.show'), id }),
    z.strictObject({ operation: z.literal('runs.inspect'), id }),
    z.strictObject({ operation: z.literal('runs.events'), id }),
    z.strictObject({ operation: z.literal('runs.export'), id, includePrivate: z.boolean().optional() }),
    z.strictObject({ operation: z.literal('usage.report'), selection: z.unknown() }),
    executionControlSchema.extend({ operation: z.literal('runs.advance'), id }),
    z.strictObject({ operation: z.literal('runs.cancel'), id, requestId: id }),
    z.strictObject({ operation: z.literal('approvals.show'), id }),
    z.strictObject({ operation: z.literal('approvals.list'), page: recordPageSchema }),
    z.strictObject({ operation: z.literal('notifications.destinations') }),
    z.strictObject({ operation: z.literal('notifications.automatic-status') }),
    z.strictObject({ operation: z.literal('notifications.automatic-show'), requestId: id }),
    z.strictObject({ operation: z.literal('notifications.automatic-list'), page: automaticAdmissionPage }),
    z.strictObject({ operation: z.literal('notifications.prepare'), pin: approvalNotificationPinSchema, endpointId: reference }),
    z.strictObject({ operation: z.literal('notifications.send'), request: notificationRequestSchema }),
    z.strictObject({ operation: z.literal('notifications.show'), requestId: id }),
    z.strictObject({ operation: z.literal('notifications.abort'), requestId: id }),
    z.strictObject({ operation: z.literal('notifications.list'), page: notificationPageRequestSchema }),
    z.strictObject({ operation: z.literal('approvals.decide'), id, attemptId: id,
        action: z.string().min(1).max(128), pauseAfter: z.boolean().optional() }),
    z.strictObject({ operation: z.literal('reviewers.issue'), id, tokenSha256: z.string().regex(/^(?!0{64}$)[a-f0-9]{64}$/u),
        runId: id, attemptId: id, expiresAt: z.iso.datetime(), decisions: reviewerDecisionsSchema }),
    z.strictObject({ operation: z.literal('reviewers.show'), id }),
    z.strictObject({ operation: z.literal('reviewers.revoke'), id, requestId: id, expectedGeneration: z.literal(1) }),
]);
/** Source of truth for the exact-release OpenAPI request body. The HTTP layer
 * adds its separate releaseSha256 envelope before this strict union is parsed.
 */
export function releaseOperationJsonSchema() { return z.toJSONSchema(commandSchema, { io: 'input' }); }
/** Admit a notification-only app command before acquiring database ownership.
 * Use the same strict schema as the release service; no caller-supplied release pin or actor.
 */
export function parseReleaseNotificationOperation(value) {
    const parsed = commandSchema.safeParse(value);
    if (!parsed.success || !parsed.data.operation.startsWith('notifications.'))
        throw new WorkflowRuntimeError('invalid-command');
    return parsed.data;
}
/** Exact-release execution adapter. No project, source, provider or credential mutations. */
export class ReleaseSession {
    target;
    actor;
    automaticDelivery;
    reviewerDecisions;
    release;
    pin;
    constructor(target, value, actor, automaticDelivery = false, reviewerDecisions = false) {
        this.target = target;
        this.actor = actor;
        this.automaticDelivery = automaticDelivery;
        this.reviewerDecisions = reviewerDecisions;
        this.release = inspectRelease(value);
        this.pin = Object.freeze({ id: this.release.snapshot.id, sha256: this.release.sha256,
            revision: this.release.snapshot.workflow.revision, version: this.release.snapshot.version,
            runtime: Object.freeze({ ...this.release.snapshot.runtime }) });
    }
    get runtime() { return this.target.runtime; }
    get reviewerPin() { return { id: this.pin.id, sha256: this.pin.sha256, revision: this.pin.revision, version: this.pin.version }; }
    capabilities() {
        // Startup metadata only: capability discovery must never access live runtime state.
        const automaticDelivery = this.automaticDelivery;
        return { schemaVersion: 1, product: 'Jevable workflow runtime', version: CORE_VERSION, protocolVersion: PROTOCOL_VERSION,
            mode: 'release-execution', release: this.pin, storage: `single-owner-${this.target.storage}`,
            evidence: { schemaVersion: this.target.storage === 'postgres' ? 2 : 1, sequenceEncoding: this.target.storage === 'postgres' ? 'decimal-int64' : 'safe-integer' },
            pagination: { operation: 'runs.list', required: this.target.storage === 'postgres', defaultLimit: 100, maxLimit: 200,
                cursor: 'last-returned-release-run-id', consistency: 'live-keyset; not-a-snapshot' },
            operations: commandSchema.options.map(schema => schema.shape.operation.value),
            dependencies: { desktop: false, harness: false, skill: false, docker: false },
            authoring: false, providerConfiguration: false, htmlPreview: false, operatorHtml: true, remoteAccess: false,
            telemetryExport: 'opt-in-otlp-http-protobuf-or-grpc', telemetryProtocols: ['http/protobuf', 'grpc'], telemetrySignals: ['traces', 'metrics', 'logs'],
            runtimeWorkTelemetry: runtimeWorkTelemetryCapability(),
            httpAsyncCapacityTelemetry: httpAsyncCapacityTelemetryCapability(),
            httpResponseContextTelemetry: httpResponseContextTelemetryCapability(),
            httpAccessTelemetry: httpAccessTelemetryCapability(),
            authentication: 'single-owner-bearer for release operations; opt-in separate exact-attempt reviewer bearer',
            reviewerAccess: this.reviewerDecisions ? { enabled: true, requestPage: '/review', scope: 'one-release-one-run-one-attempt',
                actions: 'exact-node-subset', tokenStorage: 'digest-only', ownerTokenShared: false } : false,
            approvalNotifications: { scope: 'exact-release', delivery: automaticDelivery ? 'explicit-and-reviewed-automatic' : 'explicit-only', automaticDelivery,
                eventKinds: ['requested', 'decided', 'expired', 'cancelled'],
                history: 'live-filtered-keyset; matching-release-cursors-only',
                historyFilters: 'outcome; lifecycle-kind; inclusive-created-from-exclusive-created-before; matching-live-cursor',
                configuration: 'startup-only; private-operator-file' },
            execution: 'only-on-explicit-operation; stable-run-and-control-identities; no-automatic-approval' };
    }
    matches(run) {
        return run.revision === this.pin.revision && run.release?.id === this.pin.id && run.release.sha256 === this.pin.sha256;
    }
    async scopedRun(id) {
        const run = await this.runtime.show(id);
        if (!this.matches(run))
            throw new WorkflowRuntimeError('not-found');
        return run;
    }
    /** Delegated browser/API reads use their own bearer and never enter owner operations. */
    async reviewerRequest(token) {
        const { compileLocalRun, findNode } = await import("../runtime/run-evaluator.js");
        const { principal, run } = await this.runtime.reviewerReleaseWithGrant(token, this.reviewerPin);
        if (run.state.status !== 'waiting')
            throw new WorkflowRuntimeError('not-found');
        const node = findNode(compileLocalRun(run.yaml, DEFAULT_COMPILER_LIMITS, run.triggerMode), run.state.next, run.state.scope);
        if (node?.plan.kind !== 'humanApproval')
            throw new WorkflowRuntimeError('not-found');
        return releaseReviewerRequest(principal, run, this.reviewerPin, node.plan.actions);
    }
    async reviewerDecision(token, request, context) {
        // Retained same-ID receipt reads need the original release check even after
        // the wait has settled. The writer still reauthenticates action and grant.
        await this.runtime.reviewerReleaseWithGrant(token, this.reviewerPin);
        return this.runtime.decideWithGrant(token, request, context);
    }
    async operation(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new WorkflowRuntimeError('invalid-command');
        const { releaseSha256, ...body } = value;
        if (typeof releaseSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(releaseSha256))
            throw new WorkflowRuntimeError('invalid-command');
        if (releaseSha256 !== this.pin.sha256)
            throw new WorkflowRuntimeError('conflict');
        const parsed = commandSchema.safeParse(body);
        if (!parsed.success)
            throw new WorkflowRuntimeError('invalid-command');
        const command = parsed.data;
        if (command.operation === 'release.info')
            return { schemaVersion: 1, release: this.pin,
                ...(this.release.snapshot.notes === undefined ? {} : { notes: this.release.snapshot.notes }),
                requirements: releaseRequirements(this.release.snapshot), graph: releaseGraph(this.release.snapshot), execution: 'not-run' };
        if (command.operation === 'release.check')
            return this.runtime.check(this.release.snapshot.workflow.yaml, command.triggerMode);
        if (command.operation === 'notifications.destinations')
            return { schemaVersion: 1, destinations: await this.runtime.notificationDestinations() };
        if (command.operation === 'notifications.automatic-status')
            return this.runtime.automaticApprovalNotificationStatus();
        if (command.operation === 'notifications.automatic-show') {
            const record = await this.runtime.automaticApprovalAdmission(command.requestId);
            if (!automaticDiagnosticMatches(record, this.pin))
                throw new WorkflowRuntimeError('not-found');
            return automaticDiagnostic(record);
        }
        if (command.operation === 'notifications.automatic-list')
            return automaticDiagnosticPage({
                get: id => this.runtime.automaticApprovalAdmission(id), page: page => this.runtime.automaticApprovalAdmissions(page),
            }, command.page, { id: this.pin.id, sha256: this.pin.sha256, revision: this.pin.revision });
        if (command.operation === 'notifications.list')
            return this.runtime.listApprovalNotifications(command.page, { id: this.pin.id, sha256: this.pin.sha256, revision: this.pin.revision });
        if (command.operation === 'notifications.prepare') {
            await this.scopedRun(command.pin.runId);
            return this.runtime.prepareApprovalNotification(command.pin, command.endpointId);
        }
        if (command.operation === 'notifications.show' || command.operation === 'notifications.abort') {
            const receipt = await this.runtime.inspectApprovalNotification(command.requestId);
            await this.scopedRun(receipt.request.runId);
            return command.operation === 'notifications.show' ? receipt : this.runtime.abortApprovalNotification(command.requestId);
        }
        if (command.operation === 'notifications.send') {
            await this.scopedRun(command.request.runId);
            // A caller cannot alias a foreign receipt or predecessor through an otherwise permitted run.
            let existing;
            try {
                existing = await this.runtime.inspectApprovalNotification(command.request.requestId);
            }
            catch (error) {
                if (!(error instanceof WorkflowRuntimeError && error.code === 'not-found'))
                    throw error;
            }
            if (existing)
                await this.scopedRun(existing.request.runId);
            if (command.request.redeliverOf) {
                const previous = await this.runtime.inspectApprovalNotification(command.request.redeliverOf);
                await this.scopedRun(previous.request.runId);
            }
            return notificationReceipt(await this.runtime.sendApprovalNotification(command.request, this.actor));
        }
        if (command.operation === 'approvals.list')
            return { ...await createApprovalInbox({
                    listRuns: async (page) => {
                        if (this.target.storage === 'postgres')
                            return this.target.runtime.listRelease({ id: this.pin.id, sha256: this.pin.sha256, revision: this.pin.revision }, page.after, page.limit);
                        if (page.after !== undefined)
                            await this.scopedRun(page.after);
                        return this.target.runtime.listReleasePage({ id: this.pin.id, sha256: this.pin.sha256, revision: this.pin.revision }, page.after, page.limit);
                    },
                    showRun: id => this.scopedRun(id),
                }, command.page), release: this.pin };
        if (command.operation === 'usage.report') {
            const { createUsageReport } = await import("../evidence/usage.js");
            return createUsageReport({ exportRun: async (id, includePrivate) => {
                    await this.scopedRun(id);
                    return this.runtime.exportRun(id, includePrivate);
                }, exportUsageRun: async (id) => {
                    await this.scopedRun(id);
                    return this.runtime.exportUsageRun(id);
                } }, command.selection);
        }
        if (command.operation === 'runs.list') {
            if (this.target.storage === 'postgres') {
                if (!command.page)
                    throw new WorkflowRuntimeError('invalid-command');
                return { schemaVersion: 2, release: this.pin, ...await this.target.runtime.listRelease({ id: this.pin.id, sha256: this.pin.sha256, revision: this.pin.revision }, command.page.after, command.page.limit) };
            }
            if (!command.page)
                return { schemaVersion: 1, release: this.pin, runs: this.target.runtime.list().filter(run => this.matches(run)) };
            if (command.page.after !== undefined)
                await this.scopedRun(command.page.after);
            return { schemaVersion: 2, release: this.pin, ...this.target.runtime.listReleasePage({ id: this.pin.id, sha256: this.pin.sha256, revision: this.pin.revision }, command.page.after, command.page.limit) };
        }
        if (command.operation === 'runs.start')
            return runReceipt(await this.runtime.runRelease(this.release.snapshot, command.input, { id: command.id, paused: command.paused ?? false, ...triggerMetadata(command) }));
        if (command.operation === 'reviewers.issue') {
            const run = await this.scopedRun(command.runId);
            let existing;
            try {
                existing = await this.runtime.grant(command.id);
            }
            catch (error) {
                if (!(error instanceof WorkflowRuntimeError && error.code === 'not-found'))
                    throw error;
            }
            if (existing) {
                if (existing.scope.kind !== 'reviewer' || existing.scope.runId !== run.id
                    || existing.scope.attemptId !== command.attemptId)
                    throw new WorkflowRuntimeError('conflict');
            }
            else {
                if (run.state.status !== 'waiting' || run.state.attempt.id !== command.attemptId)
                    throw new WorkflowRuntimeError('conflict');
                const { compileLocalRun, findNode } = await import("../runtime/run-evaluator.js");
                const node = findNode(compileLocalRun(run.yaml, DEFAULT_COMPILER_LIMITS, run.triggerMode), run.state.next, run.state.scope);
                if (node?.plan.kind !== 'humanApproval')
                    throw new WorkflowRuntimeError('invalid-command');
                const actions = node.plan.actions;
                if (command.decisions.some(action => !actions.includes(action)))
                    throw new WorkflowRuntimeError('invalid-command');
            }
            return this.runtime.issueGrant({ id: command.id, tokenSha256: command.tokenSha256, expiresAt: command.expiresAt,
                scope: { kind: 'reviewer', runId: run.id, attemptId: command.attemptId, revision: run.revision, decisions: command.decisions }, actor: this.actor });
        }
        if (command.operation === 'reviewers.show' || command.operation === 'reviewers.revoke') {
            const metadata = await this.runtime.grant(command.id);
            if (metadata.scope.kind !== 'reviewer')
                throw new WorkflowRuntimeError('not-found');
            await this.scopedRun(metadata.scope.runId);
            return command.operation === 'reviewers.show' ? metadata : this.runtime.revokeGrant({ id: command.id,
                requestId: command.requestId, expectedGeneration: command.expectedGeneration, actor: this.actor });
        }
        const run = await this.scopedRun(command.id);
        switch (command.operation) {
            case 'runs.show': return runReceipt(run);
            case 'runs.inspect': return { schemaVersion: 1, privateInspection: true, run };
            case 'runs.events': return this.target.storage === 'postgres'
                ? { schemaVersion: 2, runId: run.id, release: run.release, privatePayloads: 'excluded', sequenceEncoding: 'decimal-int64',
                    events: (await this.target.runtime.events(run.id)).map(({ sequence, version, kind, at }) => ({ sequence, version, kind, at })) }
                : { schemaVersion: 1, runId: run.id, release: run.release, privatePayloads: 'excluded',
                    events: (await this.target.runtime.events(run.id)).map(({ sequence, kind, at }) => ({ sequence, kind, at })) };
            case 'runs.export': return this.runtime.exportRun(run.id, command.includePrivate ?? false);
            case 'runs.advance': return runReceipt(await this.runtime.advance(run.id, { requestId: command.requestId,
                expectedCheckpointSha256: command.expectedCheckpointSha256, mode: command.mode,
                ...(command.breakpoints === undefined ? {} : { breakpoints: command.breakpoints }) }, this.actor));
            case 'runs.cancel': return runReceipt(await this.runtime.cancel(run.id, command.requestId, this.actor));
            case 'approvals.show':
                if (run.state.status !== 'waiting')
                    throw new WorkflowRuntimeError('conflict');
                return { ...runReceipt(run), review: run.state.attempt.prepared };
            case 'approvals.decide': return runReceipt(await this.runtime.decide(run.id, command.attemptId, command.action, this.actor, { pauseAfter: command.pauseAfter ?? false }));
        }
    }
}

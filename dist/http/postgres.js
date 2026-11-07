import { PostgresRuntime } from "../runtime/postgres.js";
import { JournalError } from "../storage/postgres.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { capabilities } from "../capabilities.js";
import { dispatchOperation } from "./operations.js";
import { operationCapabilities } from "./operation-host.js";
import { startRuntimeServer } from "./server.js";
import { ReleaseSession } from "../releases/service-session.js";
import { inspectRelease } from "../releases/snapshot.js";
import { z } from 'zod';
import { PreviewSession } from "../preview/session.js";
import { renderPreview } from "../preview/index.js";
import { traceNavigationTools } from "../telemetry/navigation.js";
import { parseNotificationConfig } from "../notifications/config.js";
import { prepareAutomaticStartupRelease } from "../notifications/automatic-startup.js";
import { AsyncRunSession } from "./async-runs.js";
import { ReleaseMessageSession, inspectMessageRelease } from "../releases/messages.js";
import { releaseWebhookConfigSchema } from "../releases/webhooks.js";
import { admitPreviewProjectPin, previewProjectPinSchema } from "../preview/project-pin.js";
function postgresCapabilities(preview = false) {
    const core = capabilities();
    const { cliNodeKinds, ...runtime } = core.workflowRuntime;
    return { ...core, product: 'Jevable workflow runtime', mode: 'management', experimental: true,
        workflowRuntime: { ...runtime, storage: 'postgres', serviceNodeKinds: cliNodeKinds, cliBackendSelection: 'service-and-direct-sdk-jobs',
            projectDelete: 'archived-without-retained-references', projectTransfer: ['json'],
            releasePackaging: false, releaseHttpService: 'explicit-sdk-cli-or-packaged-exact-release', releaseImages: false },
        htmlPreview: false, livePreview: preview ? 'experimental-postgres-project-scoped; browser-unqualified' : false,
        livePreviewTests: preview ? core.livePreviewTests : false,
        livePreviewNotificationHistory: preview ? core.livePreviewNotificationHistory : false,
        livePreviewUsage: preview ? core.livePreviewUsage : false,
        livePreviewExistingProject: preview ? core.livePreviewExistingProject : false,
        livePreviewApiTrigger: preview ? core.livePreviewApiTrigger : false,
        livePreviewInputs: preview ? core.livePreviewInputs : false,
        livePreviewBreakpoints: preview ? core.livePreviewBreakpoints : false,
        livePreviewPause: preview, livePreviewEvidence: preview ? core.livePreviewEvidence : false,
        livePreviewRecovery: preview ? core.livePreviewRecovery : false,
        ownership: 'one-owned-database-session-per-namespace; no-automatic-reconnect',
    };
}
/** Explicit PostgreSQL management, scoped loopback preview or exact-release host. No SQLite fallback. */
export async function startPostgresRuntimeService(value) {
    const keys = new Set(['runtime', 'token', 'actor', 'port', 'maxRequestBytes', 'maxResponseBytes', 'maxConcurrentRequests', 'tls', 'release', 'preview', 'previewAutoConnect', 'reviewerDecisions', 'callerOperations', 'asyncRuns', 'rateLimits', 'coordinatedRateLimits', 'webhooks']);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.has(key))) {
        throw new WorkflowRuntimeError('invalid-command');
    }
    let options;
    // The coordinator is deliberately a trusted callable host port, not serializable configuration.
    // Its own admission captures validated data/function before storage is opened.
    try {
        const { coordinatedRateLimits, ...configuration } = value;
        options = { ...structuredClone(configuration),
            ...(coordinatedRateLimits === undefined ? {} : { coordinatedRateLimits }) };
    }
    catch {
        throw new WorkflowRuntimeError('invalid-command');
    }
    if (options.runtime?.startupRelease !== undefined)
        throw new WorkflowRuntimeError('invalid-command');
    const webhookConfig = options.webhooks === undefined ? undefined : releaseWebhookConfigSchema.safeParse(options.webhooks);
    if (webhookConfig && (!webhookConfig.success || !options.release || options.preview || !options.asyncRuns))
        throw new WorkflowRuntimeError('invalid-command');
    if (options.previewAutoConnect && !options.preview)
        throw new WorkflowRuntimeError('invalid-command');
    if (options.reviewerDecisions && options.preview || options.callerOperations && (options.preview || options.release))
        throw new WorkflowRuntimeError('invalid-command');
    if (options.preview && options.asyncRuns !== undefined)
        throw new WorkflowRuntimeError('invalid-command');
    if (options.runtime?.notifications !== undefined) {
        if (options.preview)
            throw new WorkflowRuntimeError('invalid-command');
        options.runtime.notifications = parseNotificationConfig(options.runtime.notifications);
    }
    let traceViewer;
    if (options.preview !== undefined) {
        const selection = z.strictObject({ source: z.string(), projectId: z.uuid().optional(), projectPin: previewProjectPinSchema.optional(), traceViewer: z.unknown().optional() })
            .refine(p => (p.projectId === undefined) !== (p.projectPin === undefined)).safeParse(options.preview);
        if (options.release !== undefined || options.tls !== undefined || !selection.success)
            throw new WorkflowRuntimeError('invalid-command');
        if (renderPreview(options.preview.source).data.validation.status !== 'valid')
            throw new WorkflowRuntimeError('invalid-command');
        if (options.preview.projectPin)
            admitPreviewProjectPin(options.preview.source, options.preview.projectPin);
        try {
            traceViewer = options.preview.traceViewer === undefined ? undefined : traceNavigationTools().config(options.preview.traceViewer);
        }
        catch {
            throw new WorkflowRuntimeError('invalid-command');
        }
    }
    if (options.release !== undefined && (!options.release || typeof options.release !== 'object' || Array.isArray(options.release)
        || Object.keys(options.release).length !== 1 || !Object.hasOwn(options.release, 'snapshot')))
        throw new WorkflowRuntimeError('invalid-command');
    const snapshot = options.release ? inspectRelease(options.release.snapshot).snapshot : undefined;
    const startupRelease = snapshot && options.runtime.notifications?.automatic
        ? prepareAutomaticStartupRelease(inspectRelease(snapshot), parseNotificationConfig(options.runtime.notifications).automatic) : undefined;
    if (webhookConfig)
        inspectMessageRelease(snapshot);
    return startRuntimeServer(options, async (actor) => {
        const runtime = await PostgresRuntime.open({ ...options.runtime, ...(startupRelease ? { startupRelease } : {}) });
        try {
            const release = snapshot ? new ReleaseSession({ storage: 'postgres', runtime }, snapshot, actor, Boolean(options.runtime.notifications?.automatic), Boolean(options.reviewerDecisions)) : undefined;
            return {
                capabilities: () => release ? release.capabilities() : postgresCapabilities(Boolean(options.preview)),
                ...(release ? { release: { pin: release.pin } } : { operations: operationCapabilities('postgres', Boolean(options.runtime.notifications?.automatic)) }),
                ...(webhookConfig?.success ? { releaseMessages: new ReleaseMessageSession(runtime, snapshot, webhookConfig.data.source) } : {}),
                operation: command => release ? release.operation(command) : dispatchOperation({ storage: 'postgres', runtime }, command, actor),
                ...(!options.preview ? { asyncRuns: new AsyncRunSession(runtime, snapshot) } : {}),
                ...(options.reviewerDecisions ? { reviewerDecision: (token, request, context) => release
                        ? release.reviewerDecision(token, request, context) : runtime.decideWithGrant(token, request, context),
                    ...(release ? { reviewerRequest: (token) => release.reviewerRequest(token) } : {}) } : {}),
                ...(options.callerOperations ? { callerOperation: (token, request, context) => request.operation === 'start'
                        ? runtime.startWithGrant(token, request.input, request.options, context) : request.operation === 'cancel'
                        ? runtime.cancelWithGrant(token, request.id, request.request, context) : request.operation === 'checkpoint'
                        ? runtime.controlCheckpointWithGrant(token, request.id, context) : request.operation === 'control'
                        ? runtime.advanceWithGrant(token, request.id, request.request, context) : runtime.readWithGrant(token, request.id, context) } : {}),
                withTraceParent: (parent, operation) => runtime.withTraceParent(parent, operation),
                withTraceContext: (context, operation) => context.baggage === undefined
                    ? runtime.withTraceParent(context.traceparent, operation) : runtime.withTraceContext(context, operation),
                observeHttpRequest: (method, path) => runtime.observeHttpRequest(method, path),
                observeHttpAccess: stage => runtime.observeHttpAccess(stage),
                observeHttpRateSql: (operation, parent) => runtime.observeHttpRateSql(operation, parent),
                observeHttpAsyncSlot: () => runtime.observeHttpAsyncSlot(),
                observeHttpConnection: transport => runtime.observeHttpConnection(transport),
                observeHttpTransportFailure: (transport, failure) => runtime.observeHttpTransportFailure(transport, failure),
                health: () => runtime.health(), close: () => runtime.close(),
                telemetryResource: () => { const status = runtime.telemetryStatus(); return 'resource' in status ? status.resource : undefined; },
                ...(options.preview ? { preparePreview: () => {
                        const preview = options.preview, operations = { call: (command) => dispatchOperation({ storage: 'postgres', runtime }, command, actor) };
                        return preview.projectPin ? PreviewSession.attach(operations, preview.source, preview.projectPin, undefined, traceViewer)
                            : PreviewSession.create(operations, preview.source, preview.projectId, undefined, traceViewer);
                    } } : {}),
                failure: error => error instanceof JournalError ? { code: error.code, status: {
                        'invalid-config': 400, 'invalid-command': 400, busy: 409, uninitialized: 503, 'version-mismatch': 503,
                        conflict: 409, limit: 413, corrupt: 500, unavailable: 503, 'ownership-lost': 503, 'commit-uncertain': 503, closed: 503,
                    }[error.code] } : undefined,
            };
        }
        catch (error) {
            await runtime.close();
            throw error;
        }
    });
}

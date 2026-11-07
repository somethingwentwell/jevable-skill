import { LocalRuntime } from "../runtime/local.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { capabilities } from "../capabilities.js";
import { dispatchOperation } from "./operations.js";
import { operationCapabilities } from "./operation-host.js";
import { startRuntimeServer } from "./server.js";
import { PreviewSession } from "../preview/session.js";
import { ReleaseSession } from "../releases/service-session.js";
import { inspectRelease } from "../releases/snapshot.js";
import { traceNavigationTools } from "../telemetry/navigation.js";
import { parseNotificationConfig } from "../notifications/config.js";
import { prepareAutomaticStartupRelease } from "../notifications/automatic-startup.js";
import { AsyncRunSession } from "./async-runs.js";
import { ReleaseMessageSession, inspectMessageRelease } from "../releases/messages.js";
import { releaseWebhookConfigSchema } from "../releases/webhooks.js";
import { admitPreviewProjectPin } from "../preview/project-pin.js";
/** SQLite host, including separately scoped local preview and exact-release execution modes. */
export async function startRuntimeService(options) {
    // This service derives any bootstrap solely from its exact-release option.
    if (options.runtime.startupRelease !== undefined)
        throw new WorkflowRuntimeError('invalid-command');
    const webhookConfig = options.webhooks === undefined ? undefined : releaseWebhookConfigSchema.safeParse(options.webhooks);
    if (webhookConfig && (!webhookConfig.success || !options.release || options.preview || !options.asyncRuns))
        throw new WorkflowRuntimeError('invalid-command');
    if (options.previewAutoConnect && !options.preview)
        throw new WorkflowRuntimeError('invalid-command');
    if (options.reviewerDecisions && options.preview || options.callerOperations && (options.preview || options.release))
        throw new WorkflowRuntimeError('invalid-command');
    if (options.preview && (options.release || options.tls))
        throw new WorkflowRuntimeError('invalid-command');
    if (options.preview && options.asyncRuns !== undefined)
        throw new WorkflowRuntimeError('invalid-command');
    if (options.preview && options.runtime.notifications !== undefined)
        throw new WorkflowRuntimeError('invalid-command');
    const runtimeOptions = { ...options.runtime, ...(options.runtime.notifications === undefined ? {}
            : { notifications: parseNotificationConfig(options.runtime.notifications) }) };
    // Pin an owned clone before any asynchronous startup; callers cannot retarget a release later.
    const releaseSnapshot = options.release ? inspectRelease(options.release.snapshot).snapshot : undefined;
    const startupRelease = releaseSnapshot && runtimeOptions.notifications?.automatic
        ? prepareAutomaticStartupRelease(inspectRelease(releaseSnapshot), parseNotificationConfig(runtimeOptions.notifications).automatic) : undefined;
    if (webhookConfig)
        inspectMessageRelease(releaseSnapshot);
    const previewSource = options.preview?.source;
    const previewProjectPin = options.preview?.projectPin === undefined ? undefined
        : admitPreviewProjectPin(options.preview.source, options.preview.projectPin, options.runtime.compilerLimits);
    let traceViewer;
    try {
        traceViewer = options.preview?.traceViewer === undefined ? undefined : traceNavigationTools().config(options.preview.traceViewer);
    }
    catch {
        throw new WorkflowRuntimeError('invalid-command');
    }
    return startRuntimeServer({ ...options, ...(webhookConfig?.success ? { webhooks: webhookConfig.data } : {}) }, async (actor) => {
        const runtime = await LocalRuntime.open({ ...runtimeOptions, ...(startupRelease ? { startupRelease } : {}) });
        try {
            const release = releaseSnapshot ? new ReleaseSession({ storage: 'sqlite', runtime }, releaseSnapshot, actor, Boolean(runtimeOptions.notifications?.automatic), Boolean(options.reviewerDecisions)) : undefined;
            return {
                capabilities: () => {
                    if (release)
                        return release.capabilities();
                    const core = capabilities();
                    return { ...core, livePreviewNotificationHistory: previewSource === undefined ? false : core.livePreviewNotificationHistory,
                        livePreviewUsage: previewSource === undefined ? false : core.livePreviewUsage };
                },
                ...(release ? { release: { pin: release.pin } } : { operations: operationCapabilities('sqlite', Boolean(runtimeOptions.notifications?.automatic)) }),
                ...(webhookConfig?.success ? { releaseMessages: new ReleaseMessageSession(runtime, releaseSnapshot, webhookConfig.data.source) } : {}),
                operation: (value) => release ? release.operation(value) : dispatchOperation({ storage: 'sqlite', runtime }, value, actor),
                ...(previewSource === undefined ? { asyncRuns: new AsyncRunSession(runtime, releaseSnapshot) } : {}),
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
                health: async () => ({ storage: 'sqlite', telemetry: runtime.telemetryStatus() }),
                telemetryResource: () => { const status = runtime.telemetryStatus(); return 'resource' in status ? status.resource : undefined; },
                close: () => runtime.close(),
                ...(previewSource !== undefined ? { preparePreview: () => {
                        const operations = { call: (command) => dispatchOperation({ storage: 'sqlite', runtime }, command, actor) };
                        return previewProjectPin ? PreviewSession.attach(operations, previewSource, previewProjectPin, options.runtime.compilerLimits, traceViewer)
                            : PreviewSession.create(operations, previewSource, undefined, options.runtime.compilerLimits, traceViewer);
                    } } : {}),
            };
        }
        catch (error) {
            await runtime.close();
            throw error;
        }
    });
}

import { LocalRuntime, type LocalRuntimeOptions } from '../runtime/local.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { capabilities } from '../capabilities.ts'
import { dispatchOperation } from './operations.ts'
import { operationCapabilities } from './operation-host.ts'
import { startRuntimeServer, type RuntimeServerOptions } from './server.ts'
import { PreviewSession } from '../preview/session.ts'
import { ReleaseSession } from '../releases/service-session.ts'
import { inspectRelease } from '../releases/snapshot.ts'
import { traceNavigationTools, type TraceViewerConfig } from '../telemetry/navigation.ts'
import { parseNotificationConfig } from '../notifications/config.ts'
import { prepareAutomaticStartupRelease } from '../notifications/automatic-startup.ts'
import { AsyncRunSession } from './async-runs.ts'
import { ReleaseMessageSession, inspectMessageRelease } from '../releases/messages.ts'
import { releaseWebhookConfigSchema } from '../releases/webhooks.ts'
import { admitPreviewProjectPin, type PreviewProjectPin } from '../preview/project-pin.ts'

export interface RuntimeServiceOptions extends RuntimeServerOptions {
  runtime: LocalRuntimeOptions
  preview?: { source: string; projectPin?: PreviewProjectPin; traceViewer?: TraceViewerConfig }
  release?: { snapshot: unknown }
}

/** SQLite host, including separately scoped local preview and exact-release execution modes. */
export async function startRuntimeService(options: RuntimeServiceOptions) {
  // This service derives any bootstrap solely from its exact-release option.
  if (options.runtime.startupRelease !== undefined) throw new WorkflowRuntimeError('invalid-command')
  const webhookConfig = options.webhooks === undefined ? undefined : releaseWebhookConfigSchema.safeParse(options.webhooks)
  if (webhookConfig && (!webhookConfig.success || !options.release || options.preview || !options.asyncRuns)) throw new WorkflowRuntimeError('invalid-command')
  if (options.previewAutoConnect && !options.preview) throw new WorkflowRuntimeError('invalid-command')
  if (options.reviewerDecisions && options.preview || options.callerOperations && (options.preview || options.release)) throw new WorkflowRuntimeError('invalid-command')
  if (options.preview && (options.release || options.tls)) throw new WorkflowRuntimeError('invalid-command')
  if (options.preview && options.asyncRuns !== undefined) throw new WorkflowRuntimeError('invalid-command')
  if (options.preview && options.runtime.notifications !== undefined) throw new WorkflowRuntimeError('invalid-command')
  const runtimeOptions = { ...options.runtime, ...(options.runtime.notifications === undefined ? {}
    : { notifications: parseNotificationConfig(options.runtime.notifications) }) }
  // Pin an owned clone before any asynchronous startup; callers cannot retarget a release later.
  const releaseSnapshot = options.release ? inspectRelease(options.release.snapshot).snapshot : undefined
  const startupRelease = releaseSnapshot && runtimeOptions.notifications?.automatic
    ? prepareAutomaticStartupRelease(inspectRelease(releaseSnapshot), parseNotificationConfig(runtimeOptions.notifications).automatic) : undefined
  if (webhookConfig) inspectMessageRelease(releaseSnapshot)
  const previewSource = options.preview?.source
  const previewProjectPin = options.preview?.projectPin === undefined ? undefined
    : admitPreviewProjectPin(options.preview.source, options.preview.projectPin, options.runtime.compilerLimits)
  let traceViewer: TraceViewerConfig | undefined
  try { traceViewer = options.preview?.traceViewer === undefined ? undefined : traceNavigationTools().config(options.preview.traceViewer) }
  catch { throw new WorkflowRuntimeError('invalid-command') }
  return startRuntimeServer({ ...options, ...(webhookConfig?.success ? { webhooks: webhookConfig.data } : {}) }, async actor => {
    const runtime = await LocalRuntime.open({ ...runtimeOptions, ...(startupRelease ? { startupRelease } : {}) })
    try {
      const release = releaseSnapshot ? new ReleaseSession({ storage: 'sqlite', runtime }, releaseSnapshot, actor,
        Boolean(runtimeOptions.notifications?.automatic), Boolean(options.reviewerDecisions)) : undefined
      return {
        capabilities: () => {
          if (release) return release.capabilities()
          const core = capabilities()
          return { ...core, livePreviewNotificationHistory: previewSource === undefined ? false : core.livePreviewNotificationHistory,
            livePreviewUsage: previewSource === undefined ? false : core.livePreviewUsage }
        },
        ...(release ? { release: { pin: release.pin } } : { operations: operationCapabilities('sqlite', Boolean(runtimeOptions.notifications?.automatic)) }),
        ...(webhookConfig?.success ? { releaseMessages: new ReleaseMessageSession(runtime, releaseSnapshot, webhookConfig.data.source) } : {}),
        operation: (value: unknown) => release ? release.operation(value) : dispatchOperation({ storage: 'sqlite', runtime }, value, actor),
        ...(previewSource === undefined ? { asyncRuns: new AsyncRunSession(runtime, releaseSnapshot) } : {}),
        ...(options.reviewerDecisions ? { reviewerDecision: (token, request, context) => release
          ? release.reviewerDecision(token, request, context) : runtime.decideWithGrant(token, request, context),
          ...(release ? { reviewerRequest: (token: string) => release.reviewerRequest(token) } : {}) } : {}),
        ...(options.callerOperations ? { callerOperation: (token, request, context) => request.operation === 'start'
          ? runtime.startWithGrant(token, request.input, request.options, context) : request.operation === 'cancel'
            ? runtime.cancelWithGrant(token, request.id, request.request, context) : request.operation === 'checkpoint'
              ? runtime.controlCheckpointWithGrant(token, request.id, context) : request.operation === 'control'
                ? runtime.advanceWithGrant(token, request.id, request.request, context) : runtime.readWithGrant(token, request.id, context) } : {}),
        withTraceParent: <T>(parent: string | undefined, operation: () => T) => runtime.withTraceParent(parent, operation),
        withTraceContext: (context, operation) => context.baggage === undefined
          ? runtime.withTraceParent(context.traceparent, operation) : runtime.withTraceContext(context, operation),
        observeHttpRequest: (method, path) => runtime.observeHttpRequest(method, path),
        observeHttpAccess: stage => runtime.observeHttpAccess(stage),
        observeHttpRateSql: (operation, parent) => runtime.observeHttpRateSql(operation, parent),
        observeHttpAsyncSlot: () => runtime.observeHttpAsyncSlot(),
        observeHttpConnection: transport => runtime.observeHttpConnection(transport),
        observeHttpTransportFailure: (transport, failure) => runtime.observeHttpTransportFailure(transport, failure),
        health: async () => ({ storage: 'sqlite', telemetry: runtime.telemetryStatus() }),
        telemetryResource: () => { const status = runtime.telemetryStatus(); return 'resource' in status ? status.resource : undefined },
        close: () => runtime.close(),
        ...(previewSource !== undefined ? { preparePreview: () => {
          const operations = { call: (command: Parameters<typeof dispatchOperation>[1]) => dispatchOperation({ storage: 'sqlite', runtime }, command, actor) }
          return previewProjectPin ? PreviewSession.attach(operations, previewSource, previewProjectPin, options.runtime.compilerLimits, traceViewer)
            : PreviewSession.create(operations, previewSource, undefined, options.runtime.compilerLimits, traceViewer)
        } } : {}),
      }
    } catch (error) { await runtime.close(); throw error }
  })
}

import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import { PreviewSession } from '../preview/session.ts'
import { renderPreview } from '../preview/index.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { parseTraceParent } from '../telemetry/config.ts'
import { PROTOCOL_VERSION } from '../capabilities.ts'
import { RuntimeHttpError } from './client.ts'
import { startRuntimeServer, type RuntimeServerOptions } from './server.ts'
import type { RuntimeOperation } from './operations.ts'
import { traceNavigationTools, type TraceViewerConfig } from '../telemetry/navigation.ts'
import { admitPreviewProjectPin, type PreviewProjectPin } from '../preview/project-pin.ts'

export interface PreviewGatewayOptions extends Omit<RuntimeServerOptions, 'tls' | 'actor'> {
  source: string
  /** A caller-retained, fresh UUID. Startup may commit this project even if its response is lost. */
  projectId: string
  /** Optional explicit read-only attachment. Must identify this same projectId. */
  projectPin?: PreviewProjectPin
  traceViewer?: TraceViewerConfig
}
export interface PreviewGatewayOwner {
  /** Supply an authenticated, instance-pinned owner. This gateway never discovers or starts one. */
  call(command: RuntimeOperation, traceParent?: string): Promise<unknown>
}

/** Foreground loopback HTML gateway. Closing it never closes or cancels the remote runtime. */
export async function startPreviewGateway(options: PreviewGatewayOptions, owner: PreviewGatewayOwner) {
  if (!z.uuid().safeParse(options.projectId).success || Object.keys(options).some(key =>
    !['source', 'projectId', 'projectPin', 'token', 'port', 'maxRequestBytes', 'maxResponseBytes', 'maxConcurrentRequests', 'traceViewer', 'rateLimits', 'coordinatedRateLimits'].includes(key))) {
    throw new WorkflowRuntimeError('invalid-command')
  }
  if (renderPreview(options.source).data.validation.status !== 'valid') throw new WorkflowRuntimeError('invalid-command')
  // Clone startup inputs before an asynchronous bind; SDK callers cannot retarget a pending session.
  const { source, projectId, projectPin: suppliedPin, traceViewer: suppliedViewer, ...serverOptions } = options
  const projectPin = suppliedPin === undefined ? undefined : admitPreviewProjectPin(source, suppliedPin)
  if (projectPin && projectPin.id !== projectId) throw new WorkflowRuntimeError('invalid-command')
  let traceViewer: TraceViewerConfig | undefined
  try { traceViewer = suppliedViewer === undefined ? undefined : traceNavigationTools().config(suppliedViewer) }
  catch { throw new WorkflowRuntimeError('invalid-command') }
  const parents = new AsyncLocalStorage<string | undefined>()
  return startRuntimeServer({ ...serverOptions, actor: 'preview-gateway' }, async () => ({
    capabilities: () => ({ schemaVersion: 1, product: 'Jevable preview gateway', protocolVersion: PROTOCOL_VERSION,
      management: false, execution: 'selected-owner-only', storage: 'none', dependencies: { desktop: false, harness: false },
      previewProjectSelection: projectPin ? 'attached-existing-reviewed-project' : 'created-fresh-project',
      visualReview: 'not-performed' }),
    withTraceParent: <T>(parent: string | undefined, operation: () => T) => {
      parseTraceParent(parent)
      return parents.run(parent, operation)
    },
    preparePreview: () => {
      const operations = { call: (command: RuntimeOperation) => owner.call(command, parents.getStore()) }
      return projectPin ? PreviewSession.attach(operations, source, projectPin, undefined, traceViewer)
        : PreviewSession.create(operations, source, projectId, undefined, traceViewer)
    },
    failure: error => error instanceof RuntimeHttpError ? {
      status: error.status && [400, 401, 403, 404, 409, 413, 422, 429, 503].includes(error.status) ? error.status : 502,
      code: /^[a-z][a-z0-9-]{0,63}$/u.test(error.code) ? error.code : 'upstream-failed',
    } : undefined,
    async close() { /* Only the HTTP gateway is owned here; no backend stop/cancel or local storage. */ },
  }))
}

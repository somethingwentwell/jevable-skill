import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { PreviewSession } from "../preview/session.js";
import { renderPreview } from "../preview/index.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { parseTraceParent } from "../telemetry/config.js";
import { PROTOCOL_VERSION } from "../capabilities.js";
import { RuntimeHttpError } from "./client.js";
import { startRuntimeServer } from "./server.js";
import { traceNavigationTools } from "../telemetry/navigation.js";
import { admitPreviewProjectPin } from "../preview/project-pin.js";
/** Foreground loopback HTML gateway. Closing it never closes or cancels the remote runtime. */
export async function startPreviewGateway(options, owner) {
    if (!z.uuid().safeParse(options.projectId).success || Object.keys(options).some(key => !['source', 'projectId', 'projectPin', 'token', 'port', 'maxRequestBytes', 'maxResponseBytes', 'maxConcurrentRequests', 'traceViewer', 'rateLimits', 'coordinatedRateLimits'].includes(key))) {
        throw new WorkflowRuntimeError('invalid-command');
    }
    if (renderPreview(options.source).data.validation.status !== 'valid')
        throw new WorkflowRuntimeError('invalid-command');
    // Clone startup inputs before an asynchronous bind; SDK callers cannot retarget a pending session.
    const { source, projectId, projectPin: suppliedPin, traceViewer: suppliedViewer, ...serverOptions } = options;
    const projectPin = suppliedPin === undefined ? undefined : admitPreviewProjectPin(source, suppliedPin);
    if (projectPin && projectPin.id !== projectId)
        throw new WorkflowRuntimeError('invalid-command');
    let traceViewer;
    try {
        traceViewer = suppliedViewer === undefined ? undefined : traceNavigationTools().config(suppliedViewer);
    }
    catch {
        throw new WorkflowRuntimeError('invalid-command');
    }
    const parents = new AsyncLocalStorage();
    return startRuntimeServer({ ...serverOptions, actor: 'preview-gateway' }, async () => ({
        capabilities: () => ({ schemaVersion: 1, product: 'Jevable preview gateway', protocolVersion: PROTOCOL_VERSION,
            management: false, execution: 'selected-owner-only', storage: 'none', dependencies: { desktop: false, harness: false },
            previewProjectSelection: projectPin ? 'attached-existing-reviewed-project' : 'created-fresh-project',
            visualReview: 'not-performed' }),
        withTraceParent: (parent, operation) => {
            parseTraceParent(parent);
            return parents.run(parent, operation);
        },
        preparePreview: () => {
            const operations = { call: (command) => owner.call(command, parents.getStore()) };
            return projectPin ? PreviewSession.attach(operations, source, projectPin, undefined, traceViewer)
                : PreviewSession.create(operations, source, projectId, undefined, traceViewer);
        },
        failure: error => error instanceof RuntimeHttpError ? {
            status: error.status && [400, 401, 403, 404, 409, 413, 422, 429, 503].includes(error.status) ? error.status : 502,
            code: /^[a-z][a-z0-9-]{0,63}$/u.test(error.code) ? error.code : 'upstream-failed',
        } : undefined,
        async close() { },
    }));
}

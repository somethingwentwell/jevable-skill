import { userInfo } from 'node:os';
import { z } from 'zod';
import { readSecretFile } from "../providers/secret-input.js";
import { localRuntimeOptions } from "../telemetry/options.js";
import { startRuntimeService } from "../http/service.js";
import { startPreviewGateway } from "../http/preview-gateway.js";
import { CliStorageUsageError, storageSelection, postgresRuntimeOptions } from "./runtime.js";
import { openCliOperations, operationFlags, operationSelection } from "./operations.js";
import { readTraceViewerFile } from "./trace-viewer.js";
import { readPreviewProjectPin } from "./preview-project.js";
/** Portable HTML is offline; reject every supplied runtime option before reading workflow source. */
export function portablePreviewSelection(values) {
    if ([...operationFlags, 'port', 'data-dir', 'storage', 'database-file', 'telemetry-file', 'preview-token-file', 'project-id', 'project-pin-file', 'project-pin-sha256', 'trace-viewer-file', 'token-env', 'auto-connect']
        .some(key => values[key] !== undefined))
        throw new CliStorageUsageError('Runtime options require --serve. Portable HTML stays offline.');
}
/** I/O-free admission shared with the dispatcher, before workflow/trace-viewer/config reads. */
export function previewSelection(values) {
    if (values['trace-context-file'] !== undefined)
        throw new CliStorageUsageError('Trace context files are per-operation only, not preview startup configuration.');
    const port = values.port === undefined ? 0 : typeof values.port === 'string' && /^(0|[1-9][0-9]*)$/u.test(values.port) ? Number(values.port) : NaN;
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
        throw new CliStorageUsageError('Port must be between 0 and 65535.');
    const file = typeof values['token-file'] === 'string', env = typeof values['token-env'] === 'string';
    if (file === env)
        throw new CliStorageUsageError('Provide exactly one of --token-file or --token-env; never put a credential in a URL.');
    if (env && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(values['token-env']))
        throw new CliStorageUsageError('--token-env requires a valid environment variable name, not a token value.');
    const attachment = values['project-pin-file'] !== undefined || values['project-pin-sha256'] !== undefined;
    if (attachment && (typeof values['project-pin-file'] !== 'string' || !values['project-pin-file']
        || typeof values['project-pin-sha256'] !== 'string' || !/^[a-f0-9]{64}$/u.test(values['project-pin-sha256'])
        || values['project-id'] !== undefined))
        throw new CliStorageUsageError('Existing-project preview requires both --project-pin-file and its reviewed --project-pin-sha256, without --project-id.');
    if (values.runtime === 'docker' || values.endpoint !== undefined) {
        if (env || values['auto-connect'] !== undefined)
            throw new CliStorageUsageError('--token-env and --auto-connect are for a direct local preview only, not a selected Docker or remote owner.');
        const selection = operationSelection(values);
        if (typeof values['preview-token-file'] !== 'string' || (!attachment && !z.uuid().safeParse(values['project-id']).success)) {
            throw new CliStorageUsageError('Selected-owner preview requires a separate --preview-token-file and either a retained fresh --project-id UUID or a reviewed existing-project pin.');
        }
        return { selection, port };
    }
    if (values.runtime !== undefined && values.runtime !== 'local')
        throw new CliStorageUsageError('Select --runtime local or docker; no fallback is available.');
    if ([...operationFlags.filter(key => !['runtime', 'token-file'].includes(key)), 'preview-token-file']
        .some(key => values[key] !== undefined))
        throw new CliStorageUsageError('Docker owner/preview options require --runtime docker.');
    const storage = storageSelection(values);
    if (storage === 'postgres') {
        if (!attachment && !z.uuid().safeParse(values['project-id']).success)
            throw new CliStorageUsageError('PostgreSQL preview requires a retained fresh --project-id UUID or a reviewed existing-project pin; inspect it after uncertain startup.');
    }
    else if (values['project-id'] !== undefined)
        throw new CliStorageUsageError('--project-id requires PostgreSQL or Docker preview.');
    return { selection: storage, port };
}
/** Explicit target selection. A Docker preview holds no direct SDK owner or host database. */
export async function startPreviewFromCli(source, values, observation = {}) {
    const { selection, port } = previewSelection(values);
    const projectPin = await readPreviewProjectPin(source, values);
    // The shared selector admitted these string paths; no credential contents have been read.
    const tokenFile = values['token-file'];
    const tokenEnv = values['token-env'];
    // Explicit selection only. Never log, embed, persist or discover environment credentials.
    const localToken = tokenEnv === undefined ? undefined : process.env[tokenEnv];
    if (tokenEnv !== undefined && (typeof localToken !== 'string' || !/^[a-f0-9]{64}$/u.test(localToken))) {
        throw new CliStorageUsageError('The selected token environment variable must contain exactly 64 lowercase hexadecimal characters.');
    }
    const previewAutoConnect = values['auto-connect'] === true;
    const traceViewer = await readTraceViewerFile(values['trace-viewer-file']);
    if (selection === 'docker' || selection === 'remote') {
        const token = await readSecretFile(values['preview-token-file']);
        const ownerToken = await readSecretFile(tokenFile);
        if (!/^[a-f0-9]{64}$/u.test(token) || token === ownerToken) {
            throw new CliStorageUsageError('Create a distinct preview token with runtime token; never paste the management token into the page.');
        }
        const owner = await openCliOperations(values, observation);
        return startPreviewGateway({ source, projectId: projectPin?.id ?? values['project-id'],
            ...(projectPin ? { projectPin } : {}), token, port, ...(traceViewer ? { traceViewer } : {}) }, owner);
    }
    if (selection === 'postgres') {
        const { startPostgresRuntimeService } = await import("../http/postgres.js");
        return startPostgresRuntimeService({ runtime: await postgresRuntimeOptions(values), token: localToken ?? await readSecretFile(tokenFile), previewAutoConnect,
            actor: `local:${userInfo().username}`, port, preview: { source, ...(projectPin ? { projectPin } : { projectId: values['project-id'] }), ...(traceViewer ? { traceViewer } : {}) } });
    }
    return startRuntimeService({ runtime: await localRuntimeOptions(values), token: localToken ?? await readSecretFile(tokenFile), previewAutoConnect,
        actor: `local:${userInfo().username}`, port, preview: { source, ...(projectPin ? { projectPin } : {}), ...(traceViewer ? { traceViewer } : {}) } });
}

import { z } from 'zod';
import { userInfo } from 'node:os';
import { RuntimeClient, RuntimeHttpError } from "../http/client.js";
import { dispatchOperation } from "../http/operations.js";
import { readSecretFile } from "../providers/secret-input.js";
import { readTlsPemFile } from "../http/tls.js";
import { readDockerOwner, inspectDockerOwner } from "../docker/index.js";
import { CliStorageUsageError, openCliRuntime, storageSelection } from "./runtime.js";
import { inspectRelease } from "../releases/snapshot.js";
import { connectRemoteOperations, remoteSelection } from "./remote.js";
import { readCliTraceContext } from "./trace-context.js";
export const operationFlags = ['runtime', 'owner-file', 'owner-sha256', 'container-id', 'token-file', 'ca-file', 'timeout-ms', 'endpoint', 'instance-id', 'trace-context-file'];
const remoteOnly = operationFlags.filter(name => name !== 'runtime' && name !== 'trace-context-file');
/** Validate the target before reading credentials or opening any storage. */
export function operationSelection(values) {
    const timeout = values['timeout-ms'];
    if (timeout !== undefined && (typeof timeout !== 'string' || !/^[1-9][0-9]*$/u.test(timeout) || Number(timeout) > 3600000))
        throw new CliStorageUsageError('Timeout must be 1–3600000 milliseconds.');
    if (values.endpoint !== undefined) {
        remoteSelection(values);
        return 'remote';
    }
    if (values['instance-id'] !== undefined)
        throw new CliStorageUsageError('--instance-id requires an explicit --endpoint.');
    if (values.runtime !== undefined && values.runtime !== 'local' && values.runtime !== 'docker')
        throw new CliStorageUsageError('Select --runtime local or docker; no fallback is available.');
    if (values.runtime !== 'docker') {
        if (remoteOnly.some(key => values[key] !== undefined))
            throw new CliStorageUsageError('Owner/service options require --runtime docker.');
        storageSelection(values);
        return 'local';
    }
    if (['data-dir', 'database-file', 'storage', 'telemetry-file', 'notifications-file', 'endpoint'].some(key => values[key] !== undefined))
        throw new CliStorageUsageError('Docker commands use their selected service owner, never local storage or an overriding endpoint.');
    for (const key of ['owner-file', 'owner-sha256', 'container-id', 'token-file'])
        if (typeof values[key] !== 'string' || !values[key])
            throw new CliStorageUsageError(`Docker commands require --${key}.`);
    for (const key of ['owner-sha256', 'container-id'])
        if (!/^[a-f0-9]{64}$/u.test(values[key]))
            throw new CliStorageUsageError(`Provide the full reviewed --${key}.`);
    return 'docker';
}
/** Injectable read-only owner observation for tests; production always uses the selected local Docker engine. */
export async function openCliOperations(values, observation = {}) {
    const selection = operationSelection(values);
    const configuredContext = await readCliTraceContext(values['trace-context-file']);
    if (selection === 'local') {
        const owner = await openCliRuntime(values), actor = `local:${userInfo().username}`;
        return { storage: owner.storage, call: (command, context = configuredContext) => context === undefined || typeof context === 'string'
                ? owner.runtime.withTraceParent(context, () => dispatchOperation(owner, command, actor))
                : owner.runtime.withTraceContext(context, () => dispatchOperation(owner, command, actor)), close: () => owner.runtime.close() };
    }
    if (selection === 'remote') {
        const connected = await connectRemoteOperations(values);
        return selectedOperations(connected.storage, connected.instanceId, connected.client, configuredContext);
    }
    const owner = await readDockerOwner(values['owner-file'], values['owner-sha256']);
    const observed = await inspectDockerOwner(owner, { tokenFile: values['token-file'],
        ...(values['ca-file'] === undefined ? {} : { caFile: values['ca-file'] }) }, observation);
    if (observed.containerId !== values['container-id'] || observed.status !== 'running' || observed.service.status !== 'ready'
        || !('instanceId' in observed.service))
        throw new RuntimeHttpError('owner-not-ready');
    const instanceId = observed.service.instanceId;
    const token = await readSecretFile(values['token-file']), ca = values['ca-file'] === undefined ? undefined : await readTlsPemFile(values['ca-file']);
    const client = new RuntimeClient(observed.resources.endpoint, token, Number(values['timeout-ms'] ?? 30000), 20_000_000, { expectedInstanceId: instanceId, ...(ca === undefined ? {} : { ca }) });
    const caps = z.object({ instanceId: z.literal(instanceId), api: z.object({ instanceGuard: z.literal('x-jevable-instance') }) }).safeParse(await client.capabilities());
    if (!caps.success)
        throw new RuntimeHttpError('incompatible-owner');
    return selectedOperations(owner.storage, instanceId, client, configuredContext);
}
function selectedOperations(storage, instanceId, client, configuredContext) {
    return { storage, async call(command, parent = configuredContext) {
            if (storage === 'postgres' && ['runs.list', 'tests.list', 'tests.generations', 'projects.deletions', 'providers.audit', 'releases.list'].includes(command.operation)
                && (!('page' in command) || !command.page))
                throw new CliStorageUsageError('PostgreSQL list commands require --page; follow the returned cursor.');
            const response = z.object({ schemaVersion: z.literal(1), instanceId: z.literal(instanceId), result: z.unknown() }).safeParse(await client.operation(command, parent));
            if (!response.success || !Object.hasOwn(response.data, 'result'))
                throw new RuntimeHttpError('invalid-response');
            return response.data.result;
        }, async close() { } };
}
export function operationResult(schema, value) {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
        throw new RuntimeHttpError('invalid-response');
    return parsed.data;
}
export const runResultSchema = z.object({ schemaVersion: z.literal(1), id: z.uuid(),
    status: z.enum(['completed', 'failed', 'cancelled', 'executing', 'waiting', 'paused']) });
export const testResultSchema = z.object({ assessment: z.enum(['passed', 'failed', 'pending', 'uncertain']), terminal: z.boolean(), run: runResultSchema });
export const resultExit = (run) => ({ completed: 0, failed: 4, cancelled: 7, executing: 5, waiting: 3, paused: 3 })[run.status];
export function operationRelease(value, id) {
    const record = operationResult(z.strictObject({ snapshot: z.unknown(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }), value);
    const release = inspectRelease(record.snapshot);
    if (release.sha256 !== record.sha256 || release.snapshot.id !== id)
        throw new RuntimeHttpError('invalid-response');
    return release;
}
/** Enumerate the fresh imported project's case identities through the same bounded API on either backend. */
export async function importedOperationTests(host, projectId) {
    const result = [];
    let after, examined = 0;
    do {
        const page = operationResult(z.object({ schemaVersion: z.literal(2), nextCursor: z.uuid().nullable(), tests: z.array(z.object({
                id: z.uuid(), generation: z.number().int().positive(), status: z.enum(['draft', 'accepted']), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
                project: z.object({ id: z.uuid() })
            })).max(200) }), await host.call({ operation: 'tests.list', page: { limit: 200, ...(after ? { after } : {}) } }));
        examined += page.tests.length;
        if (examined > 10000 || (page.nextCursor && after && page.nextCursor <= after))
            throw new RuntimeHttpError('invalid-response');
        result.push(...page.tests.filter(test => test.project.id === projectId).map(({ id, generation, status, sha256 }) => ({ id, generation, status, sha256 })));
        if (!page.nextCursor)
            return result;
        after = page.nextCursor;
    } while (true);
}

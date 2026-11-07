import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { writeArtifact } from "../files.js";
import { readSecretFile } from "../providers/secret-input.js";
import { loadRuntimeTls, readTlsPemFile, validateCa } from "../http/tls.js";
import { RuntimeClient, RuntimeHttpError } from "../http/client.js";
import { PROTOCOL_VERSION } from "../capabilities.js";
import { dockerCommand } from "../images/docker.js";
import { localEngine, inspect as inspectImage, hashSchema } from "../images/local.js";
import { managementImageReceiptSchema, verifyManagementImage } from "../images/management.js";
import { readPrivateConfig } from "../http/private-config.js";
import { parseTelemetryConfig } from "../telemetry/config.js";
import { reference } from "../providers/config.js";
import { ownerNetworkSchema, verifyOwnerNetwork, matchesOwnerNetwork } from "./network.js";
import { parsePostgresConfiguration } from "../storage/postgres-config.js";
import { parseNotificationConfig } from "../notifications/config.js";
import { httpRateLimitsSchema } from "../http/rate-limits.js";
import { parsePostgresHttpRateCoordinatorOptions } from "../http/postgres-rate-config.js";
import { asyncRunPolicySchema } from "../http/async-runs.js";
export class DockerLifecycleError extends Error {
    code;
    owner;
    constructor(code) {
        super(`Jevable Docker lifecycle failed: ${code}. Inspect the retained owner plan and container state; no fallback, force kill or volume deletion was performed.`);
        this.code = code;
    }
}
const ownerSchema = z.strictObject({ schemaVersion: z.literal(1), format: z.literal('jevable.ai/docker-owner'), id: z.uuid(), createdAt: z.iso.datetime(),
    runtime: z.literal('docker'), storage: z.enum(['sqlite', 'postgres']), image: managementImageReceiptSchema,
    database: z.strictObject({ sha256: hashSchema }).optional(),
    rateLimits: z.strictObject({ sha256: hashSchema }).optional(),
    rateCoordinator: z.strictObject({ sha256: hashSchema, scope: z.uuid(), policySha256: hashSchema,
        timeoutMs: z.number().int().min(100).max(5000) }).optional(),
    asyncRuns: asyncRunPolicySchema.optional(),
    hostPort: z.number().int().min(1024).max(65535), certificateSha256: hashSchema,
    telemetry: z.strictObject({ sha256: hashSchema, credentialRef: reference.optional(), caSha256: hashSchema.optional() }).optional(),
    notifications: z.strictObject({ sha256: hashSchema, caSha256: hashSchema.optional() }).optional(),
    network: ownerNetworkSchema.optional(),
    memoryMb: z.number().int().min(128).max(65536), cpus: z.number().int().min(1).max(64) })
    .refine(owner => (owner.storage === 'postgres') === Boolean(owner.database))
    .refine(owner => !(owner.rateLimits && owner.rateCoordinator));
const path = z.string().min(1).max(4096);
const clientSchema = z.strictObject({ tokenFile: path, caFile: path.optional() });
const startSchema = z.strictObject({ image: managementImageReceiptSchema, ownerFile: path, hostPort: ownerSchema.shape.hostPort,
    storage: z.enum(['sqlite', 'postgres']).default('sqlite'), databaseFile: path.optional(),
    tokenFile: path, certificateFile: path, privateKeyFile: path, caFile: path.optional(),
    telemetryFile: path.optional(), telemetryCredentialFile: path.optional(), telemetryCaFile: path.optional(),
    notificationsFile: path.optional(), notificationsCaFile: path.optional(),
    rateLimitsFile: path.optional(),
    rateCoordinatorFile: path.optional(),
    asyncRuns: asyncRunPolicySchema.optional(),
    network: ownerNetworkSchema.optional(),
    memoryMb: ownerSchema.shape.memoryMb.default(512), cpus: ownerSchema.shape.cpus.default(1),
    waitMs: z.number().int().min(0).max(60000).default(10000) })
    .refine(options => (options.storage === 'postgres') === Boolean(options.databaseFile))
    .refine(options => !(options.rateLimitsFile && options.rateCoordinatorFile));
const idSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const parse = (schema, value) => {
    const result = schema.safeParse(value);
    if (!result.success)
        throw new DockerLifecycleError('invalid-options');
    return result.data;
};
const json = (value) => { try {
    return JSON.parse(value);
}
catch {
    throw new DockerLifecycleError('observation-unavailable');
} };
const prefix = (owner) => ['--context', owner.image.context];
export function dockerOwnerResources(value) {
    const owner = parse(ownerSchema, value), name = `jevable-runtime-${owner.id}`;
    return { container: name, initializer: `${name}-init`, stateVolume: owner.storage === 'sqlite' ? `${name}-state` : undefined,
        configVolume: `${name}-config`, endpoint: `https://127.0.0.1:${owner.hostPort}` };
}
const volumeEntries = (owner) => {
    const names = dockerOwnerResources(owner);
    return [...(names.stateVolume ? [[names.stateVolume, 'state']] : []), [names.configVolume, 'config']];
};
const storageArgs = (owner) => owner.storage === 'sqlite' ? ['--data-dir', '/data/state']
    : ['--storage', 'postgres', '--database-file', '/config/database.json'];
const storageMounts = (owner) => {
    const names = dockerOwnerResources(owner);
    return [...(names.stateVolume ? ['--mount', `type=volume,source=${names.stateVolume},target=/data`] : []),
        '--mount', `type=volume,source=${names.configVolume},target=/config,readonly`];
};
const labels = (owner, role) => ({ 'ai.jevable.owner': owner.id, 'ai.jevable.owner-role': role });
const labelArgs = (owner, role) => Object.entries(labels(owner, role)).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
const security = (owner) => ['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--memory', `${owner.memoryMb}m`, '--cpus', String(owner.cpus), '--pids-limit', '256'];
const serviceArgs = (owner) => ['runtime', 'serve', ...storageArgs(owner), '--token-file', '/config/token',
    '--port', '8787', '--bind-address', '0.0.0.0', '--public-origin', dockerOwnerResources(owner).endpoint,
    '--tls-cert-file', '/config/server.crt', '--tls-key-file', '/config/server.key',
    ...(owner.telemetry ? ['--telemetry-file', '/config/telemetry.json'] : []),
    ...(owner.notifications ? ['--notifications-file', '/config/notifications.json'] : []),
    ...(owner.rateLimits ? ['--rate-limits-file', '/config/rate-limits.json'] : []),
    ...(owner.rateCoordinator ? ['--rate-coordinator-file', '/config/rate-coordinator.json'] : []),
    ...(owner.asyncRuns ? ['--async-concurrency', String(owner.asyncRuns.maxConcurrentRuns)] : [])];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const telemetryCaPath = '/config/telemetry-ca.pem';
// Preserve existing telemetry-only owners; notification CA opt-in uses the explicit union of both trust inputs.
const extraCaPath = (owner) => owner.notifications?.caSha256 ? '/config/runtime-ca.pem'
    : owner.telemetry?.caSha256 ? telemetryCaPath : undefined;
// This owner profile admits only its explicit trust input, not inherited Node/TLS overrides.
function trustEnvironment(value, extraCa) {
    if (value === undefined || value === null)
        return !extraCa;
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string'))
        return false;
    const overrides = value.filter(item => /^(?:NODE_EXTRA_CA_CERTS|NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|SSL_CERT_FILE|SSL_CERT_DIR)=/u.test(item));
    return same(overrides, extraCa ? [`NODE_EXTRA_CA_CERTS=${extraCa}`] : []);
}
export async function readDockerOwner(file, reviewedSha256) {
    parse(hashSchema, reviewedSha256);
    try {
        const handle = await open(parse(path, file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > 64000 || stat.size < 1 || (stat.mode & 0o077) || stat.uid !== process.getuid?.())
                throw new DockerLifecycleError('invalid-options');
            const bytes = Buffer.alloc(64001);
            let size = 0;
            while (size < bytes.length) {
                const result = await handle.read(bytes, size, bytes.length - size, null);
                if (!result.bytesRead)
                    break;
                size += result.bytesRead;
            }
            if (size > 64000 || createHash('sha256').update(bytes.subarray(0, size)).digest('hex') !== reviewedSha256)
                throw new DockerLifecycleError('invalid-options');
            return parse(ownerSchema, json(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))));
        }
        finally {
            await handle.close();
        }
    }
    catch {
        throw new DockerLifecycleError('invalid-options');
    }
}
async function volumes(owner, run) {
    for (const [name, role] of volumeEntries(owner)) {
        const list = json(await run([...prefix(owner), 'volume', 'inspect', name]));
        const volume = Array.isArray(list) && list.length === 1 ? list[0] : undefined;
        if (volume?.Name !== name || volume.Driver !== 'local' || volume.Scope !== 'local'
            || Object.keys(volume.Options ?? {}).length || Object.entries(labels(owner, role)).some(([key, value]) => volume.Labels?.[key] !== value))
            throw new DockerLifecycleError('state-mismatch');
    }
}
async function container(owner, expectedId, run) {
    const names = dockerOwnerResources(owner);
    const listing = (await run([...prefix(owner), 'container', 'ls', '--all', '--no-trunc', '--filter', `name=^/${names.container}$`, '--format', '{{.ID}}'])).trim();
    if (!listing)
        return undefined;
    if (owner.network && !await verifyOwnerNetwork(owner.image.context, owner.network, run))
        throw new DockerLifecycleError('state-mismatch');
    const id = parse(idSchema, listing);
    if (expectedId !== undefined && id !== expectedId)
        throw new DockerLifecycleError('state-mismatch');
    const list = json(await run([...prefix(owner), 'container', 'inspect', id])), c = Array.isArray(list) && list.length === 1 ? list[0] : undefined;
    const h = c?.HostConfig, config = c?.Config, mounts = c?.Mounts;
    if (c?.Id !== id || c.Name !== `/${names.container}` || !idSchema.safeParse(String(c.Image).replace(/^sha256:/u, '')).success
        || config?.Image !== owner.image.imageId || config.User !== 'node' || config.WorkingDir !== '/app'
        || !same(config.Entrypoint, ['node', 'bin/jevable.mjs']) || !same(config.Cmd, serviceArgs(owner)) || config.StopSignal !== 'SIGTERM'
        || !trustEnvironment(config.Env, extraCaPath(owner))
        || Object.entries(labels(owner, 'service')).some(([key, value]) => config.Labels?.[key] !== value)
        || config.Labels?.['ai.jevable.management.sha256'] !== owner.image.runtimes[0].sha256
        || h?.ReadonlyRootfs !== true || h.Privileged !== false || !same(h.CapDrop, ['ALL']) || (h.CapAdd?.length ?? 0) !== 0
        || !(same(h.SecurityOpt, ['no-new-privileges']) || same(h.SecurityOpt, ['no-new-privileges:true'])) || h.NetworkMode !== (owner.network?.id ?? 'bridge') || h.AutoRemove !== false
        || (owner.network !== undefined && !matchesOwnerNetwork(c.NetworkSettings, owner.network))
        || (h.Devices?.length ?? 0) !== 0 || (h.DeviceRequests?.length ?? 0) !== 0 || h.PidMode || h.IpcMode === 'host'
        || !same(config.Healthcheck?.Test, ['NONE'])
        || h.RestartPolicy?.Name !== 'no' || h.Memory !== owner.memoryMb * 1024 * 1024 || h.NanoCpus !== owner.cpus * 1_000_000_000 || h.PidsLimit !== 256
        || !same(h.PortBindings, { '8787/tcp': [{ HostIp: '127.0.0.1', HostPort: String(owner.hostPort) }] })
        || !Array.isArray(mounts) || mounts.length !== (owner.storage === 'sqlite' ? 2 : 1)
        || (owner.storage === 'sqlite' && !mounts.some(m => m.Type === 'volume' && m.Name === names.stateVolume && m.Destination === '/data' && m.RW === true && m.Driver === 'local'))
        || !mounts.some(m => m.Type === 'volume' && m.Name === names.configVolume && m.Destination === '/config' && m.RW === false && m.Driver === 'local'))
        throw new DockerLifecycleError('state-mismatch');
    const state = z.object({ Status: z.enum(['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead']), Running: z.boolean(),
        Paused: z.boolean(), Restarting: z.boolean(), Dead: z.boolean(), ExitCode: z.number().int(), OOMKilled: z.boolean() }).safeParse(c.State);
    if (!state.success)
        throw new DockerLifecycleError('observation-unavailable');
    return { id, state: state.data };
}
const ownerRatePolicySchema = httpRateLimitsSchema.extend({ automaticRetry: z.literal(false),
    controls: httpRateLimitsSchema.shape.controls.extend({ authority: z.literal('owner-or-scoped-preview-only') }) });
const ownerRateCapabilitySchema = z.union([
    ownerRatePolicySchema.extend({ algorithm: z.literal('token-bucket'), scope: z.literal('runtime-instance'), persistence: z.literal(false) }),
    ownerRatePolicySchema.extend({ algorithm: z.literal('host-coordinated-token-bucket'), scope: z.literal('explicit-shared-scope'),
        persistence: z.literal('coordinator-defined; not-attested'),
        coordinator: z.strictObject({ scope: z.uuid(), policySha256: hashSchema, timeoutMs: z.number().int().min(100).max(5000) }) }),
]);
const dep = (dependencies) => ({ run: dependencies.run ?? dockerCommand,
    client: dependencies.client ?? ((endpoint, token, ca) => new RuntimeClient(endpoint, token, 1000, 1_000_000, ca ? { ca } : {})),
    sleep: dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))), now: dependencies.now ?? Date.now });
async function clientConfig(input) {
    const options = parse(clientSchema, input), token = await readSecretFile(options.tokenFile);
    if (!/^[a-f0-9]{64}$/u.test(token))
        throw new DockerLifecycleError('invalid-options');
    const ca = options.caFile === undefined ? undefined : validateCa(await readTlsPemFile(options.caFile));
    return { token, ca };
}
async function service(owner, client) {
    try {
        const caps = z.object({ product: z.literal(owner.storage === 'postgres' ? 'Jevable workflow runtime' : 'Jevable core'), version: z.literal(owner.image.coreVersion), protocolVersion: z.literal(PROTOCOL_VERSION),
            instanceId: z.uuid(), remoteAccess: z.literal(true), api: z.object({ transport: z.literal('direct-https'), servesHtml: z.literal(false),
                asyncRuns: z.union([z.literal(false), asyncRunPolicySchema.extend({ status: z.literal('metadata-only'),
                        authority: z.literal('owner-only; instance-required'), release: z.literal('owner-reviewed-pins'),
                        admission: z.literal('202-created; 200-retained; no-replay'), automaticResume: z.literal(false) })]).optional(),
                rateLimits: ownerRateCapabilitySchema.optional() }),
            workflowRuntime: z.object({ mode: z.literal('local'), storage: z.literal(owner.storage) }) }).parse(await client.capabilities());
        const asyncRuns = caps.api.asyncRuns;
        if (owner.asyncRuns ? !asyncRuns || asyncRuns.maxConcurrentRuns !== owner.asyncRuns.maxConcurrentRuns : Boolean(asyncRuns))
            throw new Error('invalid-response');
        // Bind the advertised startup policy to the private reviewed owner record. Legacy owners omit both.
        const reported = caps.api.rateLimits;
        if (Boolean(owner.rateLimits || owner.rateCoordinator) !== Boolean(reported))
            throw new Error('invalid-response');
        if (reported) {
            const { authority: _authority, ...controls } = reported.controls;
            const policy = httpRateLimitsSchema.parse({ requests: reported.requests, controls });
            const policySha256 = createHash('sha256').update(JSON.stringify(policy)).digest('hex');
            if (owner.rateCoordinator) {
                if (reported.algorithm !== 'host-coordinated-token-bucket' || reported.coordinator.scope !== owner.rateCoordinator.scope
                    || reported.coordinator.policySha256 !== owner.rateCoordinator.policySha256 || policySha256 !== owner.rateCoordinator.policySha256
                    || reported.coordinator.timeoutMs !== owner.rateCoordinator.timeoutMs)
                    throw new Error('invalid-response');
            }
            else if (reported.algorithm !== 'token-bucket' || policySha256 !== owner.rateLimits.sha256)
                throw new Error('invalid-response');
        }
        const health = z.object({ instanceId: z.literal(caps.instanceId), status: z.enum(['ready', 'draining', 'closed']), activeRequests: z.number().int().nonnegative(),
            activeAsyncRuns: z.number().int().min(0).max(owner.asyncRuns?.maxConcurrentRuns ?? 0).optional(),
            runtime: owner.storage === 'postgres' ? z.object({ storage: z.literal('postgres'), database: z.literal('reachable'), state: z.literal('open') }) : z.unknown().optional(),
        }).parse(await client.health());
        if (Boolean(owner.asyncRuns) !== (health.activeAsyncRuns !== undefined))
            throw new Error('invalid-response');
        return { status: health.status, instanceId: caps.instanceId, activeRequests: health.activeRequests,
            ...(owner.asyncRuns ? { activeAsyncRuns: health.activeAsyncRuns } : {}) };
    }
    catch (error) {
        return { status: 'unavailable', code: error instanceof RuntimeHttpError ? error.code : 'invalid-response',
            ...(error instanceof RuntimeHttpError && error.code === 'rate-limit' && error.retryAfterSeconds !== undefined
                ? { retryAfterSeconds: error.retryAfterSeconds } : {}) };
    }
}
/** Read-only owner observation; no repair, discovery, automatic start or workflow replay. */
export async function inspectDockerOwner(value, clientOptions, dependencies = {}) {
    const owner = parse(ownerSchema, value), d = dep(dependencies);
    const auth = clientOptions ? await clientConfig(clientOptions) : undefined;
    await localEngine(owner.image.context, d.run);
    const found = await container(owner, undefined, d.run);
    if (found)
        await volumes(owner, d.run);
    return { schemaVersion: 1, runtime: 'docker', storage: owner.storage, ownerId: owner.id, resources: dockerOwnerResources(owner), imageId: owner.image.imageId,
        status: found?.state.Status ?? 'absent', ...(found ? { containerId: found.id, exitCode: found.state.ExitCode, oomKilled: found.state.OOMKilled } : {}),
        service: found?.state.Running && !found.state.Paused && !found.state.Restarting && auth
            ? await service(owner, d.client(dockerOwnerResources(owner).endpoint, auth.token, auth.ca)) : { status: 'not-checked' },
        execution: 'not-started-or-resumed-by-inspection', volumes: 'retained; absence of a container does not imply absent volumes' };
}
async function ready(owner, id, auth, waitMs, d) {
    const deadline = d.now() + waitMs, client = d.client(dockerOwnerResources(owner).endpoint, auth.token, auth.ca);
    while (true) {
        const c = await container(owner, id, d.run);
        if (!c)
            throw new DockerLifecycleError('not-found');
        if (!c.state.Running || c.state.Paused || c.state.Restarting || c.state.Dead)
            return { status: c.state.Status, containerId: id, exitCode: c.state.ExitCode };
        const observed = await service(owner, client);
        if (observed.status === 'ready')
            return { status: 'ready', containerId: id, service: observed };
        if (observed.status === 'draining' || observed.status === 'closed')
            return { status: observed.status, containerId: id, service: observed };
        if (d.now() >= deadline || (observed.status === 'unavailable' && ['unauthorized', 'protocol-mismatch', 'invalid-response', 'rate-limit', 'rate-coordinator-unavailable'].includes(observed.code))) {
            return { status: 'starting', containerId: id, service: observed, observation: 'readiness-not-proven; container was not stopped or restarted' };
        }
        await d.sleep(Math.min(100, Math.max(0, deadline - d.now())));
    }
}
const provision = `const fs=require('node:fs');let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',b=>{raw+=b;if(Buffer.byteLength(raw)>1000000)process.exit(2)});process.stdin.on('end',()=>{try{const c=JSON.parse(raw);for(const [name,value]of [['token',c.token],['server.crt',c.cert],['server.key',c.key],...(c.telemetry===undefined?[]:[['telemetry.json',c.telemetry]]),...(c.telemetryCa===undefined?[]:[['telemetry-ca.pem',c.telemetryCa]]),...(c.notifications===undefined?[]:[['notifications.json',c.notifications]]),...(c.runtimeCa===undefined?[]:[['runtime-ca.pem',c.runtimeCa]]),...(c.database===undefined?[]:[['database.json',c.database]]),...(c.rateLimits===undefined?[]:[['rate-limits.json',c.rateLimits]]),...(c.rateCoordinator===undefined?[]:[['rate-coordinator.json',c.rateCoordinator]])]){if(typeof value!=='string')throw Error();fs.writeFileSync('/data/'+name,value,{flag:'wx',mode:0o600});}process.stdout.write('initialized');}catch{process.stderr.write('Private configuration initialization failed.');process.exitCode=1;}});`;
/** Create only newly named owned resources, after an immutable private owner record has been durably published. */
export async function startDockerOwner(input, dependencies = {}) {
    const options = parse(startSchema, input), d = dep(dependencies);
    const rateLimits = options.rateLimitsFile ? parse(httpRateLimitsSchema, await readPrivateConfig(options.rateLimitsFile, 4096)) : undefined;
    const rateLimitsJson = rateLimits ? JSON.stringify(rateLimits) : undefined;
    let rateCoordinator;
    if (options.rateCoordinatorFile) {
        try {
            rateCoordinator = parsePostgresHttpRateCoordinatorOptions(await readPrivateConfig(options.rateCoordinatorFile, 65536));
        }
        catch {
            throw new DockerLifecycleError('invalid-options');
        }
        if (rateCoordinator.initialize !== false || rateCoordinator.connection.tls.mode !== 'verify-full')
            throw new DockerLifecycleError('invalid-options');
    }
    const rateCoordinatorJson = rateCoordinator ? JSON.stringify(rateCoordinator) : undefined;
    const database = options.databaseFile ? parsePostgresConfiguration(await readPrivateConfig(options.databaseFile, 320000)) : undefined;
    // Docker deployment requires verified database TLS even for a container-loopback destination.
    if (database && database.tls.mode !== 'verify-full')
        throw new DockerLifecycleError('invalid-options');
    const databaseJson = database ? JSON.stringify(database) : undefined;
    const notifications = options.notificationsFile ? parseNotificationConfig(await readPrivateConfig(options.notificationsFile, 100000)) : undefined;
    if (options.notificationsCaFile && !notifications?.endpoints.some(endpoint => endpoint.url.startsWith('https://')))
        throw new DockerLifecycleError('invalid-options');
    const notificationsCa = options.notificationsCaFile ? validateCa(await readTlsPemFile(options.notificationsCaFile, true)) : undefined;
    const notificationsJson = notifications ? JSON.stringify(notifications) : undefined;
    // Validate the chosen destination and independent credential before any Docker access or owner publication.
    const telemetry = options.telemetryFile ? parseTelemetryConfig(await readPrivateConfig(options.telemetryFile, 16000)) : undefined;
    const credentialRef = telemetry?.authentication.kind === 'bearer' ? telemetry.authentication.credentialRef : undefined;
    if ((options.telemetryCredentialFile && !credentialRef)
        || (options.storage === 'sqlite' && Boolean(credentialRef) !== Boolean(options.telemetryCredentialFile)))
        throw new DockerLifecycleError('invalid-options');
    const telemetryCredential = options.telemetryCredentialFile ? await readSecretFile(options.telemetryCredentialFile) : undefined;
    if (options.telemetryCaFile && (!telemetry || ![telemetry.endpoint, telemetry.metricsEndpoint, telemetry.logsEndpoint]
        .some(endpoint => endpoint?.startsWith('https://'))))
        throw new DockerLifecycleError('invalid-options');
    const telemetryCa = options.telemetryCaFile ? validateCa(await readTlsPemFile(options.telemetryCaFile, true)) : undefined;
    const telemetryJson = telemetry ? JSON.stringify(telemetry) : undefined;
    const runtimeCa = notificationsCa ? [telemetryCa, notificationsCa].filter(Boolean).join('\n') : undefined;
    const auth = await clientConfig({ tokenFile: options.tokenFile, ...(options.caFile ? { caFile: options.caFile } : {}) });
    const tls = await loadRuntimeTls({ publicOrigin: `https://127.0.0.1:${options.hostPort}`, bindAddress: '0.0.0.0', certificateFile: options.certificateFile, privateKeyFile: options.privateKeyFile });
    const configurationInput = Buffer.from(JSON.stringify({ token: auth.token, cert: tls.cert, key: tls.key,
        ...(telemetryJson ? { telemetry: telemetryJson } : {}), ...(telemetryCa ? { telemetryCa } : {}), ...(databaseJson ? { database: databaseJson } : {}),
        ...(notificationsJson ? { notifications: notificationsJson } : {}), ...(runtimeCa ? { runtimeCa } : {}),
        ...(rateLimitsJson ? { rateLimits: rateLimitsJson } : {}), ...(rateCoordinatorJson ? { rateCoordinator: rateCoordinatorJson } : {}) }));
    if (configurationInput.byteLength > 1_000_000)
        throw new DockerLifecycleError('invalid-options');
    await localEngine(options.image.context, d.run);
    const image = await inspectImage(options.image.context, options.image.imageId, d.run);
    verifyManagementImage(image, options.image);
    if (!trustEnvironment(image.Config?.Env, undefined))
        throw new DockerLifecycleError('invalid-options');
    if (options.network && !await verifyOwnerNetwork(options.image.context, options.network, d.run))
        throw new DockerLifecycleError('state-mismatch');
    const owner = parse(ownerSchema, { schemaVersion: 1, format: 'jevable.ai/docker-owner', id: randomUUID(), createdAt: new Date().toISOString(),
        runtime: 'docker', storage: options.storage, ...(databaseJson ? { database: { sha256: createHash('sha256').update(databaseJson).digest('hex') } } : {}),
        image: options.image, hostPort: options.hostPort, certificateSha256: tls.certificateSha256, memoryMb: options.memoryMb, cpus: options.cpus,
        ...(options.network ? { network: options.network } : {}),
        ...(options.asyncRuns ? { asyncRuns: options.asyncRuns } : {}),
        ...(rateLimitsJson ? { rateLimits: { sha256: createHash('sha256').update(rateLimitsJson).digest('hex') } } : {}),
        ...(rateCoordinator && rateCoordinatorJson ? { rateCoordinator: { sha256: createHash('sha256').update(rateCoordinatorJson).digest('hex'),
                scope: rateCoordinator.scope, policySha256: createHash('sha256').update(JSON.stringify(rateCoordinator.policy)).digest('hex'),
                timeoutMs: rateCoordinator.timeoutMs } } : {}),
        ...(notificationsJson ? { notifications: { sha256: createHash('sha256').update(notificationsJson).digest('hex'),
                ...(notificationsCa ? { caSha256: createHash('sha256').update(notificationsCa).digest('hex') } : {}) } } : {}),
        ...(telemetryJson ? { telemetry: { sha256: createHash('sha256').update(telemetryJson).digest('hex'), ...(credentialRef ? { credentialRef } : {}),
                ...(telemetryCa ? { caSha256: createHash('sha256').update(telemetryCa).digest('hex') } : {}) } } : {}) });
    const artifact = await writeArtifact(options.ownerFile, JSON.stringify(owner, null, 2) + '\n');
    const names = dockerOwnerResources(owner);
    try {
        const directory = await open(dirname(artifact.path), constants.O_RDONLY | constants.O_DIRECTORY);
        try {
            await directory.sync();
        }
        finally {
            await directory.close();
        }
        for (const name of [names.container, names.initializer])
            if ((await d.run([...prefix(owner), 'container', 'ls', '--all', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'])).trim())
                throw new DockerLifecycleError('resource-conflict');
        for (const [name] of volumeEntries(owner))
            if ((await d.run([...prefix(owner), 'volume', 'ls', '--filter', `name=${name}`, '--format', '{{.Name}}'])).trim())
                throw new DockerLifecycleError('resource-conflict');
        for (const [name, role] of volumeEntries(owner))
            await d.run([...prefix(owner), 'volume', 'create', '--driver', 'local', ...labelArgs(owner, role), name]);
        await volumes(owner, d.run);
        await d.run([...prefix(owner), 'run', '--rm', '--pull', 'never', '--name', names.initializer, '--platform', owner.image.platform,
            '--network', 'none', ...security(owner), ...labelArgs(owner, 'initializer'), '--mount', `type=volume,source=${names.configVolume},target=/data`,
            '-i', '--entrypoint', 'node', owner.image.imageId, '-e', provision], { input: configurationInput });
        if (telemetryCredential && credentialRef) {
            // A PostgreSQL credential job uses the explicit database route; configuration staging stays offline.
            await d.run([...prefix(owner), 'run', '--rm', '--pull', 'never', '--name', names.initializer, '--platform', owner.image.platform,
                '--network', owner.storage === 'postgres' ? owner.network?.id ?? 'bridge' : 'none', ...security(owner), ...labelArgs(owner, 'initializer'),
                ...(owner.storage === 'postgres' ? storageMounts(owner) : ['--mount', `type=volume,source=${names.stateVolume},target=/data`]),
                '-i', owner.image.imageId, 'credentials', 'set', credentialRef, '--stdin', '--expected-generation', '0', ...storageArgs(owner)], { input: Buffer.from(telemetryCredential) });
        }
        const id = parse(idSchema, (await d.run([...prefix(owner), 'run', '--detach', '--pull', 'never', '--name', names.container, '--platform', owner.image.platform,
            '--network', owner.network?.id ?? 'bridge', '--restart', 'no', ...security(owner), ...labelArgs(owner, 'service'),
            ...(extraCaPath(owner) ? ['--env', `NODE_EXTRA_CA_CERTS=${extraCaPath(owner)}`] : []),
            ...storageMounts(owner),
            '--publish', `127.0.0.1:${owner.hostPort}:8787`, owner.image.imageId, ...serviceArgs(owner)])).trim());
        return { schemaVersion: 1, runtime: 'docker', storage: owner.storage, owner: artifact, ownerId: owner.id, resources: names, imageId: owner.image.imageId,
            ...await ready(owner, id, auth, options.waitMs, d), execution: 'service-start-only; no workflow submitted' };
    }
    catch (cause) {
        const error = cause instanceof DockerLifecycleError ? cause : new DockerLifecycleError('startup-uncertain');
        error.owner = artifact;
        throw error;
    }
}
/** Signal only the exact reviewed container, never force-kill on observation timeout and never remove its volumes. */
export async function stopDockerOwner(value, containerId, waitMs = 10000, dependencies = {}) {
    const owner = parse(ownerSchema, value), id = parse(idSchema, containerId), wait = parse(z.number().int().min(0).max(60000), waitMs), d = dep(dependencies);
    await localEngine(owner.image.context, d.run);
    await volumes(owner, d.run);
    let c = await container(owner, id, d.run);
    if (!c)
        throw new DockerLifecycleError('not-found');
    if (c.state.Paused || c.state.Restarting || c.state.Dead)
        throw new DockerLifecycleError('state-mismatch');
    if (c.state.Running) {
        try {
            await d.run([...prefix(owner), 'kill', '--signal', 'SIGTERM', id]);
        }
        catch {
            const observed = await container(owner, id, d.run);
            if (!observed || observed.state.Running)
                throw new DockerLifecycleError('observation-unavailable');
            c = observed;
        }
    }
    const deadline = d.now() + wait;
    while (c.state.Running) {
        c = await container(owner, id, d.run);
        if (!c)
            throw new DockerLifecycleError('not-found');
        if (!c.state.Running || d.now() >= deadline)
            break;
        await d.sleep(Math.min(100, Math.max(0, deadline - d.now())));
    }
    return { schemaVersion: 1, runtime: 'docker', storage: owner.storage, ownerId: owner.id, containerId: id,
        status: c.state.Running ? 'draining' : c.state.Status === 'exited' && c.state.ExitCode === 0 && !c.state.OOMKilled ? 'stopped' : 'exited-unclean',
        exitCode: c.state.ExitCode, volumes: 'retained', forceKill: false, container: 'retained for inspection and explicit clean restart' };
}
/** Reuse the same cleanly stopped container. This does not replace images, rotate config, repair locks or resume workflows. */
export async function restartDockerOwner(value, containerId, clientOptions, waitMs = 10000, dependencies = {}) {
    const owner = parse(ownerSchema, value), id = parse(idSchema, containerId), wait = parse(z.number().int().min(0).max(60000), waitMs), d = dep(dependencies), auth = await clientConfig(clientOptions);
    await localEngine(owner.image.context, d.run);
    await volumes(owner, d.run);
    const c = await container(owner, id, d.run);
    if (!c)
        throw new DockerLifecycleError('not-found');
    if (c.state.Paused || c.state.Restarting || c.state.Dead || (!c.state.Running && (c.state.Status !== 'exited' || c.state.ExitCode !== 0 || c.state.OOMKilled)))
        throw new DockerLifecycleError('not-cleanly-stopped');
    if (!c.state.Running)
        await d.run([...prefix(owner), 'start', id]);
    return { schemaVersion: 1, runtime: 'docker', storage: owner.storage, ownerId: owner.id, resources: dockerOwnerResources(owner), ...await ready(owner, id, auth, wait, d),
        execution: 'service-start-only; retained workflows are not automatically resumed' };
}

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, readFile, chmod, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { createTlsFixture } from '../scripts/tls-fixture.mjs'
import { capabilities } from '../src/capabilities.ts'
import { startDockerOwner, inspectDockerOwner, stopDockerOwner, restartDockerOwner, readDockerOwner, dockerOwnerResources } from '../src/docker/index.ts'
import type { DockerOwner, DockerOwnerDependencies } from '../src/docker/index.ts'
import type { ManagementImageReceipt } from '../src/images/management.ts'
import type { DockerCommand } from '../src/images/docker.ts'
import { main } from '../src/cli.ts'
import { parseTelemetryConfig } from '../src/telemetry/config.ts'
import { parsePostgresConfiguration } from '../src/storage/postgres.ts'
import { parseNotificationConfig } from '../src/notifications/config.ts'
import { httpRateLimitsSchema } from '../src/http/rate-limits.ts'
import { parsePostgresHttpRateCoordinatorOptions } from '../src/http/postgres-rate-config.ts'
import { RuntimeHttpError } from '../src/http/client.ts'
import * as ownerApi from '../src/docker/index.ts'
import { Script } from 'node:vm'
import * as artifactFiles from '../src/files.ts'
import * as secretFiles from '../src/providers/secret-input.ts'

let tls: Awaited<ReturnType<typeof createTlsFixture>>
beforeAll(async () => { tls = await createTlsFixture(await mkdtemp(join(tmpdir(), 'jevable-owner-tls-'))) }, 20000)
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const network = { name: 'fixture-private', id: '7'.repeat(64) }
const ratePolicy = { requests: { capacity: 3, refillTokens: 2, refillIntervalMs: 1000 },
  controls: { capacity: 7, refillTokens: 1, refillIntervalMs: 3600000 } }
const rateCapability = (policy = ratePolicy) => ({ ...policy, algorithm: 'token-bucket', scope: 'runtime-instance',
  persistence: false, automaticRetry: false, controls: { ...policy.controls, authority: 'owner-or-scoped-preview-only' } })
const sharedRateConfig = () => ({ connection: { host: 'quota.fixture', port: 5432, database: 'quota_fixture', user: 'quota_fixture',
  password: 'PRIVATE_QUOTA_PASSWORD', tls: { mode: 'verify-full', ca: tls.ca } }, scope: randomUUID() as string, policy: structuredClone(ratePolicy),
  initialize: false, timeoutMs: 2000, statementTimeoutMs: 1000, maxPendingDebits: 4 })
const sharedRateCapability = (config: ReturnType<typeof sharedRateConfig>) => ({ ...rateCapability(structuredClone(config.policy)),
  algorithm: 'host-coordinated-token-bucket', scope: 'explicit-shared-scope', persistence: 'coordinator-defined; not-attested',
  coordinator: { scope: config.scope.toLowerCase(), policySha256: digest(JSON.stringify(httpRateLimitsSchema.parse(config.policy))), timeoutMs: config.timeoutMs } })
const asyncCapability = (maxConcurrentRuns: number) => ({ maxConcurrentRuns, status: 'metadata-only',
  authority: 'owner-only; instance-required', release: 'owner-reviewed-pins',
  admission: '202-created; 200-retained; no-replay', automaticResume: false })
const image: ManagementImageReceipt = { schemaVersion: 1, format: 'jevable.ai/management-image-receipt', createdAt: '2026-01-01T00:00:00.000Z',
  context: 'fixture', platform: 'linux/arm64', baseImage: `node@sha256:${'a'.repeat(64)}`, tag: 'fixture:owner', imageId: `sha256:${'b'.repeat(64)}`,
  engineVersion: 'fixture', execution: 'not-run', publication: 'local-daemon-only', coreVersion: capabilities().version,
  runtimes: [{ role: 'management', sha256: 'c'.repeat(64), bytes: 100 }, { role: 'sqlite', sha256: 'd'.repeat(64), bytes: 100 }, { role: 'postgres', sha256: 'e'.repeat(64), bytes: 100 }],
  manifestSha256: 'f'.repeat(64), recipeSha256: 'a'.repeat(64), state: 'excluded', credentials: 'excluded' }
const imageConfig = { User: 'node', WorkingDir: '/app', Entrypoint: ['node', 'bin/jevable.mjs'], Cmd: ['capabilities'], StopSignal: 'SIGTERM', Healthcheck: { Test: ['NONE'] }, Labels: {
  'ai.jevable.mode': 'management', 'ai.jevable.core.version': image.coreVersion, 'ai.jevable.management.sha256': image.runtimes[0].sha256,
  'ai.jevable.release-sqlite.sha256': image.runtimes[1].sha256, 'ai.jevable.release-postgres.sha256': image.runtimes[2].sha256,
  'ai.jevable.manifest.sha256': image.manifestSha256, 'ai.jevable.recipe.sha256': image.recipeSha256, 'ai.jevable.base.image': image.baseImage, 'ai.jevable.platform': image.platform } }
async function fixture(storage: 'sqlite' | 'postgres' = 'sqlite') {
  const dir = await mkdtemp(join(tmpdir(), 'jevable-owner-')), token = '1'.repeat(64), tokenFile = join(dir, 'token'), ownerFile = join(dir, 'owner.json')
  await writeFile(tokenFile, token, { mode: 0o600 })
  const databaseFile = join(dir, 'database.json'), database = { host: 'database.fixture', port: 5432, database: 'fixture', user: 'fixture',
    password: 'PRIVATE_DATABASE_PASSWORD', namespace: 'PRIVATE_DATABASE_NAMESPACE', initialize: true, tls: { mode: 'verify-full', ca: tls.ca } }
  if (storage === 'postgres') await writeFile(databaseFile, JSON.stringify(database), { mode: 0o600 })
  let owner: DockerOwner, c: any, clock = 0, provisioned = '', credentialInput = '', instanceId = randomUUID(), serviceStatus = 'ready'
  let overrideRateLimits = false, reportedRateLimits: unknown, healthError: Error | undefined, healthReads = 0
  let overrideAsyncRuns = false, reportedAsyncRuns: unknown, overrideActiveAsyncRuns = false, activeAsyncRuns: unknown
  const commands: string[][] = [], createdVolumes: any[] = [], id = '2'.repeat(64)
  const networkInfo = { Name: network.name, Id: network.id, Driver: 'bridge', Scope: 'local', Ingress: false, Internal: false }
  const faults = { remote: false, init: false, credential: false, hold: false, signalLost: false, image: false, startLost: false, conflict: false, imageEnv: [] as string[],
    reportedStorage: storage, databaseHealth: 'reachable', databaseState: 'open' }
  const run: DockerCommand = async (args, opts = {}) => {
    commands.push(args)
    if (args[0] === 'context') return JSON.stringify({ Host: faults.remote ? 'ssh://fixture' : 'unix:///fixture.sock' })
    const a = args.slice(2)
    if (a[0] === 'version') return JSON.stringify({ Os: 'linux', Version: 'fixture' })
    if (a[0] === 'image' && a[1] === 'inspect') return JSON.stringify([{ Id: image.imageId, Os: 'linux', Architecture: 'arm64', Config: { ...imageConfig, Env: faults.imageEnv, ...(faults.image ? { User: 'root' } : {}) } }])
    if (a[0] === 'network' && a[1] === 'inspect') { expect(a[2]).toBe(network.id); return JSON.stringify([networkInfo]) }
    // Every command beyond read-only preflight must have a persisted, private, parseable ownership record.
    owner = await readDockerOwner(ownerFile, digest(await readFile(ownerFile)))
    const names = dockerOwnerResources(owner)
    if (a[0] === 'container' && a[1] === 'ls') return c && a.includes(`name=^/${names.container}$`) ? c.Id : faults.conflict ? id : ''
    if (a[0] === 'container' && a[1] === 'inspect') return JSON.stringify([c])
    if (a[0] === 'volume') {
      if (a[1] === 'ls') return ''
      if (a[1] === 'create') {
        createdVolumes.push({ Name: a.at(-1), Driver: 'local', Scope: 'local', Options: null,
          Labels: Object.fromEntries(a.flatMap((v, i) => v === '--label' ? [a[i + 1]!.split('=')] : [])) }); return a.at(-1)!
      }
      if (a[1] === 'inspect') return JSON.stringify(createdVolumes.filter(v => v.Name === a[2]))
    }
    if (a[0] === 'run' && a.includes('--rm')) {
      if (a.includes('credentials')) {
        credentialInput = Buffer.from(opts.input!).toString()
        if (faults.credential) throw Error('PRIVATE_CREDENTIAL_INITIALIZATION_ERROR')
        return JSON.stringify({ generation: 1 })
      }
      provisioned = Buffer.from(opts.input!).toString()
      if (faults.init) throw Error('PRIVATE_PROVISION_FAILURE')
      return 'initialized'
    }
    if (a[0] === 'run') {
      c = { Id: id, Name: `/${names.container}`, Image: image.imageId,
        Config: { ...imageConfig, Image: image.imageId, Cmd: a.slice(a.indexOf(image.imageId) + 1),
          Env: ['PATH=/usr/local/bin:/usr/bin', ...a.flatMap((arg, i) => arg === '--env' ? [a[i + 1]!] : [])],
          Labels: { ...imageConfig.Labels, 'ai.jevable.owner': owner.id, 'ai.jevable.owner-role': 'service' } },
        HostConfig: { ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], CapAdd: null, SecurityOpt: ['no-new-privileges:true'], NetworkMode: a[a.indexOf('--network') + 1],
          AutoRemove: false, RestartPolicy: { Name: 'no' }, Memory: owner.memoryMb * 1024 * 1024, NanoCpus: owner.cpus * 1e9, PidsLimit: 256,
          PortBindings: { '8787/tcp': [{ HostIp: '127.0.0.1', HostPort: String(owner.hostPort) }] } },
        NetworkSettings: { Networks: { [owner.network?.name ?? 'bridge']: { NetworkID: owner.network?.id ?? '8'.repeat(64) } } },
        Mounts: [...(names.stateVolume ? [{ Type: 'volume', Name: names.stateVolume, Destination: '/data', RW: true, Driver: 'local' }] : []), { Type: 'volume', Name: names.configVolume, Destination: '/config', RW: false, Driver: 'local' }],
        State: { Status: 'running', Running: true, Paused: false, Restarting: false, Dead: false, ExitCode: 0, OOMKilled: false } }
      if (faults.startLost) throw Error('PRIVATE_LOST_RESPONSE')
      return id
    }
    if (a[0] === 'kill') {
      expect(a).toEqual(['kill', '--signal', 'SIGTERM', id])
      if (!faults.hold) { c.State.Running = false; c.State.Status = 'exited' }
      if (faults.signalLost) throw Error('PRIVATE_LOST_SIGNAL')
      return id
    }
    if (a[0] === 'start') { expect(a[1]).toBe(id); c.State.Running = true; c.State.Status = 'running'; instanceId = randomUUID(); return id }
    throw Error(`Unexpected fixture command: ${a.join(' ')}`)
  }
  const dependencies: DockerOwnerDependencies = { run, now: () => clock, sleep: async ms => { clock += ms }, client: (endpoint, provided, ca) => {
    expect(endpoint).toBe('https://127.0.0.1:18787'); expect(provided).toBe(token); expect(ca).toBe(tls.ca)
    return { capabilities: async () => ({ ...capabilities(), product: faults.reportedStorage === 'postgres' ? 'Jevable workflow runtime' : 'Jevable core',
      workflowRuntime: { ...capabilities().workflowRuntime, storage: faults.reportedStorage }, instanceId, remoteAccess: true,
      api: { transport: 'direct-https', servesHtml: false,
        ...((overrideAsyncRuns ? reportedAsyncRuns !== undefined : Boolean(owner?.asyncRuns))
          ? { asyncRuns: overrideAsyncRuns ? reportedAsyncRuns : asyncCapability(owner.asyncRuns!.maxConcurrentRuns) } : {}),
        ...((overrideRateLimits ? reportedRateLimits !== undefined : Boolean(owner?.rateLimits || owner?.rateCoordinator))
          ? { rateLimits: overrideRateLimits ? reportedRateLimits : owner.rateCoordinator
            ? sharedRateCapability(JSON.parse(JSON.parse(provisioned).rateCoordinator))
            : rateCapability(JSON.parse(JSON.parse(provisioned).rateLimits)) } : {}) } }),
      health: async () => { healthReads++; if (healthError) throw healthError; return { instanceId, status: serviceStatus, activeRequests: 0,
        ...((overrideActiveAsyncRuns ? activeAsyncRuns !== undefined : Boolean(owner?.asyncRuns))
          ? { activeAsyncRuns: overrideActiveAsyncRuns ? activeAsyncRuns : 0 } : {}),
        ...(storage === 'postgres' ? { runtime: { storage, database: faults.databaseHealth, state: faults.databaseState } } : {}) } } }
  } }
  const options = { image, ownerFile, hostPort: 18787, tokenFile, certificateFile: tls.cert, privateKeyFile: tls.key, caFile: tls.cert,
    storage, ...(storage === 'postgres' ? { databaseFile } : {}) }
  return { options, dependencies, faults, commands, createdVolumes, networkInfo, database, databaseFile, id, client: { tokenFile, caFile: tls.cert },
    owner: () => owner, container: () => c, provisioned: () => provisioned, credentialInput: () => credentialInput, serviceStatus: (status: string) => { serviceStatus = status },
    reportRateLimits: (value: unknown) => { overrideRateLimits = true; reportedRateLimits = value },
    reportAsyncRuns: (value: unknown) => { overrideAsyncRuns = true; reportedAsyncRuns = value },
    activeAsyncRuns: (value: unknown) => { overrideActiveAsyncRuns = true; activeAsyncRuns = value },
    healthError: (error: Error) => { healthError = error }, healthReads: () => healthReads }
}
describe('explicit Docker owner lifecycle', () => {
  it.each(['sqlite', 'postgres'] as const)('privately stages attach-only shared quotas for %s and pins clean restart without rereading host input', async storage => {
    const f = await fixture(storage), file = f.options.ownerFile + '.coordinator', config = sharedRateConfig()
    config.scope = config.scope.toUpperCase()
    await writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600 })
    const started = await startDockerOwner({ ...f.options, rateCoordinatorFile: file }, f.dependencies)
    expect(started.status).toBe('ready')
    const canonical = JSON.stringify(parsePostgresHttpRateCoordinatorOptions(config)), staged = JSON.parse(f.provisioned()).rateCoordinator
    expect(staged).toBe(canonical)
    expect(f.owner().rateCoordinator).toEqual({ sha256: digest(canonical), ...sharedRateCapability(config).coordinator })
    expect(f.owner()).not.toHaveProperty('rateLimits')
    expect(f.container().Config.Cmd.slice(-2)).toEqual(['--rate-coordinator-file', '/config/rate-coordinator.json'])
    expect(f.container().Mounts.find((m: any) => m.Destination === '/config').RW).toBe(false)
    expect(JSON.stringify([started, f.owner(), f.commands])).not.toContain(file)
    expect(JSON.stringify([started, f.owner(), f.commands])).not.toContain(config.connection.password)
    const initializer = f.commands.find(args => args.includes('-e'))!, writes: any[] = [], events: Record<string, Function> = {}
    expect(initializer[initializer.indexOf('--network') + 1]).toBe('none')
    new Script(initializer.at(-1)!).runInNewContext({ Buffer,
      require: (name: string) => { expect(name).toBe('node:fs'); return { writeFileSync: (...args: any[]) => { writes.push(args) } } },
      process: { stdin: { setEncoding() {}, on: (name: string, fn: Function) => { events[name] = fn } },
        stdout: { write: (s: string) => { expect(s).toBe('initialized') } }, stderr: { write: () => { throw Error('initializer failed') } } } })
    events.data!(f.provisioned()); events.end!()
    expect(writes.filter(write => write[0] === '/data/rate-coordinator.json')).toEqual([['/data/rate-coordinator.json', canonical, { flag: 'wx', mode: 0o600 }]])
    await unlink(file)
    await stopDockerOwner(f.owner(), f.id, 0, f.dependencies)
    expect(await restartDockerOwner(f.owner(), f.id, f.client, 0, f.dependencies)).toMatchObject({ status: 'ready', containerId: f.id })
    expect(f.commands.filter(args => args.includes('run'))).toHaveLength(2)
    expect(await readDockerOwner(started.owner.path, started.owner.sha256)).toEqual(f.owner())
  })
  it.each(['missing', 'public', 'symlink', 'oversized', 'invalid-utf8', 'malformed', 'unknown', 'initialize', 'test-tls', 'timeout', 'scope', 'conflict'])('refuses %s coordinator input before token, Docker or owner access', async fault => {
    const f = await fixture(), file = f.options.ownerFile + '.coordinator', config: any = sharedRateConfig()
    if (fault === 'unknown') config.credentialDiscovery = 'PRIVATE'
    if (fault === 'initialize') config.initialize = true
    if (fault === 'test-tls') { config.connection.host = '127.0.0.1'; config.connection.tls = { mode: 'loopback-test' } }
    if (fault === 'timeout') config.statementTimeoutMs = config.timeoutMs + 1
    if (fault === 'scope') config.scope = 'PRIVATE_INVALID_SCOPE'
    await writeFile(file, JSON.stringify(config), { mode: 0o600 })
    if (fault === 'missing') await unlink(file)
    if (fault === 'public') await chmod(file, 0o644)
    if (fault === 'symlink') await symlink(file, file + '.link')
    if (fault === 'oversized') await writeFile(file, ' '.repeat(65537))
    if (fault === 'invalid-utf8') await writeFile(file, Buffer.from([0xff]))
    if (fault === 'malformed') await writeFile(file, '{PRIVATE_QUOTA_PASSWORD')
    const secrets = vi.spyOn(secretFiles, 'readSecretFile')
    try {
      await expect(startDockerOwner({ ...f.options, rateCoordinatorFile: fault === 'symlink' ? file + '.link' : file,
        ...(fault === 'conflict' ? { rateLimitsFile: '/never-read-policy' } : {}) }, f.dependencies)).rejects.toHaveProperty('code', 'invalid-options')
      expect(secrets).not.toHaveBeenCalled(); expect(f.commands).toEqual([])
      await expect(readFile(f.options.ownerFile)).rejects.toHaveProperty('code', 'ENOENT')
    } finally { secrets.mockRestore() }
  })
  it.each(['missing', 'local', 'policy', 'algorithm', 'scope-kind', 'persistence', 'retry', 'authority', 'scope-id', 'policy-hash', 'deadline', 'extra', 'coordinator-extra'])('refuses shared quota %s capability drift before health or mutation', async fault => {
    const f = await fixture(), file = f.options.ownerFile + '.coordinator', config = sharedRateConfig()
    await writeFile(file, JSON.stringify(config), { mode: 0o600 })
    await startDockerOwner({ ...f.options, rateCoordinatorFile: file }, f.dependencies)
    const reported: any = sharedRateCapability(config)
    if (fault === 'policy') reported.requests.capacity++
    if (fault === 'algorithm') reported.algorithm = 'token-bucket'
    if (fault === 'scope-kind') reported.scope = 'runtime-instance'
    if (fault === 'persistence') reported.persistence = false
    if (fault === 'retry') reported.automaticRetry = true
    if (fault === 'authority') reported.controls.authority = 'all-callers'
    if (fault === 'scope-id') reported.coordinator.scope = randomUUID()
    if (fault === 'policy-hash') reported.coordinator.policySha256 = 'a'.repeat(64)
    if (fault === 'deadline') reported.coordinator.timeoutMs++
    if (fault === 'extra') reported.reset = true
    if (fault === 'coordinator-extra') reported.coordinator.reset = true
    f.reportRateLimits(fault === 'missing' ? undefined : fault === 'local' ? rateCapability() : reported)
    const reads = f.healthReads(), count = f.commands.length
    expect(await restartDockerOwner(f.owner(), f.id, f.client, 1000, f.dependencies)).toMatchObject({ status: 'starting',
      service: { status: 'unavailable', code: 'invalid-response' } })
    expect(f.healthReads()).toBe(reads)
    expect(f.commands.slice(count).some(args => ['start', 'kill', 'run'].includes(args[2]!))).toBe(false)
  })
  it('rejects unexpectedly coordinated capabilities on both legacy and local-policy owners', async () => {
    for (const localPolicy of [false, true]) {
      const f = await fixture(), file = f.options.ownerFile + '.rates'
      await writeFile(file, JSON.stringify(ratePolicy), { mode: 0o600 })
      await startDockerOwner({ ...f.options, ...(localPolicy ? { rateLimitsFile: file } : {}) }, f.dependencies)
      f.reportRateLimits(sharedRateCapability(sharedRateConfig()))
      const reads = f.healthReads()
      expect((await inspectDockerOwner(f.owner(), f.client, f.dependencies)).service).toMatchObject({ status: 'unavailable', code: 'invalid-response' })
      expect(f.healthReads()).toBe(reads)
    }
  })
  it.each(['rate-limit', 'rate-coordinator-unavailable'])('does not poll or restart after shared quota health refusal %s', async code => {
    const f = await fixture(), file = f.options.ownerFile + '.coordinator'
    await writeFile(file, JSON.stringify(sharedRateConfig()), { mode: 0o600 })
    await startDockerOwner({ ...f.options, rateCoordinatorFile: file }, f.dependencies)
    f.healthError(new RuntimeHttpError(code, code === 'rate-limit' ? 429 : 503))
    const reads = f.healthReads(), count = f.commands.length
    expect(await restartDockerOwner(f.owner(), f.id, f.client, 60000, f.dependencies)).toMatchObject({ status: 'starting',
      service: { status: 'unavailable', code } })
    expect(f.healthReads()).toBe(reads + 1)
    expect(f.commands.slice(count).some(args => ['start', 'kill', 'run'].includes(args[2]!))).toBe(false)
  })
  it.each(['removed', 'changed-path'])('rejects %s staged coordinator argument before restarting', async fault => {
    const f = await fixture(), file = f.options.ownerFile + '.coordinator'
    await writeFile(file, JSON.stringify(sharedRateConfig()), { mode: 0o600 })
    await startDockerOwner({ ...f.options, rateCoordinatorFile: file }, f.dependencies)
    await stopDockerOwner(f.owner(), f.id, 0, f.dependencies)
    if (fault === 'removed') f.container().Config.Cmd.splice(-2)
    else f.container().Config.Cmd[f.container().Config.Cmd.length - 1] = '/config/other.json'
    await expect(restartDockerOwner(f.owner(), f.id, f.client, 0, f.dependencies)).rejects.toHaveProperty('code', 'state-mismatch')
    expect(f.commands.some(args => args[2] === 'start')).toBe(false)
  })
  it('forwards shared-quota Docker startup and discovers its mutually exclusive grammar without I/O', async () => {
    const f = await fixture(), imageFile = f.options.ownerFile + '.image', bytes = JSON.stringify(image)
    await writeFile(imageFile, bytes, { mode: 0o600 })
    const begin = vi.spyOn(ownerApi, 'startDockerOwner').mockResolvedValue({ status: 'ready' } as never)
    const argv = ['runtime', 'start', '--runtime', 'docker', '--image-receipt', imageFile, '--receipt-sha256', digest(bytes),
      '--owner-file', f.options.ownerFile, '--port', '18787', '--token-file', f.options.tokenFile, '--tls-cert-file', tls.cert,
      '--tls-key-file', tls.key, '--rate-coordinator-file', 'reviewed-private-quota.json']
    try {
      expect(await main(argv, { out() {}, err() {} })).toBe(0)
      expect(begin).toHaveBeenCalledWith(expect.objectContaining({ rateCoordinatorFile: 'reviewed-private-quota.json' }))
      begin.mockClear()
      const files = vi.spyOn(artifactFiles, 'readBoundedBytes')
      try {
        expect(await main([...argv, '--rate-limits-file', '/never-read-policy'], { out() {}, err() {} })).toBe(2)
        expect(files).not.toHaveBeenCalled(); expect(begin).not.toHaveBeenCalled()
        let out = ''
        expect(await main(['help', 'runtime', 'start', '--json'], { out: value => { out += value }, err() {} })).toBe(0)
        const variant = JSON.parse(out).variants.find((v: any) => v.profile.startsWith('docker'))
        expect(variant.options['rate-coordinator-file']).toBe('string')
        expect(variant.requirements.rules).toContainEqual({ kind: 'exactly-one', flags: ['rate-limits-file', 'rate-coordinator-file'],
          when: { any: [{ flag: 'rate-limits-file', present: true }, { flag: 'rate-coordinator-file', present: true }] } })
        expect(files).not.toHaveBeenCalled()
      } finally { files.mockRestore() }
    } finally { begin.mockRestore() }
  })
  it.each(['sqlite', 'postgres'] as const)('pins optional %s async admission through inspection and exact clean restart, without policy mutation', async storage => {
    const f = await fixture(storage), asyncRuns = { maxConcurrentRuns: 2 }
    const started = await startDockerOwner({ ...f.options, asyncRuns }, f.dependencies)
    expect(started).toMatchObject({ status: 'ready', service: { activeAsyncRuns: 0 } })
    expect(f.owner().asyncRuns).toEqual({ maxConcurrentRuns: 2 })
    expect(f.container().Config.Cmd.slice(-2)).toEqual(['--async-concurrency', '2'])
    expect(JSON.parse(f.provisioned())).not.toHaveProperty('asyncRuns') // No new secret/config file or daemon.
    expect(await readDockerOwner(started.owner.path, started.owner.sha256)).toEqual(f.owner())
    asyncRuns.maxConcurrentRuns = 64
    f.activeAsyncRuns(1)
    const inspected = await inspectDockerOwner(f.owner(), f.client, f.dependencies)
    expect(inspected.service).toMatchObject({ status: 'ready', activeAsyncRuns: 1 })
    f.faults.hold = true
    expect((await stopDockerOwner(f.owner(), f.id, 0, f.dependencies)).status).toBe('draining')
    f.serviceStatus('draining')
    expect((await restartDockerOwner(f.owner(), f.id, f.client, 0, f.dependencies)).status).toBe('draining')
    expect(f.commands.filter(args => args[2] === 'start')).toHaveLength(0)
    f.faults.hold = false
    expect((await stopDockerOwner(f.owner(), f.id, 0, f.dependencies)).status).toBe('stopped')
    f.serviceStatus('ready'); f.activeAsyncRuns(0)
    const restarted = await restartDockerOwner(f.owner(), f.id, f.client, 0, f.dependencies)
    expect(restarted).toMatchObject({ status: 'ready', containerId: f.id, service: { activeAsyncRuns: 0 } })
    if (restarted.service?.status !== 'ready' || inspected.service.status !== 'ready' || !('instanceId' in inspected.service)) throw Error('Fixture readiness not proven')
    expect(restarted.service.instanceId).not.toBe(inspected.service.instanceId)
    expect(f.owner().asyncRuns).toEqual({ maxConcurrentRuns: 2 })
    expect(f.commands.filter(args => args[2] === 'run')).toHaveLength(2)
    expect(f.commands.filter(args => args[2] === 'start')).toHaveLength(1)
  })
  it.each([1, 64])('accepts bounded async capacity %i with no execution during startup', async maxConcurrentRuns => {
    const f = await fixture()
    expect((await startDockerOwner({ ...f.options, asyncRuns: { maxConcurrentRuns } }, f.dependencies)).status).toBe('ready')
    expect(f.owner().asyncRuns).toEqual({ maxConcurrentRuns })
    expect(f.container().Config.Cmd.slice(-2)).toEqual(['--async-concurrency', String(maxConcurrentRuns)])
    expect(f.commands.some(args => args.includes('submit') || args.includes('resume') || args.includes('approve'))).toBe(false)
  })
  it.each(['sqlite', 'postgres'] as const)('keeps omitted %s async policy compatible with absent/false legacy capabilities and refuses unexpected enablement', async storage => {
    const f = await fixture(storage); await startDockerOwner(f.options, f.dependencies)
    expect(f.owner()).not.toHaveProperty('asyncRuns'); expect(f.container().Config.Cmd).not.toContain('--async-concurrency')
    expect((await inspectDockerOwner(f.owner(), f.client, f.dependencies)).service).not.toHaveProperty('activeAsyncRuns')
    f.reportAsyncRuns(false)
    expect((await inspectDockerOwner(f.owner(), f.client, f.dependencies)).service.status).toBe('ready')
    const reads = f.healthReads(); f.reportAsyncRuns(asyncCapability(1))
    expect((await inspectDockerOwner(f.owner(), f.client, f.dependencies)).service).toMatchObject({ status: 'unavailable', code: 'invalid-response' })
    expect(f.healthReads()).toBe(reads)
    f.reportAsyncRuns(false); f.activeAsyncRuns(0)
    expect((await inspectDockerOwner(f.owner(), f.client, f.dependencies)).service).toMatchObject({ status: 'unavailable', code: 'invalid-response' })
  })
  it.each([null, {}, [], { maxConcurrentRuns: 0 }, { maxConcurrentRuns: 65 }, { maxConcurrentRuns: 1.5 },
    { maxConcurrentRuns: '2' }, { maxConcurrentRuns: 2, automaticResume: true }])('refuses invalid async startup policy %j before files, Docker or publication', async asyncRuns => {
    const f = await fixture()
    await expect(startDockerOwner({ ...f.options, tokenFile: '/never-read', asyncRuns } as any, f.dependencies)).rejects.toMatchObject({ code: 'invalid-options' })
    expect(f.commands).toEqual([]); await expect(readFile(f.options.ownerFile)).rejects.toHaveProperty('code', 'ENOENT')
  })
  it.each(['missing', 'false', 'capacity', 'status', 'authority', 'release', 'admission', 'resume', 'extra'])('refuses %s async capability drift before health, without replacing or restarting the owner', async fault => {
    const f = await fixture(); await startDockerOwner({ ...f.options, asyncRuns: { maxConcurrentRuns: 2 } }, f.dependencies)
    const reported: any = asyncCapability(2)
    if (fault === 'capacity') reported.maxConcurrentRuns = 1
    if (fault === 'status') reported.status = 'private-results'
    if (fault === 'authority') reported.authority = 'delegated'
    if (fault === 'release') reported.release = 'exact-release; read-hash-header-required'
    if (fault === 'admission') reported.admission = 'queued'
    if (fault === 'resume') reported.automaticResume = true
    if (fault === 'extra') reported.queue = true
    f.reportAsyncRuns(fault === 'missing' ? undefined : fault === 'false' ? false : reported)
    const reads = f.healthReads(), count = f.commands.length
    expect(await restartDockerOwner(f.owner(), f.id, f.client, 1000, f.dependencies)).toMatchObject({ status: 'starting',
      service: { status: 'unavailable', code: 'invalid-response' } })
    expect(f.healthReads()).toBe(reads)
    expect(f.commands.slice(count).some(args => ['start', 'kill', 'run'].includes(args[2]!))).toBe(false)
  })
  it.each([undefined, null, -1, 3, 1.5, '1'])('refuses invalid configured async health count %j without taking over completion', async count => {
    const f = await fixture(); await startDockerOwner({ ...f.options, asyncRuns: { maxConcurrentRuns: 2 } }, f.dependencies)
    f.activeAsyncRuns(count)
    expect((await inspectDockerOwner(f.owner(), f.client, f.dependencies)).service).toMatchObject({ status: 'unavailable', code: 'invalid-response' })
  })
  it.each(['enabled', 'omitted'])('refuses a changed %s service command before a lifecycle signal', async policy => {
    const f = await fixture()
    await startDockerOwner({ ...f.options, ...(policy === 'enabled' ? { asyncRuns: { maxConcurrentRuns: 2 } } : {}) }, f.dependencies)
    if (policy === 'enabled') f.container().Config.Cmd[f.container().Config.Cmd.length - 1] = '3'
    else f.container().Config.Cmd.push('--async-concurrency', '1')
    const count = f.commands.length
    await expect(stopDockerOwner(f.owner(), f.id, 0, f.dependencies)).rejects.toMatchObject({ code: 'state-mismatch' })
    expect(f.commands.slice(count).some(args => args[2] === 'kill')).toBe(false)
  })
  it('forwards the Docker CLI startup policy to the owned SDK and refuses lifecycle policy overrides', async () => {
    const f = await fixture(), receiptFile = f.options.ownerFile + '.image'
    await writeFile(receiptFile, JSON.stringify(image), { mode: 0o600 })
    const start = vi.spyOn(ownerApi, 'startDockerOwner').mockResolvedValue({ status: 'ready' } as any)
    try {
      const args = ['runtime', 'start', '--runtime', 'docker', '--image-receipt', receiptFile, '--receipt-sha256', digest(await readFile(receiptFile)),
        '--owner-file', f.options.ownerFile, '--port', '18787', '--token-file', f.options.tokenFile,
        '--tls-cert-file', tls.cert, '--tls-key-file', tls.key, '--async-concurrency', '2']
      expect(await main(args, { out: () => {}, err: () => {} })).toBe(0)
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ asyncRuns: { maxConcurrentRuns: 2 } }))
      for (const action of ['inspect', 'stop', 'restart'])
        expect(await main(['runtime', action, '--runtime', 'docker', '--async-concurrency', '2'], { out: () => {}, err: () => {} })).toBe(2)
      expect(start).toHaveBeenCalledTimes(1)
    } finally { start.mockRestore() }
  })
  it.each(['0', '65', '01', '1e1', '-1', '9007199254740992'])('refuses Docker CLI capacity %s before image/credential files', async capacity => {
    const out: string[] = [], err: string[] = []
    const files = vi.spyOn(artifactFiles, 'readBoundedBytes'), secrets = vi.spyOn(secretFiles, 'readSecretFile')
    try {
      expect(await main(['runtime', 'start', '--runtime', 'docker', '--async-concurrency', capacity,
        '--image-receipt', '/never-read-image', '--receipt-sha256', 'a'.repeat(64), '--owner-file', '/never-written-owner',
        '--port', '18787', '--token-file', '/never-read-token', '--tls-cert-file', '/never-read-cert', '--tls-key-file', '/never-read-key'],
      { out: value => out.push(value), err: value => err.push(value) })).toBe(2)
      expect(err.join('')).toContain('invalid-input'); expect(out).toEqual([])
      expect(files).not.toHaveBeenCalled(); expect(secrets).not.toHaveBeenCalled()
    } finally { files.mockRestore(); secrets.mockRestore() }
  })
  it.each(['sqlite', 'postgres'] as const)('pins and privately stages a canonical %s rate policy, preserving it across clean restart', async storage => {
    const f = await fixture(storage), rateLimitsFile = f.options.ownerFile + '.rates'
    // Submitted key order and whitespace do not change the validated startup policy identity.
    await writeFile(rateLimitsFile, JSON.stringify({ controls: { refillIntervalMs: 3600000, refillTokens: 1, capacity: 7 },
      requests: { refillTokens: 2, refillIntervalMs: 1000, capacity: 3 } }, null, 2), { mode: 0o600 })
    const started = await startDockerOwner({ ...f.options, rateLimitsFile }, f.dependencies)
    expect(started.status).toBe('ready')
    const canonical = JSON.stringify(httpRateLimitsSchema.parse(ratePolicy)), staged = JSON.parse(f.provisioned()).rateLimits
    expect(staged).toBe(canonical); expect(f.owner().rateLimits).toEqual({ sha256: digest(canonical) })
    expect(f.container().Config.Cmd.slice(-2)).toEqual(['--rate-limits-file', '/config/rate-limits.json'])
    expect(f.container().Mounts.find((mount: any) => mount.Destination === '/config').RW).toBe(false)
    expect(JSON.stringify([started, f.owner(), f.commands])).not.toContain(rateLimitsFile)
    expect(f.commands.filter(args => args.includes('--rm')).every(args => args[args.indexOf('--network') + 1] === 'none')).toBe(true)
    // Execute the exact generated initializer with a confined fs/process double: no host /data writes.
    const initializer = f.commands.find(args => args.includes('-e'))!, writes: any[] = [], events: Record<string, Function> = {}
    new Script(initializer.at(-1)!).runInNewContext({ Buffer,
      require: (name: string) => { expect(name).toBe('node:fs'); return { writeFileSync: (...args: any[]) => { writes.push(args) } } },
      process: { stdin: { setEncoding() {}, on: (name: string, fn: Function) => { events[name] = fn } },
        stdout: { write: (s: string) => { expect(s).toBe('initialized') } }, stderr: { write: () => { throw Error('initializer failed') } } } })
    events.data!(f.provisioned()); events.end!()
    expect(writes.filter(write => write[0] === '/data/rate-limits.json')).toEqual([['/data/rate-limits.json', canonical, { flag: 'wx', mode: 0o600 }]])
    expect(writes.every(write => write[2].flag === 'wx' && write[2].mode === 0o600)).toBe(true)
    await unlink(rateLimitsFile); await stopDockerOwner(f.owner(), f.id, 0, f.dependencies)
    const restarted = await restartDockerOwner(f.owner(), f.id, f.client, 0, f.dependencies)
    expect(restarted.status).toBe('ready'); expect(restarted.containerId).toBe(f.id)
    expect(f.commands.filter(args => args.includes('run'))).toHaveLength(2)
    expect(await readDockerOwner(started.owner.path, started.owner.sha256)).toEqual(f.owner())
  })
  it.each(['sqlite', 'postgres'] as const)('preserves omitted %s owner policy and rejects an unexpected service policy', async storage => {
    const f = await fixture(storage); await startDockerOwner(f.options, f.dependencies)
    expect(f.owner()).not.toHaveProperty('rateLimits'); expect(JSON.parse(f.provisioned())).not.toHaveProperty('rateLimits')
    expect(f.container().Config.Cmd).not.toContain('--rate-limits-file')
    expect((await inspectDockerOwner(f.owner(), f.client, f.dependencies)).service.status).toBe('ready')
    f.reportRateLimits(rateCapability())
    expect((await inspectDockerOwner(f.owner(), f.client, f.dependencies)).service).toMatchObject({ status: 'unavailable', code: 'invalid-response' })
  })
  it.each(['missing', 'public', 'symlink', 'oversized', 'invalid-utf8', 'malformed', 'array', 'unknown', 'missing-controls', 'zero', 'fractional', 'too-fast'])('refuses %s rate policy before any Docker access or owner publication', async fault => {
    const f = await fixture(), file = f.options.ownerFile + '.rates'
    await writeFile(file, JSON.stringify(ratePolicy), { mode: 0o600 })
    if (fault === 'missing') await unlink(file)
    if (fault === 'public') await chmod(file, 0o644)
    if (fault === 'symlink') await symlink(file, file + '.link')
    if (fault === 'oversized') await writeFile(file, ' '.repeat(4097))
    if (fault === 'invalid-utf8') await writeFile(file, Buffer.from([0xff]))
    if (fault === 'malformed') await writeFile(file, '{PRIVATE')
    if (fault === 'array') await writeFile(file, '[]')
    if (fault === 'unknown') await writeFile(file, JSON.stringify({ ...ratePolicy, account: 'PRIVATE' }))
    if (fault === 'missing-controls') await writeFile(file, JSON.stringify({ requests: ratePolicy.requests }))
    if (['zero', 'fractional', 'too-fast'].includes(fault)) await writeFile(file, JSON.stringify({ ...ratePolicy,
      requests: { ...ratePolicy.requests, ...(fault === 'too-fast' ? { refillIntervalMs: 999 } : { capacity: fault === 'zero' ? 0 : 1.5 }) } }))
    await expect(startDockerOwner({ ...f.options, rateLimitsFile: fault === 'symlink' ? file + '.link' : file }, f.dependencies)).rejects.toThrow()
    expect(f.commands).toEqual([]); await expect(readFile(f.options.ownerFile)).rejects.toHaveProperty('code', 'ENOENT')
  })
  it.each(['missing', 'changed', 'algorithm', 'scope', 'persistence', 'retry', 'authority', 'extra'])('refuses %s rate-capability drift before health or readiness without owner replacement', async fault => {
    const f = await fixture(), file = f.options.ownerFile + '.rates'
    await writeFile(file, JSON.stringify(ratePolicy), { mode: 0o600 }); await startDockerOwner({ ...f.options, rateLimitsFile: file }, f.dependencies)
    const reported: any = rateCapability()
    if (fault === 'changed') reported.requests = { ...reported.requests, capacity: 4 }
    if (fault === 'algorithm') reported.algorithm = 'fixed-window'
    if (fault === 'scope') reported.scope = 'account'
    if (fault === 'persistence') reported.persistence = true
    if (fault === 'retry') reported.automaticRetry = true
    if (fault === 'authority') reported.controls = { ...reported.controls, authority: 'all-callers' }
    if (fault === 'extra') reported.unreviewed = true
    f.reportRateLimits(fault === 'missing' ? undefined : reported)
    const reads = f.healthReads(), count = f.commands.length
    expect(await restartDockerOwner(f.owner(), f.id, f.client, 1000, f.dependencies)).toMatchObject({ status: 'starting', containerId: f.id,
      service: { status: 'unavailable', code: 'invalid-response' } })
    expect(f.healthReads()).toBe(reads); expect(f.commands.slice(count).some(args => args[2] === 'start' || args[2] === 'kill' || args[2] === 'run')).toBe(false)
  })
  it('does not automatically poll, restart or evade an exhausted health-control bucket', async () => {
    const f = await fixture(), file = f.options.ownerFile + '.rates'
    await writeFile(file, JSON.stringify(ratePolicy), { mode: 0o600 }); await startDockerOwner({ ...f.options, rateLimitsFile: file }, f.dependencies)
    f.healthError(new RuntimeHttpError('rate-limit', 429, 3600))
    const reads = f.healthReads(), count = f.commands.length
    expect(await restartDockerOwner(f.owner(), f.id, f.client, 60000, f.dependencies)).toMatchObject({ status: 'starting', containerId: f.id,
      service: { status: 'unavailable', code: 'rate-limit', retryAfterSeconds: 3600 } })
    expect(f.healthReads()).toBe(reads + 1); expect(f.commands.slice(count).some(args => args[2] === 'start' || args[2] === 'kill' || args[2] === 'run')).toBe(false)
  })
  it('forwards only Docker-start rate policy through the reviewed image CLI path', async () => {
    const f = await fixture(), imageFile = f.options.ownerFile + '.image', imageBytes = JSON.stringify(image)
    await writeFile(imageFile, imageBytes, { mode: 0o600 })
    const begin = vi.spyOn(ownerApi, 'startDockerOwner').mockResolvedValue({ status: 'ready' } as never)
    try {
      expect(await main(['runtime', 'start', '--runtime', 'docker', '--image-receipt', imageFile, '--receipt-sha256', digest(imageBytes),
        '--owner-file', f.options.ownerFile, '--port', '18787', '--token-file', f.options.tokenFile, '--tls-cert-file', tls.cert,
        '--tls-key-file', tls.key, '--rate-limits-file', 'reviewed-private-rates.json'], { out() {}, err() {} })).toBe(0)
      expect(begin).toHaveBeenCalledWith(expect.objectContaining({ image, rateLimitsFile: 'reviewed-private-rates.json' }))
      expect(f.commands).toEqual([])
    } finally { begin.mockRestore() }
  })
  it.each(['removed', 'changed-path'])('refuses %s staged policy argument without restarting the reviewed container', async fault => {
    const f = await fixture(), file = f.options.ownerFile + '.rates'
    await writeFile(file, JSON.stringify(ratePolicy), { mode: 0o600 }); await startDockerOwner({ ...f.options, rateLimitsFile: file }, f.dependencies)
    await stopDockerOwner(f.owner(), f.id, 0, f.dependencies)
    if (fault === 'removed') f.container().Config.Cmd.splice(-2)
    else f.container().Config.Cmd[f.container().Config.Cmd.length - 1] = '/config/other.json'
    await expect(restartDockerOwner(f.owner(), f.id, f.client, 0, f.dependencies)).rejects.toHaveProperty('code', 'state-mismatch')
    expect(f.commands.some(args => args[2] === 'start')).toBe(false)
  })
  it.each(['sqlite', 'postgres'] as const)('stages explicit %s notification configuration privately without keys or delivery', async storage => {
    const f = await fixture(storage), notificationsFile = f.options.ownerFile + '.notifications'
    const config = { endpoints: [{ id: 'review', url: 'https://receiver.invalid/PRIVATE_DESTINATION', credentialRef: 'PRIVATE_KEY_REF', timeoutMs: 2000 }] }
    await writeFile(notificationsFile, JSON.stringify(config), { mode: 0o600 })
    const started = await startDockerOwner({ ...f.options, notificationsFile }, f.dependencies)
    const staged = JSON.parse(f.provisioned()).notifications
    expect(JSON.parse(staged)).toEqual(parseNotificationConfig(config)); expect(f.owner().notifications).toEqual({ sha256: digest(staged) })
    expect(f.container().Config.Cmd).toEqual(expect.arrayContaining(['--notifications-file', '/config/notifications.json']))
    expect(f.container().Config.Env.some((v: string) => v.startsWith('NODE_EXTRA_CA_CERTS='))).toBe(false)
    expect(f.commands.some(args => args.includes('credentials') || args.includes('send'))).toBe(false)
    expect(JSON.stringify([f.owner(), started, f.commands])).not.toMatch(/PRIVATE_DESTINATION|PRIVATE_KEY_REF|receiver.invalid/)
    expect(f.commands.filter(args => args.includes('--rm')).every(args => args[args.indexOf('--network') + 1] === 'none')).toBe(true)
    await unlink(notificationsFile); await stopDockerOwner(f.owner(), f.id, 0, f.dependencies)
    expect((await restartDockerOwner(f.owner(), f.id, f.client, 0, f.dependencies)).status).toBe('ready')
    expect(f.commands.filter(args => args.includes('run'))).toHaveLength(2)
  })
  it.each([false, true])('retains explicit notification CA trust with telemetry CA=%s across restart', async telemetry => {
    const f = await fixture(), notificationsFile = f.options.ownerFile + '.notifications', notificationsCaFile = f.options.ownerFile + '.notifications-ca'
    const telemetryFile = f.options.ownerFile + '.telemetry', telemetryCaFile = f.options.ownerFile + '.telemetry-ca'
    const other = await createTlsFixture(await mkdtemp(join(tmpdir(), 'jevable-notification-other-ca-')), undefined, 'jevable-other-ca')
    await writeFile(notificationsFile, JSON.stringify({ endpoints: [{ id: 'review', url: 'https://receiver.invalid/events', credentialRef: 'review/key', timeoutMs: 2000 }] }), { mode: 0o600 })
    await writeFile(notificationsCaFile, tls.ca, { mode: 0o600 }); await writeFile(telemetryCaFile, other.ca, { mode: 0o600 })
    await writeFile(telemetryFile, JSON.stringify({ endpoint: 'https://collector.invalid/v1/traces', authentication: { kind: 'none' } }), { mode: 0o600 })
    await startDockerOwner({ ...f.options, notificationsFile, notificationsCaFile, ...(telemetry ? { telemetryFile, telemetryCaFile } : {}) }, f.dependencies)
    expect(f.owner().notifications?.caSha256).toBe(digest(tls.ca))
    const staged = JSON.parse(f.provisioned()); expect(staged.runtimeCa).toBe(telemetry ? other.ca + '\n' + tls.ca : tls.ca)
    expect(f.owner().telemetry?.caSha256).toBe(telemetry ? digest(other.ca) : undefined)
    expect(f.container().Config.Env).toContain('NODE_EXTRA_CA_CERTS=/config/runtime-ca.pem')
    expect(JSON.stringify([f.owner(), f.commands])).not.toContain('BEGIN CERTIFICATE')
    for (const file of [notificationsFile, notificationsCaFile, telemetryFile, telemetryCaFile]) await unlink(file)
    await stopDockerOwner(f.owner(), f.id, 0, f.dependencies)
    expect((await restartDockerOwner(f.owner(), f.id, f.client, 0, f.dependencies)).status).toBe('ready')
  })
  it.each(['public', 'symlink', 'oversized', 'unknown', 'secret', 'duplicate-id', 'malformed'])('rejects %s notification configuration before Docker access', async fault => {
    const f = await fixture(), file = f.options.ownerFile + '.notifications'
    const endpoint = { id: 'review', url: 'https://receiver.invalid/events', credentialRef: 'review/key', timeoutMs: 2000 }
    await writeFile(file, JSON.stringify({ endpoints: [endpoint] }), { mode: 0o600 })
    if (fault === 'public') await chmod(file, 0o644)
    if (fault === 'symlink') await symlink(file, file + '.link')
    if (fault === 'oversized') await writeFile(file, ' '.repeat(100001))
    if (fault === 'unknown') await writeFile(file, '{"discover":true}')
    if (fault === 'secret') await writeFile(file, JSON.stringify({ endpoints: [{ ...endpoint, signingKey: 'PRIVATE_KEY' }] }))
    if (fault === 'duplicate-id') await writeFile(file, JSON.stringify({ endpoints: [endpoint, endpoint] }))
    if (fault === 'malformed') await writeFile(file, '{PRIVATE')
    await expect(startDockerOwner({ ...f.options, notificationsFile: fault === 'symlink' ? file + '.link' : file }, f.dependencies)).rejects.toThrow()
    expect(f.commands).toEqual([]); await expect(readFile(f.options.ownerFile)).rejects.toHaveProperty('code', 'ENOENT')
  })
  it.each(['absent-config', 'http-only', 'public-ca', 'symlink-ca', 'invalid-ca'])('rejects %s notification trust before Docker access', async fault => {
    const f = await fixture(), file = f.options.ownerFile + '.notifications', ca = f.options.ownerFile + '.notification-ca'
    await writeFile(file, JSON.stringify({ endpoints: [{ id: 'review', url: fault === 'http-only' ? 'http://127.0.0.1/events' : 'https://receiver.invalid/events', credentialRef: 'review/key', timeoutMs: 2000 }] }), { mode: 0o600 })
    await writeFile(ca, fault === 'invalid-ca' ? 'PRIVATE_INVALID_CA' : tls.ca, { mode: 0o600 })
    if (fault === 'public-ca') await chmod(ca, 0o644)
    if (fault === 'symlink-ca') await symlink(ca, ca + '.link')
    await expect(startDockerOwner({ ...f.options, ...(fault === 'absent-config' ? {} : { notificationsFile: file }),
      notificationsCaFile: fault === 'symlink-ca' ? ca + '.link' : ca }, f.dependencies)).rejects.toThrow()
    expect(f.commands).toEqual([]); await expect(readFile(f.options.ownerFile)).rejects.toHaveProperty('code', 'ENOENT')
  })
  it.each(['config-argument', 'trust-path', 'extra-override'])('refuses notification %s drift without restarting', async fault => {
    const f = await fixture(), file = f.options.ownerFile + '.notifications', ca = f.options.ownerFile + '.notification-ca'
    await writeFile(file, JSON.stringify({ endpoints: [{ id: 'review', url: 'https://receiver.invalid/events', credentialRef: 'review/key', timeoutMs: 2000 }] }), { mode: 0o600 })
    await writeFile(ca, tls.ca, { mode: 0o600 })
    await startDockerOwner({ ...f.options, notificationsFile: file, notificationsCaFile: ca }, f.dependencies)
    await stopDockerOwner(f.owner(), f.id, 0, f.dependencies)
    if (fault === 'config-argument') f.container().Config.Cmd.pop()
    if (fault === 'trust-path') f.container().Config.Env = ['NODE_EXTRA_CA_CERTS=/config/telemetry-ca.pem']
    if (fault === 'extra-override') f.container().Config.Env.push('NODE_TLS_REJECT_UNAUTHORIZED=0')
    await expect(restartDockerOwner(f.owner(), f.id, f.client, 0, f.dependencies)).rejects.toHaveProperty('code', 'state-mismatch')
    expect(f.commands.filter(args => args[2] === 'start')).toEqual([])
  })
  it('stages PostgreSQL privately without a SQLite volume and restarts after the host database file is gone', async () => {
    const f = await fixture('postgres'), started = await startDockerOwner({ ...f.options, network }, f.dependencies)
    expect(started).toMatchObject({ storage: 'postgres', status: 'ready' })
    const staged = JSON.parse(f.provisioned()).database
    expect(JSON.parse(staged)).toEqual(parsePostgresConfiguration(f.database))
    expect(f.owner().database).toEqual({ sha256: digest(staged) })
    expect(f.createdVolumes).toHaveLength(1); expect(started.resources.stateVolume).toBeUndefined()
    expect(f.container().Config.Cmd).toEqual(expect.arrayContaining(['--storage', 'postgres', '--database-file', '/config/database.json']))
    expect(f.container().Config.Cmd).not.toContain('--data-dir')
    expect(f.container().Mounts).toHaveLength(1); expect(f.container().Mounts[0]).toMatchObject({ Destination: '/config', RW: false })
    expect(JSON.stringify([f.owner(), started, f.commands])).not.toMatch(/PRIVATE_DATABASE_|database\.fixture/u)
    await unlink(f.databaseFile)
    expect((await stopDockerOwner(f.owner(), f.id, 0, f.dependencies)).status).toBe('stopped')
    expect((await restartDockerOwner(f.owner(), f.id, f.client, 0, f.dependencies)).status).toBe('ready')
    expect(f.commands.filter(args => args.includes('run'))).toHaveLength(2)
  })
  it.each([false, true])('uses the PostgreSQL credential store with explicit initial provisioning=%s', async provisionCredential => {
    const f = await fixture('postgres'), telemetryFile = f.options.ownerFile + '.telemetry', secret = f.options.ownerFile + '.secret'
    await writeFile(telemetryFile, JSON.stringify({ endpoint: 'https://collector.invalid/v1/traces', authentication: { kind: 'bearer', credentialRef: 'otel/key' } }), { mode: 0o600 })
    await writeFile(secret, 'PRIVATE_POSTGRES_OTEL_BEARER', { mode: 0o600 })
    expect((await startDockerOwner({ ...f.options, network, telemetryFile,
      ...(provisionCredential ? { telemetryCredentialFile: secret } : {}) }, f.dependencies)).status).toBe('ready')
    const initializer = f.commands.find(args => args.includes('credentials'))
    if (provisionCredential) {
      expect(initializer).toEqual(expect.arrayContaining(['--network', network.id, '--storage', 'postgres', '--database-file', '/config/database.json', '--expected-generation', '0']))
      expect(initializer).not.toContain('--data-dir'); expect(initializer).not.toContain('--telemetry-file')
      expect(f.credentialInput()).toBe('PRIVATE_POSTGRES_OTEL_BEARER')
    } else expect(initializer).toBeUndefined()
    const staging = f.commands.find(args => args.includes('--entrypoint'))!
    expect(staging[staging.indexOf('--network') + 1]).toBe('none')
    expect(f.createdVolumes).toHaveLength(1)
  })
  it.each(['missing-file', 'public-file', 'symlink', 'oversized', 'invalid-json', 'unknown-field', 'unverified-tls', 'invalid-ca'])('rejects %s PostgreSQL configuration before Docker access or owner publication', async fault => {
    const f = await fixture('postgres'), value = { ...f.database }
    if (fault === 'public-file') await chmod(f.databaseFile, 0o644)
    if (fault === 'symlink') await symlink(f.databaseFile, f.databaseFile + '.link')
    if (fault === 'missing-file') await unlink(f.databaseFile)
    if (fault === 'oversized') await writeFile(f.databaseFile, ' '.repeat(320001))
    if (fault === 'invalid-json') await writeFile(f.databaseFile, '{PRIVATE_DATABASE_CONFIG')
    if (fault === 'unknown-field') await writeFile(f.databaseFile, JSON.stringify({ ...value, unexpected: true }))
    if (fault === 'unverified-tls') await writeFile(f.databaseFile, JSON.stringify({ ...value, host: '127.0.0.1', tls: { mode: 'loopback-test' } }))
    if (fault === 'invalid-ca') await writeFile(f.databaseFile, JSON.stringify({ ...value, tls: { mode: 'verify-full', ca: 'PRIVATE_INVALID_CA' } }))
    await expect(startDockerOwner({ ...f.options, ...(fault === 'symlink' ? { databaseFile: f.databaseFile + '.link' } : {}) }, f.dependencies)).rejects.toThrow()
    expect(f.commands).toEqual([]); await expect(readFile(f.options.ownerFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each(['missing-config', 'sqlite-config', 'invalid-storage'] as const)('rejects incompatible %s storage flags before Docker access', async fault => {
    const f = await fixture(), options = { ...f.options, ...(fault === 'missing-config' ? { storage: 'postgres' as const }
      : fault === 'sqlite-config' ? { databaseFile: f.databaseFile } : { storage: 'other' as 'sqlite' }) }
    await expect(startDockerOwner(options, f.dependencies)).rejects.toMatchObject({ code: 'invalid-options' }); expect(f.commands).toEqual([])
  })
  it.each(['backend', 'database', 'ownership'] as const)('does not report PostgreSQL readiness with invalid %s health', async fault => {
    const f = await fixture('postgres')
    if (fault === 'backend') f.faults.reportedStorage = 'sqlite'
    if (fault === 'database') f.faults.databaseHealth = 'unavailable'
    if (fault === 'ownership') f.faults.databaseState = 'lost'
    expect(await startDockerOwner({ ...f.options, waitMs: 0 }, f.dependencies)).toMatchObject({ status: 'starting', service: { status: 'unavailable', code: 'invalid-response' } })
    expect(f.commands.flat()).not.toContain('kill')
  })
  it('refuses a PostgreSQL owner with a writable SQLite mount before signalling', async () => {
    const f = await fixture('postgres'); await startDockerOwner(f.options, f.dependencies)
    f.container().Mounts.push({ Type: 'volume', Name: 'foreign', Destination: '/data', RW: true, Driver: 'local' })
    await expect(stopDockerOwner(f.owner(), f.id, 0, f.dependencies)).rejects.toMatchObject({ code: 'state-mismatch' })
    expect(f.commands.flat()).not.toContain('kill')
  })
  it('pins an existing bridge network by immutable ID, without changing it or networking initializer jobs', async () => {
    const f = await fixture(), started = await startDockerOwner({ ...f.options, network }, f.dependencies)
    expect(started.status).toBe('ready'); expect(f.owner().network).toEqual(network)
    const service = f.commands.find(args => args.includes('--detach'))!
    expect(service[service.indexOf('--network') + 1]).toBe(network.id)
    expect(f.commands.filter(args => args.includes('--rm')).every(args => args[args.indexOf('--network') + 1] === 'none')).toBe(true)
    await inspectDockerOwner(f.owner(), f.client, f.dependencies)
    await stopDockerOwner(f.owner(), f.id, 0, f.dependencies)
    expect((await restartDockerOwner(f.owner(), f.id, f.client, 0, f.dependencies)).status).toBe('ready')
    expect(f.commands.filter(args => args.includes('network')).every(args => args[3] === 'inspect')).toBe(true)
  })
  it.each(['host', 'none', 'bridge', 'ingress', 'container:other', '--host', '../other'])('rejects reserved or invalid network %s before Docker access', async name => {
    const f = await fixture()
    await expect(startDockerOwner({ ...f.options, network: { ...network, name } }, f.dependencies)).rejects.toMatchObject({ code: 'invalid-options' })
    expect(f.commands).toEqual([])
  })
  it.each(['Name', 'Id', 'Driver', 'Scope', 'Ingress'] as const)('rejects mismatched network %s before owner publication', async key => {
    const f = await fixture()
    Object.assign(f.networkInfo, { [key]: key === 'Ingress' ? true : 'unreviewed' })
    await expect(startDockerOwner({ ...f.options, network }, f.dependencies)).rejects.toMatchObject({ code: 'state-mismatch' })
    await expect(readFile(f.options.ownerFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.createdVolumes).toEqual([]); expect(f.commands.flat()).not.toContain('run')
  })
  it.each(['replaced', 'extra', 'detached', 'mode', 'renamed'] as const)('refuses %s network before restart without reconnection or fallback', async fault => {
    const f = await fixture(); await startDockerOwner({ ...f.options, network }, f.dependencies)
    await stopDockerOwner(f.owner(), f.id, 0, f.dependencies)
    if (fault === 'replaced') f.networkInfo.Id = '9'.repeat(64)
    if (fault === 'renamed') f.networkInfo.Name = 'new-name'
    if (fault === 'extra') f.container().NetworkSettings.Networks.extra = { NetworkID: '6'.repeat(64) }
    if (fault === 'detached') f.container().NetworkSettings.Networks = {}
    if (fault === 'mode') f.container().HostConfig.NetworkMode = 'bridge'
    await expect(restartDockerOwner(f.owner(), f.id, f.client, 0, f.dependencies)).rejects.toMatchObject({ code: 'state-mismatch' })
    expect(f.commands.flat()).not.toContain('start'); expect(f.commands.flat()).not.toContain('connect')
  })
  it.each(['http/protobuf', 'grpc'] as const)('stages explicit %s TLS trust once without coupling host client trust or rereading files on restart', async protocol => {
    const f = await fixture(), telemetryFile = f.options.ownerFile + '.telemetry', telemetryCaFile = f.options.ownerFile + '.ca'
    const collectorTls = await createTlsFixture(await mkdtemp(join(tmpdir(), 'jevable-collector-ca-')))
    await writeFile(telemetryFile, JSON.stringify({ protocol, endpoint: `https://collector.invalid${protocol === 'grpc' ? '' : '/v1/traces'}`,
      authentication: { kind: 'none' } }), { mode: 0o600 })
    await writeFile(telemetryCaFile, collectorTls.ca, { mode: 0o600 })
    const started = await startDockerOwner({ ...f.options, telemetryFile, telemetryCaFile }, f.dependencies)
    expect(started.status).toBe('ready')
    expect(f.owner().telemetry?.caSha256).toBe(digest(collectorTls.ca))
    expect(JSON.parse(f.provisioned()).telemetryCa).toBe(collectorTls.ca)
    expect(f.container().Config.Env).toContain('NODE_EXTRA_CA_CERTS=/config/telemetry-ca.pem')
    const serialized = JSON.stringify([f.owner(), started, f.commands])
    expect(serialized).not.toContain(telemetryCaFile); expect(serialized).not.toContain(collectorTls.ca)
    expect(serialized).not.toContain('collector.invalid')
    const initializers = f.commands.filter(args => args.includes('--rm'))
    expect(initializers.every(args => !args.includes('--env'))).toBe(true)
    // Only these exact fixture files are removed; startup has already snapshotted their bytes.
    await unlink(telemetryCaFile); await unlink(telemetryFile)
    await stopDockerOwner(f.owner(), f.id, 0, f.dependencies)
    expect((await restartDockerOwner(f.owner(), f.id, f.client, 0, f.dependencies)).status).toBe('ready')
    expect(f.commands.filter(args => args.includes('run'))).toHaveLength(2)
  })
  it.each(['absent-telemetry', 'plaintext-only', 'missing-file', 'public-file', 'symlink', 'oversized', 'invalid-pem', 'private-key', 'mixed-pem', 'invalid-utf8'])('refuses %s collector CA before Docker access or ownership publication', async fault => {
    const f = await fixture(), telemetryFile = f.options.ownerFile + '.telemetry', file = f.options.ownerFile + '.ca'
    await writeFile(telemetryFile, JSON.stringify({ endpoint: `${fault === 'plaintext-only' ? 'http://127.0.0.1' : 'https://collector.invalid'}/v1/traces`, authentication: { kind: 'none' } }), { mode: 0o600 })
    const bytes = fault === 'oversized' ? 'x'.repeat(262145) : fault === 'invalid-pem' ? 'PRIVATE_INVALID_PEM'
      : fault === 'private-key' ? await readFile(tls.key) : fault === 'mixed-pem' ? tls.ca + 'PRIVATE_TRAILING_DATA'
        : fault === 'invalid-utf8' ? Buffer.from([0xff]) : tls.ca
    if (fault !== 'missing-file') await writeFile(file, bytes, { mode: fault === 'public-file' ? 0o644 : 0o600 })
    if (fault === 'symlink') await symlink(file, file + '.link')
    await expect(startDockerOwner({ ...f.options, ...(fault === 'absent-telemetry' ? {} : { telemetryFile }),
      telemetryCaFile: fault === 'symlink' ? file + '.link' : file }, f.dependencies)).rejects.toThrow()
    expect(f.commands).toEqual([])
    await expect(readFile(f.options.ownerFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each(['NODE_EXTRA_CA_CERTS=/unreviewed.pem', 'NODE_TLS_REJECT_UNAUTHORIZED=0', 'NODE_OPTIONS=--use-openssl-ca', 'SSL_CERT_FILE=/unreviewed.pem', 'SSL_CERT_DIR=/unreviewed'])('refuses inherited image trust override %s before owner publication', async env => {
    const f = await fixture(); f.faults.imageEnv.push(env)
    await expect(startDockerOwner(f.options, f.dependencies)).rejects.toMatchObject({ code: 'invalid-options' })
    await expect(readFile(f.options.ownerFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.createdVolumes).toEqual([]); expect(f.commands.flat()).not.toContain('run')
  })
  it.each(['missing', 'changed', 'duplicate', 'insecure', 'node-options'] as const)('refuses %s service trust before restart, with no metadata repair', async change => {
    const f = await fixture(), telemetryFile = f.options.ownerFile + '.telemetry', telemetryCaFile = f.options.ownerFile + '.ca'
    await writeFile(telemetryFile, JSON.stringify({ endpoint: 'https://collector.invalid/v1/traces', authentication: { kind: 'none' } }), { mode: 0o600 })
    await writeFile(telemetryCaFile, tls.ca, { mode: 0o600 })
    await startDockerOwner({ ...f.options, telemetryFile, telemetryCaFile }, f.dependencies)
    await stopDockerOwner(f.owner(), f.id, 0, f.dependencies)
    f.container().Config.Env = change === 'missing' ? [] : change === 'changed' ? ['NODE_EXTRA_CA_CERTS=/unreviewed.pem']
      : ['NODE_EXTRA_CA_CERTS=/config/telemetry-ca.pem', change === 'duplicate' ? 'NODE_EXTRA_CA_CERTS=/config/telemetry-ca.pem'
        : change === 'insecure' ? 'NODE_TLS_REJECT_UNAUTHORIZED=0' : 'NODE_OPTIONS=--require=/unreviewed.js']
    await expect(restartDockerOwner(f.owner(), f.id, f.client, 0, f.dependencies)).rejects.toMatchObject({ code: 'state-mismatch' })
    expect(f.commands.flat()).not.toContain('start')
  })
  it.each(['none', 'bearer'] as const)('stages private telemetry and %s authentication before service startup without exposing endpoints or secrets', async kind => {
    const f = await fixture(), telemetryFile = f.options.ownerFile + '.telemetry', secretFile = f.options.ownerFile + '.secret'
    const config = { endpoint: 'https://collector.invalid/v1/traces', metricsEndpoint: 'https://collector.invalid/v1/metrics',
      logsEndpoint: 'https://collector.invalid/v1/logs', authentication: kind === 'none' ? { kind } : { kind, credentialRef: 'otel/fixture' } }
    await writeFile(telemetryFile, JSON.stringify(config), { mode: 0o600 })
    await writeFile(secretFile, 'PRIVATE_OTEL_BEARER\n', { mode: 0o600 })
    const started = await startDockerOwner({ ...f.options, telemetryFile, ...(kind === 'bearer' ? { telemetryCredentialFile: secretFile } : {}) }, f.dependencies)
    expect(started.status).toBe('ready')
    const staged = JSON.parse(f.provisioned()).telemetry
    expect(JSON.parse(staged)).toEqual(parseTelemetryConfig(config))
    expect(f.owner().telemetry).toEqual({ sha256: digest(staged), ...(kind === 'bearer' ? { credentialRef: 'otel/fixture' } : {}) })
    expect(f.container().Config.Cmd.slice(-2)).toEqual(['--telemetry-file', '/config/telemetry.json'])
    expect(JSON.stringify([f.owner(), started, f.commands])).not.toContain('PRIVATE_OTEL_BEARER')
    expect(JSON.stringify([f.owner(), started, f.commands])).not.toContain('collector.invalid')
    if (kind === 'bearer') {
      expect(f.credentialInput()).toBe('PRIVATE_OTEL_BEARER')
      const initializer = f.commands.find(args => args.includes('credentials'))!
      expect(initializer).toEqual(expect.arrayContaining(['--network', 'none', '--stdin', '--expected-generation', '0']))
      expect(initializer).not.toContain('--telemetry-file')
    } else expect(f.credentialInput()).toBe('')
    await stopDockerOwner(f.owner(), f.id, 0, f.dependencies)
    await restartDockerOwner(f.owner(), f.id, f.client, 0, f.dependencies)
    expect(f.commands.filter(args => args.includes('run'))).toHaveLength(kind === 'bearer' ? 3 : 2)
  })
  it.each(['remote-http', 'missing-bearer', 'orphan-secret', 'extra-secret', 'public-file', 'symlink', 'oversized'])('refuses %s telemetry before Docker access or ownership publication', async fault => {
    const f = await fixture(), file = f.options.ownerFile + '.telemetry', secret = f.options.ownerFile + '.secret'
    const config = { endpoint: fault === 'remote-http' ? 'http://collector.invalid/v1/traces' : 'https://collector.invalid/v1/traces',
      authentication: fault === 'missing-bearer' ? { kind: 'bearer', credentialRef: 'otel/key' } : { kind: 'none' } }
    await writeFile(file, JSON.stringify(config) + (fault === 'oversized' ? ' '.repeat(16000) : ''), { mode: fault === 'public-file' ? 0o644 : 0o600 })
    await writeFile(secret, 'PRIVATE_OTEL_BEARER', { mode: 0o600 })
    if (fault === 'symlink') await symlink(file, file + '.link')
    await expect(startDockerOwner({ ...f.options,
      ...(fault === 'orphan-secret' ? {} : { telemetryFile: fault === 'symlink' ? file + '.link' : file }),
      ...(['extra-secret', 'orphan-secret'].includes(fault) ? { telemetryCredentialFile: secret } : {}) }, f.dependencies)).rejects.toThrow()
    expect(f.commands).toEqual([])
    await expect(readFile(f.options.ownerFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('retains the plan after credential provisioning fails, without launching a service or disclosing its input', async () => {
    const f = await fixture(), telemetryFile = f.options.ownerFile + '.telemetry', telemetryCredentialFile = f.options.ownerFile + '.secret'
    await writeFile(telemetryFile, JSON.stringify({ endpoint: 'https://collector.invalid/v1/traces', authentication: { kind: 'bearer', credentialRef: 'otel/key' } }), { mode: 0o600 })
    await writeFile(telemetryCredentialFile, 'PRIVATE_OTEL_BEARER', { mode: 0o600 }); f.faults.credential = true
    const error = await startDockerOwner({ ...f.options, telemetryFile, telemetryCredentialFile }, f.dependencies).catch(error => error)
    expect(error).toMatchObject({ code: 'startup-uncertain', owner: { path: f.options.ownerFile } })
    expect(error.message).not.toContain('PRIVATE_'); expect(f.commands.flat()).not.toContain('--detach')
    expect(f.createdVolumes).toHaveLength(2)
  })
  it('publishes an immutable private owner before mutations and sends credentials only by stdin', async () => {
    const f = await fixture(), result = await startDockerOwner(f.options, f.dependencies)
    expect(result.status).toBe('ready'); expect(result.containerId).toBe(f.id)
    expect(f.createdVolumes).toHaveLength(2)
    const owner = await readDockerOwner(result.owner.path, result.owner.sha256)
    expect(owner.image).toEqual(image)
    expect(JSON.stringify(owner)).not.toContain('PRIVATE KEY')
    expect(JSON.stringify(f.commands)).not.toContain('1'.repeat(64))
    expect(JSON.parse(f.provisioned())).toMatchObject({ token: '1'.repeat(64), cert: tls.ca })
    const init = f.commands.find(a => a.includes('--rm'))!
    expect(init).toEqual(expect.arrayContaining(['--network', 'none', '--pull', 'never']))
    await expect(startDockerOwner(f.options, f.dependencies)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(f.commands.filter(a => a.includes('run'))).toHaveLength(2)
  })
  it('inspects read-only, gracefully stops and restarts the exact same container without workflow submission', async () => {
    const f = await fixture(), started = await startDockerOwner(f.options, f.dependencies), count = f.commands.length
    const observed = await inspectDockerOwner(f.owner(), f.client, f.dependencies)
    expect(observed.service).toMatchObject({ status: 'ready' })
    expect(f.commands.slice(count).flat()).not.toContain('run')
    expect(await stopDockerOwner(f.owner(), f.id, 100, f.dependencies)).toMatchObject({ status: 'stopped', forceKill: false, volumes: 'retained' })
    const resumed = await restartDockerOwner(f.owner(), f.id, f.client, 100, f.dependencies)
    expect(resumed.status).toBe('ready')
    if (resumed.service?.status !== 'ready' || started.service?.status !== 'ready') throw Error('Fixture readiness not proven')
    expect(resumed.service.instanceId).not.toBe(started.service.instanceId)
    expect(f.commands.filter(a => a.includes('run'))).toHaveLength(2)
    expect(f.createdVolumes).toHaveLength(2)
  })
  it('observes an already-running restart without sending start or resuming workflows', async () => {
    const f = await fixture(); await startDockerOwner(f.options, f.dependencies)
    expect((await restartDockerOwner(f.owner(), f.id, f.client, 0, f.dependencies)).status).toBe('ready')
    expect(f.commands.flat()).not.toContain('start')
  })
  it('retains draining containers and never sends SIGKILL when the wait expires', async () => {
    const f = await fixture(); await startDockerOwner(f.options, f.dependencies); f.faults.hold = true
    expect(await stopDockerOwner(f.owner(), f.id, 201, f.dependencies)).toMatchObject({ status: 'draining', forceKill: false })
    expect(f.commands.filter(a => a.includes('kill'))).toHaveLength(1)
    expect(f.commands.flat()).not.toContain('SIGKILL')
  })
  it('checks actual exit after a lost SIGTERM acknowledgement', async () => {
    const f = await fixture(); await startDockerOwner(f.options, f.dependencies); f.faults.signalLost = true
    expect((await stopDockerOwner(f.owner(), f.id, 0, f.dependencies)).status).toBe('stopped')
  })
  it.each(['init', 'startLost', 'conflict'] as const)('retains the owner plan after %s, without cleanup or automatic retry', async fault => {
    const f = await fixture(); f.faults[fault] = true
    const error = await startDockerOwner(f.options, f.dependencies).catch(e => e)
    expect(error.owner.path).toBe(f.options.ownerFile)
    expect(await readDockerOwner(error.owner.path, error.owner.sha256)).toMatchObject({ runtime: 'docker' })
    expect(error.message).not.toContain('PRIVATE_')
    expect(f.commands.flat()).not.toContain('rm')
  })
  it.each(['remote', 'image'] as const)('rejects %s before publishing an owner or creating state', async fault => {
    const f = await fixture(); f.faults[fault] = true
    await expect(startDockerOwner(f.options, f.dependencies)).rejects.toThrow()
    await expect(readFile(f.options.ownerFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.createdVolumes).toHaveLength(0)
  })
  it.each(['id', 'mount', 'port', 'privileged', 'label', 'healthcheck'] as const)('refuses changed %s before signalling', async change => {
    const f = await fixture(); await startDockerOwner(f.options, f.dependencies)
    const c = f.container()
    if (change === 'id') c.Id = '9'.repeat(64)
    if (change === 'mount') c.Mounts[0].Name = 'unrelated'
    if (change === 'port') c.HostConfig.PortBindings['8787/tcp'][0].HostIp = '0.0.0.0'
    if (change === 'privileged') c.HostConfig.Privileged = true
    if (change === 'label') c.Config.Labels = {}
    if (change === 'healthcheck') c.Config.Healthcheck = { Test: ['CMD', 'unrelated'] }
    await expect(stopDockerOwner(f.owner(), f.id, 0, f.dependencies)).rejects.toMatchObject({ code: 'state-mismatch' })
    expect(f.commands.flat()).not.toContain('kill')
  })
  it.each(['created', 'unclean', 'oom', 'paused'] as const)('refuses %s restart without repairing state', async state => {
    const f = await fixture(); await startDockerOwner(f.options, f.dependencies)
    Object.assign(f.container().State, { Running: false, Status: state === 'created' ? 'created' : 'exited', ExitCode: state === 'unclean' ? 1 : 0, OOMKilled: state === 'oom', Paused: state === 'paused' })
    await expect(restartDockerOwner(f.owner(), f.id, f.client, 0, f.dependencies)).rejects.toMatchObject({ code: 'not-cleanly-stopped' })
    expect(f.commands.flat()).not.toContain('start')
  })
  it.each(['draining', 'closed'])('reports service %s instead of pretending readiness', async status => {
    const f = await fixture(); f.serviceStatus(status)
    expect((await startDockerOwner(f.options, f.dependencies)).status).toBe(status)
  })
  it('rejects owner hash mismatch, public permissions and symlinks', async () => {
    const f = await fixture(), started = await startDockerOwner(f.options, f.dependencies)
    await expect(readDockerOwner(started.owner.path, '0'.repeat(64))).rejects.toMatchObject({ code: 'invalid-options' })
    const link = join(f.options.ownerFile + '.link'); await symlink(started.owner.path, link)
    await expect(readDockerOwner(link, started.owner.sha256)).rejects.toMatchObject({ code: 'invalid-options' })
    await chmod(started.owner.path, 0o644)
    await expect(readDockerOwner(started.owner.path, started.owner.sha256)).rejects.toMatchObject({ code: 'invalid-options' })
  })
  it.each([
    ['start', '--runtime', 'invalid'], ['inspect'], ['stop', '--runtime', 'local'], ['restart', '--runtime', 'docker'],
    ['start', '--runtime', 'docker', '--data-dir', 'unrelated'], ['start', '--runtime', 'local', '--image-receipt', 'unrelated'],
    ['inspect', '--runtime', 'docker', '--ca-file', 'unrelated'],
    ['start', '--runtime', 'local', '--telemetry-ca-file', 'unrelated'],
    ['restart', '--runtime', 'docker', '--telemetry-ca-file', 'unrelated'],
    ['serve', '--telemetry-ca-file', 'unrelated'],
    ['start', '--runtime', 'local', '--notifications-ca-file', 'unrelated'],
    ['restart', '--runtime', 'docker', '--notifications-file', 'unrelated'],
    ['serve', '--notifications-ca-file', 'unrelated'],
    ['start', '--runtime', 'docker', '--network', network.name],
    ['start', '--runtime', 'docker', '--network-id', network.id],
    ['start', '--runtime', 'local', '--network', network.name, '--network-id', network.id],
    ['restart', '--runtime', 'docker', '--network', network.name, '--network-id', network.id],
  ])('rejects invalid CLI selection %j without acquiring storage or Docker', async (...args) => {
    let error = '', output = ''
    expect(await main(['runtime', ...args], { out: text => { output += text }, err: text => { error += text } })).toBe(2)
    expect(output).toBe(''); expect(JSON.parse(error).code).toBe('invalid-input')
  })
})

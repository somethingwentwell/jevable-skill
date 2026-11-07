import { afterAll, expect, it } from 'vitest'
import { constants } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, open, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { unzipSync } from 'fflate'
import { parseAllDocuments } from 'yaml'
import { createKubernetesBundle, type KubernetesOptions } from '../src/deployment/index.ts'
import { stageConfiguration, notificationStageConfiguration, rateCoordinatorStageConfiguration } from '../src/deployment/scripts.ts'
import { LocalRuntime } from '../src/runtime/local.ts'
import { createReleaseFiles } from '../src/packages/release-zip.ts'
import type { ImageReceipt } from '../src/images/service.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { parsePostgresHttpRateCoordinatorOptions } from '../src/http/postgres-rate-config.ts'

const exec = promisify(execFile), pids: number[] = [], hash = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')
const runtime = Buffer.from('export const packagingFixture = true;'), artifact = { storage: 'postgres' as const, bytes: runtime, notices: Buffer.from('synthetic not runnable'), identity: { version: CORE_VERSION, sha256: hash(runtime) } }
const base: KubernetesOptions = { name: 'workflow', namespace: 'automation', image: `registry.example/workflow@sha256:${'a'.repeat(64)}`, imageBinding: 'operator-verified-release-and-platform', publicOrigin: 'https://workflow.automation.svc.cluster.local:8787', configurationSecret: 'workflow-private', telemetry: false, terminationGracePeriodSeconds: 60,
  resources: { requestCpuMillis: 100, limitCpuMillis: 1000, requestMemoryMiB: 256, limitMemoryMiB: 512 }, network: { dns: { kind: 'pods', namespace: 'kube-system', labels: { 'k8s-app': 'kube-dns' } }, ingress: [{ kind: 'pods', namespace: 'clients', labels: { app: 'client' } }], egress: [{ peer: { kind: 'pods', namespace: 'database', labels: { app: 'postgres' } }, port: 5432 }] } }
async function releaseFixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'jevable-quota-kubernetes-'))), owner = await LocalRuntime.open({ dataDirectory: join(directory, 'authoring') })
  try {
    const yaml = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8'), project = owner.editProject({ operation: 'create', title: 'Quota packaging fixture', yaml, actor: 'local:test' })
    const release = owner.createRelease({ projectId: project.id, revision: project.acceptedRevision, expectedGeneration: project.generation, version: '1.0.0', runtime: artifact.identity, actor: 'local:test' })
    const receipt: ImageReceipt = { schemaVersion: 1, format: 'jevable.ai/image-receipt', createdAt: '2026-10-11T00:00:00.000Z', context: 'synthetic', platform: 'linux/arm64', baseImage: `node@sha256:${'b'.repeat(64)}`, tag: 'workflow:1', imageId: `sha256:${'c'.repeat(64)}`, releaseId: release.snapshot.id, releaseSha256: release.sha256, revision: release.snapshot.workflow.revision, runtime: artifact.identity, manifestSha256: hash(createReleaseFiles(release, artifact)['manifest.json']!), engineVersion: 'synthetic', execution: 'not-run', publication: 'local-daemon-only' }
    return { directory, release, receipt }
  } finally { await owner.close() }
}
function inspect(f: Awaited<ReturnType<typeof releaseFixture>>, options: KubernetesOptions) {
  const bundle = createKubernetesBundle(f.release, artifact, f.receipt, options), files = unzipSync(bundle.bytes), documents = parseAllDocuments(Buffer.from(files['workload.yaml']!).toString(), { version: '1.1' }).map(d => { expect(d.errors).toEqual([]); return d.toJS() })
  return { bundle, files, documents, pod: documents.find(d => d.kind === 'Deployment').spec.template.spec, config: documents.find(d => d.kind === 'ConfigMap') }
}
it('omission keeps the default script, secret keys, runtime command and manifest free of quota attachment', async () => {
  const f = await releaseFixture(), a = inspect(f, base), b = inspect(f, { ...base, rateCoordinator: false })
  for (const x of [a, b]) {
    expect(x.config.data['stage.mjs']).toBe(stageConfiguration); expect(x.pod.containers[0].args).not.toContain('--rate-coordinator-file')
    expect(x.pod.volumes[0].secret.items.map((i: { key: string }) => i.key)).not.toContain('rate-coordinator.json'); expect(x.bundle.manifest).not.toHaveProperty('rateCoordinator')
    expect(x.pod.initContainers).toHaveLength(2); expect(x.pod.containers[0].env).toBeUndefined()
  }
  expect(JSON.parse(Buffer.from(a.files['deployment-options.json']!).toString())).not.toHaveProperty('rateCoordinator')
})
it.each([[false, false], [false, true], [true, false], [true, true]])('composes explicit quota with notifications=%s telemetry=%s without changing egress/trust/gate or including secrets', async (notifications, telemetry) => {
  const f = await releaseFixture(), plain = inspect(f, { ...base, notifications, telemetry }), a = inspect(f, { ...base, rateCoordinator: true, notifications, telemetry })
  expect(a.bundle.manifest).toMatchObject({ storage: 'postgres', rateCoordinator: 'postgres', execution: 'not-run', clusterQualification: 'not-performed' })
  expect(a.pod.containers[0].args).toContain('--rate-coordinator-file'); expect(a.pod.containers[0].args[a.pod.containers[0].args.indexOf('--rate-coordinator-file') + 1]).toBe('/private/config/rate-coordinator.json')
  expect(a.pod.volumes[0].secret.items.map((i: { key: string }) => i.key)).toContain('rate-coordinator.json')
  expect(a.config.data['stage.mjs']).toBe(rateCoordinatorStageConfiguration(notifications ? notificationStageConfiguration(false) : stageConfiguration))
  expect(a.pod.initContainers).toHaveLength(plain.pod.initContainers.length); expect(a.pod.containers[0].env).toEqual(plain.pod.containers[0].env)
  expect(a.documents.find(d => d.kind === 'NetworkPolicy')).toEqual(plain.documents.find(d => d.kind === 'NetworkPolicy'))
  expect(a.documents.some(d => d.kind === 'Secret')).toBe(false); for (const bytes of Object.values(a.files)) expect(Buffer.from(bytes).includes(Buffer.from('PRIVATE_QUOTA_CONFIG'))).toBe(false)
  for (const p of a.bundle.manifest.files) { expect(a.files[p.path]!.length).toBe(p.bytes); expect(hash(a.files[p.path]!)).toBe(p.sha256) }
})
it.each([{ rateCoordinator: 'true' }, { rateCoordinator: {} }, { rateCoordinatorFile: '/private/config' }, { rateCoordinator: true, quotaScope: randomUUID() }, { rateCoordinator: true, quotaConnection: { password: 'PRIVATE_QUOTA_CONFIG' } }])('refuses unknown/embedded/incorrectly typed options %j', async change => {
  const f = await releaseFixture(); expect(() => inspect(f, { ...base, ...change } as KubernetesOptions)).toThrow('invalid-command')
})
it('refuses unsupported template mutation rather than silently dropping quota protection', () => {
  expect(() => rateCoordinatorStageConfiguration('')).toThrow('template mismatch')
  expect(() => rateCoordinatorStageConfiguration(stageConfiguration + stageConfiguration)).toThrow('template mismatch')
})
it('preserves notification certificate checks when composing the extra-CA template', async () => {
  const f = await releaseFixture(), a = inspect(f, { ...base, rateCoordinator: true, notifications: true, notificationsExtraCa: true })
  expect(a.config.data['stage.mjs']).toBe(rateCoordinatorStageConfiguration(notificationStageConfiguration(true)))
  expect(a.pod.volumes[0].secret.items.map((i: { key: string }) => i.key)).toContain('notifications-ca.crt')
})
const quota = { connection: { host: 'quota.example', port: 5432, database: 'quota', user: 'runtime', password: 'PRIVATE_QUOTA_CONFIG', tls: { mode: 'verify-full' } }, scope: randomUUID(), policy: { requests: { capacity: 3, refillTokens: 1, refillIntervalMs: 60000 }, controls: { capacity: 4, refillTokens: 1, refillIntervalMs: 1000 } }, initialize: false, timeoutMs: 5000, statementTimeoutMs: 1000, maxPendingDebits: 16 }
async function stagingFixture(options: { quotaValue?: unknown; quotaBytes?: string; notification?: boolean } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'jevable-quota-projection-'))), source = join(directory, 'projected'), destination = join(directory, 'private'), script = join(directory, 'stage.mjs')
  await mkdir(join(source, '..version'), { recursive: true, mode: 0o700 }); await mkdir(destination, { mode: 0o700 })
  const values: Record<string, string> = { 'database.json': JSON.stringify({ tls: { mode: 'verify-full' } }), 'rate-coordinator.json': options.quotaBytes ?? JSON.stringify(options.quotaValue ?? quota), 'service-token': 'f'.repeat(64), 'server.crt': 'synthetic', 'server.key': 'synthetic', 'ca.crt': 'synthetic', ...(options.notification ? { 'notifications.json': '{"endpoints":[]}' } : {}) }
  for (const [name, value] of Object.entries(values)) { await writeFile(join(source, '..version', name), value, { mode: 0o600 }); await symlink('..version/' + name, join(source, name)) }
  await writeFile(script, rateCoordinatorStageConfiguration(options.notification ? notificationStageConfiguration(false) : stageConfiguration))
  const run = async () => { const p = exec(process.execPath, [script, source, destination, 'no', 'no'], { timeout: 2500, killSignal: 'SIGTERM', maxBuffer: 16384 }); pids.push(p.child.pid!); return p }
  return { directory, source, destination, script, values, run, output: join(destination, 'rate-coordinator.json'), pending: join(destination, 'rate-coordinator.json.pending') }
}
const refusal = { code: 1, stdout: '', stderr: 'Jevable private configuration staging failed.\n' }
it.each([false, true])('copies a real projected quota into a 0600 regular private file and supports init retry; notifications=%s', async notification => {
  const f = await stagingFixture({ notification }); for (let i = 0; i < 2; i++) {
    const result = await f.run(); expect(result.stdout).toBe(''); expect(result.stderr).toBe(''); expect(await readFile(f.output, 'utf8')).toBe(f.values['rate-coordinator.json'])
    expect(parsePostgresHttpRateCoordinatorOptions(JSON.parse(await readFile(f.output, 'utf8')))).toEqual(quota)
    const stat = await lstat(f.output); expect(stat.isFile()).toBe(true); expect(stat.isSymbolicLink()).toBe(false); expect(stat.nlink).toBe(1); expect(stat.uid).toBe(process.getuid!()); expect(stat.mode & 511).toBe(384)
  }
})
it.each([null, [], { ...quota, initialize: true }, { ...quota, initialize: undefined }, { ...quota, connection: { ...quota.connection, tls: { mode: 'loopback-test' } } }, { ...quota, connection: {} }])('refuses a malformed/bootstrap/plaintext quota before publishing its private copy %j', async value => {
  const f = await stagingFixture({ quotaBytes: JSON.stringify(value) }); await expect(f.run()).rejects.toMatchObject(refusal); await expect(lstat(f.output)).rejects.toHaveProperty('code', 'ENOENT')
})
it.each(['invalid-json', 'oversize'])('refuses %s quota bytes with no private payload in stdout/stderr', async kind => {
  const f = await stagingFixture({ quotaBytes: kind === 'invalid-json' ? 'PRIVATE_QUOTA_CONFIG{' : JSON.stringify(quota) + ' '.repeat(65536) }); await expect(f.run()).rejects.toMatchObject(refusal); await expect(lstat(f.output)).rejects.toHaveProperty('code', 'ENOENT')
})
it('accepts exactly 65,536 bytes and leaves an unselected projection unread by the default script', async () => {
  const body = JSON.stringify(quota), f = await stagingFixture({ quotaBytes: body + ' '.repeat(65536 - Buffer.byteLength(body)) }); await f.run(); expect((await readFile(f.output)).length).toBe(65536)
  const g = await stagingFixture({ quotaBytes: 'PRIVATE_BAD_QUOTA' }); await writeFile(g.script, stageConfiguration); await g.run(); await expect(lstat(g.output)).rejects.toHaveProperty('code', 'ENOENT')
})
it('refuses a projection pointing outside its owned Secret volume', async () => {
  const f = await stagingFixture(), g = join(f.directory, 'outside'), source = join(f.source, '..version/rate-coordinator.json'); await writeFile(g, 'PRIVATE_RETAINED', { mode: 0o640 }); const before = await lstat(g)
  // A fresh projection contains a reviewed outside pointer; existing links/files are never repaired.
  const alternate = join(f.directory, 'alternate'); await mkdir(join(alternate, '..version'), { recursive: true })
  for (const [name, value] of Object.entries(f.values)) {
    if (name !== 'rate-coordinator.json') await writeFile(join(alternate, '..version', name), value, { mode: 0o600 })
    await symlink(name === 'rate-coordinator.json' ? g : '..version/' + name, join(alternate, name))
  }
  const p = exec(process.execPath, [f.script, alternate, f.destination, 'no', 'no'], { timeout: 2500, maxBuffer: 16384 }); pids.push(p.child.pid!); await expect(p).rejects.toMatchObject(refusal)
  expect(await readFile(g, 'utf8')).toBe('PRIVATE_RETAINED'); expect((await lstat(g)).mode).toBe(before.mode); expect(await readFile(source, 'utf8')).toBe(f.values['rate-coordinator.json'])
  expect(await readFile(join(f.destination, 'database.json'), 'utf8')).toBe(f.values['database.json'])
  await expect(lstat(f.output)).rejects.toHaveProperty('code', 'ENOENT')
})
it.each(['symlink', 'hardlink', 'directory', 'fifo'])('refuses a %s quota pending output before target mutation', async kind => {
  const f = await stagingFixture(), protectedPath = join(f.directory, 'protected'); await writeFile(protectedPath, 'PRIVATE_RETAINED', { mode: 0o640 }); const before = await lstat(protectedPath)
  if (kind === 'symlink') await symlink(protectedPath, f.pending)
  if (kind === 'hardlink') await link(protectedPath, f.pending)
  if (kind === 'directory') await mkdir(f.pending)
  if (kind === 'fifo') { const p = exec('mkfifo', [f.pending]); pids.push(p.child.pid!); await p }
  const reader = kind === 'fifo' ? await open(f.pending, constants.O_RDONLY | constants.O_NONBLOCK) : undefined
  try { await expect(f.run()).rejects.toMatchObject(refusal); expect(await readFile(protectedPath, 'utf8')).toBe('PRIVATE_RETAINED'); const after = await lstat(protectedPath); expect(after.ino).toBe(before.ino); expect(after.mode).toBe(before.mode); expect(after.size).toBe(before.size); if (reader) expect((await reader.read(Buffer.alloc(1024), 0, 1024, null)).bytesRead).toBe(0); await expect(lstat(f.output)).rejects.toHaveProperty('code', 'ENOENT') } finally { await reader?.close() }
})
afterAll(() => { for (const pid of pids) { try { process.kill(pid, 0); throw Error('Recorded fixture child remains') } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e } } })

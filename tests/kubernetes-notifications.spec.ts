import { expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, realpath, lstat, symlink, link, open, chmod } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:https'
import { unzipSync } from 'fflate'
import { parseAllDocuments } from 'yaml'
import { createKubernetesBundle, type KubernetesOptions } from '../src/deployment/index.ts'
import { stageConfiguration, readinessProbe, notificationStageConfiguration, combineOutboundCa } from '../src/deployment/scripts.ts'
import { LocalRuntime } from '../src/runtime/local.ts'
import { createReleaseFiles } from '../src/packages/release-zip.ts'
import type { ImageReceipt } from '../src/images/service.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { reviewAutomaticApprovalPolicy } from '../src/notifications/automatic-policy.ts'
import { notificationOptions } from '../src/notifications/options.ts'

const exec = promisify(execFile), hash = (v: Uint8Array | string) => createHash('sha256').update(v).digest('hex')
const runtimeBytes = Buffer.from('export const syntheticFixture = true;')
const artifact = { storage: 'postgres' as const, bytes: runtimeBytes, notices: Buffer.from('Synthetic packaging fixture, not a runnable image'),
  identity: { version: CORE_VERSION, sha256: hash(runtimeBytes) } }
const base: KubernetesOptions = { name: 'workflow', namespace: 'automation', image: `registry.example/workflow@sha256:${'a'.repeat(64)}`,
  imageBinding: 'operator-verified-release-and-platform', publicOrigin: 'https://workflow.automation.svc.cluster.local:8787',
  configurationSecret: 'workflow-private', telemetry: false, terminationGracePeriodSeconds: 60,
  resources: { requestCpuMillis: 100, limitCpuMillis: 1000, requestMemoryMiB: 256, limitMemoryMiB: 512 },
  network: { dns: { kind: 'pods', namespace: 'kube-system', labels: { 'k8s-app': 'kube-dns' } },
    ingress: [{ kind: 'pods', namespace: 'clients', labels: { app: 'client' } }],
    egress: [{ peer: { kind: 'pods', namespace: 'database', labels: { app: 'postgres' } }, port: 5432 }] } }
async function releaseFixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'jevable-k8s-notifications-')))
  const owner = await LocalRuntime.open({ dataDirectory: join(directory, 'authoring') })
  const yaml = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
  const project = owner.editProject({ operation: 'create', title: 'Synthetic notifications export', yaml, actor: 'local:test' })
  const release = owner.createRelease({ projectId: project.id, revision: project.acceptedRevision, expectedGeneration: project.generation,
    version: '1.0.0', runtime: artifact.identity, actor: 'local:test' })
  await owner.close()
  const receipt: ImageReceipt = { schemaVersion: 1, format: 'jevable.ai/image-receipt', createdAt: '2026-10-10T00:00:00.000Z', context: 'synthetic',
    platform: 'linux/arm64', baseImage: `node@sha256:${'b'.repeat(64)}`, tag: 'workflow:1', imageId: `sha256:${'c'.repeat(64)}`,
    releaseId: release.snapshot.id, releaseSha256: release.sha256, revision: release.snapshot.workflow.revision, runtime: artifact.identity,
    manifestSha256: hash(createReleaseFiles(release, artifact)['manifest.json']!), engineVersion: 'synthetic', execution: 'not-run', publication: 'local-daemon-only' }
  const endpoint = { id: 'recipient', url: 'https://recipient.example/hook', credentialRef: 'private/signing-key', timeoutMs: 1000 }
  const reviewed = reviewAutomaticApprovalPolicy({ format: 'jevable.ai/automatic-approval-policy/v1', routes: [{
    scope: { kind: 'release', id: release.snapshot.id, sha256: release.sha256, revision: release.snapshot.workflow.revision },
    endpointId: endpoint.id, endpointSha256: hash(JSON.stringify(endpoint)), eventKinds: ['requested', 'decided'] }] })
  const notifications = { endpoints: [endpoint], automatic: { policy: reviewed.policy, reviewedPolicySha256: reviewed.policySha256 } }
  return { directory, release, receipt, notifications }
}
function inspect(f: Awaited<ReturnType<typeof releaseFixture>>, options: KubernetesOptions) {
  const bundle = createKubernetesBundle(f.release, artifact, f.receipt, options), files = unzipSync(bundle.bytes)
  const documents = parseAllDocuments(Buffer.from(files['workload.yaml']!).toString(), { version: '1.1' }).map(d => { expect(d.errors).toEqual([]); return d.toJS() })
  return { bundle, files, documents, config: documents.find(d => d.kind === 'ConfigMap'),
    pod: documents.find(d => d.kind === 'Deployment').spec.template.spec }
}
it('omission has no notification flag/key/script/init/trust or implicit outbound network rule', async () => {
  const f = await releaseFixture(), a = inspect(f, base)
  expect(a.config.data['stage.mjs']).toBe(stageConfiguration); expect(a.config.data['readiness.mjs']).toBe(readinessProbe)
  expect(a.config.data['outbound-trust.mjs']).toBeUndefined()
  expect(a.pod.containers[0].args).not.toContain('--notifications-file'); expect(a.pod.containers[0].env).toBeUndefined()
  expect(a.pod.volumes.find((v: any) => v.name === 'projected').secret.items.map((i: any) => i.key)).not.toContain('notifications.json')
  expect(a.pod.initContainers).toHaveLength(2)
  expect(JSON.parse(Buffer.from(a.files['deployment-options.json']!).toString())).not.toHaveProperty('notifications')
  const policy = a.documents.find(d => d.kind === 'NetworkPolicy')
  expect(policy.spec.egress).toHaveLength(2)
})
it.each([[false, false], [true, false], [false, true], [true, true]])('exports explicit notification/telemetry extra trust (%s, %s) without credentials or automatic egress', async (notificationsExtraCa, telemetryExtraCa) => {
  const f = await releaseFixture(), a = inspect(f, { ...base, notifications: true, notificationsExtraCa, telemetry: true, telemetryExtraCa })
  const keys = a.pod.volumes.find((v: any) => v.name === 'projected').secret.items.map((i: any) => i.key)
  expect(keys).toContain('notifications.json'); expect(keys.includes('notifications-ca.crt')).toBe(notificationsExtraCa)
  expect(a.pod.containers[0].args.slice(-2)).toEqual(['--notifications-file', '/private/config/notifications.json'])
  expect(a.config.data['stage.mjs']).toBe(notificationStageConfiguration(notificationsExtraCa))
  const trust = notificationsExtraCa && telemetryExtraCa ? 'outbound-ca.crt' : notificationsExtraCa ? 'notifications-ca.crt' : telemetryExtraCa ? 'telemetry-ca.crt' : undefined
  expect(a.pod.containers[0].env).toEqual(trust ? [{ name: 'NODE_EXTRA_CA_CERTS', value: '/private/config/' + trust }] : undefined)
  const init = a.pod.initContainers.find((c: any) => c.name === 'outbound-trust')
  if (notificationsExtraCa && telemetryExtraCa) {
    expect(init.command).toEqual(['node', '/jevable-deployment/outbound-trust.mjs']); expect(init.args).toEqual(['/private/config'])
    expect(init.securityContext).toEqual(a.pod.containers[0].securityContext); expect(init.resources).toEqual(a.pod.containers[0].resources)
    expect(a.config.data['outbound-trust.mjs']).toBe(combineOutboundCa)
  } else expect(init).toBeUndefined()
  expect(a.documents.some(d => d.kind === 'Secret')).toBe(false)
  expect(a.documents.find(d => d.kind === 'NetworkPolicy').spec.egress).toHaveLength(2)
  for (const secret of ['private/signing-key', 'recipient.example', f.directory]) expect(Buffer.from(a.files['workload.yaml']!).toString()).not.toContain(secret)
  for (const member of a.bundle.manifest.files) expect(hash(a.files[member.path]!)).toBe(member.sha256)
})
it.each([{ notifications: 'true' }, { notificationsExtraCa: true }, { notifications: false, notificationsExtraCa: true },
  { notifications: true, notificationsExtraCa: 'true' }, { notifications: true, notificationPolicy: {} }])('refuses invalid or embedded-secret notification options %j', async change => {
  const f = await releaseFixture(); expect(() => inspect(f, { ...base, ...change } as KubernetesOptions)).toThrow('invalid-command')
})
async function stagedFixture(extraCa = false) {
  const f = await releaseFixture(), projection = join(f.directory, 'projected'), destination = join(f.directory, 'private'), script = join(f.directory, 'stage.mjs')
  await mkdir(join(projection, '..version'), { recursive: true, mode: 0o700 })
  const values: Record<string, string> = { 'database.json': JSON.stringify({ tls: { mode: 'verify-full' } }), 'service-token': 'f'.repeat(64),
    'server.crt': 'synthetic-cert', 'server.key': 'synthetic-key', 'ca.crt': 'synthetic-ca', 'notifications.json': JSON.stringify(f.notifications) }
  for (const [name, value] of Object.entries(values)) { await writeFile(join(projection, '..version', name), value, { mode: 0o600 }); await symlink('..version/' + name, join(projection, name)) }
  await writeFile(script, notificationStageConfiguration(extraCa), { mode: 0o600 })
  const run = () => exec(process.execPath, [script, projection, destination, 'no', 'no'], { timeout: 3000, maxBuffer: 16384 })
  return { ...f, projection, destination, script, values, run }
}
it('stages a real reviewed exact-release automatic policy privately, supports init retry and lets the existing runtime reader refuse a bad review', async () => {
  const f = await stagedFixture()
  for (let retry = 0; retry < 2; retry++) {
    expect((await f.run()).stdout).toBe('')
    const path = join(f.destination, 'notifications.json'), s = await lstat(path)
    expect(s.isFile()).toBe(true); expect(s.isSymbolicLink()).toBe(false); expect(s.mode & 511).toBe(384); expect(s.nlink).toBe(1)
    expect(await readFile(path, 'utf8')).toBe(f.values['notifications.json'])
    expect((await notificationOptions({ 'notifications-file': path }))!.automatic!.reviewedPolicySha256).toBe(f.notifications.automatic.reviewedPolicySha256)
  }
  await writeFile(join(f.projection, '..version/notifications.json'), JSON.stringify({ ...f.notifications, automatic: { ...f.notifications.automatic, reviewedPolicySha256: '0'.repeat(64) } }), { mode: 0o600 })
  await f.run(); await expect(notificationOptions({ 'notifications-file': join(f.destination, 'notifications.json') })).rejects.toThrow('invalid-command')
  expect(await notificationOptions({})).toBeUndefined()
})
it('refuses missing or outside-volume notification projections without disclosing them or widening access', async () => {
  const f = await stagedFixture(true)
  await expect(f.run()).rejects.toMatchObject({ code: 1, stdout: '', stderr: 'Jevable private configuration staging failed.\n' })
  const g = await stagedFixture(); await writeFile(join(g.directory, 'outside'), 'PRIVATE_SIGNING_KEY', { mode: 0o600 })
  // Use the extra-CA projection for the outside-volume case, keeping the real policy intact.
  await symlink('../outside', join(g.projection, 'notifications-ca.crt'))
  await writeFile(g.script, notificationStageConfiguration(true), { mode: 0o600 })
  await expect(g.run()).rejects.toMatchObject({ code: 1, stdout: '', stderr: 'Jevable private configuration staging failed.\n' })
  await expect(lstat(join(g.destination, 'notifications-ca.crt'))).rejects.toHaveProperty('code', 'ENOENT')
})
async function trustFixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'jevable-k8s-outbound-ca-'))), target = join(directory, 'private')
  await mkdir(target, { mode: 0o700 }); const script = join(directory, 'combine.mjs'); await writeFile(script, combineOutboundCa, { mode: 0o600 })
  for (const name of ['telemetry', 'notifications']) {
    await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2', '-subj', '/CN=' + name,
      '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(directory, name + '.key'), '-out', join(target, name + '-ca.crt')])
    await chmod(join(target, name + '-ca.crt'), 0o600)
  }
  return { directory, target, script, run: () => exec(process.execPath, [script, target], { timeout: 3000, maxBuffer: 16384 }) }
}
it('copies an explicitly enabled valid recipient CA from the projection into a private regular file', async () => {
  const f = await stagedFixture(true), trust = await trustFixture(), ca = await readFile(join(trust.target, 'notifications-ca.crt'))
  await writeFile(join(f.projection, '..version/notifications-ca.crt'), ca, { mode: 0o600 })
  await symlink('..version/notifications-ca.crt', join(f.projection, 'notifications-ca.crt'))
  const result = await f.run(); expect(result.stdout).toBe(''); expect(result.stderr).toBe('')
  const path = join(f.destination, 'notifications-ca.crt'), stat = await lstat(path)
  expect(stat.isFile()).toBe(true); expect(stat.isSymbolicLink()).toBe(false); expect(stat.mode & 511).toBe(384)
  expect(await readFile(path)).toEqual(ca)
})
it('combines both explicit CA bundles privately and verifies real HTTPS to both, without TLS bypass', async () => {
  const f = await trustFixture(), servers = [], urls = []; let received = 0
  for (const name of ['telemetry', 'notifications']) {
    const s = createServer({ key: await readFile(join(f.directory, name + '.key')), cert: await readFile(join(f.target, name + '-ca.crt')) }, (_q, r) => { received++; r.end() })
    await new Promise<void>((yes, no) => { s.once('error', no); s.listen(0, '127.0.0.1', yes) }); servers.push(s)
    urls.push('https://127.0.0.1:' + (s.address() as { port: number }).port)
  }
  try {
    for (let retry = 0; retry < 2; retry++) expect((await f.run()).stdout).toBe('')
    const ca = join(f.target, 'outbound-ca.crt'), s = await lstat(ca)
    expect(s.mode & 511).toBe(384); expect(s.nlink).toBe(1)
    expect(await readFile(ca, 'utf8')).toBe((await readFile(join(f.target, 'telemetry-ca.crt'), 'utf8')) + '\n' + (await readFile(join(f.target, 'notifications-ca.crt'), 'utf8')) + '\n')
    const client = "import{get}from'node:https';for(const url of process.argv.slice(1))await new Promise((yes,no)=>{get(url,{rejectUnauthorized:true},r=>{r.resume();r.on('end',yes)}).on('error',no)});"
    const env = { PATH: '', NODE_EXTRA_CA_CERTS: ca }
    await exec(process.execPath, ['--input-type=module', '-e', client, ...urls], { env, timeout: 5000 }); expect(received).toBe(2)
    await expect(exec(process.execPath, ['--input-type=module', '-e', client, urls[1]!], { env: { PATH: '', NODE_EXTRA_CA_CERTS: join(f.target, 'telemetry-ca.crt') }, timeout: 5000 })).rejects.toHaveProperty('code', 1)
    expect(received).toBe(2)
  } finally { await Promise.all(servers.map(s => new Promise<void>(yes => s.close(() => yes())))) }
}, 20000)
it.each(['symlink', 'hardlink', 'directory', 'fifo'])('refuses a %s pending trust output before mutating its protected target', async kind => {
  const f = await trustFixture(), protectedPath = join(f.directory, 'protected'), pending = join(f.target, 'outbound-ca.crt.pending')
  await writeFile(protectedPath, 'PRIVATE_RETAINED_BYTES', { mode: 0o640 }); const before = await lstat(protectedPath)
  if (kind === 'symlink') await symlink(protectedPath, pending)
  if (kind === 'hardlink') await link(protectedPath, pending)
  if (kind === 'directory') await mkdir(pending)
  if (kind === 'fifo') await exec('mkfifo', [pending])
  const reader = kind === 'fifo' ? await open(pending, constants.O_RDONLY | constants.O_NONBLOCK) : undefined
  try {
    await expect(f.run()).rejects.toMatchObject({ code: 1, stdout: '', stderr: 'Jevable outbound trust staging failed.\n' })
    expect(await readFile(protectedPath, 'utf8')).toBe('PRIVATE_RETAINED_BYTES'); const after = await lstat(protectedPath)
    expect({ mode: after.mode, ino: after.ino, size: after.size, links: after.nlink }).toEqual({ mode: before.mode, ino: before.ino, size: before.size, links: kind === 'hardlink' ? before.nlink + 1 : before.nlink })
    if (reader) expect((await reader.read(Buffer.alloc(1024), 0, 1024, null)).bytesRead).toBe(0)
  } finally { await reader?.close() }
})
it('refuses malformed certificate content instead of silently discarding a reviewed trust input', async () => {
  const f = await trustFixture(); await writeFile(join(f.target, 'notifications-ca.crt'), 'PRIVATE_INVALID_CA', { mode: 0o600 })
  await expect(f.run()).rejects.toMatchObject({ code: 1, stdout: '', stderr: 'Jevable outbound trust staging failed.\n' })
  await expect(lstat(join(f.target, 'outbound-ca.crt'))).rejects.toHaveProperty('code', 'ENOENT')
  const g = await stagedFixture(true); await writeFile(join(g.projection, 'notifications-ca.crt'), 'PRIVATE_INVALID_CA', { mode: 0o600 })
  await expect(g.run()).rejects.toMatchObject({ code: 1, stdout: '', stderr: 'Jevable private configuration staging failed.\n' })
})

import { expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { mkdtemp, mkdir, readFile, writeFile, lstat, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:https'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { unzipSync } from 'fflate'
import { parseAllDocuments } from 'yaml'
import { createManagementKubernetesBundle, managementKubernetesOptionsSchema, type ManagementKubernetesOptions } from '../src/deployment/index.ts'
import { createManagementFiles } from '../src/management/package.ts'
import { type ManagementImageReceipt } from '../src/images/management.ts'
import { CORE_VERSION, PROTOCOL_VERSION, capabilities } from '../src/capabilities.ts'
import { main } from '../src/cli.ts'

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex'), exec = promisify(execFile)
const program = Buffer.from('export const fixture = true;')
const read = async (path: string) => basename(path).endsWith('.mjs') ? program : basename(path).endsWith('.txt') ? Buffer.from('Fixture notice')
  : Buffer.from(JSON.stringify({ schemaVersion: 1, coreVersion: CORE_VERSION, storage: basename(path).startsWith('core') ? 'management'
    : basename(path).includes('postgres') ? 'postgres' : 'sqlite', sha256: hash(program), bytes: program.length, external: 'node-builtins-only' }))
const options: ManagementKubernetesOptions = { name: 'management', namespace: 'automation', storage: 'postgres',
  image: `registry.example/management@sha256:${'a'.repeat(64)}`, imageBinding: 'operator-verified-management-and-platform',
  publicOrigin: 'https://management.automation.svc.cluster.local:8787', configurationSecret: 'management-private',
  telemetry: true, telemetryExtraCa: true, telemetryPodMetadata: true, rateCoordinator: true, terminationGracePeriodSeconds: 3600,
  resources: { requestCpuMillis: 250, limitCpuMillis: 1000, requestMemoryMiB: 256, limitMemoryMiB: 512 },
  network: { dns: { kind: 'pods', namespace: 'kube-system', labels: { 'k8s-app': 'kube-dns' } },
    ingress: [{ kind: 'pods', namespace: 'clients', labels: { app: 'reviewed-client' } }],
    egress: [{ peer: { kind: 'pods', namespace: 'database', labels: { app: 'postgres' } }, port: 5432 }] } }
async function fixture() {
  const p = await createManagementFiles(read)
  const receipt: ManagementImageReceipt = { schemaVersion: 1, format: 'jevable.ai/management-image-receipt', createdAt: '2026-10-12T00:00:00.000Z',
    context: 'fixture', platform: 'linux/arm64', baseImage: `node@sha256:${'b'.repeat(64)}`, tag: 'management:1', imageId: `sha256:${'c'.repeat(64)}`,
    engineVersion: 'fixture', coreVersion: CORE_VERSION, runtimes: p.manifest.runtimes as ManagementImageReceipt['runtimes'],
    manifestSha256: hash(p.files['manifest.json']!), recipeSha256: 'd'.repeat(64), state: 'excluded', credentials: 'excluded', execution: 'not-run', publication: 'local-daemon-only' }
  const bundle = await createManagementKubernetesBundle(receipt, options, read), files = unzipSync(bundle.bytes)
  const docs = parseAllDocuments(Buffer.from(files['workload.yaml']!).toString()).map(d => { expect(d.errors).toEqual([]); return d.toJS() })
  return { ...p, receipt, bundle, entries: files, docs }
}

it('exports deterministic management-only manifests and exact program pins without user state or secrets', async () => {
  const f = await fixture(), again = await createManagementKubernetesBundle(f.receipt, options, read)
  expect(again.bytes).toEqual(f.bundle.bytes)
  expect(Object.keys(f.entries).sort()).toEqual(['README.md', 'deployment-options.json', 'image-receipt.json', 'manifest.json', 'workload.yaml'])
  expect(f.bundle.manifest).toMatchObject({ format: 'jevable.ai/management-kubernetes-bundle', mode: 'management', storage: 'postgres',
    execution: 'not-run', clusterQualification: 'not-performed', runtimes: f.receipt.runtimes })
  for (const pin of f.bundle.manifest.files) { expect(hash(f.entries[pin.path]!)).toBe(pin.sha256); expect(f.entries[pin.path]!.length).toBe(pin.bytes) }
  const deployment = f.docs.find(d => d.kind === 'Deployment'), pod = deployment.spec.template.spec, app = pod.containers[0]
  expect(deployment.spec).toMatchObject({ replicas: 1, strategy: { type: 'Recreate' } })
  expect(pod).toMatchObject({ automountServiceAccountToken: false, enableServiceLinks: false,
    securityContext: { runAsNonRoot: true, runAsUser: 1000, fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
    nodeSelector: { 'kubernetes.io/arch': 'arm64' } })
  for (const c of [...pod.initContainers, app]) expect(c).toMatchObject({ image: options.image,
    securityContext: { readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
    resources: { requests: { cpu: '250m', memory: '256Mi' }, limits: { cpu: '1000m', memory: '512Mi' } } })
  expect(app.command).toEqual(['node', '/app/bin/jevable.mjs']); expect(app.args.slice(0, 4)).toEqual(['runtime', 'serve', '--storage', 'postgres'])
  expect(app.args).toEqual(expect.arrayContaining(['--async-concurrency', '8', '--rate-coordinator-file', '--telemetry-file']))
  for (const denied of ['--release-file', '--data-dir', '--notifications-file', '--reviewer-decisions', '--caller-operations']) expect(app.args).not.toContain(denied)
  expect(f.bundle.manifest).not.toHaveProperty('reviewerDecisions')
  expect(Buffer.from(f.entries['README.md']!).toString()).toContain('Reviewer decisions are disabled by default')
  expect(app.livenessProbe).toBeUndefined(); expect(app.volumeMounts.every((m: { readOnly: boolean }) => m.readOnly)).toBe(true)
  expect(f.docs.find(d => d.kind === 'Service').spec.type).toBe('ClusterIP')
  expect(f.docs.map(d => d.kind)).toEqual(['ServiceAccount', 'ConfigMap', 'Deployment', 'Service', 'NetworkPolicy'])
  const config = f.docs.find(d => d.kind === 'ConfigMap')
  expect(config.immutable).toBe(true); expect(config.data['stage.mjs']).toContain("containerName: 'management'")
  expect(config.data['stage.mjs']).toContain('initialize !== false')
  expect(JSON.stringify(f.docs)).not.toContain('hostPath')
})

it('enables only the restricted reviewer route on explicit management opt-in and pins that choice in the bundle', async () => {
  const f = await fixture(), bundle = await createManagementKubernetesBundle(f.receipt, { ...options, reviewerDecisions: true }, read)
  const files = unzipSync(bundle.bytes), docs = parseAllDocuments(Buffer.from(files['workload.yaml']!).toString()).map(d => d.toJS())
  const app = docs.find(d => d.kind === 'Deployment').spec.template.spec.containers[0]
  expect(app.args.filter((arg: string) => arg === '--reviewer-decisions')).toHaveLength(1)
  expect(app.args).not.toContain('--caller-operations')
  expect(app.args).not.toContain('--release-file')
  expect(bundle.manifest.reviewerDecisions).toBe(true)
  expect(JSON.parse(Buffer.from(files['deployment-options.json']!).toString()).reviewerDecisions).toBe(true)
  const guide = Buffer.from(files['README.md']!).toString()
  expect(guide).toContain('Reviewer decisions are explicitly enabled')
  expect(guide).toContain('Protect grant delivery independently')
  expect(guide).not.toContain('reviewer/caller grants and release-only webhooks are not enabled')
  const disabled = await createManagementKubernetesBundle(f.receipt, { ...options, reviewerDecisions: false }, read)
  const disabledDocs = parseAllDocuments(Buffer.from(unzipSync(disabled.bytes)['workload.yaml']!).toString()).map(d => d.toJS())
  expect(disabledDocs.find(d => d.kind === 'Deployment').spec.template.spec.containers[0].args).not.toContain('--reviewer-decisions')
  expect(disabled.manifest).not.toHaveProperty('reviewerDecisions')
})

it('omitted opt-ins stage no telemetry/quota files and transport gate can be explicitly disabled', async () => {
  const f = await fixture(), bundle = await createManagementKubernetesBundle(f.receipt, { ...options, telemetry: false,
    telemetryExtraCa: false, telemetryPodMetadata: false, rateCoordinator: false, databaseTransportWaitSeconds: 0 }, read)
  const docs = parseAllDocuments(Buffer.from(unzipSync(bundle.bytes)['workload.yaml']!).toString()).map(d => d.toJS())
  const pod = docs.find(d => d.kind === 'Deployment').spec.template.spec
  expect(pod.initContainers).toHaveLength(1); expect(pod.initContainers[0].env).toBeUndefined()
  expect(pod.volumes[0].secret.items.map((i: { key: string }) => i.key)).toEqual(['database.json', 'service-token', 'server.crt', 'server.key', 'ca.crt'])
  expect(pod.containers[0].env).toBeUndefined()
})

it.each([
  { storage: 'sqlite' }, { imageBinding: 'operator-verified-release-and-platform' }, { image: 'registry.example/management:latest' },
  { notifications: true }, { notificationsExtraCa: true }, { asyncConcurrency: 0 }, { asyncConcurrency: 65 },
  { reviewerDecisions: 'yes' },
  { telemetry: false }, { publicOrigin: 'http://management.example' }, { publicOrigin: 'https://127.0.0.1' },
  { replicas: 2 }, { databaseTransportWaitSeconds: 301 }, { resources: { ...options.resources, requestCpuMillis: 2000 } },
])('refuses unsupported or unsafe management profile %j before artifact reads', async patch => {
  let reads = 0
  const f = await fixture()
  await expect(createManagementKubernetesBundle(f.receipt, { ...options, ...patch } as ManagementKubernetesOptions,
    async () => { reads++; throw Error() })).rejects.toMatchObject({ code: 'invalid-command' })
  expect(reads).toBe(0)
})

it.each(['format', 'coreVersion', 'manifest', 'runtime'] as const)('refuses substituted %s receipt', async changed => {
  const f = await fixture(), receipt = structuredClone(f.receipt)
  if (changed === 'format') (receipt as { format: string }).format = 'jevable.ai/image-receipt'
  if (changed === 'coreVersion') receipt.coreVersion = 'other'
  if (changed === 'manifest') receipt.manifestSha256 = '0'.repeat(64)
  if (changed === 'runtime') receipt.runtimes[2].sha256 = '0'.repeat(64)
  await expect(createManagementKubernetesBundle(receipt, options, read)).rejects.toThrow()
})

it('exposes help/schema and refuses missing/changed reviewed files without opening storage or writing output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-management-k8s-cli-')), file = join(directory, 'review.json'), output = join(directory, 'out.zip')
  await writeFile(file, '{}'); let out = '', err = ''
  const io = { out: (s: string) => { out += s }, err: (s: string) => { err += s } }
  expect(await main(['help', 'runtime', 'export-kubernetes', '--json'], io)).toBe(0)
  const help = JSON.parse(out); expect(help.variants[0].positionalCount).toBe(0); expect(help.execution).toBe('not-dispatched')
  expect(help.variants[0].options['data-dir']).toBeUndefined(); expect(help.variants[0].options['docker-context']).toBeUndefined()
  expect(capabilities().managementKubernetesExport).toMatchObject({ clusterApply: false, htmlPreview: false })
  expect(managementKubernetesOptionsSchema.parse(options).asyncConcurrency).toBe(8)
  out = ''; expect(await main(['runtime', 'export-kubernetes'], io)).toBe(2)
  err = ''; expect(await main(['runtime', 'export-kubernetes', '--image-receipt', file, '--receipt-sha256', 'b'.repeat(64),
    '--options-file', file, '--options-sha256', hash('{}'), '--output', output], io)).toBe(1)
  expect(JSON.parse(err).code).toBe('conflict'); await expect(lstat(output)).rejects.toHaveProperty('code', 'ENOENT')
})

it('runs generated private staging with management pod identity and refuses conflicting identity/plaintext database', async () => {
  const f = await fixture(), bundle = await createManagementKubernetesBundle(f.receipt, { ...options, rateCoordinator: false }, read)
  const docs = parseAllDocuments(Buffer.from(unzipSync(bundle.bytes)['workload.yaml']!).toString()).map(d => d.toJS())
  const stage = docs.find(d => d.kind === 'ConfigMap').data['stage.mjs']
  const directory = await mkdtemp(join(tmpdir(), 'jevable-management-k8s-stage-')), source = join(directory, 'projected'), target = join(directory, 'private'), script = join(directory, 'stage.mjs')
  await mkdir(source); await writeFile(script, stage)
  const telemetry = { resource: { serviceName: 'fixture' } }
  for (const [name, value] of Object.entries({ 'database.json': JSON.stringify({ tls: { mode: 'verify-full' } }),
    'service-token': 'f'.repeat(64), 'server.crt': 'fixture certificate', 'server.key': 'fixture key', 'ca.crt': 'fixture CA',
    'telemetry.json': JSON.stringify(telemetry), 'telemetry-ca.crt': 'fixture outbound CA' })) await writeFile(join(source, name), value)
  const env = { ...process.env, JEVABLE_K8S_NAMESPACE: 'automation', JEVABLE_K8S_POD_NAME: 'management-abc',
    JEVABLE_K8S_POD_UID: randomUUID(), JEVABLE_K8S_NODE_NAME: 'node-1' }
  const args = [script, source, target, 'yes', 'yes', 'yes']
  await exec(process.execPath, args, { env })
  expect(JSON.parse(await readFile(join(target, 'telemetry.json'), 'utf8')).resource.kubernetes).toEqual({
    namespace: 'automation', podName: 'management-abc', podUid: env.JEVABLE_K8S_POD_UID, nodeName: 'node-1', containerName: 'management' })
  for (const name of ['database.json', 'service-token', 'server.key', 'telemetry.json']) {
    const stat = await lstat(join(target, name)); expect(stat.isFile()).toBe(true); expect(stat.mode & 0o777).toBe(0o600)
  }
  await writeFile(join(source, 'telemetry.json'), JSON.stringify({ resource: { kubernetes: { containerName: 'workflow' } } }))
  await expect(exec(process.execPath, args, { env })).rejects.toMatchObject({ code: 1, stderr: 'Jevable private configuration staging failed.\n' })
  await writeFile(join(source, 'database.json'), JSON.stringify({ tls: { mode: 'disable' } }))
  await expect(exec(process.execPath, args, { env })).rejects.toHaveProperty('code', 1)
})

it('executes actual staged management readiness with TLS; program mismatches refuse before HTTP', async () => {
  const f = await fixture(), directory = await mkdtemp(join(tmpdir(), 'jevable-management-k8s-probe-')), appRoot = join(directory, 'app')
  for (const [path, bytes] of Object.entries(f.files)) { await mkdir(dirname(join(appRoot, path)), { recursive: true }); await writeFile(join(appRoot, path), bytes) }
  const config = f.docs.find(d => d.kind === 'ConfigMap'), script = join(directory, 'probe.mjs')
  await writeFile(script, config.data['readiness.mjs'])
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2', '-subj', '/CN=fixture',
    '-addext', 'subjectAltName=DNS:management.automation.svc.cluster.local', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'ca.crt')])
  await writeFile(join(directory, 'service-token'), 'f'.repeat(64))
  let body: Record<string, unknown> = { schemaVersion: 1, instanceId: randomUUID(), status: 'ready', runtime: { storage: 'postgres', database: 'reachable' } }, requests = 0
  const server = createServer({ key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'ca.crt')) }, (req, res) => {
    requests++; expect(req.url).toBe('/v1/health'); expect(req.method).toBe('GET'); expect(req.headers.host).toBe(new URL(options.publicOrigin).host)
    expect(req.headers.authorization).toBe('Bearer ' + 'f'.repeat(64)); expect(req.headers['x-jevable-protocol']).toBe(PROTOCOL_VERSION)
    res.writeHead(200, { 'x-jevable-protocol': PROTOCOL_VERSION }); res.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const args = [script, options.publicOrigin, PROTOCOL_VERSION, directory, String((server.address() as { port: number }).port), appRoot]
  try {
    expect((await exec(process.execPath, args)).stdout).toBe('')
    const original = structuredClone(body)
    for (const patch of [{ status: 'draining' }, { runtime: { storage: 'sqlite', database: 'reachable' } }, { runtime: { storage: 'postgres', database: 'unavailable' } }, { release: { id: randomUUID() } }]) {
      body = { ...original, ...patch }; await expect(exec(process.execPath, args)).rejects.toMatchObject({ code: 1, stderr: 'Jevable management readiness failed.\n' })
    }
    body = original; const before = requests
    await expect(exec(process.execPath, [script, 'https://wrong.invalid', ...args.slice(2)])).rejects.toHaveProperty('code', 1)
    expect(requests).toBe(before)
    const path = join(appRoot, 'dist/management/core-runtime.mjs')
    await writeFile(path, 'changed'); await expect(exec(process.execPath, args)).rejects.toHaveProperty('code', 1); expect(requests).toBe(before)
    await writeFile(path, f.files['dist/management/core-runtime.mjs']!)
    const copy = join(directory, 'same-bytes.mjs'); await writeFile(copy, f.files['dist/management/core-runtime.mjs']!)
    await unlink(path); await symlink(copy, path)
    await expect(exec(process.execPath, args)).rejects.toHaveProperty('code', 1); expect(requests).toBe(before)
    await unlink(path); await writeFile(path, f.files['dist/management/core-runtime.mjs']!)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  await expect(exec(process.execPath, args)).rejects.toHaveProperty('code', 1)
}, 20000)

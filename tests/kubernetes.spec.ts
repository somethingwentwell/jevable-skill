import { expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile, mkdir, symlink, lstat, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:https'
import { unzipSync } from 'fflate'
import { parseAllDocuments } from 'yaml'
import { createKubernetesBundle, type KubernetesOptions } from '../src/deployment/index.ts'
import { stageConfiguration, readinessProbe } from '../src/deployment/scripts.ts'
import { databaseTransportGate } from '../src/deployment/postgres-transport-script.ts'
import { createReleaseFiles } from '../src/packages/release-zip.ts'
import { LocalRuntime } from '../src/runtime/local.ts'
import { CORE_VERSION, PROTOCOL_VERSION, capabilities } from '../src/capabilities.ts'
import type { ImageReceipt } from '../src/images/service.ts'
import { main } from '../src/cli.ts'
import { readPrivateConfig } from '../src/http/private-config.ts'
import { readSecretFile } from '../src/providers/secret-input.ts'
import { parseTelemetryConfig } from '../src/telemetry/config.ts'

const exec = promisify(execFile), hash = (v: Uint8Array | string) => createHash('sha256').update(v).digest('hex')
const source = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const bytes = Buffer.from('export const fixture = true;')
const artifact = { storage: 'postgres' as const, bytes, notices: Buffer.from('Fixture, not a qualified executable'), identity: { version: CORE_VERSION, sha256: hash(bytes) } }
const options: KubernetesOptions = { name: 'workflow', namespace: 'automation', image: `registry.example/workflow@sha256:${'a'.repeat(64)}`,
  imageBinding: 'operator-verified-release-and-platform', publicOrigin: 'https://workflow.automation.svc.cluster.local:8787',
  configurationSecret: 'workflow-private', imagePullSecrets: ['registry-access'], telemetry: true, telemetryExtraCa: true, terminationGracePeriodSeconds: 3600,
  resources: { requestCpuMillis: 250, limitCpuMillis: 1000, requestMemoryMiB: 256, limitMemoryMiB: 512 },
  network: { dns: { kind: 'pods', namespace: 'kube-system', labels: { 'k8s-app': 'kube-dns' } },
    ingress: [{ kind: 'pods', namespace: 'clients', labels: { app: 'reviewed-client' } }],
    egress: [{ peer: { kind: 'pods', namespace: 'database', labels: { app: 'postgres' } }, port: 5432 },
      { peer: { kind: 'cidr', cidr: '192.0.2.5/32' }, port: 443 }] } }
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-kubernetes-')), runtime = await LocalRuntime.open({ dataDirectory: join(directory, 'state') })
  const p = runtime.editProject({ operation: 'create', title: 'Kubernetes fixture', yaml: source, actor: 'local:test' })
  runtime.setCredential('private/fixture', 'MUST_NOT_BE_EXPORTED', 0, 'local:test')
  const release = runtime.createRelease({ projectId: p.id, revision: p.acceptedRevision, expectedGeneration: 1, version: '1.0.0', runtime: artifact.identity, actor: 'local:test' })
  await runtime.close()
  const receipt: ImageReceipt = { schemaVersion: 1, format: 'jevable.ai/image-receipt', createdAt: '2026-09-29T00:00:00.000Z', context: 'fixture',
    platform: 'linux/arm64', baseImage: `node@sha256:${'b'.repeat(64)}`, tag: 'workflow:1', imageId: `sha256:${'c'.repeat(64)}`,
    releaseId: release.snapshot.id, releaseSha256: release.sha256, revision: release.snapshot.workflow.revision, runtime: artifact.identity,
    manifestSha256: hash(createReleaseFiles(release, artifact)['manifest.json']!), engineVersion: 'fixture', execution: 'not-run', publication: 'local-daemon-only' }
  return { directory, release, receipt }
}
it('advertises local Kubernetes packaging separately from unqualified cluster execution and matches actual generated artifacts', async () => {
  const capability = capabilities().kubernetesExport
  expect(capability).toBeDefined()
  const f = await fixture(), bundle = createKubernetesBundle(f.release, artifact, f.receipt, options)
  const files = unzipSync(bundle.bytes), manifests = parseAllDocuments(Buffer.from(files['workload.yaml']!).toString()).map(d => d.toJS())
  const deployment = manifests.find(d => d.kind === 'Deployment')
  expect(capability).toMatchObject({ available: true, command: 'releases export-kubernetes', sdk: '@jevable/core/deployment',
    format: bundle.manifest.format, mode: bundle.manifest.mode, imageBinding: bundle.manifest.imageBinding,
    publication: bundle.manifest.publication, execution: bundle.manifest.execution, clusterQualification: bundle.manifest.clusterQualification,
    replicas: deployment.spec.replicas, runtimeComponent: deployment.metadata.labels['app.kubernetes.io/component'],
    clusterApply: false, registryVerification: false, secretValuesIncluded: false })
  expect(capability.storageBackends).toEqual([bundle.manifest.storage])
  expect(capability.databaseTransportGate).toMatchObject({ option: 'databaseTransportWaitSeconds', defaultSeconds: 60,
    maxSeconds: 300, credentialsSent: false, databaseAuthentication: false, schemaOrOwnerAdmission: false, workflowRetry: false })
  expect(capabilities().kubernetes).toBe(false)
  expect(deployment.spec.template.spec.containers[0].command).toEqual(['node', '/app/app.mjs'])
  expect(manifests.some(d => ['Secret', 'Ingress'].includes(d.kind))).toBe(false)
})
it('returns detached Kubernetes packaging metadata without changing later discovery or enabling deployment', () => {
  const first = capabilities().kubernetesExport
  expect(first).toBeDefined()
  first.storageBackends.push('sqlite'); first.available = false; first.clusterApply = true
  first.databaseTransportGate.defaultSeconds = 0
  const second = capabilities().kubernetesExport
  expect(second.storageBackends).toEqual(['postgres']); expect(second.available).toBe(true)
  expect(second.clusterApply).toBe(false); expect(capabilities().kubernetes).toBe(false)
  expect(second.databaseTransportGate.defaultSeconds).toBe(60)
})
it('exposes packaging discovery through read-only CLI output without opening requested storage or executing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-k8s-discovery-')), state = join(directory, 'not-created')
  let output = '', errors = ''
  const io = { out: (v: string) => { output += v }, err: (v: string) => { errors += v } }
  expect(await main(['capabilities'], io)).toBe(0)
  expect(errors).toBe('')
  expect(JSON.parse(output).kubernetesExport).toMatchObject({ available: true, execution: 'not-run', clusterApply: false })
  output = ''; expect(await main(['capabilities', '--data-dir', state], io)).toBe(2)
  await expect(lstat(state)).rejects.toHaveProperty('code', 'ENOENT')
})
it('exports only pinned release deployment files, isolated non-root pods, private config references and bounded network rules', async () => {
  const f = await fixture(), bundle = createKubernetesBundle(f.release, artifact, f.receipt, options), files = unzipSync(bundle.bytes)
  expect(Object.keys(files).sort()).toEqual(['README.md', 'deployment-options.json', 'image-receipt.json', 'manifest.json', 'workload.yaml'])
  for (const entry of bundle.manifest.files) { expect(hash(files[entry.path]!)).toBe(entry.sha256); expect(files[entry.path]!.length).toBe(entry.bytes) }
  const yaml = Buffer.from(files['workload.yaml']!).toString(), docs = parseAllDocuments(yaml).map(d => { expect(d.errors).toEqual([]); return d.toJS() })
  const deployment = docs.find(d => d.kind === 'Deployment'), pod = deployment.spec.template.spec, container = pod.containers[0]
  expect(docs.map(d => d.kind)).toEqual(['ServiceAccount', 'ConfigMap', 'Deployment', 'Service', 'NetworkPolicy'])
  expect(deployment.spec).toMatchObject({ replicas: 1, strategy: { type: 'Recreate' } })
  expect(pod).toMatchObject({ automountServiceAccountToken: false, enableServiceLinks: false,
    securityContext: { runAsUser: 1000, fsGroup: 1000, runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
    nodeSelector: { 'kubernetes.io/arch': 'arm64' }, terminationGracePeriodSeconds: 3600 })
  expect(container.image).toBe(options.image); expect(pod.initContainers[0].image).toBe(options.image)
  expect(pod.imagePullSecrets).toEqual([{ name: 'registry-access' }])
  expect(container.command).toEqual(['node', '/app/app.mjs']); expect(container.args).toContain('--database-file')
  expect(container.args).not.toContain('--data-dir'); expect(container.livenessProbe).toBeUndefined()
  expect(container.volumeMounts.every((m: any) => m.readOnly)).toBe(true)
  expect(container.volumeMounts.some((m: any) => m.name === 'projected')).toBe(false)
  expect(pod.volumes.find((v: any) => v.name === 'private').emptyDir).toEqual({ medium: 'Memory', sizeLimit: '16Mi' })
  const guide = Buffer.from(files['README.md']!).toString()
  expect(guide).toContain('After database Pod loss or replacement')
  expect(guide).toContain('503 ownership-lost')
  expect(guide).toContain('kubectl --kubeconfig <reviewed-kubeconfig> --context <reviewed-context> -n automation rollout restart deployment/workflow')
  expect(guide).toContain('If those effects cannot be resolved safely, stop')
  expect(guide).toContain('Do not create replacement run IDs')
  expect(docs.find(d => d.kind === 'Service').spec).toMatchObject({ type: 'ClusterIP', ports: [{ port: 8787, targetPort: 'https' }] })
  const policy = docs.find(d => d.kind === 'NetworkPolicy').spec
  expect(policy.policyTypes).toEqual(['Ingress', 'Egress']); expect(policy.egress).toHaveLength(3)
  expect(policy.egress[1]).toMatchObject({ to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'database' } }, podSelector: { matchLabels: { app: 'postgres' } } }], ports: [{ port: 5432 }] })
  expect(policy.ingress[0].ports).toEqual([{ protocol: 'TCP', port: 8787 }])
  expect(bundle.manifest).toMatchObject({ execution: 'not-run', clusterQualification: 'not-performed', imageBinding: 'operator-asserted-not-registry-verified' })
  expect(yaml).not.toContain('MUST_NOT_BE_EXPORTED'); expect(yaml).not.toContain(source); expect(yaml).not.toContain(f.directory)
  expect(yaml).not.toContain('hostPath'); expect(yaml).not.toContain('docker.sock')
  expect(pod.initContainers[0].env).toBeUndefined()
  expect(pod.initContainers[0].args.at(-1)).toBe('no')
})
it('opts into only four Downward API fields in the init container, never API access or ambient app discovery', async () => {
  const f = await fixture(), files = unzipSync(createKubernetesBundle(f.release, artifact, f.receipt, { ...options, telemetryPodMetadata: true }).bytes)
  const pod = parseAllDocuments(Buffer.from(files['workload.yaml']!).toString()).map(d => d.toJS()).find(d => d.kind === 'Deployment').spec.template.spec
  expect(pod.initContainers[0].args.at(-1)).toBe('yes')
  expect(pod.initContainers[0].env).toEqual(Object.entries({ NAMESPACE: 'metadata.namespace', POD_NAME: 'metadata.name',
    POD_UID: 'metadata.uid', NODE_NAME: 'spec.nodeName' }).map(([name, fieldPath]) => ({ name: `JEVABLE_K8S_${name}`, valueFrom: { fieldRef: { apiVersion: 'v1', fieldPath } } })))
  expect(pod.containers[0].env).toEqual([{ name: 'NODE_EXTRA_CA_CERTS', value: '/private/config/telemetry-ca.crt' }])
  expect(pod.automountServiceAccountToken).toBe(false)
})
it.each([undefined, 1, 90, 300, 0])('exports a bounded database TLS gate (%s seconds), separately from application readiness', async budget => {
  const f = await fixture(), input = budget === undefined ? options : { ...options, databaseTransportWaitSeconds: budget }
  const files = unzipSync(createKubernetesBundle(f.release, artifact, f.receipt, input).bytes)
  const docs = parseAllDocuments(Buffer.from(files['workload.yaml']!).toString()).map(d => d.toJS())
  const pod = docs.find(d => d.kind === 'Deployment').spec.template.spec
  expect(docs.find(d => d.kind === 'ConfigMap').data['database-transport.mjs']).toBe(databaseTransportGate)
  const gate = pod.initContainers.find((c: any) => c.name === 'database-transport')
  if (budget === 0) { expect(gate).toBeUndefined(); expect(pod.initContainers).toHaveLength(1) }
  else {
    expect(pod.initContainers).toHaveLength(2)
    expect(gate.command).toEqual(['node', '/jevable-deployment/database-transport.mjs'])
    expect(gate.args).toEqual(['/private/config/database.json', String(budget ?? 60)])
    expect(gate.image).toBe(options.image)
    expect(gate.volumeMounts).toEqual([{ name: 'scripts', mountPath: '/jevable-deployment', readOnly: true }, { name: 'private', mountPath: '/private', readOnly: true }])
    expect(gate.env).toBeUndefined(); expect(gate.securityContext).toEqual(pod.containers[0].securityContext)
  }
  expect(pod.containers[0].livenessProbe).toBeUndefined()
  expect(JSON.parse(Buffer.from(files['deployment-options.json']!).toString()).databaseTransportWaitSeconds).toBe(budget ?? 60)
  expect(Buffer.from(files['README.md']!).toString()).toContain('It proves TLS transport only, not database/role/schema readiness')
})
it.each([
  { telemetry: false, telemetryExtraCa: false, telemetryPodMetadata: false, flags: ['no', 'no', 'no'] },
  { telemetry: true, telemetryExtraCa: false, telemetryPodMetadata: false, flags: ['yes', 'no', 'no'] },
  { telemetry: true, telemetryExtraCa: true, telemetryPodMetadata: false, flags: ['yes', 'yes', 'no'] },
  { telemetry: true, telemetryExtraCa: true, telemetryPodMetadata: true, flags: ['yes', 'yes', 'yes'] },
])('preserves string arguments and names through Kubernetes YAML 1.1 conversion: %j', async ({ flags, ...telemetry }) => {
  const f = await fixture(), input = { ...options, ...telemetry, name: 'on', namespace: 'no', configurationSecret: 'off' }
  const files = unzipSync(createKubernetesBundle(f.release, artifact, f.receipt, input).bytes)
  const docs = parseAllDocuments(Buffer.from(files['workload.yaml']!).toString(), { version: '1.1' }).map(d => {
    expect(d.errors).toEqual([]); return d.toJS()
  })
  const pod = docs.find(d => d.kind === 'Deployment').spec.template.spec
  expect(pod.initContainers[0].args).toEqual(['/projected', '/private/config', ...flags])
  expect(pod.initContainers[0].args.every((v: unknown) => typeof v === 'string')).toBe(true)
  expect(pod.volumes.find((v: any) => v.name === 'projected').secret.secretName).toBe('off')
  for (const doc of docs) { expect(doc.metadata.namespace).toBe('no'); expect(typeof doc.metadata.name).toBe('string') }
  expect(pod.securityContext.runAsNonRoot).toBe(true)
  expect(pod.securityContext.runAsUser).toBe(1000)
})
it('refuses changed release/image/runtime bindings and SQLite before exporting', async () => {
  const f = await fixture()
  for (const receipt of [{ ...f.receipt, releaseSha256: 'd'.repeat(64) }, { ...f.receipt, manifestSha256: 'd'.repeat(64) },
    { ...f.receipt, runtime: { ...f.receipt.runtime, sha256: 'd'.repeat(64) } }]) {
    expect(() => createKubernetesBundle(f.release, artifact, receipt, options)).toThrow('conflict')
  }
  expect(() => createKubernetesBundle(f.release, { ...artifact, storage: 'sqlite' }, f.receipt, options)).toThrow('invalid-command')
  expect(() => createKubernetesBundle(f.release, { ...artifact, bytes: Buffer.from('changed') }, f.receipt, options)).toThrow('conflict')
})
it.each([{ image: 'workflow:latest' }, { image: `sha256:${'a'.repeat(64)}` }, { publicOrigin: 'http://workflow:8787' },
  { publicOrigin: 'https://user:password@workflow' }, { publicOrigin: 'https://workflow/path' }, { publicOrigin: 'https://127.0.0.1:8787' },
  { replicas: 2 }, { namespace: '../outside' }, { configurationSecret: 'secret;command' }, { imageBinding: 'verified' },
  { publicOrigin: 'https://workflow..invalid:8787' }, { imagePullSecrets: ['invalid/name'] },
  { terminationGracePeriodSeconds: 1 }, { telemetry: false, telemetryExtraCa: true },
  { databaseTransportWaitSeconds: -1 }, { databaseTransportWaitSeconds: 301 }, { databaseTransportWaitSeconds: 0.5 }, { databaseTransportWaitSeconds: '60' },
  { telemetry: false, telemetryExtraCa: false, telemetryPodMetadata: true },
  { network: { ...options.network, egress: [{ peer: { kind: 'cidr', cidr: '0.0.0.0/0' }, port: 443 }] } },
  { network: { ...options.network, ingress: [{ kind: 'pods', namespace: 'clients', labels: {} }] } },
])('rejects unsafe or unsupported deployment input %j', async change => {
  const f = await fixture(); expect(() => createKubernetesBundle(f.release, artifact, f.receipt, { ...options, ...change } as KubernetesOptions)).toThrow('invalid-command')
})
it('stages projected Secret symlinks into owner-only regular files accepted by runtime readers and supports init retry', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'jevable-k8s-stage-'))), projection = join(directory, 'projected'), target = join(directory, 'private')
  await mkdir(join(projection, '..version'), { recursive: true })
  const values = { 'database.json': JSON.stringify({ tls: { mode: 'verify-full' }, password: 'PRIVATE_FIXTURE' }), 'service-token': 'f'.repeat(64) + '\n',
    'server.crt': 'cert', 'server.key': 'key', 'ca.crt': 'ca', 'telemetry.json': '{}', 'telemetry-ca.crt': 'extra-ca' }
  for (const [name, value] of Object.entries(values)) { await writeFile(join(projection, '..version', name), value); await symlink(`..version/${name}`, join(projection, name)) }
  const script = join(directory, 'stage.mjs'); await writeFile(script, stageConfiguration)
  for (let i = 0; i < 2; i++) {
    const result = await exec(process.execPath, [script, projection, target, 'yes', 'yes']); expect(result.stdout).toBe(''); expect(result.stderr).toBe('')
    for (const [name, value] of Object.entries(values)) { const stat = await lstat(join(target, name)); expect(stat.isSymbolicLink()).toBe(false); expect(stat.mode & 0o777).toBe(0o600); expect(stat.uid).toBe(process.getuid?.()); expect(await readFile(join(target, name), 'utf8')).toBe(value) }
    expect((await lstat(target)).mode & 0o777).toBe(0o700)
    expect(await readPrivateConfig(join(target, 'database.json'))).toEqual(JSON.parse(values['database.json']))
    expect(await readSecretFile(join(target, 'service-token'))).toBe('f'.repeat(64))
  }
  await writeFile(join(projection, '..version', 'database.json'), JSON.stringify({ tls: { mode: 'loopback-test' }, password: 'PRIVATE_FIXTURE' }))
  await expect(exec(process.execPath, [script, projection, target, 'yes', 'yes'])).rejects.toMatchObject({ code: 1, stderr: 'Jevable private configuration staging failed.\n' })
})
it('refuses projected secrets that escape their volume without disclosing file contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-k8s-escape-')), projection = join(directory, 'projected')
  await mkdir(projection); await writeFile(join(directory, 'secret'), 'PRIVATE_CONTENT'); await symlink('../secret', join(projection, 'database.json'))
  const script = join(directory, 'stage.mjs'); await writeFile(script, stageConfiguration)
  await expect(exec(process.execPath, [script, projection, join(directory, 'private'), 'no', 'no'])).rejects.toMatchObject({ code: 1, stdout: '', stderr: 'Jevable private configuration staging failed.\n' })
})
it('stages explicit pod identity privately, preserves collector configuration, refuses missing/conflicting metadata and does not alter disabled configuration', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'jevable-k8s-resource-'))), source = join(directory, 'projected'), target = join(directory, 'private')
  await mkdir(source)
  for (const name of ['service-token', 'server.crt', 'server.key', 'ca.crt']) await writeFile(join(source, name), 'fixture')
  await writeFile(join(source, 'database.json'), JSON.stringify({ tls: { mode: 'verify-full' } }))
  const config = { endpoint: 'https://collector.example/v1/traces', authentication: { kind: 'bearer', credentialRef: 'otel/key' },
    resource: { serviceNamespace: 'service-group', kubernetes: { clusterName: 'cluster-fixture' } } }
  const configPath = join(source, 'telemetry.json'), script = join(directory, 'stage.mjs')
  await writeFile(configPath, JSON.stringify(config)); await writeFile(script, stageConfiguration)
  const env = { ...process.env, JEVABLE_K8S_NAMESPACE: 'automation', JEVABLE_K8S_POD_NAME: 'workflow-123',
    JEVABLE_K8S_POD_UID: randomUUID(), JEVABLE_K8S_NODE_NAME: 'node.example', OTEL_RESOURCE_ATTRIBUTES: 'secret=PRIVATE_ENV' }
  const args = [script, source, target, 'yes', 'no']
  for (let retry = 0; retry < 2; retry++) {
    await exec(process.execPath, [...args, 'yes'], { env })
    const staged = await readPrivateConfig(join(target, 'telemetry.json'))
    expect(parseTelemetryConfig(staged).resource).toEqual({ serviceNamespace: 'service-group', kubernetes: { clusterName: 'cluster-fixture',
      namespace: 'automation', podName: 'workflow-123', podUid: env.JEVABLE_K8S_POD_UID, nodeName: 'node.example', containerName: 'workflow' } })
    expect(staged).toMatchObject({ endpoint: config.endpoint, authentication: config.authentication })
    expect(JSON.stringify(staged)).not.toContain('PRIVATE_ENV')
  }
  const refusal = { code: 1, stdout: '', stderr: 'Jevable private configuration staging failed.\n' }
  for (const key of ['JEVABLE_K8S_NAMESPACE', 'JEVABLE_K8S_POD_NAME', 'JEVABLE_K8S_POD_UID', 'JEVABLE_K8S_NODE_NAME']) {
    await expect(exec(process.execPath, [...args, 'yes'], { env: { ...env, [key]: '' } })).rejects.toMatchObject(refusal)
  }
  for (const kubernetes of [null, [], { podName: 'other-pod' }, { namespace: 'other-namespace' }, { containerName: 'private-configuration' }]) {
    await writeFile(configPath, JSON.stringify({ ...config, resource: { kubernetes } }))
    await expect(exec(process.execPath, [...args, 'yes'], { env })).rejects.toMatchObject(refusal)
  }
  await writeFile(configPath, JSON.stringify(config)); await exec(process.execPath, [...args, 'no'], { env })
  expect(await readFile(join(target, 'telemetry.json'), 'utf8')).toBe(JSON.stringify(config))
  await expect(exec(process.execPath, [script, source, target, 'no', 'no', 'yes'], { env })).rejects.toMatchObject(refusal)
})
it('probes actual verified HTTPS with authority, bearer and exact-release identity; rejects mismatch and outage without mutation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-k8s-probe-')), origin = 'https://workflow.automation.svc.cluster.local:8787'
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2', '-subj', '/CN=fixture',
    '-addext', 'subjectAltName=DNS:workflow.automation.svc.cluster.local', '-keyout', join(directory, 'server.key'), '-out', join(directory, 'ca.crt')])
  await writeFile(join(directory, 'service-token'), 'f'.repeat(64)); await writeFile(join(directory, 'probe.mjs'), readinessProbe)
  const id = randomUUID(), releaseHash = 'b'.repeat(64), runtimeHash = 'c'.repeat(64)
  let status = 'ready', code = 200, returnedHash = releaseHash, requests = 0
  const server = createServer({ key: await readFile(join(directory, 'server.key')), cert: await readFile(join(directory, 'ca.crt')) }, (req, res) => {
    requests++; expect(req.method).toBe('GET'); expect(req.url).toBe('/v1/health'); expect(req.headers.host).toBe(new URL(origin).host)
    expect(req.headers.authorization).toBe('Bearer ' + 'f'.repeat(64)); expect(req.headers['x-jevable-protocol']).toBe(PROTOCOL_VERSION)
    res.writeHead(code, { 'content-type': 'application/json', 'x-jevable-protocol': PROTOCOL_VERSION });
    res.end(JSON.stringify({ status, runtime: { storage: 'postgres', database: 'reachable' }, release: { id, sha256: returnedHash, runtime: { sha256: runtimeHash } } }))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as { port: number }).port
  const args = [join(directory, 'probe.mjs'), origin, id, releaseHash, runtimeHash, PROTOCOL_VERSION, directory, String(port)]
  try {
    expect((await exec(process.execPath, args)).stdout).toBe('')
    returnedHash = 'd'.repeat(64); await expect(exec(process.execPath, args)).rejects.toHaveProperty('code', 1)
    returnedHash = releaseHash; status = 'draining'; await expect(exec(process.execPath, args)).rejects.toHaveProperty('code', 1)
    status = 'ready'; code = 503; await expect(exec(process.execPath, args)).rejects.toHaveProperty('code', 1)
    const before = requests; await expect(exec(process.execPath, [args[0]!, 'https://wrong.invalid:8787', ...args.slice(2)])).rejects.toHaveProperty('code', 1)
    expect(requests).toBe(before)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  await expect(exec(process.execPath, args)).rejects.toMatchObject({ code: 1, stderr: 'Jevable release readiness failed.\n' })
}, 20000)
it('validates review hashes and required flags before opening authoring storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-k8s-cli-')), file = join(directory, 'metadata.json'), state = join(directory, 'not-created')
  await writeFile(file, '{}')
  let err = ''; const io = { out: () => { throw Error('unexpected output') }, err: (value: string) => { err += value } }
  expect(await main(['releases', 'export-kubernetes', randomUUID(), '--data-dir', state], io)).toBe(2)
  err = ''
  expect(await main(['releases', 'export-kubernetes', randomUUID(), '--data-dir', state, '--release-sha256', 'a'.repeat(64),
    '--image-receipt', file, '--receipt-sha256', 'b'.repeat(64), '--options-file', file, '--options-sha256', hash('{}'), '--output', join(directory, 'bundle.zip')], io)).toBe(1)
  expect(JSON.parse(err).code).toBe('conflict'); await expect(lstat(state)).rejects.toHaveProperty('code', 'ENOENT')
})

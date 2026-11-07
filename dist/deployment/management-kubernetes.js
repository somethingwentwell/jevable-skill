import { z } from 'zod';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { stringify } from 'yaml';
import { CORE_VERSION, PROTOCOL_VERSION } from "../capabilities.js";
import { readBoundedBytes } from "../files.js";
import { createManagementFiles } from "../management/package.js";
import { inspectManagementImageReceipt } from "../images/management.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { zipEpoch } from "../packages/zip-time.js";
import { kubernetesCommonOptionsSchema } from "./kubernetes.js";
import { stageConfiguration, rateCoordinatorStageConfiguration } from "./scripts.js";
import { databaseTransportGate } from "./postgres-transport-script.js";
/** A distinct management profile; release receipts and release assertions never substitute. */
export const managementKubernetesOptionsSchema = kubernetesCommonOptionsSchema.extend({
    imageBinding: z.literal('operator-verified-management-and-platform'),
    storage: z.literal('postgres'),
    notifications: z.literal(false).optional(), notificationsExtraCa: z.literal(false).optional(),
    reviewerDecisions: z.boolean().optional(),
    asyncConcurrency: z.number().int().min(1).max(64).default(8),
}).refine(o => !(o.telemetryExtraCa || o.telemetryPodMetadata) || o.telemetry);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
/** Readiness verifies the fixed program files, authenticated TLS and management database health. */
export function managementReadinessProbe(files) {
    return `import { request } from 'node:https';
import { readFile, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { checkServerIdentity } from 'node:tls';
const expected = ${JSON.stringify(files)};
const [origin, protocol, directory, port = '8787', appDirectory = '/app'] = process.argv.slice(2);
try {
  for (const file of expected) {
    const handle = await open(appDirectory + '/' + file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== file.bytes) throw Error();
      const bytes = Buffer.alloc(file.bytes + 1); let length = 0;
      while (length < bytes.length) { const r = await handle.read(bytes, length, bytes.length - length, null); if (!r.bytesRead) break; length += r.bytesRead; }
      if (length !== file.bytes || createHash('sha256').update(bytes.subarray(0, length)).digest('hex') !== file.sha256) throw Error();
    } finally { await handle.close(); }
  }
  const url = new URL(origin), token = (await readFile(directory + '/service-token', 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error();
  const ca = await readFile(directory + '/ca.crt');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { outgoing.destroy(); reject(Error()); }, 2000);
    const outgoing = request({ hostname: '127.0.0.1', port: Number(port), path: '/v1/health', method: 'GET',
      servername: url.hostname, checkServerIdentity: (_, cert) => checkServerIdentity(url.hostname, cert),
      ca, rejectUnauthorized: true, minVersion: 'TLSv1.2', agent: false, maxHeaderSize: 16384,
      headers: { host: url.host, authorization: 'Bearer ' + token, 'x-jevable-protocol': protocol } }, response => {
      let size = 0; const chunks = [];
      response.on('data', chunk => { size += chunk.length; if (size > 64000) response.destroy(Error()); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => { try {
        const body = JSON.parse(Buffer.concat(chunks));
        if (response.statusCode !== 200 || response.headers['x-jevable-protocol'] !== protocol || body.schemaVersion !== 1
          || body.status !== 'ready' || typeof body.instanceId !== 'string' || body.release !== undefined
          || body.runtime?.storage !== 'postgres' || body.runtime?.database !== 'reachable') throw Error();
        resolve();
      } catch { reject(Error()); } });
    });
    outgoing.on('error', reject); outgoing.on('close', () => clearTimeout(timer)); outgoing.end();
  });
} catch { process.stderr.write('Jevable management readiness failed.\\n'); process.exitCode = 1; }
`;
}
/** Local artifact reads only. Never contacts a registry, Docker, database or cluster. */
export async function createManagementKubernetesBundle(imageValue, input, readBytes = readBoundedBytes) {
    const parsed = managementKubernetesOptionsSchema.safeParse(input);
    if (!parsed.success)
        throw new WorkflowRuntimeError('invalid-command');
    const o = parsed.data, receipt = inspectManagementImageReceipt(imageValue);
    const { files, manifest: program } = await createManagementFiles(readBytes);
    if (receipt.coreVersion !== CORE_VERSION || receipt.manifestSha256 !== hash(files['manifest.json'])
        || JSON.stringify(receipt.runtimes) !== JSON.stringify(program.runtimes))
        throw new WorkflowRuntimeError('conflict');
    const pins = [...program.files, { path: 'manifest.json', bytes: files['manifest.json'].length, sha256: receipt.manifestSha256 }];
    const readiness = managementReadinessProbe(pins);
    const stageNeedle = "containerName: 'workflow'";
    if (stageConfiguration.split(stageNeedle).length !== 2)
        throw new WorkflowRuntimeError('corrupt');
    const selectedStage = stageConfiguration.replace(stageNeedle, "containerName: 'management'");
    const stage = o.rateCoordinator ? rateCoordinatorStageConfiguration(selectedStage) : selectedStage;
    const labels = { 'app.kubernetes.io/name': o.name, 'app.kubernetes.io/component': 'jevable-management-runtime' };
    const annotations = { 'jevable.ai/management-sha256': receipt.runtimes[0].sha256,
        'jevable.ai/manifest-sha256': receipt.manifestSha256, 'jevable.ai/image-binding': 'operator-asserted-not-registry-verified' };
    const metadata = { name: o.name, namespace: o.namespace, labels };
    const configName = `${o.name.slice(0, 40)}-cfg-${hash(stage + readiness + databaseTransportGate).slice(0, 12)}`;
    const securityContext = { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } };
    const resources = { requests: { cpu: `${o.resources.requestCpuMillis}m`, memory: `${o.resources.requestMemoryMiB}Mi` },
        limits: { cpu: `${o.resources.limitCpuMillis}m`, memory: `${o.resources.limitMemoryMiB}Mi` } };
    const keys = ['database.json', 'service-token', 'server.crt', 'server.key', 'ca.crt',
        ...(o.rateCoordinator ? ['rate-coordinator.json'] : []), ...(o.telemetry ? ['telemetry.json'] : []), ...(o.telemetryExtraCa ? ['telemetry-ca.crt'] : [])];
    const scriptMount = { name: 'scripts', mountPath: '/jevable-deployment', readOnly: true };
    const privateMount = { name: 'private', mountPath: '/private', readOnly: true };
    const peer = (p) => p.kind === 'cidr' ? { ipBlock: { cidr: p.cidr } }
        : { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': p.namespace } }, podSelector: { matchLabels: p.labels } };
    const manifests = [
        { apiVersion: 'v1', kind: 'ServiceAccount', metadata, automountServiceAccountToken: false },
        { apiVersion: 'v1', kind: 'ConfigMap', metadata: { ...metadata, name: configName }, immutable: true,
            data: { 'stage.mjs': stage, 'readiness.mjs': readiness, 'database-transport.mjs': databaseTransportGate } },
        { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { ...metadata, annotations }, spec: {
                replicas: 1, strategy: { type: 'Recreate' }, revisionHistoryLimit: 2, selector: { matchLabels: labels },
                template: { metadata: { labels, annotations }, spec: {
                        serviceAccountName: o.name, automountServiceAccountToken: false, enableServiceLinks: false,
                        imagePullSecrets: o.imagePullSecrets.map(name => ({ name })),
                        nodeSelector: { 'kubernetes.io/os': 'linux', 'kubernetes.io/arch': receipt.platform.split('/')[1] },
                        securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
                        terminationGracePeriodSeconds: o.terminationGracePeriodSeconds,
                        volumes: [{ name: 'projected', secret: { secretName: o.configurationSecret, defaultMode: 0o440, items: keys.map(key => ({ key, path: key })) } },
                            { name: 'private', emptyDir: { medium: 'Memory', sizeLimit: '16Mi' } }, { name: 'scripts', configMap: { name: configName, defaultMode: 0o444 } }],
                        initContainers: [{ name: 'private-configuration', image: o.image, imagePullPolicy: 'IfNotPresent', securityContext, resources,
                                command: ['node', '/jevable-deployment/stage.mjs'], args: ['/projected', '/private/config', o.telemetry ? 'yes' : 'no', o.telemetryExtraCa ? 'yes' : 'no', o.telemetryPodMetadata ? 'yes' : 'no'],
                                ...(o.telemetryPodMetadata ? { env: Object.entries({ NAMESPACE: 'metadata.namespace', POD_NAME: 'metadata.name', POD_UID: 'metadata.uid', NODE_NAME: 'spec.nodeName' })
                                        .map(([key, fieldPath]) => ({ name: `JEVABLE_K8S_${key}`, valueFrom: { fieldRef: { apiVersion: 'v1', fieldPath } } })) } : {}),
                                volumeMounts: [scriptMount, { name: 'projected', mountPath: '/projected', readOnly: true }, { name: 'private', mountPath: '/private' }] },
                            ...(o.databaseTransportWaitSeconds === 0 ? [] : [{ name: 'database-transport', image: o.image, imagePullPolicy: 'IfNotPresent', securityContext, resources,
                                    command: ['node', '/jevable-deployment/database-transport.mjs'], args: ['/private/config/database.json', String(o.databaseTransportWaitSeconds)], volumeMounts: [scriptMount, privateMount] }])],
                        containers: [{ name: 'management', image: o.image, imagePullPolicy: 'IfNotPresent', securityContext, resources,
                                command: ['node', '/app/bin/jevable.mjs'], args: ['runtime', 'serve', '--storage', 'postgres', '--database-file', '/private/config/database.json',
                                    '--token-file', '/private/config/service-token', '--port', '8787', '--bind-address', '0.0.0.0', '--public-origin', o.publicOrigin,
                                    '--tls-cert-file', '/private/config/server.crt', '--tls-key-file', '/private/config/server.key', '--async-concurrency', String(o.asyncConcurrency),
                                    ...(o.reviewerDecisions ? ['--reviewer-decisions'] : []),
                                    ...(o.rateCoordinator ? ['--rate-coordinator-file', '/private/config/rate-coordinator.json'] : []),
                                    ...(o.telemetry ? ['--telemetry-file', '/private/config/telemetry.json'] : [])],
                                ...(o.telemetryExtraCa ? { env: [{ name: 'NODE_EXTRA_CA_CERTS', value: '/private/config/telemetry-ca.crt' }] } : {}),
                                ports: [{ name: 'https', containerPort: 8787 }], volumeMounts: [scriptMount, privateMount],
                                readinessProbe: { exec: { command: ['node', '/jevable-deployment/readiness.mjs', o.publicOrigin, PROTOCOL_VERSION, '/private/config'] }, timeoutSeconds: 5, periodSeconds: 10, failureThreshold: 3 } }],
                    } },
            } },
        { apiVersion: 'v1', kind: 'Service', metadata, spec: { type: 'ClusterIP', selector: labels,
                ports: [{ name: 'https', port: Number(new URL(o.publicOrigin).port || '443'), targetPort: 'https', protocol: 'TCP' }] } },
        { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata, spec: { podSelector: { matchLabels: labels }, policyTypes: ['Ingress', 'Egress'],
                ingress: [{ from: o.network.ingress.map(peer), ports: [{ protocol: 'TCP', port: 8787 }] }],
                egress: [{ to: [peer(o.network.dns)], ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
                    ...o.network.egress.map(rule => ({ to: [peer(rule.peer)], ports: [{ protocol: 'TCP', port: rule.port }] }))] } },
    ];
    const guide = `# Jevable management workflow runtime — Kubernetes\n\nOffline export only; no publication, cluster apply, workflow execution or cluster qualification. The pod runs the standalone Jevable management CLI/API, not the authoring skill, desktop or harness. It is not an immutable workflow release and accepts full management operations from its token holder. No HTML preview server is included in this HTTPS profile.\n\nVerify the registry manifest contains the reviewed management programs and platform in image-receipt.json. A local Docker image ID may be a config digest; imageBinding is an operator assertion, not registry attestation. Provision namespace, registry access and a dedicated PostgreSQL database/schema/role independently. Never share an owned workflow namespace or scale beyond one replica. Recreate is not a distributed lease.\n\nProvision Secret ${o.configurationSecret} in ${o.namespace} with keys: ${keys.join(', ')}. No Secret values are exported. database.json requires verify-full TLS; service-token is 64 lower-case hex characters. ca.crt must trust the service certificate matching ${o.publicOrigin}. Init copies protected projected files into regular owner-only files in memory. Replace the pod after reviewed Secret updates. Database state remains external; no PVC, migration, backup, provider credentials or database installation is supplied.\n\nReview explicit NetworkPolicy peers/ports and CNI enforcement; policies are additive. ClusterIP only, no Ingress/RBAC/API credentials or Docker socket. Readiness hashes fixed program files and checks authenticated verified-TLS management health/database reachability without running a workflow. No liveness restart is installed. Readiness consumes health/control quota; reserve sufficient capacity. ${o.rateCoordinator ? 'Explicit quota configuration requires initialize:false and verify-full TLS; independently provision its scope/role and allowed egress. No quota database gate or retry is added.' : 'Shared quota is disabled.'}\n\n${o.telemetry ? 'Explicit telemetry.json enables OTLP; configure collector trust, credentials and egress independently. No Collector is deployed. Pod metadata is opt-in, with containerName management; conflicting values fail staging. Extra CA broadens process-wide Node trust without disabling TLS verification.' : 'Telemetry is explicitly disabled.'}\n\nRetain command/run UUIDs after uncertain responses; export and readiness never retry execution or decide approvals. Termination grace is ${o.terminationGracePeriodSeconds}s; qualify drain/forced-loss behavior before production. Checksums are not signatures. Notification delivery, reviewer/caller grants and release-only webhooks are not enabled by this initial management Kubernetes profile.\n`;
    const entries = Object.fromEntries(Object.entries({
        'workload.yaml': manifests.map(value => stringify(value, { schema: 'yaml-1.1' })).join('---\n'),
        'deployment-options.json': json(o), 'image-receipt.json': json(receipt),
        'README.md': guide.replace('Notification delivery, reviewer/caller grants and release-only webhooks are not enabled by this initial management Kubernetes profile.', `${o.reviewerDecisions
            ? 'Reviewer decisions are explicitly enabled: the owner may issue exact-attempt grants, and grant holders can use only the restricted reviewer route through the configured ingress peers. Protect grant delivery independently; this is not multi-user owner authentication.'
            : 'Reviewer decisions are disabled by default; no reviewer-grant route is exposed.'} Notification delivery, caller grants and release-only webhooks are not enabled by this management Kubernetes profile.`),
    }).map(([path, value]) => [path, Buffer.from(value)]));
    const manifest = { schemaVersion: 1, format: 'jevable.ai/management-kubernetes-bundle', coreVersion: CORE_VERSION,
        runtimes: receipt.runtimes, programManifestSha256: receipt.manifestSha256, image: o.image, platform: receipt.platform,
        storage: 'postgres', mode: 'management', ...(o.rateCoordinator ? { rateCoordinator: 'postgres' } : {}),
        ...(o.reviewerDecisions ? { reviewerDecisions: true } : {}),
        imageBinding: 'operator-asserted-not-registry-verified', publication: 'local-file-only', execution: 'not-run', clusterQualification: 'not-performed',
        files: Object.entries(entries).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })) };
    entries['manifest.json'] = Buffer.from(json(manifest));
    return { bytes: zipSync(entries, { mtime: zipEpoch() }), manifest };
}

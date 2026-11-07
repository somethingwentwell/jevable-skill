import { z } from 'zod'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { zipSync } from 'fflate'
import { stringify } from 'yaml'
import { createReleaseFiles, type loadReleaseRuntime } from '../packages/release-zip.ts'
import { inspectImageReceipt, type ImageReceipt } from '../images/service.ts'
import type { Release } from '../releases/snapshot.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { PROTOCOL_VERSION } from '../capabilities.ts'
import { stageConfiguration, readinessProbe, notificationStageConfiguration, combineOutboundCa, rateCoordinatorStageConfiguration } from './scripts.ts'
import { databaseTransportGate } from './postgres-transport-script.ts'

const name = z.string().min(1).max(63).regex(/^[a-z]([-a-z0-9]*[a-z0-9])?$/u)
const dns = (value: string) => value.length <= 253 && value.split('.').every(part => part.length > 0 && part.length <= 63 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u.test(part))
const label = z.string().min(1).max(63).regex(/^[a-zA-Z0-9]([-_.a-zA-Z0-9]*[a-zA-Z0-9])?$/u)
const labelKey = z.string().max(317).refine(value => {
  const parts = value.split('/')
  return (parts.length === 1 || (parts.length === 2 && dns(parts[0]!))) && label.safeParse(parts.at(-1)).success
})
const podPeer = z.strictObject({ kind: z.literal('pods'), namespace: name,
  labels: z.record(labelKey, label).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 16) })
const cidrPeer = z.strictObject({ kind: z.literal('cidr'), cidr: z.string().max(64).refine(value => {
  const [ip, mask, extra] = value.split('/'), family = isIP(ip ?? '')
  return !extra && family !== 0 && /^(?:[1-9][0-9]*)$/u.test(mask ?? '') && Number(mask) <= (family === 4 ? 32 : 128)
}) })
const peer = z.discriminatedUnion('kind', [podPeer, cidrPeer])
const component = '[a-z0-9]+(?:[._-][a-z0-9]+)*'
const image = z.string().max(512).regex(new RegExp(`^(?:${component}(?::[0-9]{1,5})?/)?${component}(?:/${component})*@sha256:[a-f0-9]{64}$`, 'u'))
export const kubernetesCommonOptionsSchema = z.strictObject({
  name, namespace: name, image,
  publicOrigin: z.string().max(512).refine(value => {
    try { const u = new URL(value); return u.protocol === 'https:' && u.origin === value && !u.username && !u.password
      && u.port !== '0' && !isIP(u.hostname) && dns(u.hostname) } catch { return false }
  }),
  configurationSecret: name,
  imagePullSecrets: z.array(name).max(8).default([]),
  telemetry: z.boolean(), telemetryExtraCa: z.boolean().default(false),
  telemetryPodMetadata: z.boolean().default(false),
  notifications: z.boolean().optional(), notificationsExtraCa: z.boolean().optional(),
  rateCoordinator: z.boolean().optional(),
  databaseTransportWaitSeconds: z.number().int().min(0).max(300).default(60),
  terminationGracePeriodSeconds: z.number().int().min(60).max(86400),
  resources: z.strictObject({ requestCpuMillis: z.number().int().min(100).max(64000), limitCpuMillis: z.number().int().min(100).max(64000),
    requestMemoryMiB: z.number().int().min(128).max(65536), limitMemoryMiB: z.number().int().min(128).max(65536) })
    .refine(r => r.requestCpuMillis <= r.limitCpuMillis && r.requestMemoryMiB <= r.limitMemoryMiB),
  network: z.strictObject({ dns: podPeer, ingress: z.array(peer).min(1).max(32),
    egress: z.array(z.strictObject({ peer, port: z.number().int().min(1).max(65535) })).min(1).max(32) }),
})
export const kubernetesOptionsSchema = kubernetesCommonOptionsSchema.extend({
  imageBinding: z.literal('operator-verified-release-and-platform'),
}).refine(o => (!(o.telemetryExtraCa || o.telemetryPodMetadata) || o.telemetry)
  && (!o.notificationsExtraCa || o.notifications === true))
export type KubernetesOptions = z.input<typeof kubernetesOptionsSchema>
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'

/** Pure local export: no registry, Docker, kubectl, database or network access. */
export function createKubernetesBundle(release: Release, artifact: Awaited<ReturnType<typeof loadReleaseRuntime>>,
  imageValue: ImageReceipt, input: KubernetesOptions) {
  const parsed = kubernetesOptionsSchema.safeParse(input)
  if (!parsed.success || artifact.storage !== 'postgres') throw new WorkflowRuntimeError('invalid-command')
  const o = parsed.data, receipt = inspectImageReceipt(imageValue), files = createReleaseFiles(release, artifact)
  if (receipt.releaseId !== release.snapshot.id || receipt.releaseSha256 !== release.sha256
    || receipt.revision !== release.snapshot.workflow.revision || receipt.runtime.version !== artifact.identity.version
    || receipt.runtime.sha256 !== artifact.identity.sha256 || receipt.manifestSha256 !== hash(files['manifest.json']!)) throw new WorkflowRuntimeError('conflict')
  const labels = { 'app.kubernetes.io/name': o.name, 'app.kubernetes.io/component': 'jevable-workflow-runtime' }
  const annotations = { 'jevable.ai/release-id': release.snapshot.id, 'jevable.ai/release-sha256': release.sha256,
    'jevable.ai/runtime-sha256': artifact.identity.sha256, 'jevable.ai/image-binding': 'operator-asserted-not-registry-verified' }
  const metadata = { name: o.name, namespace: o.namespace, labels }
  const securityContext = { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } }
  const resources = { requests: { cpu: `${o.resources.requestCpuMillis}m`, memory: `${o.resources.requestMemoryMiB}Mi` },
    limits: { cpu: `${o.resources.limitCpuMillis}m`, memory: `${o.resources.limitMemoryMiB}Mi` } }
  const keys = ['database.json', ...(o.rateCoordinator ? ['rate-coordinator.json'] : []), 'service-token', 'server.crt', 'server.key', 'ca.crt', ...(o.telemetry ? ['telemetry.json'] : []), ...(o.telemetryExtraCa ? ['telemetry-ca.crt'] : []),
    ...(o.notifications ? ['notifications.json'] : []), ...(o.notificationsExtraCa ? ['notifications-ca.crt'] : [])]
  const selectedStage = o.notifications ? notificationStageConfiguration(o.notificationsExtraCa === true) : stageConfiguration
  const stage = o.rateCoordinator ? rateCoordinatorStageConfiguration(selectedStage) : selectedStage
  const combinedCa = o.telemetryExtraCa && o.notificationsExtraCa
  const trustFile = combinedCa ? 'outbound-ca.crt' : o.notificationsExtraCa ? 'notifications-ca.crt' : o.telemetryExtraCa ? 'telemetry-ca.crt' : undefined
  const configName = `${o.name.slice(0, 40)}-cfg-${hash(stage + readinessProbe + databaseTransportGate + (combinedCa ? combineOutboundCa : '')).slice(0, 12)}`
  const volumes = [ { name: 'projected', secret: { secretName: o.configurationSecret, defaultMode: 0o440, items: keys.map(key => ({ key, path: key })) } },
    { name: 'private', emptyDir: { medium: 'Memory', sizeLimit: '16Mi' } },
    { name: 'scripts', configMap: { name: configName, defaultMode: 0o444 } } ]
  const scriptMount = { name: 'scripts', mountPath: '/jevable-deployment', readOnly: true }
  const probe = ['node', '/jevable-deployment/readiness.mjs', o.publicOrigin, release.snapshot.id, release.sha256,
    artifact.identity.sha256, PROTOCOL_VERSION, '/private/config']
  const servicePort = Number(new URL(o.publicOrigin).port || '443')
  const peerObject = (value: z.infer<typeof peer>) => value.kind === 'cidr' ? { ipBlock: { cidr: value.cidr } }
    : { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': value.namespace } }, podSelector: { matchLabels: value.labels } }
  const manifests = [
    { apiVersion: 'v1', kind: 'ServiceAccount', metadata, automountServiceAccountToken: false },
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: { ...metadata, name: configName }, immutable: true,
      data: { 'stage.mjs': stage, 'readiness.mjs': readinessProbe, 'database-transport.mjs': databaseTransportGate,
        ...(combinedCa ? { 'outbound-trust.mjs': combineOutboundCa } : {}) } },
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { ...metadata, annotations }, spec: {
      replicas: 1, strategy: { type: 'Recreate' }, revisionHistoryLimit: 2, selector: { matchLabels: labels },
      template: { metadata: { labels, annotations }, spec: {
        serviceAccountName: o.name, automountServiceAccountToken: false, enableServiceLinks: false,
        imagePullSecrets: o.imagePullSecrets.map(name => ({ name })),
        nodeSelector: { 'kubernetes.io/os': 'linux', 'kubernetes.io/arch': receipt.platform.split('/')[1] },
        securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
        terminationGracePeriodSeconds: o.terminationGracePeriodSeconds, volumes,
        initContainers: [{ name: 'private-configuration', image: o.image, imagePullPolicy: 'IfNotPresent', securityContext, resources,
          command: ['node', '/jevable-deployment/stage.mjs'], args: ['/projected', '/private/config', o.telemetry ? 'yes' : 'no', o.telemetryExtraCa ? 'yes' : 'no', o.telemetryPodMetadata ? 'yes' : 'no'],
          ...(o.telemetryPodMetadata ? { env: Object.entries({ NAMESPACE: 'metadata.namespace', POD_NAME: 'metadata.name',
            POD_UID: 'metadata.uid', NODE_NAME: 'spec.nodeName' }).map(([key, fieldPath]) => ({ name: `JEVABLE_K8S_${key}`,
              valueFrom: { fieldRef: { apiVersion: 'v1', fieldPath } } })) } : {}),
          volumeMounts: [scriptMount, { name: 'projected', mountPath: '/projected', readOnly: true }, { name: 'private', mountPath: '/private' }] },
          ...(o.databaseTransportWaitSeconds === 0 ? [] : [{ name: 'database-transport', image: o.image, imagePullPolicy: 'IfNotPresent', securityContext, resources,
            command: ['node', '/jevable-deployment/database-transport.mjs'], args: ['/private/config/database.json', String(o.databaseTransportWaitSeconds)],
            volumeMounts: [scriptMount, { name: 'private', mountPath: '/private', readOnly: true }] }]),
          ...(combinedCa ? [{ name: 'outbound-trust', image: o.image, imagePullPolicy: 'IfNotPresent', securityContext, resources,
            command: ['node', '/jevable-deployment/outbound-trust.mjs'], args: ['/private/config'],
            volumeMounts: [scriptMount, { name: 'private', mountPath: '/private' }] }] : [])],
        containers: [{ name: 'workflow', image: o.image, imagePullPolicy: 'IfNotPresent', securityContext, resources,
          command: ['node', '/app/app.mjs'], args: ['serve', '--database-file', '/private/config/database.json', '--token-file', '/private/config/service-token',
            '--port', '8787', '--bind-address', '0.0.0.0', '--public-origin', o.publicOrigin,
            '--tls-cert-file', '/private/config/server.crt', '--tls-key-file', '/private/config/server.key',
            ...(o.rateCoordinator ? ['--rate-coordinator-file', '/private/config/rate-coordinator.json'] : []),
            ...(o.telemetry ? ['--telemetry-file', '/private/config/telemetry.json'] : []),
            ...(o.notifications ? ['--notifications-file', '/private/config/notifications.json'] : [])],
          ...(trustFile ? { env: [{ name: 'NODE_EXTRA_CA_CERTS', value: '/private/config/' + trustFile }] } : {}),
          ports: [{ name: 'https', containerPort: 8787 }],
          readinessProbe: { exec: { command: probe }, timeoutSeconds: 5, periodSeconds: 10, failureThreshold: 3 },
          volumeMounts: [scriptMount, { name: 'private', mountPath: '/private', readOnly: true }] }],
      } },
    } },
    { apiVersion: 'v1', kind: 'Service', metadata, spec: { type: 'ClusterIP', selector: labels, ports: [{ name: 'https', port: servicePort, targetPort: 'https', protocol: 'TCP' }] } },
    { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata, spec: { podSelector: { matchLabels: labels }, policyTypes: ['Ingress', 'Egress'],
      ingress: [{ from: o.network.ingress.map(peerObject), ports: [{ protocol: 'TCP', port: 8787 }] }],
      egress: [{ to: [peerObject(o.network.dns)], ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
        ...o.network.egress.map(rule => ({ to: [peerObject(rule.peer)], ports: [{ protocol: 'TCP', port: rule.port }] }))] } },
  ]
  const guide = `# Jevable workflow runtime — Kubernetes export\n\nThis release-only PostgreSQL bundle is generated locally, not applied or cluster-qualified. No authoring skill, desktop or harness runs in the pod.\n\nBefore applying: verify the registry manifest digest really contains the reviewed release, runtime and platform from image-receipt.json. Local Docker image IDs may be config digests and are NOT registry manifest digests. The supplied binding is an operator assertion, not attestation. Provision namespace, image access, database schema/role and provider/telemetry credentials independently. Review deployment-options.json, every manifest and your CNI behavior; other NetworkPolicies are additive.\n\nCreate the independently protected Secret ${o.configurationSecret} in namespace ${o.namespace} with keys: ${keys.join(', ')}. Database JSON must use verify-full and a matching DNS name; no development plaintext fallback. ca.crt trusts the service certificate for ${o.publicOrigin}. Token is 64 lower-case hex characters; the private key must match the certificate. All bytes remain outside this bundle. The non-root init step copies projected symlinks into regular owner-only files in memory. Secret updates require a reviewed pod replacement; files are not refreshed live. Do not use these files for persistent workflow state.\n\nThe service is ClusterIP only and accepts exactly ${o.publicOrigin}; provision DNS/certificates and connect using that authority. No Ingress, public load balancer, proxy authentication or cluster RBAC is granted. Each bearer token holder has approval and private-inspection authority. The readiness probe verifies TLS, database health and release/runtime identity without executing workflows. There is deliberately no liveness restart on a database outage.\n\nOne replica with Recreate reduces rollout overlap but is not a distributed lease. PostgreSQL ownership is the exclusion boundary; never scale or force-delete to bypass an owner. Kubernetes can force termination after ${o.terminationGracePeriodSeconds}s, so qualify maximum execution/drain time and uncertain-effect recovery before production. Approval waiting itself need not keep a request open. Set providers before serving; retained UUIDs must be reused after uncertain responses.\n\n${o.telemetry ? 'telemetry.json uses the runtime OTLP schema (default HTTP/protobuf; explicit gRPC origin URLs); remote destinations need HTTPS, explicit credential references already provisioned in the database, and reviewed egress. The optional extra CA affects Node trust but does not disable verification. No collector is deployed.' : 'Telemetry is disabled explicitly for this export; enable it with a reviewed configuration Secret and allowed egress.'}\n\nDatabase records are external and durable; this bundle does not implement database backups, migrations, PVC-based artifacts, multi-worker leases or complete cluster observability. No source, runtime database, credential values or execution payloads are exported. manifest.json has file hashes, not signatures. Apply, publication, namespace/Secret creation and cluster qualification remain separate explicit operator actions.\n`
  const recoveryGuide = `\n## After database Pod loss or replacement\n\nAn old workflow owner can become Not Ready and return 503 ownership-lost even after PostgreSQL is Ready again. This is deliberate: the deployment does not install a liveness restart or automatically replay an admitted action. Keep the original run and request UUIDs. First verify the database and its intended durable state, record the old/new Pod identities, and inspect any active or uncertain provider effects. If those effects cannot be resolved safely, stop; a new owner is not evidence that an external action did or did not happen.\n\nOnly after the old workflow owner is confirmed fail-closed, the database is Ready, and an operator explicitly authorizes owner replacement, use the reviewed kubeconfig and context for this exact Deployment:\n\n\`\`\`sh\nkubectl --kubeconfig <reviewed-kubeconfig> --context <reviewed-context> -n ${o.namespace} rollout restart deployment/${o.name}\nkubectl --kubeconfig <reviewed-kubeconfig> --context <reviewed-context> -n ${o.namespace} rollout status deployment/${o.name}\n\`\`\`\n\nVerify a new runtime instance becomes Ready, then read the retained original run IDs, checkpoints, events and evidence before considering any further action. Do not create replacement run IDs, auto-resume uncertain work, approve a waiting gate, or treat a same-ID read as proof of exactly-once provider effects. Do not delete or force-replace the database PVC to make readiness pass.\n`
  const entries: Record<string, Uint8Array> = Object.fromEntries(Object.entries({
    // Kubernetes converts manifests through YAML 1.1: unquoted yes/no/on/off become booleans.
    // Keep typed string arguments, names and labels strings at that admission boundary.
    'workload.yaml': manifests.map(value => stringify(value, { schema: 'yaml-1.1' })).join('---\n'), 'deployment-options.json': json(o),
    'image-receipt.json': json(receipt), 'README.md': guide + recoveryGuide + (o.rateCoordinator
      ? '\n## Explicit shared HTTP quota\n\nrateCoordinator is enabled. Independently provision the reviewed PostgreSQL quota schema/scope and a restricted runtime role; supply rate-coordinator.json with initialize:false and connection.tls.mode:verify-full in the configuration Secret. The init copies at most 65,536 bytes to an owner-only regular file. The app validates complete options before taking workflow ownership; it does not bootstrap, reset, reconnect, refund or retry an uncertain debit. The quota database may differ from the workflow journal; explicitly review its DNS/CA and NetworkPolicy egress. No egress or quota transport gate is added automatically. The existing database gate covers only the workflow database. Allocate a control reserve for readiness/health traffic, including all sharing owners. Shared quota does not provide a workflow lease or authorize scaling the one-replica deployment; independent owners need independent workflow namespaces. Quota scope/policy/credentials remain private and are not in this ZIP. Actual quota pod/image/fault/received telemetry qualification is separate.\n' : '') + `\n## Database cold start\n\n${o.databaseTransportWaitSeconds === 0 ? 'The pre-start transport gate is explicitly disabled.' : `After staging private configuration, a separate restricted init container waits up to ${o.databaseTransportWaitSeconds}s for the configured PostgreSQL endpoint to accept verified TLS. Only transient connection/DNS failures are retried, within one monotonic deadline. Certificate/hostname and protocol refusals fail closed.`} Set databaseTransportWaitSeconds to 0 to disable, or 1–300 to select this per-init-attempt budget. Kubernetes may retry failed init containers; this is not a total pod-lifetime deadline. No credentials, StartupMessage, SQL, schema initialization, ownership or workflow work are sent by this gate. It proves TLS transport only, not database/role/schema readiness. Application startup still validates/authenticates and fails closed; no uncertain database write or workflow operation is retried. A later outage does not invoke the gate or add liveness restarts.\n` + (o.telemetryPodMetadata
      ? '\n## Telemetry pod identity\n\nExplicitly enabled: init reads namespace, pod name/UID and node name from Downward API fields and stages them with containerName workflow in telemetry.resource.kubernetes. Conflicting preconfigured values or missing fields stop startup. Optional serviceNamespace and clusterName remain operator-configured. No labels, annotations, API token or API requests are used. Every runtime owner still creates a fresh service.instance.id; pod UID is not a process identity. These infrastructure names leave the pod for the selected collector. Actual kubelet enrichment remains cluster-unqualified.\n'
      : '\nPod metadata enrichment is disabled. Telemetry uses only the explicitly supplied configuration; no Kubernetes identity is discovered automatically.\n') + (o.notifications
      ? '\n## Approval notifications\n\nExplicitly enabled: notifications.json is copied to an owner-only regular file and passed to the standalone workflow app. Omission remains disabled. Configure destinations and an exact-release reviewed automatic policy in this private file; provision referenced signing credentials independently in the database before startup. Startup does not execute a workflow, backfill old approvals or send notifications. A newly committed matching requested/decided event may admit a signed delivery; human approval stays a separate explicit action. Retained retries/replacements do not authorize redelivery. Recipient HTTP acceptance is not human receipt, approval or business delivery. Invalid policies/checksums fail closed at app startup. Review endpoint hashes, destination transport and egress rules independently; no egress is added automatically. This export does not contain policies, signing keys or secret values.\n' + (o.notificationsExtraCa
        ? '\nnotifications-ca.crt adds explicit process-wide Node trust, not recipient-only trust. When telemetryExtraCa is also enabled, a restricted init combines both owner-only staged inputs into outbound-ca.crt; neither original trust input is discarded and certificate/hostname verification remains enabled. No runtime/skill/desktop installation or discovery is required.\n' : '') : ''),
    }).map(([path, value]) => [path, Buffer.from(value)]))
  const manifest = { schemaVersion: 1, format: 'jevable.ai/kubernetes-bundle', releaseId: release.snapshot.id,
    releaseSha256: release.sha256, revision: release.snapshot.workflow.revision, runtime: artifact.identity,
    image: o.image, platform: receipt.platform, storage: 'postgres', mode: 'exact-release',
    ...(o.rateCoordinator ? { rateCoordinator: 'postgres' } : {}),
    imageBinding: 'operator-asserted-not-registry-verified', publication: 'local-file-only', execution: 'not-run', clusterQualification: 'not-performed',
    files: Object.entries(entries).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })) }
  entries['manifest.json'] = Buffer.from(json(manifest))
  return { bytes: zipSync(entries), manifest }
}

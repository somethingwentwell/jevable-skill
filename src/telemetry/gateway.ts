/** Offline Collector configuration packaging. No files, credentials, sockets or owners are opened here. */
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { posix } from 'node:path'
import { stringify } from 'yaml'
import { zipSync } from 'fflate'
import { WorkflowRuntimeError } from '../runtime/errors.ts'

export const COLLECTOR_GATEWAY_PROFILE = 'otelcol-contrib-0.136.0' as const
export const COLLECTOR_GATEWAY_OPTIONS_MAX_BYTES = 16_384
const signals = ['traces', 'metrics', 'logs'] as const
const text = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)
const endpoint = z.string().min(1).max(2048).refine(value => {
  try {
    if (!/^[\x21-\x7e]+$/u.test(value) || /[\\$]/u.test(value)) return false
    const url = new URL(value), host = url.hostname.replace(/^\[|\]$/gu, '')
    const dns = host.length <= 253 && host.split('.').every(p => p.length <= 63 && /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/iu.test(p))
    return value.startsWith('https://') && url.protocol === 'https:' && !url.username && !url.password
      && !url.search && !url.hash && (isIP(host) !== 0 || dns) && url.href === value
  } catch { return false }
})
const backend = z.strictObject({
  protocol: z.enum(['http/protobuf', 'grpc']), endpoint,
  authentication: z.enum(['none', 'bearer-file']), extraCa: z.boolean().default(false),
}).refine(value => value.protocol !== 'grpc' || new URL(value.endpoint).pathname === '/')
const queueDirectory = z.string().min(2).max(256).refine(value =>
  value.startsWith('/') && value !== '/' && !value.endsWith('/') && posix.normalize(value) === value
  && /^[A-Za-z0-9_./-]+$/u.test(value) && !value.split('/').some(segment => segment === '.' || segment === '..'))
export const collectorGatewayOptionsSchema = z.strictObject({
  profile: z.literal(COLLECTOR_GATEWAY_PROFILE),
  receiver: z.strictObject({ protocol: z.enum(['http/protobuf', 'grpc']),
    bindAddress: z.enum(['127.0.0.1', '::1', '0.0.0.0', '::']), port: z.number().int().min(1024).max(65535) }),
  backends: z.strictObject({ traces: backend.optional(), metrics: backend.optional(), logs: backend.optional() })
    .refine(value => signals.some(signal => value[signal] !== undefined)),
  enrichment: z.strictObject({ clusterName: text.optional(), environment: text.optional() }).optional(),
  memory: z.strictObject({ limitMiB: z.number().int().min(128).max(65536), spikeLimitMiB: z.number().int().min(1).max(32768) })
    .refine(value => value.spikeLimitMiB < value.limitMiB),
  batch: z.strictObject({ maxRecords: z.number().int().min(1).max(8192), timeoutMs: z.number().int().min(100).max(60000) }).optional(),
  forwarding: z.strictObject({ queueSize: z.number().int().min(1).max(4096),
    retryMaxElapsedMs: z.number().int().min(0).max(60000),
    persistentQueue: z.strictObject({ directory: queueDirectory }).optional() }),
  selfMetrics: z.strictObject({ bindAddress: z.enum(['127.0.0.1', '::1']),
    port: z.number().int().min(1024).max(65535) }).optional(),
}).refine(value => value.selfMetrics === undefined || value.selfMetrics.port !== value.receiver.port)
  .refine(value => value.forwarding.persistentQueue === undefined
    ? value.batch !== undefined && value.forwarding.retryMaxElapsedMs >= 1000
    : value.batch === undefined && value.forwarding.retryMaxElapsedMs === 0)
export type CollectorGatewayOptions = z.input<typeof collectorGatewayOptionsSchema>
export type CollectorGatewayPolicy = z.output<typeof collectorGatewayOptionsSchema>
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')

/** Normalize a detached, bounded selection. Secret bytes and arbitrary Collector components are deliberately not inputs. */
export function inspectCollectorGatewayOptions(value: unknown) {
  let bytes: string | undefined
  try { bytes = JSON.stringify(value) } catch { throw new WorkflowRuntimeError('invalid-command') }
  if (!bytes || Buffer.byteLength(bytes) > COLLECTOR_GATEWAY_OPTIONS_MAX_BYTES) throw new WorkflowRuntimeError('invalid-command')
  const result = collectorGatewayOptionsSchema.safeParse(JSON.parse(bytes))
  if (!result.success) throw new WorkflowRuntimeError('invalid-command')
  return result.data
}

function gatewayFiles(options: CollectorGatewayPolicy) {
  const requiredFiles = ['receiver.crt', 'receiver.key', 'receiver.token']
  const extensions: Record<string, unknown> = { 'bearertokenauth/receiver': { filename: '/private/gateway/receiver.token' } }
  const durableQueue = options.forwarding.persistentQueue
  if (durableQueue) extensions['file_storage/queue'] = { directory: durableQueue.directory,
    create_directory: false, fsync: true, recreate: false }
  const exporters: Record<string, unknown> = {}, pipelines: Record<string, unknown> = {}
  const attributes = [
    ...(options.enrichment?.clusterName === undefined ? [] : [{ key: 'k8s.cluster.name', value: options.enrichment.clusterName, action: 'insert' }]),
    ...(options.enrichment?.environment === undefined ? [] : [{ key: 'deployment.environment.name', value: options.enrichment.environment, action: 'insert' }]),
  ]
  for (const signal of signals) {
    const destination = options.backends[signal]
    if (!destination) continue
    const id = `${destination.protocol === 'grpc' ? 'otlp' : 'otlphttp'}/${signal}`
    const tls = { ...(destination.extraCa ? { ca_file: `/private/gateway/${signal}.ca.crt` } : {}), min_version: '1.2' }
    if (destination.extraCa) requiredFiles.push(`${signal}.ca.crt`)
    if (destination.authentication === 'bearer-file') {
      extensions[`bearertokenauth/${signal}`] = { filename: `/private/gateway/${signal}.token` }
      requiredFiles.push(`${signal}.token`)
    }
    exporters[id] = {
      ...(destination.protocol === 'grpc' ? { endpoint: `${new URL(destination.endpoint).hostname}:${new URL(destination.endpoint).port || '443'}` } : { [`${signal}_endpoint`]: destination.endpoint, encoding: 'proto' }),
      tls, ...(destination.authentication === 'bearer-file' ? { auth: { authenticator: `bearertokenauth/${signal}` } } : {}),
      timeout: '10s', sending_queue: { enabled: true, num_consumers: 1, queue_size: options.forwarding.queueSize,
        ...(durableQueue ? { storage: 'file_storage/queue' } : {}) },
      retry_on_failure: { enabled: true, initial_interval: '1s',
        max_interval: options.forwarding.retryMaxElapsedMs === 0 ? '5s'
          : options.forwarding.retryMaxElapsedMs < 5000 ? `${options.forwarding.retryMaxElapsedMs}ms` : '5s',
        max_elapsed_time: options.forwarding.retryMaxElapsedMs === 0 ? '0s' : `${options.forwarding.retryMaxElapsedMs}ms` },
    }
    pipelines[signal] = { receivers: ['otlp/jevable'], processors: ['memory_limiter',
      ...(attributes.length ? ['resource/explicit'] : []), ...(durableQueue ? [] : ['batch'])], exporters: [id] }
  }
  const address = options.receiver.bindAddress.includes(':') ? `[${options.receiver.bindAddress}]` : options.receiver.bindAddress
  const metrics = options.selfMetrics === undefined ? { level: 'none' } : {
    level: 'normal', readers: [{ pull: { exporter: { prometheus: {
      host: options.selfMetrics.bindAddress, port: options.selfMetrics.port,
      without_type_suffix: true, without_units: true,
    } } } }],
  }
  const configuration = {
    extensions,
    receivers: { 'otlp/jevable': { protocols: { [options.receiver.protocol === 'grpc' ? 'grpc' : 'http']: {
      endpoint: `${address}:${options.receiver.port}`, tls: { cert_file: '/private/gateway/receiver.crt', key_file: '/private/gateway/receiver.key', min_version: '1.2' },
      auth: { authenticator: 'bearertokenauth/receiver' },
    } } } },
    processors: { memory_limiter: { check_interval: '1s', limit_mib: options.memory.limitMiB, spike_limit_mib: options.memory.spikeLimitMiB },
      ...(attributes.length ? { 'resource/explicit': { attributes } } : {}),
      ...(options.batch ? { batch: { timeout: `${options.batch.timeoutMs}ms`, send_batch_size: options.batch.maxRecords,
        send_batch_max_size: options.batch.maxRecords } } : {}) },
    exporters,
    // No payload/debug exporter, host metrics, file logs, scraping, API/RBAC enrichment or ambient detection.
    service: { extensions: Object.keys(extensions), telemetry: { logs: { level: 'warn' }, metrics }, pipelines },
  }
  const guide = `# Optional Jevable telemetry gateway\n\nOffline configuration for ${COLLECTOR_GATEWAY_PROFILE}; not a Collector installation, workload, deployment or qualification receipt. Validate with the exact independently provisioned Collector binary before starting it. Other versions/component aliases require separate review. Workflow execution never depends on this gateway or Jarness.\n\nProvision these separate bounded, Collector-readable private files at /private/gateway: ${requiredFiles.join(', ')}. No secret values or file contents are included. receiver.crt/key must match the explicitly configured gateway authority; receiver.token is an independently generated single bearer token shared only with authorized OTLP producers. Each enabled <signal>.token is that backend's separate bearer credential. CA files are backend trust chains, not receiver certificates. Never use a workflow owner/approval token. Review token file whitespace rules and rotation with the exact Collector extension.\n\nConfigure the Jevable runtime with the matching protocol, authenticated TLS destination(s) and a separately provisioned credential reference. HTTP runtime destinations include /v1/traces, /v1/metrics and /v1/logs; gRPC runtime destinations are HTTPS origins. Export only enabled signals. Bind ${options.receiver.bindAddress}:${options.receiver.port} is a configuration choice, not permission to expose a port. Provision DNS, certificates, firewall/CNI, non-root permissions, resource limits and egress separately. No cluster manifest, Docker socket, host mount, workflow state or service discovery is generated.\n\nAll pipelines place memory_limiter first. Set an operator-reviewed process/container memory budget above the heap limit and size queue/batch limits for actual traffic. Queues are bounded but memory-only; shutdown, saturation or outage can lose telemetry. Collector retry may duplicate telemetry; it never replays workflow actions. An OTLP acknowledgement is not proof of durable backend ingestion or dashboard visibility.\n\nResource enrichment uses insert only: existing application service/pod/cluster/environment/instance identities are never overwritten. Cluster/environment defaults are explicit operator assertions, not kubelet-attested values. No k8sattributes/API lookup, service.instance.id fabrication, host discovery or additional metric point labels are generated.\n\nThis gateway receives application OTLP only. Do not also scrape/tail the same application signals through an agent. If adding agent host logs/metrics, use distinct sources and resource identity. Tail sampling is not enabled: distributed gateways need trace-ID affinity and sufficient decision windows for asynchronous approval/recovery segments; upstream unsampled spans cannot be recovered. Qualify routing/late-span behavior before adding it.\n\nBefore production, verify TLS/auth refusals, retained resource/trace/log/metric joins, bounded memory/drop visibility, backend persistence, dashboards/alerts, network isolation and lifecycle on the intended platform. Configuration packaging alone does not meet those gates.\n`
  const queueGuide = durableQueue
    ? `Persistent exporter queue selected at ${durableQueue.directory}. Provision an owner-only writable directory on separately reviewed durable storage before starting the Collector; keep one writer and the same extension/exporter names across replacements. No batch processor precedes the queue. File storage uses fsync, does not auto-create the directory or silently recreate a corrupt database, and retries temporary backend failures without an elapsed-time cutoff. A full queue rejects new telemetry; a permanent backend refusal, storage failure, unqueued/in-flight record, receiver crash before enqueue, node/PVC loss or backend acknowledgment without durable storage can still lose data. Do not delete or reset the queue to make the Collector Ready. Retain its original bytes for forensic review, watch exporter queue/failure metrics, capacity and disk alerts, and qualify actual crash/restart and backend readback before claiming durability.`
    : 'Queues are bounded but memory-only; shutdown, saturation or outage can lose telemetry.'
  return { requiredFiles, configuration, files: {
    'collector.yaml': Buffer.from(stringify(configuration)),
    'gateway-options.json': Buffer.from(JSON.stringify(options, null, 2) + '\n'),
    'README.md': Buffer.from(guide.replace('Queues are bounded but memory-only; shutdown, saturation or outage can lose telemetry.', queueGuide)
      + (options.selfMetrics === undefined
      ? '\n## Collector self-metrics\n\nDisabled explicitly: no implicit default Prometheus listener. To monitor gateway receive/export failures, queue size/capacity and process metrics, select a separate loopback selfMetrics address/port in reviewed options and re-export. This does not enable application telemetry, scraping or a backend.\n'
      : `\n## Collector self-metrics\n\nExplicit normal-level Prometheus reader at http://${options.selfMetrics.bindAddress.includes(':') ? `[${options.selfMetrics.bindAddress}]` : options.selfMetrics.bindAddress}:${options.selfMetrics.port}/metrics. This is unauthenticated loopback HTTP in the Collector's own network namespace, not a TLS endpoint or an authorization to publish it. Use a separately reviewed local scraper; do not expose it using host networking, a public Service, ingress or port forwarding without independent access control. No scraper or forwarding of these internal metrics is configured. Counters and queue/process measurements are instance-local diagnostics, not workflow receipts, durable ingestion, successful approval or exactly-once delivery. Metric names are pinned to this Collector profile with unit/type suffixes suppressed; verify semantics and resets after replacement. Missing metrics mean unknown.\n`)),
  } }
}

/** Pure SDK export. Does not validate credential files, fetch a binary/image, send telemetry or start a Collector. */
export function createCollectorGatewayBundle(value: unknown) {
  const options = inspectCollectorGatewayOptions(value), generated = gatewayFiles(options)
  const manifest = { schemaVersion: 1, format: 'jevable.ai/collector-gateway', profile: options.profile,
    optionsSha256: hash(JSON.stringify(options)), enabledSignals: signals.filter(signal => options.backends[signal]),
    selfMetrics: options.selfMetrics === undefined ? { enabled: false } : { enabled: true,
      bindAddress: options.selfMetrics.bindAddress, port: options.selfMetrics.port, transport: 'loopback-http', format: 'prometheus-text' },
    requiredPrivateFiles: generated.requiredFiles, execution: 'not-run', collectorQualification: 'not-performed',
    clusterQualification: 'not-performed', files: Object.entries(generated.files).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })) }
  const files = { ...generated.files, 'manifest.json': Buffer.from(JSON.stringify(manifest, null, 2) + '\n') }
  // ZIP/DOS timestamps encode local calendar fields, not UTC instants. Use local
  // midnight so fflate emits the same fields in every caller time zone.
  return { manifest, bytes: zipSync(files, { level: 6, mtime: new Date(1980, 0, 1, 0, 0, 0) }) }
}

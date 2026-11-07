import { expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile, readdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { unzipSync } from 'fflate'
import { parse } from 'yaml'
import { createCollectorGatewayBundle, inspectCollectorGatewayOptions, type CollectorGatewayOptions } from '../src/telemetry/gateway.ts'
import { main } from '../src/cli.ts'
import { listSchemas, showSchema } from '../src/contracts.ts'

const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const options: CollectorGatewayOptions = {
  profile: 'otelcol-contrib-0.136.0', receiver: { protocol: 'http/protobuf', bindAddress: '127.0.0.1', port: 4318 },
  backends: {
    traces: { protocol: 'http/protobuf', endpoint: 'https://traces.example/v1/traces', authentication: 'bearer-file', extraCa: true },
    metrics: { protocol: 'grpc', endpoint: 'https://metrics.example:4317/', authentication: 'bearer-file' },
    logs: { protocol: 'http/protobuf', endpoint: 'https://logs.example/otel/logs', authentication: 'none' },
  },
  enrichment: { clusterName: 'reviewed-cluster', environment: 'staging' },
  memory: { limitMiB: 400, spikeLimitMiB: 80 }, batch: { maxRecords: 512, timeoutMs: 1000 },
  forwarding: { queueSize: 128, retryMaxElapsedMs: 30000 },
}
const contents = (value: unknown = options) => {
  const bundle = createCollectorGatewayBundle(value), files = unzipSync(bundle.bytes)
  return { bundle, files, config: parse(Buffer.from(files['collector.yaml']!).toString()) }
}
it('exports identical ZIP bytes across caller time zones, including dates before UTC epoch midnight locally', () => {
  const original = process.env.TZ
  try {
    process.env.TZ = 'UTC'
    const expected = createCollectorGatewayBundle(options).bytes
    for (const zone of ['Asia/Singapore', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Pacific/Honolulu']) {
      process.env.TZ = zone
      expect(createCollectorGatewayBundle(options).bytes).toEqual(expected)
    }
  } finally {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  }
})
it('exports deterministic, independently hash-verifiable configuration and reference-only private inputs', () => {
  const { bundle, files, config } = contents()
  expect(Object.keys(files).sort()).toEqual(['README.md', 'collector.yaml', 'gateway-options.json', 'manifest.json'])
  expect(createCollectorGatewayBundle(options).bytes).toEqual(bundle.bytes)
  for (const file of bundle.manifest.files) {
    expect(hash(files[file.path]!)).toBe(file.sha256); expect(files[file.path]!.length).toBe(file.bytes)
  }
  expect(bundle.manifest).toMatchObject({ enabledSignals: ['traces', 'metrics', 'logs'], execution: 'not-run',
    collectorQualification: 'not-performed', clusterQualification: 'not-performed',
    requiredPrivateFiles: ['receiver.crt', 'receiver.key', 'receiver.token', 'traces.ca.crt', 'traces.token', 'metrics.token'] })
  expect(bundle.manifest.optionsSha256).toBe(hash(JSON.stringify(inspectCollectorGatewayOptions(options))))
  expect(config.receivers['otlp/jevable'].protocols.http).toEqual({ endpoint: '127.0.0.1:4318',
    tls: { cert_file: '/private/gateway/receiver.crt', key_file: '/private/gateway/receiver.key', min_version: '1.2' },
    auth: { authenticator: 'bearertokenauth/receiver' } })
  expect(config.extensions).toEqual({ 'bearertokenauth/receiver': { filename: '/private/gateway/receiver.token' },
    'bearertokenauth/traces': { filename: '/private/gateway/traces.token' },
    'bearertokenauth/metrics': { filename: '/private/gateway/metrics.token' } })
})
it('routes each signal only to its reviewed TLS backend with explicit bounded forwarding and first-position memory limiter', () => {
  const { config } = contents()
  expect(config.exporters['otlphttp/traces']).toMatchObject({ traces_endpoint: options.backends.traces!.endpoint, encoding: 'proto',
    tls: { ca_file: '/private/gateway/traces.ca.crt', min_version: '1.2' }, auth: { authenticator: 'bearertokenauth/traces' } })
  expect(config.exporters['otlp/metrics']).toMatchObject({ endpoint: 'metrics.example:4317', tls: { min_version: '1.2' } })
  expect(config.exporters['otlphttp/logs']).toMatchObject({ logs_endpoint: options.backends.logs!.endpoint })
  expect(config.exporters['otlphttp/logs'].auth).toBeUndefined()
  for (const [signal, id] of [['traces', 'otlphttp/traces'], ['metrics', 'otlp/metrics'], ['logs', 'otlphttp/logs']]) {
    expect(config.service.pipelines[signal!]).toEqual({ receivers: ['otlp/jevable'], processors: ['memory_limiter', 'resource/explicit', 'batch'], exporters: [id] })
    expect(config.exporters[id!]).toMatchObject({ sending_queue: { enabled: true, num_consumers: 1, queue_size: 128 },
      retry_on_failure: { enabled: true, initial_interval: '1s', max_interval: '5s', max_elapsed_time: '30000ms' } })
  }
  expect(config.processors.memory_limiter).toEqual({ check_interval: '1s', limit_mib: 400, spike_limit_mib: 80 })
  expect(config.processors.batch).toEqual({ timeout: '1000ms', send_batch_size: 512, send_batch_max_size: 512 })
})
it('exports an opt-in fsynced persistent queue without an unflushed batch processor', () => {
  const value = { ...options, batch: undefined, forwarding: { queueSize: 128, retryMaxElapsedMs: 0,
    persistentQueue: { directory: '/var/lib/otelcol/jevable-queue' } } }
  const { bundle, config, files } = contents(value)
  expect(config.extensions['file_storage/queue']).toEqual({ directory: '/var/lib/otelcol/jevable-queue',
    create_directory: false, fsync: true, recreate: false })
  expect(config.service.extensions).toContain('file_storage/queue')
  expect(config.processors.batch).toBeUndefined()
  for (const [signal, id] of [['traces', 'otlphttp/traces'], ['metrics', 'otlp/metrics'], ['logs', 'otlphttp/logs']]) {
    expect(config.service.pipelines[signal!].processors).toEqual(['memory_limiter', 'resource/explicit'])
    expect(config.exporters[id!].sending_queue).toEqual({ enabled: true, num_consumers: 1,
      queue_size: 128, storage: 'file_storage/queue' })
    expect(config.exporters[id!].retry_on_failure.max_elapsed_time).toBe('0s')
  }
  expect(Buffer.from(files['README.md']!).toString()).toContain('A full queue rejects new telemetry')
  expect(Buffer.from(files['README.md']!).toString()).not.toContain('Queues are bounded but memory-only')
  expect(bundle.manifest.execution).toBe('not-run')
})
it.each(['/','relative/queue','/tmp/../queue','/data//queue','/data/queue/','/data/${env:SECRET}',
  '/data/queue?token=x','/data/queue\\else'])('refuses unsafe persistent queue location %s', directory => {
  expect(() => contents({ ...options, batch: undefined, forwarding: { queueSize: 128, retryMaxElapsedMs: 0,
    persistentQueue: { directory } } })).toThrow('invalid-command')
})
it('refuses a memory queue with unlimited retry or a persistent queue with an unflushed batch or finite retry', () => {
  expect(() => contents({ ...options, forwarding: { queueSize: 128, retryMaxElapsedMs: 0 } })).toThrow('invalid-command')
  expect(() => contents({ ...options, forwarding: { queueSize: 128, retryMaxElapsedMs: 0,
    persistentQueue: { directory: '/data/queue' } } })).toThrow('invalid-command')
  expect(() => contents({ ...options, batch: undefined, forwarding: { queueSize: 128, retryMaxElapsedMs: 30000,
    persistentQueue: { directory: '/data/queue' } } })).toThrow('invalid-command')
})
it.each([1000, 1999, 4999, 5000, 60000])('keeps exporter retry intervals within the admitted %i ms total retry budget', retryMaxElapsedMs => {
  const { config } = contents({ ...options, forwarding: { ...options.forwarding, retryMaxElapsedMs } })
  for (const exporter of Object.values(config.exporters) as any[]) {
    expect(exporter.retry_on_failure).toEqual({ enabled: true, initial_interval: '1s',
      max_interval: retryMaxElapsedMs < 5000 ? `${retryMaxElapsedMs}ms` : '5s', max_elapsed_time: `${retryMaxElapsedMs}ms` })
  }
})
it('enriches absent cluster/environment attributes only; never rewrites pod/application identity or adds discovery/scraping', () => {
  const { config } = contents()
  expect(config.processors['resource/explicit'].attributes).toEqual([
    { key: 'k8s.cluster.name', value: 'reviewed-cluster', action: 'insert' },
    { key: 'deployment.environment.name', value: 'staging', action: 'insert' },
  ])
  expect(Object.keys(config.receivers)).toEqual(['otlp/jevable'])
  expect(Object.keys(config.processors)).toEqual(['memory_limiter', 'resource/explicit', 'batch'])
  expect(Object.keys(config.exporters)).toEqual(['otlphttp/traces', 'otlp/metrics', 'otlphttp/logs'])
  expect(config.service.telemetry).toEqual({ logs: { level: 'warn' }, metrics: { level: 'none' } })
})
it('disables implicit Collector self-metrics listeners when no explicit selection is supplied', () => {
  const { bundle, config, files } = contents()
  expect(config.service.telemetry.metrics).toEqual({ level: 'none' })
  expect(bundle.manifest.selfMetrics).toEqual({ enabled: false })
  expect(Buffer.from(files['README.md']!).toString()).toContain('no implicit default Prometheus listener')
})
it.each(['127.0.0.1', '::1'])('exports only the selected loopback %s normal-level Prometheus reader', bindAddress => {
  const value = { ...options, selfMetrics: { bindAddress, port: 8889 } }, before = structuredClone(value)
  const { bundle, config, files } = contents(value)
  expect(config.service.telemetry.metrics).toEqual({ level: 'normal', readers: [{ pull: { exporter: { prometheus: {
    host: bindAddress, port: 8889, without_type_suffix: true, without_units: true,
  } } } }] })
  expect(bundle.manifest.selfMetrics).toEqual({ enabled: true, bindAddress, port: 8889, transport: 'loopback-http', format: 'prometheus-text' })
  expect(bundle.manifest.requiredPrivateFiles).toEqual(contents().bundle.manifest.requiredPrivateFiles)
  expect(config.receivers).toEqual(contents().config.receivers)
  expect(config.exporters).toEqual(contents().config.exporters)
  expect(Buffer.from(files['README.md']!).toString()).toContain('unauthenticated loopback HTTP')
  expect(value).toEqual(before)
})
it.each([
  { bindAddress: '0.0.0.0', port: 8889 }, { bindAddress: '::', port: 8889 },
  { bindAddress: 'localhost', port: 8889 }, { bindAddress: 'remote.example', port: 8889 },
  { bindAddress: '127.0.0.1', port: 0 }, { bindAddress: '127.0.0.1', port: 1023 },
  { bindAddress: '127.0.0.1', port: 65536 }, { bindAddress: '127.0.0.1', port: 8889.5 },
  { bindAddress: '127.0.0.1', port: 4318 }, { bindAddress: '::1', port: 4318 },
  { bindAddress: '127.0.0.1', port: 8889, token: 'PRIVATE_VALUE' },
  { bindAddress: '127.0.0.1', port: 8889, level: 'detailed' },
  { bindAddress: '127.0.0.1', port: 8889, labels: { runId: 'PRIVATE_VALUE' } },
  { bindAddress: '127.0.0.1', port: 8889, insecure: true },
])('refuses implicit/public/credentialed/arbitrary/conflicting self-metrics %j', selfMetrics => {
  expect(() => contents({ ...options, selfMetrics })).toThrow('invalid-command')
})
it('exports a single explicitly enabled gRPC signal over IPv6 without spurious enrichment or other pipelines', () => {
  const value = { ...options, enrichment: undefined, receiver: { protocol: 'grpc', bindAddress: '::1', port: 4317 },
    backends: { logs: options.backends.logs } }, { bundle, config } = contents(value)
  expect(bundle.manifest.enabledSignals).toEqual(['logs'])
  expect(bundle.manifest.requiredPrivateFiles).toEqual(['receiver.crt', 'receiver.key', 'receiver.token'])
  expect(config.receivers['otlp/jevable'].protocols.grpc.endpoint).toBe('[::1]:4317')
  expect(config.receivers['otlp/jevable'].protocols.http).toBeUndefined()
  expect(config.processors['resource/explicit']).toBeUndefined()
  expect(config.service.pipelines).toEqual({ logs: { receivers: ['otlp/jevable'], processors: ['memory_limiter', 'batch'], exporters: ['otlphttp/logs'] } })
})
it.each([
  { profile: 'latest' }, { secret: 'PRIVATE_VALUE' }, { backends: {} },
  { backends: { traces: { ...options.backends.traces, token: 'PRIVATE_VALUE' } } },
  { receiver: { ...options.receiver, bindAddress: 'discovered.example' } },
  { receiver: { ...options.receiver, port: 0 } }, { receiver: { ...options.receiver, insecure: true } },
  { enrichment: { serviceInstanceId: 'invented' } }, { enrichment: { clusterName: '${env:SECRET}' } },
  { memory: { limitMiB: 128, spikeLimitMiB: 128 } }, { memory: { limitMiB: 100, spikeLimitMiB: 10 } },
  { batch: { maxRecords: 9000, timeoutMs: 1 } }, { forwarding: { queueSize: 0, retryMaxElapsedMs: 100000 } },
])('refuses unsupported configuration, secret values and unsafe bounds %j', change => {
  expect(() => contents({ ...options, ...change })).toThrow('invalid-command')
})
it.each(['http://remote.example/v1/traces', 'https://user:password@remote.example/v1/traces',
  'https://remote.example/v1/traces?token=PRIVATE_VALUE', 'https://remote.example/v1/traces#secret',
  'https://remote.example/${env:SECRET}', 'https://remote.example/space here', 'https://remote.example\\escape',
  'https://remote.example', 'https://REMOTE.example/v1/traces', 'https://bad..example/v1/traces'])('refuses credentialed, interpolated or noncanonical destination %s', endpoint => {
  expect(() => contents({ ...options, backends: { traces: { ...options.backends.traces, endpoint } } })).toThrow('invalid-command')
})
it('refuses gRPC paths and non-serializable or oversized SDK input with sanitized errors', () => {
  expect(() => contents({ ...options, backends: { metrics: { ...options.backends.metrics, endpoint: 'https://metrics.example/path' } } })).toThrow('invalid-command')
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
  for (const value of [cyclic, { ...options, huge: 'PRIVATE_VALUE'.repeat(3000) }, { value: 1n }]) {
    expect(() => contents(value)).toThrow('invalid-command')
  }
})
it('makes secure default gRPC port explicit and preserves IPv6 authority without mutating input', () => {
  for (const [endpoint, authority] of [['https://metrics.example/', 'metrics.example:443'], ['https://[::1]:4317/', '[::1]:4317']]) {
    const value = { ...options, backends: { metrics: { ...options.backends.metrics, endpoint } } }, before = structuredClone(value)
    expect(contents(value).config.exporters['otlp/metrics'].endpoint).toBe(authority)
    expect(value).toEqual(before)
  }
})
async function invoke(argv: string[]) {
  let stdout = '', stderr = ''
  const code = await main(argv, { out: x => { stdout += x }, err: x => { stderr += x } })
  return { code, stdout, stderr }
}
it('CLI exports only reviewed input bytes, without an owner, then refuses existing output and explicitly overwrites atomically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jevable-gateway-cli-')), input = join(dir, 'options.json'), output = join(dir, 'gateway.zip')
  const bytes = JSON.stringify(options); await writeFile(input, bytes)
  const argv = ['telemetry', 'export-gateway', '--options-file', input, '--options-sha256', hash(bytes), '--output', output]
  const result = await invoke(argv); expect(result.code).toBe(0); expect(result.stderr).toBe('')
  const receipt = JSON.parse(result.stdout), archive = await readFile(output)
  expect(receipt.reviewedOptionsSha256).toBe(hash(bytes)); expect(receipt.artifact.sha256).toBe(hash(archive))
  expect(receipt.artifact.bytes).toBe(archive.length); expect((await lstat(output)).mode & 0o077).toBe(0)
  expect((await invoke(argv)).code).not.toBe(0); expect(await readFile(output)).toEqual(archive)
  expect((await invoke([...argv, '--overwrite'])).code).toBe(0)
  expect(await readdir(dir)).toEqual(expect.arrayContaining(['options.json', 'gateway.zip']))
  expect((await readdir(dir)).length).toBe(2)
})
it('CLI refuses wrong review hash and invalid or private input without replacing an existing artifact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jevable-gateway-refusal-')), input = join(dir, 'options.json'), output = join(dir, 'gateway.zip')
  await writeFile(output, 'preserved')
  for (const [bytes, pin] of [[JSON.stringify(options), 'a'.repeat(64)], ['{PRIVATE_VALUE', undefined],
    [JSON.stringify({ ...options, secret: 'PRIVATE_VALUE' }), undefined]]) {
    await writeFile(input, bytes!)
    const result = await invoke(['telemetry', 'export-gateway', '--options-file', input, '--options-sha256', pin ?? hash(bytes!), '--output', output, '--overwrite'])
    expect(result.code).not.toBe(0); expect(result.stdout + result.stderr).not.toContain('PRIVATE_VALUE')
    expect(await readFile(output, 'utf8')).toBe('preserved')
  }
})
it('CLI admits required flags/hash before reading options and rejects owner/Docker/service selection entirely', async () => {
  for (const tail of [[], ['--options-file', '/never-read', '--output', '/never-write'],
    ['--options-file', '/never-read', '--options-sha256', 'invalid', '--output', '/never-write'],
    ['--options-file', '/never-read', '--options-sha256', 'a'.repeat(64), '--output', '/never-write', '--runtime', 'docker']]) {
    const result = await invoke(['telemetry', 'export-gateway', ...tail]); expect(result.code).toBe(2)
    expect(result.stdout + result.stderr).not.toContain('ENOENT')
  }
})
it('discovers the same consuming gateway schema and the no-owner offline CLI grammar without reading files', async () => {
  expect(listSchemas().schemas.some(x => x.id === 'collector-gateway-options')).toBe(true)
  const schema = showSchema('collector-gateway-options'); expect(schema.schema.additionalProperties).toBe(false)
  const result = await invoke(['telemetry', 'export-gateway', '--help', '--json'])
  expect(result.code).toBe(0); const help = JSON.parse(result.stdout)
  expect(help.command).toBe('telemetry export-gateway')
  expect(result.stdout).not.toContain('data-dir'); expect(result.stdout).not.toContain('token-file')
})

import { expect, it } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { parse } from 'yaml'
import { parseTelemetryConfig } from '../src/telemetry/config.ts'

const root = new URL('../examples/observability/', import.meta.url)
const yaml = async (name: string) => parse(await readFile(new URL(name, root), 'utf8'))
const dashboard = JSON.parse(await readFile(new URL('workflow-runtime.json', root), 'utf8'))

it('keeps optional backend startup pinned, explicit, local and separate from runtime/host state', async () => {
  const config = await yaml('compose.yaml'), service = config.services.observability
  expect(service.image).toMatch(/^grafana\/otel-lgtm@sha256:[a-f0-9]{64}$/u)
  expect(service.pull_policy).toBe('never'); expect(service.ports).toHaveLength(2)
  for (const port of service.ports) expect(port).toMatch(/^127\.0\.0\.1:/u)
  expect(service.environment.GF_AUTH_ANONYMOUS_ENABLED).toBe('false')
  expect(service.environment.ENABLE_OBI).toBe('false')
  expect(service.environment.GF_PLUGINS_PREINSTALL_DISABLED).toBe('true')
  expect(service.environment.GRAFANA_URL).toBe('http://127.0.0.1:1')
  expect(config.networks.private.driver).toBe('bridge')
  expect(config.networks.private.internal).toBeUndefined()
  expect(service.environment.GF_PATHS_CONFIG).toBeUndefined()
  expect(service.volumes.find((v: any) => v.source === './grafana.ini').target).toBe('/otel-lgtm/grafana/conf/custom.ini')
  expect(service.privileged).toBeUndefined(); expect(service.pid).toBeUndefined()
  expect(service.volumes.filter((v: unknown) => typeof v === 'string')).toEqual(['data:/data'])
  for (const mount of service.volumes.filter((v: unknown) => typeof v === 'object')) {
    expect(mount.type).toBe('bind'); expect(mount.read_only).toBe(true); expect(mount.bind.create_host_path).toBe(false)
    expect(mount.source).toMatch(/^\.\/[a-z-]+\.(ini|yaml|json)$/u)
    await readFile(new URL(mount.source, root))
    expect(mount.target).not.toMatch(/docker\.sock|harness|jarness|workflow-state/u)
  }
  expect(config.secrets.grafana_admin_password.file).toContain(':?')
})

it('configures only explicit local receiver pipelines with bounded memory, batches and transport retry', async () => {
  const collector = await yaml('otelcol.yaml')
  expect(Object.keys(collector.receivers.otlp.protocols)).toEqual(['grpc', 'http'])
  expect(collector.receivers.otlp.protocols.grpc).toEqual({ endpoint: '0.0.0.0:4317', max_recv_msg_size_mib: 4 })
  expect(collector.receivers.otlp.protocols.http.cors).toBeUndefined()
  expect(collector.processors.memory_limiter.limit_mib).toBe(256)
  for (const signal of ['traces', 'metrics', 'logs']) {
    const pipeline = collector.service.pipelines[signal]
    expect(pipeline.processors).toEqual(['memory_limiter', 'batch'])
    expect(pipeline.exporters).toEqual(['otlp_http/' + signal])
    const exporter = collector.exporters[pipeline.exporters[0]]
    expect(exporter.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:/u)
    expect(exporter.sending_queue.queue_size).toBe(128)
    expect(exporter.retry_on_failure.max_elapsed_time).toBe('30s')
  }
  expect(Object.keys(collector.exporters)).toHaveLength(3)
})

it('uses a privacy-bounded metric translation/resource contract and separate signal opt-ins', async () => {
  const prometheus = await yaml('prometheus.yaml')
  expect(prometheus.otlp.translation_strategy).toBe('UnderscoreEscapingWithoutSuffixes')
  expect(prometheus.otlp.promote_all_resource_attributes).toBeUndefined()
  expect(prometheus.otlp.promote_resource_attributes).toEqual(['service.name', 'service.instance.id', 'deployment.environment.name', 'jevable.storage.kind', 'k8s.namespace.name', 'k8s.pod.name'])
  const telemetry = parseTelemetryConfig(JSON.parse(await readFile(new URL('telemetry.json', root), 'utf8')))
  expect(telemetry).toMatchObject({ httpRequests: true, exporterMetrics: true, retainedStateMetrics: true, intervalMs: 1000, authentication: { kind: 'none' } })
  const grpc = parseTelemetryConfig(JSON.parse(await readFile(new URL('telemetry-grpc.json', root), 'utf8')))
  expect(grpc).toMatchObject({ protocol: 'grpc', endpoint: 'http://127.0.0.1:4317', metricsEndpoint: 'http://127.0.0.1:4317', logsEndpoint: 'http://127.0.0.1:4317' })
  expect((await yaml('compose.grpc.yaml')).services.observability.ports).toEqual(['127.0.0.1:${JEVABLE_OTLP_GRPC_PORT:-4317}:4317'])
})

it('keeps instance selection singular and missing values unknown throughout the dashboard', () => {
  const variables = dashboard.templating.list
  expect(variables.map((v: any) => v.name)).toEqual(['service', 'environment', 'instance'])
  for (const variable of variables) { expect(variable.multi).toBe(false); expect(variable.includeAll).toBe(false) }
  let queries = 0
  for (const panel of dashboard.panels.filter((p: any) => p.datasource?.uid === 'prometheus')) {
    expect(panel.fieldConfig.defaults.noValue).toContain('unknown')
    for (const target of panel.targets) {
      expect(target.expr).toContain('${instance:regex}'); expect(target.expr).toContain('${service:regex}')
      expect(target.expr).toContain('${environment:regex}'); expect(target.expr).not.toContain('or vector(0)'); queries++
    }
  }
  expect(queries).toBe(22)
})

it('binds dashboard metric names to actual owned runtime instruments', async () => {
  const declarations = (await Promise.all(['metrics.ts', 'retained-metrics.ts', 'exporter-health.ts'].map(name => readFile(new URL('../src/telemetry/' + name, import.meta.url), 'utf8')))).join('\n')
  const names = new Set([...declarations.matchAll(/create(?:Counter|Histogram|UpDownCounter|ObservableCounter|ObservableGauge)\('([^']+)'/gu)].map(m => m[1]!.replaceAll('.', '_')))
  for (const panel of dashboard.panels.filter((p: any) => p.datasource?.uid === 'prometheus')) for (const target of panel.targets) {
    for (const [metric] of target.expr.matchAll(/jevable_[a-z_]+(?=\{)/gu)) expect(names.has(metric.replace(/_bucket$/u, '')), metric).toBe(true)
  }
})

it('ships alert evaluation fixtures but no notification or automatic workflow action', async () => {
  const alerts = await yaml('alerts.yaml'), tests = await yaml('alerts.test.yaml')
  expect(tests.tests).toHaveLength(5)
  expect(alerts.groups[0].rules.filter((r: any) => r.alert)).toHaveLength(7)
  expect(alerts.groups[0].rules[0].expr).toContain('time() - timestamp(jevable_retained_available) < 30')
  expect((await yaml('prometheus.yaml')).alerting).toBeUndefined()
  expect(await readdir(root)).not.toContain('.env')
  const ini = await readFile(new URL('grafana.ini', root), 'utf8')
  expect(ini).toContain('admin_password = $__file{/run/secrets/grafana_admin_password}')
  expect(ini).not.toContain('admin_password = admin')
})

import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { RuntimeTelemetry } from '../src/telemetry/traces.ts'
import { parseTelemetryConfig } from '../src/telemetry/config.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { resourceAttributes } from '../scripts/check-telemetry-package.mjs'

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })
const base = { endpoint: 'http://127.0.0.1:4318/v1/traces', authentication: { kind: 'none' as const }, intervalMs: 60000 }
const resource = { serviceNamespace: 'automation', kubernetes: { namespace: 'workflows', podName: 'workflow-123',
  podUid: '11111111-1111-4111-8111-111111111111', containerName: 'workflow', nodeName: 'node.example', clusterName: 'private-cluster' } }

it.each([
  { arbitrary: 'secret' }, { serviceInstanceId: 'fixed' }, { serviceNamespace: 'x'.repeat(129) }, { serviceNamespace: 'line\nbreak' },
  { kubernetes: { labels: { secret: 'private' } } }, { kubernetes: { annotations: {} } }, { kubernetes: { podUid: 'bad' } },
  { kubernetes: { namespace: '../escape' } }, { kubernetes: { containerName: 'x'.repeat(64) } },
  { kubernetes: { podName: 'x'.repeat(254) } }, { kubernetes: { nodeName: '\u0000' } }, { kubernetes: { clusterName: '' } },
])('refuses unbounded/arbitrary resource metadata without echoing it: %j', value => {
  expect(() => parseTelemetryConfig({ ...base, resource: value })).toThrow('invalid-command')
})

it.each(['sqlite', 'postgres'] as const)('shares explicit resources across actual protobuf signals; restarts retain pod UID but not instance identity (%s)', async storage => {
  vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', 'secret=AMBIENT_SECRET,service.instance.id=fixed')
  vi.stubEnv('OTEL_SERVICE_NAME', 'AMBIENT_SERVICE'); vi.stubEnv('JEVABLE_K8S_POD_NAME', 'AMBIENT_POD')
  const requests: { endpoint: string; bytes: Buffer }[] = []
  vi.stubGlobal('fetch', vi.fn(async (endpoint: string, options: RequestInit) => {
    requests.push({ endpoint, bytes: Buffer.from(options.body as Uint8Array) })
    return new Response(null, { status: 200, headers: { 'content-type': 'application/x-protobuf' } })
  }))
  const instances = new Set<string>()
  for (const configured of [true, true, false]) {
    const config = { ...base, metricsEndpoint: base.endpoint.replace('traces', 'metrics'), logsEndpoint: base.endpoint.replace('traces', 'logs'),
      ...(configured ? { resource: structuredClone(resource) } : {}) }
    const runtime = new RuntimeTelemetry(config, () => undefined, { storage })
    const identity = runtime.status().resource
    expect(identity.serviceInstanceId).toMatch(/^[a-f0-9-]{36}$/)
    const originalIdentity = identity.serviceInstanceId
    identity.serviceInstanceId = 'caller-mutation'
    expect(runtime.status().resource).toEqual({ serviceInstanceId: originalIdentity })
    if (config.resource) config.resource.kubernetes.podName = 'changed-after-open'
    const start = requests.length
    try { runtime.end(runtime.start('jevable.run', { 'jevable.run.id': randomUUID() }), 'completed'); await runtime.flush() }
    finally { await runtime.close() }
    const batches = requests.slice(start)
    expect(batches.map(r => r.endpoint).sort()).toEqual(['logs', 'metrics', 'traces'].map(s => base.endpoint.replace('traces', s)))
    const resources = batches.flatMap(b => resourceAttributes(b.bytes)); expect(resources).toHaveLength(3)
    expect(resources[0]).toEqual(resources[1]); expect(resources[1]).toEqual(resources[2])
    const r = resources[0]!, instance = r['service.instance.id']!
    expect(instance).toBe(originalIdentity)
    expect(runtime.status().resource.serviceInstanceId).toBe(instance)
    expect(instance).toMatch(/^[a-f0-9-]{36}$/); expect(instances.has(instance)).toBe(false); instances.add(instance)
    expect(r).toEqual({ 'service.name': 'jevable-workflow-runtime', 'service.version': CORE_VERSION, 'service.instance.id': instance,
      'deployment.environment.name': 'local', 'jevable.storage.kind': storage, ...(configured ? {
        'service.namespace': 'automation', 'k8s.namespace.name': 'workflows', 'k8s.pod.name': 'workflow-123',
        'k8s.pod.uid': resource.kubernetes.podUid, 'k8s.container.name': 'workflow', 'k8s.node.name': 'node.example', 'k8s.cluster.name': 'private-cluster',
      } : {}) })
  }
})

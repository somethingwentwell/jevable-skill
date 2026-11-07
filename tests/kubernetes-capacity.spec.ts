import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stringify } from 'yaml'
import { inspectKubernetesCapacity, KubernetesCapacityInputError } from '../src/deployment/index.ts'
import { main } from '../src/cli.ts'
import { capabilities } from '../src/capabilities.ts'

const resources = (cpu = '100m', memory = '128Mi') => ({ requests: { cpu, memory } })
const container = (name = 'app', cpu = '100m', memory = '128Mi') => ({ name, resources: resources(cpu, memory) })
const node = (name = 'node-a', cpu = '4', memory = '1Gi', pods = '20') => ({ metadata: { name, labels: { 'kubernetes.io/os': 'linux', 'kubernetes.io/arch': 'arm64' } }, status: { allocatable: { cpu, memory, pods } } })
const pod = (name = 'app', cpu = '100m', memory = '128Mi') => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: 'test' }, spec: { containers: [container('app', cpu, memory)] } })
const nodes = (items = [node()]) => ({ apiVersion: 'v1', kind: 'NodeList', metadata: { resourceVersion: 'synthetic' }, items })
const pods = (items: any[] = []) => ({ apiVersion: 'v1', kind: 'PodList', metadata: { resourceVersion: 'synthetic' }, items })
const inspect = (workload: unknown = pod(), existing: any[] = [], cluster = nodes()) => inspectKubernetesCapacity({ workloadYaml: stringify(workload), nodes: cluster, pods: pods(existing) })
const bound = (name: string, cpu = '100m', memory = '128Mi', nodeName = 'node-a') => ({ ...pod(name, cpu, memory), spec: { ...pod(name, cpu, memory).spec, nodeName }, status: { phase: 'Running' } })
const controller = (kind = 'Deployment', spec: object = {}) => ({ apiVersion: kind === 'Job' ? 'batch/v1' : 'apps/v1', kind,
  metadata: { name: 'workflow', namespace: 'test' }, spec: { ...spec, template: { spec: pod().spec } } })

describe('pure Kubernetes CPU/memory/pod request accounting', () => {
  it('reports headroom without a reservation, scheduling or execution claim; leaves inputs unchanged', () => {
    const input = { workloadYaml: stringify(pod()), nodes: nodes(), pods: pods([bound('existing')]) }, before = structuredClone(input)
    const report = inspectKubernetesCapacity(input)
    expect(report).toMatchObject({ status: 'no-obvious-request-shortage', execution: 'not-run', clusterMutation: false, capacityReserved: false,
      assessment: 'additional-pods-not-replacement-credit', demand: { cpuMillis: '100', memoryBytes: '134217728', pods: '1' } })
    expect(report.nodes[0]?.available).toEqual({ cpuMillis: '3900', memoryBytes: '939524096', pods: '19' })
    expect(input).toEqual(before)
  })
  it('detects the actual Minikube-shaped memory shortage despite spare CPU', () => {
    const r = inspect(pod('workflow', '100m', '256Mi'), [bound('retained', '6200m', '7850Mi')], nodes([node('node-a', '10', '7959Mi')]))
    expect(r.status).toBe('insufficient-capacity'); expect(r.nodes[0]?.available.memoryBytes).toBe(String(109 * 1024 * 1024))
    expect(r.shortages.map(s => s.code)).toContain('request-does-not-fit')
  })
  it.each([
    ['cpu', '3901m', '128Mi'], ['memory', '100m', '897Mi'],
  ])('detects insufficient %s from requests, not limits or current utilization', (_name, cpu, memory) => {
    expect(inspect(pod('new', cpu, memory), [bound('existing')]).status).toBe('insufficient-capacity')
  })
  it('includes node pod-count capacity', () => {
    const r = inspect(pod(), [bound('existing')], nodes([node('node-a', '4', '1Gi', '1')]))
    expect(r.status).toBe('insufficient-capacity'); expect(r.nodes[0]?.available.pods).toBe('0')
  })
  it('does not double-count matching init and application requests in the emitted workflow profile', () => {
    const p: any = pod(); p.spec.initContainers = [container('private-configuration')]
    expect(inspect(p).demand).toEqual({ cpuMillis: '100', memoryBytes: '134217728', pods: '1' })
  })
  it('takes the per-resource init peak rather than only the app or highest single container', () => {
    const p: any = pod(); p.spec.initContainers = [container('cpu-stage', '1', '64Mi'), container('memory-stage', '50m', '512Mi')]
    expect(inspect(p).demand).toEqual({ cpuMillis: '1000', memoryBytes: '536870912', pods: '1' })
  })
  it('accounts ordered restartable init sidecars during both initialization and steady state', () => {
    const p: any = pod(); p.spec.initContainers = [
      { ...container('first-sidecar', '200m', '64Mi'), restartPolicy: 'Always' },
      container('large-stage', '500m', '512Mi'),
      { ...container('second-sidecar', '300m', '32Mi'), restartPolicy: 'Always' },
    ]
    expect(inspect(p).demand).toEqual({ cpuMillis: '700', memoryBytes: '603979776', pods: '1' })
  })
  it('adds pod overhead after the effective init/app resource peak', () => {
    const p: any = pod(); p.spec.overhead = { cpu: '20m', memory: '16Mi' }
    expect(inspect(p).demand).toEqual({ cpuMillis: '120', memoryBytes: '150994944', pods: '1' })
  })
  it('uses an explicit pod-level request per resource, preserving other container resources', () => {
    const p: any = pod(); p.spec.resources = { requests: { cpu: '2' } }; p.spec.overhead = { cpu: '10m' }
    expect(inspect(p).demand).toEqual({ cpuMillis: '2010', memoryBytes: '134217728', pods: '1' })
  })
  it('includes admission defaulting of pod-level limits while preserving explicit zero requests', () => {
    const p: any = pod(); p.spec.resources = { requests: { cpu: '0' }, limits: { cpu: '2', memory: '512Mi' } }
    expect(inspect(p).demand).toEqual({ cpuMillis: '0', memoryBytes: '536870912', pods: '1' })
  })
  it('defaults a missing request to its limit, without overriding an explicit zero', () => {
    const p: any = pod(); p.spec.containers[0].resources = { requests: { cpu: '0' }, limits: { cpu: '2', memory: '256Mi' } }
    expect(inspect(p).demand).toEqual({ cpuMillis: '0', memoryBytes: '268435456', pods: '1' })
  })
  it('sums before rounding final CPU millis and memory bytes', () => {
    const p: any = pod(); p.spec.containers = [container('a', '100u', '400m'), container('b', '100u', '400m')]
    expect(inspect(p).demand).toEqual({ cpuMillis: '1', memoryBytes: '1', pods: '1' })
  })
  it.each([
    ['0.25', '123Mi', '250', String(123 * 1024 * 1024)],
    ['250m', '129M', '250', '129000000'], ['+2.5e-1', '129e6', '250', '129000000'],
    ['250000u', '129000000000m', '250', '129000000'], ['.25', '1Ki', '250', '1024'],
    ['250000000n', '1G', '250', '1000000000'],
  ])('parses exact quantity %s / %s', (cpu, memory, cpuMillis, memoryBytes) => {
    expect(inspect(pod('new', cpu, memory)).demand).toEqual({ cpuMillis, memoryBytes, pods: '1' })
  })
  it('retains the larger spec, actuated and allocated request during a pending resize', () => {
    const p: any = bound('existing', '100m', '128Mi'); p.status.containerStatuses = [{ name: 'app', resources: resources('200m', '256Mi'), allocatedResources: { cpu: '300m', memory: '512Mi' } }]
    expect(inspect(pod(), [p]).nodes[0]?.requested).toEqual({ cpuMillis: '300', memoryBytes: '536870912', pods: '1' })
  })
  it('uses actuated/allocated rather than an infeasible resize spec per v1.35 semantics', () => {
    const p: any = bound('existing', '8', '8Gi'); p.status.conditions = [{ type: 'PodResizePending', reason: 'Infeasible' }]
    p.status.containerStatuses = [{ name: 'app', resources: resources('200m', '256Mi'), allocatedResources: { cpu: '300m', memory: '512Mi' } }]
    expect(inspect(pod(), [p]).nodes[0]?.requested).toEqual({ cpuMillis: '300', memoryBytes: '536870912', pods: '1' })
  })
  it('never credits observed resize status from copied workload YAML to an additional new pod', () => {
    const p: any = pod('new', '8', '8Gi'); p.status = { conditions: [{ type: 'PodResizePending', reason: 'Infeasible' }],
      containerStatuses: [{ name: 'app', resources: resources('100m', '128Mi'), allocatedResources: { cpu: '100m', memory: '128Mi' } }] }
    const r = inspect(p); expect(r.status).toBe('insufficient-capacity')
    expect(r.demand).toEqual({ cpuMillis: '8000', memoryBytes: '8589934592', pods: '1' })
  })
  it('refuses duplicate container or status names instead of choosing an ambiguous resource record', () => {
    const p: any = pod(); p.spec.initContainers = [container('app')]
    expect(() => inspect(p)).toThrow(KubernetesCapacityInputError)
    const existing: any = bound('existing'); existing.status.containerStatuses = [
      { name: 'app', resources: resources('100m', '128Mi') }, { name: 'app', resources: resources('4', '1Gi') }]
    expect(() => inspect(pod(), [existing])).toThrow(KubernetesCapacityInputError)
  })
  it('keeps terminating bound pods charged and excludes only terminal Failed/Succeeded phases', () => {
    const p: any = bound('terminating'); p.metadata.deletionTimestamp = 'synthetic'
    const finished = [bound('failed'), bound('done')]; finished[0]!.status.phase = 'Failed'; finished[1]!.status.phase = 'Succeeded'
    expect(inspect(pod(), [p, ...finished]).nodes[0]?.requested.pods).toBe('1')
  })
  it('reports pending unbound competition without guessing a node or reserving it', () => {
    const p: any = pod('pending', '4', '1Gi'); p.status = { phase: 'Pending' }
    const r = inspect(pod(), [p]); expect(r.pendingPodsNotReserved).toBe(1); expect(r.nodes[0]?.requested.pods).toBe('0')
  })
  it('uses allocatable rather than capacity and does not credit a replacement or existing workload name', () => {
    const r = inspect(pod('app', '4', '1Gi'), [bound('app')])
    expect(r.status).toBe('insufficient-capacity'); expect(r.assessment).toBe('additional-pods-not-replacement-credit')
  })
  it('handles explicit node name and selector without combining CPU on one node with memory on another', () => {
    const p: any = pod('new', '2', '512Mi'); p.spec.nodeSelector = { 'kubernetes.io/arch': 'arm64' }
    const r = inspect(p, [], nodes([node('cpu', '4', '256Mi'), node('ram', '1', '1Gi')]))
    expect(r.shortages.map(s => s.code)).toContain('request-does-not-fit')
    p.spec.nodeName = 'absent'; expect(inspect(p).shortages.map(s => s.code)).toContain('no-matching-node')
  })
  it('includes the full additional batch and all workload replicas in aggregate headroom', () => {
    const r = inspect({ apiVersion: 'v1', kind: 'List', items: [controller('Deployment', { replicas: 5 }), controller('StatefulSet', { replicas: 5 })] })
    expect(r.demand.pods).toBe('10'); expect(r.shortages.map(s => s.code)).toContain('aggregate-request-shortage')
  })
  it('handles Job parallelism/completions, zero replicas and suspended jobs', () => {
    expect(inspect(controller('Job', { parallelism: 5, completions: 2 })).demand.pods).toBe('2')
    expect(inspect(controller('Job', { suspend: true })).demand.pods).toBe('0')
    expect(inspect(controller('Deployment', { replicas: 0 })).demand.pods).toBe('0')
  })
  it('does not include commands, environment values, annotation content or Secrets in the report', () => {
    const p: any = pod(); p.spec.containers[0].env = [{ name: 'PRIVATE', value: 'MUST_NOT_APPEAR' }]
    p.metadata.annotations = { private: 'MUST_NOT_APPEAR' }
    const r = inspect({ apiVersion: 'v1', kind: 'List', items: [p, { apiVersion: 'v1', kind: 'Secret', data: { token: 'MUST_NOT_APPEAR' } }] })
    expect(JSON.stringify(r)).not.toContain('MUST_NOT_APPEAR'); expect(r.capacityReserved).toBe(false)
  })
  it.each(['-1', 'NaN', 'Infinity', '1.2.3', '2 Gi', '1e1000000', '0;touch', '1mi'])('refuses unsafe or malformed quantity %s with sanitized errors', value => {
    expect(() => inspect(pod('new', value))).toThrow(KubernetesCapacityInputError)
    try { inspect(pod('new', value)) } catch (e) { expect(String(e)).not.toContain(value) }
  })
  it.each([
    (input: any) => { input.nodes.metadata.continue = 'next-page' },
    (input: any) => { input.pods.metadata.continue = 'next-page' },
    (input: any) => { input.nodes.items.push(input.nodes.items[0]) },
    (input: any) => { input.pods.items = [bound('same'), bound('same')] },
    (input: any) => { delete input.nodes.items[0].status.allocatable.memory },
    (input: any) => { input.pods.items = [bound('unknown-node', '100m', '128Mi', 'missing')] },
    (input: any) => { input.workloadYaml = 'kind: Pod\nkind: Secret' },
    (input: any) => { input.workloadYaml = stringify({ apiVersion: 'apps/v1', kind: 'DaemonSet' }) },
    (input: any) => { input.workloadYaml = stringify(controller('Deployment', { replicas: 129 })) },
  ])('refuses incomplete/ambiguous/unsupported inputs instead of claiming capacity (case %#)', change => {
    const input = { nodes: nodes(), pods: pods(), workloadYaml: stringify(pod()) }; change(input)
    expect(() => inspectKubernetesCapacity(input)).toThrow(KubernetesCapacityInputError)
  })
})

describe('owner-free Kubernetes CLI capacity diagnosis', () => {
  const cli = async (argv: string[]) => {
    let out = '', err = ''; const code = await main(argv, { out: s => out += s, err: s => err += s })
    return { code, out, err }
  }
  it('exposes an independent read-only capability/help grammar without opening any snapshot', async () => {
    expect(capabilities().kubernetesCapacity).toMatchObject({ available: true, clusterContact: false, clusterMutation: false, capacityReservation: false })
    const r = await cli(['kubernetes', 'capacity', '--help', '--json']); expect(r.code).toBe(0)
    expect(JSON.parse(r.out).variants[0].requirements.rules).toContainEqual({ kind: 'required', flags: ['nodes-file', 'pods-file'] })
  })
  it.each([
    ['kubernetes', 'capacity', 'never-read'],
    ['kubernetes', 'capacity', 'never-read', '--nodes-file', 'never-read'],
    ['kubernetes', 'capacity', 'never-read', '--nodes-file', 'never-read', '--pods-file', 'never-read', '--data-dir', 'never-created'],
    ['kubernetes', 'capacity', 'never-read', '--nodes-file', 'never-read', '--pods-file', 'never-read', '--endpoint', 'https://never-contact.invalid'],
    ['kubernetes', 'apply'],
  ])('refuses omitted/mixed authority before any input read %j', async (...argv) => {
    const r = await cli(argv); expect(r.code).toBe(2); expect(r.out).toBe(''); expect(r.err).not.toContain('never-read')
  })
  it('reads three explicit bounded regular files, returns hashes, and makes shortages nonzero', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jevable-capacity-')), manifest = join(dir, 'workload.yaml'), nodeFile = join(dir, 'nodes.json'), podFile = join(dir, 'pods.json')
    await writeFile(manifest, stringify(pod('workflow', '100m', '256Mi')))
    await writeFile(nodeFile, JSON.stringify(nodes([node('node-a', '10', '7959Mi')]))); await writeFile(podFile, JSON.stringify(pods([bound('retained', '6200m', '7850Mi')])))
    const r = await cli(['kubernetes', 'capacity', manifest, '--nodes-file', nodeFile, '--pods-file', podFile])
    expect(r.code).toBe(1); expect(r.err).toBe(''); const report = JSON.parse(r.out)
    expect(report.status).toBe('insufficient-capacity'); expect(report.inputs).toHaveLength(3)
    for (const input of report.inputs) { expect(input.sha256).toMatch(/^[a-f0-9]{64}$/u); expect(input.bytes).toBeGreaterThan(0) }
    await writeFile(podFile, JSON.stringify(pods())); expect((await cli(['kubernetes', 'capacity', manifest, '--nodes-file', nodeFile, '--pods-file', podFile])).code).toBe(0)
    const link = join(dir, 'link'); await symlink(manifest, link)
    const unsafe = await cli(['kubernetes', 'capacity', link, '--nodes-file', nodeFile, '--pods-file', podFile]); expect(unsafe.code).toBe(2); expect(unsafe.err).not.toContain(dir)
  })
})

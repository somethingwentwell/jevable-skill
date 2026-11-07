import { z } from 'zod'
import { parseAllDocuments } from 'yaml'

export class KubernetesCapacityInputError extends Error {
  constructor() { super('Provide complete, bounded Kubernetes node/pod JSON lists and supported workload YAML. Input details are withheld.') }
}
const name = z.string().min(1).max(253).regex(/^[a-z0-9][a-z0-9.-]*$/u)
const quantity = z.union([z.string().min(1).max(128), z.number().finite().nonnegative()])
const resourceList = z.record(z.string(), quantity)
const resources = z.object({ requests: resourceList.optional(), limits: resourceList.optional() })
const container = z.object({ name, resources: resources.optional(), restartPolicy: z.enum(['Always', 'Never', 'OnFailure']).optional() })
const podSpec = z.object({ containers: z.array(container).min(1).max(128), initContainers: z.array(container).max(128).optional(),
  resources: resources.optional(), overhead: resourceList.optional(), nodeName: name.optional(), nodeSelector: z.record(z.string(), z.string()).optional() })
const metadata = z.object({ name, namespace: name.optional(), uid: z.string().min(1).max(128).optional() })
const condition = z.object({ type: z.string(), reason: z.string().optional(), status: z.string().optional() })
const containerStatus = z.object({ name, allocatedResources: resourceList.optional(), resources: resources.optional() })
const pod = z.object({ metadata, spec: podSpec, status: z.object({ phase: z.string().optional(),
  conditions: z.array(condition).optional(), containerStatuses: z.array(containerStatus).optional(),
  initContainerStatuses: z.array(containerStatus).optional(), resources: resources.optional(), allocatedResources: resourceList.optional() }).optional() })
const listMetadata = z.object({ continue: z.literal('').optional(), resourceVersion: z.string().optional() }).optional()
const nodesSchema = z.object({ apiVersion: z.literal('v1'), kind: z.enum(['List', 'NodeList']), metadata: listMetadata,
  items: z.array(z.object({ metadata: z.object({ name, labels: z.record(z.string(), z.string()).optional() }),
    status: z.object({ allocatable: resourceList }) })).min(1).max(1000) })
const podsSchema = z.object({ apiVersion: z.literal('v1'), kind: z.enum(['List', 'PodList']), metadata: listMetadata, items: z.array(pod).max(20000) })
type Pod = z.infer<typeof pod>
type Budget = { cpu: bigint; memory: bigint; pods: bigint }
const empty = (): Budget => ({ cpu: 0n, memory: 0n, pods: 0n })
const add = (a: Budget, b: Budget): Budget => ({ cpu: a.cpu + b.cpu, memory: a.memory + b.memory, pods: a.pods + b.pods })
const maximum = (a: Budget, b: Budget): Budget => ({ cpu: a.cpu > b.cpu ? a.cpu : b.cpu, memory: a.memory > b.memory ? a.memory : b.memory, pods: 0n })
const publicBudget = (b: Budget) => ({ cpuMillis: b.cpu.toString(), memoryBytes: b.memory.toString(), pods: b.pods.toString() })

/** Exact decimal/binary arithmetic; round up only after each final pod/node quantity.
 * Kubernetes Quantity is at most nano precision. Use nanounits internally so
 * adding fractional quantities does not overcount each individual container.
 */
function nano(value: string | number): bigint {
  const text = String(value), match = /^\+?(\d+(?:\.\d*)?|\.\d+)([eE][+-]?\d+|[numkKMGTPE]|[KMGTPE]i)?$/u.exec(text)
  if (!match || text.length > 128) throw new KubernetesCapacityInputError()
  const [whole, fraction = ''] = match[1]!.split('.'), suffix = match[2] ?? ''
  let numerator = BigInt((whole || '0') + fraction), denominator = 10n ** BigInt(fraction.length)
  if (suffix.endsWith('i')) numerator *= 1024n ** BigInt('KMGTPE'.indexOf(suffix[0]!) + 1)
  else {
    const powers: Record<string, number> = { '': 0, n: -9, u: -6, m: -3, k: 3, K: 3, M: 6, G: 9, T: 12, P: 15, E: 18 }
    const power = /^[eE][+-]?\d+$/u.test(suffix) ? Number(suffix.slice(1)) : powers[suffix]
    if (power === undefined || !Number.isSafeInteger(power) || Math.abs(power) > 30) throw new KubernetesCapacityInputError()
    if (power >= 0) numerator *= 10n ** BigInt(power); else denominator *= 10n ** BigInt(-power)
  }
  return (numerator * 1_000_000_000n + denominator - 1n) / denominator
}
const ceil = (value: bigint, scale: bigint) => (value + scale - 1n) / scale
function vector(list: z.infer<typeof resourceList> | undefined): Budget {
  return { cpu: nano(list?.cpu ?? '0'), memory: nano(list?.memory ?? '0'), pods: 0n }
}
function request(r: z.infer<typeof resources> | undefined): Budget {
  // Planned manifests have not passed admission, which defaults a missing
  // request to its limit. API snapshots normally already contain that default.
  return vector({ cpu: r?.requests?.cpu ?? r?.limits?.cpu ?? '0', memory: r?.requests?.memory ?? r?.limits?.memory ?? '0' })
}
function podRequest(p: Pod): Budget {
  const names = [...p.spec.containers, ...(p.spec.initContainers ?? [])].map(c => c.name)
  const statusNames = [...(p.status?.containerStatuses ?? []), ...(p.status?.initContainerStatuses ?? [])].map(c => c.name)
  if (new Set(names).size !== names.length || new Set(statusNames).size !== statusNames.length) throw new KubernetesCapacityInputError()
  const infeasible = p.status?.conditions?.some(c => c.type === 'PodResizePending' && c.reason === 'Infeasible') ?? false
  const effective = (c: z.infer<typeof container>, useStatus: boolean) => {
    const status = [...(p.status?.containerStatuses ?? []), ...(p.status?.initContainerStatuses ?? [])].find(s => s.name === c.name)
    if (!useStatus || !status?.resources) return request(c.resources)
    const reserved = maximum(vector(status.resources.requests), vector(status.allocatedResources))
    return infeasible ? reserved : maximum(request(c.resources), reserved)
  }
  let total = p.spec.containers.reduce((sum, c) => add(sum, effective(c, true)), empty())
  let sidecars = empty(), initPeak = empty()
  for (const c of p.spec.initContainers ?? []) {
    const restartable = c.restartPolicy === 'Always', current = effective(c, restartable)
    if (restartable) { total = add(total, current); sidecars = add(sidecars, current) }
    initPeak = maximum(initPeak, restartable ? sidecars : add(sidecars, current))
  }
  total = maximum(total, initPeak)
  const podDeclared = { cpu: p.spec.resources?.requests?.cpu ?? p.spec.resources?.limits?.cpu,
    memory: p.spec.resources?.requests?.memory ?? p.spec.resources?.limits?.memory }
  for (const key of ['cpu', 'memory'] as const) if (podDeclared[key] !== undefined) {
    // Pod-level resource feature semantics must match the operator's cluster.
    let value = nano(podDeclared[key]!)
    if (p.status?.resources) {
      const reserved = maximum(vector(p.status.resources.requests), vector(p.status.allocatedResources))
      value = infeasible ? reserved[key] : maximum(vector({ cpu: podDeclared.cpu ?? '0', memory: podDeclared.memory ?? '0' }), reserved)[key]
    }
    total[key] = value
  }
  total = add(total, vector(p.spec.overhead))
  return { cpu: ceil(total.cpu, 1_000_000n), memory: ceil(total.memory, 1_000_000_000n), pods: 1n }
}
const nonPodKinds = new Set(['Service', 'ServiceAccount', 'ConfigMap', 'Secret', 'NetworkPolicy', 'PersistentVolumeClaim', 'Namespace'])
function workloadPods(yaml: string): { pod: Pod; replicas: number }[] {
  if (typeof yaml !== 'string' || Buffer.byteLength(yaml) > 8_000_000) throw new KubernetesCapacityInputError()
  const documents = parseAllDocuments(yaml, { uniqueKeys: true })
  if (!documents.length || documents.length > 256 || documents.some(d => d.errors.length)) throw new KubernetesCapacityInputError()
  const result: { pod: Pod; replicas: number }[] = []
  const objects: unknown[] = documents.filter(d => d.contents !== null).map(d => d.toJS({ maxAliasCount: 32 }))
  for (let i = 0; i < objects.length; i++) {
    if (objects.length > 256) throw new KubernetesCapacityInputError()
    const object = z.object({ apiVersion: z.string(), kind: z.string() }).parse(objects[i])
    if (object.kind === 'List' && object.apiVersion === 'v1') {
      objects.push(...z.object({ items: z.array(z.unknown()).max(256) }).parse(objects[i]).items); continue
    }
    if (nonPodKinds.has(object.kind)) continue
    if (object.kind === 'Pod' && object.apiVersion === 'v1') { result.push({ pod: pod.parse(objects[i]), replicas: 1 }); continue }
    if (!['Deployment', 'StatefulSet', 'Job'].includes(object.kind)
      || object.apiVersion !== (object.kind === 'Job' ? 'batch/v1' : 'apps/v1')) throw new KubernetesCapacityInputError()
    const controller = z.object({ metadata, spec: z.object({ replicas: z.number().int().min(0).max(128).optional(),
      parallelism: z.number().int().min(0).max(128).optional(), completions: z.number().int().min(1).max(128).optional(),
      suspend: z.boolean().optional(), template: z.object({ spec: podSpec }) }) }).parse(objects[i])
    const replicas = object.kind === 'Job' ? controller.spec.suspend ? 0 : Math.min(controller.spec.parallelism ?? 1, controller.spec.completions ?? 128) : controller.spec.replicas ?? 1
    result.push({ pod: { metadata: controller.metadata, spec: controller.spec.template.spec }, replicas })
  }
  if (!result.length || result.reduce((n, p) => n + p.replicas, 0) > 1024) throw new KubernetesCapacityInputError()
  return result
}

/** Pure request-budget diagnostic on explicit snapshots, not scheduler simulation,
 * admission, reservation, topology/security verification, runtime launch or cleanup.
 * Sidecar/init/overhead and resize accounting follow Kubernetes v1.35 helpers.
 */
export function inspectKubernetesCapacity(input: { nodes: unknown; pods: unknown; workloadYaml: string }) {
  try {
    const nodes = nodesSchema.parse(input.nodes), pods = podsSchema.parse(input.pods), workloads = workloadPods(input.workloadYaml)
    if (new Set(nodes.items.map(n => n.metadata.name)).size !== nodes.items.length) throw new KubernetesCapacityInputError()
    const identities = pods.items.map(p => `${p.metadata.namespace ?? 'default'}/${p.metadata.name}`)
    if (new Set(identities).size !== identities.length) throw new KubernetesCapacityInputError()
    const budgets = nodes.items.map(n => {
      if (n.status.allocatable.cpu === undefined || n.status.allocatable.memory === undefined || n.status.allocatable.pods === undefined) throw new KubernetesCapacityInputError()
      const q = vector(n.status.allocatable)
      const allocatable = { cpu: ceil(q.cpu, 1_000_000n), memory: ceil(q.memory, 1_000_000_000n), pods: ceil(nano(n.status.allocatable.pods), 1_000_000_000n) }
      return { name: n.metadata.name, labels: n.metadata.labels ?? {}, allocatable, requested: empty() }
    })
    let pending = 0
    for (const p of pods.items) {
      if (['Succeeded', 'Failed'].includes(p.status?.phase ?? '')) continue
      if (!p.spec.nodeName) { pending++; continue }
      const node = budgets.find(n => n.name === p.spec.nodeName)
      if (!node) throw new KubernetesCapacityInputError()
      node.requested = add(node.requested, podRequest(p))
    }
    const available = budgets.map(n => ({ ...n, available: { cpu: n.allocatable.cpu - n.requested.cpu,
      memory: n.allocatable.memory - n.requested.memory, pods: n.allocatable.pods - n.requested.pods } }))
    const shortages: { workload: string; code: string; message: string }[] = []
    let demand = empty()
    const requestedWorkloads = workloads.map(w => {
      // A copied Pod's observed status is not the request for an additional new
      // pod. In-place resize state applies only to already bound snapshot pods.
      const amount = podRequest({ metadata: w.pod.metadata, spec: w.pod.spec }), workload = `${w.pod.metadata.namespace ?? 'default'}/${w.pod.metadata.name}`
      demand = add(demand, { cpu: amount.cpu * BigInt(w.replicas), memory: amount.memory * BigInt(w.replicas), pods: BigInt(w.replicas) })
      const eligible = available.filter(n => (!w.pod.spec.nodeName || w.pod.spec.nodeName === n.name)
        && Object.entries(w.pod.spec.nodeSelector ?? {}).every(([key, value]) => n.labels[key] === value))
      if (w.replicas && !eligible.length) shortages.push({ workload, code: 'no-matching-node', message: 'No node in this snapshot matches the explicit node name/selector.' })
      else if (w.replicas && !eligible.some(n => amount.cpu <= n.available.cpu && amount.memory <= n.available.memory && n.available.pods >= 1n))
        shortages.push({ workload, code: 'request-does-not-fit', message: 'One additional pod does not fit any matching node’s remaining CPU, memory and pod-count request budget.' })
      return { workload, replicas: w.replicas, perPod: publicBudget(amount), candidateNodes: eligible.map(n => n.name) }
    })
    const total = available.reduce((sum, n) => add(sum, { cpu: n.available.cpu > 0n ? n.available.cpu : 0n,
      memory: n.available.memory > 0n ? n.available.memory : 0n, pods: n.available.pods > 0n ? n.available.pods : 0n }), empty())
    if (demand.cpu > total.cpu || demand.memory > total.memory || demand.pods > total.pods)
      shortages.push({ workload: 'all-new-workloads', code: 'aggregate-request-shortage', message: 'The additional batch exceeds total available CPU, memory or pod-count requests, even before node-selection and placement constraints.' })
    return { schemaVersion: 1, kind: 'JevableKubernetesCapacity', status: shortages.length ? 'insufficient-capacity' as const : 'no-obvious-request-shortage' as const,
      execution: 'not-run' as const, clusterMutation: false, capacityReserved: false,
      assessment: 'additional-pods-not-replacement-credit' as const, accounting: 'kubernetes-v1.35-cpu-memory-pod-requests' as const,
      workloads: requestedWorkloads, demand: publicBudget(demand),
      nodes: available.map(n => ({ name: n.name, allocatable: publicBudget(n.allocatable), requested: publicBudget(n.requested), available: publicBudget(n.available) })),
      pendingPodsNotReserved: pending, shortages,
      limitations: ['Snapshots must be complete, current and from the same explicitly selected cluster; this function cannot authenticate their provenance.',
        'No atomic snapshot, reservation, automatic replacement credit, scheduling or deletion. Existing bound and terminating pods keep their request budget.',
        'Does not simulate packing, taints, affinity, topology, quota, storage, pod priority, admission mutations, image access, security, networking or extended-resource scheduling.',
        'Pod-level and in-place resize resource fields assume matching Kubernetes v1.35 feature semantics. Other scheduler/version configurations need separate verification.',
        'Pending unbound pods and other concurrent actors may consume apparent headroom. No-obvious-shortage is not deployable or production-ready.'] }
  } catch { throw new KubernetesCapacityInputError() }
}

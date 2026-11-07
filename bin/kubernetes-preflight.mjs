#!/usr/bin/env node
// Offline operator helper. Works beside both the npm CLI and extracted skill CLI.
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify, parseArgs, isDeepStrictEqual } from 'node:util'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const execute = promisify(execFile)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const invalid = () => { throw new Error('Invalid preflight input; details withheld.') }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const name = value => typeof value === 'string' && /^[a-z0-9][a-z0-9.-]{0,252}$/u.test(value)
const version = value => typeof value === 'string' && value.length <= 128
  && /^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)*$/u.test(value)
const usage = `Offline Kubernetes preflight (no cluster access or mutation)
node bin/kubernetes-preflight.mjs --workload-file workload.yaml --nodes-file nodes.json --pods-file pods.json --version-file version.json --platform linux/arm64
All four snapshots must come from your explicitly reviewed context. Platform is the reviewed workflow image platform, not a detected host platform.
Exit 0: snapshot checks found no blocker, live acceptance still required. Exit 1: observed blocker. Exit 2: invalid input or checker failure.
`

/** Inspect only allowlisted node metadata. Capacity remains the existing core calculation. */
export function inspectSnapshotHealth({ nodes, serverVersion, platform, capacity }) {
  if (!['linux/arm64', 'linux/amd64'].includes(platform)
    || !object(serverVersion) || !object(serverVersion.serverVersion) || !version(serverVersion.serverVersion.gitVersion)
    || !object(nodes) || nodes.apiVersion !== 'v1' || !['NodeList', 'List'].includes(nodes.kind)
    || !Array.isArray(nodes.items) || !nodes.items.length || nodes.items.length > 1000
    || nodes.metadata?.continue && nodes.metadata.continue !== '') invalid()
  if (!object(capacity) || capacity.schemaVersion !== 1 || capacity.kind !== 'JevableKubernetesCapacity'
    || !['insufficient-capacity', 'no-obvious-request-shortage'].includes(capacity.status)
    || !Array.isArray(capacity.nodes) || !Array.isArray(capacity.workloads) || !Array.isArray(capacity.shortages)) invalid()
  const [os, arch] = platform.split('/')
  const observedNodes = nodes.items.map(node => {
    if (!object(node) || !object(node.metadata) || !name(node.metadata.name)
      || !object(node.status) || !object(node.status.nodeInfo) || !Array.isArray(node.status.conditions)
      || !object(node.metadata.labels) || node.spec !== undefined && !object(node.spec)
      || node.spec?.unschedulable !== undefined && typeof node.spec.unschedulable !== 'boolean') invalid()
    const info = node.status.nodeInfo, labels = node.metadata.labels
    if (!version(info.kubeletVersion) || typeof info.containerRuntimeVersion !== 'string'
      || !/^[a-z][a-z0-9-]{0,31}:\/\/[A-Za-z0-9.+_-]{1,100}$/u.test(info.containerRuntimeVersion)
      || typeof info.operatingSystem !== 'string' || typeof info.architecture !== 'string'
      || labels['kubernetes.io/os'] !== info.operatingSystem || labels['kubernetes.io/arch'] !== info.architecture) invalid()
    const ready = node.status.conditions.filter(c => object(c) && c.type === 'Ready')
    if (ready.length !== 1 || !['True', 'False', 'Unknown'].includes(ready[0].status)) invalid()
    return { name: node.metadata.name, ready: ready[0].status, cordoned: node.spec?.unschedulable === true,
      platformMatches: info.operatingSystem === os && info.architecture === arch,
      kubeletVersion: info.kubeletVersion, containerRuntime: info.containerRuntimeVersion }
  })
  const identities = observedNodes.map(n => n.name)
  if (new Set(identities).size !== identities.length
    || !isDeepStrictEqual([...identities].sort(), capacity.nodes.map(n => n.name).sort())) invalid()
  const blockers = capacity.shortages.map(s => ({ workload: s.workload, code: s.code }))
  const readyBudgets = capacity.nodes.filter(b => observedNodes.some(n => n.name === b.name
    && n.ready === 'True' && !n.cordoned && n.platformMatches))
  const availableOnReadyNodes = Object.fromEntries(['cpuMillis', 'memoryBytes', 'pods'].map(key => [key,
    readyBudgets.reduce((sum, n) => sum + (BigInt(n.available[key]) > 0n ? BigInt(n.available[key]) : 0n), 0n).toString()]))
  if (['cpuMillis', 'memoryBytes', 'pods'].some(key => BigInt(capacity.demand[key]) > BigInt(availableOnReadyNodes[key]))) {
    blockers.push({ workload: 'all-new-workloads', code: 'aggregate-request-shortage-on-ready-nodes' })
  }
  for (const w of capacity.workloads) {
    if (!Array.isArray(w.candidateNodes) || w.candidateNodes.some(n => !identities.includes(n))) invalid()
    if (w.replicas === 0) continue
    const candidates = observedNodes.filter(n => w.candidateNodes.includes(n.name)
      && n.ready === 'True' && !n.cordoned && n.platformMatches)
    if (!candidates.length) {
      blockers.push({ workload: w.workload, code: 'no-ready-uncordoned-platform-matching-node' }); continue
    }
    const fits = candidates.some(n => {
      const budget = capacity.nodes.find(b => b.name === n.name).available
      return BigInt(budget.cpuMillis) >= BigInt(w.perPod.cpuMillis)
        && BigInt(budget.memoryBytes) >= BigInt(w.perPod.memoryBytes) && BigInt(budget.pods) >= 1n
    })
    if (!fits) blockers.push({ workload: w.workload, code: 'request-does-not-fit-ready-node' })
  }
  const versions = [serverVersion.serverVersion.gitVersion, ...observedNodes.map(n => n.kubeletVersion)]
  return { schemaVersion: 1, kind: 'JevableKubernetesPreflight',
    status: blockers.length ? 'blocked-by-snapshot' : 'snapshot-checks-pass-live-review-required',
    execution: 'not-run', clusterAccess: false, clusterMutation: false, deploymentQualified: false,
    serverVersion: serverVersion.serverVersion.gitVersion, platform,
    distributionHint: /(?:[-+])k3s\d+(?:$|[.-])/u.test(serverVersion.serverVersion.gitVersion) ? 'k3s-version-string' : 'not-inferred',
    capacitySemanticsMatch: versions.every(v => /^v1\.35\./u.test(v)), nodes: observedNodes,
    availableOnReadyNodes, blockers, capacity,
    requiredLiveChecks: ['Verify exact image digest, platform and availability on every eligible node.',
      'Confirm effective NetworkPolicy with both allowed and denied traffic; a policy object or CNI name is not proof.',
      'Verify TLS/hostname, authentication, database ownership, release/runtime identity and private configuration.',
      'Review taints, affinity, quotas, storage, admission and version-specific scheduling semantics.',
      'Run an authorized synthetic workflow and approval, then normal replacement without replay.',
      'Join retained run/attempt/pod identities to received OpenTelemetry traces, logs and metrics.'],
    limitations: ['Untrusted non-atomic snapshots; provenance, freshness and cluster identity are not authenticated.',
      'Per-pod fit is not bin packing, a reservation, deployment authority or production acceptance.',
      'Capacity uses Kubernetes v1.35 resource semantics; a different version needs explicit review.',
      'K3s can disable its embedded network-policy controller; version and pod discovery cannot establish enforcement.'] }
}

async function readSnapshot(path, limit) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW | constants.O_NOCTTY)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > limit) invalid()
    const bytes = Buffer.alloc(limit + 1)
    let offset = 0
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, null)
      if (!result.bytesRead) break
      offset += result.bytesRead
    }
    if (offset > limit) invalid()
    return bytes.subarray(0, offset)
  } finally { await file.close() }
}

export async function main(argv, io = { out: text => process.stdout.write(text), err: text => process.stderr.write(text) }) {
  try {
    const { values, positionals } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
      'workload-file': { type: 'string' }, 'nodes-file': { type: 'string' }, 'pods-file': { type: 'string' },
      'version-file': { type: 'string' }, platform: { type: 'string' }, help: { type: 'boolean' },
    } })
    if (values.help) {
      if (argv.length !== 1) invalid()
      io.out(usage); return 0
    }
    if (positionals.length || !['linux/arm64', 'linux/amd64'].includes(values.platform)
      || ['workload-file', 'nodes-file', 'pods-file', 'version-file'].some(key => !values[key])
      || argv.filter(a => a.startsWith('--')).length !== 5
      || new Set(argv.filter(a => a.startsWith('--')).map(a => a.split('=')[0])).size !== 5) invalid()
    const kinds = ['workload', 'nodes', 'pods', 'version']
    const paths = kinds.map(kind => resolve(values[kind + '-file']))
    const bytes = await Promise.all(paths.map((path, i) => readSnapshot(path, i === 3 ? 64_000 : 8_000_000)))
    const decode = b => new TextDecoder('utf-8', { fatal: true }).decode(b)
    const nodes = JSON.parse(decode(bytes[1])), serverVersion = JSON.parse(decode(bytes[3]))
    const pins = bytes.map((b, i) => ({ kind: kinds[i], bytes: b.length, sha256: hash(b) }))
    const cli = fileURLToPath(new URL('./jevable.mjs', import.meta.url))
    // Never shell out to kubectl, use exec plugins or inherit Node preload hooks.
    const { NODE_OPTIONS: _options, NODE_PATH: _path, ...env } = process.env
    let result
    try { result = await execute(process.execPath, [cli, 'kubernetes', 'capacity', paths[0],
      '--nodes-file', paths[1], '--pods-file', paths[2]], { env, timeout: 30_000, maxBuffer: 8_000_000 }) }
    catch (error) {
      if (error.code !== 1 || error.signal || error.killed) invalid()
      result = { stdout: error.stdout }
    }
    const capacity = JSON.parse(result.stdout)
    if (!isDeepStrictEqual(capacity.inputs, pins.slice(0, 3))) invalid()
    const after = await Promise.all(paths.map((path, i) => readSnapshot(path, i === 3 ? 64_000 : 8_000_000)))
    if (!after.every((b, i) => b.equals(bytes[i]))) invalid()
    const report = inspectSnapshotHealth({ nodes, serverVersion, platform: values.platform, capacity })
    io.out(JSON.stringify({ ...report, inputs: pins }, null, 2) + '\n')
    return report.blockers.length ? 1 : 0
  } catch {
    io.err('Preflight requires explicit bounded regular snapshots, a reviewed platform and a matching local CLI. Input/error details are withheld. Use --help.\n')
    return 2
  }
}

// Node canonicalizes module URLs (including macOS /var -> /private/var), not argv.
const entry = process.argv[1] ? await realpath(process.argv[1]).catch(() => undefined) : undefined
if (entry === await realpath(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2))

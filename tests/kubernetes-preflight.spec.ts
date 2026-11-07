import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, symlink, readFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { unzipSync } from 'fflate'
import { stringify } from 'yaml'
// Public helper intentionally needs only Node builtins plus the adjacent CLI.
// @ts-expect-error JavaScript operator helper has no SDK declaration contract.
import { inspectSnapshotHealth, main } from '../bin/kubernetes-preflight.mjs'
import { inspectKubernetesCapacity } from '../src/deployment/capacity.ts'
import { inspectAgentSkillZip } from '../src/management/skill-inspection.ts'
// @ts-expect-error Developer-only checker has no SDK declaration contract.
import { checkDocumentationPackage } from '../scripts/check-documentation-package.mjs'

const node = (name = 'node-a', ready = 'True', cordoned = false) => ({ metadata: { name,
  labels: { 'kubernetes.io/os': 'linux', 'kubernetes.io/arch': 'arm64', private: 'PRIVATE_SENTINEL' } },
  spec: { unschedulable: cordoned }, status: { allocatable: { cpu: '2', memory: '1Gi', pods: '10' },
    conditions: [{ type: 'Ready', status: ready, message: 'PRIVATE_SENTINEL' }],
    nodeInfo: { operatingSystem: 'linux', architecture: 'arm64', kubeletVersion: 'v1.35.4+k3s1',
      containerRuntimeVersion: 'containerd://2.1.5-k3s1' } } })
const nodes = (items = [node()]) => ({ apiVersion: 'v1', kind: 'NodeList', items })
const pods = { apiVersion: 'v1', kind: 'PodList', items: [] }
const workload = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'workflow', namespace: 'test' }, spec: {
  nodeSelector: { 'kubernetes.io/os': 'linux', 'kubernetes.io/arch': 'arm64' },
  containers: [{ name: 'workflow', resources: { requests: { cpu: '250m', memory: '256Mi' } }, env: [{ name: 'PRIVATE', value: 'PRIVATE_SENTINEL' }] }] } }
const serverVersion = { serverVersion: { gitVersion: 'v1.35.4+k3s1' }, clientVersion: { private: 'PRIVATE_SENTINEL' } }
const inspect = (cluster: any = nodes(), w: any = workload, platform = 'linux/arm64', v: any = serverVersion) => {
  const capacity = inspectKubernetesCapacity({ nodes: cluster, pods, workloadYaml: stringify(w) })
  return inspectSnapshotHealth({ nodes: cluster, serverVersion: v, platform, capacity })
}

describe('offline Kubernetes preflight, not deployment qualification', () => {
  it('joins real core capacity to allowlisted node health, without mutation or credential disclosure', () => {
    const input = nodes(), before = structuredClone(input), r = inspect(input)
    expect(r).toMatchObject({ status: 'snapshot-checks-pass-live-review-required', distributionHint: 'k3s-version-string',
      execution: 'not-run', clusterAccess: false, clusterMutation: false, deploymentQualified: false, capacitySemanticsMatch: true })
    expect(r.requiredLiveChecks).toHaveLength(6)
    expect(JSON.stringify(r)).not.toContain('PRIVATE_SENTINEL'); expect(input).toEqual(before)
  })
  it.each([['False', false], ['Unknown', false], ['True', true]])('blocks readiness %s / cordoning %s despite spare capacity', (ready, cordoned) => {
    const r = inspect(nodes([node('node-a', ready as string, cordoned as boolean)]))
    expect(r.status).toBe('blocked-by-snapshot'); expect(r.capacity.status).toBe('no-obvious-request-shortage')
    expect(r.blockers.map((b: any) => b.code)).toContain('no-ready-uncordoned-platform-matching-node')
  })
  it('does not borrow the budget of an unready candidate', () => {
    const a = node('node-a'); a.status.allocatable.memory = '128Mi'
    const r = inspect(nodes([a, node('node-b', 'False')]))
    expect(r.capacity.status).toBe('no-obvious-request-shortage')
    expect(r.blockers.map((b: any) => b.code)).toContain('request-does-not-fit-ready-node')
  })
  it('does not infer the image platform from the host or node', () => {
    expect(inspect(nodes(), workload, 'linux/amd64').status).toBe('blocked-by-snapshot')
    expect(() => inspect(nodes(), workload, 'darwin/arm64')).toThrow()
  })
  it('does not borrow unready aggregate capacity for a batch whose individual pods fit', () => {
    const a = node('node-a'); a.status.allocatable.memory = '512Mi'
    const w = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: workload.metadata,
      spec: { replicas: 3, template: { spec: workload.spec } } }
    const r = inspect(nodes([a, node('node-b', 'False')]), w)
    expect(r.capacity.status).toBe('no-obvious-request-shortage')
    expect(r.availableOnReadyNodes.memoryBytes).toBe(String(512 * 1024 * 1024))
    expect(r.blockers.map((b: any) => b.code)).toContain('aggregate-request-shortage-on-ready-nodes')
  })
  it('preserves original capacity shortages', () => {
    const a = node(); a.status.allocatable.memory = '128Mi'
    expect(inspect(nodes([a])).blockers.map((b: any) => b.code)).toContain('request-does-not-fit')
  })
  it('flags non-v1.35 semantics for review rather than claiming newer cluster qualification', () => {
    const a = node(); a.status.nodeInfo.kubeletVersion = 'v1.34.8+k3s1'
    expect(inspect(nodes([a])).capacitySemanticsMatch).toBe(false)
    expect(inspect(nodes(), workload, 'linux/arm64', { serverVersion: { gitVersion: 'v1.36.0' } }).distributionHint).toBe('not-inferred')
  })
  it.each(['ready', 'labels', 'continued', 'duplicate', 'version', 'missing-info'])('refuses ambiguous/incomplete %s snapshots', kind => {
    const a: any = node(), n: any = nodes([a])
    if (kind === 'ready') a.status.conditions.push({ type: 'Ready', status: 'False' })
    if (kind === 'labels') a.metadata.labels['kubernetes.io/arch'] = 'amd64'
    if (kind === 'continued') n.metadata = { continue: 'PRIVATE_SENTINEL' }
    if (kind === 'duplicate') n.items.push(a)
    if (kind === 'version') a.status.nodeInfo.kubeletVersion = 'PRIVATE_SENTINEL'
    if (kind === 'missing-info') delete a.status.nodeInfo
    expect(() => inspect(n)).toThrow()
  })
  it('ignores suspended/zero-replica workload health demand', () => {
    const w = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: workload.metadata,
      spec: { replicas: 0, template: { spec: workload.spec } } }
    expect(inspect(nodes([node('node-a', 'False')]), w).blockers).toEqual([])
  })
})

describe('public snapshot helper CLI', () => {
  it('handles help without reading inputs and refuses implicit/duplicate options', async () => {
    const out: string[] = [], err: string[] = [], io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }
    expect(await main(['--help'], io)).toBe(0)
    expect(out.join('')).toContain('no cluster access')
    for (const argv of [[], ['--help', '--platform', 'linux/arm64'], ['--kubeconfig', 'PRIVATE_SENTINEL'],
      ['--nodes-file', 'x', '--nodes-file', 'y', '--pods-file', 'x', '--workload-file', 'x', '--version-file', 'x', '--platform', 'linux/arm64']]) {
      expect(await main(argv, io)).toBe(2)
    }
    expect(err.join('')).not.toContain('PRIVATE_SENTINEL')
  })
  it('runs the real adjacent compiled CLI and pins all four exact snapshot bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jevable-preflight-'))
    const contents = [stringify(workload), JSON.stringify(nodes()), JSON.stringify(pods), JSON.stringify(serverVersion)]
    const kinds = ['workload', 'nodes', 'pods', 'version'], paths = kinds.map(k => join(dir, k))
    await Promise.all(paths.map((p, i) => writeFile(p, contents[i]!, { mode: 0o600 })))
    const args = kinds.flatMap((k, i) => ['--' + k + '-file', paths[i]!]).concat(['--platform', 'linux/arm64'])
    const out: string[] = [], err: string[] = [], io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }
    expect(await main(args, io)).toBe(0); expect(err).toEqual([])
    const r = JSON.parse(out.pop()!); expect(r.inputs.map((i: any) => i.kind)).toEqual(kinds)
    expect(r.inputs.map((i: any) => i.bytes)).toEqual(contents.map(c => Buffer.byteLength(c)))
    expect(JSON.stringify(r)).not.toContain('PRIVATE_SENTINEL')
    const unready = nodes([node('node-a', 'False')]); await writeFile(paths[1]!, JSON.stringify(unready))
    expect(await main(args, io)).toBe(1); expect(JSON.parse(out.pop()!).status).toBe('blocked-by-snapshot')
    const small = node(); small.status.allocatable.memory = '64Mi'; await writeFile(paths[1]!, JSON.stringify(nodes([small])))
    expect(await main(args, io)).toBe(1); expect(JSON.parse(out.pop()!).capacity.status).toBe('insufficient-capacity')
    const before = await readFile(paths[1]!)
    await writeFile(paths[3]!, '{PRIVATE_SENTINEL')
    expect(await main(args, io)).toBe(2); expect(err.join('')).not.toContain('PRIVATE_SENTINEL')
    expect(await readFile(paths[1]!)).toEqual(before)
  })
  it('refuses a final symlink instead of reading a selected credential target', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jevable-preflight-link-')), target = join(dir, 'private'), link = join(dir, 'link')
    await writeFile(target, 'PRIVATE_SENTINEL', { mode: 0o600 }); await symlink(target, link)
    const err: string[] = []
    expect(await main(['--workload-file', link, '--nodes-file', link, '--pods-file', link, '--version-file', link,
      '--platform', 'linux/arm64'], { out: () => { throw Error('unexpected output') }, err: (s: string) => err.push(s) })).toBe(2)
    expect(err.join('')).not.toContain('PRIVATE_SENTINEL'); expect(await readFile(target, 'utf8')).toBe('PRIVATE_SENTINEL')
  })
  it('ships and runs from an independent Node-only extracted skill, with no npm/source/Docker lookup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jevable-preflight-skill-'))
    // The compiled SDK resolves owned runtime programs beside dist, unlike the source module.
    const { createAgentSkillZip } = await import('../dist/management/skill-package.js')
    const archive = await createAgentSkillZip()
    const inspection = await inspectAgentSkillZip(archive.bytes)
    expect(inspection.status).toBe('consistent')
    const files = unzipSync(archive.bytes)
    expect(files['jevable/bin/kubernetes-preflight.mjs']).toBeDefined()
    for (const [name, bytes] of Object.entries(files)) {
      expect(name.startsWith('jevable/') && !name.split('/').includes('..')).toBe(true)
      const path = join(dir, name)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, bytes, { mode: 0o600 })
    }
    // Its private-artifact exclusions apply to an extracted package, not a development checkout.
    const documentation = await checkDocumentationPackage(join(dir, 'jevable'))
    expect(documentation.status).toBe('passed')
    const kinds = ['workload', 'nodes', 'pods', 'version']
    const contents = [stringify(workload), JSON.stringify(nodes()), JSON.stringify(pods), JSON.stringify(serverVersion)]
    const paths = kinds.map(k => join(dir, k))
    await Promise.all(paths.map((p, i) => writeFile(p, contents[i]!, { mode: 0o600 })))
    const helper = join(dir, 'jevable/bin/kubernetes-preflight.mjs')
    const args = kinds.flatMap((k, i) => ['--' + k + '-file', paths[i]!]).concat(['--platform', 'linux/arm64'])
    const { NODE_OPTIONS: _options, NODE_PATH: _path, ...env } = process.env
    const result = await promisify(execFile)(process.execPath, [helper, ...args], {
      cwd: dir, env: { ...env, PATH: '', NODE_PATH: '' }, timeout: 30_000, maxBuffer: 1_000_000,
    })
    expect(result.stderr).toBe('')
    const report = JSON.parse(result.stdout)
    expect(report.status).toBe('snapshot-checks-pass-live-review-required')
    expect(report.capacity.status).toBe('no-obvious-request-shortage')
    expect(report.inputs.map((i: any) => i.kind)).toEqual(kinds)
    expect(result.stdout).not.toContain('PRIVATE_SENTINEL')
    await writeFile(join(dir, 'skill.zip'), archive.bytes, { mode: 0o600 })
    const inspectionResult = await promisify(execFile)(process.execPath,
      [join(dir, 'jevable/bin/jevable.mjs'), 'skill', 'inspect', join(dir, 'skill.zip')], {
        cwd: dir, env: { ...env, PATH: '', NODE_PATH: '' }, timeout: 30_000, maxBuffer: 1_000_000,
      })
    expect(JSON.parse(inspectionResult.stdout).status).toBe('consistent')
  }, 30_000)
})

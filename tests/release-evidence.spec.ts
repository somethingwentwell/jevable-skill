import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { unzipSync } from 'fflate'
import { LocalRuntime } from '../src/runtime/local.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { createEvidenceZip } from '../src/evidence/index.ts'
import { createReleaseZip, createReleaseZipWithEvidence } from '../src/releases/index.ts'
import { main } from '../src/cli.ts'

const source = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8')
const owners: LocalRuntime[] = []
afterEach(async () => { for (const owner of owners.splice(0)) await owner.close(); vi.restoreAllMocks() })
async function fixture(storage: 'sqlite' | 'postgres' = 'sqlite', privateData = false) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-release-evidence-')), owner = await LocalRuntime.open({ dataDirectory }); owners.push(owner)
  // Stub tests launcher integrity only; the independent-package verifier exercises real execution.
  const bytes = Buffer.from('export async function releaseMain(snapshot) { console.log(JSON.stringify({loaded:true,id:snapshot.id})); return 0; }')
  const artifact = { bytes, storage, notices: Buffer.from('Test-only runtime'), identity: { version: CORE_VERSION, sha256: digest(bytes) } }
  const project = owner.editProject({ operation: 'create', yaml: source, actor: 'test', title: 'Release attachment' })
  const release = owner.createRelease({ projectId: project.id, revision: project.acceptedRevision, expectedGeneration: 1, actor: 'test', version: '1.0.0', runtime: artifact.identity })
  const run = await owner.run(source, 'PRIVATE_INPUT')
  const evidence = await createEvidenceZip(owner, { schemaVersion: 1, runs: [{ id: run.id, revision: run.revision }] }, privateData)
  return { owner, artifact, release, evidence, run, dataDirectory }
}

describe('release ZIP review-only evidence', () => {
  it.each(['sqlite', 'postgres'] as const)('preserves exact %s release identity and default image inventory', async storage => {
    const f = await fixture(storage, true), original = createReleaseZip(f.release, f.artifact)
    const result = await createReleaseZipWithEvidence(f.release, f.artifact, { bytes: f.evidence.bytes, sha256: f.evidence.sha256, includePrivate: true })
    const files = unzipSync(result.bytes), manifest = JSON.parse(text(files['manifest.json']!)), baseline = unzipSync(original)
    expect(manifest).toMatchObject({ version: 2, releaseSha256: f.release.sha256, storage, tests: 'review-attachment-only', evidence: result.evidence })
    expect(result.evidence).toMatchObject({ relationship: 'workflow-revision-only', restoration: 'unsupported', declaredPrivacy: 'private-execution-data' })
    expect(text(files['release.json']!)).toBe(text(baseline['release.json']!)); expect(files['runtime.mjs']).toEqual(baseline['runtime.mjs'])
    expect(Buffer.from(files['evidence.zip']!)).toEqual(f.evidence.bytes)
    expect(Object.keys(files).length).toBe(13); expect(manifest.files.length).toBe(12)
    for (const entry of manifest.files) expect(entry).toMatchObject({ bytes: files[entry.path]!.length, sha256: digest(files[entry.path]!) })
    expect(text(files['Dockerfile']!)).toContain('.dockerignore evidence.zip ./')
    expect(text(files['.dockerignore']!)).toContain('!evidence.zip\n')
    expect(text(files['README.txt']!)).toContain('includes evidence.zip, including any private payloads')
    expect(text(files['README.txt']!)).not.toContain('No credentials or originating runtime state are exported.')
    expect(text(files['README.txt']!)).toContain('inline secrets and test data')
    expect(JSON.stringify(result.evidence)).not.toContain('PRIVATE_INPUT')
    expect(createReleaseZip(f.release, f.artifact)).toEqual(original)
    expect(baseline['evidence.zip']).toBeUndefined(); expect(JSON.parse(text(baseline['manifest.json']!)).version).toBe(1)
    expect(text(baseline['Dockerfile']!)).not.toContain('evidence.zip')
  })

  it('pins release, runtime, notices and evidence buffers before yielding', async () => {
    const f = await fixture('sqlite', true), saved = structuredClone(f.release), runtime = Buffer.from(f.artifact.bytes), evidence = Buffer.from(f.evidence.bytes)
    const input = { bytes: f.evidence.bytes, sha256: f.evidence.sha256, includePrivate: true }
    const pending = createReleaseZipWithEvidence(f.release, f.artifact, input)
    f.release.snapshot.version = 'mutated'; f.artifact.bytes.fill(0); f.artifact.notices.fill(0); input.bytes.fill(0); input.sha256 = '0'.repeat(64); input.includePrivate = false
    const files = unzipSync((await pending).bytes)
    expect(JSON.parse(text(files['release.json']!))).toEqual(saved); expect(Buffer.from(files['runtime.mjs']!)).toEqual(runtime)
    expect(text(files['NOTICES.txt']!)).toBe('Test-only runtime'); expect(Buffer.from(files['evidence.zip']!)).toEqual(evidence)
  })

  it.each(['consent', 'checksum', 'revision', 'corrupt'] as const)('rejects invalid %s before producing a ZIP', async mode => {
    const f = await fixture('sqlite', true)
    if (mode === 'revision') {
      const run = await f.owner.run(source.replace('Standalone echo', 'Another workflow'), 'input')
      f.evidence = await createEvidenceZip(f.owner, { schemaVersion: 1, runs: [{ id: run.id, revision: run.revision }] }, true)
    }
    if (mode === 'corrupt') { f.evidence.bytes.fill(0); f.evidence.sha256 = digest(f.evidence.bytes) }
    await expect(createReleaseZipWithEvidence(f.release, f.artifact, { bytes: f.evidence.bytes,
      sha256: mode === 'checksum' ? '0'.repeat(64) : f.evidence.sha256, includePrivate: mode !== 'consent' })).rejects.toThrow()
    expect(f.owner.releases()).toEqual([f.release])
  })

  it.each(['valid', 'missing', 'changed', 'descriptor', 'version', 'undeclared', 'runtime', 'duplicate',
    'path', 'privacy', 'selection', 'hash', 'runs', 'restoration', 'bytes'] as const)('launcher verifies %s attachment before importing runtime', async mode => {
    const f = await fixture(), packed = await createReleaseZipWithEvidence(f.release, f.artifact, { bytes: f.evidence.bytes, sha256: f.evidence.sha256 })
    const files = unzipSync(packed.bytes), manifest = JSON.parse(text(files['manifest.json']!))
    if (mode === 'missing') delete files['evidence.zip']
    if (mode === 'changed') files['evidence.zip']![0] = files['evidence.zip']![0]! ^ 1
    if (mode === 'runtime') files['runtime.mjs']![0] = files['runtime.mjs']![0]! ^ 1
    if (mode === 'descriptor') manifest.evidence.revision = '0'.repeat(64)
    if (mode === 'path') manifest.evidence.path = '../evidence.zip'
    if (mode === 'privacy') manifest.evidence.declaredPrivacy = 'public'
    if (mode === 'selection') manifest.evidence.selectionSha256 = 'invalid'
    if (mode === 'hash') manifest.evidence.sha256 = '0'.repeat(64)
    if (mode === 'runs') manifest.evidence.runs = 0
    if (mode === 'restoration') manifest.evidence.restoration = 'supported'
    if (mode === 'bytes') manifest.evidence.bytes = 0
    if (mode === 'version') manifest.version = 1
    if (mode === 'undeclared') manifest.files = manifest.files.filter((entry: any) => entry.path !== 'evidence.zip')
    if (mode === 'duplicate') manifest.files[0] = manifest.files[1]
    files['manifest.json'] = Buffer.from(JSON.stringify(manifest))
    const directory = await mkdtemp(join(tmpdir(), 'jevable-release-bootstrap-'))
    for (const [name, bytes] of Object.entries(files)) await writeFile(join(directory, name), bytes, { mode: 0o600 })
    const result = spawnSync(process.execPath, ['--no-global-search-paths', join(directory, 'app.mjs'), 'info'],
      { cwd: directory, env: { ...process.env, NODE_PATH: '', PATH: '/no-executable-fixture' }, encoding: 'utf8', timeout: 10000 })
    expect(result.status, result.stderr).toBe(mode === 'valid' ? 0 : 1)
    if (mode === 'valid') expect(JSON.parse(result.stdout)).toEqual({ loaded: true, id: f.release.snapshot.id })
    else { expect(result.stdout).toBe(''); expect(JSON.parse(result.stderr).code).toBe('release-integrity-or-startup') }
  })

  it.each([
    ['--evidence-file', 'absent.zip'], ['--evidence-sha256', '0'.repeat(64)], ['--include-private-evidence'],
    ['--evidence-file', 'absent.zip', '--evidence-sha256', 'bad-hash'],
  ].map(flags => ({ flags })))('rejects incomplete CLI attachment options before starting an owner: $flags', async ({ flags }) => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-release-cli-refusal-')), state = join(directory, 'state'), output = join(directory, 'release.zip')
    vi.spyOn(process.stderr, 'write').mockImplementation(acknowledgeCliWrite()); vi.spyOn(process.stdout, 'write').mockImplementation(acknowledgeCliWrite())
    expect(await main(['releases', 'export', 'not-opened', '--release-sha256', '0'.repeat(64), '--format', 'zip', '--output', output, '--data-dir', state, ...flags])).toBe(2)
    await expect(stat(state)).rejects.toMatchObject({ code: 'ENOENT' }); await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
import { acknowledgeCliWrite } from './helpers/cli-write.ts'

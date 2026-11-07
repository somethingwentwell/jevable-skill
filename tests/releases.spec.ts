import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { unzipSync } from 'fflate'
import { LocalRuntime } from '../src/runtime/local.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { inspectRelease, releaseRequirements } from '../src/releases/snapshot.ts'
import { createReleaseZip } from '../src/packages/release-zip.ts'
const source = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const bytes = Buffer.from('export const fixture = true;'), hash = createHash('sha256').update(bytes).digest('hex')
const artifact = { bytes, storage: 'sqlite' as const, notices: Buffer.from('Test runtime, not executable qualification'), identity: { version: CORE_VERSION, sha256: hash } }
async function fixture() {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-releases-')), runtime = await LocalRuntime.open({ dataDirectory })
  const project = runtime.editProject({ operation: 'create', title: 'Release project', yaml: source, actor: 'local:test' })
  const command = { projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision, version: '1.0.0', actor: 'local:test', runtime: artifact.identity }
  return { runtime, dataDirectory, project, command }
}
describe('immutable standalone releases', () => {
  it.each([1, 2, 10, 11])('preserves reviewed retry limits in release admission and configuration: %i', async maxAttempts => {
    const { runtime, command } = await fixture()
    try {
      const yaml = (await readFile(new URL('../examples/support.yaml', import.meta.url), 'utf8')).replace('maxAttempts: 1', `maxAttempts: ${maxAttempts}`)
      const project = runtime.editProject({ operation: 'create', title: 'Retried release', yaml, actor: 'local:test' })
      const create = () => runtime.createRelease({ ...command, projectId: project.id, revision: project.acceptedRevision })
      if (maxAttempts > 10) { expect(create).toThrow('invalid-command'); return }
      const release = create()
      expect(releaseRequirements(release.snapshot).models).toMatchObject([{ maxAttempts, timeoutSeconds: 60 }])
      const files = unzipSync(createReleaseZip(release, artifact))
      expect(JSON.parse(Buffer.from(files['configuration.json']!).toString()).models).toMatchObject([{ maxAttempts }])
    } finally { await runtime.close() }
  })

  it('pins accepted source and runtime identity across project edits and restart', async () => {
    const { runtime, dataDirectory, project, command } = await fixture()
    const release = runtime.createRelease(command)
    runtime.editProject({ operation: 'propose', id: project.id, expectedGeneration: 1, actor: 'local:test', yaml: source.replace('Standalone echo', 'New name') })
    expect(runtime.release(release.snapshot.id)).toEqual(release)
    const id = randomUUID(), run = await runtime.runRelease(release.snapshot, 'released output', { id })
    expect(run).toMatchObject({ release: { id: release.snapshot.id, sha256: release.sha256 }, state: { status: 'completed', output: 'released output' } })
    await expect(runtime.run(source, 'released output', { id })).rejects.toMatchObject({ code: 'conflict' })
    await runtime.close()
    const reopened = await LocalRuntime.open({ dataDirectory })
    try { expect(reopened.release(release.snapshot.id)).toEqual(release); expect(await reopened.runRelease(release.snapshot, 'released output', { id })).toEqual(run) }
    finally { await reopened.close() }
  })
  it('transfers execution without requiring the originating project store', async () => {
    const { runtime, command } = await fixture(), release = runtime.createRelease(command)
    await runtime.close()
    const target = await LocalRuntime.open({ dataDirectory: await mkdtemp(join(tmpdir(), 'jevable-released-target-')) })
    try {
      expect(target.projects()).toEqual([])
      expect((await target.runRelease(release.snapshot, 'independent')).state).toMatchObject({ status: 'completed', output: 'independent' })
      expect(target.releases()).toEqual([release])
    } finally { await target.close() }
  })
  it('rejects stale guards, duplicate versions/IDs, archived creation and deletion of referenced projects', async () => {
    const { runtime, command, project } = await fixture()
    try {
      expect(() => runtime.createRelease({ ...command, expectedGeneration: 2 })).toThrow('conflict')
      expect(() => runtime.createRelease({ ...command, revision: '0'.repeat(64) })).toThrow('conflict')
      expect(() => runtime.createRelease({ ...command, version: '../bad' })).toThrow('invalid-command')
      const release = runtime.createRelease(command)
      expect(() => runtime.createRelease(command)).toThrow('conflict')
      expect(() => runtime.createRelease({ ...command, id: release.snapshot.id, version: '2.0.0' })).toThrow('conflict')
      runtime.editProject({ operation: 'archive', id: project.id, expectedGeneration: 1, archived: true, actor: 'local:test' })
      expect(() => runtime.createRelease({ ...command, expectedGeneration: 2, version: '3.0.0' })).toThrow('archived')
      expect(() => runtime.deleteProject(project.id, 2, 'local:test')).toThrow('referenced')
    } finally { await runtime.close() }
  })
  it('refuses unsupported execution graphs and mismatched canonical source', async () => {
    const { runtime, command } = await fixture()
    try {
      const release = runtime.createRelease(command)
      expect(() => inspectRelease({ ...release.snapshot, workflow: { ...release.snapshot.workflow, yaml: source } })).toThrow()
      expect(() => inspectRelease({ ...release.snapshot, runtime: { ...artifact.identity, version: 'future' } })).toThrow('conflict')
      const doc = JSON.parse(JSON.stringify((await import('../src/workflow/index.ts')).parseWorkflow(source, (await import('../src/limits.ts')).DEFAULT_COMPILER_LIMITS.source).document))
      doc.spec.nodes.result = { type: 'custom', config: { handler: 'unsupported' } }
      expect(() => inspectRelease({ ...release.snapshot, workflow: { revision: '0'.repeat(64), yaml: JSON.stringify(doc) } })).toThrow()
    } finally { await runtime.close() }
  })
  it('refuses native Decision providers even when workflow compilation succeeds', async () => {
    const { runtime, command } = await fixture()
    try {
      const yaml = await readFile(new URL('../examples/decision.yaml', import.meta.url), 'utf8')
      expect((await import('../src/validation.ts')).validateSource(yaml).status).toBe('valid')
      const project = runtime.editProject({ operation: 'create', title: 'Native Decision', yaml, actor: 'local:test' })
      expect(() => runtime.createRelease({ ...command, projectId: project.id, revision: project.acceptedRevision })).toThrow('invalid-command')
      expect(runtime.releases()).toEqual([])
    } finally { await runtime.close() }
  })
  it('rejects changed retained release content before exposing its runs', async () => {
    const { runtime, command, dataDirectory } = await fixture(), release = runtime.createRelease(command)
    await runtime.close()
    const db = new DatabaseSync(join(dataDirectory, 'runtime.sqlite'))
    const altered = structuredClone(release); altered.snapshot.version = '9.0.0'
    db.prepare('UPDATE releases SET record=? WHERE id=?').run(JSON.stringify(altered), release.snapshot.id); db.close()
    await expect(LocalRuntime.open({ dataDirectory })).rejects.toMatchObject({ code: 'corrupt' })
  })
  it('packages exact allowlisted content/checksums and refuses another runtime build', async () => {
    const { runtime, command } = await fixture()
    try {
      runtime.setCredential('fixture/key', 'SHOULD_NOT_EXPORT', 0, 'local:test')
      const release = runtime.createRelease(command), zip = createReleaseZip(release, artifact), files = unzipSync(zip)
      expect(Object.keys(files).sort()).toEqual(['.dockerignore', '.env.example', 'Dockerfile', 'NOTICES.txt', 'README.txt', 'app.mjs', 'compose.yaml', 'configuration.json', 'manifest.json', 'release.json', 'runtime.mjs', 'workflow.yaml'].sort())
      const manifest = JSON.parse(Buffer.from(files['manifest.json']!).toString())
      expect(manifest).toMatchObject({ releaseId: release.snapshot.id, releaseSha256: release.sha256, runtime: artifact.identity })
      for (const file of manifest.files) {
        const data = files[file.path]!; expect(data.byteLength).toBe(file.bytes)
        expect(createHash('sha256').update(data).digest('hex')).toBe(file.sha256)
      }
      expect(Buffer.from(files['workflow.yaml']!).toString()).toBe(release.snapshot.workflow.yaml)
      const guide = Buffer.from(files['README.txt']!).toString()
      expect(guide).toContain('The inert operator page is at the reported URL')
      expect(guide).toContain('GET /v1/openapi.json')
      expect(guide).not.toContain('not the authoring API or browser viewer')
      expect(Object.values(files).map(value => Buffer.from(value).toString()).join('')).not.toContain('SHOULD_NOT_EXPORT')
      expect(() => createReleaseZip(release, { ...artifact, bytes: Buffer.from('another runtime') })).toThrow('conflict')
      expect(() => createReleaseZip({ ...release, sha256: '0'.repeat(64) }, artifact)).toThrow('conflict')
    } finally { await runtime.close() }
  })
})

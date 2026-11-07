import { describe, expect, it, vi } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { zipSync, unzipSync } from 'fflate'
import { LocalRuntime } from '../src/runtime/index.ts'
import { createProjectZip, readProjectZip, PROJECT_PACKAGE_LIMITS } from '../src/packages/project-zip.ts'
import { main } from '../src/cli.ts'

const directory = () => mkdtemp(join(tmpdir(), 'jevable-package-test-'))
const source = () => readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
async function fixture() {
  const dataDirectory = await directory(), runtime = await LocalRuntime.open({ dataDirectory })
  const project = runtime.editProject({ operation: 'create', title: 'Exportable', yaml: await source(), actor: 'local:original' })
  return { dataDirectory, runtime, project }
}

describe('portable project transfer', () => {
  it.each([false, true])('round trips a reviewed project with history=%s without runtime state', async history => {
    const { runtime, project } = await fixture()
    const target = await LocalRuntime.open({ dataDirectory: await directory() })
    try {
      const draft = runtime.editProject({ operation: 'propose', id: project.id, expectedGeneration: 1,
        yaml: (await source()).replace('name: ', 'name: Proposed '), actor: 'local:original' })
      runtime.setCredential('private/ref', 'private-value-do-not-export', 0, 'local:original')
      await runtime.runProject(project.id, 2, project.acceptedRevision, 'private-run-input-do-not-export')
      const bundle = runtime.exportProject(project.id, 2, project.acceptedRevision, history)
      const json = JSON.stringify(bundle)
      expect(json).not.toContain('private-value-do-not-export')
      expect(json).not.toContain('private-run-input-do-not-export')
      expect(Boolean(bundle.history)).toBe(history)
      expect(() => runtime.exportProject(project.id, 1, project.acceptedRevision)).toThrow(/conflict/)
      const imported = target.importProject(json, sha(json), 'local:importer')
      expect(imported.id).not.toBe(project.id)
      expect(imported.acceptedRevision).toBe(project.acceptedRevision)
      expect(imported.proposals).toEqual(history ? draft.proposals : [])
      expect(imported.changes.at(-1)).toMatchObject({ operation: 'import', actor: 'local:importer', sourceProjectId: project.id, sourceGeneration: 2, historyIncluded: history })
      expect(target.connections()).toEqual([])
      expect(target.credentialStatus('private/ref').configured).toBe(false)
      expect(target.list()).toEqual([])
      const output = await target.runProject(imported.id, imported.generation, imported.acceptedRevision, 'fresh input')
      expect(output.state).toMatchObject({ status: 'completed', output: 'fresh input' })
    } finally { await runtime.close(); await target.close() }
  })

  it('retains imported authoring history across restart and re-export', async () => {
    const { runtime, project } = await fixture(), targetDirectory = await directory()
    let target = await LocalRuntime.open({ dataDirectory: targetDirectory })
    const archived = runtime.editProject({ operation: 'archive', id: project.id, expectedGeneration: 1, archived: true, actor: 'local:original' })
    const json = JSON.stringify(runtime.exportProject(project.id, 2, archived.acceptedRevision, true))
    const imported = target.importProject(json, sha(json), 'local:importer')
    expect(imported.archived).toBe(true)
    expect(imported.changes.slice(0, -1)).toEqual(archived.changes)
    await target.close()
    target = await LocalRuntime.open({ dataDirectory: targetDirectory })
    expect(target.project(imported.id)).toEqual(imported)
    const next = JSON.stringify(target.exportProject(imported.id, imported.generation, imported.acceptedRevision, true))
    expect(runtime.importProject(next, sha(next), 'local:second').changes.at(-1)).toMatchObject({ sourceProjectId: imported.id })
    await runtime.close(); await target.close()
  })

  it('refuses altered source, forged history, wrong reviewed hash, ID collisions and identity reuse', async () => {
    const { runtime, project } = await fixture()
    try {
      const bundle = runtime.exportProject(project.id, 1, project.acceptedRevision, true), json = JSON.stringify(bundle)
      expect(() => runtime.importProject(json, 'a'.repeat(64), 'local:importer')).toThrow(/conflict/)
      expect(() => runtime.importProject(json, sha(json), 'local:importer', project.id)).toThrow(/conflict/)
      const id = randomUUID(); runtime.importProject(json, sha(json), 'local:importer', id)
      expect(() => runtime.importProject(json, sha(json), 'local:importer', id)).toThrow(/conflict/)
      const alteredYaml = bundle.accepted.yaml.replace('name: ', 'name: Altered ')
      expect(alteredYaml).not.toBe(bundle.accepted.yaml)
      const altered = JSON.stringify({ ...bundle, accepted: { ...bundle.accepted, yaml: alteredYaml } })
      expect(() => runtime.importProject(altered, sha(altered), 'local:importer')).toThrow()
      const forged = structuredClone(bundle)
      forged.history!.changes.push({ operation: 'accept', at: new Date().toISOString(), actor: 'forged',
        proposalId: randomUUID(), revision: project.acceptedRevision, approvalChanges: [] })
      const forgedJSON = JSON.stringify(forged)
      expect(() => runtime.importProject(forgedJSON, sha(forgedJSON), 'local:importer')).toThrow()
      expect(runtime.projects()).toHaveLength(2)
    } finally { await runtime.close() }
  })

  it('rolls back a failed import without a partial project or journal', async () => {
    const { runtime, project, dataDirectory } = await fixture()
    const json = JSON.stringify(runtime.exportProject(project.id, 1, project.acceptedRevision))
    const database = new DatabaseSync(join(dataDirectory, 'runtime.sqlite'))
    database.exec("CREATE TRIGGER fail_import BEFORE INSERT ON projects BEGIN SELECT RAISE(ABORT, 'fixture'); END;")
    expect(() => runtime.importProject(json, sha(json), 'local:importer')).toThrow()
    expect(runtime.projects()).toHaveLength(1)
    database.exec('DROP TRIGGER fail_import'); database.close(); await runtime.close()
  })

  it('packs exact companions with checksums and round trips the declared bundle', async () => {
    const { runtime, project } = await fixture()
    try {
      const bundle = runtime.exportProject(project.id, 1, project.acceptedRevision, true), zip = createProjectZip(bundle)
      const unpacked = unzipSync(zip)
      expect(Object.keys(unpacked).sort()).toEqual(['README.txt', 'manifest.json', 'preview.html', 'project.json', 'workflow.yaml'])
      const read = await readProjectZip(zip)
      expect(JSON.parse(read.json)).toEqual(bundle)
      expect(read.archiveSha256).toBe(sha(zip))
      expect(runtime.inspectProjectImport(read.json).bundle.accepted).toEqual(bundle.accepted)
      expect(Buffer.from(unpacked['preview.html']!).toString()).toContain('Portable inspection only')
      const imported = runtime.importProject(read.json, sha(read.json), 'local:importer')
      expect(imported.acceptedRevision).toBe(project.acceptedRevision)
    } finally { await runtime.close() }
  })

  it.each(['../project.json', '/project.json', 'C:/project.json', 'folder\\project.json', 'extra.txt', 'PROJECT.JSON'])('refuses unsafe/unexpected archive entry %s', async path => {
    const bytes = zipSync({ [path]: Buffer.from('{}') })
    await expect(readProjectZip(bytes)).rejects.toHaveProperty('code', 'invalid-package')
  })

  it('hashes the admitted project bytes rather than a caller-mutated buffer', async () => {
    const { runtime, project } = await fixture()
    try {
      const bytes = createProjectZip(runtime.exportProject(project.id, 1, project.acceptedRevision)), expected = sha(bytes)
      const pending = readProjectZip(bytes); bytes.fill(0)
      expect((await pending).archiveSha256).toBe(expected)
    } finally { await runtime.close() }
  })

  it('refuses symlinks, excess files, decompression expansion, missing entries and truncated archives', async () => {
    await expect(readProjectZip(zipSync({ 'project.json': [Buffer.from('target'), { os: 3, attrs: 0o120777 << 16 }] }))).rejects.toHaveProperty('code', 'invalid-package')
    await expect(readProjectZip(zipSync(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`${i}.txt`, Buffer.from('x')]))))).rejects.toHaveProperty('code', 'package-limit')
    await expect(readProjectZip(zipSync({ 'project.json': Buffer.alloc(PROJECT_PACKAGE_LIMITS.entryBytes + 1, 65) }))).rejects.toHaveProperty('code', 'package-limit')
    await expect(readProjectZip(zipSync({ 'project.json': Buffer.from('{}') }))).rejects.toHaveProperty('code', 'invalid-package')
    await expect(readProjectZip(Buffer.from('PK truncated'))).rejects.toHaveProperty('code', 'invalid-package')
  })

  it('refuses content/checksum mismatches and disagreement between YAML and declared project', async () => {
    const { runtime, project } = await fixture()
    try {
      const files = unzipSync(createProjectZip(runtime.exportProject(project.id, 1, project.acceptedRevision)))
      files['workflow.yaml'] = Buffer.from('wrong workflow')
      await expect(readProjectZip(zipSync(files))).rejects.toHaveProperty('code', 'checksum-mismatch')
      const manifest = JSON.parse(Buffer.from(files['manifest.json']!).toString())
      const entry = manifest.files.find((entry: { path: string }) => entry.path === 'workflow.yaml')
      entry.bytes = files['workflow.yaml'].length; entry.sha256 = sha(files['workflow.yaml'])
      files['manifest.json'] = Buffer.from(JSON.stringify(manifest))
      await expect(readProjectZip(zipSync(files))).rejects.toHaveProperty('code', 'checksum-mismatch')
    } finally { await runtime.close() }
  })

  it('checks actual decompressed bytes even when the central-directory size lies', async () => {
    const bytes = Buffer.from(zipSync({ 'project.json': Buffer.alloc(100_000, 65) }))
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    bytes.writeUInt32LE(10, central + 24)
    await expect(readProjectZip(bytes)).rejects.toThrow()
  })

  it('rejects encrypted and unsupported compression entries before parsing their payloads', async () => {
    for (const mode of ['encrypted', 'compression']) {
      const bytes = Buffer.from(zipSync({ 'project.json': Buffer.from('{}') }))
      const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
      if (mode === 'encrypted') bytes.writeUInt16LE(bytes.readUInt16LE(central + 8) | 1, central + 8)
      else bytes.writeUInt16LE(99, central + 10)
      await expect(readProjectZip(bytes)).rejects.toHaveProperty('code', 'invalid-package')
    }
  })

  it('enforces aggregate expansion limits across individually bounded entries', async () => {
    const data = Buffer.alloc(12_100_000, 65)
    const bytes = zipSync({ 'project.json': data, 'preview.html': data, 'workflow.yaml': data, 'README.txt': data })
    await expect(readProjectZip(bytes)).rejects.toHaveProperty('code', 'package-limit')
  })

  it('preserves existing version 4 history when enabling import journal events', async () => {
    const { runtime, project, dataDirectory } = await fixture()
    const json = JSON.stringify(runtime.exportProject(project.id, 1, project.acceptedRevision, true))
    await runtime.close()
    const database = new DatabaseSync(join(dataDirectory, 'runtime.sqlite'))
    database.exec('PRAGMA user_version=4;'); database.close()
    const reopened = await LocalRuntime.open({ dataDirectory })
    expect(reopened.project(project.id)).toEqual(project)
    expect(reopened.importProject(json, sha(json), 'local:importer').changes.at(-1)!.operation).toBe('import')
    await reopened.close()
  })

  it('refuses duplicate entry names and CRC corruption', async () => {
    const duplicate = Buffer.from(zipSync({ 'project.json': Buffer.from('{}'), 'project.jsox': Buffer.from('{}') }))
    for (let offset = duplicate.indexOf('project.jsox'); offset !== -1; offset = duplicate.indexOf('project.jsox')) duplicate.write('project.json', offset)
    await expect(readProjectZip(duplicate)).rejects.toHaveProperty('code', 'invalid-package')
    const corrupt = Buffer.from(zipSync({ 'project.json': Buffer.from('{}') }))
    const central = corrupt.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    corrupt.writeUInt32LE(0, central + 16)
    await expect(readProjectZip(corrupt)).rejects.toHaveProperty('code', 'checksum-mismatch')
  })

  it('exports, inspects, and imports through installed-style CLI calls without running', async () => {
    const { runtime, project, dataDirectory } = await fixture(), target = await directory(), zip = join(await directory(), 'workflow.zip')
    await runtime.close()
    const out = vi.fn(), err = vi.fn()
    expect(await main(['projects', 'export', project.id, '--expected-generation', '1', '--revision', project.acceptedRevision,
      '--format', 'zip', '--output', zip, '--data-dir', dataDirectory], { out, err })).toBe(0)
    expect(await main(['import', 'inspect', zip, '--data-dir', target], { out, err })).toBe(0)
    const inspected = JSON.parse(out.mock.calls.at(-1)![0])
    expect(inspected.execution).toBe('not-run')
    expect(await main(['import', 'project', zip, '--reviewed-sha256', 'a'.repeat(64), '--data-dir', target], { out, err })).toBe(1)
    expect(await main(['import', 'project', zip, '--reviewed-sha256', inspected.artifactSha256, '--data-dir', target], { out, err })).toBe(0)
    const imported = JSON.parse(out.mock.calls.at(-1)![0])
    expect(imported.revision).toBe(project.acceptedRevision)
    const reopened = await LocalRuntime.open({ dataDirectory: target })
    expect(reopened.list()).toEqual([])
    expect(reopened.projects()).toHaveLength(1)
    await reopened.close()
  })
})

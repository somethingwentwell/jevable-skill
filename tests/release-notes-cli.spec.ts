import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { main } from '../src/cli.ts'
import * as operations from '../src/cli/operations.ts'
import { LocalRuntime } from '../src/runtime/local.ts'
import { dispatchOperation } from '../src/http/operations.ts'
import { inspectRelease, RELEASE_NOTES_MAX_BYTES } from '../src/releases/snapshot.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { writeArtifact } from '../src/files.ts'

// Test executable hash negotiation without depending on a source-checkout build.
// Independently installed/extracted app qualification uses real bundled programs.
vi.mock('../src/packages/release-zip.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/packages/release-zip.ts')>()
  return { ...actual, loadReleaseRuntime: async () => {
    const bytes = Buffer.from('fixture runtime')
    return { bytes, storage: 'sqlite', notices: Buffer.alloc(0), identity: { version: CORE_VERSION, sha256: createHash('sha256').update(bytes).digest('hex') } }
  } }
})
const source = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const identity = { version: CORE_VERSION, sha256: createHash('sha256').update('fixture runtime').digest('hex') }
const owners: LocalRuntime[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const owner of owners.splice(0)) await owner.close() })
async function cli(argv: string[]) {
  let out = '', err = ''
  const code = await main(argv, { out: value => { out += value }, err: value => { err += value } })
  return { code, out, err }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-release-notes-cli-')), owner = await LocalRuntime.open({ dataDirectory: join(directory, 'state') }); owners.push(owner)
  const project = owner.editProject({ operation: 'create', title: 'Notes CLI', actor: 'fixture', yaml: source })
  const command = { operation: 'releases.create' as const, id: randomUUID(), projectId: project.id,
    expectedGeneration: 1, revision: project.acceptedRevision, version: '1.0.0', runtimeStorage: 'sqlite' as const, runtime: identity }
  const call = (value: unknown) => dispatchOperation({ storage: 'sqlite', runtime: owner }, value, 'fixture:fixed-host')
  const argv = ['releases', 'create', project.id, '--id', command.id, '--expected-generation', '1', '--revision', project.acceptedRevision, '--version', '1.0.0']
  return { directory, owner, command, call, argv }
}

describe('release notes CLI/API boundary', () => {
  it.each([Buffer.from('  \n\t'), Buffer.from([0xc3, 0x28]), Buffer.alloc(RELEASE_NOTES_MAX_BYTES + 1, 120), Buffer.from('PRIVATE\u001b[31m')])('refuses invalid note files before owner or remote credential I/O (case %#)', async bytes => {
    const f = await fixture(), path = join(f.directory, 'notes.txt'); await writeArtifact(path, bytes)
    const open = vi.spyOn(operations, 'openCliOperations')
    for (const flags of [[], ['--endpoint', 'https://not-contacted.invalid', '--instance-id', randomUUID(), '--token-file', '/not-read']]) {
      const result = await cli([...f.argv, '--notes-file', path, ...flags])
      expect(result.code).toBe(2); expect(result.out).toBe('')
      expect(result.err).not.toContain('PRIVATE'); expect(result.err).not.toContain(path)
      expect(open).not.toHaveBeenCalled(); expect(f.owner.releases()).toEqual([])
    }
  })
  it('passes exact BOM/newlines/text to the fixed actor API and metadata-only list/show, without running', async () => {
    const f = await fixture(), notes = '\ufeff  改进 ✨\r\n\tPlain <script> text\n', path = join(f.directory, 'notes.txt')
    await writeArtifact(path, notes)
    vi.spyOn(operations, 'openCliOperations').mockResolvedValue({ storage: 'sqlite', call: f.call, close: async () => {} })
    const result = await cli([...f.argv, '--notes-file', path])
    expect(result.code, result.err).toBe(0)
    const release = JSON.parse(result.out)
    expect(release.snapshot).toMatchObject({ notes, createdBy: 'fixture:fixed-host' })
    expect(await f.call({ operation: 'releases.show', id: f.command.id })).toEqual(release)
    const list: any = await f.call({ operation: 'releases.list' })
    expect(list.releases[0]).toMatchObject({ notes, sha256: release.sha256 })
    expect(list.releases[0]).not.toHaveProperty('workflow'); expect(f.owner.list()).toEqual([])
  })
  it('refuses owner-altered notes even when the owner response supplies a consistent replacement hash', async () => {
    const f = await fixture(), path = join(f.directory, 'notes.txt'); await writeArtifact(path, 'Reviewed text')
    vi.spyOn(operations, 'openCliOperations').mockResolvedValue({ storage: 'sqlite', close: async () => {}, call: async value => {
      const release: any = await f.call(value)
      return inspectRelease({ ...release.snapshot, notes: 'owner changed the reviewed text' })
    } })
    const result = await cli([...f.argv, '--notes-file', path])
    expect(result.code).toBe(1); expect(JSON.parse(result.err).code).toBe('invalid-response')
    expect(f.owner.release(f.command.id).snapshot.notes).toBe('Reviewed text')
  })
  it('rejects invalid notes, actor overrides and wrong runtime identity before release mutation', async () => {
    const f = await fixture()
    for (const patch of [{ notes: null }, { notes: '' }, { notes: 'private\0' }, { notes: 'ok', actor: 'attacker' }]) {
      await expect(f.call({ ...f.command, ...patch })).rejects.toHaveProperty('code', 'invalid-command')
    }
    await expect(f.call({ ...f.command, notes: 'valid', runtime: { ...identity, sha256: '0'.repeat(64) } })).rejects.toHaveProperty('code', 'conflict')
    expect(f.owner.releases()).toEqual([])
  })
})

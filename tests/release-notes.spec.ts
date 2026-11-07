import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { unzipSync } from 'fflate'
import { LocalRuntime } from '../src/runtime/local.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { inspectRelease, releaseNotesSchema, releaseCreateCommandSchema, releaseRequirements, RELEASE_NOTES_MAX_BYTES } from '../src/releases/snapshot.ts'
import { PostgresReleaseStore } from '../src/releases/postgres-store.ts'
import type { PostgresJournal } from '../src/storage/postgres.ts'
import { PostgresProjectStore } from '../src/projects/postgres-store.ts'
import { createReleaseZip } from '../src/packages/release-zip.ts'
import { ReleaseSession } from '../src/releases/service-session.ts'
import { runReleaseApp, type ReleaseBackend } from '../src/releases/app.ts'

const source = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const bytes = Buffer.from('fixture runtime, not executable qualification')
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const artifact = { storage: 'sqlite' as const, bytes, notices: Buffer.from('Fixture notice'), identity: { version: CORE_VERSION, sha256: sha(bytes) } }
const notes = '\ufeff  Improve support routing.\r\n\t保留审批 ✨\n<script>alert("not executable")</script>  \n'
const owners: LocalRuntime[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const owner of owners.splice(0)) await owner.close() })
async function fixture() {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-release-notes-'))
  const owner = await LocalRuntime.open({ dataDirectory }); owners.push(owner)
  const project = owner.editProject({ operation: 'create', title: 'Release notes', yaml: source, actor: 'fixture' })
  const command = { projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision, version: '1.0.0', actor: 'fixture', runtime: artifact.identity }
  return { owner, project, command, dataDirectory }
}

describe('immutable release notes', () => {
  it('keeps omitted and explicit undefined creation shape/hash identical to the old contract', async () => {
    const f = await fixture(), release = f.owner.createRelease({ ...f.command, notes: undefined })
    expect(Object.keys(release.snapshot)).toEqual(['format', 'schemaVersion', 'id', 'version', 'createdAt', 'createdBy', 'project', 'workflow', 'runtime'])
    expect(release.sha256).toBe(sha(JSON.stringify(release.snapshot)))
    expect(inspectRelease(release.snapshot)).toEqual(release)
    expect(inspectRelease({ ...release.snapshot, notes: undefined }).sha256).toBe(release.sha256)
  })
  it('preserves exact text and binds it to the release hash independently of executable source/configuration', async () => {
    const f = await fixture(), release = f.owner.createRelease({ ...f.command, notes })
    expect(release.snapshot.notes).toBe(notes)
    const { notes: _notes, ...old } = release.snapshot
    const without = inspectRelease(old), changed = inspectRelease({ ...release.snapshot, notes: notes + 'changed' })
    expect(release.sha256).not.toBe(without.sha256); expect(changed.sha256).not.toBe(release.sha256)
    expect(releaseRequirements(release.snapshot)).toEqual(releaseRequirements(without.snapshot))
    expect(release.snapshot.workflow).toEqual(without.snapshot.workflow)
  })
  it.each(['', ' \r\n\t', '\0private', 'escape\u001b[31m', 'delete\u007f', '\ud800', '\udfff', 'x'.repeat(RELEASE_NOTES_MAX_BYTES + 1), '😀'.repeat(4097)])('refuses invalid notes without a release mutation (case %#)', async invalid => {
    const f = await fixture()
    expect(releaseNotesSchema.safeParse(invalid).success).toBe(false)
    expect(() => f.owner.createRelease({ ...f.command, notes: invalid })).toThrow('invalid-command')
    expect(f.owner.releases()).toEqual([])
    expect(() => inspectRelease({ ...f.owner.createRelease(f.command).snapshot, notes: invalid })).toThrow('invalid-command')
  })
  it.each(['x'.repeat(RELEASE_NOTES_MAX_BYTES), '😀'.repeat(4096), 'é'.repeat(8192)])('admits exact UTF-8 byte boundaries without truncation (case %#)', value => {
    expect(Buffer.byteLength(value)).toBe(RELEASE_NOTES_MAX_BYTES)
    expect(releaseNotesSchema.parse(value)).toBe(value)
    expect(releaseNotesSchema.safeParse(value + 'x').success).toBe(false)
  })
  it('uses the same strict SDK creation contract for both stores, refusing unknown executable fields', async () => {
    const f = await fixture(), value = { ...f.command, notes, execute: true }
    expect(releaseCreateCommandSchema.safeParse(value).success).toBe(false)
    expect(() => f.owner.createRelease(value)).toThrow('invalid-command')
    const journal = { signal: new AbortController().signal, get: vi.fn(), commit: vi.fn() } as unknown as PostgresJournal
    expect(() => new PostgresReleaseStore(journal).create(value)).toThrow('invalid-command')
    expect(journal.get).not.toHaveBeenCalled(); expect(journal.commit).not.toHaveBeenCalled()
  })
  it('preserves version/UUID immutability, reopening and independent transferred execution', async () => {
    const f = await fixture(), release = f.owner.createRelease({ ...f.command, notes })
    expect(() => f.owner.createRelease({ ...f.command, notes: 'different' })).toThrow('conflict')
    expect(() => f.owner.createRelease({ ...f.command, id: release.snapshot.id, version: '2.0.0', notes: 'different' })).toThrow('conflict')
    const run = await f.owner.runRelease(release.snapshot, 'notes are not input')
    expect(run.state).toMatchObject({ status: 'completed', output: 'notes are not input' })
    await f.owner.close(); owners.splice(owners.indexOf(f.owner), 1)
    const reopened = await LocalRuntime.open({ dataDirectory: f.dataDirectory }); owners.push(reopened)
    expect(reopened.release(release.snapshot.id)).toEqual(release)
    expect((await reopened.runRelease(release.snapshot, 'notes are not input', { id: run.id }))).toEqual(run)
    await expect(reopened.runRelease({ ...release.snapshot, notes: 'different' }, 'notes are not input', { id: run.id })).rejects.toHaveProperty('code', 'conflict')
    const target = await fixture()
    expect((await target.owner.runRelease(release.snapshot, 'independent')).state).toMatchObject({ status: 'completed', output: 'independent' })
    expect(target.owner.release(release.snapshot.id)).toEqual(release)
  })
  it('refuses corrupted retained notes before exposing retained runs', async () => {
    const f = await fixture(), release = f.owner.createRelease({ ...f.command, notes })
    await f.owner.runRelease(release.snapshot, 'retained')
    await f.owner.close(); owners.splice(owners.indexOf(f.owner), 1)
    const db = new DatabaseSync(join(f.dataDirectory, 'runtime.sqlite'))
    try { db.prepare('UPDATE releases SET record=? WHERE id=?').run(JSON.stringify({ ...release, snapshot: { ...release.snapshot, notes: 'tampered' } }), release.snapshot.id) }
    finally { db.close() }
    await expect(LocalRuntime.open({ dataDirectory: f.dataDirectory })).rejects.toHaveProperty('code', 'corrupt')
  })
  it('includes notes only as hashed release metadata in the fixed ZIP allowlist', async () => {
    const f = await fixture(), release = f.owner.createRelease({ ...f.command, notes }), files = unzipSync(createReleaseZip(release, artifact))
    expect(JSON.parse(Buffer.from(files['release.json']!).toString()).snapshot.notes).toBe(notes)
    const manifest = JSON.parse(Buffer.from(files['manifest.json']!).toString())
    expect(manifest.releaseSha256).toBe(release.sha256)
    for (const file of manifest.files) expect(sha(files[file.path]!)).toBe(file.sha256)
    expect(Object.keys(files).sort()).toEqual(['.dockerignore', '.env.example', 'Dockerfile', 'NOTICES.txt', 'README.txt', 'app.mjs', 'compose.yaml', 'configuration.json', 'manifest.json', 'release.json', 'runtime.mjs', 'workflow.yaml'].sort())
    for (const name of ['configuration.json', 'workflow.yaml', 'Dockerfile', 'compose.yaml', 'app.mjs']) expect(Buffer.from(files[name]!).toString()).not.toContain(notes)
    expect(() => createReleaseZip({ ...release, snapshot: { ...release.snapshot, notes: 'tampered' } }, artifact)).toThrow('conflict')
  })
  it.each(['sqlite', 'postgres'] as const)('exposes optional notes through offline %s app info and exact-release info, not execution pins', async storage => {
    const f = await fixture(), release = f.owner.createRelease({ ...f.command, notes })
    let out = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(acknowledgeCliWrite(value => { out += value }))
    const backend = { storage, open: vi.fn() } as unknown as ReleaseBackend
    expect(await runReleaseApp(backend, release.snapshot, ['info'], '/unused')).toBe(0)
    expect(JSON.parse(out)).toMatchObject({ notes, releaseSha256: release.sha256, execution: 'not-run' })
    expect(backend.open).not.toHaveBeenCalled()
    const session = new ReleaseSession({ storage: 'sqlite', runtime: f.owner }, release.snapshot, 'fixture')
    expect(await session.operation({ operation: 'release.info', releaseSha256: release.sha256 })).toMatchObject({ notes, release: { sha256: release.sha256 }, execution: 'not-run' })
    expect(session.pin).not.toHaveProperty('notes'); expect(JSON.stringify(session.capabilities())).not.toContain(notes)
    expect(f.owner.list()).toEqual([])
  })
  it('preserves notes in PostgreSQL domain rows while excluding them from journal events and refusing tampered reads', async () => {
    const f = await fixture(), records = new Map<string, any>(), events: unknown[] = []
    vi.spyOn(PostgresProjectStore.prototype, 'get').mockResolvedValue(f.project)
    const journal = {
      signal: new AbortController().signal,
      get: async (collection: string, key: string) => records.get(`${collection}/${key}`), count: async () => 0,
      commit: async (batch: any) => {
        for (const change of batch.changes) records.set(`${change.collection}/${change.key}`, { key: change.key, version: '1', value: change.value })
        events.push(...batch.events)
      },
    } as unknown as PostgresJournal
    const store = new PostgresReleaseStore(journal), release = await store.create({ ...f.command, notes })
    expect(await new PostgresReleaseStore(journal).get(release.snapshot.id)).toEqual(release)
    expect(JSON.stringify(events)).not.toContain('Improve support routing')
    await expect(store.create({ ...f.command, notes: 'different' })).rejects.toHaveProperty('code', 'conflict')
    const row = records.get(`releases/${release.snapshot.id}`); row.value.snapshot.notes = 'changed without hash'
    await expect(store.get(release.snapshot.id)).rejects.toHaveProperty('code', 'corrupt')
  })
})
import { acknowledgeCliWrite } from './helpers/cli-write.ts'

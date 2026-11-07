import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LocalRuntime } from '../src/runtime/local.ts'
import { RunStore } from '../src/runtime/store.ts'
import { ReleaseSession } from '../src/releases/service-session.ts'
import { CORE_VERSION } from '../src/capabilities.ts'

const yaml = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const owners: LocalRuntime[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const runtime of owners.splice(0)) await runtime.close() })
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-release-page-'))
  const runtime = await LocalRuntime.open({ dataDirectory: directory }); owners.push(runtime)
  const project = runtime.editProject({ operation: 'create', title: 'PRIVATE_TITLE', yaml, actor: 'fixture' })
  const release = runtime.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision,
    version: '1.0.0', actor: 'fixture', runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
  const other = runtime.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision,
    version: '2.0.0', actor: 'fixture', runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
  const pin = { id: release.snapshot.id, sha256: release.sha256, revision: project.acceptedRevision }
  const run = (n: number, paused = false) => runtime.runRelease(release.snapshot, { message: 'PRIVATE_REVIEW' }, { id: id(n), paused })
  const session = new ReleaseSession({ storage: 'sqlite', runtime }, release.snapshot, 'fixture')
  const call = (operation: string, page?: object) => session.operation({ operation, ...(page === undefined ? {} : { page }), releaseSha256: release.sha256 })
  return { directory, runtime, release, other, pin, run, call }
}

describe('indexed SQLite release metadata pages', () => {
  it('reads selected payloads only, excluding foreign runs and the continuation sentinel', async () => {
    const f = await fixture()
    const first = await f.run(1), second = await f.run(100)
    for (let n = 2; n < 25; n++) await f.runtime.run(yaml, { message: 'PRIVATE_FOREIGN' }, { id: id(n), paused: true })
    await f.runtime.runRelease(f.other.snapshot, { message: 'PRIVATE_OTHER' }, { id: id(50) })
    const get = RunStore.prototype.get
    const reads = vi.spyOn(RunStore.prototype, 'get').mockImplementation(function (this: RunStore, value) {
      if (value !== first.id) throw Error('unselected payload decoded')
      return get.call(this, value)
    })
    vi.spyOn(f.runtime, 'list').mockImplementation(() => { throw Error('legacy unpaged scan') })
    expect(f.runtime.listReleasePage(f.pin, undefined, 1)).toMatchObject({ runs: [{ id: first.id }], nextCursor: first.id })
    expect(reads).toHaveBeenCalledExactlyOnceWith(first.id)
    const inbox: any = await f.call('approvals.list', { limit: 1 })
    expect(inbox).toMatchObject({ tasks: [{ runId: first.id }], nextCursor: first.id, scannedRuns: 1 })
    expect(JSON.stringify(inbox)).not.toMatch(/PRIVATE_/)
    expect(await f.call('runs.list', { limit: 1 })).toMatchObject({ runs: [{ id: first.id }], nextCursor: first.id })
    reads.mockRestore()
    expect(f.runtime.listReleasePage(f.pin, first.id, 1)).toMatchObject({ runs: [{ id: second.id }], nextCursor: null })
  })

  it('traverses empty task pages and retains ascending exact-release cursors', async () => {
    const f = await fixture()
    await f.run(3); await f.run(1, true); await f.run(2, true)
    let after: string | undefined
    const scanned = [], tasks = []
    do {
      const page: any = await f.call('approvals.list', { limit: 1, ...(after ? { after } : {}) })
      expect(page.scannedRuns).toBe(1); scanned.push(page.nextCursor); tasks.push(...page.tasks)
      after = page.nextCursor ?? undefined
    } while (after)
    expect(scanned).toEqual([id(1), id(2), null]); expect(tasks.map(t => t.runId)).toEqual([id(3)])
    expect(await f.call('runs.list')).toMatchObject({ schemaVersion: 1, runs: [{ id: id(3) }, { id: id(1) }, { id: id(2) }] })
  })

  it('refuses unknown, ordinary and other-release cursors even for identical workflow revisions', async () => {
    const f = await fixture(); await f.run(3)
    await f.runtime.run(yaml, { message: 'private' }, { id: id(1), paused: true })
    await f.runtime.runRelease(f.other.snapshot, { message: 'private' }, { id: id(2) })
    for (const after of [id(1), id(2), id(99)]) {
      expect(() => f.runtime.listReleasePage(f.pin, after)).toThrow(expect.objectContaining({ code: 'not-found' }))
      for (const operation of ['runs.list', 'approvals.list']) await expect(f.call(operation, { after })).rejects.toHaveProperty('code', 'not-found')
    }
    for (const pin of [{ ...f.pin, sha256: 'b'.repeat(64) }, { ...f.pin, revision: 'b'.repeat(64) }, { ...f.pin, id: f.other.snapshot.id }]) {
      expect(f.runtime.listReleasePage(pin)).toEqual({ runs: [], nextCursor: null })
      expect(() => f.runtime.listReleasePage(pin, id(3))).toThrow(expect.objectContaining({ code: 'not-found' }))
    }
  })

  it.each([null, {}, { id: 'bad', sha256: 'a'.repeat(64), revision: 'a'.repeat(64) }])('rejects invalid pin %j before reads', async pin => {
    const f = await fixture(), read = vi.spyOn(RunStore.prototype, 'get')
    expect(() => f.runtime.listReleasePage(pin as any)).toThrow(expect.objectContaining({ code: 'invalid-command' }))
    expect(read).not.toHaveBeenCalled()
  })

  it('rejects invalid page options before payload reads', async () => {
    const f = await fixture(), read = vi.spyOn(RunStore.prototype, 'get')
    for (const [after, limit] of [['bad', 1], [undefined, 0], [undefined, 201], [undefined, 1.5]] as const)
      expect(() => f.runtime.listReleasePage(f.pin, after, limit)).toThrow(expect.objectContaining({ code: 'invalid-command' }))
    expect(read).not.toHaveBeenCalled()
  })

  it('rechecks decoded record identity and release membership before returning a page', async () => {
    const f = await fixture(), run = await f.run(1)
    const read = vi.spyOn(RunStore.prototype, 'get')
    for (const record of [{ ...run, id: id(2) }, { ...run, revision: 'b'.repeat(64) },
      { ...run, release: { id: f.other.snapshot.id, sha256: f.other.sha256 } }]) {
      read.mockReturnValue(record)
      expect(() => f.runtime.listReleasePage(f.pin)).toThrow(expect.objectContaining({ code: 'corrupt' }))
    }
  })

  it('adds the index to a version-15 store without rewriting records, events or approval state', async () => {
    const f = await fixture(), run = await f.run(1), before = await f.runtime.events(run.id)
    await f.runtime.close()
    const database = join(f.directory, 'runtime.sqlite')
    let db = new DatabaseSync(database)
    const saved = db.prepare('SELECT record FROM runs WHERE id=?').get(run.id)
    db.exec('DROP INDEX runs_release_page; PRAGMA user_version=15'); db.close()
    const reopened = await LocalRuntime.open({ dataDirectory: f.directory }); owners.push(reopened)
    expect(await reopened.show(run.id)).toEqual(run); expect(await reopened.events(run.id)).toEqual(before)
    expect(reopened.listReleasePage(f.pin)).toMatchObject({ runs: [{ id: run.id, status: 'waiting' }], nextCursor: null })
    db = new DatabaseSync(database, { readOnly: true })
    try {
      expect(db.prepare('SELECT record FROM runs WHERE id=?').get(run.id)).toEqual(saved)
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(18)
      const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM runs WHERE json_extract(record, '$.release.id') = ?
        AND json_extract(record, '$.release.sha256') = ? AND json_extract(record, '$.revision') = ? AND id > ? ORDER BY id LIMIT ?`)
        .all(f.pin.id, f.pin.sha256, f.pin.revision, '', 2)
      expect(plan.map(row => row.detail).join(' ')).toMatch(/SEARCH runs USING (?:COVERING )?INDEX runs_release_page/)
      expect(plan.map(row => row.detail).join(' ')).not.toMatch(/TEMP B-TREE/)
    } finally { db.close() }
  })

  it('rolls back a failed legacy index build and releases only its startup lock', async () => {
    const f = await fixture(), run = await f.run(1); await f.runtime.close()
    const database = join(f.directory, 'runtime.sqlite'), db = new DatabaseSync(database)
    db.exec('DROP INDEX runs_release_page'); db.prepare('UPDATE runs SET record=? WHERE id=?').run('{broken', run.id); db.close()
    await expect(LocalRuntime.open({ dataDirectory: f.directory })).rejects.toHaveProperty('code', 'corrupt')
    expect(await readdir(f.directory)).not.toContain('runtime.lock')
    const retained = new DatabaseSync(database, { readOnly: true })
    try {
      expect(retained.prepare("SELECT name FROM sqlite_master WHERE name='runs_release_page'").get()).toBeUndefined()
      expect(retained.prepare('SELECT record FROM runs WHERE id=?').get(run.id)?.record).toBe('{broken')
    } finally { retained.close() }
  })
})

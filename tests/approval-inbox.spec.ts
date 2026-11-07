import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LocalRuntime, createApprovalInbox, type ApprovalInboxHost } from '../src/runtime/index.ts'
import { recordPage } from '../src/http/pagination.ts'
import { dispatchOperation } from '../src/http/operations.ts'
import { ReleaseSession } from '../src/releases/service-session.ts'
import { runReleaseApp } from '../src/releases/app.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { main } from '../src/cli.ts'
import { RunStore } from '../src/runtime/store.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const owners: LocalRuntime[] = []
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); for (const owner of owners.splice(0)) await owner.close() })
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-inbox-')), runtime = await LocalRuntime.open({ dataDirectory: join(directory, 'state') })
  owners.push(runtime)
  const host: ApprovalInboxHost = {
    listRuns: vi.fn(page => { const result = recordPage(runtime.list(), page.after, page.limit); return { runs: result.items, nextCursor: result.nextCursor } }),
    showRun: vi.fn(id => runtime.show(id)),
  }
  return { directory, runtime, host }
}
async function cli(...args: string[]) {
  let out = '', err = ''
  const exit = await main(args, { out: value => { out += value }, err: value => { err += value } })
  return { exit, out: out ? JSON.parse(out) : undefined, err: err ? JSON.parse(err) : undefined }
}
describe('read-only approval inbox', () => {
  it('uses a bounded SQLite metadata query instead of decoding all retained payloads', async () => {
    const f = await fixture(), first = await f.runtime.run(echo, 'private', { id: id(1) })
    await f.runtime.run(approval, { message: 'private' }, { id: id(2) })
    const original = RunStore.prototype.get
    const read = vi.spyOn(RunStore.prototype, 'get').mockImplementation(function (this: RunStore, value) {
      if (value !== first.id) throw Error('Unselected payload was read')
      return original.call(this, value)
    })
    const all = vi.spyOn(f.runtime, 'list').mockImplementation(() => { throw Error('Unpaged list was read') })
    expect(f.runtime.listPage(undefined, 1)).toMatchObject({ runs: [{ id: first.id }], nextCursor: first.id })
    expect(await dispatchOperation({ storage: 'sqlite', runtime: f.runtime }, { operation: 'approvals.list', page: { limit: 1 } }, 'fixture'))
      .toMatchObject({ tasks: [], scannedRuns: 1, nextCursor: first.id })
    expect(all).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledTimes(2)
    for (const [after, limit] of [['bad', 1], [undefined, 0], [undefined, 201]] as const) expect(() => f.runtime.listPage(after, limit)).toThrow()
  })
  it('bounds retained candidate bytes before projecting private records', async () => {
    const f = await fixture(), run = await f.runtime.run(approval, { message: 'private' })
    const oversized = { ...run, input: 'x'.repeat(64_000_001) }
    await expect(createApprovalInbox({ ...f.host, showRun: () => oversized })).rejects.toHaveProperty('code', 'limit')
  })
  it('follows empty live run pages without hiding later waiting tasks or inspecting non-waiting runs', async () => {
    const f = await fixture()
    const first = await f.runtime.run(echo, 'PRIVATE_COMPLETED', { id: id(1) })
    const wait = await f.runtime.run(approval, { message: 'PRIVATE_REVIEW' }, { id: id(2) })
    const paused = await f.runtime.run(approval, { message: 'PRIVATE_PAUSED' }, { id: id(3), paused: true })
    const before = await f.runtime.events(wait.id)
    const page1 = await createApprovalInbox(f.host, { limit: 1 })
    expect(page1).toMatchObject({ tasks: [], scannedRuns: 1, nextCursor: first.id })
    expect(f.host.showRun).not.toHaveBeenCalled()
    const page2 = await createApprovalInbox(f.host, { limit: 1, after: page1.nextCursor! })
    expect(page2).toMatchObject({ scannedRuns: 1, nextCursor: wait.id, changedCandidates: 0 })
    expect(page2.tasks).toHaveLength(1)
    expect(page2.tasks[0]).toMatchObject({ runId: wait.id, revision: wait.revision, nodeId: 'review',
      expiry: 'not-expired-at-observation', cancellationRequested: false })
    expect(f.host.showRun).toHaveBeenCalledExactlyOnceWith(wait.id)
    expect(await createApprovalInbox(f.host, { limit: 1, after: page2.nextCursor! })).toMatchObject({ tasks: [], nextCursor: null, scannedRuns: 1 })
    expect(JSON.stringify([page1, page2])).not.toContain('PRIVATE_')
    expect(await f.runtime.events(wait.id)).toEqual(before); expect((await f.runtime.show(paused.id)).state.status).toBe('paused')
  })
  it('lists expiry as an observation without settling a waiting task or changing its journal', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-01T00:00:00Z'))
    const f = await fixture(), run = await f.runtime.run(approval, { message: 'PRIVATE_EXPIRED' })
    const before = await f.runtime.events(run.id)
    vi.setSystemTime(new Date('2026-10-03T00:00:00Z'))
    const report = await createApprovalInbox(f.host)
    expect(report.tasks[0]).toMatchObject({ runId: run.id, expiry: 'expired-at-observation', observedAt: '2026-10-03T00:00:00.000Z' })
    expect((await f.runtime.show(run.id)).state.status).toBe('waiting')
    expect(await f.runtime.events(run.id)).toEqual(before)
  })
  it('includes project and reviewed test identities without titles, actors or review values', async () => {
    const f = await fixture(), project = f.runtime.editProject({ operation: 'create', title: 'PRIVATE_TITLE', yaml: approval, actor: 'PRIVATE_ACTOR' })
    const draft = f.runtime.editTest({ operation: 'create', actor: 'PRIVATE_ACTOR', definition: { title: 'PRIVATE_TEST',
      project: { id: project.id, generation: project.generation, revision: project.acceptedRevision }, input: { message: 'PRIVATE_REVIEW' },
      expectations: [{ kind: 'status', value: 'waiting' }] } })
    const test = f.runtime.editTest({ operation: 'accept', id: draft.id, expectedGeneration: 1, reviewedSha256: draft.sha256, actor: 'PRIVATE_REVIEWER' })
    const result = await f.runtime.runTest({ id: test.id, generation: test.generation, sha256: test.sha256 }, randomUUID())
    f.runtime.setCredential('fixture/key', 'PRIVATE_CREDENTIAL', 0, 'PRIVATE_ACTOR')
    const inbox = await createApprovalInbox(f.host)
    expect(inbox.tasks[0]).toMatchObject({ runId: result.run.id, project: { id: project.id, generation: 1 },
      test: { id: test.id, generation: test.generation, sha256: test.sha256 } })
    expect(JSON.stringify(inbox)).not.toMatch(/PRIVATE_|approve|reject/)
  })
  it('omits a candidate decided during enumeration and retains the page cursor', async () => {
    const f = await fixture(), wait = await f.runtime.run(approval, { message: 'private' }, { id: id(1) })
    await f.runtime.run(echo, 'private', { id: id(2) })
    if (wait.state.status !== 'waiting') throw Error('expected wait')
    const attempt = wait.state.attempt.id
    const showRun = vi.fn(async (id: string) => { await f.runtime.decide(id, attempt, 'approve', 'fixture'); return f.runtime.show(id) })
    expect(await createApprovalInbox({ ...f.host, showRun }, { limit: 1 })).toMatchObject({ tasks: [], scannedRuns: 1, changedCandidates: 1, nextCursor: wait.id })
  })
  it('does not discover a new wait behind a live cursor until an explicit new scan', async () => {
    const f = await fixture(), paused = await f.runtime.run(approval, { message: 'private' }, { id: id(1), paused: true })
    await f.runtime.run(echo, 'private', { id: id(2) })
    const first = await createApprovalInbox(f.host, { limit: 1 }); expect(first.tasks).toEqual([])
    await f.runtime.resume(paused.id)
    expect((await createApprovalInbox(f.host, { after: first.nextCursor!, limit: 1 })).tasks).toEqual([])
    expect((await createApprovalInbox(f.host, { limit: 1 })).tasks[0]!.runId).toBe(paused.id)
  })
  it('reports an admitted cancellation separately and omits fully cancelled tasks', async () => {
    const f = await fixture(), waiting = await f.runtime.run(approval, { message: 'private' })
    const snapshot = structuredClone(waiting); snapshot.cancellation = { id: randomUUID(), actor: 'PRIVATE_ACTOR', at: new Date().toISOString() }
    const report = await createApprovalInbox({ ...f.host, showRun: async () => snapshot })
    expect(report.tasks[0]!.cancellationRequested).toBe(true); expect(JSON.stringify(report)).not.toContain('PRIVATE_ACTOR')
    f.runtime.cancel(waiting.id, randomUUID(), 'fixture')
    expect((await createApprovalInbox(f.host)).tasks).toEqual([])
  })
  it.each([null, [], { after: 'bad' }, { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { limit: '1' }, { offset: 1 }])('rejects invalid page %j before reads', async page => {
    const host = { listRuns: vi.fn(), showRun: vi.fn() }
    await expect(createApprovalInbox(host, page as any)).rejects.toHaveProperty('code', 'invalid-command')
    expect(host.listRuns).not.toHaveBeenCalled(); expect(host.showRun).not.toHaveBeenCalled()
  })
  it.each(['duplicate', 'order', 'cursor', 'short-page', 'oversized-page', 'status'])('refuses malformed %s backend pages before candidate reads', async kind => {
    const f = await fixture(), wait = await f.runtime.run(approval, { message: 'private' }, { id: id(2) })
    const row: any = { id: wait.id, revision: wait.revision, status: 'waiting' }, runs: any[] = [row]
    let nextCursor: string | null = null
    if (kind === 'duplicate') runs.push({ ...row })
    if (kind === 'order') runs.push({ ...row, id: id(1) })
    if (kind === 'cursor') nextCursor = id(3)
    if (kind === 'short-page') nextCursor = row.id
    if (kind === 'oversized-page') runs.push({ ...row, id: id(3) })
    if (kind === 'status') row.status = 'invented'
    await expect(createApprovalInbox({ ...f.host, listRuns: () => ({ runs, nextCursor }) }, { limit: kind === 'oversized-page' ? 1 : 2 })).rejects.toHaveProperty('code', 'corrupt')
    expect(f.host.showRun).not.toHaveBeenCalled()
  })
  it.each(['id', 'revision', 'node', 'invalid-run', 'read-failure'])('refuses inconsistent %s observations without a partial inbox', async kind => {
    const f = await fixture(), run = await f.runtime.run(approval, { message: 'private' })
    const showRun = async () => {
      if (kind === 'read-failure') throw Error('fixture read failed')
      const value: any = structuredClone(run)
      if (kind === 'id') value.id = randomUUID()
      if (kind === 'revision') value.revision = '0'.repeat(64)
      if (kind === 'node') value.state.next = 'different'
      if (kind === 'invalid-run') return undefined as any
      return value
    }
    await expect(createApprovalInbox({ ...f.host, showRun })).rejects.toThrow()
  })
  it('uses the shared management operation and requires explicit page syntax before opening CLI state', async () => {
    const f = await fixture(), run = await f.runtime.run(approval, { message: 'private' })
    await expect(dispatchOperation({ storage: 'sqlite', runtime: f.runtime }, { operation: 'approvals.list' }, 'fixture')).rejects.toHaveProperty('code', 'invalid-command')
    expect(await dispatchOperation({ storage: 'sqlite', runtime: f.runtime }, { operation: 'approvals.list', page: {} }, 'fixture')).toMatchObject({ tasks: [{ runId: run.id }] })
    await f.runtime.close()
    expect((await cli('approvals', 'list', '--data-dir', join(f.directory, 'must-not-create'))).exit).toBe(2)
    expect(await readdir(f.directory)).not.toContain('must-not-create')
    expect(await cli('approvals', 'list', '--page', '--limit', '1', '--data-dir', join(f.directory, 'state'))).toMatchObject({ exit: 0, out: { tasks: [{ runId: run.id }] } })
  })
  it('scopes release inboxes and cursors, and exposes the same read-only inbox in an extracted-app command', async () => {
    const f = await fixture(), project = f.runtime.editProject({ operation: 'create', title: 'Private release', yaml: approval, actor: 'fixture' })
    const artifact = f.runtime.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision,
      version: '1.0.0', runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) }, actor: 'fixture' })
    const own = await f.runtime.runRelease(artifact.snapshot, { message: 'PRIVATE_OWN' }, { id: id(2) })
    const foreign = await f.runtime.run(approval, { message: 'PRIVATE_FOREIGN' }, { id: id(1) })
    const session = new ReleaseSession({ storage: 'sqlite', runtime: f.runtime }, artifact.snapshot, 'fixture')
    const call = (page: object) => session.operation({ operation: 'approvals.list', page, releaseSha256: artifact.sha256 })
    expect(await call({ limit: 1 })).toMatchObject({ tasks: [{ runId: own.id }], nextCursor: null, scannedRuns: 1 })
    await expect(call({ after: foreign.id })).rejects.toHaveProperty('code', 'not-found')
    const before = await f.runtime.events(own.id)
    let output = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(acknowledgeCliWrite(value => { output += value }))
    const backend = { storage: 'sqlite' as const, open: async () => f.runtime, serve: vi.fn() }
    expect(await runReleaseApp(backend, artifact.snapshot, ['approvals', '--page', '--limit', '1'], f.directory)).toBe(0)
    expect(JSON.parse(output)).toMatchObject({ tasks: [{ runId: own.id }], nextCursor: null })
    expect(output).not.toMatch(/PRIVATE_|Private release/)
    const reopened = await LocalRuntime.open({ dataDirectory: join(f.directory, 'state') }); owners.push(reopened)
    expect(await reopened.events(own.id)).toEqual(before)
  })
})
import { acknowledgeCliWrite } from './helpers/cli-write.ts'

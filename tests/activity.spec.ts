import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { LocalRuntime } from '../src/runtime/local.ts'
import { activityReportSchema, ACTIVITY_LIMITS } from '../src/runtime/index.ts'
import { createActivityReport, type ActivityRun } from '../src/runtime/activity.ts'
import { dispatchOperation } from '../src/http/operations.ts'
import { operationCapabilities } from '../src/http/operation-host.ts'
import { main } from '../src/cli.ts'
import { previewVendorImport } from '../src/projects/vendor-import.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { CORE_VERSION } from '../src/capabilities.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const owners: LocalRuntime[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const owner of owners.splice(0)) await owner.close() })
async function fixture() {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-activity-'))
  const runtime = await LocalRuntime.open({ dataDirectory }); owners.push(runtime)
  return { runtime, dataDirectory }
}
const guard = (p: { id: string; generation: number }) => ({ id: p.id, expectedGeneration: p.generation, actor: 'PRIVATE_ACTOR' })
const create = (r: LocalRuntime) => r.editProject({ operation: 'create', title: 'PRIVATE_TITLE', yaml: echo, actor: 'PRIVATE_ACTOR' })
const withoutObservation = (report: unknown) => { const { observedAt: _time, ...rest } = report as any; return rest }
const metadata = (patch: Partial<ActivityRun> = {}): ActivityRun => ({ id: randomUUID(), revision: 'a'.repeat(64),
  createdAt: '2026-01-01T00:00:00.000Z', status: 'completed', ...patch })
async function cli(...args: string[]) {
  let out = '', err = ''
  const exit = await main(args, { out: text => { out += text }, err: text => { err += text } })
  return { exit, out: out ? JSON.parse(out) : undefined, err: err ? JSON.parse(err) : undefined }
}

describe('selected-owner retained activity', () => {
  it('reports explicit empty retained state, not account/lifetime/billing data', async () => {
    const { runtime } = await fixture(), report = await runtime.activityReport()
    expect(activityReportSchema.parse(report)).toEqual(report)
    expect(report).toMatchObject({ projects: { total: 0, active: 0, archived: 0 }, proposals: { total: 0 },
      runs: { total: 0, firstRetainedRun: null }, scope: 'selected-owner-retained-data', billing: false, lifetimeTotals: false,
      consistency: 'single-owner-coherent-observation', execution: 'not-started-resumed-approved-or-cancelled' })
  })
  it('counts proposal state and local actions separately from imported history and retained project origins', async () => {
    const { runtime } = await fixture()
    let project = create(runtime)
    for (const action of ['accept', 'reject', 'pending']) {
      project = runtime.editProject({ ...guard(project), operation: 'propose', yaml: echo })
      const proposal = project.proposals.at(-1)!
      const review = { ...guard(project), proposalId: proposal.id, reviewedRevision: proposal.revision }
      if (action === 'accept') project = runtime.editProject({ ...review, operation: 'accept', approvalChanges: [] })
      if (action === 'reject') project = runtime.editProject({ ...review, operation: 'reject' })
    }
    const duplicate = runtime.editProject({ ...guard(project), operation: 'duplicate', revision: project.acceptedRevision, title: 'Copy' })
    const bundle = runtime.exportProject(project.id, project.generation, project.acceptedRevision, true)
    const json = JSON.stringify(bundle)
    let imported = runtime.importProject(json, createHash('sha256').update(json).digest('hex'), 'PRIVATE_IMPORTER')
    const source = JSON.stringify({ name: 'Private fixture', privateMemo: 'PRIVATE_UPLOAD',
      nodes: [{ name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} }], connections: {} })
    const preview = previewVendorImport(source, DEFAULT_COMPILER_LIMITS.source)
    const command = { id: randomUUID(), title: 'Vendor', actor: 'PRIVATE_ACTOR', source, yaml: preview.yaml,
      reviewedSourceSha256: preview.sourceSha256, reviewedConversionSha256: preview.conversionSha256, reviewedRevision: preview.conversionRevision }
    const vendor = runtime.createVendorImport(command); runtime.createVendorImport(command)
    imported = runtime.editProject({ ...guard(imported), operation: 'reject', proposalId: imported.proposals.at(-1)!.id,
      reviewedRevision: imported.proposals.at(-1)!.revision })
    runtime.editProject({ ...guard(duplicate), operation: 'archive', archived: true })
    const before = runtime.project(project.id), report = await runtime.activityReport()
    expect(report.projects).toEqual({ total: 4, active: 3, archived: 1, origins: { authored: 1, duplicated: 1, projectBundle: 1, vendor: 1 } })
    expect(report.proposals).toEqual({ total: 6, pending: 1, accepted: 2, rejected: 3, importedHistory: 3,
      localActions: { proposed: 3, accepted: 1, rejected: 2 } })
    expect(report.imports).toEqual({ projectBundle: 1, vendor: 1, basis: 'retained-project-origin' })
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE|Copy|Vendor|yaml|changes|proposalId/u)
    expect(runtime.project(project.id)).toEqual(before); expect(runtime.list()).toEqual([])
    const archived = runtime.editProject({ ...guard(vendor), operation: 'archive', archived: true })
    runtime.deleteProject(archived.id, archived.generation, 'PRIVATE_ACTOR')
    expect((await runtime.activityReport()).imports.vendor).toBe(0)
    expect(runtime.projectDeletions()).toHaveLength(1)
  })
  it('retains run identity/current outcome, project/release links and explicit API entry without counting retries twice', async () => {
    const f = await fixture(), project = create(f.runtime)
    const first = await f.runtime.run(echo, 'PRIVATE_INPUT', { paused: true })
    await f.runtime.run(echo, 'PRIVATE_INPUT', { id: first.id, paused: true })
    const waiting = await f.runtime.run(approval, { message: 'PRIVATE_APPROVAL' })
    await f.runtime.runProject(project.id, project.generation, project.acceptedRevision, 'PRIVATE_PROJECT')
    const release = f.runtime.createRelease({ projectId: project.id, expectedGeneration: project.generation, revision: project.acceptedRevision,
      version: '1.0.0', actor: 'PRIVATE_ACTOR', runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
    await f.runtime.runRelease(release.snapshot, 'PRIVATE_RELEASE')
    await f.runtime.run(echo.replace('[manual]', '[api]'), 'PRIVATE_API', { triggerMode: 'api' })
    await f.runtime.cancel(waiting.id, randomUUID(), 'PRIVATE_ACTOR')
    const history = await f.runtime.events(first.id), report = await f.runtime.activityReport()
    expect(report.runs).toMatchObject({ total: 5, byStatus: { paused: 1, completed: 3, cancelled: 1, waiting: 0, executing: 0, failed: 0 },
      links: { project: 1, release: 1, unlinked: 3 }, triggerSelection: { api: 1, defaultLocal: 4 },
      firstRetainedRun: { id: first.id, revision: first.revision, status: 'paused' } })
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE|"yaml"|"output"|"token"|"actor"/u)
    expect(await f.runtime.events(first.id)).toEqual(history)
    await f.runtime.close()
    const reopened = await LocalRuntime.open({ dataDirectory: f.dataDirectory }); owners.push(reopened)
    expect(withoutObservation(await reopened.activityReport())).toEqual(withoutObservation(report))
    await reopened.resume(first.id)
    expect((await reopened.activityReport()).runs.firstRetainedRun).toMatchObject({ id: first.id, status: 'completed' })
  })
  it.each(['create', 'rename', 'delete', 'new-run', 'transition'])('refuses mixed SQLite observations after concurrent %s without auto retry', async change => {
    const { runtime } = await fixture(), project = create(runtime), first = await runtime.run(echo, 'PRIVATE', { paused: true })
    const original = runtime.show.bind(runtime), show = vi.spyOn(runtime, 'show')
    let started!: () => void, finish!: () => void
    const entered = new Promise<void>(resolve => { started = resolve }), held = new Promise<void>(resolve => { finish = resolve })
    show.mockImplementationOnce(async id => { const run = await original(id); started(); await held; return run })
    const pending = runtime.activityReport(); await entered
    if (change === 'create') create(runtime)
    if (change === 'rename') runtime.editProject({ ...guard(project), operation: 'rename', title: 'Changed' })
    if (change === 'delete') { const archived = runtime.editProject({ ...guard(project), operation: 'archive', archived: true }); runtime.deleteProject(project.id, archived.generation, 'PRIVATE_ACTOR') }
    if (change === 'new-run') await runtime.run(echo, 'Another')
    if (change === 'transition') await runtime.resume(first.id)
    const readsBeforeSettlement = show.mock.calls.length
    finish(); await expect(pending).rejects.toHaveProperty('code', 'conflict')
    expect(show.mock.calls).toHaveLength(readsBeforeSettlement)
  })
  it('refuses corrupt project history rather than summarizing unchecked metadata', async () => {
    const { runtime, dataDirectory } = await fixture(), project = create(runtime)
    const db = new DatabaseSync(join(dataDirectory, 'runtime.sqlite'))
    try {
      const row = db.prepare('SELECT record FROM projects WHERE id=?').get(project.id) as { record: string }
      const value = JSON.parse(row.record); value.changes[0].revision = '0'.repeat(64)
      db.prepare('UPDATE projects SET record=? WHERE id=?').run(JSON.stringify(value), project.id)
      await expect(runtime.activityReport()).rejects.toHaveProperty('code', 'corrupt')
    } finally { db.close() }
  })
  it('refuses after close, and counts all six recorded statuses without asserting a live worker', async () => {
    const { runtime } = await fixture(); await runtime.close()
    await expect(runtime.activityReport()).rejects.toHaveProperty('code', 'closed')
    const states = ['paused', 'executing', 'waiting', 'completed', 'failed', 'cancelled'] as const
    const report = createActivityReport('sqlite', [], states.map(status => metadata({ status })))
    expect(report.runs.byStatus).toEqual(Object.fromEntries(states.map(status => [status, 1])))
    expect(report.execution).toBe('not-started-resumed-approved-or-cancelled')
  })
  it('orders precise retained times first, and uses UUIDs only for equal instants', () => {
    const small = '00000000-0000-4000-8000-000000000001', large = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
    const a = metadata({ id: small, createdAt: '2026-01-01T00:00:00.000002Z' })
    const b = metadata({ id: large, createdAt: '2026-01-01T00:00:00.000001Z' })
    expect(createActivityReport('sqlite', [], [a, b]).runs.firstRetainedRun?.id).toBe(large)
    expect(createActivityReport('sqlite', [], [a, { ...b, createdAt: a.createdAt + '' }]).runs.firstRetainedRun?.id).toBe(small)
    expect(createActivityReport('sqlite', [], [a, { ...b, createdAt: '2026-01-01T00:00:00Z' }]).runs.firstRetainedRun?.id).toBe(large)
    expect(createActivityReport('sqlite', [], [a, { ...b, createdAt: '2026-01-01T00:00:00.0000020Z' }]).runs.firstRetainedRun?.id).toBe(small)
  })
  it.each([{ createdAt: 'bad' }, { status: 'running' }, { triggerMode: 'manual' }, { id: 'bad' }, { revision: 'bad' },
    { project: { id: randomUUID(), generation: 1 }, release: { id: randomUUID(), sha256: 'a'.repeat(64) } }])('refuses malformed metadata even when not selected first (%#)', patch => {
    expect(() => createActivityReport('sqlite', [], [metadata(), metadata(patch as never)])).toThrow('corrupt')
  })
  it('refuses duplicates, forged inconsistent output and capacity overflow without truncation', () => {
    const run = metadata(), report = createActivityReport('sqlite', [], [run])
    expect(() => createActivityReport('sqlite', [], [run, { ...run }])).toThrow('corrupt')
    expect(activityReportSchema.safeParse({ ...report, actor: 'private' }).success).toBe(false)
    expect(activityReportSchema.safeParse({ ...report, runs: { ...report.runs, total: 0 } }).success).toBe(false)
    expect(() => createActivityReport('sqlite', [], Array(ACTIVITY_LIMITS.runs + 1).fill(run))).toThrow('limit')
  })
  it('preserves valid SQLite exact case-sensitive keys and deterministically orders equal UUID instants', async () => {
    const { runtime } = await fixture(), lower = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', upper = lower.toUpperCase()
    const first = await runtime.run(echo, 'first', { id: lower }), second = await runtime.run(echo, 'second', { id: upper })
    const report = await runtime.activityReport()
    expect(report.runs.total).toBe(2)
    const tied = [{ ...metadata(), id: lower }, { ...metadata(), id: upper }]
    expect(createActivityReport('sqlite', [], tied).runs.firstRetainedRun?.id).toBe(upper)
    expect(createActivityReport('sqlite', [], tied.toReversed()).runs.firstRetainedRun?.id).toBe(upper)
    expect((await runtime.show(lower)).id).toBe(first.id); expect((await runtime.show(upper)).id).toBe(second.id)
  })
  it('awaits the strict empty-field operation and rejects attempted authority/private/selection widening', async () => {
    const { runtime } = await fixture(), spy = vi.spyOn(runtime, 'activityReport')
    expect(await dispatchOperation({ storage: 'sqlite', runtime }, { operation: 'activity.report' }, 'PRIVATE_ACTOR')).toMatchObject({ projects: { total: 0 } })
    expect(spy).toHaveBeenCalledExactlyOnceWith()
    for (const field of ['actor', 'privatePayloads', 'runs', 'execute', 'billing', 'namespace']) {
      await expect(dispatchOperation({ storage: 'sqlite', runtime }, { operation: 'activity.report', [field]: true }, 'PRIVATE_ACTOR')).rejects.toHaveProperty('code', 'invalid-command')
    }
    expect(spy).toHaveBeenCalledTimes(1)
    for (const storage of ['sqlite', 'postgres'] as const) expect(operationCapabilities(storage).activity).toMatchObject({ coherent: true, billing: false, execution: false })
  })
  it('uses direct local CLI report and validates command/target syntax before opening state', async () => {
    const { runtime, dataDirectory } = await fixture(); await runtime.run(echo, 'PRIVATE_CLI'); await runtime.close()
    const result = await cli('activity', 'report', '--data-dir', dataDirectory, '--json')
    expect(result.exit).toBe(0); expect(result.out.runs.total).toBe(1); expect(JSON.stringify(result)).not.toContain('PRIVATE_CLI')
    const open = vi.spyOn(LocalRuntime, 'open')
    for (const args of [['activity', 'wrong'], ['activity', 'report', '--execute'], ['activity', 'report', 'extra'],
      ['activity', 'report', '--runtime', 'docker', '--data-dir', '/not-read']]) expect((await cli(...args)).exit).toBe(2)
    expect(open).not.toHaveBeenCalled()
  })
})

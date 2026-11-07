import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SQLiteNotificationStore, initializeNotificationTables } from '../src/notifications/sqlite-store.ts'
import { inspectNotificationRecord, notificationSha256, type NotificationRecord } from '../src/notifications/schema.ts'
import { filteredNotificationRecords, notificationPage, inspectNotificationPage, parseNotificationPage } from '../src/notifications/history.ts'
import { projectNotificationRecords } from '../src/notifications/project-history.ts'
import { releaseNotificationPage } from '../src/notifications/release-history.ts'
import { LocalRuntime } from '../src/runtime/index.ts'
import { RuntimeClient, startRuntimeService } from '../src/http/index.ts'
import { main } from '../src/cli.ts'

const id = (n: number) => n.toString(16).padStart(8, '0') + '-0000-4000-8000-000000000000'
function record(n: number, kind = 'requested', release?: { id: string; sha256: string }, project?: { id: string; generation: number }) {
  const pin = { runId: randomUUID(), revision: 'a'.repeat(64), attemptId: randomUUID() }
  const core = { source: 'urn:jevable:workflow-runtime', type: 'ai.jevable.approval.' + kind, time: '2026-10-01T00:00:00.000Z',
    data: { ...pin, nodeId: 'PRIVATE_REVIEW', expiresAt: '2026-10-02T00:00:00.000Z', ...(release ? { release } : {}), ...(project ? { project } : {}) } }
  const event = { specversion: '1.0', id: notificationSha256(core), source: core.source, type: core.type,
    time: core.time, datacontenttype: 'application/json', data: core.data }
  return inspectNotificationRecord({ schemaVersion: 1, request: { ...pin, requestId: id(n), endpointId: 'review', endpointSha256: 'b'.repeat(64),
    eventSha256: notificationSha256(event), ...(kind === 'requested' ? {} : { eventKind: kind }) }, event, actor: 'PRIVATE_ACTOR',
    createdAt: '2026-10-01T01:00:00.000Z', credentialGeneration: 1, outcome: { status: 'pending' } })
}
const noRead = { get() { throw Error('unexpected read') }, page() { throw Error('unexpected page') } }
describe('read-only notification metadata filters', () => {
  it.each([{}, { outcome: 'settled' }, { eventKind: 'approved' }, { actor: 'someone' }, { outcome: null },
    { createdFrom: '2026-10-01T00:00:00Z' }, { createdBefore: '2026-10-01T00:00:00.000+00:00' },
    { createdFrom: '2026-10-02T00:00:00.000Z', createdBefore: '2026-10-01T00:00:00.000Z' },
    { createdFrom: '2026-10-01T00:00:00.000Z', createdBefore: '2026-10-01T00:00:00.000Z' }, { outcome: undefined }])
    ('rejects invalid filters before any storage read: %j', async filter => {
      await expect(filteredNotificationRecords(noRead, { filter } as never)).rejects.toHaveProperty('code', 'invalid-command')
    })
  it('normalizes optional undefined keys without changing unfiltered requests or pages', () => {
    expect(parseNotificationPage({})).toEqual({ limit: 100 })
    expect(parseNotificationPage({ filter: { outcome: 'pending', eventKind: undefined } })).toEqual({ limit: 100, filter: { outcome: 'pending' } })
    expect(notificationPage([], null, {})).not.toHaveProperty('filter')
  })
  it('selects sparse outcomes across bounded SQLite batches with matching cursors and no writes', async () => {
    const db = new DatabaseSync(':memory:'); initializeNotificationTables(db)
    const store = new SQLiteNotificationStore(db, { maxDeliveries: 1000, maxEvents: 2000 }), selected: NotificationRecord[] = []
    try {
      for (let n = 0; n < 407; n++) {
        const r = record(n); store.createIntent(r)
        const result = { status: [0, 203, 406].includes(n) ? 'accepted' : 'rejected', httpStatus: [0, 203, 406].includes(n) ? 202 : 409 }
        const settled = inspectNotificationRecord({ ...r, outcome: { status: 'settled', at: '2026-10-01T01:00:01.000Z', result } })
        store.settle(settled); if (result.status === 'accepted') selected.push(settled)
      }
      const before = db.prepare('SELECT total_changes() AS n').get(), filter = { outcome: 'accepted' as const }
      const first = await filteredNotificationRecords(store, { filter, limit: 2 })
      expect(first).toEqual({ records: selected.slice(0, 2), nextCursor: id(203) })
      expect(await filteredNotificationRecords(store, { filter, limit: 2, after: first.nextCursor! })).toEqual({ records: selected.slice(2), nextCursor: null })
      await expect(filteredNotificationRecords(store, { filter, after: id(1) })).rejects.toHaveProperty('code', 'not-found')
      expect(() => store.page({ filter })).toThrow()
      const page = notificationPage(first.records, first.nextCursor, { filter, limit: 2 })
      expect(inspectNotificationPage(page, { filter, limit: 2 })).toEqual(page)
      expect(JSON.stringify(page)).not.toMatch(/PRIVATE_|credentialGeneration|actor|event"/)
      expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before)
    } finally { db.close() }
  })
  it('composes exact project/release scope with event kind and inclusive/exclusive creation bounds', async () => {
    const release = { id: randomUUID(), sha256: 'c'.repeat(64) }, project = { id: randomUUID(), generation: 2 }, rows = [record(1, 'requested', release, project), record(2, 'decided', release, project), record(3, 'decided')]
    const reader = { get: (id: string) => rows.find(r => r.request.requestId === id), page: () => ({ records: rows, nextCursor: null }) }
    const filter = { eventKind: 'decided' as const, createdFrom: rows[1]!.createdAt, createdBefore: '2026-10-01T01:00:00.001Z' }
    const expected = { records: [rows[1]], nextCursor: null }
    expect(await projectNotificationRecords(reader, { ...project, revision: 'a'.repeat(64) }, { filter })).toEqual(expected)
    expect(await releaseNotificationPage(reader, { ...release, revision: 'a'.repeat(64) }, { filter })).toEqual(expected)
    expect(await filteredNotificationRecords(reader, { filter: { createdBefore: rows[0]!.createdAt } })).toEqual({ records: [], nextCursor: null })
    await expect(releaseNotificationPage(reader, { ...release, revision: 'a'.repeat(64) }, { filter, after: id(3) })).rejects.toHaveProperty('code', 'not-found')
  })
  it.each(['omit-filter', 'changed-filter', 'wrong-outcome', 'wrong-kind', 'outside-time'])('refuses untrusted filtered replies: %s', damage => {
    const filter = { outcome: 'pending' as const, eventKind: 'requested' as const, createdFrom: '2026-10-01T01:00:00.000Z' }
    const page = notificationPage([record(1)], null, { filter })
    if (damage === 'omit-filter') delete page.filter
    if (damage === 'changed-filter') page.filter = { outcome: 'accepted' }
    if (damage === 'wrong-outcome') page.deliveries[0]!.outcome = { status: 'settled', at: '2026-10-01T01:00:01.000Z', result: { status: 'accepted', httpStatus: 202 } }
    if (damage === 'wrong-kind') page.deliveries[0]!.request.eventKind = 'decided'
    if (damage === 'outside-time') page.deliveries[0]!.createdAt = '2026-10-01T00:59:59.999Z'
    expect(() => inspectNotificationPage(page, { filter })).toThrow()
  })
  it('uses delivery creation time rather than historical approval event time', async () => {
    const row = record(1), reader = { get: () => row, page: () => ({ records: [row], nextCursor: null }) }
    expect((await filteredNotificationRecords(reader, { filter: { createdFrom: row.createdAt } })).records).toEqual([row])
  })
  it('refuses a mismatched stored cursor identity, not just its matching attributes', async () => {
    const row = record(1), reader = { get: () => row, page: noRead.page }
    await expect(filteredNotificationRecords(reader, { after: id(2), filter: { outcome: 'pending' } })).rejects.toHaveProperty('code', 'corrupt')
  })
  it('makes a changed live outcome invalidate a prior cursor rather than inventing snapshot stability', async () => {
    const row = record(1), changed = inspectNotificationRecord({ ...row, outcome: { status: 'settled', at: '2026-10-01T01:00:01.000Z', result: { status: 'accepted', httpStatus: 202 } } })
    await expect(filteredNotificationRecords({ get: () => changed, page: noRead.page }, { after: id(1), filter: { outcome: 'pending' } })).rejects.toHaveProperty('code', 'not-found')
  })
  it.each([['--outcome', 'settled'], ['--event-kind', 'approved'], ['--created-from', 'bad'], ['--created-before', '2026-10-01T00:00:00Z']])
    ('CLI rejects invalid %s before unavailable storage', async (flag, value) => {
      let output = ''; expect(await main(['approvals', 'notify', 'list', '--page', flag, value, '--data-dir', '/unavailable/notification-filter-state', '--json'], { out: s => output += s, err: s => output += s })).toBe(2)
      expect(JSON.parse(output)).toMatchObject({ status: 'error', code: 'invalid-input' })
    })
  it('reads real retained accepted/rejected/uncertain deliveries through SDK, CLI and authenticated API without sends', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-notification-filter-')), yaml = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
    let received = 0, outcome: 'accepted' | 'rejected' | 'uncertain' = 'accepted'
    const receiver = createServer((req, res) => { received++; req.resume(); if (outcome === 'uncertain') res.destroy(); else { res.writeHead(outcome === 'accepted' ? 202 : 409); res.end() } })
    await new Promise<void>(yes => receiver.listen(0, '127.0.0.1', yes)); const address = receiver.address(); if (!address || typeof address === 'string') throw Error('address')
    const endpoint = { id: 'review', url: `http://127.0.0.1:${address.port}`, credentialRef: 'review/key', timeoutMs: 1000 }
    let runtime: LocalRuntime | undefined, service: Awaited<ReturnType<typeof startRuntimeService>> | undefined
    try {
      runtime = await LocalRuntime.open({ dataDirectory, notifications: { endpoints: [endpoint] } }); runtime.setCredential(endpoint.credentialRef, 'whsec_' + randomBytes(32).toString('base64'), 0, 'fixture')
      const project = runtime.editProject({ operation: 'create', id: randomUUID(), title: 'Filter', yaml, actor: 'fixture' }), pin = { id: project.id, generation: project.generation, revision: project.acceptedRevision }, runs = []
      for (const selected of ['accepted', 'rejected', 'uncertain'] as const) {
        outcome = selected; const run = await runtime.runProject(project.id, project.generation, project.acceptedRevision, { message: 'PRIVATE_REVIEW' }); runs.push(run)
        if (run.state.status !== 'waiting') throw Error('wait')
        const { event: _event, delivery: _delivery, ...request } = await runtime.prepareApprovalNotification({ runId: run.id, revision: run.revision, attemptId: run.state.attempt.id }, endpoint.id)
        const delivery = await runtime.sendApprovalNotification({ ...request, requestId: randomUUID() }, 'fixture'); expect(delivery.outcome).toMatchObject({ status: 'settled', result: { status: selected } })
      }
      const events = await Promise.all(runs.map(r => runtime!.events(r.id))), sends = received
      const page = await runtime.listProjectApprovalNotifications(pin, { filter: { outcome: 'accepted' } }); expect(page.deliveries).toHaveLength(1)
      for (const selected of ['accepted', 'rejected', 'uncertain'] as const) expect((await runtime.listApprovalNotifications({ filter: { outcome: selected } })).deliveries).toHaveLength(1)
      expect((await runtime.listApprovalNotifications({ filter: { outcome: 'pending' } })).deliveries).toEqual([])
      await runtime.close(); runtime = undefined
      let output = ''; const code = await main(['approvals', 'notify', 'list', '--page', '--outcome', 'accepted', '--project-id', pin.id, '--generation', String(pin.generation), '--revision', pin.revision, '--data-dir', dataDirectory, '--json'], { out: s => output += s, err: s => output += s }); expect(code).toBe(0); expect(JSON.parse(output)).toEqual(page)
      const token = randomBytes(32).toString('hex')
      service = await startRuntimeService({ runtime: { dataDirectory }, token, actor: 'fixture' })
      const client = new RuntimeClient(service.url, token)
      const response = await client.operation({ operation: 'notifications.project-list', project: pin, page: { filter: { outcome: 'accepted' } } }) as { result: unknown }
      expect(response.result).toEqual(page); expect(received).toBe(sends)
      await service.close(); service = undefined; runtime = await LocalRuntime.open({ dataDirectory })
      expect(await Promise.all(runs.map(r => runtime!.events(r.id)))).toEqual(events)
      expect(await Promise.all(runs.map(r => runtime!.show(r.id)))).toEqual(runs)
    } finally { await service?.close(); await runtime?.close(); await new Promise<void>(yes => { receiver.closeIdleConnections(); receiver.close(() => yes()) }) }
  })
})

import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { SQLiteNotificationStore, initializeNotificationTables } from '../src/notifications/sqlite-store.ts'
import { inspectNotificationRecord, notificationSha256, type NotificationRecord } from '../src/notifications/schema.ts'
import { notificationPage, inspectNotificationPage } from '../src/notifications/history.ts'
import { releaseNotificationPage } from '../src/notifications/release-history.ts'

function record(id: string = randomUUID()): NotificationRecord {
  const pin = { runId: randomUUID(), revision: 'a'.repeat(64), attemptId: randomUUID() }
  const core = { source: 'urn:jevable:workflow-runtime', type: 'ai.jevable.approval.requested', time: '2026-10-01T00:00:00.000Z',
    data: { ...pin, nodeId: 'PRIVATE_NODE_' + 'n'.repeat(4000), expiresAt: '2026-10-02T00:00:00.000Z' } }
  const event = { specversion: '1.0', id: notificationSha256(core), source: core.source, type: core.type,
    time: core.time, datacontenttype: 'application/json', data: core.data }
  return inspectNotificationRecord({ schemaVersion: 1, request: { ...pin, requestId: id, endpointId: 'review',
    endpointSha256: 'b'.repeat(64), eventSha256: notificationSha256(event) }, event, actor: 'PRIVATE_ACTOR',
  createdAt: '2026-10-01T01:00:00.000Z', credentialGeneration: 1, outcome: { status: 'pending' } })
}
function fixture() {
  const db = new DatabaseSync(':memory:'); initializeNotificationTables(db)
  const store = new SQLiteNotificationStore(db, { maxDeliveries: 1000, maxEvents: 2000 })
  return { db, store }
}
describe('bounded notification history pages', () => {
  it('filters across foreign batches and exposes only exact-release cursors without writes', async () => {
    const { db, store } = fixture(), release = { id: randomUUID(), sha256: 'c'.repeat(64), revision: 'a'.repeat(64) }
    const selected: NotificationRecord[] = [], foreign: NotificationRecord[] = []
    try {
      for (let i = 0; i < 407; i++) {
        let r = record(i.toString(16).padStart(8, '0') + '-0000-4000-8000-000000000000')
        if ([0, 203, 406].includes(i)) {
          const { revision: _revision, ...pin } = release, data = { ...r.event.data, release: pin }
          const core = { source: r.event.source, type: r.event.type, time: r.event.time, data }
          const event = { ...r.event, ...core, id: notificationSha256(core) }
          r = inspectNotificationRecord({ ...r, event, request: { ...r.request, eventSha256: notificationSha256(event) } })
          selected.push(r)
        } else foreign.push(r)
        store.createIntent(r)
      }
      const before = db.prepare('SELECT total_changes() AS n').get()
      const first = await releaseNotificationPage(store, release, { limit: 2 })
      expect(first).toEqual({ records: selected.slice(0, 2), nextCursor: selected[1]!.request.requestId })
      const second = await releaseNotificationPage(store, release, { after: first.nextCursor!, limit: 2 })
      expect(second).toEqual({ records: selected.slice(2), nextCursor: null })
      for (const scope of [{ ...release, id: randomUUID() }, { ...release, sha256: 'd'.repeat(64) }, { ...release, revision: 'e'.repeat(64) }])
        expect(await releaseNotificationPage(store, scope, {})).toEqual({ records: [], nextCursor: null })
      await expect(releaseNotificationPage(store, release, { after: foreign[0]!.request.requestId })).rejects.toHaveProperty('code', 'not-found')
      await expect(releaseNotificationPage(store, release, { after: randomUUID() })).rejects.toHaveProperty('code', 'not-found')
      expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before)
    } finally { db.close() }
  })
  it('refuses malformed release scope before touching storage', async () => {
    const reader = { get: () => { throw Error('unexpected read') }, page: () => { throw Error('unexpected page') } }
    await expect(releaseNotificationPage(reader, { id: randomUUID(), sha256: 'bad', revision: 'a'.repeat(64) }, {}))
      .rejects.toHaveProperty('code', 'invalid-command')
  })
  it('uses indexed keyset pages across 205 receipts without payload leakage, offset scans or writes', () => {
    const { db, store } = fixture()
    try {
      const records = Array.from({ length: 205 }, () => record()).sort((a, b) => a.request.requestId < b.request.requestId ? -1 : 1)
      for (const r of [...records].reverse()) store.createIntent(r)
      const before = db.prepare('SELECT total_changes() AS n').get()
      const a = store.page({ limit: 200 }), b = store.page({ after: a.nextCursor!, limit: 200 })
      expect(a.records).toHaveLength(200); expect(b.records).toHaveLength(5); expect(b.nextCursor).toBeNull()
      expect([...a.records, ...b.records]).toEqual(records)
      const summary = notificationPage(a.records, a.nextCursor, { limit: 200 })
      expect(JSON.stringify(summary)).not.toMatch(/PRIVATE_|credentialGeneration|actor|event"/)
      expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(200_000)
      expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before)
      const plan = db.prepare('EXPLAIN QUERY PLAN SELECT id,event_sha256,endpoint_id,record FROM approval_deliveries WHERE id>? ORDER BY id LIMIT ?')
        .all(a.nextCursor!, 201)
      expect(JSON.stringify(plan)).toContain('USING INDEX sqlite_autoindex_approval_deliveries_1 (id>?)')
      expect(JSON.stringify(plan)).not.toMatch(/SCAN approval_deliveries|TEMP B-TREE/)
    } finally { db.close() }
  })
  it('makes live insertion behavior explicit: identities before a cursor require a new traversal', () => {
    const { db, store } = fixture()
    try {
      const low = record('10000000-0000-4000-8000-000000000000'), middle = record('50000000-0000-4000-8000-000000000000'), high = record('f0000000-0000-4000-8000-000000000000')
      store.createIntent(middle); store.createIntent(high)
      const a = store.page({ limit: 1 }); store.createIntent(low)
      expect(store.page({ after: a.nextCursor!, limit: 1 }).records).toEqual([high])
      expect(store.page({}).records).toEqual([low, middle, high])
      expect(() => store.page({ after: randomUUID() })).toThrow()
    } finally { db.close() }
  })
  it.each([0, -1, 201, 1.5, NaN])('refuses invalid limit %s before reading', limit => {
    const { db, store } = fixture()
    try { expect(() => store.page({ limit })).toThrow() } finally { db.close() }
  })
  it('does not decode an unselected corrupt record and refuses it when reached', () => {
    const { db, store } = fixture()
    try {
      const first = record('10000000-0000-4000-8000-000000000000'), last = record('f0000000-0000-4000-8000-000000000000')
      store.createIntent(first); store.createIntent(last)
      db.prepare('UPDATE approval_deliveries SET record=? WHERE id=?').run('{}', last.request.requestId)
      expect(store.page({ limit: 1 }).records).toEqual([first])
      expect(() => store.page({ after: first.request.requestId })).toThrow()
    } finally { db.close() }
  })
  it.each(['reversed', 'duplicate', 'over-limit', 'cursor', 'empty-cursor', 'private-field', 'backwards-time'])('refuses malformed remote pages: %s', damage => {
    const records = [record(), record()].sort((a, b) => a.request.requestId < b.request.requestId ? -1 : 1)
    const page = notificationPage(records, null, { limit: 2 })
    let limit = 2
    if (damage === 'reversed') page.deliveries.reverse()
    if (damage === 'duplicate') page.deliveries[1] = page.deliveries[0]!
    if (damage === 'over-limit') limit = 1
    if (damage === 'cursor') page.nextCursor = randomUUID()
    if (damage === 'empty-cursor') { page.deliveries = []; page.nextCursor = randomUUID() }
    if (damage === 'private-field') Object.assign(page.deliveries[0]!, { actor: 'private' })
    if (damage === 'backwards-time') page.deliveries[0]!.outcome = { status: 'settled', at: '2026-09-01T00:00:00.000Z', result: { status: 'accepted', httpStatus: 202 } }
    expect(() => inspectNotificationPage(page, { limit })).toThrow()
  })
})

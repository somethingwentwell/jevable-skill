import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PostgresJournal, type JournalBatch } from '../src/storage/postgres.ts'
import { journalConditionHash, parseJournalConditions, checkJournalConditionTime, type JournalConditions } from '../src/storage/conditions.ts'

const at = '2026-10-01T00:00:00.000Z', expiresAt = '2026-10-01T00:00:10.000Z'
afterEach(() => vi.useRealTimers())

/** Executes the actual journal transaction code against a query double; NOT real SQL/locking/durability qualification. */
class QueryClient {
  readonly ownerId = randomUUID()
  readonly queries: string[] = []
  readonly rows = new Map<string, { version: string; deleted: boolean; value: unknown }>()
  readonly receipts = new Map<string, { request_sha256: string; receipt: string }>()
  readonly events: unknown[] = []
  hook?: (sql: string) => void | Promise<void>
  transaction: { rows: Map<string, { version: string; deleted: boolean; value: unknown }>;
    receipts: Map<string, { request_sha256: string; receipt: string }>; events: unknown[] } | undefined
  ended = false
  on() {}
  async end() { this.ended = true }
  key(collection: string, key: string) { return JSON.stringify([collection, key]) }
  async query(sql: string, args: any[] = []) {
    this.queries.push(sql); await this.hook?.(sql)
    if (sql === 'BEGIN') { this.transaction = { rows: structuredClone(this.rows), receipts: structuredClone(this.receipts), events: structuredClone(this.events) }; return { rows: [] } }
    if (sql === 'COMMIT') { this.transaction = undefined; return { rows: [] } }
    if (sql === 'ROLLBACK') {
      if (this.transaction) { this.rows.clear(); this.receipts.clear(); this.events.splice(0)
        for (const [key, value] of this.transaction.rows) this.rows.set(key, value)
        for (const [key, value] of this.transaction.receipts) this.receipts.set(key, value)
        this.events.push(...this.transaction.events); this.transaction = undefined }
      return { rows: [] }
    }
    if (sql.startsWith('SELECT owner_id,epoch')) return { rows: [{ owner_id: this.ownerId, epoch: '1' }] }
    if (sql.startsWith('SELECT 1 FROM jevable_journal.records')) return { rows: this.rows.has(this.key(args[1], args[2])) ? [{}] : [] }
    if (sql.startsWith('SELECT key FROM jevable_journal.records')) {
      const row = this.rows.get(this.key('runs', args[1])), value = row?.value as any, run = value?.record
      const matches = row && !row.deleted && value?.format === 'jevable.pg-run/v1' && run?.caller?.grantId === args[2]
        && run?.release?.id === args[3] && run.release.sha256 === args[4] && run.revision === args[5]
      return { rows: matches ? [{ key: args[1] }] : [] }
    }
    if (sql.startsWith('SELECT version,deleted,CASE')) {
      const row = this.rows.get(this.key(args[1], args[2]))
      return { rows: row ? [{ ...row, value: row.deleted ? null : JSON.stringify(row.value), bytes: row.deleted ? null : Buffer.byteLength(JSON.stringify(row.value)) }] : [] }
    }
    if (sql.startsWith('SELECT CASE WHEN octet_length(receipt)')) return { rows: this.receipts.has(args[1]) ? [structuredClone(this.receipts.get(args[1]))] : [] }
    if (sql.includes('(SELECT count(*)::int')) return { rows: [{ records: this.rows.size, events: this.events.length, batches: this.receipts.size }] }
    if (sql.startsWith('SELECT version,deleted FROM')) {
      const row = this.rows.get(this.key(args[1], args[2])); return { rows: row ? [{ version: row.version, deleted: row.deleted }] : [] }
    }
    if (sql.startsWith('INSERT INTO jevable_journal.records')) {
      this.rows.set(this.key(args[1], args[2]), { version: args[3], deleted: args[4], value: args[5] === null ? null : JSON.parse(args[5]) }); return { rows: [] }
    }
    if (sql.startsWith('INSERT INTO jevable_journal.batches')) { this.receipts.set(args[1], { request_sha256: args[2], receipt: '{}' }); return { rows: [] } }
    if (sql.startsWith('INSERT INTO jevable_journal.events')) { this.events.push(args); return { rows: [{ sequence: String(this.events.length) }] } }
    if (sql.startsWith('SELECT clock_timestamp')) return { rows: [{ at }] }
    if (sql.startsWith('UPDATE jevable_journal.batches')) { this.receipts.get(args[1])!.receipt = args[2]; return { rows: [] } }
    throw Error('Unexpected query in journal guard fixture')
  }
}
function fixture() {
  vi.setSystemTime(at)
  const client = new QueryClient(), grantId = randomUUID(), targetId = randomUUID(), runId = randomUUID(), value = { scope: 'exact retained fixture' }
  client.rows.set(client.key('access-grants', grantId), { version: '1', deleted: false, value })
  client.rows.set(client.key('releases', targetId), { version: '1', deleted: false, value: { revision: 'a'.repeat(64) } })
  // Constructor injection is confined to this source test; no production API or fixture mode is added.
  const journal = Reflect.construct(PostgresJournal, [client, { namespace: 'fixture', maxRecordBytes: 4_000_000, maxBatchBytes: 8_000_000,
    maxRecords: 10000, maxEvents: 10000, maxBatches: 10000 }]) as PostgresJournal
  Reflect.set(journal, 'state', 'open'); Reflect.set(journal, 'epoch', '1'); Reflect.set(journal, 'ownerId', client.ownerId)
  const batch: JournalBatch = { id: randomUUID(), changes: [{ operation: 'put', collection: 'runs', key: runId, expectedVersion: '0', value: { fixture: 'mutation' } }],
    events: [{ collection: 'runs', key: runId, kind: 'run-created', data: { fixture: 'evidence' } }] }
  const conditions: JournalConditions = { records: [
    { collection: 'access-grants', key: grantId, version: '1', sha256: journalConditionHash(value) },
    { collection: 'releases', key: targetId, version: '1', sha256: journalConditionHash({ revision: 'a'.repeat(64) }) },
  ], notBefore: at, expiresAt }
  return { client, journal, batch, conditions, grantId, targetId, runId }
}
describe('journal admission conditions', () => {
  it('hashes canonical snapshots without depending on object key order', () => {
    expect(journalConditionHash({ b: [1, { y: true, x: null }], a: 2 })).toBe(journalConditionHash({ a: 2, b: [1, { x: null, y: true }] }))
    expect(journalConditionHash({ a: [1, 2] })).not.toBe(journalConditionHash({ a: [2, 1] }))
  })
  it.each(['empty', 'duplicate', 'past', 'unsupported-collection', 'unknown-key', 'bad-version', 'bad-hash'] as const)('strictly refuses %s conditions', damage => {
    const f = fixture(), value: any = structuredClone(f.conditions)
    if (damage === 'empty') value.records = []
    if (damage === 'duplicate') value.records.push(value.records[0])
    if (damage === 'past') value.expiresAt = at
    if (damage === 'unsupported-collection') value.records[0].collection = 'provider-credentials'
    if (damage === 'unknown-key') value.actor = 'forged'
    if (damage === 'bad-version') value.records[0].version = '0'
    if (damage === 'bad-hash') value.records[0].sha256 = 'not-a-hash'
    expect(() => parseJournalConditions(value)).toThrowError(expect.objectContaining({ code: 'invalid-command' }))
  })
  it('checks inclusive expiry, rollback and invalid dates without accepting a stale admission timestamp', () => {
    const f = fixture(); expect(() => checkJournalConditionTime(f.conditions, at)).not.toThrow()
    for (const time of [expiresAt, '2026-09-30T23:59:59.999Z', 'invalid'])
      expect(() => checkJournalConditionTime(f.conditions, time)).toThrowError(expect.objectContaining({ code: 'conflict' }))
  })
  it('commits guarded snapshots/events/receipt and preserves unguarded mutation identity on exact retry', async () => {
    const f = fixture(), receipt = await f.journal.commit(f.batch, f.conditions)
    expect(receipt.changes).toEqual([{ collection: 'runs', key: f.runId, version: '1', deleted: false }])
    expect(f.client.events).toHaveLength(1); expect(await f.journal.commit(f.batch)).toEqual(receipt)
    expect(await f.journal.commit(f.batch, f.conditions)).toEqual(receipt)
    expect(f.client.events).toHaveLength(1); expect(f.journal.status().state).toBe('open'); await f.journal.close()
  })
  it.each(['missing', 'deleted', 'version', 'snapshot', 'target-version', 'expired', 'rollback'] as const)(
    'refuses %s before mutation and retains the journal owner', async damage => {
      const f = fixture(), grant = f.client.rows.get(f.client.key('access-grants', f.grantId))!
      if (damage === 'missing') f.client.rows.delete(f.client.key('access-grants', f.grantId))
      if (damage === 'deleted') grant.deleted = true
      if (damage === 'version') grant.version = '2'
      if (damage === 'snapshot') grant.value = { scope: 'changed without a version bump' }
      if (damage === 'target-version') f.client.rows.get(f.client.key('releases', f.targetId))!.version = '2'
      if (damage === 'expired') vi.setSystemTime(expiresAt)
      if (damage === 'rollback') vi.setSystemTime('2026-09-30T23:59:59.999Z')
      const before = structuredClone(f.client.rows)
      await expect(f.journal.commit(f.batch, f.conditions)).rejects.toHaveProperty('code', 'conflict')
      expect(f.client.rows).toEqual(before); expect(f.client.receipts.size).toBe(0); expect(f.client.events).toEqual([])
      expect(f.client.queries.some(q => q.startsWith('INSERT'))).toBe(false)
      expect(f.client.queries.at(-1)).toBe('ROLLBACK'); expect(f.journal.status().state).toBe('open'); await f.journal.close()
    })
  it('does not return a retained receipt after grant revocation or expiry', async () => {
    const f = fixture(), receipt = await f.journal.commit(f.batch, f.conditions)
    const grant = f.client.rows.get(f.client.key('access-grants', f.grantId))!
    grant.version = '2'
    await expect(f.journal.commit(f.batch, f.conditions)).rejects.toHaveProperty('code', 'conflict')
    grant.version = '1'; vi.setSystemTime(expiresAt)
    await expect(f.journal.commit(f.batch, f.conditions)).rejects.toHaveProperty('code', 'conflict')
    expect(f.client.events).toHaveLength(1); expect(await f.journal.commit(f.batch)).toEqual(receipt); await f.journal.close()
  })
  it('checks expiry after waiting behind an earlier transaction, rather than at enqueue time', async () => {
    const f = fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let held = false
    f.client.hook = async sql => { if (sql.startsWith('SELECT owner_id') && !held) { held = true; entered.resolve(); await release.promise } }
    const prior = f.journal.health(); await entered.promise
    const attempt = f.journal.commit(f.batch, f.conditions), refused = expect(attempt).rejects.toHaveProperty('code', 'conflict')
    vi.setSystemTime(expiresAt); release.resolve(); await prior; await refused
    expect(f.client.events).toHaveLength(0); await f.journal.close()
  })
  it.each(['snapshot', 'receipt', 'capacity', 'write-version'] as const)('checks expiry after asynchronous %s reads before the first mutation', async phase => {
    const f = fixture()
    f.client.hook = sql => {
      const match = phase === 'snapshot' ? sql.startsWith('SELECT version,deleted,CASE')
        : phase === 'receipt' ? sql.startsWith('SELECT CASE WHEN octet_length(receipt)')
          : phase === 'capacity' ? sql.includes('(SELECT count(*)::int') : sql.startsWith('SELECT version,deleted FROM')
      if (match) vi.setSystemTime(expiresAt)
    }
    await expect(f.journal.commit(f.batch, f.conditions)).rejects.toHaveProperty('code', 'conflict')
    expect(f.client.queries.some(q => q.startsWith('INSERT'))).toBe(false); expect(f.journal.status().state).toBe('open'); await f.journal.close()
  })
  it('detaches guard input before queueing and never lets an expired retry bypass receipt authorization', async () => {
    const f = fixture(), original = structuredClone(f.conditions), attempt = f.journal.commit(f.batch, f.conditions)
    f.conditions.records.splice(0); f.conditions.expiresAt = '2030-01-01T00:00:00.000Z'
    await attempt; vi.setSystemTime(expiresAt)
    await expect(f.journal.commit(f.batch, original)).rejects.toHaveProperty('code', 'conflict'); await f.journal.close()
  })
  it('preserves rollback and uncertain commit semantics for guarded writes', async () => {
    const f = fixture()
    f.client.hook = sql => { if (sql === 'COMMIT') throw Error('Lost acknowledgment fixture') }
    await expect(f.journal.commit(f.batch, f.conditions)).rejects.toHaveProperty('code', 'commit-uncertain')
    expect(f.journal.status().state).toBe('lost'); expect(f.client.ended).toBe(true)
    expect(f.client.queries.at(-1)).toBe('COMMIT'); await f.journal.close()
  })
})

describe('caller journal selector (query double, not SQL qualification)', () => {
  function callerFixture() {
    const f = fixture(), pin = { id: f.runId, grantId: f.grantId, release: { id: f.targetId, sha256: 'b'.repeat(64), revision: 'a'.repeat(64) } }
    const value = { format: 'jevable.pg-run/v1', record: { caller: { grantId: f.grantId }, release: { id: f.targetId, sha256: pin.release.sha256 }, revision: pin.release.revision, input: 'private' } }
    f.client.rows.set(f.client.key('runs', f.runId), { version: '1', deleted: false, value })
    return { ...f, pin, value }
  }
  it('loads matching private bytes only after identity selection in the same owner transaction', async () => {
    const f = callerFixture(), result = await f.journal.callerRun(f.pin)
    expect(result?.value).toEqual(f.value)
    expect(f.client.queries.filter(q => q === 'BEGIN')).toHaveLength(1)
    const select = f.client.queries.findIndex(q => q.startsWith('SELECT key FROM')), payload = f.client.queries.findIndex(q => q.startsWith('SELECT version,deleted,CASE'))
    expect(select).toBeGreaterThan(0); expect(payload).toBeGreaterThan(select); expect(f.client.queries.at(-1)).toBe('COMMIT')
    await f.journal.close()
  })
  it.each(['missing', 'deleted', 'grant', 'release', 'hash', 'revision', 'malformed'] as const)('refuses %s without loading a private payload', async damage => {
    const f = callerFixture(), row = f.client.rows.get(f.client.key('runs', f.runId))!
    if (damage === 'missing') f.client.rows.delete(f.client.key('runs', f.runId))
    if (damage === 'deleted') row.deleted = true
    if (damage === 'grant') f.pin.grantId = randomUUID()
    if (damage === 'release') f.pin.release.id = randomUUID()
    if (damage === 'hash') f.pin.release.sha256 = 'c'.repeat(64)
    if (damage === 'revision') f.pin.release.revision = 'c'.repeat(64)
    if (damage === 'malformed') row.value = 'not-an-envelope'
    expect(await f.journal.callerRun(f.pin)).toBeUndefined()
    expect(f.client.queries.some(q => q.startsWith('SELECT version,deleted,CASE'))).toBe(false)
    expect(f.journal.status().state).toBe('open'); await f.journal.close()
  })
  it('reports a retained deleted identity without decoding its payload', async () => {
    const f = callerFixture(); f.client.rows.get(f.client.key('runs', f.runId))!.deleted = true
    expect(await f.journal.exists('runs', f.runId)).toBe(true)
    expect(await f.journal.exists('runs', randomUUID())).toBe(false)
    expect(f.client.queries.some(q => q.startsWith('SELECT version,deleted,CASE'))).toBe(false); await f.journal.close()
  })
})

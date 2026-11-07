import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { SQLiteGrantStore, initializeGrantTables } from '../src/access/sqlite-grants.ts'
import { PostgresGrantStore } from '../src/access/postgres-grants.ts'
import { prepareGrantToken, grantTokenProof, grantPrincipal, grantMetadata, inspectGrant, inspectGrantHistory,
  issueGrantRecord, grantHistory, parseGrantIssue, type GrantIssue, type GrantRecord } from '../src/access/grants.ts'
import { JournalError, type PostgresJournal, type JournalBatch } from '../src/storage/postgres.ts'
import { withDomainWrite } from '../src/storage/domain-owner.ts'

const databases: DatabaseSync[] = []
afterEach(() => { vi.useRealTimers(); for (const db of databases.splice(0)) db.close() })
const at = '2026-01-01T00:00:00.000Z', expiresAt = '2027-01-01T00:00:00.000Z'
function command(): { prepared: ReturnType<typeof prepareGrantToken>; command: GrantIssue } {
  const prepared = prepareGrantToken(randomUUID())
  return { prepared, command: { id: prepared.id, tokenSha256: prepared.tokenSha256, actor: 'owner:fixture', expiresAt,
    scope: { kind: 'caller', release: { id: randomUUID(), revision: 'a'.repeat(64), sha256: 'b'.repeat(64) }, permissions: ['read', 'start'] } } }
}
function sqlite(max = 10000) {
  const db = new DatabaseSync(':memory:'); databases.push(db); db.exec('PRAGMA foreign_keys=ON'); initializeGrantTables(db)
  return { db, store: new SQLiteGrantStore(db, max), records: () => db.prepare('SELECT * FROM access_grants ORDER BY id').all(),
    events: () => db.prepare('SELECT * FROM access_grant_events ORDER BY sequence').all() }
}
function postgres(max = 10000) {
  const abort = new AbortController(), records = new Map<string, { key: string; version: string; value: unknown }>(), events: any[] = [], receipts = new Map<string, unknown>()
  let commits = 0, fail = false
  const journal = { signal: abort.signal,
    get: async (kind: string, key: string) => { expect(kind).toBe('access-grants'); return structuredClone(records.get(key)) },
    count: async (kind: string) => { expect(kind).toBe('access-grants'); return records.size },
    page: async (kind: string, after: string | undefined, limit: number) => {
      expect(kind).toBe('access-grants'); const all = [...records.keys()].sort().filter(k => after === undefined || k > after), selected = all.slice(0, limit)
      return { records: selected.map(k => structuredClone(records.get(k))), nextCursor: all.length > limit ? selected.at(-1) : null }
    },
    events: async (after: string, limit: number, kinds: string[], key?: string) => {
      expect(kinds).toEqual(['access-grants']); const selected = events.filter(e => BigInt(e.sequence) > BigInt(after) && (!key || e.key === key)).slice(0, limit)
      return { events: structuredClone(selected), cursor: selected.at(-1)?.sequence ?? after }
    },
    receipt: async (id: string) => receipts.get(id),
    commit: async (batch: JournalBatch) => {
      if (fail) throw new JournalError('unavailable')
      if (receipts.has(batch.id)) throw new JournalError('conflict')
      for (const c of batch.changes) if ((records.get(c.key)?.version ?? '0') !== c.expectedVersion) throw new JournalError('conflict')
      for (const c of batch.changes) { expect(c.operation).toBe('put'); if (c.operation === 'put') records.set(c.key, { key: c.key, version: String(BigInt(c.expectedVersion) + 1n), value: structuredClone(c.value) }) }
      for (const e of batch.events) events.push({ sequence: String(events.length + 1), key: e.key, kind: e.kind, batchId: batch.id, data: structuredClone(e.data) })
      commits++; receipts.set(batch.id, structuredClone(batch)); return {} as never
    },
  } as unknown as PostgresJournal
  return { journal, records, events, receipts, abort, get commits() { return commits }, fail: () => { fail = true }, store: new PostgresGrantStore(journal, max) }
}
const ignoreScope = () => {}, ignoreAsyncScope = async () => {}

describe('delegated grant token and audit primitives', () => {
  it('uses fresh random opaque values, canonical UUID and ID/domain-bound hashes; metadata carries neither bearer nor digest', () => {
    const id = randomUUID(), a = prepareGrantToken(id.toUpperCase()), b = prepareGrantToken(id)
    expect(a.id).toBe(id); expect(a.token).not.toBe(b.token); expect(a.tokenSha256).not.toBe(b.tokenSha256)
    expect(a.token).toMatch(/^jvg1\.[a-f0-9-]{36}\.[a-f0-9]{64}$/); expect(grantTokenProof(a.token)).toEqual({ id, tokenSha256: a.tokenSha256 })
    const moved = a.token.replace(id, randomUUID()); expect(grantTokenProof(moved)!.tokenSha256).not.toBe(a.tokenSha256)
    vi.setSystemTime(at); const c = command(), r = issueGrantRecord(c.command, at), metadata = grantMetadata(r)
    expect(JSON.stringify(metadata)).not.toContain(c.prepared.token); expect(JSON.stringify(metadata)).not.toContain(c.prepared.tokenSha256)
  })
  it.each(['', 'a'.repeat(64), 'Bearer jvg1.' + 'a'.repeat(100), 'jvg1.' + '0'.repeat(36) + '.' + 'a'.repeat(64), 'jvg2.' + randomUUID() + '.' + 'a'.repeat(64)])('rejects malformed/other-role token syntax: %s', token => {
    expect(grantTokenProof(token)).toBeNull()
  })
  it('treats boundary expiry inclusively, refuses clock rollback/invalid time and does not mutate history or manufacture revocation', () => {
    const c = command(), r = issueGrantRecord(c.command, at), proof = grantTokenProof(c.prepared.token)!
    expect(grantPrincipal(r, proof, at)).toMatchObject({ actor: `grant:${r.id}`, grantId: r.id })
    expect(grantPrincipal(r, proof, expiresAt)).toBeNull(); expect(grantPrincipal(r, proof, 'invalid')).toBeNull()
    expect(grantPrincipal(r, proof, '2025-12-31T23:59:59.999Z')).toBeNull()
    expect(grantMetadata(r, expiresAt)).toMatchObject({ status: 'expired', generation: 1 }); expect(r.revocation).toBeUndefined()
  })
  it('validates exact scope/permissions and rejects raw secrets, actor omissions, past expiry and malformed history', () => {
    const c = command()
    for (const change of [{ token: c.prepared.token }, { actor: '' }, { scope: { ...c.command.scope, permissions: ['read', 'read'] } }, { scope: { kind: 'owner' } }]) {
      expect(() => parseGrantIssue({ ...c.command, ...change })).toThrowError(expect.objectContaining({ code: 'invalid-command' }))
    }
    expect(() => issueGrantRecord({ ...c.command, expiresAt: at }, at)).toThrowError(expect.objectContaining({ code: 'invalid-command' }))
    const r = issueGrantRecord(c.command, at); expect(() => inspectGrantHistory(r, [grantHistory(r)])).not.toThrow()
    expect(() => inspectGrantHistory(r, [])).toThrowError(expect.objectContaining({ code: 'corrupt' }))
    expect(() => inspectGrant({ ...r, generation: 2 })).toThrowError(expect.objectContaining({ code: 'corrupt' }))
  })
})

describe('owned SQLite grant ledger', () => {
  it('issues metadata only, stores no raw bearer, authenticates internal lookup and preserves exact-ID observation after revoke and expiry', () => {
    vi.setSystemTime(at); const f = sqlite(), c = command(), check = vi.fn()
    const issued = f.store.issue(c.command, check); expect(issued).toMatchObject({ generation: 1, status: 'active' }); expect(check).toHaveBeenCalledOnce()
    expect(f.store.lookup(c.prepared.token)).toMatchObject({ grantId: issued.id }); expect(f.store.lookup(prepareGrantToken(issued.id).token)).toBeNull()
    expect(JSON.stringify(f.records())).not.toContain(c.prepared.token); expect(JSON.stringify(f.events())).not.toContain(c.prepared.token)
    const revoke = { id: issued.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:revoke' }
    expect(f.store.revoke(revoke)).toMatchObject({ status: 'revoked', generation: 2 }); expect(f.store.lookup(c.prepared.token)).toBeNull()
    vi.setSystemTime(expiresAt); expect(f.store.issue(c.command, () => { throw Error('Should not regrant or recheck admission') }).status).toBe('revoked')
    expect(f.store.revoke(revoke).generation).toBe(2); expect(f.events()).toHaveLength(2); f.store.validate()
    expect(JSON.stringify(f.store.page())).not.toContain(c.prepared.tokenSha256)
  })
  it('refuses changed issue/revoke identity, shared request IDs and issue IDs used by revocations without partial state', () => {
    vi.setSystemTime(at); const f = sqlite(), a = command(), b = command(); f.store.issue(a.command, ignoreScope); f.store.issue(b.command, ignoreScope)
    for (const change of [{ tokenSha256: 'e'.repeat(64) }, { actor: 'different' }, { expiresAt: '2028-01-01T00:00:00.000Z' }])
      expect(() => f.store.issue({ ...a.command, ...change }, ignoreScope)).toThrowError(expect.objectContaining({ code: 'conflict' }))
    const requestId = randomUUID(), r = { id: a.command.id, requestId, expectedGeneration: 1, actor: 'owner' }; f.store.revoke(r)
    expect(() => f.store.revoke({ ...r, actor: 'other' })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(() => f.store.revoke({ ...r, id: b.command.id })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(() => f.store.issue({ ...command().command, id: requestId }, ignoreScope)).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(f.store.get(b.command.id).generation).toBe(1); expect(f.events()).toHaveLength(3)
  })
  it('rolls back snapshot and audit together on a late write error; failed scope/capacity checks write nothing', () => {
    vi.setSystemTime(at); const f = sqlite(1), c = command()
    expect(() => f.store.issue(c.command, () => { throw Error('scope refused') })).toThrow('scope refused'); expect(f.records()).toEqual([])
    f.db.exec("CREATE TRIGGER reject_grant_event BEFORE INSERT ON access_grant_events BEGIN SELECT RAISE(ABORT,'fixture late error'); END")
    expect(() => f.store.issue(c.command, ignoreScope)).toThrow('fixture late error'); expect(f.records()).toEqual([]); expect(f.events()).toEqual([])
    f.db.exec('DROP TRIGGER reject_grant_event'); f.store.issue(c.command, ignoreScope)
    expect(() => f.store.issue(command().command, ignoreScope)).toThrowError(expect.objectContaining({ code: 'limit' }))
    f.db.exec("CREATE TRIGGER reject_revoke BEFORE INSERT ON access_grant_events BEGIN SELECT RAISE(ABORT,'fixture revoke error'); END")
    expect(() => f.store.revoke({ id: c.command.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner' })).toThrow('fixture revoke error')
    expect(f.store.get(c.command.id).generation).toBe(1); expect(f.events()).toHaveLength(1)
  })
  it.each(['snapshot', 'event', 'generation', 'request', 'null-event'])('fails whole lookup/catalogue/activation on %s corruption', kind => {
    vi.setSystemTime(at); const f = sqlite(), c = command(); f.store.issue(c.command, ignoreScope)
    if (kind === 'snapshot') { const record = JSON.parse(f.records()[0]!.record as string); record.scope.permissions = ['cancel']; f.db.prepare('UPDATE access_grants SET record=?').run(JSON.stringify(record)) }
    if (kind === 'event') f.db.exec("UPDATE access_grant_events SET kind='grant-revoked'")
    if (kind === 'generation') f.db.exec('UPDATE access_grants SET generation=2')
    if (kind === 'request') f.db.prepare('UPDATE access_grant_events SET request_id=?').run(randomUUID())
    if (kind === 'null-event') f.db.exec("UPDATE access_grant_events SET record='null'")
    for (const read of [() => f.store.lookup(c.prepared.token), () => f.store.get(c.command.id), () => f.store.page(), () => f.store.validate()])
      expect(read).toThrowError(expect.objectContaining({ code: 'corrupt' }))
  })
  it('uses explicit UUID keyset pages; unknown cursors, unsupported filters and size refusals do not read a prefix', () => {
    vi.setSystemTime(at); const f = sqlite(); for (let n = 0; n < 3; n++) f.store.issue(command().command, ignoreScope)
    const first = f.store.page({ limit: 2 }), next = f.store.page({ after: first.nextCursor!, limit: 2 })
    expect(first.grants).toHaveLength(2); expect(next.grants).toHaveLength(1); expect(next.nextCursor).toBeNull()
    expect([...first.grants, ...next.grants].map(r => r.id)).toEqual(f.records().map(r => r.id))
    expect(() => f.store.page({ after: randomUUID() })).toThrowError(expect.objectContaining({ code: 'not-found' }))
    for (const page of [{ limit: 201 }, { limit: 0 }, { role: 'reviewer' }]) expect(() => f.store.page(page as never)).toThrowError(expect.objectContaining({ code: 'invalid-command' }))
  })
})

// A domain journal double: real SQL, COMMIT transport, deployed auth and production qualification remain separate.
describe('PostgreSQL grant domain boundary', () => {
  it('serializes exact issuance/revocation across adapters, returns metadata only and preserves hashes/audit versions', async () => {
    vi.setSystemTime(at); const f = postgres(), other = new PostgresGrantStore(f.journal), c = command()
    const [a, b] = await Promise.all([f.store.issue(c.command, ignoreAsyncScope), other.issue(c.command, ignoreAsyncScope)])
    expect(a.id).toBe(b.id); expect(f.commits).toBe(1); expect(await f.store.lookup(c.prepared.token)).toMatchObject({ grantId: a.id })
    const revoke = { id: c.command.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner' }
    await Promise.all([f.store.revoke(revoke), other.revoke(revoke)]); expect(f.commits).toBe(2); expect(await f.store.lookup(c.prepared.token)).toBeNull()
    expect(await f.store.issue(c.command, async () => { throw Error('Replay must not regrant') })).toMatchObject({ status: 'revoked' })
    await f.store.validate(); expect(JSON.stringify(await f.store.page())).not.toContain(c.prepared.tokenSha256)
  })
  it('holds scope validation and commit under the shared owner gate and clones issue input before queued mutation', async () => {
    vi.setSystemTime(at); const f = postgres(), c = command(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), phases: string[] = []
    const pending = f.store.issue(c.command, async () => { phases.push('scope'); entered.resolve(); await release.promise })
    await entered.promise
    const mutation = withDomainWrite(f.journal, async () => { phases.push('mutation') }); await Promise.resolve(); expect(phases).toEqual(['scope'])
    c.command.actor = 'modified after admission'; if (c.command.scope.kind === 'caller') c.command.scope.permissions = ['cancel']
    release.resolve(); const issued = await pending; await mutation
    expect(issued.issuer).toBe('owner:fixture'); expect(issued.scope).toMatchObject({ permissions: ['read', 'start'] }); expect(phases).toEqual(['scope', 'mutation'])
  })
  it('refuses lost ownership, capacity and late commit failure without recording partial grants', async () => {
    vi.setSystemTime(at); const lost = postgres(); lost.abort.abort(new Error('lost fixture owner'))
    await expect(lost.store.issue(command().command, ignoreAsyncScope)).rejects.toThrow('lost fixture owner'); expect(lost.commits).toBe(0)
    const f = postgres(1); const c = command(); await f.store.issue(c.command, ignoreAsyncScope)
    await expect(f.store.issue(command().command, ignoreAsyncScope)).rejects.toHaveProperty('code', 'limit')
    const failed = postgres(); failed.fail(); await expect(failed.store.issue(command().command, ignoreAsyncScope)).rejects.toHaveProperty('code', 'unavailable')
    expect(failed.records.size).toBe(0); expect(failed.events).toEqual([])
  })
  it('rejects batch UUID reuse across grants and normalizes conflicting revocation retries', async () => {
    vi.setSystemTime(at); const f = postgres(), a = command(), b = command(); await f.store.issue(a.command, ignoreAsyncScope); await f.store.issue(b.command, ignoreAsyncScope)
    const revoke = { id: a.command.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner' }; await f.store.revoke(revoke)
    await expect(f.store.revoke({ ...revoke, id: b.command.id })).rejects.toHaveProperty('code', 'conflict')
    await expect(f.store.revoke({ ...revoke, actor: 'other' })).rejects.toHaveProperty('code', 'conflict')
    await expect(f.store.issue({ ...command().command, id: revoke.requestId }, ignoreAsyncScope)).rejects.toHaveProperty('code', 'conflict')
    expect(f.commits).toBe(3)
  })
  it.each(['snapshot', 'event', 'version', 'batch', 'extra-event'])('rejects %s substitution before metadata or principal leaves the store', async kind => {
    vi.setSystemTime(at); const f = postgres(), c = command(); await f.store.issue(c.command, ignoreAsyncScope)
    if (kind === 'snapshot') (f.records.get(c.command.id)!.value as GrantRecord).scope = { kind: 'reviewer', runId: randomUUID(), attemptId: randomUUID(), revision: 'a'.repeat(64), decisions: ['approve'] }
    if (kind === 'event') f.events[0].kind = 'grant-revoked'
    if (kind === 'version') f.records.get(c.command.id)!.version = '2'
    if (kind === 'batch') f.events[0].batchId = randomUUID()
    if (kind === 'extra-event') f.events.push({ ...f.events[0], sequence: '2' })
    for (const read of [() => f.store.get(c.command.id), () => f.store.lookup(c.prepared.token), () => f.store.page(), () => f.store.validate()])
      await expect(read()).rejects.toHaveProperty('code', 'corrupt')
  })
  it('rejects orphan audit events instead of treating an empty namespace as valid', async () => {
    const f = postgres(); f.events.push({ key: randomUUID(), sequence: '1', kind: 'grant-issued', data: {} })
    await expect(f.store.validate()).rejects.toHaveProperty('code', 'corrupt')
  })
})

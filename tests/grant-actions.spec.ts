import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { admitGrantAction, parseGrantAction, type GrantAction, type GrantActionTarget } from '../src/access/actions.ts'
import { prepareGrantToken, issueGrantRecord, grantTokenProof, revokeGrantRecord, type GrantIssue } from '../src/access/grants.ts'
import { SQLiteGrantStore, initializeGrantTables } from '../src/access/sqlite-grants.ts'
import { PostgresGrantStore } from '../src/access/postgres-grants.ts'
import { journalConditionHash } from '../src/storage/conditions.ts'
import { type PostgresJournal, type JournalBatch } from '../src/storage/postgres.ts'
import { withDomainWrite } from '../src/storage/domain-owner.ts'

const at = '2026-10-01T00:00:00.000Z', expiresAt = '2026-10-02T00:00:00.000Z'
const dbs: DatabaseSync[] = []
afterEach(() => { vi.useRealTimers(); dbs.splice(0).forEach(db => db.close()) })
function fixture() {
  vi.setSystemTime(at)
  const prepared = prepareGrantToken(randomUUID()), release = { id: randomUUID(), sha256: 'a'.repeat(64), revision: 'b'.repeat(64) }
  const command: GrantIssue = { id: prepared.id, tokenSha256: prepared.tokenSha256, actor: 'owner:fixture', expiresAt,
    scope: { kind: 'caller', release, permissions: ['start', 'read', 'control', 'cancel'] } }
  const record = issueGrantRecord(command, at), proof = grantTokenProof(prepared.token)!
  const target: Extract<GrantActionTarget, { kind: 'run' }> = { kind: 'run', runId: randomUUID(), revision: release.revision,
    release, callerGrantId: record.id, cancelled: false, wait: { attemptId: randomUUID(), expiresAt } }
  return { prepared, release, command, record, proof, target }
}

describe('exact delegated action policy (internal, no delegated endpoint)', () => {
  it.each(['start', 'read', 'control', 'cancel'] as const)('admits only the explicit caller %s action with server-derived identity', kind => {
    const f = fixture(), action: GrantAction = kind === 'start' ? { kind, release: f.release } : { kind, runId: f.target.runId }
    const target: GrantActionTarget = kind === 'start' ? { kind: 'release', release: f.release } : f.target
    const admission = admitGrantAction(f.record, f.proof, action, target)
    expect(admission).toMatchObject({ grantId: f.record.id, actor: `grant:${f.record.id}`, action, admittedAt: at, expiresAt })
    expect(JSON.stringify(admission)).not.toContain(f.prepared.token); expect(JSON.stringify(admission)).not.toContain(f.prepared.tokenSha256)
    admission.scope.kind === 'caller' && admission.scope.permissions.splice(0)
    expect(f.record.scope.kind === 'caller' && f.record.scope.permissions.length).toBe(4)
  })
  it.each(['read', 'control', 'cancel'] as const)('refuses caller %s without its exact permission', kind => {
    const f = fixture(); if (f.record.scope.kind !== 'caller') throw Error()
    f.record.scope.permissions = f.record.scope.permissions.filter(p => p !== kind)
    expect(() => admitGrantAction(f.record, f.proof, { kind, runId: f.target.runId }, f.target)).toThrowError(expect.objectContaining({ code: 'not-found' }))
  })
  it.each(['no-owner', 'foreign-owner', 'foreign-run', 'foreign-release', 'changed-sha', 'changed-revision', 'no-release'] as const)(
    'refuses caller access with %s retained target; equal release pins alone are not ownership', damage => {
      const f = fixture(), action = { kind: 'read' as const, runId: f.target.runId }
      if (damage === 'no-owner') delete f.target.callerGrantId
      if (damage === 'foreign-owner') f.target.callerGrantId = randomUUID()
      if (damage === 'foreign-run') f.target.runId = randomUUID()
      if (damage === 'foreign-release') f.target.release!.id = randomUUID()
      if (damage === 'changed-sha') f.target.release!.sha256 = 'c'.repeat(64)
      if (damage === 'changed-revision') f.target.revision = 'c'.repeat(64)
      if (damage === 'no-release') delete f.target.release
      expect(() => admitGrantAction(f.record, f.proof, action, f.target)).toThrowError(expect.objectContaining({ code: 'not-found' }))
    })
  it.each(['request-pin', 'retained-pin', 'no-start-permission'] as const)('refuses substituted caller start: %s', damage => {
    const f = fixture(), request = structuredClone(f.release), retained = structuredClone(f.release)
    if (damage === 'request-pin') request.id = randomUUID()
    if (damage === 'retained-pin') retained.sha256 = 'c'.repeat(64)
    if (damage === 'no-start-permission' && f.record.scope.kind === 'caller') f.record.scope.permissions = ['read']
    expect(() => admitGrantAction(f.record, f.proof, { kind: 'start', release: request }, { kind: 'release', release: retained }))
      .toThrowError(expect.objectContaining({ code: 'not-found' }))
  })
  it('does not promote caller credentials to reviewer authority, even for its own run', () => {
    const f = fixture()
    expect(() => admitGrantAction(f.record, f.proof, { kind: 'decision', runId: f.target.runId, attemptId: f.target.wait!.attemptId, decision: 'approve' }, f.target))
      .toThrowError(expect.objectContaining({ code: 'not-found' }))
  })
  it.each(['start', 'read', 'control', 'cancel'] as const)('does not promote reviewer credentials to %s authority', kind => {
    const f = fixture()
    f.record.scope = { kind: 'reviewer', runId: f.target.runId, attemptId: f.target.wait!.attemptId, revision: f.target.revision, decisions: ['approve'] }
    const action: GrantAction = kind === 'start' ? { kind, release: f.release } : { kind, runId: f.target.runId }
    expect(() => admitGrantAction(f.record, f.proof, action, f.target)).toThrowError(expect.objectContaining({ code: 'not-found' }))
  })
  it.each(['approve', 'reject', 'requestChanges'] as const)('admits exact reviewer %s and pins the earliest wait/loop/grant deadline', decision => {
    const f = fixture(), loopExpiresAt = '2026-10-01T00:00:05.000Z'
    f.record.scope = { kind: 'reviewer', runId: f.target.runId, attemptId: f.target.wait!.attemptId, revision: f.target.revision, decisions: [decision] }
    f.target.wait!.loopExpiresAt = loopExpiresAt
    const admission = admitGrantAction(f.record, f.proof, { kind: 'decision', runId: f.target.runId, attemptId: f.target.wait!.attemptId, decision }, f.target)
    expect(admission.expiresAt).toBe(loopExpiresAt)
  })
  it.each(['run', 'attempt', 'revision', 'decision', 'no-wait', 'cancelled', 'wait-expiry', 'loop-expiry'] as const)(
    'refuses stale/out-of-scope reviewer %s without granting another action', damage => {
      const f = fixture(), action: GrantAction = { kind: 'decision', runId: f.target.runId, attemptId: f.target.wait!.attemptId, decision: 'approve' }
      f.record.scope = { kind: 'reviewer', runId: f.target.runId, attemptId: f.target.wait!.attemptId, revision: f.target.revision, decisions: ['approve'] }
      if (damage === 'run') f.target.runId = randomUUID()
      if (damage === 'attempt') f.target.wait!.attemptId = randomUUID()
      if (damage === 'revision') f.target.revision = 'c'.repeat(64)
      if (damage === 'decision') action.decision = 'reject'
      if (damage === 'no-wait') delete f.target.wait
      if (damage === 'cancelled') f.target.cancelled = true
      if (damage === 'wait-expiry') f.target.wait!.expiresAt = at
      if (damage === 'loop-expiry') f.target.wait!.loopExpiresAt = at
      expect(() => admitGrantAction(f.record, f.proof, action, f.target)).toThrowError(expect.objectContaining({ code: 'not-found' }))
    })
  it.each(['revoked', 'expired', 'clock-rollback', 'wrong-digest', 'wrong-id'] as const)('refuses %s credentials for every action', damage => {
    const f = fixture()
    if (damage === 'revoked') f.record = revokeGrantRecord(f.record, { id: f.record.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:revoke' }, at)
    if (damage === 'expired') vi.setSystemTime(expiresAt)
    if (damage === 'clock-rollback') vi.setSystemTime('2026-09-30T23:59:59.999Z')
    if (damage === 'wrong-digest') f.proof.tokenSha256 = 'd'.repeat(64)
    if (damage === 'wrong-id') f.proof.id = randomUUID()
    for (const action of [{ kind: 'start', release: f.release }, { kind: 'read', runId: f.target.runId }, { kind: 'control', runId: f.target.runId }, { kind: 'cancel', runId: f.target.runId }] as const)
      expect(() => admitGrantAction(f.record, f.proof, action, action.kind === 'start' ? { kind: 'release', release: f.release } : f.target))
        .toThrowError(expect.objectContaining({ code: 'not-found' }))
  })
  it.each([{ kind: 'owner' }, { kind: 'read', runId: randomUUID(), actor: 'forged' }, { kind: 'start', yaml: 'arbitrary' },
    { kind: 'decision', runId: randomUUID(), attemptId: randomUUID(), decision: 'bad action' },
    { kind: 'decision', runId: randomUUID(), attemptId: randomUUID(), decision: 'timeout' }])('refuses an expanded action contract: %j', value => {
    expect(() => parseGrantAction(value)).toThrowError(expect.objectContaining({ code: 'invalid-command' }))
  })
})

describe('SQLite grant guard at the owning writer transaction', () => {
  function sqlite() { const f = fixture(), db = new DatabaseSync(':memory:'); dbs.push(db); initializeGrantTables(db)
    const store = new SQLiteGrantStore(db); store.issue(f.command, () => {}); return { ...f, db, store } }
  it('refuses out-of-transaction lookup as action admission and accepts the exact current snapshot inside BEGIN', () => {
    const f = sqlite(), action = { kind: 'read', runId: f.target.runId }
    expect(() => f.store.authorizeInTransaction(f.prepared.token, action, f.target)).toThrowError(expect.objectContaining({ code: 'busy' }))
    f.db.exec('BEGIN IMMEDIATE')
    try { expect(f.store.authorizeInTransaction(f.prepared.token, action, f.target)).toMatchObject({ actor: `grant:${f.record.id}` }) }
    finally { f.db.exec('ROLLBACK') }
  })
  it.each(['revoked', 'expired', 'wrong-secret', 'owner-token'] as const)('rejects %s at the write boundary after a successful earlier lookup', damage => {
    const f = sqlite(); expect(f.store.lookup(f.prepared.token)).not.toBeNull()
    if (damage === 'revoked') f.store.revoke({ id: f.record.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:revoke' })
    if (damage === 'expired') vi.setSystemTime(expiresAt)
    const token = damage === 'wrong-secret' ? prepareGrantToken(f.record.id).token : damage === 'owner-token' ? 'a'.repeat(64) : f.prepared.token
    f.db.exec('BEGIN IMMEDIATE')
    try { expect(() => f.store.authorizeInTransaction(token, { kind: 'read', runId: f.target.runId }, f.target)).toThrowError(expect.objectContaining({ code: 'not-found' })) }
    finally { f.db.exec('ROLLBACK') }
  })
  it('fails closed on corrupt audit at action admission', () => {
    const f = sqlite(); f.db.exec('DELETE FROM access_grant_events; BEGIN IMMEDIATE')
    try { expect(() => f.store.authorizeInTransaction(f.prepared.token, { kind: 'read', runId: f.target.runId }, f.target)).toThrowError(expect.objectContaining({ code: 'corrupt' })) }
    finally { f.db.exec('ROLLBACK') }
  })
})

describe('PostgreSQL action planning (journal/domain doubles, not real SQL)', () => {
  function postgres() {
    const f = fixture(), rows = new Map<string, any>(), events: any[] = [], abort = new AbortController()
    const journal = { signal: abort.signal, get: async (_: string, id: string) => structuredClone(rows.get(id)),
      events: async (_: string, __: number, ___: string[], id: string) => ({ events: structuredClone(events.filter(e => e.key === id)) }),
      count: async () => rows.size, receipt: async () => undefined,
      commit: async (batch: JournalBatch) => { for (const c of batch.changes) if (c.operation === 'put') rows.set(c.key, { key: c.key, version: String(BigInt(c.expectedVersion) + 1n), value: structuredClone(c.value) })
        for (const e of batch.events) events.push({ ...structuredClone(e), batchId: batch.id }); return {} as never },
    } as unknown as PostgresJournal
    const store = new PostgresGrantStore(journal), condition = { collection: 'runs' as const, key: f.target.runId, version: '1', sha256: journalConditionHash({ fixture: 'verified run snapshot' }) }
    return { ...f, journal, store, condition, reader: vi.fn(async () => ({ target: f.target, condition })), rows, events }
  }
  it('returns exact grant and target snapshot/time guards, not a broadly authorized principal', async () => {
    const f = postgres(); await f.store.issue(f.command, async () => {})
    const planned = await f.store.planAction(f.prepared.token, { kind: 'control', runId: f.target.runId }, f.reader)
    expect(planned.conditions).toEqual({ records: [{ collection: 'access-grants', key: f.record.id, version: '1', sha256: journalConditionHash(f.record) }, f.condition], notBefore: at, expiresAt })
    expect(planned.admission.actor).toBe(`grant:${f.record.id}`); expect(f.events).toHaveLength(1)
  })
  it('never loads a private target for an invalid, unknown, expired or revoked token', async () => {
    const f = postgres(); await f.store.issue(f.command, async () => {})
    for (const token of ['a'.repeat(64), prepareGrantToken(randomUUID()).token, prepareGrantToken(f.record.id).token])
      await expect(f.store.planAction(token, { kind: 'read', runId: f.target.runId }, f.reader)).rejects.toHaveProperty('code', 'not-found')
    vi.setSystemTime(expiresAt)
    await expect(f.store.planAction(f.prepared.token, { kind: 'read', runId: f.target.runId }, f.reader)).rejects.toHaveProperty('code', 'not-found')
    vi.setSystemTime(at); await f.store.revoke({ id: f.record.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:revoke' })
    await expect(f.store.planAction(f.prepared.token, { kind: 'read', runId: f.target.runId }, f.reader)).rejects.toHaveProperty('code', 'not-found')
    expect(f.reader).not.toHaveBeenCalled()
  })
  it('rechecks inclusive expiry after an asynchronously delayed target read', async () => {
    const f = postgres(); await f.store.issue(f.command, async () => {})
    const read = async () => { vi.setSystemTime(expiresAt); return f.reader() }
    await expect(f.store.planAction(f.prepared.token, { kind: 'read', runId: f.target.runId }, read)).rejects.toHaveProperty('code', 'not-found')
    expect(f.events).toHaveLength(1)
  })
  it('keeps a concurrent revoke behind the coherent planning gate, and detaches action input before awaits', async () => {
    const f = postgres(); await f.store.issue(f.command, async () => {})
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), action = { kind: 'read', runId: f.target.runId }
    const plan = f.store.planAction(f.prepared.token, action, async () => { entered.resolve(); await release.promise; return f.reader() })
    await entered.promise; action.runId = randomUUID()
    let revoked = false
    const revoke = f.store.revoke({ id: f.record.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:revoke' }).then(() => { revoked = true })
    const checkpoint = withDomainWrite(f.journal, async () => {})
    expect(revoked).toBe(false); release.resolve(); const planned = await plan
    expect(planned.admission.action).toEqual({ kind: 'read', runId: f.target.runId })
    await revoke; await checkpoint; expect(f.rows.get(f.record.id).version).toBe('2')
    // The now-stale version-1 conditions must still be checked inside commit; planning never dispatches.
    expect(planned.conditions.records[0]!.version).toBe('1')
  })
  it.each(['collection', 'key'] as const)('refuses a mismatched target snapshot %s', async damage => {
    const f = postgres(); await f.store.issue(f.command, async () => {})
    const read = async () => ({ target: f.target, condition: { ...f.condition, ...(damage === 'collection' ? { collection: 'releases' as const } : { key: randomUUID() }) } })
    await expect(f.store.planAction(f.prepared.token, { kind: 'read', runId: f.target.runId }, read)).rejects.toHaveProperty('code', 'corrupt')
  })
})

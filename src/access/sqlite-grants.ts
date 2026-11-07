import type { DatabaseSync } from 'node:sqlite'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { admitGrantAction, parseGrantAction, type GrantActionTarget } from './actions.ts'
import type { GrantPolicyObserver } from './policy-observation.ts'
import { GRANT_LIMITS, parseGrantId, parseGrantIssue, parseGrantRevoke, parseGrantPage, inspectGrant, inspectGrantHistory,
  issueGrantRecord, revokeGrantRecord, sameGrantIssue, grantHistory, grantMetadata, grantTokenProof, grantPrincipal,
  type GrantRecord, type GrantScope, type GrantPageRequest, type GrantPage } from './grants.ts'

export function initializeGrantTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS access_grants (id TEXT PRIMARY KEY, generation INTEGER NOT NULL, record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS access_grant_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      grant_id TEXT NOT NULL REFERENCES access_grants(id), request_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, record TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS access_grant_history ON access_grant_events(grant_id, sequence);`)
}
type Row = { id: string; generation: number; record: string }
export class SQLiteGrantStore {
  constructor(private readonly db: DatabaseSync, private readonly maxGrants: number = GRANT_LIMITS.records,
    private readonly policyObserver?: GrantPolicyObserver) {
    if (!Number.isSafeInteger(maxGrants) || maxGrants < 1 || maxGrants > GRANT_LIMITS.records) throw new WorkflowRuntimeError('invalid-command')
  }
  private decode(value: string) {
    try { if (typeof value !== 'string' || Buffer.byteLength(value) > GRANT_LIMITS.bytes) throw Error(); return JSON.parse(value) as unknown }
    catch { throw new WorkflowRuntimeError('corrupt') }
  }
  private read(id: string): GrantRecord | undefined {
    const row = this.db.prepare('SELECT id,generation,record FROM access_grants WHERE id=?').get(id) as Row | undefined
    if (!row) return undefined
    const record = inspectGrant(this.decode(row.record))
    if (record.id !== row.id || record.generation !== row.generation) throw new WorkflowRuntimeError('corrupt')
    const rows = this.db.prepare('SELECT request_id,kind,record FROM access_grant_events WHERE grant_id=? ORDER BY sequence LIMIT 3')
      .all(id) as { request_id: string; kind: string; record: string }[]
    const history = rows.map(row => { const event = this.decode(row.record) as { kind?: unknown; requestId?: unknown } | null
      if (event?.kind !== row.kind || event?.requestId !== row.request_id) throw new WorkflowRuntimeError('corrupt'); return event })
    inspectGrantHistory(record, history)
    return record
  }
  get(value: string) { const record = this.read(parseGrantId(value)); if (!record) throw new WorkflowRuntimeError('not-found'); return grantMetadata(record) }
  page(value: GrantPageRequest = {}): GrantPage {
    const { after, limit } = parseGrantPage(value), at = new Date().toISOString()
    if (after && !this.read(after)) throw new WorkflowRuntimeError('not-found')
    const rows = this.db.prepare('SELECT id FROM access_grants WHERE id>? ORDER BY id LIMIT ?').all(after ?? '', limit + 1) as { id: string }[]
    const records = rows.slice(0, limit).map(row => this.read(row.id)!)
    return { schemaVersion: 1, observedAt: at, grants: records.map(record => grantMetadata(record, at)), nextCursor: rows.length > limit ? records.at(-1)!.id : null }
  }
  private atomic<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const value = work(); this.db.exec('COMMIT'); return value }
    catch (error) { try { this.db.exec('ROLLBACK') } catch { /* Preserve the original uncertainty. */ } throw error }
  }
  issue(value: unknown, checkScope: (scope: GrantScope, at: string) => void) {
    const command = parseGrantIssue(value)
    return this.atomic(() => {
      const previous = this.read(command.id)
      if (previous) { if (!sameGrantIssue(previous, command)) throw new WorkflowRuntimeError('conflict'); return grantMetadata(previous) }
      if (this.db.prepare('SELECT grant_id FROM access_grant_events WHERE request_id=?').get(command.id)) throw new WorkflowRuntimeError('conflict')
      const count = (this.db.prepare('SELECT count(*) AS count FROM access_grants').get() as { count: number }).count
      if (count >= this.maxGrants) throw new WorkflowRuntimeError('limit')
      const at = new Date().toISOString(), record = issueGrantRecord(command, at); checkScope(record.scope, at)
      this.db.prepare('INSERT INTO access_grants(id,generation,record) VALUES(?,?,?)').run(record.id, 1, JSON.stringify(record))
      this.db.prepare('INSERT INTO access_grant_events(grant_id,request_id,kind,record) VALUES(?,?,?,?)')
        .run(record.id, command.id, 'grant-issued', JSON.stringify(grantHistory(record)))
      return grantMetadata(record, at)
    })
  }
  revoke(value: unknown) {
    const command = parseGrantRevoke(value)
    return this.atomic(() => {
      const previous = this.read(command.id); if (!previous) throw new WorkflowRuntimeError('not-found')
      const at = new Date().toISOString(), record = revokeGrantRecord(previous, command, at)
      if (record === previous) return grantMetadata(record, at)
      if (this.db.prepare('SELECT grant_id FROM access_grant_events WHERE request_id=?').get(command.requestId)) throw new WorkflowRuntimeError('conflict')
      this.db.prepare('UPDATE access_grants SET generation=?,record=? WHERE id=? AND generation=1').run(2, JSON.stringify(record), record.id)
      this.db.prepare('INSERT INTO access_grant_events(grant_id,request_id,kind,record) VALUES(?,?,?,?)')
        .run(record.id, command.requestId, 'grant-revoked', JSON.stringify(grantHistory(record, previous)))
      return grantMetadata(record, at)
    })
  }
  lookup(token: unknown) { const proof = grantTokenProof(token); if (!proof) return null
    const record = this.read(proof.id); return record ? grantPrincipal(record, proof) : null }
  /** Internal run-writer guard: shares its transaction, never starts a nested transaction or accepts request-owned targets. */
  authorizeInTransaction(token: unknown, action: unknown, target: GrantActionTarget) {
    if (!this.db.isTransaction) throw new WorkflowRuntimeError('busy')
    const request = parseGrantAction(action), proof = grantTokenProof(token)
    if (!proof) throw new WorkflowRuntimeError('not-found')
    const record = this.read(proof.id)
    if (!record) throw new WorkflowRuntimeError('not-found')
    return admitGrantAction(record, proof, request, target, undefined, this.policyObserver)
  }
  validate() {
    const rows = this.db.prepare('SELECT id FROM access_grants ORDER BY id').all() as { id: string }[]
    if (rows.length > this.maxGrants) throw new WorkflowRuntimeError('limit')
    let events = 0
    for (const row of rows) events += this.read(row.id)!.generation
    if ((this.db.prepare('SELECT count(*) AS count FROM access_grant_events').get() as { count: number }).count !== events) throw new WorkflowRuntimeError('corrupt')
  }
}

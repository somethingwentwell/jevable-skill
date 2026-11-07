import type { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual as same } from 'node:util'
import { z } from 'zod'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { automaticAdmissionLimits, inspectAutomaticAdmission, parseAutomaticAdmissionPage, validateAutomaticAdmissionCreation,
  validateAutomaticAdmissionSettlement, verifyAutomaticAdmissionDelivery,
  type AutomaticAdmissionLimits, type AutomaticAdmissionPage, type AutomaticAdmissionRecord } from './automatic-admission.ts'

/** Internal explicit owner migration only; no connection, schema repair or transaction ownership here. */
export function initializeAutomaticAdmissionTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE automatic_approval_admissions (
    id TEXT PRIMARY KEY, record TEXT NOT NULL
  );
  CREATE TABLE automatic_approval_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    admission_id TEXT NOT NULL REFERENCES automatic_approval_admissions(id),
    kind TEXT NOT NULL, record TEXT NOT NULL
  );
  CREATE INDEX automatic_approval_history ON automatic_approval_events(admission_id, sequence);`)
}
type Row = { id: string; record: string }
const corrupt = () => new WorkflowRuntimeError('corrupt')

/** Sole SQLite owner's durable evidence, never a recovered outbox. Reads/startup never call a transport. */
export class SQLiteAutomaticAdmissionStore {
  private readonly limits: AutomaticAdmissionLimits
  constructor(private readonly db: DatabaseSync, limits: AutomaticAdmissionLimits,
    // Called synchronously under this transaction. Must not nest a transaction or perform external effects.
    private readonly checks: { history(record: AutomaticAdmissionRecord): void; delivery(requestId: string): unknown }) {
    const parsed = automaticAdmissionLimits.safeParse(limits)
    if (!parsed.success || typeof checks?.history !== 'function' || typeof checks?.delivery !== 'function')
      throw new WorkflowRuntimeError('invalid-command')
    this.limits = parsed.data
    this.validate()
  }
  private decode(row: Row) {
    if (typeof row.record !== 'string' || Buffer.byteLength(row.record) > 65536) throw corrupt()
    let value: unknown
    try { value = JSON.parse(row.record) } catch { throw corrupt() }
    const record = inspectAutomaticAdmission(value)
    if (record.request.requestId !== row.id) throw corrupt()
    return record
  }
  private read(id: string) {
    const row = this.db.prepare('SELECT id,record FROM automatic_approval_admissions WHERE id=?').get(id) as Row | undefined
    return row ? this.decode(row) : undefined
  }
  private checked(record: AutomaticAdmissionRecord) {
    this.checks.history(record)
    if (record.outcome.status === 'delivery-recorded') verifyAutomaticAdmissionDelivery(record, this.checks.delivery(record.request.requestId))
    return record
  }
  private count(table: 'automatic_approval_admissions' | 'automatic_approval_events') {
    return (this.db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count
  }
  private atomic<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = work(); this.db.exec('COMMIT'); return result }
    catch (error) { try { this.db.exec('ROLLBACK') } catch { /* Preserve uncertain acknowledgement, never replay. */ } throw error }
  }
  get(id: string) {
    if (!z.uuid().safeParse(id).success) throw new WorkflowRuntimeError('invalid-command')
    const record = this.read(id)
    return record ? this.checked(record) : undefined
  }
  page(value: AutomaticAdmissionPage = {}) {
    const { after, limit } = parseAutomaticAdmissionPage(value)
    if (after !== undefined && !this.get(after)) throw new WorkflowRuntimeError('not-found')
    const rows = (after === undefined
      ? this.db.prepare('SELECT id,record FROM automatic_approval_admissions ORDER BY id LIMIT ?').all(limit + 1)
      : this.db.prepare('SELECT id,record FROM automatic_approval_admissions WHERE id>? ORDER BY id LIMIT ?').all(after, limit + 1)) as Row[]
    const records = rows.slice(0, limit).map(row => this.checked(this.decode(row)))
    return { records, nextCursor: rows.length > limit ? records.at(-1)!.request.requestId : null }
  }
  create(value: AutomaticAdmissionRecord) {
    const input = inspectAutomaticAdmission(value)
    return this.atomic(() => {
      const { record, changed } = validateAutomaticAdmissionCreation(input, this.read(input.request.requestId))
      this.checked(record)
      if (!changed) return false
      if (this.count('automatic_approval_admissions') >= this.limits.maxAdmissions
        || (this.count('automatic_approval_admissions') + 1) * 2 > this.limits.maxEvents) throw new WorkflowRuntimeError('limit')
      const encoded = JSON.stringify(record)
      this.db.prepare('INSERT INTO automatic_approval_admissions(id,record) VALUES(?,?)').run(record.request.requestId, encoded)
      this.db.prepare("INSERT INTO automatic_approval_events(admission_id,kind,record) VALUES(?,'created',?)").run(record.request.requestId, encoded)
      return true
    })
  }
  settle(value: AutomaticAdmissionRecord) {
    const input = inspectAutomaticAdmission(value)
    this.atomic(() => {
      const previous = this.read(input.request.requestId)
      if (!previous) throw new WorkflowRuntimeError('not-found')
      const { record, changed } = validateAutomaticAdmissionSettlement(previous, input)
      this.checked(record)
      if (!changed) return
      if (this.count('automatic_approval_events') >= this.limits.maxEvents) throw new WorkflowRuntimeError('limit')
      const encoded = JSON.stringify(record)
      this.db.prepare('UPDATE automatic_approval_admissions SET record=? WHERE id=?').run(encoded, record.request.requestId)
      this.db.prepare("INSERT INTO automatic_approval_events(admission_id,kind,record) VALUES(?,'settled',?)").run(record.request.requestId, encoded)
    })
  }
  /** Bidirectional bounded snapshot/audit verification only; a reserved row is left reserved, never dispatched. */
  validate() {
    if (this.count('automatic_approval_admissions') > this.limits.maxAdmissions
      || this.count('automatic_approval_admissions') * 2 > this.limits.maxEvents
      || this.count('automatic_approval_events') > this.limits.maxEvents) throw new WorkflowRuntimeError('limit')
    const rows = this.db.prepare('SELECT id,record FROM automatic_approval_admissions ORDER BY id').all() as Row[]
    let total = 0
    for (const row of rows) {
      const current = this.decode(row)
      const audit = this.db.prepare('SELECT kind,record FROM automatic_approval_events WHERE admission_id=? ORDER BY sequence LIMIT 3')
        .all(row.id) as { kind: string; record: string }[]
      if (!audit.length || audit.length > 2 || audit[0]!.kind !== 'created') throw corrupt()
      const first = this.decode({ id: row.id, record: audit[0]!.record })
      try { validateAutomaticAdmissionCreation(first) } catch { throw corrupt() }
      let expected = first
      if (audit.length === 2) {
        if (audit[1]!.kind !== 'settled') throw corrupt()
        try {
          const checked = validateAutomaticAdmissionSettlement(first, this.decode({ id: row.id, record: audit[1]!.record }))
          if (!checked.changed) throw corrupt()
          expected = checked.record
        } catch { throw corrupt() }
      }
      if (!same(current, expected)) throw corrupt()
      this.checked(current); total += audit.length
    }
    if (total !== this.count('automatic_approval_events')) throw corrupt()
  }
}

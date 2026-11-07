import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { WorkflowLimits } from '../workflow/index.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import type { TransferredTests } from '../testing/schema.ts'
import { vendorImportCommandSchema, type VendorImportCommand } from './vendor-import.ts'
import { activityProject } from '../runtime/activity.ts'
import { ProjectLedger, deleteCommandSchema, deletionSchema, type Project, type ProjectCommand, type ProjectDeletion, type ProjectRecord } from './ledger.ts'
export { projectCommandSchema, approvalChanges } from './ledger.ts'
export type { Project, ProjectCommand, ProjectDeletion, ProjectBundle } from './ledger.ts'

/** SQLite persistence around the backend-independent project review ledger. */
export class ProjectStore {
  private readonly ledger: ProjectLedger
  constructor(private readonly db: DatabaseSync, limits: WorkflowLimits, maxRecordBytes: number) {
    this.ledger = new ProjectLedger(limits, maxRecordBytes)
  }
  private read(id: string): ProjectRecord {
    if (!z.uuid().safeParse(id).success) throw new WorkflowRuntimeError('invalid-command')
    const row = this.db.prepare('SELECT generation,record FROM projects WHERE id=?').get(id) as { generation: number; record: string } | undefined
    if (!row) throw new WorkflowRuntimeError('not-found')
    return this.ledger.decode(row.record, id, row.generation)
  }
  get(id: string, generation?: number) { return this.ledger.replay(this.read(id), generation) }
  diff(id: string, from: string, to: string) { return this.ledger.diff(this.read(id), from, to) }
  export(id: string, expectedGeneration: number, reviewedRevision: string, history = false, tests?: TransferredTests) {
    return this.ledger.export(this.read(id), expectedGeneration, reviewedRevision, history, tests)
  }
  inspectImport(json: string) { return this.ledger.inspectImport(json) }
  vendorImport(id: string, inspect = false) {
    if (!z.uuid().safeParse(id).success) throw new WorkflowRuntimeError('invalid-command')
    return this.ledger.vendorImport(this.read(id.toLowerCase()), inspect)
  }
  createVendorImport(value: VendorImportCommand): Project {
    const parsed = vendorImportCommandSchema.safeParse(value)
    if (!parsed.success) throw new WorkflowRuntimeError('invalid-command')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const exists = this.db.prepare('SELECT id FROM projects WHERE lower(id)=?').get(parsed.data.id) as { id: string } | undefined
      if (!exists && this.db.prepare('SELECT id FROM project_deletions WHERE lower(id)=?').get(parsed.data.id)) throw new WorkflowRuntimeError('conflict')
      const result = this.ledger.createVendorImport(parsed.data, exists ? this.read(exists.id) : undefined)
      if (!result.replayed) { this.createSlot(result.record.id); this.save(result.record) }
      this.db.exec('COMMIT'); return result.project
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private createSlot(id: string) {
    if ((this.db.prepare('SELECT count(*) AS count FROM projects').get() as { count: number }).count >= 1000) throw new WorkflowRuntimeError('limit')
    if (this.db.prepare('SELECT id FROM projects WHERE id=? UNION ALL SELECT id FROM project_deletions WHERE id=?').get(id, id)) throw new WorkflowRuntimeError('conflict')
  }
  private save(record: ProjectRecord) {
    this.db.prepare('INSERT INTO projects(id,generation,record) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,record=excluded.record')
      .run(record.id, record.changes.length, JSON.stringify(record))
  }
  import(json: string, reviewedSha256: string, actor: string, newId?: string, importTests?: (project: Project) => void): Project {
    const { record, project } = this.ledger.prepareImport(json, reviewedSha256, actor, newId, Boolean(importTests))
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.createSlot(record.id); this.save(record); importTests?.(project)
      this.db.exec('COMMIT'); return project
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  list() {
    return (this.db.prepare('SELECT id FROM projects ORDER BY rowid').all() as { id: string }[]).map(({ id }) => {
      const { revisions: _r, proposals: _p, changes: _c, ...summary } = this.get(id)
      return summary
    })
  }
  /** Private metadata projection for the runtime's optimistic coherent activity read. */
  activity() {
    return (this.db.prepare('SELECT id FROM projects ORDER BY id').all() as { id: string }[]).map(({ id }) => {
      const record = this.read(id)
      return activityProject(this.ledger.replay(record), Boolean(record.vendorImport))
    })
  }
  deletions(): ProjectDeletion[] {
    return (this.db.prepare('SELECT id,record FROM project_deletions ORDER BY rowid').all() as { id: string; record: string }[]).map(row => {
      try {
        if (Buffer.byteLength(row.record) > 4096) throw new Error()
        const receipt = deletionSchema.parse(JSON.parse(row.record))
        if (receipt.id !== row.id || this.db.prepare('SELECT id FROM projects WHERE id=?').get(row.id)) throw new Error()
        return receipt
      } catch { throw new WorkflowRuntimeError('corrupt') }
    })
  }

  /** No cascade: every linked run, including completed runs, retains its project evidence. */
  deleteArchived(value: z.infer<typeof deleteCommandSchema>): ProjectDeletion {
    const parsed = deleteCommandSchema.safeParse(value)
    if (!parsed.success) throw new WorkflowRuntimeError('invalid-command')
    const command = parsed.data
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const project = this.get(command.id)
      if (project.generation !== command.expectedGeneration || !project.archived) throw new WorkflowRuntimeError('conflict')
      const linked = this.db.prepare("SELECT id FROM runs WHERE json_extract(record, '$.project.id')=? LIMIT 1").get(command.id)
      if (linked) throw new WorkflowRuntimeError('referenced')
      const count = this.db.prepare('SELECT count(*) AS count FROM project_deletions').get() as { count: number }
      if (count.count >= 10_000) throw new WorkflowRuntimeError('limit')
      const now = new Date().toISOString()
      const receipt: ProjectDeletion = { schemaVersion: 1, id: project.id, generation: project.generation,
        revision: project.acceptedRevision, actor: command.actor, at: now < project.updatedAt ? project.updatedAt : now, status: 'deleted' }
      this.db.prepare('INSERT INTO project_deletions(id,record) VALUES(?,?)').run(project.id, JSON.stringify(receipt))
      const result = this.db.prepare('DELETE FROM projects WHERE id=? AND generation=?').run(project.id, project.generation)
      if (result.changes !== 1) throw new WorkflowRuntimeError('conflict')
      this.db.exec('COMMIT')
      return receipt
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }


  execute(value: ProjectCommand): Project {
    const command = this.ledger.command(value)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const before = command.operation === 'create' ? undefined : this.read(command.id)
      const { record, project } = this.ledger.apply(command, before)
      if (command.operation === 'create' || command.operation === 'duplicate') this.createSlot(record.id)
      this.save(record); this.db.exec('COMMIT'); return project
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
}

import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { PostgresJournal, JournalError, type JournalBatch } from '../storage/postgres.ts'
import { withDomainWrite } from '../storage/domain-owner.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import type { WorkflowLimits, WorkflowCompilerLimits } from '../workflow/index.ts'
import { ProjectLedger, deleteCommandSchema, deletionSchema, type ProjectCommand, type ProjectRecord, type ProjectDeletion } from './ledger.ts'
import { requireUnreferencedProject } from './postgres-references.ts'
import { DEFAULT_COMPILER_LIMITS } from '../limits.ts'
import { TestLedger } from '../testing/ledger.ts'
import { parseTest, testCommandSchema, transferredTestsSchema, type TransferredTests } from '../testing/schema.ts'
import { postgresTestWrite, decodePostgresTest } from '../testing/postgres-record.ts'
import { vendorImportCommandSchema, type VendorImportCommand } from './vendor-import.ts'
import { activityProject } from '../runtime/activity.ts'

const storedProject = z.strictObject({ format: z.literal('jevable.pg-project/v1'),
  generation: z.number().int().min(1).max(1000), record: z.unknown() })
const storedDeletion = z.strictObject({ format: z.literal('jevable.pg-project-deletion/v1'),
  projectVersion: z.string().regex(/^[1-9][0-9]{0,18}$/u).refine(value => BigInt(value) < 9223372036854775806n), receipt: deletionSchema })

/** Async review persistence, sharing the SQLite ledger's exact revision and approval rules. */
export class PostgresProjectStore {
  private readonly ledger: ProjectLedger
  private readonly tests: TestLedger
  private readonly limits: WorkflowCompilerLimits
  constructor(private readonly journal: PostgresJournal, limits: WorkflowLimits, private readonly maxRecordBytes = 4_000_000,
    testLimits: Omit<WorkflowCompilerLimits, 'source'> = DEFAULT_COMPILER_LIMITS) {
    if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1024 || maxRecordBytes > 16_000_000) throw new WorkflowRuntimeError('invalid-command')
    this.limits = { ...testLimits, source: limits }
    this.ledger = new ProjectLedger(limits, maxRecordBytes)
    this.tests = new TestLedger(this.limits, maxRecordBytes)
  }
  private decode(row: { key: string; version: string; value: unknown }) {
    const parsed = storedProject.safeParse(row.value)
    if (!parsed.success) throw new WorkflowRuntimeError('corrupt')
    const record = this.ledger.decode(JSON.stringify(parsed.data.record), row.key, parsed.data.generation)
    // Imported history arrives in one local commit. Every subsequent local change has one storage version.
    const imported = record.changes.findLastIndex(change => change.operation === 'import')
    const localVersions = record.changes.length - Math.max(0, imported)
    if (row.version !== String(localVersions)) throw new WorkflowRuntimeError('corrupt')
    return { record, version: row.version }
  }
  private async read(id: string) {
    if (!z.uuid().safeParse(id).success) throw new WorkflowRuntimeError('invalid-command')
    const row = await this.journal.get('projects', id)
    if (!row || row.deleted) throw new WorkflowRuntimeError('not-found')
    return this.decode(row)
  }
  private mutate<T>(work: () => Promise<T>): Promise<T> {
    return withDomainWrite(this.journal, async () => {
      try { return await work() }
      catch (error) { if (error instanceof JournalError && error.code === 'conflict') throw new WorkflowRuntimeError('conflict'); throw error }
    })
  }
  private async createSlot(id: string) {
    if (await this.journal.count('projects') >= 1000) throw new WorkflowRuntimeError('limit')
    // Neither a tombstone nor a deletion receipt makes an old identity reusable.
    if (await this.journal.get('projects', id) || await this.journal.get('project-deletions', id)) throw new WorkflowRuntimeError('conflict')
  }
  private async save(record: ProjectRecord, expectedVersion: string, testWrites: ReturnType<typeof postgresTestWrite>[] = []) {
    const change = record.changes.at(-1)!, project = this.ledger.replay(record)
    const projectWrite: JournalBatch['changes'][number] = { operation: 'put', collection: 'projects', key: record.id, expectedVersion,
      value: z.json().parse({ format: 'jevable.pg-project/v1', generation: project.generation, record }) }
    await this.journal.commit({ id: randomUUID(), changes: [projectWrite, ...testWrites.map(write => write.change)], events: [{ collection: 'projects', key: record.id,
      kind: `project-${change.operation}`, data: { projectId: record.id, generation: project.generation, operation: change.operation,
        revision: project.acceptedRevision, actor: change.actor, at: change.at } }, ...testWrites.map(write => write.event)] })
    return project
  }
  async get(id: string, generation?: number) { return this.ledger.replay((await this.read(id)).record, generation) }
  async list() {
    return (await this.journal.records('projects', 1000)).map(row => {
      const { revisions: _r, proposals: _p, changes: _c, ...summary } = this.ledger.replay(this.decode(row).record)
      return summary
    })
  }
  /** Internal metadata read; a coherent cross-domain report holds the shared domain gate. */
  async activity() {
    return (await this.journal.records('projects', 1000)).map(row => {
      const { record } = this.decode(row)
      return activityProject(this.ledger.replay(record), Boolean(record.vendorImport))
    })
  }
  async diff(id: string, from: string, to: string) { return this.ledger.diff((await this.read(id)).record, from, to) }
  private async readDeletion(id: string): Promise<ProjectDeletion> {
    if (!z.uuid().safeParse(id).success) throw new WorkflowRuntimeError('invalid-command')
    const row = await this.journal.get('project-deletions', id), project = await this.journal.get('projects', id)
    if (!row) {
      if (project?.deleted) throw new WorkflowRuntimeError('corrupt')
      throw new WorkflowRuntimeError('not-found')
    }
    const parsed = storedDeletion.safeParse(row.value)
    if (row.deleted || row.version !== '1' || !parsed.success || parsed.data.receipt.id !== id
      || !project?.deleted || project.version !== String(BigInt(parsed.data.projectVersion) + 1n)) throw new WorkflowRuntimeError('corrupt')
    const evidence = await this.journal.events('0', 2, ['project-deletions'], id)
    if (evidence.events.length !== 1 || evidence.events[0]!.kind !== 'project-deleted'
      || !isDeepStrictEqual(evidence.events[0]!.data, parsed.data.receipt)) throw new WorkflowRuntimeError('corrupt')
    return parsed.data.receipt
  }
  deletion(id: string) { return this.mutate(() => this.readDeletion(id)) }
  deletions(after?: string, limit = 100) {
    return this.mutate(async () => {
      const page = await this.journal.page('project-deletions', after, limit), deletions = []
      for (const row of page.records) deletions.push(await this.readDeletion(row.key))
      return { deletions, nextCursor: page.nextCursor }
    })
  }
  /** No cascade. Guard every retained reference and atomically retain a receipt alongside the project tombstone. */
  deleteArchived(value: z.infer<typeof deleteCommandSchema>) {
    const parsed = deleteCommandSchema.safeParse(value)
    if (!parsed.success) throw new WorkflowRuntimeError('invalid-command')
    const command = parsed.data
    return this.mutate(async () => {
      const before = await this.read(command.id), project = this.ledger.replay(before.record)
      if (!project.archived || project.generation !== command.expectedGeneration) throw new WorkflowRuntimeError('conflict')
      await requireUnreferencedProject(this.journal, project.id, this.limits, this.maxRecordBytes)
      if (await this.journal.count('project-deletions') >= 10000) throw new WorkflowRuntimeError('limit')
      const now = new Date().toISOString(), receipt: ProjectDeletion = { schemaVersion: 1, id: project.id,
        generation: project.generation, revision: project.acceptedRevision, actor: command.actor,
        at: now < project.updatedAt ? project.updatedAt : now, status: 'deleted' }
      await this.journal.commit({ id: randomUUID(), changes: [
        { operation: 'delete', collection: 'projects', key: project.id, expectedVersion: before.version },
        { operation: 'put', collection: 'project-deletions', key: project.id, expectedVersion: '0',
          value: { format: 'jevable.pg-project-deletion/v1', projectVersion: before.version, receipt } },
      ], events: [
        { collection: 'projects', key: project.id, kind: 'project-deleted', data: { ...receipt } },
        { collection: 'project-deletions', key: project.id, kind: 'project-deleted', data: { ...receipt } },
      ] })
      return receipt
    })
  }
  async export(id: string, expectedGeneration: number, reviewedRevision: string, history = false, includeTests = false) {
    if (typeof includeTests !== 'boolean') throw new WorkflowRuntimeError('invalid-command')
    // All typed mutations on this owner queue behind the complete read, not between its pages.
    return this.mutate(async () => {
      const record = (await this.read(id)).record
      const base = this.ledger.export(record, expectedGeneration, reviewedRevision, history)
      if (!includeTests) return base
      if (await this.journal.count('test-cases') > 10000) throw new WorkflowRuntimeError('limit')
      const tests: TransferredTests = { scope: 'accepted-revision-latest-definitions', excludedOtherRevisions: 0, cases: [] }
      let after: string | undefined, bytes = Buffer.byteLength(JSON.stringify(base))
      do {
        const page = await this.journal.page('test-cases', after)
        for (const row of page.records) {
          const test = this.tests.select(await decodePostgresTest(row, this.tests, (key, generation) => this.get(key, generation), this.maxRecordBytes))
          if (test.definition.project.id !== id) continue
          if (test.definition.project.revision !== reviewedRevision) { tests.excludedOtherRevisions++; continue }
          if (test.archived) { tests.excludedArchived = (tests.excludedArchived ?? 0) + 1; continue }
          const item = { source: { id: test.id, generation: test.generation, sha256: test.sha256 }, status: test.status, definition: test.definition }
          bytes += Buffer.byteLength(JSON.stringify(item)) + 1
          if (tests.cases.length >= 1000 || bytes > this.maxRecordBytes) throw new WorkflowRuntimeError('limit')
          tests.cases.push(item)
        }
        after = page.nextCursor ?? undefined
      } while (after !== undefined)
      return this.ledger.export(record, expectedGeneration, reviewedRevision, history,
        parseTest(transferredTestsSchema, tests, this.maxRecordBytes))
    })
  }
  inspectImport(json: string) { return this.ledger.inspectImport(json) }
  vendorImport(id: string, inspect = false) {
    return this.mutate(async () => this.ledger.vendorImport((await this.read(id)).record, inspect))
  }
  createVendorImport(value: VendorImportCommand) {
    const parsed = vendorImportCommandSchema.safeParse(value)
    if (!parsed.success) throw new WorkflowRuntimeError('invalid-command')
    return this.mutate(async () => {
      const row = await this.journal.get('projects', parsed.data.id)
      if (row?.deleted) throw new WorkflowRuntimeError('conflict')
      const result = this.ledger.createVendorImport(parsed.data, row ? this.decode(row).record : undefined)
      if (result.replayed) return result.project
      await this.createSlot(result.record.id)
      return this.save(result.record, '0')
    })
  }
  import(json: string, reviewedSha256: string, actor: string, newId?: string) {
    const { record, project, bundle } = this.ledger.prepareImport(json, reviewedSha256, actor, newId, true)
    const pin = { id: project.id, generation: project.generation, revision: project.acceptedRevision }
    const writes = (bundle.version === 2 ? bundle.tests.cases : []).map(item => {
      const prepared = this.tests.prepare(parseTest(testCommandSchema, { operation: 'create', actor: record.changes.at(-1)!.actor,
        definition: { ...item.definition, project: pin } }), undefined,
      { bundleSha256: reviewedSha256, source: item.source, project: item.definition.project, status: item.status })
      this.tests.validate(prepared.test.definition, project, true, true)
      return postgresTestWrite(prepared.record, '0', this.maxRecordBytes)
    })
    return this.mutate(async () => {
      await this.createSlot(record.id)
      if (writes.length && await this.journal.count('test-cases') + writes.length > 10000) throw new WorkflowRuntimeError('limit')
      for (const write of writes) if ((await this.journal.testCaseIdentity(write.change.key)).retained) throw new WorkflowRuntimeError('conflict')
      return this.save(record, '0', writes)
    })
  }
  execute(value: ProjectCommand) {
    const command = this.ledger.command(value)
    return this.mutate(async () => {
      const before = command.operation === 'create' ? undefined : await this.read(command.id)
      const { record } = this.ledger.apply(command, before?.record)
      const creates = command.operation === 'create' || command.operation === 'duplicate'
      if (creates) await this.createSlot(record.id)
      return this.save(record, creates ? '0' : before!.version)
    })
  }
}

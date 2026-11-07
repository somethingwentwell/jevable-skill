import { z } from 'zod'
import { PostgresJournal, JournalError } from '../storage/postgres.ts'
import { DEFAULT_COMPILER_LIMITS } from '../limits.ts'
import { admitWorkflowData, type WorkflowCompilerLimits } from '../workflow/index.ts'
import { PostgresProjectStore } from '../projects/postgres-store.ts'
import { PostgresReleaseStore } from '../releases/postgres-store.ts'
import { PostgresTestStore } from '../testing/postgres-store.ts'
import { PostgresProviderStore } from '../providers/postgres-store.ts'
import { ConfiguredModels } from '../providers/model-calls.ts'
import { localRunSchema, stoppedCheckpoint, type LocalRun } from './run-types.ts'
import { RunLedger } from './run-ledger.ts'
import { verifyModelResults, type RunCheckpoint } from './run-evaluator.ts'
import { runEventKind } from './run-transition.ts'
import { WorkflowRuntimeError } from './errors.ts'
import { PostgresGrantStore } from '../access/postgres-grants.ts'
import { reviewerGrantIds, verifyReviewerBatchIdentity } from '../access/reviewer.ts'
import { verifyCallerCancellationBatchIdentity } from '../access/caller-cancellation.ts'
import { verifyCallerControlBatchIdentity } from '../access/caller-control.ts'

const serial = z.string().regex(/^(0|[1-9][0-9]{0,18})$/u).refine(value => BigInt(value) < 9223372036854775806n)
const envelope = z.strictObject({ format: z.literal('jevable.pg-run/v1'), record: localRunSchema })
const eventEnvelope = z.strictObject({ format: z.literal('jevable.pg-run-event/v1'), version: serial, at: z.iso.datetime(), data: z.json() })
export interface PostgresRunEvent { sequence: string; version: string; kind: z.infer<typeof runEventKind>; at: string; data: unknown }

/** Internal verified reads; caller must hold the shared domain queue for a coherent read/guard/write operation. */
export class PostgresRunReader {
  private readonly projects: PostgresProjectStore
  private readonly releases: PostgresReleaseStore
  private readonly tests: PostgresTestStore
  private readonly models: ConfiguredModels
  private readonly ledger: RunLedger
  private readonly grants: PostgresGrantStore
  constructor(private readonly journal: PostgresJournal, private readonly limits: WorkflowCompilerLimits = DEFAULT_COMPILER_LIMITS,
    private readonly maxRecordBytes = 4_000_000) {
    if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1024 || maxRecordBytes > 16_000_000) throw new WorkflowRuntimeError('invalid-command')
    this.projects = new PostgresProjectStore(journal, limits.source, maxRecordBytes, limits)
    this.releases = new PostgresReleaseStore(journal, maxRecordBytes)
    this.tests = new PostgresTestStore(journal, limits, maxRecordBytes)
    this.models = new ConfiguredModels(new PostgresProviderStore(journal, maxRecordBytes))
    this.ledger = new RunLedger(limits)
    this.grants = new PostgresGrantStore(journal)
  }
  private parse<T>(schema: z.ZodType<T>, value: unknown, corrupt = false): T {
    try { return schema.parse(admitWorkflowData(value, { maxBytes: this.maxRecordBytes, maxDepth: 64, maxValues: 100000 })) }
    catch { throw new WorkflowRuntimeError(corrupt ? 'corrupt' : 'invalid-command') }
  }
  private async history(id: string): Promise<PostgresRunEvent[]> {
    const events: PostgresRunEvent[] = []; let cursor = '0', bytes = 0
    while (true) {
      const page = await this.journal.events(cursor, 200, ['runs'], id)
      if (!page.events.length) return events
      for (const item of page.events) {
        const value = this.parse(eventEnvelope, item.data, true), kind = runEventKind.safeParse(item.kind)
        if (!kind.success || value.version !== String(events.length + 1)) throw new WorkflowRuntimeError('corrupt')
        verifyReviewerBatchIdentity(kind.data, value.data, item.batchId)
        verifyCallerCancellationBatchIdentity(kind.data, value.data, item.batchId)
        verifyCallerControlBatchIdentity(kind.data, value.data, item.batchId)
        bytes += Buffer.byteLength(JSON.stringify(item.data))
        if (events.length >= 50000 || bytes > 64_000_000) throw new WorkflowRuntimeError('limit')
        events.push({ sequence: item.sequence, version: value.version, kind: kind.data, at: value.at, data: value.data })
      }
      cursor = page.cursor
    }
  }
  async checked(record: LocalRun, events: readonly { kind: string; data: unknown }[], current = false) {
    const project = record.project ? await this.projects.get(record.project.id, current ? undefined : record.project.generation) : undefined
    const release = record.release ? await this.releases.get(record.release.id) : undefined
    const test = record.test ? await this.tests.get(record.test.id, current ? undefined : record.test.generation) : undefined
    if (current) {
      if (test?.archived) throw new WorkflowRuntimeError('archived')
      if (project?.archived) throw new WorkflowRuntimeError('archived')
      if (project && (project.generation !== record.project?.generation || project.acceptedRevision !== record.revision)) throw new WorkflowRuntimeError('conflict')
      if (test && (test.status !== 'accepted' || test.generation !== record.test?.generation || test.sha256 !== record.test?.sha256)) throw new WorkflowRuntimeError('conflict')
    }
    const grant = record.caller ? await this.grants.metadataForReplay(record.caller.grantId) : undefined
    const reviewerGrants = []
    for (const id of reviewerGrantIds(record, events)) reviewerGrants.push(await this.grants.metadataForReplay(id))
    const graph = this.ledger.check(record, { events, reviewerGrants, ...(project ? { project } : {}), ...(release ? { release } : {}), ...(test ? { test } : {}), ...(grant ? { grant } : {}) })
    const state = stoppedCheckpoint(record.state)
    await verifyModelResults(graph, state.status === 'waiting' || state.status === 'executing'
      ? { status: 'paused', steps: state.steps, next: state.next, ...(state.scope ? { scope: state.scope } : {}) } : state as RunCheckpoint, this.models)
    return graph
  }
  async read(id: string) {
    if (!z.uuid().safeParse(id).success) throw new WorkflowRuntimeError('invalid-command')
    const row = await this.journal.get('runs', id)
    if (!row || row.deleted) throw new WorkflowRuntimeError('not-found')
    try {
      const record = this.parse(envelope, row.value, true).record as LocalRun, events = await this.history(id)
      if (record.id !== id || row.version !== String(events.length) || record.updatedAt !== events.at(-1)?.at) throw new WorkflowRuntimeError('corrupt')
      const graph = await this.checked(record, events)
      return { record, version: row.version, events, graph }
    } catch (error) { if (error instanceof JournalError || error instanceof WorkflowRuntimeError && error.code === 'limit') throw error; throw new WorkflowRuntimeError('corrupt') }
  }
}

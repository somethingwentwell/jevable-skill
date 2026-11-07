import { z } from 'zod'
import { JournalError, type JournalBatch } from '../storage/postgres.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import type { TestRecord, TestLedger } from './ledger.ts'
import type { Project } from '../projects/ledger.ts'

const savedCase = z.strictObject({ format: z.literal('jevable.pg-test/v1'), record: z.unknown() })

/** Shared replay checks for direct reads and coherent project/test export. */
export async function decodePostgresTest(row: { key: string; version: string; value: unknown }, ledger: TestLedger,
  project: (id: string, generation: number) => Promise<Project>, maxRecordBytes: number): Promise<TestRecord> {
  try {
    if (Buffer.byteLength(JSON.stringify(row.value)) > maxRecordBytes) throw new WorkflowRuntimeError('corrupt')
    const envelope = savedCase.parse(row.value), record = ledger.decode(envelope.record, row.key, Number(row.version))
    if (row.version !== String(record.versions.length)) throw new WorkflowRuntimeError('corrupt')
    if (record.importedFrom) {
      const pin = record.versions[0]!.definition.project
      ledger.validateImport(record, await project(pin.id, pin.generation))
    }
    for (const version of record.versions) {
      const pin = version.definition.project
      ledger.validate(version.definition, await project(pin.id, pin.generation), false)
    }
    return record
  } catch (error) {
    if (error instanceof JournalError) throw error
    throw new WorkflowRuntimeError('corrupt')
  }
}

/** Shared encoding for ordinary case writes and atomic project/test imports. Does not commit. */
export function postgresTestWrite(record: TestRecord, expectedVersion: string, maxRecordBytes: number) {
  const test = record.versions.at(-1)!, value = { format: 'jevable.pg-test/v1', record }
  if (Buffer.byteLength(JSON.stringify(value)) > maxRecordBytes) throw new WorkflowRuntimeError('limit')
  const change: JournalBatch['changes'][number] = { operation: 'put', collection: 'test-cases', key: record.id,
    expectedVersion, value: z.json().parse(value) }
  const event: JournalBatch['events'][number] = { collection: 'test-cases', key: record.id, kind: `test-${test.operation}`,
    data: { testId: record.id, generation: test.generation, sha256: test.sha256, status: test.status,
      ...(test.archived === undefined ? {} : { archived: test.archived }),
      projectId: test.definition.project.id, projectGeneration: test.definition.project.generation,
      revision: test.definition.project.revision, actor: test.actor, at: test.at } }
  return { change, event }
}

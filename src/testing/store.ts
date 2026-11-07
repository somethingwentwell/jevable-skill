import type { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { ProjectStore } from '../projects/store.ts'
import { compileWorkflowYaml, type WorkflowCompilerLimits } from '../workflow/index.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { parseTest, testCommandSchema, type TestDefinition, type TestCommand, type TestCase, type ImportedTest, type TransferredTests } from './schema.ts'
import { TestLedger } from './ledger.ts'
import { generateTestsSchema, type GenerateTestsRequest, type TestGeneration } from './generation-schema.ts'
import { generateInputs } from './generate.ts'
import { triggerMetadata } from '../runtime/trigger.ts'
import { validateTestTriggerMode } from './validate.ts'
import { localRunSchema } from '../runtime/run-types.ts'
import { reviewTestErasure } from './erasure.ts'
import { testErasureRequestSchema, savedTestErasureSchema, testErasureReceiptHash, prepareTestErasureReceipt,
  verifyTestErasureRetry, type TestErasureRequest, type TestErasureReceipt } from './erasure-write.ts'

/** Append-only case versions. Acceptance never executes; past accepted definitions remain available to runs. */
export class TestStore {
  private readonly projects: ProjectStore
  private readonly ledger: TestLedger
  constructor(private readonly db: DatabaseSync, private readonly limits: WorkflowCompilerLimits, private readonly maxBytes: number) {
    this.projects = new ProjectStore(db, limits.source, maxBytes)
    this.ledger = new TestLedger(limits, maxBytes)
  }

  private validate(definition: TestDefinition, current: boolean, allowArchived = false) {
    const pin = definition.project, project = this.projects.get(pin.id, current ? undefined : pin.generation)
    this.ledger.validate(definition, project, current, allowArchived)
  }

  private read(id: string) {
    const row = this.db.prepare('SELECT generation,record FROM test_cases WHERE id=?').get(id) as { generation: number; record: string } | undefined
    if (!row) throw new WorkflowRuntimeError('not-found')
    try {
      if (Buffer.byteLength(row.record) > this.maxBytes) throw new Error()
      const record = this.ledger.decode(JSON.parse(row.record), id, row.generation)
      if (record.importedFrom) {
        const pin = record.versions[0]!.definition.project
        this.ledger.validateImport(record, this.projects.get(pin.id, pin.generation))
      }
      for (const version of record.versions) this.validate(version.definition, false)
      return record
    } catch { throw new WorkflowRuntimeError('corrupt') }
  }

  get(id: string, generation?: number): TestCase {
    return this.ledger.select(this.read(id), generation)
  }
  list() {
    return (this.db.prepare('SELECT id FROM test_cases ORDER BY rowid').all() as { id: string }[]).map(({ id }) => {
      const item = this.get(id)
      return { id, generation: item.generation, title: item.definition.title, project: item.definition.project,
        ...(item.archived === undefined ? {} : { archived: item.archived }),
        status: item.status, sha256: item.sha256, actor: item.actor, at: item.at }
    })
  }
  history(id: string) { return this.read(id) }
  erasure(requestId: string): TestErasureReceipt {
    const id = parseTest(z.uuid().transform(value => value.toLowerCase()), requestId, 4096)
    const row = this.db.prepare('SELECT request_id,test_id,record FROM test_erasures WHERE request_id=?').get(id) as
      { request_id: string; test_id: string; record: string } | undefined
    if (!row) throw new WorkflowRuntimeError('not-found')
    try {
      const saved = parseTest(savedTestErasureSchema, JSON.parse(row.record), 8192), receipt = saved.receipt
      if (receipt.requestId !== row.request_id || receipt.test.id !== row.test_id || saved.sha256 !== testErasureReceiptHash(receipt)
        || this.db.prepare('SELECT id FROM test_cases WHERE lower(id)=lower(?)').get(receipt.test.id)) throw new Error()
      const project = this.projects.get(receipt.project.id, receipt.project.generation)
      if (project.acceptedRevision !== receipt.project.revision) throw new Error()
      return receipt
    } catch { throw new WorkflowRuntimeError('corrupt') }
  }
  /** Retained metadata remains a project reference even though unused draft payloads are removed. */
  erasures() {
    const rows = this.db.prepare('SELECT request_id FROM test_erasures ORDER BY request_id LIMIT 10001').all() as { request_id: string }[]
    if (rows.length > 10000) throw new WorkflowRuntimeError('limit')
    return rows.map(row => this.erasure(row.request_id))
  }
  private erasureReferences(id: string) {
    if ((this.db.prepare('SELECT count(*) AS count FROM runs').get() as { count: number }).count > 100000) throw new WorkflowRuntimeError('limit')
    const rows = this.db.prepare('SELECT id,record FROM runs').iterate() as IterableIterator<{ id: string; record: string }>
    let runs = 0
    for (const row of rows) {
      try {
        if (Buffer.byteLength(row.record) > this.maxBytes) throw new Error()
        const run = parseTest(localRunSchema, JSON.parse(row.record), this.maxBytes)
        if (run.id !== row.id) throw new Error()
        if (run.test?.id.toLowerCase() === id.toLowerCase()) runs++
      } catch { throw new WorkflowRuntimeError('corrupt') }
    }
    const batches = this.db.prepare('SELECT id FROM test_generations ORDER BY id LIMIT 10001').all() as { id: string }[]
    if (batches.length > 10000) throw new WorkflowRuntimeError('limit')
    let generationBatches = 0
    for (const batch of batches) if (this.generation(batch.id).snapshot.cases.some(item => item.id.toLowerCase() === id.toLowerCase())) generationBatches++
    const aliases = this.db.prepare('SELECT count(*) AS count FROM test_cases WHERE lower(id)=lower(?) AND id<>?').get(id, id) as { count: number }
    return { runs, generationBatches, otherReferences: aliases.count }
  }
  /** Atomic single-owner logical removal. Only unused archived manual drafts can lose their definitions. */
  erase(value: TestErasureRequest): TestErasureReceipt {
    const command = parseTest(testErasureRequestSchema, value, 4096)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (this.db.prepare('SELECT request_id FROM test_erasures WHERE request_id=?').get(command.requestId)) {
        const receipt = this.erasure(command.requestId); verifyTestErasureRetry(receipt, command)
        this.db.exec('COMMIT'); return receipt
      }
      if (this.db.prepare('SELECT request_id FROM test_erasures WHERE lower(test_id)=lower(?)').get(command.test.id)) throw new WorkflowRuntimeError('conflict')
      const record = this.read(command.test.id)
      const review = reviewTestErasure(record, { test: command.test, reviewedHistorySha256: command.reviewedHistorySha256 },
        this.erasureReferences(record.id), this.limits, this.maxBytes)
      if (review.reasons.includes('not-archived')) throw new WorkflowRuntimeError('conflict')
      if (!review.eligible) throw new WorkflowRuntimeError('referenced')
      if ((this.db.prepare('SELECT count(*) AS count FROM test_erasures').get() as { count: number }).count >= 10000) throw new WorkflowRuntimeError('limit')
      const receipt = prepareTestErasureReceipt(command, record)
      const saved = { format: 'jevable.test-erasure/v1', receipt, sha256: testErasureReceiptHash(receipt) }
      this.db.prepare('INSERT INTO test_erasures(request_id,test_id,record) VALUES(?,?,?)').run(command.requestId, receipt.test.id, JSON.stringify(saved))
      const result = this.db.prepare('DELETE FROM test_cases WHERE id=? AND generation=?').run(receipt.test.id, receipt.test.generation)
      if (result.changes !== 1) throw new WorkflowRuntimeError('conflict')
      this.db.exec('COMMIT'); return receipt
    } catch (error) { try { this.db.exec('ROLLBACK') } catch { /* A committed but unacknowledged write is inspected by its retained request. */ } throw error }
  }
  /** Called inside the project-import transaction; savepoint never commits the surrounding project. */
  importDrafts(tests: TransferredTests, project: TestDefinition['project'], bundleSha256: string, actor: string) {
    this.db.exec('SAVEPOINT imported_test_drafts')
    try {
      const result = tests.cases.map(item => this.apply(parseTest(testCommandSchema, { operation: 'create', actor,
        definition: { ...item.definition, project } }), { bundleSha256, source: item.source, project: item.definition.project, status: item.status }))
      this.db.exec('RELEASE imported_test_drafts'); return result
    } catch (error) { this.db.exec('ROLLBACK TO imported_test_drafts; RELEASE imported_test_drafts'); throw error }
  }
  execute(value: TestCommand): TestCase {
    const command = parseTest(testCommandSchema, value)
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = this.apply(command); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private apply(command: TestCommand, importedFrom?: ImportedTest): TestCase {
    const previous = command.operation === 'create' ? undefined : this.read(command.id)
    const { record, test } = this.ledger.prepare(command, previous, importedFrom)
    if (command.operation === 'create') {
      if (this.db.prepare('SELECT id FROM test_cases WHERE lower(id)=lower(?) UNION ALL SELECT test_id AS id FROM test_erasures WHERE lower(test_id)=lower(?)')
        .get(test.id, test.id)) throw new WorkflowRuntimeError('conflict')
      if ((this.db.prepare('SELECT count(*) AS count FROM test_cases').get() as { count: number }).count >= 10000) throw new WorkflowRuntimeError('limit')
    }
    this.validate(test.definition, command.operation !== 'archive', importedFrom !== undefined)
    this.db.prepare('INSERT INTO test_cases(id,generation,record) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,record=excluded.record')
      .run(test.id, test.generation, JSON.stringify(record))
    return test
  }

  generation(id: string): TestGeneration {
    const row = this.db.prepare('SELECT record FROM test_generations WHERE id=?').get(id) as { record: string } | undefined
    if (!row) throw new WorkflowRuntimeError('not-found')
    try {
      if (Buffer.byteLength(row.record) > this.maxBytes) throw new Error()
      const result = this.ledger.decodeGeneration(JSON.parse(row.record), id), snapshot = result.snapshot
      const pin = snapshot.request.project
      this.ledger.validateGenerationProject(snapshot, this.projects.get(pin.id, pin.generation))
      for (const item of snapshot.cases) this.ledger.validateGeneratedCase(snapshot, item, this.get(item.id, 1))
      return result
    } catch { throw new WorkflowRuntimeError('corrupt') }
  }
  generations() {
    return (this.db.prepare('SELECT id FROM test_generations ORDER BY rowid').all() as { id: string }[]).map(({ id }) => this.generation(id))
  }

  /** The batch and all new drafts commit together; a caller-retained UUID is its retry identity. */
  generate(value: GenerateTestsRequest): TestGeneration {
    const { id, actor, ...request } = parseTest(generateTestsSchema, value)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (this.db.prepare('SELECT id FROM test_generations WHERE id=?').get(id)) {
        const previous = this.generation(id)
        if (!isDeepStrictEqual(previous.snapshot.request, request)) throw new WorkflowRuntimeError('conflict')
        this.db.exec('COMMIT'); return previous
      }
      if ((this.db.prepare('SELECT count(*) AS count FROM test_generations').get() as { count: number }).count >= 10000) throw new WorkflowRuntimeError('limit')
      const project = this.projects.get(request.project.id)
      if (project.archived) throw new WorkflowRuntimeError('archived')
      if (project.generation !== request.project.generation || project.acceptedRevision !== request.project.revision) throw new WorkflowRuntimeError('conflict')
      const graph = compileWorkflowYaml(project.revisions.find(item => item.revision === project.acceptedRevision)!.yaml, this.limits)
      validateTestTriggerMode(request.triggerMode, graph)
      const generated = generateInputs(graph.input, this.limits.binding.data, request.limit)
      const cases = generated.candidates.map((candidate, index) => {
        const test = this.apply(parseTest(testCommandSchema, { operation: 'create', actor, definition: {
          title: `Generated case ${index + 1} (${candidate.reason})`, project: request.project, input: candidate.input,
          expectations: [{ kind: 'status', value: 'completed' }], ...triggerMetadata(request) } }))
        return { id: test.id, generation: 1 as const, sha256: test.sha256, definition: test.definition, reason: candidate.reason, path: candidate.path }
      })
      const result = this.ledger.prepareGeneration(id, actor, request, generated, cases), encoded = JSON.stringify(result)
      this.db.prepare('INSERT INTO test_generations(id,record) VALUES(?,?)').run(id, encoded)
      this.db.exec('COMMIT'); return result
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
}

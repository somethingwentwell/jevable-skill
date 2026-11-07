import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { z } from 'zod'
import type { Project } from '../projects/ledger.ts'
import { compileWorkflowYaml, type WorkflowCompilerLimits } from '../workflow/index.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { parseTest, testRecordSchema, testHash, type TestDefinition, type TestCommand, type TestCase, type TestVersion, type ImportedTest } from './schema.ts'
import { validateTestSource } from './validate.ts'
import { generationSnapshotSchema, generationHash, type TestGeneration, type TestGenerationSnapshot } from './generation-schema.ts'
import { GENERATOR_VERSION, type generateInputs } from './generate.ts'

export type TestRecord = z.infer<typeof testRecordSchema>

/** Backend-independent test review and historical evidence rules. Never executes a workflow. */
export class TestLedger {
  constructor(private readonly limits: WorkflowCompilerLimits, private readonly maxBytes: number) {}
  validate(definition: TestDefinition, project: Project, current: boolean, allowArchived = false) {
    const pin = definition.project
    if (current && project.archived && !allowArchived) throw new WorkflowRuntimeError('archived')
    if (project.id !== pin.id || project.generation !== pin.generation || project.acceptedRevision !== pin.revision) throw new WorkflowRuntimeError('conflict')
    const graph = compileWorkflowYaml(project.revisions.find(item => item.revision === pin.revision)!.yaml, this.limits)
    validateTestSource(definition, graph, this.limits)
  }
  decode(value: unknown, id: string, generation: number): TestRecord {
    try {
      const record = parseTest(testRecordSchema, value, this.maxBytes)
      if (record.id !== id || record.versions.length !== generation) throw new Error()
      if (record.importedFrom) {
        const original = record.versions[0]!, imported = record.importedFrom
        if (imported.source.id === id || original.status !== 'draft' || imported.project.id === original.definition.project.id
          || testHash({ ...original.definition, project: imported.project }) !== imported.source.sha256) throw new Error()
      }
      for (const [index, version] of record.versions.entries()) {
        const before = record.versions[index - 1]
        if (version.generation !== index + 1 || version.sha256 !== testHash(version.definition)
          || version.status !== (version.operation === 'archive' ? before?.status : version.operation === 'accept' ? 'accepted' : 'draft')
          || (index === 0 ? version.operation !== 'create' : version.operation === 'create')
          || (before && (version.at < before.at || version.definition.project.id !== before.definition.project.id))) throw new Error()
        if (version.operation === 'accept' && (!before || before.status !== 'draft' || !isDeepStrictEqual(version.definition, before.definition))) throw new Error()
        if (version.operation === 'archive') {
          if (!before || typeof version.archived !== 'boolean' || version.archived === (before.archived === true)
            || !isDeepStrictEqual(version.definition, before.definition)) throw new Error()
        } else if (version.archived !== undefined || before?.archived === true) throw new Error()
      }
      return record
    } catch { throw new WorkflowRuntimeError('corrupt') }
  }
  validateImport(record: TestRecord, project: Project) {
    const imported = record.importedFrom
    if (imported && !project.changes.some(change => change.operation === 'import' && change.bundleSha256 === imported.bundleSha256
      && change.sourceProjectId === imported.project.id && change.sourceGeneration >= imported.project.generation)) throw new WorkflowRuntimeError('corrupt')
  }
  select(record: TestRecord, generation = record.versions.length): TestCase {
    const version = record.versions[generation - 1]
    if (!version) throw new WorkflowRuntimeError('not-found')
    return { schemaVersion: 1, id: record.id, ...version, ...(record.importedFrom ? { importedFrom: record.importedFrom } : {}) }
  }
  prepare(command: TestCommand, previous?: TestRecord, importedFrom?: ImportedTest) {
    if (command.operation === 'create' && previous) throw new WorkflowRuntimeError('conflict')
    const id = command.operation === 'create' ? command.id ?? randomUUID() : command.id
    if (importedFrom?.source.id === id) throw new WorkflowRuntimeError('conflict')
    const retained = previous ? structuredClone(previous) : undefined, before = retained?.versions.at(-1)
    if (command.operation !== 'create') {
      if (!before || retained!.id !== id) throw new WorkflowRuntimeError('not-found')
      if (command.expectedGeneration !== before.generation) throw new WorkflowRuntimeError('conflict')
    }
    if (before?.archived && command.operation !== 'archive') throw new WorkflowRuntimeError('archived')
    if (command.operation === 'archive' && (before!.sha256 !== command.reviewedSha256 || command.archived === (before!.archived === true))) throw new WorkflowRuntimeError('conflict')
    const definition = structuredClone(command.operation === 'accept' || command.operation === 'archive' ? before!.definition : command.definition)
    if (before && definition.project.id !== before.definition.project.id) throw new WorkflowRuntimeError('conflict')
    if (command.operation === 'accept' && (before!.status !== 'draft' || before!.sha256 !== command.reviewedSha256)) throw new WorkflowRuntimeError('conflict')
    const version: TestVersion = { generation: (before?.generation ?? 0) + 1, operation: command.operation,
      status: command.operation === 'archive' ? before!.status : command.operation === 'accept' ? 'accepted' : 'draft',
      ...(command.operation === 'archive' ? { archived: command.archived } : {}), definition, sha256: testHash(definition), actor: command.actor,
      at: new Date(Math.max(Date.now(), before ? Date.parse(before.at) : 0)).toISOString() }
    const provenance = importedFrom ?? retained?.importedFrom
    const record: TestRecord = { schemaVersion: 1, id, versions: [...retained?.versions ?? [], version],
      ...(provenance ? { importedFrom: structuredClone(provenance) } : {}) }
    if (record.versions.length > 100 || Buffer.byteLength(JSON.stringify(record)) > this.maxBytes) throw new WorkflowRuntimeError('limit')
    return { record, test: this.select(record) }
  }
  decodeGeneration(value: { snapshot: unknown; sha256: unknown }, id: string): TestGeneration {
    try {
      if (Buffer.byteLength(JSON.stringify(value)) > this.maxBytes) throw new Error()
      const snapshot = parseTest(generationSnapshotSchema, value.snapshot, this.maxBytes)
      if (snapshot.id !== id || generationHash(snapshot) !== value.sha256 || snapshot.cases.length > snapshot.request.limit
        || snapshot.status !== (snapshot.cases.length ? 'review-required' : 'no-candidates')
        || new Set(snapshot.cases.map(item => item.id)).size !== snapshot.cases.length
        || snapshot.diagnostics.totalInputBytes !== snapshot.cases.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item.definition.input)), 0)
        || snapshot.diagnostics.attempted < snapshot.cases.length || (snapshot.diagnostics.noSeed && snapshot.cases.length)) throw new Error()
      return { snapshot, sha256: value.sha256 as string }
    } catch { throw new WorkflowRuntimeError('corrupt') }
  }
  validateGenerationProject(snapshot: TestGenerationSnapshot, project: Project) {
    if (project.id !== snapshot.request.project.id || project.generation !== snapshot.request.project.generation
      || project.archived || project.acceptedRevision !== snapshot.request.project.revision) throw new WorkflowRuntimeError('corrupt')
  }
  validateGeneratedCase(snapshot: TestGenerationSnapshot, item: TestGenerationSnapshot['cases'][number], original: TestCase) {
    if (original.id !== item.id || original.operation !== 'create' || original.status !== 'draft' || original.sha256 !== item.sha256
      || original.actor !== snapshot.actor || !isDeepStrictEqual(original.definition, item.definition)
      || !isDeepStrictEqual(item.definition.project, snapshot.request.project)
      || item.definition.triggerMode !== snapshot.request.triggerMode) throw new WorkflowRuntimeError('corrupt')
  }
  prepareGeneration(id: string, actor: string, request: TestGenerationSnapshot['request'], generated: ReturnType<typeof generateInputs>, cases: TestGenerationSnapshot['cases']): TestGeneration {
    const snapshot = parseTest(generationSnapshotSchema, { schemaVersion: 1, format: 'jevable.ai/test-generation', id,
      generator: GENERATOR_VERSION, createdAt: new Date().toISOString(), actor, request,
      status: cases.length ? 'review-required' : 'no-candidates', execution: 'not-run',
      expectations: 'completion-suggestion-only; review-before-acceptance', coverage: 'schema-samples-not-branch-proof',
      diagnostics: generated.diagnostics, cases }, this.maxBytes)
    const result = { snapshot, sha256: generationHash(snapshot) }
    if (Buffer.byteLength(JSON.stringify(result)) > this.maxBytes) throw new WorkflowRuntimeError('limit')
    return result
  }
}

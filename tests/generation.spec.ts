import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { generateInputs, GENERATION_LIMITS } from '../src/testing/generate.ts'
import { compileValueSchema, validateWorkflowValue, type WorkflowValueSchemaDefinition } from '../src/workflow/index.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { LocalRuntime } from '../src/runtime/index.ts'
import { main } from '../src/cli.ts'

const limits = DEFAULT_COMPILER_LIMITS.binding.data
function samples(schema: unknown, count = 32) {
  const compiled = compileValueSchema(schema, DEFAULT_COMPILER_LIMITS.schema)
  const generated = generateInputs(compiled, limits, count)
  for (const item of generated.candidates) expect(validateWorkflowValue(compiled, item.input, limits)).toEqual(item.input)
  expect(new Set(generated.candidates.map(item => JSON.stringify(item.input))).size).toBe(generated.candidates.length)
  return generated
}
const cleanup: LocalRuntime[] = []
afterEach(async () => { for (const runtime of cleanup.splice(0)) await runtime.close() })
const echo = JSON.parse(JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'generated', name: 'Generated fixture' },
  spec: { inputSchema: { type: 'boolean' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
    end: { type: 'output', config: { value: '${{ inputs }}' } } }, edges: [{ from: 'start', to: 'end' }] } }))
async function fixture(schema: unknown = { type: 'boolean' }) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-generation-')), runtime = await LocalRuntime.open({ dataDirectory: directory })
  cleanup.push(runtime)
  const project = runtime.editProject({ operation: 'create', yaml: JSON.stringify({ ...echo, spec: { ...echo.spec, inputSchema: schema } }), title: 'Fixture', actor: 'local:author' })
  const request = { id: randomUUID(), project: { id: project.id, generation: 1, revision: project.acceptedRevision }, actor: 'local:generator', limit: 12 }
  return { directory, runtime, project, request }
}

describe('bounded schema candidate generation', () => {
  it.each([
    { schema: { type: 'boolean' }, expected: [true, false] },
    { schema: { type: 'null' }, expected: [null] },
    { schema: { type: 'integer', minimum: 2.2, maximum: 5.9 }, expected: [3, 5] },
    { schema: { type: 'number', minimum: -1.5, maximum: 2.5 }, expected: [0, -1.5, 2.5] },
    { schema: { type: 'string', minLength: 1, maxLength: 3 }, expected: ['sam', 'x', 'xxx'] },
    { schema: { type: 'string', enum: ['A', 'B'] }, expected: ['A', 'B'] },
  ])('generates valid unique scalar boundaries: $schema', ({ schema, expected }) => {
    expect(samples(schema).candidates.map(item => item.input)).toEqual(expected)
  })

  it('varies nested properties, enum values and optional omissions in stable order', () => {
    const schema = { type: 'object', required: ['nested'], additionalProperties: false, properties: {
      nested: { type: 'object', required: ['choice'], properties: { choice: { type: 'string', enum: ['first', 'second'] } } },
      flag: { type: 'boolean' }, number: { type: 'integer', minimum: 1, maximum: 9 } } }
    const first = samples(schema), second = samples(schema)
    expect(first).toEqual(second)
    expect(first.candidates.some(c => c.path === '/nested/choice' && c.reason === 'enum' && JSON.stringify(c.input).includes('second'))).toBe(true)
    expect(first.candidates.some(c => c.reason === 'optional-omitted' && c.path === '/flag')).toBe(true)
    expect(first.candidates.some(c => c.reason === 'maximum' && c.path === '/number')).toBe(true)
  })

  it('covers bounded array lengths and one item variation without aliasing object items', () => {
    const generated = samples({ type: 'array', minItems: 0, maxItems: 3, items: {
      type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } }, additionalProperties: false } })
    expect(new Set(generated.candidates.map(c => (c.input as unknown[]).length))).toEqual(new Set([0, 1, 2, 3]))
    expect(generated.candidates.some(c => c.path === '/0/enabled' && JSON.stringify(c.input).includes('false'))).toBe(true)
  })

  it('can omit impossible optional fields and fall back to an empty array when its items cannot be sampled', () => {
    expect(samples({ type: 'object', properties: { huge: { type: 'string', minLength: 1000000000 } } }).candidates[0]!.input).toEqual({})
    expect(samples({ type: 'array', items: { type: 'string', minLength: 1000000000 } }).candidates[0]!.input).toEqual([])
  })

  it('preserves compiler rejection of undeclared required properties, duplicate enums and reserved keys', () => {
    for (const schema of [
      { type: 'object', required: ['extra'] },
      { type: 'object', required: ['extra'], additionalProperties: false },
      { type: 'string', enum: ['A', 'A', 'B'] },
      { type: 'object', properties: { constructor: { type: 'string' } }, required: ['constructor'] },
    ]) expect(() => samples(schema)).toThrow()
  })

  it('respects enum type/length constraints, Unicode code points and tiny value budgets', () => {
    expect(samples({ type: 'string', minLength: 1, maxLength: 1, enum: ['too-long', '😀', 7] }).candidates.map(c => c.input)).toEqual(['😀'])
    const compiled = compileValueSchema({ type: 'string' }, DEFAULT_COMPILER_LIMITS.schema)
    expect(generateInputs(compiled, { ...limits, maxBytes: 2 }).candidates.map(c => c.input)).toEqual([''])
  })

  it.each([
    { type: 'array', minItems: 1000000000, items: { type: 'string' } },
    { type: 'string', minLength: 1000000000 },
  ])('does not allocate impossible inputs %#', schema => {
    expect(samples(schema).candidates).toEqual([])
  })

  it('bounds multiplicative nested arrays before allocation and reports skipped large boundaries', () => {
    let schema: WorkflowValueSchemaDefinition = { type: 'string' }
    for (let index = 0; index < 4; index++) schema = { type: 'array', minItems: 100, maxItems: 100, items: schema }
    const generated = samples(schema)
    expect(generated.candidates).toEqual([]); expect(generated.diagnostics.noSeed).toBe(true)
    const bounded = samples({ type: 'string', maxLength: 1000000000 })
    expect(bounded.diagnostics.skippedBounds).toBeGreaterThan(0)
    expect(bounded.candidates.every(item => Buffer.byteLength(JSON.stringify(item.input)) <= GENERATION_LIMITS.inputBytes)).toBe(true)
  })

  it('enforces candidate and attempt caps, including many invalid enum alternatives', () => {
    const generated = samples({ type: 'integer', enum: Array.from({ length: 1000 }, (_, index) => index) }, 3)
    expect(generated.candidates).toHaveLength(3); expect(generated.diagnostics.limitReached).toBe(true)
    const exhausted = samples({ type: 'string', enum: ['valid', ...Array.from({ length: 1000 }, (_, index) => index)] })
    expect(exhausted.diagnostics.attempted).toBe(GENERATION_LIMITS.attempts)
    expect(exhausted.diagnostics.limitReached).toBe(true)
    expect(() => samples({ type: 'boolean' }, 33)).toThrow('invalid-command')
  })

  it('caps total emitted bytes across independently valid large candidates', () => {
    const generated = samples({ type: 'array', minItems: 200, maxItems: 201,
      items: { type: 'string', enum: Array.from({ length: 40 }, (_, index) => String(index).padEnd(400, 'x')) } })
    expect(generated.candidates.length).toBeGreaterThan(1)
    expect(generated.candidates.length).toBeLessThan(32)
    expect(generated.diagnostics.totalInputBytes).toBeLessThanOrEqual(GENERATION_LIMITS.totalInputBytes)
    expect(generated.diagnostics.skippedBounds).toBeGreaterThan(0)
  })
})

describe('durable generation batches', () => {
  it('commits only drafts, retries by batch ID and recovers identical output after edits and restart', async () => {
    const f = await fixture(), result = f.runtime.generateTests(f.request)
    expect(result.snapshot).toMatchObject({ execution: 'not-run', status: 'review-required', coverage: 'schema-samples-not-branch-proof' })
    expect(result.snapshot.cases.map(c => c.definition.input)).toEqual([true, false])
    expect(f.runtime.list()).toEqual([])
    const first = result.snapshot.cases[0]!
    expect(f.runtime.testCase(first.id).status).toBe('draft')
    f.runtime.editTest({ operation: 'accept', id: first.id, expectedGeneration: 1, reviewedSha256: first.sha256, actor: 'local:reviewer' })
    f.runtime.editProject({ operation: 'rename', id: f.project.id, expectedGeneration: 1, title: 'Renamed', actor: 'local:author' })
    expect(f.runtime.generateTests({ ...f.request, actor: 'local:retry-owner' })).toEqual(result)
    expect(f.runtime.testCases()).toHaveLength(2)
    await f.runtime.close()
    const runtime = await LocalRuntime.open({ dataDirectory: f.directory }); cleanup.push(runtime)
    expect(runtime.testGeneration(f.request.id)).toEqual(result)
    expect(runtime.generateTests(f.request)).toEqual(result)
    expect(runtime.testGenerations()[0]).not.toHaveProperty('cases')
  })

  it('rejects stale revision/generation, archived projects and conflicting request reuse without new drafts', async () => {
    const f = await fixture(); f.runtime.generateTests(f.request)
    expect(() => f.runtime.generateTests({ ...f.request, limit: 1 })).toThrow('conflict')
    expect(() => f.runtime.generateTests({ ...f.request, id: randomUUID(), project: { ...f.request.project, revision: '0'.repeat(64) } })).toThrow('conflict')
    f.runtime.editProject({ operation: 'archive', id: f.project.id, expectedGeneration: 1, archived: true, actor: 'local:author' })
    expect(() => f.runtime.generateTests({ ...f.request, id: randomUUID() })).toThrow('archived')
    expect(f.runtime.testCases()).toHaveLength(2)
  })

  it('retains a truthful empty batch and prevents deletion of its historical source', async () => {
    const f = await fixture({ type: 'string', minLength: 1000000000 }), generated = f.runtime.generateTests(f.request)
    expect(generated.snapshot.status).toBe('no-candidates'); expect(generated.snapshot.diagnostics.noSeed).toBe(true)
    expect(f.runtime.testCases()).toEqual([])
    f.runtime.editProject({ operation: 'archive', id: f.project.id, expectedGeneration: 1, archived: true, actor: 'local:author' })
    expect(() => f.runtime.deleteProject(f.project.id, 2, 'local:author')).toThrow('referenced')
  })

  it('rolls back the entire batch if any draft insert fails', async () => {
    const f = await fixture(), db = new DatabaseSync(join(f.directory, 'runtime.sqlite'))
    db.exec("CREATE TRIGGER fail_second_test BEFORE INSERT ON test_cases WHEN (SELECT count(*) FROM test_cases) >= 1 BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END;")
    expect(() => f.runtime.generateTests(f.request)).toThrow()
    expect(f.runtime.testCases()).toEqual([]); expect(f.runtime.testGenerations()).toEqual([])
    db.exec('DROP TRIGGER fail_second_test'); db.close()
    expect(f.runtime.generateTests(f.request).snapshot.cases).toHaveLength(2)
  })

  it('rejects changed generation receipts on reopen', async () => {
    const f = await fixture(); f.runtime.generateTests(f.request); await f.runtime.close()
    const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'))
    const row = db.prepare('SELECT record FROM test_generations WHERE id=?').get(f.request.id) as { record: string }, record = JSON.parse(row.record)
    record.snapshot.cases[0].definition.input = 'tampered'
    db.prepare('UPDATE test_generations SET record=? WHERE id=?').run(JSON.stringify(record), f.request.id); db.close()
    await expect(LocalRuntime.open({ dataDirectory: f.directory })).rejects.toMatchObject({ code: 'corrupt' })
  })

  it('migrates schema 8 while preserving existing accepted tests and results', async () => {
    const f = await fixture(), draft = f.runtime.editTest({ operation: 'create', actor: 'local:author', definition: {
      title: 'Existing test', project: f.request.project, input: true, expectations: [{ kind: 'status', value: 'completed' }] } })
    const accepted = f.runtime.editTest({ operation: 'accept', id: draft.id, expectedGeneration: 1, reviewedSha256: draft.sha256, actor: 'local:reviewer' })
    const result = await f.runtime.runTest({ id: accepted.id, generation: 2, sha256: accepted.sha256 }, randomUUID())
    await f.runtime.close(); const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'))
    db.exec('DROP TABLE test_generations; PRAGMA user_version=8'); db.close()
    const runtime = await LocalRuntime.open({ dataDirectory: f.directory }); cleanup.push(runtime)
    expect(await runtime.testResult(result.run.id)).toEqual(result)
    expect(runtime.generateTests(f.request).snapshot.cases).toHaveLength(2)
  })

  it('generates, lists and reopens a batch through CLI commands without running it', async () => {
    const f = await fixture(); await f.runtime.close()
    const invoke = async (...args: string[]) => { let out = '', err = ''
      expect(await main(['tests', ...args, '--data-dir', f.directory], { out: s => { out += s }, err: s => { err += s } })).toBe(0)
      expect(err).toBe(''); return JSON.parse(out) }
    const generated = await invoke('generate', f.project.id, '--expected-generation', '1', '--revision', f.project.acceptedRevision, '--id', f.request.id, '--limit', '2')
    expect(generated.snapshot.cases).toHaveLength(2)
    expect(await invoke('generation', f.request.id)).toEqual(generated)
    expect((await invoke('generations')).generations[0].caseCount).toBe(2)
    expect((await invoke('list')).tests.every((test: any) => test.status === 'draft')).toBe(true)
  })
})

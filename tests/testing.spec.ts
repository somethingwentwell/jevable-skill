import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { LocalRuntime, type TestDefinition, type ModelCalls } from '../src/runtime/index.ts'
import { main } from '../src/cli.ts'
import { renderTemplate, listTemplates } from '../src/templates/index.ts'
import { RunStore } from '../src/runtime/store.ts'
import { vi } from 'vitest'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const cleanup: LocalRuntime[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const runtime of cleanup.splice(0)) await runtime.close() })
async function fixture(source = echo, input: TestDefinition['input'] = 'private test input', models?: ModelCalls) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-tests-'))
  const runtime = await LocalRuntime.open({ dataDirectory: directory, ...(models ? { models } : {}) }); cleanup.push(runtime)
  const project = runtime.editProject({ operation: 'create', title: 'Test project', yaml: source, actor: 'local:author' })
  const definition: TestDefinition = { title: 'Reviewed example', project: { id: project.id, generation: project.generation, revision: project.acceptedRevision },
    input, expectations: [{ kind: 'status', value: 'completed' }, { kind: 'output-equals', value: input }] }
  const create = (value = definition) => runtime.editTest({ operation: 'create', definition: value, actor: 'local:author' })
  const accept = (value = definition) => {
    const draft = create(value)
    return runtime.editTest({ operation: 'accept', id: draft.id, expectedGeneration: draft.generation, reviewedSha256: draft.sha256, actor: 'local:reviewer' })
  }
  return { directory, runtime, project, definition, create, accept }
}
const identity = (test: { id: string; generation: number; sha256: string }) => ({ id: test.id, generation: test.generation, sha256: test.sha256 })

describe('reviewed saved workflow tests', () => {
  it('creates drafts without execution; only exact accepted case versions can run', async () => {
    const f = await fixture(), draft = f.create()
    expect(draft.status).toBe('draft'); expect(f.runtime.list()).toEqual([])
    await expect(f.runtime.runTest(identity(draft), randomUUID())).rejects.toMatchObject({ code: 'conflict' })
    expect(() => f.runtime.editTest({ operation: 'accept', id: draft.id, expectedGeneration: 1, reviewedSha256: '0'.repeat(64), actor: 'local:reviewer' })).toThrow('conflict')
    const test = f.runtime.editTest({ operation: 'accept', id: draft.id, expectedGeneration: 1, reviewedSha256: draft.sha256, actor: 'local:reviewer' })
    const result = await f.runtime.runTest(identity(test), randomUUID())
    expect(result).toMatchObject({ assessment: 'passed', workflowStatus: 'completed', terminal: true, test: identity(test) })
    expect(result.run.project).toEqual({ id: f.project.id, generation: 1 })
    expect((await f.runtime.events(result.run.id))[0]!.data).toMatchObject({ test: identity(test) })
  })

  it('preserves accepted versions and run expectations across case edits, project edits and restart', async () => {
    const f = await fixture(), test = f.accept(), id = randomUUID(), result = await f.runtime.runTest(identity(test), id)
    const edited = f.runtime.editTest({ operation: 'edit', id: test.id, expectedGeneration: 2, actor: 'local:editor',
      definition: { ...f.definition, expectations: [{ kind: 'status', value: 'completed' }, { kind: 'output-equals', value: 'different' }] } })
    expect(edited.status).toBe('draft'); expect(edited.generation).toBe(3)
    f.runtime.editProject({ operation: 'rename', id: f.project.id, expectedGeneration: 1, title: 'Changed project', actor: 'local:author' })
    expect(() => f.runtime.editTest({ operation: 'accept', id: test.id, expectedGeneration: 3, reviewedSha256: edited.sha256, actor: 'local:reviewer' })).toThrow('conflict')
    expect(await f.runtime.runTest(identity(test), id)).toEqual(result)
    await expect(f.runtime.runTest(identity(test), randomUUID())).rejects.toMatchObject({ code: 'conflict' })
    await f.runtime.close()
    const reopened = await LocalRuntime.open({ dataDirectory: f.directory }); cleanup.push(reopened)
    expect(await reopened.testResult(id)).toEqual(result)
    expect(reopened.testHistory(test.id).versions.map(v => [v.generation, v.status])).toEqual([[1, 'draft'], [2, 'accepted'], [3, 'draft']])
    expect(reopened.testCase(test.id, 2).actor).toBe('local:reviewer')
  })

  it('reports mismatched expectations without changing a successfully executed workflow', async () => {
    const f = await fixture(), test = f.accept({ ...f.definition, expectations: [{ kind: 'status', value: 'completed' }, { kind: 'output-equals', value: 'wrong' }] })
    const result = await f.runtime.runTest(identity(test), randomUUID())
    expect(result.assessment).toBe('failed'); expect(result.workflowStatus).toBe('completed')
    expect(result.checks[1]).toMatchObject({ matched: false, available: true })
    expect(result.checks[1]).not.toHaveProperty('expected'); expect(result.checks[1]).not.toHaveProperty('actual')
    expect((await f.runtime.testResult(result.run.id, true)).checks[1]).toMatchObject({ expected: 'wrong', actual: f.definition.input })
    expect(JSON.stringify(f.runtime.testCases())).not.toContain('private test input')
  })

  it('does not approve a waiting test and evaluates retained evidence after explicit approval', async () => {
    const f = await fixture(approval, { message: 'Fixture request' }), test = f.accept({ ...f.definition,
      expectations: [{ kind: 'status', value: 'completed' }, { kind: 'output-equals', value: 'approve' }] })
    const result = await f.runtime.runTest(identity(test), randomUUID())
    expect(result).toMatchObject({ assessment: 'pending', workflowStatus: 'waiting', terminal: false })
    expect((await f.runtime.testResult(result.run.id)).assessment).toBe('pending')
    const waiting = await f.runtime.show(result.run.id); expect(waiting.state.status).toBe('waiting')
    if (waiting.state.status !== 'waiting') throw Error('Expected fixture approval')
    await f.runtime.decide(waiting.id, waiting.state.attempt.id, 'approve', 'local:approved-fixture')
    expect(await f.runtime.testResult(waiting.id)).toMatchObject({ assessment: 'passed', terminal: true })
  })

  it('can assert an approval checkpoint without claiming workflow completion', async () => {
    const f = await fixture(approval, { message: 'Fixture request' }), test = f.accept({ ...f.definition, expectations: [{ kind: 'status', value: 'waiting' }] })
    expect(await f.runtime.runTest(identity(test), randomUUID())).toMatchObject({ assessment: 'passed', workflowStatus: 'waiting', terminal: false })
  })

  it('can assert a specific failure from an explicitly rejected approval', async () => {
    const f = await fixture(approval, { message: 'Fixture rejection' }), test = f.accept({ ...f.definition,
      expectations: [{ kind: 'status', value: 'failed' }, { kind: 'failure-code', value: 'approval-rejected' }] })
    const result = await f.runtime.runTest(identity(test), randomUUID()), waiting = await f.runtime.show(result.run.id)
    expect(result.assessment).toBe('pending')
    if (waiting.state.status !== 'waiting') throw Error('Expected fixture approval')
    await f.runtime.decide(waiting.id, waiting.state.attempt.id, 'reject', 'local:fixture-reviewer')
    expect(await f.runtime.testResult(waiting.id, true)).toMatchObject({ assessment: 'passed', workflowStatus: 'failed', terminal: true,
      checks: [{ actual: 'failed', matched: true }, { actual: 'approval-rejected', matched: true }] })
  })

  it('checks node outputs and scoped loop iterations from actual settled steps', async () => {
    const source = JSON.stringify(renderTemplate('expense-check')), input = listTemplates().find(t => t.id === 'expense-check')!.sample
    const f = await fixture(source, input as TestDefinition['input']), baseline = await f.runtime.run(source, input)
    const step = baseline.state.steps.find(s => s.scope)!
    expect(step).toBeDefined()
    const test = f.accept({ ...f.definition, expectations: [{ kind: 'status', value: baseline.state.status as 'completed' | 'waiting' },
      { kind: 'node-visited', nodeId: step.nodeId, scope: step.scope! },
      { kind: 'node-output-equals', nodeId: step.nodeId, scope: step.scope!, value: step.output as TestDefinition['input'] }] })
    expect((await f.runtime.runTest(identity(test), randomUUID())).assessment).toBe('passed')
    expect(() => f.create({ ...f.definition, expectations: [{ kind: 'status', value: 'completed' }, { kind: 'node-visited', nodeId: 'missing' }] })).toThrow()
  })

  it.each([[], [{ kind: 'output-equals', value: 'x' }], [{ kind: 'status', value: 'completed' }, { kind: 'status', value: 'waiting' }],
    [{ kind: 'status', value: 'waiting' }, { kind: 'output-equals', value: 'x' }],
    [{ kind: 'status', value: 'completed' }, { kind: 'failure-code', value: 'approval-rejected' }]].map(expectations => ({ expectations })))('rejects inconsistent expectations %#', async ({ expectations }) => {
    const f = await fixture(); expect(() => f.create({ ...f.definition, expectations } as any)).toThrow('invalid-command')
    expect(f.runtime.testCases()).toEqual([])
  })

  it('rejects invalid input, stale project revisions, cross-project edits and oversized cases', async () => {
    const f = await fixture(), test = f.accept()
    expect(() => f.create({ ...f.definition, input: 5 })).toThrow()
    expect(() => f.create({ ...f.definition, input: 'x'.repeat(250001) })).toThrow('invalid-command')
    expect(() => f.create({ ...f.definition, project: { ...f.definition.project, revision: '0'.repeat(64) } })).toThrow('conflict')
    const other = f.runtime.editProject({ operation: 'create', title: 'Other', yaml: echo, actor: 'local:author' })
    expect(() => f.runtime.editTest({ operation: 'edit', id: test.id, expectedGeneration: 2, actor: 'local:editor',
      definition: { ...f.definition, project: { ...f.definition.project, id: other.id } } })).toThrow('conflict')
    expect(f.runtime.testCase(test.id)).toEqual(test)
  })

  it('refuses deletion of projects referenced by saved tests, even without a run', async () => {
    const f = await fixture(); f.create()
    f.runtime.editProject({ operation: 'archive', id: f.project.id, expectedGeneration: 1, archived: true, actor: 'local:author' })
    expect(() => f.runtime.deleteProject(f.project.id, 2, 'local:author')).toThrow('referenced')
  })

  it('does not repurpose a normal run UUID or a test UUID through another execution API', async () => {
    const f = await fixture(), test = f.accept(), id = randomUUID()
    await f.runtime.runProject(f.project.id, 1, f.project.acceptedRevision, f.definition.input, { id })
    await expect(f.runtime.runTest(identity(test), id)).rejects.toMatchObject({ code: 'conflict' })
    const result = await f.runtime.runTest(identity(test), randomUUID())
    await expect(f.runtime.runProject(f.project.id, 1, f.project.acceptedRevision, f.definition.input, { id: result.run.id })).rejects.toMatchObject({ code: 'conflict' })
    await expect(f.runtime.run(echo, f.definition.input, { id: result.run.id })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('does not accept forged test provenance through generic JavaScript run options', async () => {
    const f = await fixture(), draft = f.create()
    const run = await f.runtime.runProject(f.project.id, 1, f.project.acceptedRevision, f.definition.input,
      { id: randomUUID(), test: identity(draft) } as any)
    expect(run.test).toBeUndefined()
    await expect(f.runtime.testResult(run.id)).rejects.toMatchObject({ code: 'conflict' })
    const release = f.runtime.createRelease({ projectId: f.project.id, expectedGeneration: 1, revision: f.project.acceptedRevision,
      version: '1.0.0', actor: 'local:author', runtime: { version: '0.1.0-alpha.1', sha256: '1'.repeat(64) } })
    const released = await f.runtime.runRelease(release.snapshot, f.definition.input, { id: randomUUID(), test: identity(draft) } as any)
    expect(released.test).toBeUndefined()
  })

  it('never redispatches an uncertain model test after restart', async () => {
    let calls = 0
    const models: ModelCalls = { admit() {}, async execute() { calls++; throw Error('response lost') }, async verify() {} }
    const source = JSON.stringify(renderTemplate('support-reply', { model: { provider: 'fixture', model: 'fixture' } }))
    const sample = listTemplates().find(t => t.id === 'support-reply')!.sample
    const f = await fixture(source, sample as TestDefinition['input'], models), test = f.accept({ ...f.definition, expectations: [{ kind: 'status', value: 'completed' }] }), id = randomUUID()
    await expect(f.runtime.runTest(identity(test), id)).rejects.toThrow('response lost')
    await f.runtime.close()
    const runtime = await LocalRuntime.open({ dataDirectory: f.directory, models }); cleanup.push(runtime)
    expect(await runtime.runTest(identity(test), id)).toMatchObject({ assessment: 'uncertain', workflowStatus: 'executing' })
    expect(calls).toBe(1)
  })

  it('commits test identity with run creation before any execution, refusing a failed commit', async () => {
    const f = await fixture(), test = f.accept()
    const save = vi.spyOn(RunStore.prototype, 'save').mockImplementation(() => { throw Error('disk fixture failure') })
    await expect(f.runtime.runTest(identity(test), randomUUID())).rejects.toThrow('disk fixture failure')
    expect(save.mock.calls[0]![0].test).toEqual(identity(test)); expect(f.runtime.list()).toEqual([])
  })

  it.each(['case', 'run', 'removed-link'])('rejects tampered %s provenance on reopening', async target => {
    const f = await fixture(), test = f.accept(), result = await f.runtime.runTest(identity(test), randomUUID())
    await f.runtime.close()
    const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'))
    if (target === 'case') {
      const row = db.prepare('SELECT record FROM test_cases WHERE id=?').get(test.id) as { record: string }, record = JSON.parse(row.record)
      record.versions[1].definition.input = 'tampered'
      db.prepare('UPDATE test_cases SET record=? WHERE id=?').run(JSON.stringify(record), test.id)
    } else {
      const row = db.prepare('SELECT record FROM runs WHERE id=?').get(result.run.id) as { record: string }, record = JSON.parse(row.record)
      if (target === 'removed-link') delete record.test; else record.test.generation = 1
      db.prepare('UPDATE runs SET record=? WHERE id=?').run(JSON.stringify(record), result.run.id)
    }
    db.close(); await expect(LocalRuntime.open({ dataDirectory: f.directory })).rejects.toMatchObject({ code: 'corrupt' })
  })

  it('migrates schema 7 without changing existing run evidence', async () => {
    const f = await fixture(), run = await f.runtime.run(echo, 'existing')
    await f.runtime.close()
    const db = new DatabaseSync(join(f.directory, 'runtime.sqlite')); db.exec('DROP TABLE test_cases; PRAGMA user_version = 7'); db.close()
    const runtime = await LocalRuntime.open({ dataDirectory: f.directory }); cleanup.push(runtime)
    expect(await runtime.show(run.id)).toEqual(run); expect(runtime.testCases()).toEqual([])
  })

  it('exposes review/run/inspect commands and distinguishes assertion failure exit code', async () => {
    const f = await fixture(), file = join(f.directory, 'case.json')
    await writeFile(file, JSON.stringify({ ...f.definition, expectations: [{ kind: 'status', value: 'completed' }, { kind: 'output-equals', value: 'wrong' }] }))
    await f.runtime.close()
    const cli = async (...args: string[]) => { let out = '', err = ''
      const code = await main(['tests', ...args, '--data-dir', f.directory], { out: value => { out += value }, err: value => { err += value } })
      expect(err).toBe(''); return { code, body: JSON.parse(out) } }
    const draft = (await cli('create', file)).body
    const test = (await cli('accept', draft.id, '--expected-generation', '1', '--sha256', draft.sha256)).body
    const result = await cli('run', test.id, '--expected-generation', '2', '--sha256', test.sha256, '--id', randomUUID())
    expect(result.code).toBe(6); expect(result.body.workflowStatus).toBe('completed')
    const inspected = await cli('result', result.body.run.id, '--inspect')
    expect(inspected.code).toBe(0); expect(inspected.body.checks[1].actual).toBe(f.definition.input)
  })
})

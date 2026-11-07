import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { LocalRuntime, type Project } from '../src/runtime/index.ts'
import { main } from '../src/cli.ts'

const workspace = () => mkdtemp(join(tmpdir(), 'jevable-project-'))
const source = (name = 'Echo') => JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow',
  metadata: { id: 'echo', name }, spec: { inputSchema: { type: 'string' },
    nodes: { start: { type: 'trigger', config: { modes: ['manual'] } }, result: { type: 'output', config: { value: '${{ inputs }}' } } },
    edges: [{ from: 'start', to: 'result' }] } })
const guard = (project: Project) => ({ id: project.id, expectedGeneration: project.generation, actor: 'local:test' })
const create = (runtime: LocalRuntime, yaml = source()) => runtime.editProject({ operation: 'create', title: 'Example', yaml, actor: 'local:test' })
const propose = (runtime: LocalRuntime, project: Project, yaml = source('Revised')) => runtime.editProject({ ...guard(project), operation: 'propose', yaml })
const accept = (runtime: LocalRuntime, project: Project, approvalChanges: string[] = []) => {
  const proposal = project.proposals.at(-1)!
  return runtime.editProject({ ...guard(project), operation: 'accept', proposalId: proposal.id, reviewedRevision: proposal.revision, approvalChanges })
}

describe('standalone durable project review', () => {
  it('keeps drafts distinct, enforces exact review, and retains all revisions after restart', async () => {
    const dataDirectory = await workspace()
    let runtime = await LocalRuntime.open({ dataDirectory })
    const initial = create(runtime), draft = propose(runtime, initial), candidate = draft.proposals[0]!
    expect(draft.acceptedRevision).toBe(initial.acceptedRevision)
    expect(draft.generation).toBe(2)
    expect(() => runtime.editProject({ ...guard(initial), operation: 'rename', title: 'Stale' })).toThrow(/conflict/)
    expect(() => runtime.editProject({ ...guard(draft), operation: 'accept', proposalId: candidate.id,
      reviewedRevision: initial.acceptedRevision, approvalChanges: [] })).toThrow(/conflict/)
    expect(runtime.project(initial.id)).toEqual(draft)
    const accepted = accept(runtime, draft)
    expect(accepted.acceptedRevision).toBe(candidate.revision)
    expect(accepted.proposals[0]!.status).toBe('accepted')
    expect(() => accept(runtime, draft)).toThrow(/conflict/)
    await runtime.close()
    runtime = await LocalRuntime.open({ dataDirectory })
    expect(runtime.project(initial.id)).toEqual(accepted)
    expect(runtime.diffProject(initial.id, initial.acceptedRevision, candidate.revision)).toMatchObject({ metadataChanged: true, approvalChanges: [] })
    await runtime.close()
  })

  it('rejects stale proposal bases but lets the user reject obsolete drafts', async () => {
    const runtime = await LocalRuntime.open({ dataDirectory: await workspace() })
    try {
      const one = propose(runtime, create(runtime)), two = propose(runtime, one, source('Another'))
      const accepted = accept(runtime, two), pending = one.proposals[0]!
      const command = { ...guard(accepted), proposalId: pending.id, reviewedRevision: pending.revision }
      expect(() => runtime.editProject({ ...command, operation: 'accept', approvalChanges: [] })).toThrow(/conflict/)
      const rejected = runtime.editProject({ ...command, operation: 'reject' })
      expect(rejected.acceptedRevision).toBe(accepted.acceptedRevision)
      expect(rejected.proposals[0]!.status).toBe('rejected')
      expect(() => runtime.editProject({ ...guard(rejected), operation: 'restore', revision: pending.revision, approvalChanges: [] })).toThrow(/conflict/)
    } finally { await runtime.close() }
  })

  it.each(['remove', 'bypass', 'change'])('requires explicit approval acknowledgement for %s', async mode => {
    const runtime = await LocalRuntime.open({ dataDirectory: await workspace() })
    try {
      const yaml = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
      const original = create(runtime, yaml)
      const { parseWorkflow } = await import('../src/workflow/index.ts')
      const { DEFAULT_COMPILER_LIMITS } = await import('../src/limits.ts')
      const doc = JSON.parse(JSON.stringify(parseWorkflow(yaml, DEFAULT_COMPILER_LIMITS.source).document))
      if (mode === 'change') doc.spec.nodes.review.config.title = 'Changed terms'
      else if (mode === 'remove') {
        doc.spec.edges = [{ from: 'start', to: 'result' }]
        doc.spec.nodes.result.config.value = 'bypassed'
        delete doc.spec.nodes.review
      } else {
        doc.spec.nodes.route = { type: 'rule', config: { mode: 'ifElse', condition: '${{ false }}' } }
        doc.spec.nodes.result.config.value = 'bypassed'
        doc.spec.edges = [{ from: 'start', to: 'route' }, { from: 'route', port: 'true', to: 'review' },
          { from: 'route', port: 'false', to: 'result' }, { from: 'review', port: 'approve', to: 'result' }]
      }
      const draft = propose(runtime, original, JSON.stringify(doc))
      expect(runtime.diffProject(draft.id, original.acceptedRevision, draft.proposals[0]!.revision).approvalChanges).toEqual(['review'])
      expect(() => accept(runtime, draft)).toThrow(/conflict/)
      expect(() => accept(runtime, draft, ['review', 'review'])).toThrow(/conflict/)
      const accepted = accept(runtime, draft, ['review'])
      expect(accepted.changes.at(-1)).toMatchObject({ operation: 'accept', approvalChanges: ['review'], actor: 'local:test' })
    } finally { await runtime.close() }
  })

  it('pins an approval-waiting run to its original accepted revision across edits and restart', async () => {
    const dataDirectory = await workspace(), runId = randomUUID()
    let runtime = await LocalRuntime.open({ dataDirectory })
    const yaml = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
    const initial = create(runtime, yaml)
    const run = await runtime.runProject(initial.id, initial.generation, initial.acceptedRevision, { message: 'Check me' }, { id: runId })
    expect(run.state.status).toBe('waiting')
    const draft = propose(runtime, initial, yaml.replace('Review this request', 'Different terms'))
    const accepted = accept(runtime, draft, ['review'])
    await expect(runtime.runProject(initial.id, initial.generation, initial.acceptedRevision, { message: 'Check me' })).rejects.toMatchObject({ code: 'conflict' })
    await expect(runtime.runProject(accepted.id, accepted.generation, draft.proposals[0]!.base, { message: 'Check me' })).rejects.toMatchObject({ code: 'conflict' })
    expect(await runtime.runProject(initial.id, initial.generation, initial.acceptedRevision, { message: 'Check me' }, { id: runId })).toEqual(run)
    await expect(runtime.run(yaml, { message: 'Check me' }, { id: runId })).rejects.toMatchObject({ code: 'conflict' })
    await runtime.close()
    runtime = await LocalRuntime.open({ dataDirectory })
    expect(await runtime.show(runId)).toEqual(run)
    if (run.state.status !== 'waiting') throw Error('Expected waiting')
    const completed = await runtime.decide(runId, run.state.attempt.id, 'approve', 'local:test')
    expect(completed.revision).toBe(initial.acceptedRevision)
    expect(completed.project).toEqual({ id: initial.id, generation: 1 })
    expect(completed.state.status).toBe('completed')
    await runtime.close()
  })

  it('restores only accepted snapshots and blocks new authoring/execution while archived', async () => {
    const runtime = await LocalRuntime.open({ dataDirectory: await workspace() })
    try {
      const initial = create(runtime), next = accept(runtime, propose(runtime, initial))
      const restored = runtime.editProject({ ...guard(next), operation: 'restore', revision: initial.acceptedRevision, approvalChanges: [] })
      const archived = runtime.editProject({ ...guard(restored), operation: 'archive', archived: true })
      expect(() => propose(runtime, archived)).toThrow(/archived/)
      await expect(runtime.runProject(archived.id, archived.generation, archived.acceptedRevision, 'input')).rejects.toMatchObject({ code: 'archived' })
      const renamed = runtime.editProject({ ...guard(archived), operation: 'rename', title: 'Archived name' })
      const active = runtime.editProject({ ...guard(renamed), operation: 'archive', archived: false })
      expect((await runtime.runProject(active.id, active.generation, active.acceptedRevision, 'input')).state.status).toBe('completed')
    } finally { await runtime.close() }
  })

  it('rolls back storage failure without partially accepting a revision', async () => {
    const dataDirectory = await workspace(), runtime = await LocalRuntime.open({ dataDirectory })
    const draft = propose(runtime, create(runtime))
    const database = new DatabaseSync(join(dataDirectory, 'runtime.sqlite'))
    database.exec("CREATE TRIGGER fail_project_update BEFORE UPDATE ON projects BEGIN SELECT RAISE(ABORT, 'fixture'); END;")
    expect(() => accept(runtime, draft)).toThrow()
    expect(runtime.project(draft.id)).toEqual(draft)
    database.exec('DROP TRIGGER fail_project_update'); database.close()
    expect(accept(runtime, draft).generation).toBe(3)
    await runtime.close()
  })

  it('does not confuse source admission with executability or readiness', async () => {
    const runtime = await LocalRuntime.open({ dataDirectory: await workspace() })
    try {
      const initial = create(runtime)
      const draft = propose(runtime, initial, source().replace('${{ inputs }}', '${{ nodes.missing.output }}'))
      const accepted = accept(runtime, draft)
      expect(accepted.acceptedRevision).not.toBe(initial.acceptedRevision)
      expect((await runtime.check(accepted.revisions.at(-1)!.yaml)).status).toBe('invalid')
      await expect(runtime.runProject(accepted.id, accepted.generation, accepted.acceptedRevision, 'input')).rejects.toThrow()
      expect(runtime.list()).toEqual([])
    } finally { await runtime.close() }
  })

  it('enforces bounded records and leaves no partial project on failed creation', async () => {
    const runtime = await LocalRuntime.open({ dataDirectory: await workspace(), maxRecordBytes: 100 })
    try {
      expect(() => create(runtime)).toThrow(/limit/)
      expect(runtime.projects()).toEqual([])
    } finally { await runtime.close() }
  })

  it('rejects corrupted journal replay on open without starting any execution', async () => {
    const dataDirectory = await workspace(), runtime = await LocalRuntime.open({ dataDirectory })
    const draft = propose(runtime, create(runtime)), accepted = accept(runtime, draft)
    await runtime.close()
    const database = new DatabaseSync(join(dataDirectory, 'runtime.sqlite'))
    const row = database.prepare('SELECT record FROM projects WHERE id=?').get(accepted.id) as { record: string }
    const record = JSON.parse(row.record)
    record.changes[2].revision = draft.acceptedRevision
    database.prepare('UPDATE projects SET record=? WHERE id=?').run(JSON.stringify(record), accepted.id)
    database.close()
    await expect(LocalRuntime.open({ dataDirectory })).rejects.toMatchObject({ code: 'corrupt' })
  })

  it('migrates a version 2 database without changing run history', async () => {
    const dataDirectory = await workspace(), runtime = await LocalRuntime.open({ dataDirectory })
    const run = await runtime.run(source(), 'retained')
    await runtime.close()
    const database = new DatabaseSync(join(dataDirectory, 'runtime.sqlite'))
    database.exec('DROP TABLE projects; PRAGMA user_version=2;'); database.close()
    const reopened = await LocalRuntime.open({ dataDirectory })
    expect(await reopened.show(run.id)).toEqual(run)
    expect(reopened.projects()).toEqual([])
    expect(create(reopened).generation).toBe(1)
    await reopened.close()
  })

  it('exposes generation-checked authoring and pinned execution through the CLI', async () => {
    const dataDirectory = await workspace(), out = vi.fn(), err = vi.fn()
    const cli = async (...args: string[]) => {
      out.mockClear(); err.mockClear()
      const code = await main(['projects', ...args, '--data-dir', dataDirectory, '--json'], { out, err })
      return { code, value: JSON.parse((code === 0 ? out : err).mock.calls[0]![0]) }
    }
    const created = await cli('create', new URL('../examples/echo.yaml', import.meta.url).pathname, '--title', 'CLI project')
    expect(created.code).toBe(0)
    const project = created.value
    expect((await cli('rename', project.id, '--expected-generation', '1', '--title', 'New name')).code).toBe(0)
    expect((await cli('rename', project.id, '--expected-generation', '1', '--title', 'Stale')).value.code).toBe('conflict')
    const run = await cli('run', project.id, '--expected-generation', '2', '--revision', project.acceptedRevision,
      '--input', new URL('../examples/echo-input.json', import.meta.url).pathname)
    expect(run.code).toBe(0)
    expect(run.value.project).toEqual({ id: project.id, generation: 2 })
  })

  it('duplicates only accepted snapshots into a fresh independent project with lineage', async () => {
    const dataDirectory = await workspace(), runtime = await LocalRuntime.open({ dataDirectory })
    const original = create(runtime), draft = propose(runtime, original)
    expect(() => runtime.editProject({ ...guard(draft), operation: 'duplicate', revision: draft.proposals[0]!.revision, title: 'Unreviewed' })).toThrow(/conflict/)
    expect(() => runtime.editProject({ ...guard(original), operation: 'duplicate', revision: original.acceptedRevision, title: 'Stale' })).toThrow(/conflict/)
    const id = randomUUID()
    const copied = runtime.editProject({ ...guard(draft), operation: 'duplicate', revision: original.acceptedRevision, title: 'Copy', newId: id })
    expect(copied).toMatchObject({ id, generation: 1, title: 'Copy', acceptedRevision: original.acceptedRevision, archived: false,
      proposals: [], revisions: original.revisions,
      changes: [{ operation: 'create', copiedFrom: { id: original.id, generation: draft.generation, revision: original.acceptedRevision } }] })
    expect(() => runtime.editProject({ ...guard(draft), operation: 'duplicate', revision: original.acceptedRevision, title: 'Collision', newId: id })).toThrow(/conflict/)
    const archived = runtime.editProject({ ...guard(draft), operation: 'archive', archived: true })
    runtime.deleteProject(archived.id, archived.generation, 'local:test')
    expect(runtime.project(id)).toEqual(copied)
    await runtime.close()
    const reopened = await LocalRuntime.open({ dataDirectory })
    expect((await reopened.runProject(id, 1, copied.acceptedRevision, 'copied input')).state.status).toBe('completed')
    await reopened.close()
  })

  it('deletes only an exact archived project and retains a source-free deletion receipt', async () => {
    const dataDirectory = await workspace(), runtime = await LocalRuntime.open({ dataDirectory })
    const original = create(runtime), unrelated = create(runtime)
    expect(() => runtime.deleteProject(original.id, 1, 'local:test')).toThrow(/conflict/)
    const archived = runtime.editProject({ ...guard(original), operation: 'archive', archived: true })
    expect(() => runtime.deleteProject(original.id, 1, 'local:test')).toThrow(/conflict/)
    const receipt = runtime.deleteProject(original.id, archived.generation, 'local:test')
    expect(receipt).toMatchObject({ status: 'deleted', id: original.id, generation: 2, revision: original.acceptedRevision, actor: 'local:test' })
    expect(receipt).not.toHaveProperty('yaml')
    expect(runtime.projectDeletions()).toEqual([receipt])
    expect(() => runtime.project(original.id)).toThrow(/not-found/)
    expect(runtime.project(unrelated.id)).toEqual(unrelated)
    expect(() => runtime.editProject({ operation: 'create', id: original.id, title: 'Reused ID', yaml: source(), actor: 'local:test' })).toThrow(/conflict/)
    await runtime.close()
    const reopened = await LocalRuntime.open({ dataDirectory })
    expect(reopened.projectDeletions()).toEqual([receipt])
    expect(reopened.projects().map(p => p.id)).toEqual([unrelated.id])
    await reopened.close()
  })

  it.each(['completed', 'waiting'])('retains project evidence for a linked %s run', async state => {
    const runtime = await LocalRuntime.open({ dataDirectory: await workspace() })
    try {
      const yaml = state === 'waiting' ? await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8') : source()
      const project = create(runtime, yaml)
      const run = await runtime.runProject(project.id, 1, project.acceptedRevision, state === 'waiting' ? { message: 'Review' } : 'completed')
      const archived = runtime.editProject({ ...guard(project), operation: 'archive', archived: true })
      expect(() => runtime.deleteProject(archived.id, archived.generation, 'local:test')).toThrow(/referenced/)
      expect(await runtime.show(run.id)).toEqual(run)
      expect(runtime.project(archived.id)).toEqual(archived)
      expect(runtime.projectDeletions()).toEqual([])
    } finally { await runtime.close() }
  })

  it('rolls back the deletion receipt and project removal together on failure', async () => {
    const dataDirectory = await workspace(), runtime = await LocalRuntime.open({ dataDirectory })
    const archived = runtime.editProject({ ...guard(create(runtime)), operation: 'archive', archived: true })
    const database = new DatabaseSync(join(dataDirectory, 'runtime.sqlite'))
    database.exec("CREATE TRIGGER fail_project_delete BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'fixture'); END;")
    expect(() => runtime.deleteProject(archived.id, 2, 'local:test')).toThrow()
    expect(runtime.project(archived.id)).toEqual(archived)
    expect(runtime.projectDeletions()).toEqual([])
    database.exec('DROP TRIGGER fail_project_delete'); database.close()
    runtime.deleteProject(archived.id, 2, 'local:test')
    await runtime.close()
  })

  it('requires an exact CLI deletion confirmation and handles deletion in another process session', async () => {
    const dataDirectory = await workspace(), runtime = await LocalRuntime.open({ dataDirectory })
    const project = runtime.editProject({ ...guard(create(runtime)), operation: 'archive', archived: true })
    await runtime.close()
    const out = vi.fn(), err = vi.fn()
    const command = ['projects', 'delete', project.id, '--expected-generation', '2', '--data-dir', dataDirectory]
    expect(await main(command, { out, err })).toBe(2)
    expect(await main([...command, '--confirm-delete', randomUUID()], { out, err })).toBe(2)
    expect(await main([...command, '--confirm-delete', project.id], { out, err })).toBe(0)
    expect(JSON.parse(out.mock.calls.at(-1)![0])).toMatchObject({ id: project.id, status: 'deleted', recovery: expect.stringContaining('backup') })
    const reopened = await LocalRuntime.open({ dataDirectory })
    expect(reopened.projects()).toEqual([])
    expect(reopened.projectDeletions()).toHaveLength(1)
    await reopened.close()
  })

  it('migrates version 3 project journals without rewriting their history', async () => {
    const dataDirectory = await workspace(), runtime = await LocalRuntime.open({ dataDirectory })
    const project = accept(runtime, propose(runtime, create(runtime)))
    await runtime.close()
    const database = new DatabaseSync(join(dataDirectory, 'runtime.sqlite'))
    database.exec('DROP TABLE project_deletions; PRAGMA user_version=3;'); database.close()
    const reopened = await LocalRuntime.open({ dataDirectory })
    expect(reopened.project(project.id)).toEqual(project)
    expect(reopened.projectDeletions()).toEqual([])
    await reopened.close()
  })
})

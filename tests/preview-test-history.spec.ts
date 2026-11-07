import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PreviewSession, type PreviewOperations } from '../src/preview/session.ts'
import { renderPreview } from '../src/preview/index.ts'
import { testHash } from '../src/testing/schema.ts'

const source = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
function fixture() {
  const revision = renderPreview(source).data.revision
  if (!revision) throw Error('Fixture workflow must compile')
  const project = { id: randomUUID(), generation: 1, revision }
  const id = randomUUID(), definition = { title: 'Private saved case', project, input: 'PRIVATE_PAYLOAD',
    expectations: [{ kind: 'status' as const, value: 'completed' as const }] }
  const version = { generation: 1, operation: 'create' as const, status: 'draft' as const, definition,
    sha256: testHash(definition), actor: 'PRIVATE_ACTOR', at: '2026-10-06T00:00:00.000Z' }
  const record = { schemaVersion: 1, id, versions: [version] }
  const current = () => ({ schemaVersion: 1, id, ...record.versions.at(-1)! })
  const calls: any[] = []
  const owner: PreviewOperations = { call: async command => {
    calls.push(command)
    if (command.operation === 'projects.command') return { id: project.id, generation: 1, acceptedRevision: project.revision }
    if (command.operation === 'tests.show') return current()
    if (command.operation === 'tests.history') return structuredClone(record)
    throw Error('Unexpected dispatch')
  } }
  return { project, id, version, record, current, calls, owner }
}

describe('preview saved-case history: bounded scoped metadata, never action authority', () => {
  it('projects version metadata without private inputs, expectations, titles or actors', async () => {
    const f = fixture(), session = await PreviewSession.create(f.owner, source)
    const before = structuredClone(f.record)
    expect(await session.operation({ operation: 'tests.history', id: f.id })).toEqual({
      project: f.project, test: { id: f.id, generation: 1, sha256: f.version.sha256 }, execution: 'not-run',
      versions: [{ generation: 1, operation: 'create', status: 'draft', archived: false, sha256: f.version.sha256, at: f.version.at }] })
    expect(f.record).toEqual(before)
    expect(f.calls.slice(1).map(call => call.operation)).toEqual(['tests.show', 'tests.history'])
  })
  it('omits prior versions belonging to another project revision', async () => {
    const f = fixture(), session = await PreviewSession.create(f.owner, source)
    const foreign = { ...f.version, definition: { ...f.version.definition, project: { ...f.project, generation: 2 } } }
    f.record.versions = [foreign, { ...f.version, generation: 2 }]
    const result: any = await session.operation({ operation: 'tests.history', id: f.id })
    expect(result.versions.map((version: any) => version.generation)).toEqual([2])
  })
  it('refuses a foreign latest definition before reading history', async () => {
    const f = fixture(), session = await PreviewSession.create(f.owner, source)
    f.record.versions[0]!.definition.project = { ...f.project, id: randomUUID() }
    await expect(session.operation({ operation: 'tests.history', id: f.id })).rejects.toMatchObject({ code: 'not-found' })
    expect(f.calls.map(call => call.operation)).not.toContain('tests.history')
  })
  it.each(['id', 'generation', 'hash'])('refuses an inconsistent history %s rather than substituting newer guards', async mismatch => {
    const f = fixture(), session = await PreviewSession.create(f.owner, source), saved = f.current()
    const call = f.owner.call
    f.owner.call = async command => command.operation === 'tests.show' ? saved : call(command)
    if (mismatch === 'id') f.record.id = randomUUID()
    if (mismatch === 'generation') f.record.versions[0]!.generation = 2
    if (mismatch === 'hash') f.record.versions[0]!.sha256 = '0'.repeat(64)
    await expect(session.operation({ operation: 'tests.history', id: f.id })).rejects.toMatchObject({ code: 'corrupt' })
  })
  it.each([{ actor: 'override' }, { project: {} }, { generation: 1 }, { includePrivate: true }])('refuses widened history requests %j', async extra => {
    const f = fixture(), session = await PreviewSession.create(f.owner, source), count = f.calls.length
    await expect(session.operation({ operation: 'tests.history', id: f.id, ...extra })).rejects.toMatchObject({ code: 'invalid-command' })
    expect(f.calls).toHaveLength(count)
  })
})

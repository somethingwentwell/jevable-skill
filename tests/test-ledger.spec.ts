import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { TestLedger } from '../src/testing/ledger.ts'
import { ProjectLedger } from '../src/projects/ledger.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { testHash, type TestDefinition } from '../src/testing/schema.ts'

const yaml = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const project = new ProjectLedger(DEFAULT_COMPILER_LIMITS.source, 4_000_000).apply({ operation: 'create', title: 'Tests', yaml, actor: 'local:test' }).project
const definition = (): TestDefinition => ({ title: 'Case', project: { id: project.id, generation: 1, revision: project.acceptedRevision },
  input: 'private input', expectations: [{ kind: 'status', value: 'completed' }] })
const ledger = () => new TestLedger(DEFAULT_COMPILER_LIMITS, 4_000_000)

describe('shared saved-test review ledger', () => {
  it('owns prepared input/history copies without modifying earlier versions', () => {
    const core = ledger(), input = definition(), first = core.prepare({ operation: 'create', definition: input, actor: 'local:test' })
    input.title = 'Caller mutation'; expect(first.test.definition.title).toBe('Case')
    const accepted = core.prepare({ operation: 'accept', id: first.test.id, expectedGeneration: 1, reviewedSha256: first.test.sha256, actor: 'local:reviewer' }, first.record)
    accepted.record.versions[0]!.definition.title = 'Returned history mutation'
    expect(first.test.definition.title).toBe('Case'); expect(first.record.versions).toHaveLength(1)
    expect(() => core.prepare({ operation: 'create', definition: definition(), actor: 'local:test' }, first.record)).toThrow('conflict')
  })
  it('requires exact draft acceptance and detects a rehashed but altered acceptance record', () => {
    const core = ledger(), first = core.prepare({ operation: 'create', definition: definition(), actor: 'local:test' })
    expect(() => core.prepare({ operation: 'accept', id: first.test.id, expectedGeneration: 1, reviewedSha256: '0'.repeat(64), actor: 'local:test' }, first.record)).toThrow('conflict')
    const accepted = core.prepare({ operation: 'accept', id: first.test.id, expectedGeneration: 1, reviewedSha256: first.test.sha256, actor: 'local:test' }, first.record)
    const altered = structuredClone(accepted.record), last = altered.versions.at(-1)!
    last.definition.input = 'Not the reviewed draft'; last.sha256 = testHash(last.definition)
    expect(() => core.decode(altered, altered.id, 2)).toThrow('corrupt')
    expect(() => core.prepare({ operation: 'accept', id: first.test.id, expectedGeneration: 2, reviewedSha256: first.test.sha256, actor: 'local:test' }, accepted.record)).toThrow('conflict')
  })
  it('preserves historical pins while current review rejects stale, archived or unrelated projects', () => {
    const core = ledger(), test = definition()
    core.validate(test, project, false)
    expect(() => core.validate(test, { ...project, generation: 2 }, true)).toThrow('conflict')
    expect(() => core.validate(test, { ...project, id: randomUUID() }, false)).toThrow('conflict')
    expect(() => core.validate(test, { ...project, archived: true }, true)).toThrow('archived')
    core.validate(test, { ...project, archived: true }, true, true)
  })
  it('bounds retained case history and rejects generation or checksum corruption', () => {
    const core = ledger(); let current = core.prepare({ operation: 'create', definition: definition(), actor: 'local:test' })
    for (let i = 1; i < 100; i++) current = core.prepare({ operation: 'edit', id: current.test.id, expectedGeneration: i, definition: definition(), actor: 'local:test' }, current.record)
    expect(core.decode(current.record, current.test.id, 100).versions).toHaveLength(100)
    expect(() => core.prepare({ operation: 'edit', id: current.test.id, expectedGeneration: 100, definition: definition(), actor: 'local:test' }, current.record)).toThrow('limit')
    expect(() => core.decode(current.record, current.test.id, 99)).toThrow('corrupt')
    current.record.versions[0]!.sha256 = '0'.repeat(64)
    expect(() => core.decode(current.record, current.test.id, 100)).toThrow('corrupt')
  })
})

import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { ProjectLedger } from '../src/projects/ledger.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'

const yaml = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const ledger = () => new ProjectLedger(DEFAULT_COMPILER_LIMITS.source, 4_000_000)

describe('shared project review ledger', () => {
  it('does not mutate its admitted prior record or the caller command', () => {
    const core = ledger(), first = core.apply({ operation: 'create', id: randomUUID(), title: 'Original', yaml, actor: 'local:test' })
    const original = JSON.stringify(first.record), command = { operation: 'rename' as const, id: first.project.id,
      expectedGeneration: 1, title: 'Renamed', actor: 'local:test' }
    const result = core.apply(command, first.record)
    expect(JSON.stringify(first.record)).toBe(original)
    expect(result.project.title).toBe('Renamed'); expect(command.title).toBe('Renamed')
    result.record.changes[0]!.actor = 'altered returned record'
    expect(first.record.changes[0]!.actor).toBe('local:test')
  })
  it('preserves approval acknowledgement requirements and rejects forged replay', () => {
    const core = ledger(), first = core.apply({ operation: 'create', title: 'Original', yaml, actor: 'local:test' })
    const proposed = core.apply({ operation: 'propose', id: first.project.id, expectedGeneration: 1,
      yaml: yaml.replace('24h', '12h'), actor: 'local:test' }, first.record)
    const proposal = proposed.project.proposals[0]!, command = { operation: 'accept' as const, id: first.project.id,
      expectedGeneration: 2, proposalId: proposal.id, reviewedRevision: proposal.revision, actor: 'local:reviewer', approvalChanges: [] as string[] }
    expect(() => core.apply(command, proposed.record)).toThrow('conflict')
    const accepted = core.apply({ ...command, approvalChanges: ['review'] }, proposed.record)
    expect(accepted.project.acceptedRevision).toBe(proposal.revision)
    const altered = structuredClone(accepted.record)
    const change = altered.changes.at(-1)!
    if (change.operation !== 'accept') throw new Error('Expected accept event')
    change.approvalChanges = []
    expect(() => core.decode(JSON.stringify(altered), first.project.id, 3)).toThrow('corrupt')
    expect(core.replay(accepted.record, 1).acceptedRevision).toBe(first.project.acceptedRevision)
  })
  it('treats duplication onto its own identity as a command conflict, not corrupt persistence', () => {
    const core = ledger(), first = core.apply({ operation: 'create', title: 'Original', yaml, actor: 'local:test' })
    expect(() => core.apply({ operation: 'duplicate', id: first.project.id, newId: first.project.id,
      expectedGeneration: 1, revision: first.project.acceptedRevision, title: 'Copy', actor: 'local:test' }, first.record)).toThrow('conflict')
  })
  it('prepares imports with fresh identity and local provenance without modifying source history', () => {
    const core = ledger(), first = core.apply({ operation: 'create', title: 'Original', yaml, actor: 'external:author' })
    const bundle = core.export(first.record, 1, first.project.acceptedRevision, true), json = JSON.stringify(bundle)
    const reviewed = core.inspectImport(json), id = randomUUID()
    const prepared = core.prepareImport(json, reviewed.sha256, 'local:importer', id)
    expect(prepared.project.id).toBe(id); expect(prepared.project.generation).toBe(2)
    expect(prepared.project.changes.at(-1)).toMatchObject({ operation: 'import', actor: 'local:importer', sourceProjectId: first.project.id })
    expect(JSON.stringify(bundle)).toBe(json)
    expect(() => core.prepareImport(json, '0'.repeat(64), 'local:importer')).toThrow('conflict')
  })
})

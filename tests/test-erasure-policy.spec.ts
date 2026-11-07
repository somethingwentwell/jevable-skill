import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { TestLedger } from '../src/testing/ledger.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { testHash, type TestDefinition } from '../src/testing/schema.ts'
import { reviewTestErasure, testHistorySha256, type TestErasureReferences } from '../src/testing/erasure.ts'

const ledger = new TestLedger(DEFAULT_COMPILER_LIMITS, 4_000_000)
const references = (): TestErasureReferences => ({ runs: 0, generationBatches: 0, otherReferences: 0 })
function fixture(accepted = false) {
  const definition: TestDefinition = { title: 'PRIVATE_ERASURE_TITLE', project: { id: randomUUID(), generation: 1, revision: 'a'.repeat(64) },
    input: 'PRIVATE_ERASURE_INPUT', expectations: [{ kind: 'status', value: 'completed' }, { kind: 'output-equals', value: 'PRIVATE_ERASURE_EXPECTED' }] }
  let current = ledger.prepare({ operation: 'create', definition, actor: 'PRIVATE_ERASURE_ACTOR' })
  if (accepted) current = ledger.prepare({ operation: 'accept', id: current.test.id, expectedGeneration: current.test.generation,
    reviewedSha256: current.test.sha256, actor: 'PRIVATE_ERASURE_ACTOR' }, current.record)
  const active = structuredClone(current)
  current = ledger.prepare({ operation: 'archive', id: current.test.id, expectedGeneration: current.test.generation,
    reviewedSha256: current.test.sha256, archived: true, actor: 'PRIVATE_ERASURE_ACTOR' }, current.record)
  const request = { test: { id: current.test.id, generation: current.test.generation, sha256: current.test.sha256 },
    reviewedHistorySha256: testHistorySha256(current.record) }
  return { ...current, active, definition, request }
}

describe('standalone saved-test erasure review foundation', () => {
  it('reviews an exactly pinned archived manual draft without erasing, granting authority or exposing private history', () => {
    const f = fixture(), before = structuredClone(f), refs = references(), originalRefs = structuredClone(refs)
    const review = reviewTestErasure(f.record, f.request, refs)
    expect(review).toMatchObject({ eligible: true, reasons: [], test: f.request.test, historySha256: f.request.reviewedHistorySha256,
      projectId: f.definition.project.id, authority: 'none', storageMutation: 'not-performed', referenceFacts: 'supplied-not-discovered', policy: 'archived-draft-v1' })
    expect(JSON.stringify(review)).not.toContain('PRIVATE_ERASURE_')
    expect(f).toEqual(before); expect(refs).toEqual(originalRefs)
    review.test.id = randomUUID(); review.references.runs = 99; review.reasons.push('retained-runs')
    expect(f).toEqual(before); expect(refs).toEqual(originalRefs)
  })
  it('refuses an active draft even with complete zero-reference facts', () => {
    const f = fixture(), active = f.active
    const request = { test: { id: active.test.id, generation: active.test.generation, sha256: active.test.sha256 },
      reviewedHistorySha256: testHistorySha256(active.record) }
    expect(reviewTestErasure(active.record, request, references())).toMatchObject({ eligible: false, reasons: ['not-archived'] })
  })
  it('preserves any previously accepted definition even after later draft edits and archival', () => {
    const f = fixture(true)
    expect(reviewTestErasure(f.record, f.request, references())).toMatchObject({ eligible: false, reasons: ['accepted-history'] })
    const restored = ledger.prepare({ operation: 'archive', id: f.test.id, expectedGeneration: f.test.generation, reviewedSha256: f.test.sha256,
      archived: false, actor: 'owner' }, f.record)
    const edited = ledger.prepare({ operation: 'edit', id: f.test.id, expectedGeneration: restored.test.generation,
      definition: { ...f.definition, title: 'Later draft' }, actor: 'owner' }, restored.record)
    const archived = ledger.prepare({ operation: 'archive', id: f.test.id, expectedGeneration: edited.test.generation,
      reviewedSha256: edited.test.sha256, archived: true, actor: 'owner' }, edited.record)
    const request = { test: { id: f.test.id, generation: archived.test.generation, sha256: archived.test.sha256 },
      reviewedHistorySha256: testHistorySha256(archived.record) }
    expect(reviewTestErasure(archived.record, request, references())).toMatchObject({ eligible: false, reasons: ['accepted-history'] })
  })
  it.each([['runs', 'retained-runs'], ['generationBatches', 'generation-evidence'], ['otherReferences', 'other-retained-references']] as const)(
    'preserves drafts with %s evidence', (key, reason) => {
      const f = fixture(), refs = references(); refs[key] = 1
      expect(reviewTestErasure(f.record, f.request, refs)).toMatchObject({ eligible: false, reasons: [reason] })
    })
  it('returns every retention reason in fixed order, not just the first one', () => {
    const f = fixture(true)
    expect(reviewTestErasure(f.record, f.request, { runs: 1, generationBatches: 2, otherReferences: 3 })).toMatchObject({
      eligible: false, reasons: ['accepted-history', 'retained-runs', 'generation-evidence', 'other-retained-references'] })
  })
  it('preserves imported draft provenance without exporting its original private definition', () => {
    const f = fixture(), originalProject = { ...f.definition.project, id: randomUUID() }
    f.record.importedFrom = { bundleSha256: 'b'.repeat(64), source: { id: randomUUID(), generation: 1,
      sha256: testHash({ ...f.definition, project: originalProject }) }, project: originalProject, status: 'draft' }
    f.request.reviewedHistorySha256 = testHistorySha256(f.record)
    const review = reviewTestErasure(f.record, f.request, references())
    expect(review).toMatchObject({ eligible: false, reasons: ['imported-history'] })
    expect(JSON.stringify(review)).not.toContain(originalProject.id)
  })
  it.each(['id', 'generation', 'sha256', 'history'] as const)('rejects stale or foreign %s review pins', pin => {
    const f = fixture()
    if (pin === 'id') f.request.test.id = randomUUID()
    if (pin === 'generation') f.request.test.generation++
    if (pin === 'sha256') f.request.test.sha256 = 'c'.repeat(64)
    if (pin === 'history') f.request.reviewedHistorySha256 = 'c'.repeat(64)
    expect(() => reviewTestErasure(f.record, f.request, references())).toThrow('conflict')
  })
  it('binds earlier private draft versions even when the latest definition hash is unchanged', () => {
    const f = fixture(), altered = structuredClone(f.record)
    altered.versions[0]!.actor = 'Different historical actor'
    expect(ledger.decode(altered, altered.id, altered.versions.length)).toEqual(altered)
    expect(ledger.select(altered).sha256).toBe(f.test.sha256)
    expect(() => reviewTestErasure(altered, f.request, references())).toThrow('conflict')
  })
  it('hashes schema-normalized history rather than JSON formatting/property insertion order', () => {
    const f = fixture(), reordered = { versions: f.record.versions, id: f.record.id, schemaVersion: 1 }
    expect(testHistorySha256(JSON.parse(JSON.stringify(reordered, null, 2)))).toBe(f.request.reviewedHistorySha256)
  })
  it.each([undefined, {}, { runs: 0, generationBatches: 0 }, { runs: -1, generationBatches: 0, otherReferences: 0 },
    { runs: 0.5, generationBatches: 0, otherReferences: 0 }, { runs: Number.MAX_SAFE_INTEGER + 1, generationBatches: 0, otherReferences: 0 },
    { runs: '0', generationBatches: 0, otherReferences: 0 }, { runs: 0, generationBatches: 0, otherReferences: 0, ignored: true }])(
    'requires complete bounded strict reference facts: %j', refs => {
      const f = fixture(); expect(() => reviewTestErasure(f.record, f.request, refs as never)).toThrow('invalid-command')
    })
  it.each([{ reviewedHistorySha256: undefined }, { actor: 'caller' }, { erase: true }, { reviewedHistorySha256: 'x' }])(
    'refuses malformed or authority-bearing review input: %j', patch => {
      const f = fixture(); expect(() => reviewTestErasure(f.record, { ...f.request, ...patch } as never, references())).toThrow('invalid-command')
    })
  it('validates complete history integrity before considering retention eligibility', () => {
    const f = fixture(), corrupt = structuredClone(f.record)
    corrupt.versions[0]!.definition.input = 'Altered private input'
    expect(() => testHistorySha256(corrupt)).toThrow('corrupt')
    expect(() => reviewTestErasure(corrupt, f.request, references())).toThrow('corrupt')
    expect(() => reviewTestErasure({ ...f.record, injected: true }, f.request, references())).toThrow('invalid-command')
  })
  it.each([0, 1023, 16_000_001, NaN, Infinity, 1024.5])('refuses invalid history byte bound %s', maxBytes => {
    const f = fixture(); expect(() => testHistorySha256(f.record, DEFAULT_COMPILER_LIMITS, maxBytes)).toThrow('invalid-command')
  })
  it('bounds oversized private histories without emitting their content', () => {
    const f = fixture(); f.record.versions[0]!.definition.input = 'PRIVATE_ERASURE_'.repeat(300)
    expect(() => testHistorySha256(f.record, DEFAULT_COMPILER_LIMITS, 1024)).toThrow('invalid-command')
  })
})

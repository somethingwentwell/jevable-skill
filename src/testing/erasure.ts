import { createHash } from 'node:crypto'
import { z } from 'zod'
import { DEFAULT_COMPILER_LIMITS } from '../limits.ts'
import type { WorkflowCompilerLimits } from '../workflow/index.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { TestLedger, type TestRecord } from './ledger.ts'
import { parseTest, testIdentitySchema, testRecordSchema } from './schema.ts'

export const TEST_ERASURE_POLICY_VERSION = 'archived-draft-v1' as const
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
const reviewSchema = z.strictObject({ test: testIdentitySchema, reviewedHistorySha256: sha256 })
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const referencesSchema = z.strictObject({ runs: count, generationBatches: count, otherReferences: count })
export const testErasurePreparationSchema = z.strictObject({
  schemaVersion: z.literal(1), policy: z.literal(TEST_ERASURE_POLICY_VERSION), test: testIdentitySchema,
  historySha256: sha256, projectId: z.uuid(),
  intrinsicReasons: z.array(z.enum(['not-archived', 'accepted-history', 'imported-history'])).max(3),
  eligibility: z.literal('not-assessed'), referenceFacts: z.literal('not-discovered'),
  authority: z.literal('none'), storageMutation: z.literal('not-performed'),
  scope: z.literal('archived-manual-never-accepted-draft'),
})
export type TestErasurePreparation = z.infer<typeof testErasurePreparationSchema>
export type TestErasureReviewRequest = z.infer<typeof reviewSchema>
/** Complete facts from a storage owner, not caller claims or a live-reference scan performed by this helper. */
export type TestErasureReferences = z.infer<typeof referencesSchema>
export type TestErasureReason = 'not-archived' | 'accepted-history' | 'imported-history'
  | 'retained-runs' | 'generation-evidence' | 'other-retained-references'
export type TestErasureReview = {
  schemaVersion: 1
  policy: typeof TEST_ERASURE_POLICY_VERSION
  test: TestErasureReviewRequest['test']
  historySha256: string
  projectId: string
  eligible: boolean
  reasons: TestErasureReason[]
  references: TestErasureReferences
  referenceFacts: 'supplied-not-discovered'
  authority: 'none'
  storageMutation: 'not-performed'
  scope: 'archived-manual-never-accepted-draft'
}

function history(value: unknown, limits: WorkflowCompilerLimits, maxBytes: number): TestRecord {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 16_000_000) throw new WorkflowRuntimeError('invalid-command')
  const parsed = parseTest(testRecordSchema, value, maxBytes)
  return new TestLedger(limits, maxBytes).decode(parsed, parsed.id, parsed.versions.length)
}
const digest = (record: TestRecord) => createHash('sha256').update(JSON.stringify(record)).digest('hex')

/** Hash the normalized, validated complete history—not just its latest definition or a file's formatting. */
export function testHistorySha256(value: unknown, limits = DEFAULT_COMPILER_LIMITS, maxBytes = 4_000_000) {
  return digest(history(value, limits, maxBytes))
}

function intrinsicReasons(record: TestRecord): ('not-archived' | 'accepted-history' | 'imported-history')[] {
  const reasons: ('not-archived' | 'accepted-history' | 'imported-history')[] = []
  if (record.versions.at(-1)!.archived !== true) reasons.push('not-archived')
  if (record.versions.some(version => version.status === 'accepted' || version.operation === 'accept')) reasons.push('accepted-history')
  if (record.importedFrom) reasons.push('imported-history')
  return reasons
}

/** Prepare exact history pins only. No reference scan, eligibility assessment or authority. */
export function prepareTestErasureReview(value: unknown, limits = DEFAULT_COMPILER_LIMITS, maxBytes = 4_000_000): TestErasurePreparation {
  const record = history(value, limits, maxBytes), last = record.versions.at(-1)!
  return { schemaVersion: 1, policy: TEST_ERASURE_POLICY_VERSION,
    test: { id: record.id, generation: last.generation, sha256: last.sha256 }, historySha256: digest(record),
    projectId: last.definition.project.id, intrinsicReasons: intrinsicReasons(record), eligibility: 'not-assessed',
    referenceFacts: 'not-discovered', authority: 'none', storageMutation: 'not-performed',
    scope: 'archived-manual-never-accepted-draft' }
}

/**
 * Pure review foundation. No storage is opened, references discovered, authority granted or data erased.
 * A future write must recompute complete reference facts and this review within the owner's atomic
 * mutation boundary, preserve a metadata receipt/tombstone and never reuse the erased identity.
 */
export function reviewTestErasure(value: unknown, request: TestErasureReviewRequest, retained: TestErasureReferences,
  limits = DEFAULT_COMPILER_LIMITS, maxBytes = 4_000_000): TestErasureReview {
  const command = parseTest(reviewSchema, request, 4096), references = parseTest(referencesSchema, retained, 4096)
  const record = history(value, limits, maxBytes), last = record.versions.at(-1)!, historySha256 = digest(record)
  if (record.id !== command.test.id || last.generation !== command.test.generation || last.sha256 !== command.test.sha256
    || historySha256 !== command.reviewedHistorySha256) throw new WorkflowRuntimeError('conflict')
  const reasons: TestErasureReason[] = intrinsicReasons(record)
  if (references.runs > 0) reasons.push('retained-runs')
  if (references.generationBatches > 0) reasons.push('generation-evidence')
  if (references.otherReferences > 0) reasons.push('other-retained-references')
  return { schemaVersion: 1, policy: TEST_ERASURE_POLICY_VERSION, test: { ...command.test }, historySha256,
    projectId: last.definition.project.id, eligible: reasons.length === 0, reasons, references: { ...references }, referenceFacts: 'supplied-not-discovered',
    authority: 'none', storageMutation: 'not-performed', scope: 'archived-manual-never-accepted-draft' }
}

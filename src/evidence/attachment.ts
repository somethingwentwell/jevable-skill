import { isDeepStrictEqual } from 'node:util'
import { inspectEvidenceZip } from './inspect.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'

/** An attachment is review material, never imported runtime state or proof of release/project ownership. */
export const EVIDENCE_ATTACHMENT_LIMIT = 16_000_000
export interface EvidenceAttachmentInput { bytes: Uint8Array; sha256: string; includePrivate?: boolean }
export async function prepareEvidenceAttachment(input: EvidenceAttachmentInput, revision: string) {
  if (!input || !(input.bytes instanceof Uint8Array) || !/^[a-f0-9]{64}$/u.test(input.sha256)
    || !/^[a-f0-9]{64}$/u.test(revision) || input.includePrivate !== undefined && typeof input.includePrivate !== 'boolean') {
    throw new WorkflowRuntimeError('invalid-command')
  }
  if (input.bytes.byteLength > EVIDENCE_ATTACHMENT_LIMIT) throw new WorkflowRuntimeError('limit')
  const bytes = Buffer.from(input.bytes), sha256 = input.sha256, includePrivate = input.includePrivate === true
  const inspection = await inspectEvidenceZip(bytes, sha256)
  if (inspection.runs.some(run => run.revision !== revision)) throw new WorkflowRuntimeError('conflict')
  if (inspection.declaredPrivacy === 'private-execution-data' && !includePrivate) throw new WorkflowRuntimeError('invalid-command')
  const descriptor = { format: 'jevable.ai/evidence-attachment' as const, path: 'evidence.zip' as const,
    sha256: inspection.artifact.sha256, bytes: inspection.artifact.bytes, selectionSha256: inspection.selectionSha256,
    revision, declaredPrivacy: inspection.declaredPrivacy, runs: inspection.runs.length,
    relationship: 'workflow-revision-only' as const, authenticity: 'not-verified' as const, restoration: 'unsupported' as const }
  return { bytes, descriptor, inspection }
}

/** Reads may inspect a declared private archive but never display its payloads or grant export consent. */
export async function inspectEvidenceAttachment(bytes: Uint8Array, revision: string, descriptor: unknown) {
  if (!descriptor || typeof descriptor !== 'object' || !('sha256' in descriptor) || typeof descriptor.sha256 !== 'string') {
    throw new WorkflowRuntimeError('corrupt')
  }
  const result = await prepareEvidenceAttachment({ bytes, sha256: descriptor.sha256, includePrivate: true }, revision)
  if (!isDeepStrictEqual(result.descriptor, descriptor)) throw new WorkflowRuntimeError('corrupt')
  return { attachment: result.descriptor, inspection: result.inspection, importStatus: 'not-restored' as const }
}

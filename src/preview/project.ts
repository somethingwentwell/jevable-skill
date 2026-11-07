import { createHash } from 'node:crypto'
import { ProjectLedger } from '../projects/ledger.ts'
import { createProjectZip, createProjectZipWithEvidence, PROJECT_PACKAGE_LIMITS } from '../packages/project-zip.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import type { EvidenceAttachmentInput } from '../evidence/attachment.ts'
import type { WorkflowLimits } from '../workflow/index.ts'
import type { PreviewOperations } from './session.ts'
import type { PreviewProjectPin } from './release.ts'

/** Export authoring content only from the explicitly admitted project. Never import, execute or restore. */
export async function previewProjectZip(owner: PreviewOperations, pin: PreviewProjectPin, limits: WorkflowLimits,
  options: { history: boolean; tests: boolean }, evidence?: EvidenceAttachmentInput) {
  const exported = await owner.call({ operation: 'projects.export', id: pin.id, expectedGeneration: pin.generation,
    revision: pin.revision, history: options.history, tests: options.tests })
  const { bundle } = new ProjectLedger(limits, PROJECT_PACKAGE_LIMITS.entryBytes).inspectImport(JSON.stringify(exported))
  if (bundle.source.id !== pin.id || bundle.source.generation !== pin.generation || bundle.accepted.revision !== pin.revision
    || Boolean(bundle.history) !== options.history || (bundle.version === 2) !== options.tests) throw new WorkflowRuntimeError('corrupt')
  const attached = evidence ? await createProjectZipWithEvidence(bundle, evidence) : undefined
  const bytes = attached?.bytes ?? createProjectZip(bundle)
  if (bytes.length > 12_000_000) throw new WorkflowRuntimeError('limit')
  const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
  return { schemaVersion: 1, format: 'jevable.ai/preview-project-zip', project: { ...pin },
    options: { ...options }, bundleSha256: digest(JSON.stringify(bundle)),
    tests: bundle.version === 2 ? { included: true, count: bundle.tests.cases.length,
      excludedOtherRevisions: bundle.tests.excludedOtherRevisions, importStatus: 'draft-review-required' }
      : { included: false, count: 0, excludedOtherRevisions: 0, importStatus: 'excluded' },
    evidence: attached ? { sha256: attached.evidence.sha256, selectionSha256: attached.evidence.selectionSha256,
      privacy: attached.evidence.declaredPrivacy } : null,
    bytes: bytes.length, sha256: digest(bytes), base64: bytes.toString('base64'),
    runnableRelease: false, execution: 'not-run', executionStateRestoration: 'unsupported' }
}

import { createHash } from 'node:crypto'
import { zipSync } from 'fflate'
import { zipEpoch } from './zip-time.ts'
import { readBoundedZip, BoundedZipError } from './read-zip.ts'
import { z } from 'zod'
import type { ProjectBundle } from '../projects/store.ts'
import { renderPreview } from '../preview/index.ts'
import { prepareEvidenceAttachment, inspectEvidenceAttachment, type EvidenceAttachmentInput } from '../evidence/attachment.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'

export const PROJECT_PACKAGE_LIMITS = Object.freeze({ archiveBytes: 32_000_000, entryBytes: 16_000_000,
  totalBytes: 48_000_000, entries: 8 })
const names = ['project.json', 'workflow.yaml', 'preview.html', 'README.txt'] as const
const allowed = new Set<string>(['manifest.json', ...names, 'evidence.zip'])
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const fileSchema = z.strictObject({ path: z.enum(names), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) })
const manifestFields = { format: z.literal('jevable.ai/project-zip'),
  bundle: z.literal('project.json'), revision: z.string().regex(/^[a-f0-9]{64}$/u),
  historyIncluded: z.boolean(), files: z.array(fileSchema).length(4) }
const manifestSchema = z.discriminatedUnion('version', [
  z.strictObject({ ...manifestFields, version: z.literal(1), tests: z.literal('not-available-in-this-version') }),
  z.strictObject({ ...manifestFields, version: z.literal(2), tests: z.strictObject({ mode: z.literal('definitions-review-required'),
    count: z.number().int().min(0).max(1000), excludedOtherRevisions: z.number().int().min(0).max(10000),
    excludedArchived: z.number().int().min(1).max(10000).optional() }) }),
  z.strictObject({ ...manifestFields, version: z.literal(3), bundleVersion: z.union([z.literal(1), z.literal(2)]),
    tests: z.union([z.literal('not-available-in-this-version'), z.strictObject({ mode: z.literal('definitions-review-required'),
      count: z.number().int().min(0).max(1000), excludedOtherRevisions: z.number().int().min(0).max(10000),
      excludedArchived: z.number().int().min(1).max(10000).optional() })]),
    evidence: z.unknown(), files: z.array(fileSchema.extend({ path: z.enum([...names, 'evidence.zip']) })).length(5) }),
])
export class ProjectPackageError extends Error {
  constructor(readonly code: 'invalid-package' | 'package-limit' | 'checksum-mismatch') {
    super(`Jevable project package failed: ${code}.`); this.name = 'ProjectPackageError'
  }
}
const text = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes)

/** Generate from a reviewed core-owned bundle. No directory enumeration or runtime state access. */
export function createProjectZip(bundle: ProjectBundle): Buffer {
  return buildProjectZip(bundle)
}

/** Pin and inspect a selected evidence archive before including it; no owner access, discovery or execution. */
export async function createProjectZipWithEvidence(value: ProjectBundle, input: EvidenceAttachmentInput) {
  const bundle = structuredClone(value)
  const evidence = await prepareEvidenceAttachment(input, bundle.accepted.revision)
  return { bytes: buildProjectZip(bundle, evidence), evidence: evidence.descriptor, inspection: evidence.inspection }
}

function buildProjectZip(bundle: ProjectBundle, evidence?: Awaited<ReturnType<typeof prepareEvidenceAttachment>>): Buffer {
  const { html } = renderPreview(bundle.accepted.yaml)
  const files: Record<string, Uint8Array> = {
    'project.json': Buffer.from(JSON.stringify(bundle)),
    'workflow.yaml': Buffer.from(bundle.accepted.yaml),
    'preview.html': Buffer.from(html),
    'README.txt': Buffer.from('Jevable editable project bundle\n\nThis archive is not a runnable release or container image.\n'
      + 'Inspect and import it with the standalone Jevable CLI. Import never executes a workflow.\n'
      + 'The HTML is experimental inspection-only; browser qualification remains pending.\n'
      + 'Workflow source and optional history are private authoring content. Review before sharing.\n'
      + (evidence ? 'The explicit evidence.zip attachment is read-only review material and may include private run/test data.\n'
        + 'It matches this workflow revision only; it does not authenticate project ownership or approvals.\n'
        + 'Import ignores attached execution evidence: no runs, results, approvals or credentials are restored.\n'
        : 'No credential store, runtime database, run inputs/outputs or conversation sessions are included.\n')
      + 'Imported history is an external claim, not authenticated local approval evidence.\n'
      + (bundle.version === 2 ? 'Included test inputs and expected values are private. Imported cases are new local drafts requiring review; no test runs or approvals are transferred.\n'
        : evidence ? 'Test definitions are excluded; the explicit evidence attachment may contain historical test assessments.\n' : 'Tests are excluded from this package version.\n')),
  }
  if (evidence) files['evidence.zip'] = evidence.bytes
  const manifest = { format: 'jevable.ai/project-zip', version: evidence ? 3 : bundle.version,
    ...(evidence ? { bundleVersion: bundle.version, evidence: evidence.descriptor } : {}), bundle: 'project.json', revision: bundle.accepted.revision,
    historyIncluded: Boolean(bundle.history), tests: bundle.version === 2 ? { mode: 'definitions-review-required',
      count: bundle.tests.cases.length, excludedOtherRevisions: bundle.tests.excludedOtherRevisions,
      ...(bundle.tests.excludedArchived === undefined ? {} : { excludedArchived: bundle.tests.excludedArchived }) } : 'not-available-in-this-version',
    files: Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.byteLength, sha256: digest(bytes) })) }
  files['manifest.json'] = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
  if (Object.values(files).some(file => file.byteLength > PROJECT_PACKAGE_LIMITS.entryBytes)
    || Object.values(files).reduce((sum, file) => sum + file.byteLength, 0) > PROJECT_PACKAGE_LIMITS.totalBytes) throw new ProjectPackageError('package-limit')
  const bytes = Buffer.from(zipSync(files, { level: 6, mtime: zipEpoch() }))
  if (bytes.byteLength > PROJECT_PACKAGE_LIMITS.archiveBytes) throw new ProjectPackageError('package-limit')
  return bytes
}

/** Read only bounded allowlisted entries into memory; never extract to disk or execute archived HTML. */
export async function readProjectZip(bytes: Uint8Array) {
  if (bytes.byteLength > PROJECT_PACKAGE_LIMITS.archiveBytes) throw new ProjectPackageError('package-limit')
  bytes = Buffer.from(bytes) // The returned receipt must hash the same bytes the asynchronous reader admitted.
  const entries = await readBoundedZip(bytes, PROJECT_PACKAGE_LIMITS, path => allowed.has(path))
    .catch(error => { throw new ProjectPackageError(error instanceof BoundedZipError ? error.code : 'invalid-package') })
  try {
    const manifest = manifestSchema.parse(JSON.parse(text(entries.get('manifest.json')!)))
    const expected = new Set<string>(['manifest.json', ...names, ...(manifest.version === 3 ? ['evidence.zip'] : [])])
    if (entries.size !== expected.size || [...entries.keys()].some(path => !expected.has(path))
      || new Set(manifest.files.map(file => file.path)).size !== expected.size - 1) throw new ProjectPackageError('invalid-package')
    for (const file of manifest.files) {
      const bytes = entries.get(file.path)!
      if (bytes.byteLength !== file.bytes || digest(bytes) !== file.sha256) throw new ProjectPackageError('checksum-mismatch')
    }
    const json = text(entries.get(manifest.bundle)!), raw = JSON.parse(json)
    if (raw?.accepted?.revision !== manifest.revision || raw?.accepted?.yaml !== text(entries.get('workflow.yaml')!)
      || Boolean(raw?.history) !== manifest.historyIncluded || raw?.version !== (manifest.version === 3 ? manifest.bundleVersion : manifest.version)) throw new ProjectPackageError('checksum-mismatch')
    if (raw.version === 2 ? typeof manifest.tests !== 'object' || !Array.isArray(raw?.tests?.cases) || raw.tests.cases.length !== manifest.tests.count
      || raw.tests.excludedOtherRevisions !== manifest.tests.excludedOtherRevisions
      || raw.tests.excludedArchived !== manifest.tests.excludedArchived : manifest.tests !== 'not-available-in-this-version') throw new ProjectPackageError('checksum-mismatch')
    const evidence = manifest.version === 3 ? await inspectEvidenceAttachment(entries.get('evidence.zip')!, manifest.revision, manifest.evidence) : undefined
    // The caller must additionally validate source and replay optional project history before saving.
    return { json, archiveSha256: digest(bytes), ...(evidence ? { evidence } : {}) }
  } catch (error) { throw error instanceof ProjectPackageError ? error : new ProjectPackageError(error instanceof WorkflowRuntimeError && error.code === 'limit' ? 'package-limit' : 'invalid-package') }
}

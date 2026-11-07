import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { readBoundedZip, BoundedZipError } from '../packages/read-zip.ts'
import { prepareEvidenceDownload } from './download.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { testIdentitySchema } from '../testing/schema.ts'
import { triggerMetadata } from '../runtime/trigger.ts'
import { EVIDENCE_PACKAGE_LIMITS, inspectEvidenceSelection, evidenceRunSchema, inspectPackagedAssessment } from './package.ts'

const hash = z.string().regex(/^[a-f0-9]{64}$/u), uuid = '[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}'
const allowed = (path: string) => ['manifest.json', 'selection.json', 'README.txt'].includes(path) || new RegExp(`^(runs|tests)/${uuid}\\.json$`, 'u').test(path)
const status = evidenceRunSchema.shape.status
const manifestSchema = z.strictObject({ schemaVersion: z.literal(1), format: z.literal('jevable.ai/evidence-zip'), selectionSha256: hash,
  privacy: z.enum(['metadata-only', 'private-execution-data']),
  consistency: z.literal('per-run-observations; not-an-atomic-snapshot'), execution: z.literal('not-started-or-resumed-by-export'),
  restoration: z.literal('unsupported'),
  runs: z.array(z.strictObject({ id: z.uuid(), revision: hash, workflowStatus: status, observedRunUpdatedAt: z.iso.datetime(),
    evidencePath: z.string().max(128), snapshotSha256: hash, testPath: z.string().max(128).optional(), test: testIdentitySchema.optional(),
    assessment: z.enum(['passed', 'failed', 'pending', 'uncertain']).optional() })).min(1).max(EVIDENCE_PACKAGE_LIMITS.runs),
  files: z.array(z.strictObject({ path: z.string().max(128), bytes: z.number().int().nonnegative().max(EVIDENCE_PACKAGE_LIMITS.entryBytes), sha256: hash }))
    .min(3).max(2 + EVIDENCE_PACKAGE_LIMITS.runs * 2) })
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const fail = (code: 'corrupt' | 'limit' | 'conflict' | 'invalid-command' = 'corrupt'): never => { throw new WorkflowRuntimeError(code) }

/** Offline consistency report only. No extraction, state access, payload display, authenticity claim or execution. */
export async function inspectEvidenceZip(input: Uint8Array, expectedSha256?: string) {
  if (!(input instanceof Uint8Array) || expectedSha256 !== undefined && !hash.safeParse(expectedSha256).success) return fail('invalid-command')
  if (input.byteLength > EVIDENCE_PACKAGE_LIMITS.archiveBytes) return fail('limit')
  const bytes = Buffer.from(input), archiveSha256 = digest(bytes)
  if (expectedSha256 !== undefined && expectedSha256 !== archiveSha256) return fail('conflict')
  try {
    const entries = await readBoundedZip(bytes, { ...EVIDENCE_PACKAGE_LIMITS, entries: 3 + EVIDENCE_PACKAGE_LIMITS.runs * 2 }, allowed)
    const text = (path: string) => {
      const content = entries.get(path)
      if (!content) return fail()
      return new TextDecoder('utf-8', { fatal: true }).decode(content)
    }
    const manifest = manifestSchema.parse(JSON.parse(text('manifest.json')))
    if (manifest.files.length !== entries.size - 1 || new Set(manifest.files.map(file => file.path)).size !== manifest.files.length) return fail()
    for (const file of manifest.files) {
      const content = entries.get(file.path)
      if (file.path === 'manifest.json' || !content || content.length !== file.bytes || digest(content) !== file.sha256) return fail()
    }
    if (entries.get('selection.json')!.length > EVIDENCE_PACKAGE_LIMITS.selectionBytes) return fail('limit')
    const { selection, sha256 } = inspectEvidenceSelection(JSON.parse(text('selection.json')))
    if (manifest.selectionSha256 !== sha256 || manifest.runs.length !== selection.runs.length) return fail()
    text('README.txt') // Validate text encoding without displaying or interpreting its instructions.
    const includePrivate = manifest.privacy === 'private-execution-data', expectedPaths = new Set(['manifest.json', 'selection.json', 'README.txt'])
    const runs = []
    for (const [index, selected] of selection.runs.entries()) {
      const declared = manifest.runs[index]!
      if (declared.id !== selected.id || declared.revision !== selected.revision || declared.evidencePath !== `runs/${selected.id}.json`) return fail()
      const envelope = JSON.parse(text(declared.evidencePath)), evidence = await prepareEvidenceDownload({ runId: selected.id, revision: selected.revision }, envelope, includePrivate)
      const run = evidenceRunSchema.parse(envelope.snapshot.run)
      if (declared.snapshotSha256 !== evidence.snapshotSha256 || declared.workflowStatus !== run.status || declared.observedRunUpdatedAt !== run.updatedAt
        || !isDeepStrictEqual(declared.test, run.test)) return fail()
      expectedPaths.add(declared.evidencePath)
      const test = run.test ? inspectPackagedAssessment(JSON.parse(text(`tests/${run.id}.json`)), run, includePrivate) : undefined
      if (test) {
        if (declared.testPath !== `tests/${run.id}.json` || declared.assessment !== test.assessment) return fail()
        expectedPaths.add(declared.testPath)
      } else if (declared.testPath !== undefined || declared.assessment !== undefined) return fail()
      runs.push({ id: run.id, revision: run.revision, workflowStatus: run.status, observedRunUpdatedAt: run.updatedAt, ...triggerMetadata(run),
        evidenceVersion: envelope.schemaVersion as 1 | 2, snapshotSha256: evidence.snapshotSha256,
        ...(test ? { test: test.test, assessment: test.assessment, terminal: test.terminal,
          checks: { total: test.checks.length, matched: test.checks.filter(check => check.matched).length,
            available: test.checks.filter(check => check.available).length } } : {}) })
    }
    if (entries.size !== expectedPaths.size || [...entries.keys()].some(path => !expectedPaths.has(path))) return fail()
    return { schemaVersion: 1, status: 'consistent', format: manifest.format, artifact: { sha256: archiveSha256, bytes: bytes.length },
      expectedChecksum: expectedSha256 === undefined ? 'not-provided' : 'matched', selectionSha256: sha256,
      declaredPrivacy: manifest.privacy, privatePayloads: 'not-displayed', runs, files: entries.size,
      consistency: manifest.consistency, authenticity: 'not-verified', runtimeHistoryReplay: 'not-performed',
      privacyAttestation: 'not-performed; archive-label-is-a-claim', execution: 'not-started-by-inspection', restoration: 'unsupported' }
  } catch (error) {
    if (error instanceof WorkflowRuntimeError) return fail(error.code === 'limit' ? 'limit' : 'corrupt')
    return fail(error instanceof BoundedZipError && error.code === 'package-limit' ? 'limit' : 'corrupt')
  }
}

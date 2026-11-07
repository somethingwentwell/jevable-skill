import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { zipSync } from 'fflate'
import { z } from 'zod'
import { zipEpoch } from '../packages/zip-time.ts'
import { prepareEvidenceDownload } from './download.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { testIdentitySchema } from '../testing/schema.ts'
import { apiTriggerModeSchema } from '../runtime/trigger.ts'

export const EVIDENCE_PACKAGE_LIMITS = Object.freeze({ selectionBytes: 32000, runs: 100, entryBytes: 16_000_000,
  totalBytes: 64_000_000, archiveBytes: 32_000_000, readAttempts: 3 })
const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const selectionSchema = z.strictObject({ schemaVersion: z.literal(1), runs: z.array(z.strictObject({ id: z.uuid(), revision: hash }))
  .min(1).max(EVIDENCE_PACKAGE_LIMITS.runs) }).refine(value => new Set(value.runs.map(run => run.id)).size === value.runs.length)
export type EvidenceSelection = z.infer<typeof selectionSchema>
export { selectionSchema as evidenceSelectionSchema }
/** Supply checked core owner reads. No execution, discovery, list, mutation or filesystem methods are used. */
export interface EvidencePackageHost {
  exportRun(id: string, includePrivate: boolean): unknown | Promise<unknown>
  testResult(id: string, inspect: boolean): unknown | Promise<unknown>
}
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const fail = (code: 'invalid-command' | 'corrupt' | 'limit' | 'busy' = 'corrupt'): never => { throw new WorkflowRuntimeError(code) }
function detach(value: unknown, maxBytes: number, code: 'invalid-command' | 'corrupt' = 'corrupt'): unknown {
  try {
    const json = JSON.stringify(value)
    if (!json) return fail(code)
    if (Buffer.byteLength(json) > maxBytes) return fail('limit')
    return JSON.parse(json)
  } catch (error) { if (error instanceof WorkflowRuntimeError) throw error; return fail(code) }
}
/** Validate and detach the exact selection before the first asynchronous read. Never enumerate runs. */
export function inspectEvidenceSelection(value: unknown) {
  const parsed = selectionSchema.safeParse(detach(value, EVIDENCE_PACKAGE_LIMITS.selectionBytes, 'invalid-command'))
  if (!parsed.success) return fail('invalid-command')
  return { selection: parsed.data, sha256: digest(JSON.stringify(parsed.data)) }
}
const status = z.enum(['completed', 'failed', 'cancelled', 'executing', 'waiting', 'paused'])
const scope = z.strictObject({ loop: z.string().min(1).max(128), index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
const checkSchema = z.object({ index: z.number().int().nonnegative().max(63),
  kind: z.enum(['status', 'output-equals', 'failure-code', 'node-visited', 'node-output-equals', 'node-port-equals']),
  matched: z.boolean(), available: z.boolean(), nodeId: z.string().min(1).max(128).optional(), scope: scope.optional(),
  expected: z.json().optional(), actual: z.json().optional() })
const assessmentSchema = z.object({ schemaVersion: z.literal(1), test: testIdentitySchema, title: z.string().min(1).max(256),
  assessment: z.enum(['passed', 'failed', 'pending', 'uncertain']), workflowStatus: status, terminal: z.boolean(),
  observedRunUpdatedAt: z.iso.datetime(), evidence: z.literal('retained-run'), privateInspection: z.boolean(),
  checks: z.array(checkSchema).min(1).max(64),
  run: z.object({ id: z.uuid(), test: testIdentitySchema, revision: hash, status, updatedAt: z.iso.datetime() }) })
export const evidenceRunSchema = z.object({ id: z.uuid(), revision: hash, status, updatedAt: z.iso.datetime(), test: testIdentitySchema.optional(),
  triggerMode: apiTriggerModeSchema.optional() })
type SnapshotRun = z.infer<typeof evidenceRunSchema>
function assessment(value: unknown, run: SnapshotRun, includePrivate: boolean) {
  const parsed = assessmentSchema.safeParse(detach(value, EVIDENCE_PACKAGE_LIMITS.entryBytes))
  if (!parsed.success) return fail()
  const data = parsed.data, terminal = ['completed', 'failed', 'cancelled'].includes(run.status)
  const matched = data.checks.every(check => check.matched)
  if (!isDeepStrictEqual(data.test, run.test) || !isDeepStrictEqual(data.run.test, run.test)
    || data.run.id !== run.id || data.run.revision !== run.revision || data.run.status !== run.status || data.workflowStatus !== run.status
    || data.run.updatedAt !== run.updatedAt || data.observedRunUpdatedAt !== run.updatedAt || data.terminal !== terminal
    || data.privateInspection !== includePrivate || data.checks.some((check, index) => check.index !== index || check.matched && !check.available)
    || (terminal && !['passed', 'failed'].includes(data.assessment)) || (run.status === 'executing' && data.assessment !== 'uncertain')
    || (run.status === 'paused' && data.assessment !== 'pending') || (data.assessment === 'passed' && !matched)
    || (data.assessment === 'failed' && matched)) return fail()
  if (data.checks.some(check => includePrivate ? !Object.hasOwn(check, 'expected') || Object.hasOwn(check, 'actual') !== check.available
    : Object.hasOwn(check, 'expected') || Object.hasOwn(check, 'actual'))) return fail()
  return { schemaVersion: 1, format: 'jevable.ai/test-assessment', test: data.test, runId: run.id, revision: run.revision,
    assessment: data.assessment, workflowStatus: data.workflowStatus, terminal, observedRunUpdatedAt: run.updatedAt,
    evidence: 'retained-run', privateInspection: includePrivate, ...(includePrivate ? { title: data.title } : {}), checks: data.checks }
}
const packagedAssessmentSchema = z.strictObject({ schemaVersion: z.literal(1), format: z.literal('jevable.ai/test-assessment'),
  test: testIdentitySchema, runId: z.uuid(), revision: hash, assessment: assessmentSchema.shape.assessment,
  workflowStatus: status, terminal: z.boolean(), observedRunUpdatedAt: z.iso.datetime(), evidence: z.literal('retained-run'),
  privateInspection: z.boolean(), title: z.string().min(1).max(256).optional(), checks: z.array(checkSchema.strict()).min(1).max(64) })
/** Internal archive consistency check; does not authenticate test provenance or replay a workflow. */
export function inspectPackagedAssessment(value: unknown, run: SnapshotRun, includePrivate: boolean) {
  const parsed = packagedAssessmentSchema.safeParse(value)
  if (!parsed.success) return fail()
  const data = parsed.data
  if (data.runId !== run.id || data.revision !== run.revision || Object.hasOwn(data, 'title') !== includePrivate) return fail()
  const checked = assessment({ ...data, title: data.title ?? 'metadata-title-omitted', run }, run, includePrivate)
  if (!isDeepStrictEqual(checked, data) || data.checks.some(check =>
    ((check.kind === 'node-visited' || check.kind === 'node-output-equals' || check.kind === 'node-port-equals') !== Object.hasOwn(check, 'nodeId'))
    || (check.scope !== undefined && check.nodeId === undefined)
    || (includePrivate && check.matched !== (check.available && isDeepStrictEqual(check.expected, check.actual))))) return fail()
  return checked
}
async function capture(host: EvidencePackageHost, selected: EvidenceSelection['runs'][number], includePrivate: boolean) {
  for (let attempt = 0; attempt < EVIDENCE_PACKAGE_LIMITS.readAttempts; attempt++) {
    const raw = await host.exportRun(selected.id, includePrivate)
    let artifact: Awaited<ReturnType<typeof prepareEvidenceDownload>>
    try { artifact = await prepareEvidenceDownload({ runId: selected.id, revision: selected.revision }, raw, includePrivate) }
    catch { return fail() }
    const envelope = JSON.parse(artifact.contents), parsed = evidenceRunSchema.safeParse(envelope.snapshot.run)
    if (!parsed.success) return fail()
    const run = parsed.data
    if (!run.test) return { artifact, run, assessment: undefined }
    const result = detach(await host.testResult(selected.id, includePrivate), EVIDENCE_PACKAGE_LIMITS.entryBytes)
    let after: Awaited<ReturnType<typeof prepareEvidenceDownload>>
    try { after = await prepareEvidenceDownload({ runId: selected.id, revision: selected.revision }, await host.exportRun(selected.id, includePrivate), includePrivate) }
    catch { return fail() }
    // Re-read only, never run or resume to settle an observation. Compare complete serialized envelopes.
    if (artifact.sha256 !== after.sha256) continue
    return { artifact, run, assessment: assessment(result, run, includePrivate) }
  }
  return fail('busy')
}

/** Package selected retained observations. Nothing is written until the caller explicitly publishes the returned bytes. */
export async function createEvidenceZip(host: EvidencePackageHost, value: EvidenceSelection, includePrivate = false) {
  const { selection, sha256 } = inspectEvidenceSelection(value)
  if (typeof includePrivate !== 'boolean') return fail('invalid-command')
  const files: Record<string, Uint8Array> = {}, inventory: { path: string; bytes: number; sha256: string }[] = []
  let totalBytes = 0
  const add = (path: string, content: string) => {
    const bytes = Buffer.from(content)
    if (bytes.length > EVIDENCE_PACKAGE_LIMITS.entryBytes || totalBytes + bytes.length > EVIDENCE_PACKAGE_LIMITS.totalBytes) return fail('limit')
    totalBytes += bytes.length; files[path] = bytes; inventory.push({ path, bytes: bytes.length, sha256: digest(bytes) })
  }
  add('selection.json', JSON.stringify(selection) + '\n')
  const runs = []
  for (const selected of selection.runs) {
    const captured = await capture(host, selected, includePrivate), evidencePath = `runs/${selected.id}.json`
    add(evidencePath, captured.artifact.contents)
    const testPath = captured.assessment ? `tests/${selected.id}.json` : undefined
    if (testPath) add(testPath, JSON.stringify(captured.assessment) + '\n')
    runs.push({ id: selected.id, revision: selected.revision, workflowStatus: captured.run.status,
      observedRunUpdatedAt: captured.run.updatedAt, evidencePath, snapshotSha256: captured.artifact.snapshotSha256,
      ...(testPath ? { testPath, test: captured.run.test, assessment: captured.assessment!.assessment } : {}) })
  }
  add('README.txt', 'Jevable retained evidence package\n\nRead-only audit/review material, not a runnable app, project transfer, backup or replay instruction.\n'
    + 'No import restores runs, approvals or test acceptance. Export did not execute, resume, approve or cancel workflows.\n'
    + 'The selection lists exact run IDs and workflow revisions; no other runs were discovered or included.\n'
    + 'Each test assessment is paired with unchanged before/after run evidence. Runs are separate observations, not one atomic batch snapshot.\n'
    + 'Workflow completion and test assessment are distinct. A matching approval wait can pass a test without completing the workflow.\n'
    + (includePrivate ? 'PRIVATE: Includes source, inputs, outputs, recorded actors, review data and expected/actual checks. Inline secrets can remain.\n'
      : 'Metadata excludes workflow payloads, actors, test titles and expected/actual values. IDs and branch names can still reveal business context.\n')
    + 'Credential/configuration stores are excluded. This is not automatic secret scrubbing. Review before sharing.\n'
    + 'Manifest file hashes and snapshot checksums verify consistency against a trusted receipt, not signed authenticity or external outcomes.\n')
  const manifest = { schemaVersion: 1, format: 'jevable.ai/evidence-zip', selectionSha256: sha256,
    privacy: includePrivate ? 'private-execution-data' : 'metadata-only', runs,
    consistency: 'per-run-observations; not-an-atomic-snapshot', execution: 'not-started-or-resumed-by-export',
    restoration: 'unsupported', files: inventory.map(file => ({ ...file })) }
  add('manifest.json', JSON.stringify(manifest, null, 2) + '\n')
  const bytes = Buffer.from(zipSync(files, { level: 6, mtime: zipEpoch() }))
  if (bytes.length > EVIDENCE_PACKAGE_LIMITS.archiveBytes) return fail('limit')
  return { bytes, manifest, sha256: digest(bytes) }
}

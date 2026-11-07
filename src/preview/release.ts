import { createHash } from 'node:crypto'
import { inspectRelease, releaseSnapshotSchema, type Release } from '../releases/snapshot.ts'
import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { loadReleaseRuntime, loadReleaseRuntimeForIdentity } from '../packages/release-zip.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import type { PreviewOperations } from './session.ts'

export interface PreviewProjectPin { id: string; generation: number; revision: string }
/** Only the exact admitted project generation may be packaged by this preview. */
export function scopedPreviewRelease(value: unknown, pin: PreviewProjectPin, id: string): Release {
  const raw = value as Partial<Release> | null
  if (!raw || typeof raw !== 'object') throw new WorkflowRuntimeError('corrupt')
  const release = inspectRelease(raw.snapshot)
  if (raw.sha256 !== release.sha256 || release.snapshot.id !== id) throw new WorkflowRuntimeError('corrupt')
  if (release.snapshot.project.id !== pin.id || release.snapshot.project.generation !== pin.generation
    || release.snapshot.workflow.revision !== pin.revision) throw new WorkflowRuntimeError('not-found')
  return release
}
function releaseReceiptIdentity(release: Release) {
  return { schemaVersion: 1, format: 'jevable.ai/preview-release', id: release.snapshot.id, releaseSha256: release.sha256,
    project: { ...release.snapshot.project, revision: release.snapshot.workflow.revision }, version: release.snapshot.version,
    runtime: release.snapshot.runtime }
}
export function previewReleaseReceipt(release: Release, storage: 'sqlite' | 'postgres') {
  return { ...releaseReceiptIdentity(release), storage, execution: 'not-run',
    ...(release.snapshot.notes === undefined ? {} : { notes: release.snapshot.notes }) }
}
export async function createPreviewRelease(owner: PreviewOperations, pin: PreviewProjectPin,
  command: { id: string; version: string; storage: 'sqlite' | 'postgres'; notes?: string | undefined }) {
  const artifact = await loadReleaseRuntime(command.storage)
  const release = scopedPreviewRelease(await owner.call({ operation: 'releases.create', id: command.id,
    projectId: pin.id, expectedGeneration: pin.generation, revision: pin.revision, version: command.version,
    runtimeStorage: command.storage, runtime: artifact.identity,
    ...(command.notes === undefined ? {} : { notes: command.notes }) }), pin, command.id)
  if (release.snapshot.version !== command.version || release.snapshot.runtime.version !== artifact.identity.version
    || release.snapshot.runtime.sha256 !== artifact.identity.sha256 || release.snapshot.notes !== command.notes) throw new WorkflowRuntimeError('corrupt')
  return previewReleaseReceipt(release, command.storage)
}
export async function readPreviewRelease(owner: PreviewOperations, pin: PreviewProjectPin, id: string) {
  const release = scopedPreviewRelease(await owner.call({ operation: 'releases.show', id }), pin, id)
  const artifact = await loadReleaseRuntimeForIdentity(release.snapshot.runtime)
  return { release, artifact, receipt: previewReleaseReceipt(release, artifact.storage) }
}
/** Scan one bounded owner metadata page; only matching snapshots reach the viewer. */
export async function listPreviewReleasePage(owner: PreviewOperations, pin: PreviewProjectPin,
  after?: string, examined = 0) {
  const metadata = releaseSnapshotSchema.omit({ workflow: true }).extend({ sha256: z.string().regex(/^[a-f0-9]{64}$/u) })
  const schema = z.strictObject({ schemaVersion: z.literal(2), releases: z.array(metadata).max(25), nextCursor: z.uuid().nullable() })
  const parsed = schema.safeParse(await owner.call({ operation: 'releases.list', page: { limit: 25, ...(after ? { after } : {}) } }))
  if (!parsed.success) throw new WorkflowRuntimeError('corrupt')
  const page = parsed.data, releases = []
  if (examined + page.releases.length > 10000) throw new WorkflowRuntimeError('limit')
  let last = after
  for (const row of page.releases) {
    if (last && row.id <= last) throw new WorkflowRuntimeError('corrupt')
    last = row.id
    if (row.project.id !== pin.id || row.project.generation !== pin.generation) continue
    const raw = await owner.call({ operation: 'releases.show', id: row.id }) as Partial<Release> | null
    if (!raw || typeof raw !== 'object') throw new WorkflowRuntimeError('corrupt')
    let release: Release
    try { release = inspectRelease(raw.snapshot) } catch { throw new WorkflowRuntimeError('corrupt') }
    const { workflow, ...actual } = release.snapshot
    if (raw.sha256 !== release.sha256 || !isDeepStrictEqual({ ...actual, sha256: release.sha256 }, row)) throw new WorkflowRuntimeError('corrupt')
    if (workflow.revision !== pin.revision) continue
    let storage: 'sqlite' | 'postgres' | null = null
    try { storage = (await loadReleaseRuntimeForIdentity(release.snapshot.runtime)).storage }
    catch (error) { if (!(error instanceof WorkflowRuntimeError && error.code === 'conflict')) throw error }
    // Missing historical bytes stay visible but cannot be replaced or packaged.
    releases.push({ ...releaseReceiptIdentity(release), storage, execution: 'not-run' })
  }
  if (page.nextCursor !== null && (!page.releases.length || page.nextCursor !== last)) throw new WorkflowRuntimeError('corrupt')
  return { releases, after: page.nextCursor, examined: examined + page.releases.length }
}
export function previewReleaseZipEnvelope(receipt: ReturnType<typeof previewReleaseReceipt>, bytes: Buffer,
  evidence?: { sha256: string; selectionSha256: string; declaredPrivacy: string }) {
  if (bytes.length > 12_000_000) throw new WorkflowRuntimeError('limit')
  return { schemaVersion: 1, format: 'jevable.ai/preview-release-zip', release: receipt, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64'),
    evidence: evidence ? { sha256: evidence.sha256, selectionSha256: evidence.selectionSha256, privacy: evidence.declaredPrivacy } : null,
    execution: 'not-run', restoration: 'unsupported' }
}

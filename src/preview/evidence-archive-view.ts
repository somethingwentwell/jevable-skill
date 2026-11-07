/// <reference lib="dom" />
import { Unzip, UnzipInflate } from 'fflate'
import { prepareEvidenceDownload } from './evidence-download.ts'
import type { PreviewEvidenceSelection } from './evidence-bundle-download.ts'

const LIMITS = { archive: 12_000_000, entry: 16_000_000, total: 64_000_000, files: 203 }
const hash = /^[a-f0-9]{64}$/u
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu
const fail = (): never => { throw Error('Selected evidence archive could not be inspected.') }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value: unknown, keys: string[]) => record(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key))
const allowed = (path: string) => ['manifest.json', 'selection.json', 'README.txt'].includes(path)
  || /^(runs|tests)\/[a-f0-9-]{36}\.json$/iu.test(path) && uuid.test(path.slice(path.indexOf('/') + 1, -5))
const sha256 = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))),
  byte => byte.toString(16).padStart(2, '0')).join('')

/** Inspect the already receipt-checked ZIP in bounded browser memory, without storing or executing its contents. */
export async function inspectPreviewEvidenceArchive(bytes: Uint8Array, selection: PreviewEvidenceSelection,
  expectedSha256: string, expectedPrivacy: 'metadata-only' | 'private-execution-data') {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4 || bytes.length > LIMITS.archive || !hash.test(expectedSha256)
    || !exact(selection, ['schemaVersion', 'runs']) || selection.schemaVersion !== 1 || !Array.isArray(selection.runs)
    || selection.runs.length < 1 || selection.runs.length > 100
    || selection.runs.some(run => !exact(run, ['id', 'revision']) || !uuid.test(run.id) || !hash.test(run.revision))
    || new Set(selection.runs.map(run => run.id.toLowerCase())).size !== selection.runs.length
    || !['metadata-only', 'private-execution-data'].includes(expectedPrivacy)) return fail()
  if (await sha256(bytes) !== expectedSha256) return fail()

  const entries = new Map<string, Uint8Array>()
  let total = 0, count = 0
  try {
    const unzip = new Unzip(file => {
      if (!allowed(file.name) || entries.has(file.name) || ++count > LIMITS.files
        || ![0, 8].includes(file.compression) || !Number.isSafeInteger(file.originalSize)
        || file.originalSize! < 0 || file.originalSize! > LIMITS.entry
        || !Number.isSafeInteger(file.size) || file.size! < 0 || file.size! > bytes.length
        || total + file.originalSize! > LIMITS.total) return fail()
      const chunks: Uint8Array[] = []
      let length = 0
      file.ondata = (error, chunk, final) => {
        if (error || length + chunk.length > LIMITS.entry || total + chunk.length > LIMITS.total
          || length + chunk.length > file.originalSize!) return fail()
        length += chunk.length; total += chunk.length; chunks.push(chunk)
        if (final) {
          if (length !== file.originalSize || entries.has(file.name)) return fail()
          const content = new Uint8Array(length)
          let offset = 0
          for (const part of chunks) { content.set(part, offset); offset += part.length }
          entries.set(file.name, content)
        }
      }
      file.start()
    })
    unzip.register(UnzipInflate)
    for (let offset = 0; offset < bytes.length; offset += 65_536) {
      const end = Math.min(offset + 65_536, bytes.length)
      unzip.push(bytes.subarray(offset, end), end === bytes.length)
    }
  } catch { return fail() }
  if (entries.size !== count || entries.size < 4 || entries.size > LIMITS.files) return fail()
  const decode = (path: string) => {
    const value = entries.get(path)
    if (!value) return fail()
    try { return new TextDecoder('utf-8', { fatal: true }).decode(value) } catch { return fail() }
  }
  let manifest: any, selected: any
  try { manifest = JSON.parse(decode('manifest.json')); selected = JSON.parse(decode('selection.json')) } catch { return fail() }
  if (!exact(manifest, ['schemaVersion', 'format', 'selectionSha256', 'privacy', 'runs', 'consistency', 'execution', 'restoration', 'files'])
    || manifest.schemaVersion !== 1 || manifest.format !== 'jevable.ai/evidence-zip' || manifest.privacy !== expectedPrivacy
    || manifest.consistency !== 'per-run-observations; not-an-atomic-snapshot'
    || manifest.execution !== 'not-started-or-resumed-by-export' || manifest.restoration !== 'unsupported'
    || !hash.test(manifest.selectionSha256) || JSON.stringify(selected) !== JSON.stringify(selection)
    || manifest.selectionSha256 !== await sha256(new TextEncoder().encode(JSON.stringify(selection)))
    || !Array.isArray(manifest.files) || manifest.files.length !== entries.size - 1
    || !Array.isArray(manifest.runs) || manifest.runs.length !== selection.runs.length) return fail()
  const inventory = new Set<string>()
  for (const file of manifest.files) {
    if (!exact(file, ['path', 'bytes', 'sha256']) || typeof file.path !== 'string' || !allowed(file.path)
      || file.path === 'manifest.json' || inventory.has(file.path) || !Number.isSafeInteger(file.bytes)
      || file.bytes < 0 || file.bytes > LIMITS.entry || !hash.test(file.sha256)) return fail()
    const content = entries.get(file.path)
    if (!content || content.length !== file.bytes || await sha256(content) !== file.sha256) return fail()
    inventory.add(file.path)
  }
  if (inventory.size !== entries.size - 1 || [...entries.keys()].some(path => path !== 'manifest.json' && !inventory.has(path))) return fail()
  decode('README.txt')
  const paths = new Set(['manifest.json', 'selection.json', 'README.txt'])
  const runs: Array<{ id: string; revision: string; workflowStatus: string; assessment?: string;
    evidencePath: string; testPath?: string; checkCount?: number }> = []
  for (const [index, selectedRun] of selection.runs.entries()) {
    const declared = manifest.runs[index]
    const evidencePath = `runs/${selectedRun.id}.json`, testPath = `tests/${selectedRun.id}.json`
    if (!record(declared) || declared.id !== selectedRun.id || declared.revision !== selectedRun.revision
      || declared.evidencePath !== evidencePath || !hash.test(declared.snapshotSha256 as string)
      || typeof declared.workflowStatus !== 'string' || typeof declared.observedRunUpdatedAt !== 'string') return fail()
    let envelope: any
    try { envelope = JSON.parse(decode(evidencePath)) } catch { return fail() }
    let verified: Awaited<ReturnType<typeof prepareEvidenceDownload>>
    try { verified = await prepareEvidenceDownload({ runId: selectedRun.id, revision: selectedRun.revision }, envelope,
      expectedPrivacy === 'private-execution-data') } catch { return fail() }
    if (verified.snapshotSha256 !== declared.snapshotSha256 || verified.workflowStatus !== declared.workflowStatus
      || envelope.snapshot.run.updatedAt !== declared.observedRunUpdatedAt) return fail()
    paths.add(evidencePath)
    const run = { id: selectedRun.id, revision: selectedRun.revision, workflowStatus: declared.workflowStatus as string,
      evidencePath, ...('assessment' in declared ? { assessment: declared.assessment as string, testPath } : {}) } as typeof runs[number]
    if ('assessment' in declared) {
      if (declared.testPath !== testPath || !['passed', 'failed', 'pending', 'uncertain'].includes(declared.assessment as string)
        || !record(declared.test)) return fail()
      let assessment: any
      try { assessment = JSON.parse(decode(testPath)) } catch { return fail() }
      if (!record(assessment) || assessment.schemaVersion !== 1 || assessment.format !== 'jevable.ai/test-assessment'
        || assessment.runId !== selectedRun.id || assessment.revision !== selectedRun.revision
        || assessment.assessment !== declared.assessment || assessment.workflowStatus !== declared.workflowStatus
        || assessment.observedRunUpdatedAt !== declared.observedRunUpdatedAt
        || assessment.privateInspection !== (expectedPrivacy === 'private-execution-data')
        || JSON.stringify(assessment.test) !== JSON.stringify(declared.test)
        || !Array.isArray(assessment.checks) || assessment.checks.length < 1 || assessment.checks.length > 64) return fail()
      run.checkCount = assessment.checks.length
      paths.add(testPath)
    } else if ('testPath' in declared || 'test' in declared || entries.has(testPath)) return fail()
    runs.push(run)
  }
  if (paths.size !== entries.size || [...entries.keys()].some(path => !paths.has(path))) return fail()
  return { privacy: expectedPrivacy, files: [...entries.keys()].map(path => ({ path, content: decode(path) })), runs }
}

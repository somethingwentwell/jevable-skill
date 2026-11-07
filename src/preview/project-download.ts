/// <reference lib="dom" />
import type { PreviewProjectPin } from './release.ts'
import type { PreviewReleaseEvidence } from './release-download.ts'

/** Browser-safe receipt/byte verification. The server validates project/history/tests and ZIP entries. */
export async function prepareProjectDownload(expected: { project: PreviewProjectPin; options: { history: boolean; tests: boolean } },
  value: unknown, evidence: PreviewReleaseEvidence | null = null) {
  const fail = (): never => { throw Error('Project download verification failed') }
  const hash = /^[a-f0-9]{64}$/, uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
  const exact = (x: any, keys: string[]) => x && typeof x === 'object' && !Array.isArray(x)
    && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k))
  if (!exact(expected, ['project', 'options']) || !exact(expected.project, ['id', 'generation', 'revision'])
    || !uuid.test(expected.project.id) || !hash.test(expected.project.revision)
    || !Number.isSafeInteger(expected.project.generation) || expected.project.generation < 1
    || !exact(expected.options, ['history', 'tests']) || typeof expected.options.history !== 'boolean' || typeof expected.options.tests !== 'boolean') return fail()
  const wanted = evidence === null ? null : { ...evidence }
  if (wanted && (!exact(wanted, ['sha256', 'selectionSha256', 'privacy']) || !hash.test(wanted.sha256)
    || !hash.test(wanted.selectionSha256) || !['metadata-only', 'private-execution-data'].includes(wanted.privacy))) return fail()
  const pin = { ...expected.project }, options = { ...expected.options }, raw: any = value
  if (!exact(raw, ['schemaVersion', 'format', 'project', 'options', 'bundleSha256', 'tests', 'evidence', 'bytes', 'sha256', 'base64',
    'runnableRelease', 'execution', 'executionStateRestoration']) || typeof raw.base64 !== 'string' || raw.base64.length > 16_000_000) return fail()
  const json = JSON.stringify(raw); if (json.length > 20_000_000) return fail()
  const data = JSON.parse(json)
  if (data.schemaVersion !== 1 || data.format !== 'jevable.ai/preview-project-zip'
    || !exact(data.project, ['id', 'generation', 'revision']) || data.project.id !== pin.id || data.project.generation !== pin.generation || data.project.revision !== pin.revision
    || !exact(data.options, ['history', 'tests']) || data.options.history !== options.history || data.options.tests !== options.tests
    || !hash.test(data.bundleSha256) || !hash.test(data.sha256) || !Number.isSafeInteger(data.bytes) || data.bytes < 4 || data.bytes > 12_000_000
    || data.base64.length !== 4 * Math.ceil(data.bytes / 3) || data.runnableRelease !== false || data.execution !== 'not-run' || data.executionStateRestoration !== 'unsupported'
    || !exact(data.tests, ['included', 'count', 'excludedOtherRevisions', 'importStatus']) || data.tests.included !== options.tests
    || !Number.isSafeInteger(data.tests.count) || data.tests.count < 0 || data.tests.count > 1000
    || !Number.isSafeInteger(data.tests.excludedOtherRevisions) || data.tests.excludedOtherRevisions < 0 || data.tests.excludedOtherRevisions > 10000
    || data.tests.importStatus !== (options.tests ? 'draft-review-required' : 'excluded') || !options.tests && (data.tests.count !== 0 || data.tests.excludedOtherRevisions !== 0)
    || (wanted === null ? data.evidence !== null : !exact(data.evidence, ['sha256', 'selectionSha256', 'privacy'])
      || data.evidence.sha256 !== wanted.sha256 || data.evidence.selectionSha256 !== wanted.selectionSha256 || data.evidence.privacy !== wanted.privacy)) return fail()
  const binary = atob(data.base64); if (binary.length !== data.bytes || btoa(binary) !== data.base64) return fail()
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i)
  if (bytes[0] !== 80 || bytes[1] !== 75 || bytes[2] !== 3 || bytes[3] !== 4) return fail()
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(x => x.toString(16).padStart(2, '0')).join('')
  if (digest !== data.sha256) return fail()
  return { bytes, sha256: digest, bundleSha256: data.bundleSha256 as string, tests: { included: data.tests.included as boolean,
    count: data.tests.count as number, excludedOtherRevisions: data.tests.excludedOtherRevisions as number },
    filename: `jevable-project-${pin.id}-${digest.slice(0, 12)}.zip` }
}

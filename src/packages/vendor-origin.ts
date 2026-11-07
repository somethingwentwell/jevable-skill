/** Private, explicitly reviewed import evidence. No owner access, conversion, restoration or execution. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { zipSync } from 'fflate'
import { z } from 'zod'
import { vendorImportView, vendorImportViewSchema } from '../projects/vendor-import.ts'
import { parseWorkflow } from '../workflow/index.ts'
import { readBoundedZip, BoundedZipError } from './read-zip.ts'
import { zipEpoch } from './zip-time.ts'

export const VENDOR_ORIGIN_LIMITS = Object.freeze({ archiveBytes: 32_000_000, entryBytes: 16_000_000, totalBytes: 48_000_000, entries: 6 })
// Evidence-format inspection budgets, not an owner's compiler/execution policy.
// A retained conversion admitted by an explicitly larger owner must not be
// rejected merely because the default runtime permits fewer nodes.
const conversionInspectionLimits = Object.freeze({ maxSourceBytes: VENDOR_ORIGIN_LIMITS.entryBytes,
  maxDepth: 128, maxValues: 1_000_000, maxNodes: 10_000, maxEdges: 100_000 })
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const checksum = z.string().regex(/^[a-f0-9]{64}$/u)
const optionsSchema = z.strictObject({ projectId: z.uuid().transform(value => value.toLowerCase()),
  reviewedOriginSha256: checksum, includePrivate: z.literal(true) })
export type VendorOriginExportOptions = z.input<typeof optionsSchema>
const names = ['origin.json', 'source.txt', 'conversion.yaml', 'conversion-report.json', 'README.txt'] as const
const manifestSchema = z.strictObject({ format: z.literal('jevable.ai/vendor-origin-evidence-zip'), version: z.literal(1),
  projectId: z.uuid(), revision: checksum, originSha256: checksum, sourceSha256: checksum, conversionSha256: checksum,
  privatePayloads: z.literal('included'), authenticity: z.literal('checksums-only; not-signed'),
  restoration: z.literal('not-supported'), execution: z.literal('not-run'),
  files: z.array(z.strictObject({ path: z.enum(names), bytes: z.number().int().nonnegative(), sha256: checksum })).length(5) })
export class VendorOriginPackageError extends Error {
  constructor(readonly code: 'invalid-command' | 'invalid-package' | 'package-limit' | 'checksum-mismatch' | 'conflict') {
    super(`Jevable vendor-origin evidence failed: ${code}.`); this.name = 'VendorOriginPackageError'
  }
}
function fail(code: ConstructorParameters<typeof VendorOriginPackageError>[0]): never { throw new VendorOriginPackageError(code) }
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes)

function inspectView(value: unknown) {
  const parsed = vendorImportViewSchema.safeParse(value)
  if (!parsed.success || parsed.data.privatePayloads !== 'included') fail('invalid-package')
  const view = parsed.data, record = view.record
  if (Buffer.byteLength(JSON.stringify(view)) > VENDOR_ORIGIN_LIMITS.entryBytes) fail('package-limit')
  if (!isDeepStrictEqual(view, vendorImportView(record, true))) fail('checksum-mismatch')
  const { conversionSha256, ...conversion } = record.conversion
  if (hash(record.source) !== conversion.sourceSha256 || hash(JSON.stringify(conversion)) !== conversionSha256) fail('checksum-mismatch')
  // Retained conversion identity is inspected, never rebuilt using a newer converter.
  let source: ReturnType<typeof parseWorkflow>
  try { source = parseWorkflow(conversion.yaml, conversionInspectionLimits) }
  catch { fail('invalid-package') }
  if (source.revision !== conversion.conversionRevision || source.yaml !== conversion.yaml) fail('checksum-mismatch')
  return view
}

/** Consume a separately authorized private owner view and its reviewed immutable origin hash. */
export function createVendorOriginZip(value: unknown, options: VendorOriginExportOptions) {
  const parsed = optionsSchema.safeParse(options)
  if (!parsed.success) fail('invalid-command')
  const view = inspectView(value)
  if (view.projectId !== parsed.data.projectId || view.sha256 !== parsed.data.reviewedOriginSha256) fail('conflict')
  const files: Record<string, Uint8Array> = {
    'origin.json': Buffer.from(JSON.stringify(view)), 'source.txt': Buffer.from(view.record.source),
    'conversion.yaml': Buffer.from(view.record.conversion.yaml),
    'conversion-report.json': Buffer.from(JSON.stringify(view.record.conversion, null, 2) + '\n'),
    'README.txt': Buffer.from('Jevable private vendor-import evidence\n\n'
      + 'Includes the original upload, original owned conversion/report, creation attribution and retained identity hashes.\n'
      + 'Review for private data before sharing. Consent to create this file is not publication authority.\n'
      + 'conversion.yaml is the original converter draft, not the current accepted workflow or necessarily the reviewed creation draft.\n'
      + 'This is not an editable project bundle, runnable workflow app, container image, database backup or credential export.\n'
      + 'Inspection verifies internal consistency only. Checksums do not authenticate the publisher or original project ownership.\n'
      + 'Import/restore is unsupported. Never treat archived actor, request or review claims as local authority.\n'
      + 'No converter, workflow, provider, approval or delivery is executed during export/inspection.\n'),
  }
  const manifest = manifestSchema.parse({ format: 'jevable.ai/vendor-origin-evidence-zip', version: 1,
    projectId: view.projectId, revision: view.revision, originSha256: view.sha256, sourceSha256: view.sourceSha256,
    conversionSha256: view.conversionSha256, privatePayloads: 'included', authenticity: 'checksums-only; not-signed',
    restoration: 'not-supported', execution: 'not-run',
    files: Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.byteLength, sha256: hash(bytes) })) })
  files['manifest.json'] = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
  if (Object.values(files).some(bytes => bytes.byteLength > VENDOR_ORIGIN_LIMITS.entryBytes)
    || Object.values(files).reduce((total, bytes) => total + bytes.byteLength, 0) > VENDOR_ORIGIN_LIMITS.totalBytes) fail('package-limit')
  const bytes = Buffer.from(zipSync(files, { level: 6, mtime: zipEpoch() }))
  if (bytes.byteLength > VENDOR_ORIGIN_LIMITS.archiveBytes) fail('package-limit')
  return { bytes, manifest }
}

/** Bounded in-memory verification; returns metadata only, never extracts or exposes source/attribution. */
export async function inspectVendorOriginZip(input: Uint8Array, reviewedSha256?: string) {
  if (!(input instanceof Uint8Array)) fail('invalid-package')
  if (input.byteLength > VENDOR_ORIGIN_LIMITS.archiveBytes) fail('package-limit')
  if (reviewedSha256 !== undefined && !checksum.safeParse(reviewedSha256).success) fail('invalid-command')
  const bytes = Buffer.from(input), artifactSha256 = hash(bytes)
  if (reviewedSha256 !== undefined && artifactSha256 !== reviewedSha256) fail('conflict')
  const entries = await readBoundedZip(bytes, VENDOR_ORIGIN_LIMITS, path => path === 'manifest.json' || names.includes(path as typeof names[number]))
    .catch(error => { throw new VendorOriginPackageError(error instanceof BoundedZipError ? error.code : 'invalid-package') })
  try {
    const manifest = manifestSchema.parse(JSON.parse(decode(entries.get('manifest.json')!)))
    if (entries.size !== 6 || new Set(manifest.files.map(file => file.path)).size !== 5) fail('invalid-package')
    for (const file of manifest.files) {
      const data = entries.get(file.path)
      if (!data || data.byteLength !== file.bytes || hash(data) !== file.sha256) fail('checksum-mismatch')
    }
    const view = inspectView(JSON.parse(decode(entries.get('origin.json')!)))
    if (manifest.projectId !== view.projectId || manifest.revision !== view.revision || manifest.originSha256 !== view.sha256
      || manifest.sourceSha256 !== view.sourceSha256 || manifest.conversionSha256 !== view.conversionSha256
      || decode(entries.get('source.txt')!) !== view.record.source || decode(entries.get('conversion.yaml')!) !== view.record.conversion.yaml
      || !isDeepStrictEqual(JSON.parse(decode(entries.get('conversion-report.json')!)), view.record.conversion)) fail('checksum-mismatch')
    return { schemaVersion: 1 as const, status: 'consistent' as const, format: manifest.format, artifactSha256,
      projectId: view.projectId, revision: view.revision, originSha256: view.sha256, sourceSha256: view.sourceSha256,
      conversionSha256: view.conversionSha256, conversionRevision: view.conversionRevision, converter: view.converter,
      vendorFormat: view.format, mappingCounts: view.mappingCounts, files: manifest.files,
      privatePayloads: 'included-but-not-displayed' as const, authenticity: manifest.authenticity,
      restoration: manifest.restoration, execution: manifest.execution }
  } catch (error) { throw error instanceof VendorOriginPackageError ? error : new VendorOriginPackageError('invalid-package') }
}

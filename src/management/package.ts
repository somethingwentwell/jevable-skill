import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'
import { readBoundedBytes } from '../files.ts'
import { CORE_VERSION } from '../capabilities.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { zipEpoch } from '../packages/zip-time.ts'
import { z } from 'zod'

const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
export const MANAGEMENT_PACKAGE_FILES = Object.freeze([
  'bin/jevable.mjs', 'dist/management/core-runtime.mjs', 'dist/management/core-runtime.json', 'dist/management/core-NOTICES.txt',
  'dist/release-runtime.mjs', 'dist/release-runtime.json', 'dist/release-NOTICES.txt',
  'dist/release-postgres-runtime.mjs', 'dist/release-postgres-runtime.json', 'dist/release-postgres-NOTICES.txt', 'README.txt',
])
export const MANAGEMENT_COORDINATED_PACKAGE_FILES = Object.freeze([...MANAGEMENT_PACKAGE_FILES,
  'dist/release-sqlite-coordinated-runtime.mjs', 'dist/release-sqlite-coordinated-runtime.json', 'dist/release-sqlite-coordinated-NOTICES.txt'])
const archiveOptions = z.strictObject({ rateCoordinator: z.literal('postgres').optional() })
export type RuntimeArchiveOptions = z.infer<typeof archiveOptions>
const readme = `Jevable workflow runtime — standalone management distribution

Requires Node.js >=22.19.0 with built-in SQLite. No npm install, desktop,
Jarness/harness, authoring agent, skill or Docker is required to execute this CLI.
Run: node bin/jevable.mjs --help
Offline: node bin/jevable.mjs templates list
Run a workflow: node bin/jevable.mjs run workflow.yaml --input input.json --data-dir /private/jevable-data
Start an explicit service: create a private token with runtime token --output,
then runtime serve --token-file <private-token-file> --data-dir <private-directory>.
Default service binding is authenticated loopback HTTP. Use the documented
explicit certificate/origin profile for direct HTTPS; never expose a plaintext
listener or mount a Docker socket to make management reachable.

This is the full management CLI, not an immutable workflow release. It can author,
review, test, execute and export workflows with the same current limitations as
the core version. Configure providers, credentials, storage and telemetry afresh.
No workflow, data directory, credential, test/run history or conversation is bundled.
Keep data outside this program directory and preserve single-owner storage rules.
SQLite is the local default; PostgreSQL requires explicit private configuration.
Portable and live HTML remain experimental and are not browser-qualified.

Checksums detect accidental modification; they are not signatures or independent
authenticity evidence. Verify the archive hash through your trusted distribution.
This package is not a Docker image or a managed Docker/Kubernetes launcher.
No server starts on import, export or extraction. Review before executing commands.
Proprietary distribution terms remain unpublished; retain all included notices.
`

/** Fixed shipped assets only: never enumerate the working directory or open runtime state. */
export async function createManagementFiles(readBytes = readBoundedBytes, options: RuntimeArchiveOptions = {}) {
  const selected = archiveOptions.safeParse(options)
  if (!selected.success) throw new WorkflowRuntimeError('invalid-command')
  const coordinated = selected.data.rateCoordinator === 'postgres'
  const files: Record<string, Uint8Array> = {
    'bin/jevable.mjs': Buffer.from("#!/usr/bin/env node\nimport { main } from '../dist/management/core-runtime.mjs'\nprocess.exitCode = await main(process.argv.slice(2))\n"),
    'README.txt': Buffer.from(readme + (coordinated ? '\nExplicit optional profile: this schema-2 archive also contains the separate SQLite workflow/PostgreSQL HTTP quota runtime. Select releases create --runtime-storage sqlite --runtime-rate-coordinator postgres. Workflow history stays in SQLite; quota connection/configuration/credentials are never bundled. Direct jobs need no quota server.\n' : '')),
  }
  const identities: { role: string; sha256: string; bytes: number }[] = []
  const runtimes: readonly (readonly [string, string])[] = [['management', './core'], ['sqlite', '../release'], ['postgres', '../release-postgres'],
    ...(coordinated ? [['sqlite-coordinated', '../release-sqlite-coordinated'] as const] : [])]
  for (const [role, stem] of runtimes) {
    const runtime = await readBytes(fileURLToPath(new URL(`${stem}-runtime.mjs`, import.meta.url)), 32_000_000)
    const metadataBytes = await readBytes(fileURLToPath(new URL(`${stem}-runtime.json`, import.meta.url)), 1_000_000)
    let metadata: { storage?: unknown; external?: unknown; sha256?: unknown; bytes?: unknown; schemaVersion?: unknown; coreVersion?: unknown; rateCoordinator?: unknown }
    try { metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadataBytes)) } catch { throw new WorkflowRuntimeError('corrupt') }
    if (!metadata || metadata.schemaVersion !== 1 || metadata.storage !== (role === 'sqlite-coordinated' ? 'sqlite' : role) || metadata.external !== 'node-builtins-only'
      || metadata.rateCoordinator !== (role === 'sqlite-coordinated' ? 'postgres' : undefined)
      || (role === 'management' && metadata.coreVersion !== CORE_VERSION)
      || metadata.sha256 !== digest(runtime) || metadata.bytes !== runtime.byteLength) throw new WorkflowRuntimeError('corrupt')
    const notices = await readBytes(fileURLToPath(new URL(`${stem}-NOTICES.txt`, import.meta.url)), 2_000_000)
    if (!notices.byteLength) throw new WorkflowRuntimeError('corrupt')
    const target = role === 'management' ? 'dist/management/core' : role === 'sqlite' ? 'dist/release' : role === 'sqlite-coordinated' ? 'dist/release-sqlite-coordinated' : 'dist/release-postgres'
    files[`${target}-runtime.mjs`] = runtime
    files[`${target}-runtime.json`] = metadataBytes
    files[`${target}-NOTICES.txt`] = notices
    identities.push({ role, sha256: digest(runtime), bytes: runtime.byteLength })
  }
  const manifest = { ...(coordinated ? { schemaVersion: 2 as const, rateCoordinator: 'postgres' as const } : { schemaVersion: 1 as const }), format: 'jevable.ai/management-zip', version: CORE_VERSION,
    entrypoint: 'bin/jevable.mjs', requires: { node: '>=22.19.0', sqlite: 'builtin', npmInstall: false, docker: false },
    runtimes: identities, files: (coordinated ? MANAGEMENT_COORDINATED_PACKAGE_FILES : MANAGEMENT_PACKAGE_FILES).map(path => ({ path, bytes: files[path]!.byteLength, sha256: digest(files[path]!) })),
    state: 'excluded', credentials: 'excluded', authenticity: 'checksums-only; not-signed', execution: 'not-started-by-export' }
  files['manifest.json'] = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
  if (Object.values(files).reduce((sum, bytes) => sum + bytes.byteLength, 0) > 64_000_000) throw new WorkflowRuntimeError('limit')
  return { files, manifest }
}

export async function createManagementZip(readBytes = readBoundedBytes, options: RuntimeArchiveOptions = {}) {
  const { files, manifest } = await createManagementFiles(readBytes, options)
  return { bytes: Buffer.from(zipSync(files, { level: 6, mtime: zipEpoch() })), manifest }
}

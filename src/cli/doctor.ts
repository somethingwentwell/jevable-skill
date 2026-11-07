import { lstat, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { CORE_VERSION, PROTOCOL_VERSION } from '../capabilities.ts'
import { loadReleaseRuntime } from '../packages/release-zip.ts'
import { readPrivateConfig } from '../http/private-config.ts'
import { readSecretFile } from '../providers/secret-input.ts'
import { readTlsPemFile } from '../http/tls.ts'
import { RuntimeClient, RuntimeHttpError } from '../http/client.ts'
import { parseTelemetryConfig } from '../telemetry/config.ts'
import { CliStorageUsageError, storageSelection, type CliValues } from './runtime.ts'

type Check = { id: string; status: 'pass' | 'warning' | 'fail'; code: string; message: string }
/** Diagnostic inputs may be broken; opening a FIFO must not block before checking its type. */
async function readDiagnosticFile(path: string, limit: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > limit) throw Error()
    const bytes = Buffer.alloc(Math.min(stat.size + 1, limit + 1)); let length = 0
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    if (length !== stat.size || length > limit) throw Error()
    return bytes.subarray(0, length)
  } finally { await file.close() }
}
export function supportedNodeVersion(version: string) {
  const parts = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(version)
  return Boolean(parts && (Number(parts[1]) > 22 || (Number(parts[1]) === 22 && Number(parts[2]) >= 19)))
}
const serviceCapabilities = z.object({ schemaVersion: z.literal(1), product: z.enum(['Jevable core', 'Jevable workflow runtime']),
  version: z.string().max(128), protocolVersion: z.string().max(128), instanceId: z.uuid(), api: z.object({ protocol: z.string().max(128) }) })
const serviceHealth = z.object({ schemaVersion: z.literal(1), instanceId: z.uuid(), status: z.enum(['ready', 'draining', 'closed']),
  runtime: z.discriminatedUnion('storage', [
    z.object({ storage: z.literal('postgres'), database: z.literal('reachable'), state: z.literal('open') }),
    z.object({ storage: z.literal('sqlite'), telemetry: z.object({ enabled: z.boolean(), signals: z.array(z.enum(['traces', 'metrics', 'logs'])).max(3) }) }),
  ]).optional() })

/** I/O-free diagnostic scope admission, also used before dispatcher handoff. */
export function doctorSelection(values: CliValues) {
  const endpoint = values.endpoint
  if (endpoint !== undefined) {
    if (typeof endpoint !== 'string' || !endpoint || typeof values['token-file'] !== 'string' || !values['token-file']
      || ['storage', 'database-file', 'data-dir', 'telemetry-file'].some(key => values[key] !== undefined)) {
      throw new CliStorageUsageError('Service diagnosis requires --endpoint and --token-file; do not mix local storage/configuration flags.')
    }
  } else if (['token-file', 'ca-file', 'timeout-ms'].some(key => values[key] !== undefined)) {
    throw new CliStorageUsageError('Service credentials, CA and timeout require an explicit --endpoint.')
  }
  const storage = endpoint === undefined ? storageSelection(values) : undefined
  const timeout = values['timeout-ms'] === undefined ? 3000 : Number(values['timeout-ms'])
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000
    || (values['timeout-ms'] !== undefined && !/^[1-9][0-9]*$/u.test(String(values['timeout-ms'])))) {
    throw new CliStorageUsageError('Doctor timeout must be 1–30000 milliseconds.')
  }
  return { endpoint, storage, timeout }
}

/** No store is opened, no subprocess launched and no network used unless an endpoint is explicit. */
export async function doctor(values: CliValues) {
  const { endpoint, storage, timeout } = doctorSelection(values)
  const checks: Check[] = []
  const add = (id: string, status: Check['status'], code: string, message: string) => checks.push({ id, status, code, message })
  const probe = async (id: string, work: () => Promise<void>, pass: string, failure: string) => {
    try { await work(); add(id, 'pass', 'valid', pass) }
    catch { add(id, 'fail', 'unavailable-or-invalid', failure) }
  }
  add('node', supportedNodeVersion(process.versions.node) ? 'pass' : 'fail', supportedNodeVersion(process.versions.node) ? 'supported' : 'unsupported',
    'Node >=22.19.0 is required; passing this version check is not platform qualification.')
  await probe('sqlite-module', async () => { const module = await import('node:sqlite'); if (typeof module.DatabaseSync !== 'function') throw Error() },
    'Built-in SQLite module is available; no database was opened.', 'Use a supported Node distribution with the built-in SQLite module enabled.')
  for (const backend of ['sqlite', 'postgres'] as const) await probe(`release-${backend}`, async () => { await loadReleaseRuntime(backend, readDiagnosticFile) },
    'Bundled runtime bytes, metadata and notices are readable and checksums agree; this is not publisher authentication.',
    'Runtime bundle is missing, unreadable or inconsistent. Reinstall the trusted package, or rebuild this source checkout; do not substitute a harness runtime.')
  if (typeof values['data-dir'] === 'string') {
    try {
      const directory = await lstat(values['data-dir'])
      if (!directory.isDirectory() || (process.platform !== 'win32' && ((directory.mode & 0o077) !== 0 || directory.uid !== process.getuid?.()))) throw Error()
      add('data-directory', 'pass', 'private-directory', 'Directory metadata is private; write access, schema and journal integrity were not tested.')
      for (const name of ['runtime.sqlite', 'runtime.lock']) {
        try {
          const info = await lstat(join(values['data-dir'], name))
          if (!info.isFile() || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) throw Error()
          add(name, name === 'runtime.lock' ? 'warning' : 'pass', name === 'runtime.lock' ? 'lock-present' : 'private-file',
            name === 'runtime.lock' ? 'Owner lock exists. Use the owning service or inspect ownership; no stale-lock assumption or repair was made.' : 'Database file metadata is private; contents were not opened.')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') add(name, name === 'runtime.lock' ? 'pass' : 'warning', 'absent',
            name === 'runtime.lock' ? 'No lock observed at this instant; this does not reserve ownership.' : 'Database is not initialized; doctor did not create it.')
          else add(name, 'fail', 'unsafe-or-unreadable', 'Expected an owned private regular file; no contents were read or modified.')
        }
      }
    } catch (error) {
      add('data-directory', (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'warning' : 'fail',
        (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unsafe-or-unreadable',
        'Directory is absent, unreadable or not an owned private directory. Doctor never creates directories or changes permissions.')
    }
  }
  if (storage === 'postgres') await probe('database-config', async () => {
    const { parsePostgresConfiguration } = await import('../storage/postgres-config.ts')
    parsePostgresConfiguration(await readPrivateConfig(values['database-file'] as string))
  }, 'Private PostgreSQL configuration and TLS policy are valid; no connection, initialization, credential or ownership check was made.',
  'Check the private regular file, owner-only permissions, PostgreSQL fields and TLS policy. Values and parser errors are withheld.')
  if (typeof values['telemetry-file'] === 'string') await probe('telemetry-config', async () => {
    parseTelemetryConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readDiagnosticFile(values['telemetry-file'] as string, 16000))))
  }, 'Telemetry configuration is valid; collector reachability and credential references were not checked.',
  'Check the bounded telemetry JSON, allowed endpoints and resource fields. No telemetry was sent.')
  if (typeof endpoint === 'string') {
    try {
      const token = await readSecretFile(values['token-file'] as string)
      const ca = typeof values['ca-file'] === 'string' ? await readTlsPemFile(values['ca-file']) : undefined
      const client = new RuntimeClient(endpoint, token, timeout, 256000, ca === undefined ? {} : { ca })
      const caps = serviceCapabilities.safeParse(await client.capabilities())
      if (!caps.success) add('service', 'fail', 'invalid-response', 'Service capabilities did not match the bounded Jevable contract.')
      else if (caps.data.protocolVersion !== PROTOCOL_VERSION || caps.data.api.protocol !== PROTOCOL_VERSION) add('service', 'fail', 'protocol-mismatch', 'Select a runtime with the same protocol; no operation was submitted.')
      else if (caps.data.version !== CORE_VERSION) add('service', 'fail', 'version-mismatch', 'Runtime and CLI versions differ; their compatibility is not qualified. Install matching versions before operations.')
      else {
        const health = serviceHealth.safeParse(await client.health())
        if (!health.success) add('service', 'fail', 'invalid-response', 'Service health did not match the expected contract.')
        else if (health.data.instanceId !== caps.data.instanceId) add('service', 'fail', 'instance-changed', 'Service changed between diagnostic reads. Repeat diagnosis; no operation was submitted.')
        else add('service', health.data.status === 'ready' ? 'pass' : 'warning', health.data.status,
          'Authenticated capabilities and health were read from one compatible instance. This does not establish workflow readiness, release trust or approval authority.')
      }
    } catch (error) {
      const codes = ['protocol-mismatch', 'redirect-refused', 'invalid-endpoint', 'invalid-config', 'invalid-response', 'response-limit', 'request-timeout', 'transport-uncertain', 'unauthorized']
      const code = error instanceof RuntimeHttpError && codes.includes(error.code) ? error.code : 'service-unavailable-or-invalid'
      add('service', 'fail', code, 'Check the explicit URL, private token, TLS trust and service availability. No redirects, retries or mutations were performed; remote error details are withheld.')
    }
  }
  return { schemaVersion: 1, status: checks.some(c => c.status === 'fail') ? 'failed' : checks.some(c => c.status === 'warning') ? 'attention' : 'passed',
    version: CORE_VERSION, protocolVersion: PROTOCOL_VERSION, node: process.version, platform: process.platform, architecture: process.arch,
    mode: endpoint === undefined ? 'local-inspection' : 'explicit-service-inspection', checks,
    runtimeReadiness: 'not-checked; use check with an explicitly selected workflow and storage', execution: 'not-run',
    mutations: 'none', network: endpoint === undefined ? 'none' : 'authenticated-capabilities-and-health-only',
    notChecked: ['provider/model availability', 'credential validity', 'workflow readiness', 'journal integrity or schema migration', 'Docker or Kubernetes', 'publisher authenticity'] }
}

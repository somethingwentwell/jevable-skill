import type { PostgresJournalOptions } from './postgres-config.ts'
import { readPrivateConfig } from '../http/private-config.ts'
import { readBoundedFile } from '../files.ts'
import { parseTelemetryConfig } from '../telemetry/config.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { notificationOptions } from '../notifications/options.ts'

/** Explicit private configuration; no ambient endpoint, credential or backend fallback. */
export async function postgresRuntimeOptions(values: Record<string, string | boolean | undefined>) {
  if (typeof values['database-file'] !== 'string' || !values['database-file'] || values['data-dir'] !== undefined) throw new WorkflowRuntimeError('invalid-command')
  const notifications = await notificationOptions(values)
  const database = await readPrivateConfig(values['database-file']) as PostgresJournalOptions
  let telemetry
  if (typeof values['telemetry-file'] === 'string') {
    try { telemetry = parseTelemetryConfig(JSON.parse(await readBoundedFile(values['telemetry-file'], 16000))) }
    catch { throw new WorkflowRuntimeError('invalid-command') }
  }
  return { database, ...(telemetry ? { telemetry } : {}), ...(notifications ? { notifications } : {}) }
}

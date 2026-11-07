import { resolve } from 'node:path'
import { readBoundedFile } from '../files.ts'
import { parseTelemetryConfig } from './config.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { notificationOptions } from '../notifications/options.ts'

export async function localRuntimeOptions(values: Record<string, string | boolean | undefined>, defaultDirectory = '.jevable') {
  const dataDirectory = resolve(typeof values['data-dir'] === 'string' ? values['data-dir'] : defaultDirectory)
  const notifications = await notificationOptions(values)
  const base = { dataDirectory, ...(notifications ? { notifications } : {}) }
  if (typeof values['telemetry-file'] !== 'string') return base
  let value: unknown
  try { value = JSON.parse(await readBoundedFile(values['telemetry-file'], 16000)) } catch { throw new WorkflowRuntimeError('invalid-command') }
  return { ...base, telemetry: parseTelemetryConfig(value) }
}

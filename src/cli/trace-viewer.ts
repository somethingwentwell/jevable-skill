import { readBoundedFile } from '../files.ts'
import { traceNavigationTools } from '../telemetry/navigation.ts'
import { traceViewerConfigSchema } from '../telemetry/navigation-schema.ts'
import { CliStorageUsageError } from './runtime.ts'

export async function readTraceViewerFile(value: unknown) {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new CliStorageUsageError('Provide a trace viewer JSON file path.')
  const contents = await readBoundedFile(value, 4096)
  try { return traceNavigationTools().config(traceViewerConfigSchema.parse(JSON.parse(contents))) }
  catch { throw new CliStorageUsageError('Invalid trace viewer configuration. Use a credential-free HTTPS origin (or literal loopback HTTP) with a trace-ID path or reviewed Grafana Tempo Explore profile.') }
}

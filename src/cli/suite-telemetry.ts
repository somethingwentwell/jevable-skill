import { stat } from 'node:fs/promises'
import { readPrivateConfig } from '../http/private-config.ts'
import { readSecretFile } from '../providers/secret-input.ts'
import { parseSuiteTelemetryConfig } from '../testing/telemetry.ts'
import { CliStorageUsageError, type CliValues } from './runtime.ts'

export const suiteTelemetryFlags = ['suite-telemetry-file', 'suite-telemetry-credential-file']
/** Pure selection guard: these are client diagnostics, never selected-owner configuration. */
export function suiteTelemetrySelection(values: CliValues, selection: 'selected' | 'http' | 'local') {
  if (!suiteTelemetryFlags.some(key => values[key] !== undefined)) return
  if (selection === 'local' || typeof values['suite-telemetry-file'] !== 'string' || !values['suite-telemetry-file']
    || (values['suite-telemetry-credential-file'] !== undefined && (typeof values['suite-telemetry-credential-file'] !== 'string' || !values['suite-telemetry-credential-file']))) {
    throw new CliStorageUsageError('Client suite telemetry requires a selected endpoint/Docker owner and --suite-telemetry-file; direct owners use --telemetry-file.')
  }
}
/** Validate private client config/key before owner credentials or network. Never consult workflow credential storage. */
export async function readSuiteTelemetryOptions(values: CliValues) {
  if (values['suite-telemetry-file'] === undefined) return undefined
  try {
    const config = parseSuiteTelemetryConfig(await readPrivateConfig(values['suite-telemetry-file'] as string, 16000))
    const credentialFile = values['suite-telemetry-credential-file']
    if ((config.authentication.kind === 'bearer') !== (typeof credentialFile === 'string')) throw new Error()
    if (typeof credentialFile !== 'string') return { config }
    // Refuse direct or hard-linked reuse of the management credential file.
    const [exporter, owner] = await Promise.all([stat(credentialFile), stat(values['token-file'] as string)])
    if (exporter.dev === owner.dev && exporter.ino === owner.ino) throw new Error()
    const key = await readSecretFile(credentialFile)
    return { config, credential: () => key }
  } catch { throw new CliStorageUsageError('Suite telemetry requires a valid owner-only client JSON and, for bearer export, a separate protected credential file; values are not displayed.') }
}

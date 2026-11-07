import type { LocalRuntime } from '../runtime/local.ts'
import type { PostgresRuntime } from '../runtime/postgres.ts'
import { localRuntimeOptions } from '../telemetry/options.ts'
import { postgresRuntimeOptions } from '../storage/postgres-options.ts'

import { CliStorageUsageError, type CliValues } from './usage.ts'
export { CliStorageUsageError, type CliValues } from './usage.ts'
export type CliRuntime = { storage: 'sqlite'; runtime: LocalRuntime } | { storage: 'postgres'; runtime: PostgresRuntime }

export function storageSelection(values: CliValues): 'sqlite' | 'postgres' {
  const storage = values.storage ?? 'sqlite'
  if ((storage !== 'sqlite' && storage !== 'postgres')
    || (storage === 'sqlite' && values['database-file'] !== undefined)
    || (storage === 'postgres' && (typeof values['database-file'] !== 'string' || !values['database-file'] || values['data-dir'] !== undefined))) {
    throw new CliStorageUsageError()
  }
  return storage
}

export { postgresRuntimeOptions } from '../storage/postgres-options.ts'

/** A direct SDK owner, never an HTTP client, harness launcher or storage fallback. */
export async function openCliRuntime(values: CliValues): Promise<CliRuntime> {
  if (storageSelection(values) === 'postgres') {
    const { PostgresRuntime } = await import('../runtime/postgres.ts')
    return { storage: 'postgres', runtime: await PostgresRuntime.open(await postgresRuntimeOptions(values)) }
  }
  const { LocalRuntime } = await import('../runtime/local.ts')
  return { storage: 'sqlite', runtime: await LocalRuntime.open(await localRuntimeOptions(values)) }
}

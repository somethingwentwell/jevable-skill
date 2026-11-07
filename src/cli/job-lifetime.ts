import { openCliOperations, operationSelection, type CliOperations } from './operations.ts'
import type { CliValues } from './runtime.ts'
import { JobLifetime as CliJobLifetime } from '../process/job-lifetime.ts'
export { JobLifetime as CliJobLifetime, JobInterruptedError as CliJobInterruptedError } from '../process/job-lifetime.ts'

/** Validate selection before installing handlers; never acquire shutdown authority over a service. */
export async function openJobOperations(values: CliValues, lifetime: CliJobLifetime,
  open: (values: CliValues) => Promise<CliOperations> = openCliOperations): Promise<CliOperations> {
  if (operationSelection(values) !== 'local') return open(values)
  const release = lifetime.hold()
  let owner: CliOperations
  try { owner = await open(values) }
  catch (error) { release(); throw error }
  let closing: Promise<void> | undefined
  return { storage: owner.storage, async call(command, parent) {
    lifetime.assertAdmission()
    return parent === undefined ? owner.call(command) : owner.call(command, parent)
  }, close() {
    // Keep handlers through telemetry/storage cleanup; duplicate close joins the same result.
    return closing ??= (async () => { try { await owner.close() } finally { release() } })()
  } }
}

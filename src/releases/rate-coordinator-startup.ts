import { ReleaseRateCoordinatorStartupError, type ReleaseBackend } from './app.ts'

/** Only explicitly bundled quota-capable entries import this adapter. No workflow database owner. */
export const preparePostgresReleaseRateCoordinator: NonNullable<ReleaseBackend['prepareRateCoordinator']> = async values => {
  const { readCliRateCoordinator } = await import('../http/cli-rate-coordinator.ts')
  const options = await readCliRateCoordinator(values)
  if (!options) throw new ReleaseRateCoordinatorStartupError('invalid-config')
  return async () => {
    const { PostgresHttpRateCoordinator, PostgresHttpRateCoordinatorError } = await import('../http/postgres-rate-limits.ts')
    try { return await PostgresHttpRateCoordinator.open(options) }
    catch (error) { throw new ReleaseRateCoordinatorStartupError(error instanceof PostgresHttpRateCoordinatorError ? error.code : 'unavailable') }
  }
}

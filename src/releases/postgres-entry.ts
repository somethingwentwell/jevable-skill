import { runReleaseApp } from './app.ts'
import { preparePostgresReleaseRateCoordinator } from './rate-coordinator-startup.ts'

/** PostgreSQL release entry. Explicit database file on every stateful invocation; no SQLite fallback. */
export const releaseMain = (value: unknown, argv: string[], directory: string) => runReleaseApp({
  storage: 'postgres',
  prepareRateCoordinator: preparePostgresReleaseRateCoordinator,
  open: async (values, _directory, release) => {
    const { postgresRuntimeOptions } = await import('../storage/postgres-options.ts')
    const options = await postgresRuntimeOptions(values)
    const { PostgresRuntime } = await import('../runtime/postgres.ts')
    return PostgresRuntime.open({ ...options, ...(options.notifications?.automatic ? { startupRelease: release } : {}) })
  },
  serve: async (values, _directory, options) => {
    const { postgresRuntimeOptions } = await import('../storage/postgres-options.ts')
    const runtime = await postgresRuntimeOptions(values)
    const { startPostgresRuntimeService } = await import('../http/postgres.ts')
    return startPostgresRuntimeService({ ...options, runtime })
  },
}, value, argv, directory)

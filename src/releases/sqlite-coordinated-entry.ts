import { runReleaseApp } from './app.ts'
import { sqliteReleaseBackend } from './entry.ts'
import { preparePostgresReleaseRateCoordinator } from './rate-coordinator-startup.ts'

/** Opt-in separate bundle: SQLite workflow journal plus PostgreSQL HTTP quotas only. */
export const releaseMain = (value: unknown, argv: string[], directory: string) => runReleaseApp({
  ...sqliteReleaseBackend, rateCoordinator: 'postgres', prepareRateCoordinator: preparePostgresReleaseRateCoordinator,
}, value, argv, directory)

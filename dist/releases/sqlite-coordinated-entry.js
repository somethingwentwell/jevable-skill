import { runReleaseApp } from "./app.js";
import { sqliteReleaseBackend } from "./entry.js";
import { preparePostgresReleaseRateCoordinator } from "./rate-coordinator-startup.js";
/** Opt-in separate bundle: SQLite workflow journal plus PostgreSQL HTTP quotas only. */
export const releaseMain = (value, argv, directory) => runReleaseApp({
    ...sqliteReleaseBackend, rateCoordinator: 'postgres', prepareRateCoordinator: preparePostgresReleaseRateCoordinator,
}, value, argv, directory);

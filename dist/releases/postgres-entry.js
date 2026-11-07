import { runReleaseApp } from "./app.js";
import { preparePostgresReleaseRateCoordinator } from "./rate-coordinator-startup.js";
/** PostgreSQL release entry. Explicit database file on every stateful invocation; no SQLite fallback. */
export const releaseMain = (value, argv, directory) => runReleaseApp({
    storage: 'postgres',
    prepareRateCoordinator: preparePostgresReleaseRateCoordinator,
    open: async (values, _directory, release) => {
        const { postgresRuntimeOptions } = await import("../storage/postgres-options.js");
        const options = await postgresRuntimeOptions(values);
        const { PostgresRuntime } = await import("../runtime/postgres.js");
        return PostgresRuntime.open({ ...options, ...(options.notifications?.automatic ? { startupRelease: release } : {}) });
    },
    serve: async (values, _directory, options) => {
        const { postgresRuntimeOptions } = await import("../storage/postgres-options.js");
        const runtime = await postgresRuntimeOptions(values);
        const { startPostgresRuntimeService } = await import("../http/postgres.js");
        return startPostgresRuntimeService({ ...options, runtime });
    },
}, value, argv, directory);

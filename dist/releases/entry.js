import { resolve } from 'node:path';
import { localRuntimeOptions } from "../telemetry/options.js";
import { runReleaseApp } from "./app.js";
/** SQLite release entry. Its bundle never imports a PostgreSQL driver. */
export const sqliteReleaseBackend = {
    storage: 'sqlite',
    open: async (values, directory, release) => {
        const { LocalRuntime } = await import("../runtime/local.js");
        const options = await localRuntimeOptions(values, resolve(directory, '.jevable'));
        return LocalRuntime.open({ ...options, ...(options.notifications?.automatic ? { startupRelease: release } : {}) });
    },
    serve: async (values, directory, options) => {
        const { startRuntimeService } = await import("../http/service.js");
        return startRuntimeService({ ...options, runtime: await localRuntimeOptions(values, resolve(directory, '.jevable')) });
    },
};
export const releaseMain = (value, argv, directory) => runReleaseApp(sqliteReleaseBackend, value, argv, directory);

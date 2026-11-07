import { localRuntimeOptions } from "../telemetry/options.js";
import { postgresRuntimeOptions } from "../storage/postgres-options.js";
import { CliStorageUsageError } from "./usage.js";
export { CliStorageUsageError } from "./usage.js";
export function storageSelection(values) {
    const storage = values.storage ?? 'sqlite';
    if ((storage !== 'sqlite' && storage !== 'postgres')
        || (storage === 'sqlite' && values['database-file'] !== undefined)
        || (storage === 'postgres' && (typeof values['database-file'] !== 'string' || !values['database-file'] || values['data-dir'] !== undefined))) {
        throw new CliStorageUsageError();
    }
    return storage;
}
export { postgresRuntimeOptions } from "../storage/postgres-options.js";
/** A direct SDK owner, never an HTTP client, harness launcher or storage fallback. */
export async function openCliRuntime(values) {
    if (storageSelection(values) === 'postgres') {
        const { PostgresRuntime } = await import("../runtime/postgres.js");
        return { storage: 'postgres', runtime: await PostgresRuntime.open(await postgresRuntimeOptions(values)) };
    }
    const { LocalRuntime } = await import("../runtime/local.js");
    return { storage: 'sqlite', runtime: await LocalRuntime.open(await localRuntimeOptions(values)) };
}

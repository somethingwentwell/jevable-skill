import type { LocalRuntime } from '../runtime/local.ts';
import type { PostgresRuntime } from '../runtime/postgres.ts';
import { type CliValues } from './usage.ts';
export { CliStorageUsageError, type CliValues } from './usage.ts';
export type CliRuntime = {
    storage: 'sqlite';
    runtime: LocalRuntime;
} | {
    storage: 'postgres';
    runtime: PostgresRuntime;
};
export declare function storageSelection(values: CliValues): 'sqlite' | 'postgres';
export { postgresRuntimeOptions } from '../storage/postgres-options.ts';
/** A direct SDK owner, never an HTTP client, harness launcher or storage fallback. */
export declare function openCliRuntime(values: CliValues): Promise<CliRuntime>;

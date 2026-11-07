import type { ProviderConnectionRecord } from './config.ts';
import type { ModelEvidence } from './records.ts';
/** Domain-validated storage, whether synchronous SQLite or asynchronous PostgreSQL. */
export interface ProviderPersistence {
    readonly signal?: AbortSignal;
    connection(id: string): ProviderConnectionRecord | undefined | Promise<ProviderConnectionRecord | undefined>;
    credential(ref: string): string | undefined | Promise<string | undefined>;
    evidence(id: string): ModelEvidence | undefined | Promise<ModelEvidence | undefined>;
    saveEvidence(record: ModelEvidence): void | Promise<void>;
}

import type { ProviderPersistence } from './persistence.ts';
export interface ModelDiscoveryOptions {
    signal?: AbortSignal;
}
/** Explicit advisory GET only. No model execution, permission changes, pagination, redirects or retries. */
export declare function discoverConfiguredModels(store: Pick<ProviderPersistence, 'signal' | 'connection' | 'credential'>, id: string, options?: ModelDiscoveryOptions): Promise<{
    schemaVersion: 1;
    connection: {
        id: string;
        generation: number;
        provider: string;
        protocol: "openai-compatible";
    };
    observedAt: string;
    models: {
        id: string;
        allowed: boolean;
    }[];
    permissions: "unchanged";
    scope: "advisory-provider-list; not-execution-readiness";
}>;

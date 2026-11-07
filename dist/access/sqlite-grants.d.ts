import type { DatabaseSync } from 'node:sqlite';
import { type GrantActionTarget } from './actions.ts';
import type { GrantPolicyObserver } from './policy-observation.ts';
import { type GrantScope, type GrantPageRequest, type GrantPage } from './grants.ts';
export declare function initializeGrantTables(db: DatabaseSync): void;
export declare class SQLiteGrantStore {
    private readonly db;
    private readonly maxGrants;
    private readonly policyObserver?;
    constructor(db: DatabaseSync, maxGrants?: number, policyObserver?: GrantPolicyObserver | undefined);
    private decode;
    private read;
    get(value: string): import("./grants.ts").GrantMetadata;
    page(value?: GrantPageRequest): GrantPage;
    private atomic;
    issue(value: unknown, checkScope: (scope: GrantScope, at: string) => void): import("./grants.ts").GrantMetadata;
    revoke(value: unknown): import("./grants.ts").GrantMetadata;
    lookup(token: unknown): import("./grants.ts").GrantPrincipal | null;
    /** Internal run-writer guard: shares its transaction, never starts a nested transaction or accepts request-owned targets. */
    authorizeInTransaction(token: unknown, action: unknown, target: GrantActionTarget): import("./actions.ts").GrantActionAdmission;
    validate(): void;
}

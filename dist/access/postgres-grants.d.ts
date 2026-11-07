import { PostgresJournal } from '../storage/postgres.ts';
import { type GrantActionTarget } from './actions.ts';
import type { GrantPolicyObserver } from './policy-observation.ts';
import { type JournalConditions } from '../storage/conditions.ts';
import { type GrantScope, type GrantPageRequest, type GrantPage } from './grants.ts';
export declare class PostgresGrantStore {
    private readonly journal;
    private readonly maxGrants;
    private readonly policyObserver?;
    constructor(journal: PostgresJournal, maxGrants?: number, policyObserver?: GrantPolicyObserver | undefined);
    private owned;
    private read;
    get(value: string): Promise<import("./grants.ts").GrantMetadata>;
    /** Internal historical run replay; the reader already holds the shared domain gate. Never authorizes an action. */
    metadataForReplay(value: string): Promise<import("./grants.ts").GrantMetadata>;
    page(value?: GrantPageRequest): Promise<GrantPage>;
    issue(value: unknown, checkScope: (scope: GrantScope, at: string) => Promise<void>): Promise<import("./grants.ts").GrantMetadata>;
    revoke(value: unknown): Promise<import("./grants.ts").GrantMetadata>;
    lookup(token: unknown): Promise<import("./grants.ts").GrantPrincipal | null>;
    /** Internal read/retry admission only. Caller already holds the domain gate; never authorizes a mutation. */
    callerForReadInDomain(token: unknown, permission: 'start' | 'read' | 'control' | 'cancel'): Promise<import("./grants.ts").GrantPrincipal>;
    /** Internal receipt/current-target admission. Caller holds the shared domain gate; this never authorizes a mutation. */
    reviewerForReadInDomain(token: unknown, action: string): Promise<import("./grants.ts").GrantPrincipal>;
    /** Internal planning only: the writer MUST submit these conditions with its exact batch. No permission survives unguarded dispatch. */
    planAction(token: unknown, action: unknown, readTarget: () => Promise<{
        target: GrantActionTarget;
        condition: JournalConditions['records'][number];
    }>): Promise<{
        admission: import("./actions.ts").GrantActionAdmission;
        conditions: {
            records: {
                collection: "runs" | "releases" | "access-grants";
                key: string;
                version: string;
                sha256: string;
            }[];
            notBefore: string;
            expiresAt: string;
        };
    }>;
    validate(): Promise<void>;
}

import { z } from 'zod';
import { PostgresJournal } from '../storage/postgres.ts';
import { type WorkflowCompilerLimits } from '../workflow/index.ts';
import { type TestCommand } from './schema.ts';
import { type GenerateTestsRequest } from './generation-schema.ts';
import { type TestErasureRequest, type TestErasureReceipt } from './erasure-write.ts';
/** Async saved-case review and atomic schema-generated drafts; never dispatches execution. */
export declare class PostgresTestStore {
    private readonly journal;
    private readonly limits;
    private readonly maxRecordBytes;
    private readonly projects;
    private readonly ledger;
    constructor(journal: PostgresJournal, limits?: WorkflowCompilerLimits, maxRecordBytes?: number);
    private validateRecord;
    private read;
    get(id: string, generation?: number): Promise<import("./schema.ts").TestCase>;
    history(id: string): Promise<{
        schemaVersion: 1;
        id: string;
        versions: {
            generation: number;
            operation: "create" | "edit" | "accept" | "archive";
            status: "draft" | "accepted";
            definition: {
                title: string;
                project: {
                    id: string;
                    generation: number;
                    revision: string;
                };
                input: z.core.util.JSONType;
                expectations: ({
                    kind: "status";
                    value: "cancelled" | "completed" | "failed" | "waiting";
                } | {
                    kind: "output-equals";
                    value: z.core.util.JSONType;
                } | {
                    kind: "failure-code";
                    value: "invalid-node-value" | "loop-limit" | "loop-timeout" | "approval-rejected" | "approval-expired" | "ai-budget";
                } | {
                    nodeId: string;
                    kind: "node-visited";
                    scope?: {
                        loop: string;
                        index: number;
                    } | undefined;
                } | {
                    value: z.core.util.JSONType;
                    nodeId: string;
                    kind: "node-output-equals";
                    scope?: {
                        loop: string;
                        index: number;
                    } | undefined;
                } | {
                    value: string;
                    nodeId: string;
                    kind: "node-port-equals";
                    scope?: {
                        loop: string;
                        index: number;
                    } | undefined;
                })[];
                triggerMode?: "api" | undefined;
            };
            sha256: string;
            actor: string;
            at: string;
            archived?: boolean | undefined;
        }[];
        importedFrom?: {
            bundleSha256: string;
            source: {
                id: string;
                generation: number;
                sha256: string;
            };
            project: {
                id: string;
                generation: number;
                revision: string;
            };
            status: "draft" | "accepted";
        } | undefined;
    }>;
    list(after?: string, limit?: number): Promise<{
        tests: {
            status: "draft" | "accepted";
            sha256: string;
            actor: string;
            at: string;
            archived?: boolean;
            id: string;
            generation: number;
            title: string;
            project: {
                id: string;
                generation: number;
                revision: string;
            };
        }[];
        nextCursor: string | null;
    }>;
    private mutate;
    private caseWrite;
    /** Internal verified metadata read. Caller holds the domain gate; never acquire it again here. */
    erasureRecord(requestId: string): Promise<TestErasureReceipt>;
    erasure(requestId: string): Promise<{
        schemaVersion: 1;
        policy: "archived-draft-v1";
        requestId: string;
        test: {
            id: string;
            generation: number;
            sha256: string;
        };
        historySha256: string;
        project: {
            id: string;
            generation: number;
            revision: string;
        };
        actor: string;
        at: string;
        status: "logically-removed";
        securePhysicalErasure: false;
    }>;
    /** Startup validates every receipt and subject; missing counterparts fail closed, never repaired. */
    validateErasures(): Promise<void>;
    private erasureReferences;
    erase(value: TestErasureRequest): Promise<{
        schemaVersion: 1;
        policy: "archived-draft-v1";
        requestId: string;
        test: {
            id: string;
            generation: number;
            sha256: string;
        };
        historySha256: string;
        project: {
            id: string;
            generation: number;
            revision: string;
        };
        actor: string;
        at: string;
        status: "logically-removed";
        securePhysicalErasure: false;
    }>;
    execute(value: TestCommand): Promise<import("./schema.ts").TestCase>;
    generation(id: string): Promise<import("./generation-schema.ts").TestGeneration>;
    generations(after?: string, limit?: number): Promise<{
        generations: import("./generation-schema.ts").TestGeneration[];
        nextCursor: string | null;
    }>;
    /** Batch UUID retries observe the retained draft set; no generation command accepts or runs tests. */
    generate(value: GenerateTestsRequest): Promise<import("./generation-schema.ts").TestGeneration>;
}

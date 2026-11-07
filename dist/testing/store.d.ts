import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { type WorkflowCompilerLimits } from '../workflow/index.ts';
import { type TestDefinition, type TestCommand, type TestCase, type TransferredTests } from './schema.ts';
import { type GenerateTestsRequest, type TestGeneration } from './generation-schema.ts';
import { type TestErasureRequest, type TestErasureReceipt } from './erasure-write.ts';
/** Append-only case versions. Acceptance never executes; past accepted definitions remain available to runs. */
export declare class TestStore {
    private readonly db;
    private readonly limits;
    private readonly maxBytes;
    private readonly projects;
    private readonly ledger;
    constructor(db: DatabaseSync, limits: WorkflowCompilerLimits, maxBytes: number);
    private validate;
    private read;
    get(id: string, generation?: number): TestCase;
    list(): {
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
    history(id: string): {
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
    };
    erasure(requestId: string): TestErasureReceipt;
    /** Retained metadata remains a project reference even though unused draft payloads are removed. */
    erasures(): {
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
    }[];
    private erasureReferences;
    /** Atomic single-owner logical removal. Only unused archived manual drafts can lose their definitions. */
    erase(value: TestErasureRequest): TestErasureReceipt;
    /** Called inside the project-import transaction; savepoint never commits the surrounding project. */
    importDrafts(tests: TransferredTests, project: TestDefinition['project'], bundleSha256: string, actor: string): TestCase[];
    execute(value: TestCommand): TestCase;
    private apply;
    generation(id: string): TestGeneration;
    generations(): TestGeneration[];
    /** The batch and all new drafts commit together; a caller-retained UUID is its retry identity. */
    generate(value: GenerateTestsRequest): TestGeneration;
}

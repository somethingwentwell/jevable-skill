import type { z } from 'zod';
import type { Project } from '../projects/ledger.ts';
import { type WorkflowCompilerLimits } from '../workflow/index.ts';
import { testRecordSchema, type TestDefinition, type TestCommand, type TestCase, type ImportedTest } from './schema.ts';
import { type TestGeneration, type TestGenerationSnapshot } from './generation-schema.ts';
import { type generateInputs } from './generate.ts';
export type TestRecord = z.infer<typeof testRecordSchema>;
/** Backend-independent test review and historical evidence rules. Never executes a workflow. */
export declare class TestLedger {
    private readonly limits;
    private readonly maxBytes;
    constructor(limits: WorkflowCompilerLimits, maxBytes: number);
    validate(definition: TestDefinition, project: Project, current: boolean, allowArchived?: boolean): void;
    decode(value: unknown, id: string, generation: number): TestRecord;
    validateImport(record: TestRecord, project: Project): void;
    select(record: TestRecord, generation?: number): TestCase;
    prepare(command: TestCommand, previous?: TestRecord, importedFrom?: ImportedTest): {
        record: {
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
        test: TestCase;
    };
    decodeGeneration(value: {
        snapshot: unknown;
        sha256: unknown;
    }, id: string): TestGeneration;
    validateGenerationProject(snapshot: TestGenerationSnapshot, project: Project): void;
    validateGeneratedCase(snapshot: TestGenerationSnapshot, item: TestGenerationSnapshot['cases'][number], original: TestCase): void;
    prepareGeneration(id: string, actor: string, request: TestGenerationSnapshot['request'], generated: ReturnType<typeof generateInputs>, cases: TestGenerationSnapshot['cases']): TestGeneration;
}

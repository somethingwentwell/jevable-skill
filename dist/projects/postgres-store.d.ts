import { z } from 'zod';
import { PostgresJournal } from '../storage/postgres.ts';
import type { WorkflowLimits, WorkflowCompilerLimits } from '../workflow/index.ts';
import { deleteCommandSchema, type ProjectCommand } from './ledger.ts';
import { type VendorImportCommand } from './vendor-import.ts';
/** Async review persistence, sharing the SQLite ledger's exact revision and approval rules. */
export declare class PostgresProjectStore {
    private readonly journal;
    private readonly maxRecordBytes;
    private readonly ledger;
    private readonly tests;
    private readonly limits;
    constructor(journal: PostgresJournal, limits: WorkflowLimits, maxRecordBytes?: number, testLimits?: Omit<WorkflowCompilerLimits, 'source'>);
    private decode;
    private read;
    private mutate;
    private createSlot;
    private save;
    get(id: string, generation?: number): Promise<import("./ledger.ts").Project>;
    list(): Promise<{
        schemaVersion: 1;
        id: string;
        title: string;
        workflowId: string;
        generation: number;
        acceptedRevision: string;
        archived: boolean;
        createdAt: string;
        updatedAt: string;
    }[]>;
    /** Internal metadata read; a coherent cross-domain report holds the shared domain gate. */
    activity(): Promise<import("../runtime/activity.ts").ActivityProject[]>;
    diff(id: string, from: string, to: string): Promise<{
        approvalChanges: string[];
        from: import("../workflow/types.ts").RevisionHash;
        to: import("../workflow/types.ts").RevisionHash;
        addedNodes: readonly import("../workflow/types.ts").NodeId[];
        removedNodes: readonly import("../workflow/types.ts").NodeId[];
        changedNodes: readonly import("../workflow/types.ts").NodeId[];
        edgesChanged: boolean;
        inputSchemaChanged: boolean;
        metadataChanged: boolean;
        presentationChanged: boolean;
        extensionsChanged: boolean;
    }>;
    private readDeletion;
    deletion(id: string): Promise<{
        schemaVersion: 1;
        id: string;
        generation: number;
        revision: string;
        actor: string;
        at: string;
        status: "deleted";
    }>;
    deletions(after?: string, limit?: number): Promise<{
        deletions: {
            schemaVersion: 1;
            id: string;
            generation: number;
            revision: string;
            actor: string;
            at: string;
            status: "deleted";
        }[];
        nextCursor: string | null;
    }>;
    /** No cascade. Guard every retained reference and atomically retain a receipt alongside the project tombstone. */
    deleteArchived(value: z.infer<typeof deleteCommandSchema>): Promise<{
        schemaVersion: 1;
        id: string;
        generation: number;
        revision: string;
        actor: string;
        at: string;
        status: "deleted";
    }>;
    export(id: string, expectedGeneration: number, reviewedRevision: string, history?: boolean, includeTests?: boolean): Promise<{
        version: 1;
        format: "jevable.ai/project-bundle";
        exportedAt: string;
        source: {
            id: string;
            generation: number;
        };
        title: string;
        accepted: {
            revision: string;
            yaml: string;
        };
        history?: {
            schemaVersion: 1;
            id: string;
            revisions: {
                revision: string;
                yaml: string;
            }[];
            changes: ({
                operation: "create";
                title: string;
                revision: string;
                actor: string;
                at: string;
                copiedFrom?: {
                    id: string;
                    generation: number;
                    revision: string;
                } | undefined;
            } | {
                operation: "propose";
                proposalId: string;
                base: string;
                revision: string;
                actor: string;
                at: string;
            } | {
                operation: "accept";
                proposalId: string;
                revision: string;
                approvalChanges: string[];
                actor: string;
                at: string;
            } | {
                operation: "reject";
                proposalId: string;
                revision: string;
                actor: string;
                at: string;
            } | {
                operation: "restore";
                revision: string;
                approvalChanges: string[];
                actor: string;
                at: string;
            } | {
                operation: "rename";
                title: string;
                actor: string;
                at: string;
            } | {
                operation: "archive";
                archived: boolean;
                actor: string;
                at: string;
            } | {
                operation: "import";
                bundleSha256: string;
                sourceProjectId: string;
                sourceGeneration: number;
                historyIncluded: boolean;
                actor: string;
                at: string;
            })[];
            vendorImport?: {
                schemaVersion: 1;
                projectId: string;
                title: string;
                actor: string;
                at: string;
                source: string;
                conversion: {
                    conversionSha256: string;
                    schemaVersion: 1;
                    converter: {
                        name: "jevable-owned";
                        version: string;
                    };
                    format: "n8n" | "dify" | "coze" | "zapier" | "make" | "power-automate";
                    version: string;
                    title: string;
                    sourceSha256: string;
                    conversionRevision: string;
                    yaml: string;
                    mappings: {
                        source: string;
                        sourceType: string;
                        kind: "exact" | "approximate" | "unsupported";
                        reason: "loop" | "mapped" | "trigger-mode" | "model-route" | "expression" | "operator" | "code" | "node-type" | "unreachable" | "language";
                        target?: string | undefined;
                    }[];
                };
                revision: string;
                requestSha256: string;
            } | undefined;
        } | undefined;
    } | {
        version: 2;
        tests: {
            scope: "accepted-revision-latest-definitions";
            excludedOtherRevisions: number;
            cases: {
                source: {
                    id: string;
                    generation: number;
                    sha256: string;
                };
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
            }[];
            excludedArchived?: number | undefined;
        };
        format: "jevable.ai/project-bundle";
        exportedAt: string;
        source: {
            id: string;
            generation: number;
        };
        title: string;
        accepted: {
            revision: string;
            yaml: string;
        };
        history?: {
            schemaVersion: 1;
            id: string;
            revisions: {
                revision: string;
                yaml: string;
            }[];
            changes: ({
                operation: "create";
                title: string;
                revision: string;
                actor: string;
                at: string;
                copiedFrom?: {
                    id: string;
                    generation: number;
                    revision: string;
                } | undefined;
            } | {
                operation: "propose";
                proposalId: string;
                base: string;
                revision: string;
                actor: string;
                at: string;
            } | {
                operation: "accept";
                proposalId: string;
                revision: string;
                approvalChanges: string[];
                actor: string;
                at: string;
            } | {
                operation: "reject";
                proposalId: string;
                revision: string;
                actor: string;
                at: string;
            } | {
                operation: "restore";
                revision: string;
                approvalChanges: string[];
                actor: string;
                at: string;
            } | {
                operation: "rename";
                title: string;
                actor: string;
                at: string;
            } | {
                operation: "archive";
                archived: boolean;
                actor: string;
                at: string;
            } | {
                operation: "import";
                bundleSha256: string;
                sourceProjectId: string;
                sourceGeneration: number;
                historyIncluded: boolean;
                actor: string;
                at: string;
            })[];
            vendorImport?: {
                schemaVersion: 1;
                projectId: string;
                title: string;
                actor: string;
                at: string;
                source: string;
                conversion: {
                    conversionSha256: string;
                    schemaVersion: 1;
                    converter: {
                        name: "jevable-owned";
                        version: string;
                    };
                    format: "n8n" | "dify" | "coze" | "zapier" | "make" | "power-automate";
                    version: string;
                    title: string;
                    sourceSha256: string;
                    conversionRevision: string;
                    yaml: string;
                    mappings: {
                        source: string;
                        sourceType: string;
                        kind: "exact" | "approximate" | "unsupported";
                        reason: "loop" | "mapped" | "trigger-mode" | "model-route" | "expression" | "operator" | "code" | "node-type" | "unreachable" | "language";
                        target?: string | undefined;
                    }[];
                };
                revision: string;
                requestSha256: string;
            } | undefined;
        } | undefined;
    }>;
    inspectImport(json: string): {
        bundle: {
            version: 1;
            format: "jevable.ai/project-bundle";
            exportedAt: string;
            source: {
                id: string;
                generation: number;
            };
            title: string;
            accepted: {
                revision: string;
                yaml: string;
            };
            history?: {
                schemaVersion: 1;
                id: string;
                revisions: {
                    revision: string;
                    yaml: string;
                }[];
                changes: ({
                    operation: "create";
                    title: string;
                    revision: string;
                    actor: string;
                    at: string;
                    copiedFrom?: {
                        id: string;
                        generation: number;
                        revision: string;
                    } | undefined;
                } | {
                    operation: "propose";
                    proposalId: string;
                    base: string;
                    revision: string;
                    actor: string;
                    at: string;
                } | {
                    operation: "accept";
                    proposalId: string;
                    revision: string;
                    approvalChanges: string[];
                    actor: string;
                    at: string;
                } | {
                    operation: "reject";
                    proposalId: string;
                    revision: string;
                    actor: string;
                    at: string;
                } | {
                    operation: "restore";
                    revision: string;
                    approvalChanges: string[];
                    actor: string;
                    at: string;
                } | {
                    operation: "rename";
                    title: string;
                    actor: string;
                    at: string;
                } | {
                    operation: "archive";
                    archived: boolean;
                    actor: string;
                    at: string;
                } | {
                    operation: "import";
                    bundleSha256: string;
                    sourceProjectId: string;
                    sourceGeneration: number;
                    historyIncluded: boolean;
                    actor: string;
                    at: string;
                })[];
                vendorImport?: {
                    schemaVersion: 1;
                    projectId: string;
                    title: string;
                    actor: string;
                    at: string;
                    source: string;
                    conversion: {
                        conversionSha256: string;
                        schemaVersion: 1;
                        converter: {
                            name: "jevable-owned";
                            version: string;
                        };
                        format: "n8n" | "dify" | "coze" | "zapier" | "make" | "power-automate";
                        version: string;
                        title: string;
                        sourceSha256: string;
                        conversionRevision: string;
                        yaml: string;
                        mappings: {
                            source: string;
                            sourceType: string;
                            kind: "exact" | "approximate" | "unsupported";
                            reason: "loop" | "mapped" | "trigger-mode" | "model-route" | "expression" | "operator" | "code" | "node-type" | "unreachable" | "language";
                            target?: string | undefined;
                        }[];
                    };
                    revision: string;
                    requestSha256: string;
                } | undefined;
            } | undefined;
        } | {
            version: 2;
            tests: {
                scope: "accepted-revision-latest-definitions";
                excludedOtherRevisions: number;
                cases: {
                    source: {
                        id: string;
                        generation: number;
                        sha256: string;
                    };
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
                }[];
                excludedArchived?: number | undefined;
            };
            format: "jevable.ai/project-bundle";
            exportedAt: string;
            source: {
                id: string;
                generation: number;
            };
            title: string;
            accepted: {
                revision: string;
                yaml: string;
            };
            history?: {
                schemaVersion: 1;
                id: string;
                revisions: {
                    revision: string;
                    yaml: string;
                }[];
                changes: ({
                    operation: "create";
                    title: string;
                    revision: string;
                    actor: string;
                    at: string;
                    copiedFrom?: {
                        id: string;
                        generation: number;
                        revision: string;
                    } | undefined;
                } | {
                    operation: "propose";
                    proposalId: string;
                    base: string;
                    revision: string;
                    actor: string;
                    at: string;
                } | {
                    operation: "accept";
                    proposalId: string;
                    revision: string;
                    approvalChanges: string[];
                    actor: string;
                    at: string;
                } | {
                    operation: "reject";
                    proposalId: string;
                    revision: string;
                    actor: string;
                    at: string;
                } | {
                    operation: "restore";
                    revision: string;
                    approvalChanges: string[];
                    actor: string;
                    at: string;
                } | {
                    operation: "rename";
                    title: string;
                    actor: string;
                    at: string;
                } | {
                    operation: "archive";
                    archived: boolean;
                    actor: string;
                    at: string;
                } | {
                    operation: "import";
                    bundleSha256: string;
                    sourceProjectId: string;
                    sourceGeneration: number;
                    historyIncluded: boolean;
                    actor: string;
                    at: string;
                })[];
                vendorImport?: {
                    schemaVersion: 1;
                    projectId: string;
                    title: string;
                    actor: string;
                    at: string;
                    source: string;
                    conversion: {
                        conversionSha256: string;
                        schemaVersion: 1;
                        converter: {
                            name: "jevable-owned";
                            version: string;
                        };
                        format: "n8n" | "dify" | "coze" | "zapier" | "make" | "power-automate";
                        version: string;
                        title: string;
                        sourceSha256: string;
                        conversionRevision: string;
                        yaml: string;
                        mappings: {
                            source: string;
                            sourceType: string;
                            kind: "exact" | "approximate" | "unsupported";
                            reason: "loop" | "mapped" | "trigger-mode" | "model-route" | "expression" | "operator" | "code" | "node-type" | "unreachable" | "language";
                            target?: string | undefined;
                        }[];
                    };
                    revision: string;
                    requestSha256: string;
                } | undefined;
            } | undefined;
        };
        sha256: string;
    };
    vendorImport(id: string, inspect?: boolean): Promise<{
        privatePayloads: "excluded";
        schemaVersion: 1;
        projectId: string;
        revision: string;
        at: string;
        converter: {
            name: "jevable-owned";
            version: string;
        };
        format: "n8n" | "dify" | "coze" | "zapier" | "make" | "power-automate";
        version: string;
        sourceSha256: string;
        conversionSha256: string;
        conversionRevision: string;
        requestSha256: string;
        sha256: string;
        mappingCounts: {
            exact: number;
            approximate: number;
            unsupported: number;
        };
        transfer: "excluded-from-project-bundles";
        execution: "not-run";
    } | {
        privatePayloads: "included";
        record: {
            schemaVersion: 1;
            projectId: string;
            title: string;
            actor: string;
            at: string;
            source: string;
            conversion: {
                conversionSha256: string;
                schemaVersion: 1;
                converter: {
                    name: "jevable-owned";
                    version: string;
                };
                format: "n8n" | "dify" | "coze" | "zapier" | "make" | "power-automate";
                version: string;
                title: string;
                sourceSha256: string;
                conversionRevision: string;
                yaml: string;
                mappings: {
                    source: string;
                    sourceType: string;
                    kind: "exact" | "approximate" | "unsupported";
                    reason: "loop" | "mapped" | "trigger-mode" | "model-route" | "expression" | "operator" | "code" | "node-type" | "unreachable" | "language";
                    target?: string | undefined;
                }[];
            };
            revision: string;
            requestSha256: string;
        };
        schemaVersion: 1;
        projectId: string;
        revision: string;
        at: string;
        converter: {
            name: "jevable-owned";
            version: string;
        };
        format: "n8n" | "dify" | "coze" | "zapier" | "make" | "power-automate";
        version: string;
        sourceSha256: string;
        conversionSha256: string;
        conversionRevision: string;
        requestSha256: string;
        sha256: string;
        mappingCounts: {
            exact: number;
            approximate: number;
            unsupported: number;
        };
        transfer: "excluded-from-project-bundles";
        execution: "not-run";
    } | null>;
    createVendorImport(value: VendorImportCommand): Promise<import("./ledger.ts").Project>;
    import(json: string, reviewedSha256: string, actor: string, newId?: string): Promise<import("./ledger.ts").Project>;
    execute(value: ProjectCommand): Promise<import("./ledger.ts").Project>;
}

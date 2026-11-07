import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { WorkflowLimits } from '../workflow/index.ts';
import type { TransferredTests } from '../testing/schema.ts';
import { type VendorImportCommand } from './vendor-import.ts';
import { deleteCommandSchema, type Project, type ProjectCommand, type ProjectDeletion } from './ledger.ts';
export { projectCommandSchema, approvalChanges } from './ledger.ts';
export type { Project, ProjectCommand, ProjectDeletion, ProjectBundle } from './ledger.ts';
/** SQLite persistence around the backend-independent project review ledger. */
export declare class ProjectStore {
    private readonly db;
    private readonly ledger;
    constructor(db: DatabaseSync, limits: WorkflowLimits, maxRecordBytes: number);
    private read;
    get(id: string, generation?: number): Project;
    diff(id: string, from: string, to: string): {
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
    };
    export(id: string, expectedGeneration: number, reviewedRevision: string, history?: boolean, tests?: TransferredTests): {
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
    vendorImport(id: string, inspect?: boolean): {
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
    } | null;
    createVendorImport(value: VendorImportCommand): Project;
    private createSlot;
    private save;
    import(json: string, reviewedSha256: string, actor: string, newId?: string, importTests?: (project: Project) => void): Project;
    list(): {
        schemaVersion: 1;
        id: string;
        title: string;
        workflowId: string;
        generation: number;
        acceptedRevision: string;
        archived: boolean;
        createdAt: string;
        updatedAt: string;
    }[];
    /** Private metadata projection for the runtime's optimistic coherent activity read. */
    activity(): import("../runtime/activity.ts").ActivityProject[];
    deletions(): ProjectDeletion[];
    /** No cascade: every linked run, including completed runs, retains its project evidence. */
    deleteArchived(value: z.infer<typeof deleteCommandSchema>): ProjectDeletion;
    execute(value: ProjectCommand): Project;
}

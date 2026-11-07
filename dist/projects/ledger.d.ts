import { z } from 'zod';
import { type WorkflowLimits, type WorkflowSnapshot } from '../workflow/index.ts';
import { type TransferredTests } from '../testing/schema.ts';
import { type VendorImportCommand } from './vendor-import.ts';
export declare const deleteCommandSchema: z.ZodObject<{
    id: z.ZodUUID;
    expectedGeneration: z.ZodNumber;
    actor: z.ZodString;
}, z.core.$strict>;
export declare const deletionSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    id: z.ZodUUID;
    generation: z.ZodNumber;
    revision: z.ZodString;
    actor: z.ZodString;
    at: z.ZodISODateTime;
    status: z.ZodLiteral<"deleted">;
}, z.core.$strict>;
export type ProjectDeletion = z.infer<typeof deletionSchema>;
declare const changeSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    operation: z.ZodLiteral<"create">;
    title: z.ZodString;
    revision: z.ZodString;
    copiedFrom: z.ZodOptional<z.ZodObject<{
        id: z.ZodUUID;
        generation: z.ZodNumber;
        revision: z.ZodString;
    }, z.core.$strict>>;
    actor: z.ZodString;
    at: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"propose">;
    proposalId: z.ZodUUID;
    base: z.ZodString;
    revision: z.ZodString;
    actor: z.ZodString;
    at: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"accept">;
    proposalId: z.ZodUUID;
    revision: z.ZodString;
    approvalChanges: z.ZodArray<z.ZodString>;
    actor: z.ZodString;
    at: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"reject">;
    proposalId: z.ZodUUID;
    revision: z.ZodString;
    actor: z.ZodString;
    at: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"restore">;
    revision: z.ZodString;
    approvalChanges: z.ZodArray<z.ZodString>;
    actor: z.ZodString;
    at: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"rename">;
    title: z.ZodString;
    actor: z.ZodString;
    at: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"archive">;
    archived: z.ZodBoolean;
    actor: z.ZodString;
    at: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"import">;
    bundleSha256: z.ZodString;
    sourceProjectId: z.ZodUUID;
    sourceGeneration: z.ZodNumber;
    historyIncluded: z.ZodBoolean;
    actor: z.ZodString;
    at: z.ZodISODateTime;
}, z.core.$strict>], "operation">;
declare const recordSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    id: z.ZodUUID;
    revisions: z.ZodArray<z.ZodObject<{
        revision: z.ZodString;
        yaml: z.ZodString;
    }, z.core.$strict>>;
    changes: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        operation: z.ZodLiteral<"create">;
        title: z.ZodString;
        revision: z.ZodString;
        copiedFrom: z.ZodOptional<z.ZodObject<{
            id: z.ZodUUID;
            generation: z.ZodNumber;
            revision: z.ZodString;
        }, z.core.$strict>>;
        actor: z.ZodString;
        at: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        operation: z.ZodLiteral<"propose">;
        proposalId: z.ZodUUID;
        base: z.ZodString;
        revision: z.ZodString;
        actor: z.ZodString;
        at: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        operation: z.ZodLiteral<"accept">;
        proposalId: z.ZodUUID;
        revision: z.ZodString;
        approvalChanges: z.ZodArray<z.ZodString>;
        actor: z.ZodString;
        at: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        operation: z.ZodLiteral<"reject">;
        proposalId: z.ZodUUID;
        revision: z.ZodString;
        actor: z.ZodString;
        at: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        operation: z.ZodLiteral<"restore">;
        revision: z.ZodString;
        approvalChanges: z.ZodArray<z.ZodString>;
        actor: z.ZodString;
        at: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        operation: z.ZodLiteral<"rename">;
        title: z.ZodString;
        actor: z.ZodString;
        at: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        operation: z.ZodLiteral<"archive">;
        archived: z.ZodBoolean;
        actor: z.ZodString;
        at: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        operation: z.ZodLiteral<"import">;
        bundleSha256: z.ZodString;
        sourceProjectId: z.ZodUUID;
        sourceGeneration: z.ZodNumber;
        historyIncluded: z.ZodBoolean;
        actor: z.ZodString;
        at: z.ZodISODateTime;
    }, z.core.$strict>], "operation">>;
    vendorImport: z.ZodOptional<z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        projectId: z.ZodUUID;
        title: z.ZodString;
        actor: z.ZodString;
        at: z.ZodISODateTime;
        source: z.ZodString;
        conversion: z.ZodObject<{
            conversionSha256: z.ZodString;
            schemaVersion: z.ZodLiteral<1>;
            converter: z.ZodObject<{
                name: z.ZodLiteral<"jevable-owned">;
                version: z.ZodString;
            }, z.core.$strict>;
            format: z.ZodEnum<{
                n8n: "n8n";
                dify: "dify";
                coze: "coze";
                zapier: "zapier";
                make: "make";
                "power-automate": "power-automate";
            }>;
            version: z.ZodString;
            title: z.ZodString;
            sourceSha256: z.ZodString;
            conversionRevision: z.ZodString;
            yaml: z.ZodString;
            mappings: z.ZodArray<z.ZodObject<{
                source: z.ZodString;
                sourceType: z.ZodString;
                target: z.ZodOptional<z.ZodString>;
                kind: z.ZodEnum<{
                    exact: "exact";
                    approximate: "approximate";
                    unsupported: "unsupported";
                }>;
                reason: z.ZodEnum<{
                    loop: "loop";
                    mapped: "mapped";
                    "trigger-mode": "trigger-mode";
                    "model-route": "model-route";
                    expression: "expression";
                    operator: "operator";
                    code: "code";
                    "node-type": "node-type";
                    unreachable: "unreachable";
                    language: "language";
                }>;
            }, z.core.$strict>>;
        }, z.core.$strict>;
        revision: z.ZodString;
        requestSha256: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
type RecordData = z.infer<typeof recordSchema>;
declare const bundleSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    version: z.ZodLiteral<1>;
    format: z.ZodLiteral<"jevable.ai/project-bundle">;
    exportedAt: z.ZodISODateTime;
    source: z.ZodObject<{
        id: z.ZodUUID;
        generation: z.ZodNumber;
    }, z.core.$strict>;
    title: z.ZodString;
    accepted: z.ZodObject<{
        revision: z.ZodString;
        yaml: z.ZodString;
    }, z.core.$strict>;
    history: z.ZodOptional<z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        id: z.ZodUUID;
        revisions: z.ZodArray<z.ZodObject<{
            revision: z.ZodString;
            yaml: z.ZodString;
        }, z.core.$strict>>;
        changes: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            operation: z.ZodLiteral<"create">;
            title: z.ZodString;
            revision: z.ZodString;
            copiedFrom: z.ZodOptional<z.ZodObject<{
                id: z.ZodUUID;
                generation: z.ZodNumber;
                revision: z.ZodString;
            }, z.core.$strict>>;
            actor: z.ZodString;
            at: z.ZodISODateTime;
        }, z.core.$strict>, z.ZodObject<{
            operation: z.ZodLiteral<"propose">;
            proposalId: z.ZodUUID;
            base: z.ZodString;
            revision: z.ZodString;
            actor: z.ZodString;
            at: z.ZodISODateTime;
        }, z.core.$strict>, z.ZodObject<{
            operation: z.ZodLiteral<"accept">;
            proposalId: z.ZodUUID;
            revision: z.ZodString;
            approvalChanges: z.ZodArray<z.ZodString>;
            actor: z.ZodString;
            at: z.ZodISODateTime;
        }, z.core.$strict>, z.ZodObject<{
            operation: z.ZodLiteral<"reject">;
            proposalId: z.ZodUUID;
            revision: z.ZodString;
            actor: z.ZodString;
            at: z.ZodISODateTime;
        }, z.core.$strict>, z.ZodObject<{
            operation: z.ZodLiteral<"restore">;
            revision: z.ZodString;
            approvalChanges: z.ZodArray<z.ZodString>;
            actor: z.ZodString;
            at: z.ZodISODateTime;
        }, z.core.$strict>, z.ZodObject<{
            operation: z.ZodLiteral<"rename">;
            title: z.ZodString;
            actor: z.ZodString;
            at: z.ZodISODateTime;
        }, z.core.$strict>, z.ZodObject<{
            operation: z.ZodLiteral<"archive">;
            archived: z.ZodBoolean;
            actor: z.ZodString;
            at: z.ZodISODateTime;
        }, z.core.$strict>, z.ZodObject<{
            operation: z.ZodLiteral<"import">;
            bundleSha256: z.ZodString;
            sourceProjectId: z.ZodUUID;
            sourceGeneration: z.ZodNumber;
            historyIncluded: z.ZodBoolean;
            actor: z.ZodString;
            at: z.ZodISODateTime;
        }, z.core.$strict>], "operation">>;
        vendorImport: z.ZodOptional<z.ZodObject<{
            schemaVersion: z.ZodLiteral<1>;
            projectId: z.ZodUUID;
            title: z.ZodString;
            actor: z.ZodString;
            at: z.ZodISODateTime;
            source: z.ZodString;
            conversion: z.ZodObject<{
                conversionSha256: z.ZodString;
                schemaVersion: z.ZodLiteral<1>;
                converter: z.ZodObject<{
                    name: z.ZodLiteral<"jevable-owned">;
                    version: z.ZodString;
                }, z.core.$strict>;
                format: z.ZodEnum<{
                    n8n: "n8n";
                    dify: "dify";
                    coze: "coze";
                    zapier: "zapier";
                    make: "make";
                    "power-automate": "power-automate";
                }>;
                version: z.ZodString;
                title: z.ZodString;
                sourceSha256: z.ZodString;
                conversionRevision: z.ZodString;
                yaml: z.ZodString;
                mappings: z.ZodArray<z.ZodObject<{
                    source: z.ZodString;
                    sourceType: z.ZodString;
                    target: z.ZodOptional<z.ZodString>;
                    kind: z.ZodEnum<{
                        exact: "exact";
                        approximate: "approximate";
                        unsupported: "unsupported";
                    }>;
                    reason: z.ZodEnum<{
                        loop: "loop";
                        mapped: "mapped";
                        "trigger-mode": "trigger-mode";
                        "model-route": "model-route";
                        expression: "expression";
                        operator: "operator";
                        code: "code";
                        "node-type": "node-type";
                        unreachable: "unreachable";
                        language: "language";
                    }>;
                }, z.core.$strict>>;
            }, z.core.$strict>;
            revision: z.ZodString;
            requestSha256: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    version: z.ZodLiteral<2>;
    tests: z.ZodObject<{
        scope: z.ZodLiteral<"accepted-revision-latest-definitions">;
        excludedOtherRevisions: z.ZodNumber;
        excludedArchived: z.ZodOptional<z.ZodNumber>;
        cases: z.ZodArray<z.ZodObject<{
            source: z.ZodObject<{
                id: z.ZodUUID;
                generation: z.ZodNumber;
                sha256: z.ZodString;
            }, z.core.$strict>;
            status: z.ZodEnum<{
                draft: "draft";
                accepted: "accepted";
            }>;
            definition: z.ZodObject<{
                title: z.ZodString;
                project: z.ZodObject<{
                    id: z.ZodUUID;
                    generation: z.ZodNumber;
                    revision: z.ZodString;
                }, z.core.$strict>;
                input: z.ZodJSONSchema;
                expectations: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                    kind: z.ZodLiteral<"status">;
                    value: z.ZodEnum<{
                        cancelled: "cancelled";
                        completed: "completed";
                        failed: "failed";
                        waiting: "waiting";
                    }>;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"output-equals">;
                    value: z.ZodJSONSchema;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"failure-code">;
                    value: z.ZodEnum<{
                        "invalid-node-value": "invalid-node-value";
                        "loop-limit": "loop-limit";
                        "loop-timeout": "loop-timeout";
                        "approval-rejected": "approval-rejected";
                        "approval-expired": "approval-expired";
                        "ai-budget": "ai-budget";
                    }>;
                }, z.core.$strict>, z.ZodObject<{
                    nodeId: z.ZodString;
                    scope: z.ZodOptional<z.ZodObject<{
                        loop: z.ZodString;
                        index: z.ZodNumber;
                    }, z.core.$strict>>;
                    kind: z.ZodLiteral<"node-visited">;
                }, z.core.$strict>, z.ZodObject<{
                    value: z.ZodJSONSchema;
                    nodeId: z.ZodString;
                    scope: z.ZodOptional<z.ZodObject<{
                        loop: z.ZodString;
                        index: z.ZodNumber;
                    }, z.core.$strict>>;
                    kind: z.ZodLiteral<"node-output-equals">;
                }, z.core.$strict>, z.ZodObject<{
                    value: z.ZodString;
                    nodeId: z.ZodString;
                    scope: z.ZodOptional<z.ZodObject<{
                        loop: z.ZodString;
                        index: z.ZodNumber;
                    }, z.core.$strict>>;
                    kind: z.ZodLiteral<"node-port-equals">;
                }, z.core.$strict>], "kind">>;
                triggerMode: z.ZodOptional<z.ZodLiteral<"api">>;
            }, z.core.$strict>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    format: z.ZodLiteral<"jevable.ai/project-bundle">;
    exportedAt: z.ZodISODateTime;
    source: z.ZodObject<{
        id: z.ZodUUID;
        generation: z.ZodNumber;
    }, z.core.$strict>;
    title: z.ZodString;
    accepted: z.ZodObject<{
        revision: z.ZodString;
        yaml: z.ZodString;
    }, z.core.$strict>;
    history: z.ZodOptional<z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        id: z.ZodUUID;
        revisions: z.ZodArray<z.ZodObject<{
            revision: z.ZodString;
            yaml: z.ZodString;
        }, z.core.$strict>>;
        changes: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            operation: z.ZodLiteral<"create">;
            title: z.ZodString;
            revision: z.ZodString;
            copiedFrom: z.ZodOptional<z.ZodObject<{
                id: z.ZodUUID;
                generation: z.ZodNumber;
                revision: z.ZodString;
            }, z.core.$strict>>;
            actor: z.ZodString;
            at: z.ZodISODateTime;
        }, z.core.$strict>, z.ZodObject<{
            operation: z.ZodLiteral<"propose">;
            proposalId: z.ZodUUID;
            base: z.ZodString;
            revision: z.ZodString;
            actor: z.ZodString;
            at: z.ZodISODateTime;
        }, z.core.$strict>, z.ZodObject<{
            operation: z.ZodLiteral<"accept">;
            proposalId: z.ZodUUID;
            revision: z.ZodString;
            approvalChanges: z.ZodArray<z.ZodString>;
            actor: z.ZodString;
            at: z.ZodISODateTime;
        }, z.core.$strict>, z.ZodObject<{
            operation: z.ZodLiteral<"reject">;
            proposalId: z.ZodUUID;
            revision: z.ZodString;
            actor: z.ZodString;
            at: z.ZodISODateTime;
        }, z.core.$strict>, z.ZodObject<{
            operation: z.ZodLiteral<"restore">;
            revision: z.ZodString;
            approvalChanges: z.ZodArray<z.ZodString>;
            actor: z.ZodString;
            at: z.ZodISODateTime;
        }, z.core.$strict>, z.ZodObject<{
            operation: z.ZodLiteral<"rename">;
            title: z.ZodString;
            actor: z.ZodString;
            at: z.ZodISODateTime;
        }, z.core.$strict>, z.ZodObject<{
            operation: z.ZodLiteral<"archive">;
            archived: z.ZodBoolean;
            actor: z.ZodString;
            at: z.ZodISODateTime;
        }, z.core.$strict>, z.ZodObject<{
            operation: z.ZodLiteral<"import">;
            bundleSha256: z.ZodString;
            sourceProjectId: z.ZodUUID;
            sourceGeneration: z.ZodNumber;
            historyIncluded: z.ZodBoolean;
            actor: z.ZodString;
            at: z.ZodISODateTime;
        }, z.core.$strict>], "operation">>;
        vendorImport: z.ZodOptional<z.ZodObject<{
            schemaVersion: z.ZodLiteral<1>;
            projectId: z.ZodUUID;
            title: z.ZodString;
            actor: z.ZodString;
            at: z.ZodISODateTime;
            source: z.ZodString;
            conversion: z.ZodObject<{
                conversionSha256: z.ZodString;
                schemaVersion: z.ZodLiteral<1>;
                converter: z.ZodObject<{
                    name: z.ZodLiteral<"jevable-owned">;
                    version: z.ZodString;
                }, z.core.$strict>;
                format: z.ZodEnum<{
                    n8n: "n8n";
                    dify: "dify";
                    coze: "coze";
                    zapier: "zapier";
                    make: "make";
                    "power-automate": "power-automate";
                }>;
                version: z.ZodString;
                title: z.ZodString;
                sourceSha256: z.ZodString;
                conversionRevision: z.ZodString;
                yaml: z.ZodString;
                mappings: z.ZodArray<z.ZodObject<{
                    source: z.ZodString;
                    sourceType: z.ZodString;
                    target: z.ZodOptional<z.ZodString>;
                    kind: z.ZodEnum<{
                        exact: "exact";
                        approximate: "approximate";
                        unsupported: "unsupported";
                    }>;
                    reason: z.ZodEnum<{
                        loop: "loop";
                        mapped: "mapped";
                        "trigger-mode": "trigger-mode";
                        "model-route": "model-route";
                        expression: "expression";
                        operator: "operator";
                        code: "code";
                        "node-type": "node-type";
                        unreachable: "unreachable";
                        language: "language";
                    }>;
                }, z.core.$strict>>;
            }, z.core.$strict>;
            revision: z.ZodString;
            requestSha256: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
}, z.core.$strict>], "version">;
export type ProjectBundle = z.infer<typeof bundleSchema>;
export { bundleSchema as projectBundleSchema };
type Change = z.infer<typeof changeSchema>;
type Proposal = {
    id: string;
    base: string;
    revision: string;
    status: 'pending' | 'accepted' | 'rejected';
};
export type Project = {
    schemaVersion: 1;
    id: string;
    title: string;
    workflowId: string;
    generation: number;
    acceptedRevision: string;
    archived: boolean;
    createdAt: string;
    updatedAt: string;
    revisions: {
        revision: string;
        yaml: string;
    }[];
    proposals: Proposal[];
    changes: Change[];
};
export declare const projectCommandSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    operation: z.ZodLiteral<"create">;
    id: z.ZodOptional<z.ZodUUID>;
    title: z.ZodString;
    yaml: z.ZodString;
    actor: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"duplicate">;
    revision: z.ZodString;
    title: z.ZodString;
    newId: z.ZodOptional<z.ZodUUID>;
    id: z.ZodUUID;
    expectedGeneration: z.ZodNumber;
    actor: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"propose">;
    yaml: z.ZodString;
    proposalId: z.ZodOptional<z.ZodUUID>;
    id: z.ZodUUID;
    expectedGeneration: z.ZodNumber;
    actor: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"accept">;
    proposalId: z.ZodUUID;
    reviewedRevision: z.ZodString;
    approvalChanges: z.ZodArray<z.ZodString>;
    id: z.ZodUUID;
    expectedGeneration: z.ZodNumber;
    actor: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"reject">;
    proposalId: z.ZodUUID;
    reviewedRevision: z.ZodString;
    id: z.ZodUUID;
    expectedGeneration: z.ZodNumber;
    actor: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"restore">;
    revision: z.ZodString;
    approvalChanges: z.ZodArray<z.ZodString>;
    id: z.ZodUUID;
    expectedGeneration: z.ZodNumber;
    actor: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"rename">;
    title: z.ZodString;
    id: z.ZodUUID;
    expectedGeneration: z.ZodNumber;
    actor: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"archive">;
    archived: z.ZodBoolean;
    id: z.ZodUUID;
    expectedGeneration: z.ZodNumber;
    actor: z.ZodString;
}, z.core.$strict>], "operation">;
export type ProjectCommand = z.infer<typeof projectCommandSchema>;
/** Conservative review: any execution-spec change may bypass an unchanged approval node.
 * Presentation-only changes need no acknowledgement. This is not a reachability proof. */
export declare function approvalChanges(before: WorkflowSnapshot, after: WorkflowSnapshot): string[];
export type ProjectRecord = RecordData;
/** Shared revision/review semantics. No database, process, credential or harness dependency. */
export declare class ProjectLedger {
    private readonly limits;
    private readonly maxRecordBytes;
    constructor(limits: WorkflowLimits, maxRecordBytes: number);
    replay(record: RecordData, through?: number): Project;
    command(value: ProjectCommand): ProjectCommand;
    decode(encoded: string, id: string, generation?: number): RecordData;
    export(record: RecordData, expectedGeneration: number, reviewedRevision: string, history?: boolean, tests?: TransferredTests): ProjectBundle;
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
    prepareImport(json: string, reviewedSha256: string, importActor: string, newId?: string, allowTests?: boolean): {
        record: {
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
        };
        project: Project;
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
    };
    diff(record: RecordData, from: string, to: string): {
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
    /** Actor must come from the authenticated adapter. It is attribution, not proof of human consent. */
    createVendorImport(value: VendorImportCommand, previous?: RecordData): {
        record: {
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
        };
        project: Project;
        replayed: boolean;
    };
    vendorImport(record: RecordData, inspect?: boolean): {
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
    apply(value: ProjectCommand, previous?: RecordData): {
        record: {
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
        };
        project: Project;
    };
}

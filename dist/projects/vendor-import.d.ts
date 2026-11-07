import { z } from 'zod';
import { parseWorkflow, type WorkflowLimits } from '../workflow/index.ts';
export declare const vendorImportPreviewSchema: z.ZodObject<{
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
export declare const vendorImportCommandSchema: z.ZodObject<{
    id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    title: z.ZodString;
    actor: z.ZodString;
    source: z.ZodString;
    yaml: z.ZodString;
    reviewedSourceSha256: z.ZodString;
    reviewedConversionSha256: z.ZodString;
    reviewedRevision: z.ZodString;
}, z.core.$strict>;
export type VendorImportCommand = z.input<typeof vendorImportCommandSchema>;
export declare const vendorImportRecordSchema: z.ZodObject<{
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
}, z.core.$strict>;
export type VendorImportRecord = z.infer<typeof vendorImportRecordSchema>;
export declare function previewVendorImport(source: string, limits: WorkflowLimits): {
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
export declare function prepareVendorImport(value: VendorImportCommand, limits: WorkflowLimits): {
    command: {
        yaml: string;
        id: string;
        title: string;
        actor: string;
        source: string;
        reviewedSourceSha256: string;
        reviewedConversionSha256: string;
        reviewedRevision: string;
    };
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
    requestSha256: string;
};
/** Validate retained identity without re-running a potentially newer converter or trusting uploaded report fields.
 * readSource is an internal, operation-local parser adapter, never a file/wire witness.
 * The ledger may reuse immutable text it just admitted under these same limits;
 * ordinary callers still parse every source through the default admission path.
 */
export declare function verifyVendorImport(record: VendorImportRecord, projectId: string, first: {
    operation: string;
    title?: string;
    actor: string;
    at: string;
    revision?: string;
    copiedFrom?: unknown;
}, yaml: string, limits: WorkflowLimits, readSource?: typeof parseWorkflow): void;
export declare const vendorImportViewSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    privatePayloads: z.ZodLiteral<"excluded">;
    schemaVersion: z.ZodLiteral<1>;
    projectId: z.ZodUUID;
    revision: z.ZodString;
    at: z.ZodISODateTime;
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
    sourceSha256: z.ZodString;
    conversionSha256: z.ZodString;
    conversionRevision: z.ZodString;
    requestSha256: z.ZodString;
    sha256: z.ZodString;
    mappingCounts: z.ZodObject<{
        exact: z.ZodNumber;
        approximate: z.ZodNumber;
        unsupported: z.ZodNumber;
    }, z.core.$strict>;
    transfer: z.ZodLiteral<"excluded-from-project-bundles">;
    execution: z.ZodLiteral<"not-run">;
}, z.core.$strict>, z.ZodObject<{
    privatePayloads: z.ZodLiteral<"included">;
    record: z.ZodObject<{
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
    }, z.core.$strict>;
    schemaVersion: z.ZodLiteral<1>;
    projectId: z.ZodUUID;
    revision: z.ZodString;
    at: z.ZodISODateTime;
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
    sourceSha256: z.ZodString;
    conversionSha256: z.ZodString;
    conversionRevision: z.ZodString;
    requestSha256: z.ZodString;
    sha256: z.ZodString;
    mappingCounts: z.ZodObject<{
        exact: z.ZodNumber;
        approximate: z.ZodNumber;
        unsupported: z.ZodNumber;
    }, z.core.$strict>;
    transfer: z.ZodLiteral<"excluded-from-project-bundles">;
    execution: z.ZodLiteral<"not-run">;
}, z.core.$strict>], "privatePayloads">;
export declare function vendorImportView(record: VendorImportRecord, inspect: boolean): {
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
};

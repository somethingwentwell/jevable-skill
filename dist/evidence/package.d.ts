import { z } from 'zod';
export declare const EVIDENCE_PACKAGE_LIMITS: Readonly<{
    selectionBytes: 32000;
    runs: 100;
    entryBytes: 16000000;
    totalBytes: 64000000;
    archiveBytes: 32000000;
    readAttempts: 3;
}>;
declare const selectionSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    runs: z.ZodArray<z.ZodObject<{
        id: z.ZodUUID;
        revision: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type EvidenceSelection = z.infer<typeof selectionSchema>;
export { selectionSchema as evidenceSelectionSchema };
/** Supply checked core owner reads. No execution, discovery, list, mutation or filesystem methods are used. */
export interface EvidencePackageHost {
    exportRun(id: string, includePrivate: boolean): unknown | Promise<unknown>;
    testResult(id: string, inspect: boolean): unknown | Promise<unknown>;
}
/** Validate and detach the exact selection before the first asynchronous read. Never enumerate runs. */
export declare function inspectEvidenceSelection(value: unknown): {
    selection: {
        schemaVersion: 1;
        runs: {
            id: string;
            revision: string;
        }[];
    };
    sha256: string;
};
export declare const evidenceRunSchema: z.ZodObject<{
    id: z.ZodUUID;
    revision: z.ZodString;
    status: z.ZodEnum<{
        cancelled: "cancelled";
        completed: "completed";
        paused: "paused";
        failed: "failed";
        waiting: "waiting";
        executing: "executing";
    }>;
    updatedAt: z.ZodISODateTime;
    test: z.ZodOptional<z.ZodObject<{
        id: z.ZodUUID;
        generation: z.ZodNumber;
        sha256: z.ZodString;
    }, z.core.$strict>>;
    triggerMode: z.ZodOptional<z.ZodLiteral<"api">>;
}, z.core.$strip>;
type SnapshotRun = z.infer<typeof evidenceRunSchema>;
/** Internal archive consistency check; does not authenticate test provenance or replay a workflow. */
export declare function inspectPackagedAssessment(value: unknown, run: SnapshotRun, includePrivate: boolean): {
    checks: {
        index: number;
        kind: "status" | "output-equals" | "failure-code" | "node-visited" | "node-output-equals" | "node-port-equals";
        matched: boolean;
        available: boolean;
        nodeId?: string | undefined;
        scope?: {
            loop: string;
            index: number;
        } | undefined;
        expected?: z.core.util.JSONType | undefined;
        actual?: z.core.util.JSONType | undefined;
    }[];
    title?: string;
    schemaVersion: number;
    format: string;
    test: {
        id: string;
        generation: number;
        sha256: string;
    };
    runId: string;
    revision: string;
    assessment: "failed" | "pending" | "uncertain" | "passed";
    workflowStatus: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
    terminal: boolean;
    observedRunUpdatedAt: string;
    evidence: string;
    privateInspection: boolean;
};
/** Package selected retained observations. Nothing is written until the caller explicitly publishes the returned bytes. */
export declare function createEvidenceZip(host: EvidencePackageHost, value: EvidenceSelection, includePrivate?: boolean): Promise<{
    bytes: Buffer<ArrayBuffer>;
    manifest: {
        schemaVersion: number;
        format: string;
        selectionSha256: string;
        privacy: string;
        runs: {
            testPath?: string;
            test?: {
                id: string;
                generation: number;
                sha256: string;
            } | undefined;
            assessment?: "failed" | "pending" | "uncertain" | "passed";
            id: string;
            revision: string;
            workflowStatus: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
            observedRunUpdatedAt: string;
            evidencePath: string;
            snapshotSha256: string;
        }[];
        consistency: string;
        execution: string;
        restoration: string;
        files: {
            path: string;
            bytes: number;
            sha256: string;
        }[];
    };
    sha256: string;
}>;

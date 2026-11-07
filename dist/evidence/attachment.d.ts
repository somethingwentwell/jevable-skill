/** An attachment is review material, never imported runtime state or proof of release/project ownership. */
export declare const EVIDENCE_ATTACHMENT_LIMIT = 16000000;
export interface EvidenceAttachmentInput {
    bytes: Uint8Array;
    sha256: string;
    includePrivate?: boolean;
}
export declare function prepareEvidenceAttachment(input: EvidenceAttachmentInput, revision: string): Promise<{
    bytes: Buffer<ArrayBuffer>;
    descriptor: {
        format: "jevable.ai/evidence-attachment";
        path: "evidence.zip";
        sha256: string;
        bytes: number;
        selectionSha256: string;
        revision: string;
        declaredPrivacy: "metadata-only" | "private-execution-data";
        runs: number;
        relationship: "workflow-revision-only";
        authenticity: "not-verified";
        restoration: "unsupported";
    };
    inspection: {
        schemaVersion: number;
        status: string;
        format: "jevable.ai/evidence-zip";
        artifact: {
            sha256: string;
            bytes: number;
        };
        expectedChecksum: string;
        selectionSha256: string;
        declaredPrivacy: "metadata-only" | "private-execution-data";
        privatePayloads: string;
        runs: {
            test?: {
                id: string;
                generation: number;
                sha256: string;
            };
            assessment?: "failed" | "pending" | "uncertain" | "passed";
            terminal?: boolean;
            checks?: {
                total: number;
                matched: number;
                available: number;
            };
            evidenceVersion: 1 | 2;
            snapshotSha256: string;
            triggerMode?: import("../runtime/trigger.ts").ApiTriggerMode;
            id: string;
            revision: string;
            workflowStatus: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
            observedRunUpdatedAt: string;
        }[];
        files: number;
        consistency: "per-run-observations; not-an-atomic-snapshot";
        authenticity: string;
        runtimeHistoryReplay: string;
        privacyAttestation: string;
        execution: string;
        restoration: string;
    };
}>;
/** Reads may inspect a declared private archive but never display its payloads or grant export consent. */
export declare function inspectEvidenceAttachment(bytes: Uint8Array, revision: string, descriptor: unknown): Promise<{
    attachment: {
        format: "jevable.ai/evidence-attachment";
        path: "evidence.zip";
        sha256: string;
        bytes: number;
        selectionSha256: string;
        revision: string;
        declaredPrivacy: "metadata-only" | "private-execution-data";
        runs: number;
        relationship: "workflow-revision-only";
        authenticity: "not-verified";
        restoration: "unsupported";
    };
    inspection: {
        schemaVersion: number;
        status: string;
        format: "jevable.ai/evidence-zip";
        artifact: {
            sha256: string;
            bytes: number;
        };
        expectedChecksum: string;
        selectionSha256: string;
        declaredPrivacy: "metadata-only" | "private-execution-data";
        privatePayloads: string;
        runs: {
            test?: {
                id: string;
                generation: number;
                sha256: string;
            };
            assessment?: "failed" | "pending" | "uncertain" | "passed";
            terminal?: boolean;
            checks?: {
                total: number;
                matched: number;
                available: number;
            };
            evidenceVersion: 1 | 2;
            snapshotSha256: string;
            triggerMode?: import("../runtime/trigger.ts").ApiTriggerMode;
            id: string;
            revision: string;
            workflowStatus: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
            observedRunUpdatedAt: string;
        }[];
        files: number;
        consistency: "per-run-observations; not-an-atomic-snapshot";
        authenticity: string;
        runtimeHistoryReplay: string;
        privacyAttestation: string;
        execution: string;
        restoration: string;
    };
    importStatus: "not-restored";
}>;

import type { ProjectBundle } from '../projects/store.ts';
import { type EvidenceAttachmentInput } from '../evidence/attachment.ts';
export declare const PROJECT_PACKAGE_LIMITS: Readonly<{
    archiveBytes: 32000000;
    entryBytes: 16000000;
    totalBytes: 48000000;
    entries: 8;
}>;
export declare class ProjectPackageError extends Error {
    readonly code: 'invalid-package' | 'package-limit' | 'checksum-mismatch';
    constructor(code: 'invalid-package' | 'package-limit' | 'checksum-mismatch');
}
/** Generate from a reviewed core-owned bundle. No directory enumeration or runtime state access. */
export declare function createProjectZip(bundle: ProjectBundle): Buffer;
/** Pin and inspect a selected evidence archive before including it; no owner access, discovery or execution. */
export declare function createProjectZipWithEvidence(value: ProjectBundle, input: EvidenceAttachmentInput): Promise<{
    bytes: Buffer<ArrayBufferLike>;
    evidence: {
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
/** Read only bounded allowlisted entries into memory; never extract to disk or execute archived HTML. */
export declare function readProjectZip(bytes: Uint8Array): Promise<{
    evidence?: {
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
    };
    json: string;
    archiveSha256: string;
}>;

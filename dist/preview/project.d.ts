import type { EvidenceAttachmentInput } from '../evidence/attachment.ts';
import type { WorkflowLimits } from '../workflow/index.ts';
import type { PreviewOperations } from './session.ts';
import type { PreviewProjectPin } from './release.ts';
/** Export authoring content only from the explicitly admitted project. Never import, execute or restore. */
export declare function previewProjectZip(owner: PreviewOperations, pin: PreviewProjectPin, limits: WorkflowLimits, options: {
    history: boolean;
    tests: boolean;
}, evidence?: EvidenceAttachmentInput): Promise<{
    schemaVersion: number;
    format: string;
    project: {
        id: string;
        generation: number;
        revision: string;
    };
    options: {
        history: boolean;
        tests: boolean;
    };
    bundleSha256: string;
    tests: {
        included: boolean;
        count: number;
        excludedOtherRevisions: number;
        importStatus: string;
    };
    evidence: {
        sha256: string;
        selectionSha256: string;
        privacy: "metadata-only" | "private-execution-data";
    } | null;
    bytes: number;
    sha256: string;
    base64: string;
    runnableRelease: boolean;
    execution: string;
    executionStateRestoration: string;
}>;

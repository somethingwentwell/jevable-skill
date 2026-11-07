import type { PreviewEvidenceSelection } from './evidence-bundle-download.ts';
/** Inspect the already receipt-checked ZIP in bounded browser memory, without storing or executing its contents. */
export declare function inspectPreviewEvidenceArchive(bytes: Uint8Array, selection: PreviewEvidenceSelection, expectedSha256: string, expectedPrivacy: 'metadata-only' | 'private-execution-data'): Promise<{
    privacy: "metadata-only" | "private-execution-data";
    files: {
        path: string;
        content: string;
    }[];
    runs: {
        id: string;
        revision: string;
        workflowStatus: string;
        assessment?: string;
        evidencePath: string;
        testPath?: string;
        checkCount?: number;
    }[];
}>;

import type { PreviewProjectPin } from './release.ts';
export interface PreviewReleaseReceipt {
    schemaVersion: 1;
    format: 'jevable.ai/preview-release';
    id: string;
    releaseSha256: string;
    project: PreviewProjectPin;
    version: string;
    runtime: {
        version: string;
        sha256: string;
    };
    storage: 'sqlite' | 'postgres';
    execution: 'not-run';
    notes?: string;
}
export interface PreviewReleaseEvidence {
    sha256: string;
    selectionSha256: string;
    privacy: 'metadata-only' | 'private-execution-data';
}
export interface PreviewReleasePage {
    schemaVersion: 1;
    format: 'jevable.ai/preview-release-page';
    project: PreviewProjectPin;
    releases: PreviewReleaseListRow[];
    nextCursor: string | null;
    execution: 'not-run';
}
export type PreviewReleaseListRow = Omit<PreviewReleaseReceipt, 'storage' | 'notes'> & {
    storage: 'sqlite' | 'postgres' | null;
};
/** Serialized browser helpers. Receipt/hash checks are not publisher authentication or ZIP-entry inspection. */
export declare function previewReleaseTools(): {
    receipt: (value: unknown, pin: PreviewProjectPin, id: string) => PreviewReleaseReceipt;
    download: (expected: PreviewReleaseReceipt, value: unknown, evidence?: PreviewReleaseEvidence | null) => Promise<{
        bytes: Uint8Array<ArrayBuffer>;
        sha256: string;
        filename: string;
    }>;
    noteText: (value: unknown) => string;
    page: (value: unknown, pin: PreviewProjectPin) => PreviewReleasePage;
};

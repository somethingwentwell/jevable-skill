import { type Release } from '../releases/snapshot.ts';
import type { PreviewOperations } from './session.ts';
export interface PreviewProjectPin {
    id: string;
    generation: number;
    revision: string;
}
/** Only the exact admitted project generation may be packaged by this preview. */
export declare function scopedPreviewRelease(value: unknown, pin: PreviewProjectPin, id: string): Release;
export declare function previewReleaseReceipt(release: Release, storage: 'sqlite' | 'postgres'): {
    notes?: string;
    storage: "sqlite" | "postgres";
    execution: string;
    schemaVersion: number;
    format: string;
    id: string;
    releaseSha256: string;
    project: {
        revision: string;
        id: string;
        generation: number;
    };
    version: string;
    runtime: {
        version: string;
        sha256: string;
    };
};
export declare function createPreviewRelease(owner: PreviewOperations, pin: PreviewProjectPin, command: {
    id: string;
    version: string;
    storage: 'sqlite' | 'postgres';
    notes?: string | undefined;
}): Promise<{
    notes?: string;
    storage: "sqlite" | "postgres";
    execution: string;
    schemaVersion: number;
    format: string;
    id: string;
    releaseSha256: string;
    project: {
        revision: string;
        id: string;
        generation: number;
    };
    version: string;
    runtime: {
        version: string;
        sha256: string;
    };
}>;
export declare function readPreviewRelease(owner: PreviewOperations, pin: PreviewProjectPin, id: string): Promise<{
    release: Release;
    artifact: import("../packages/release-zip.ts").ReleaseRuntimeArtifact;
    receipt: {
        notes?: string;
        storage: "sqlite" | "postgres";
        execution: string;
        schemaVersion: number;
        format: string;
        id: string;
        releaseSha256: string;
        project: {
            revision: string;
            id: string;
            generation: number;
        };
        version: string;
        runtime: {
            version: string;
            sha256: string;
        };
    };
}>;
/** Scan one bounded owner metadata page; only matching snapshots reach the viewer. */
export declare function listPreviewReleasePage(owner: PreviewOperations, pin: PreviewProjectPin, after?: string, examined?: number): Promise<{
    releases: {
        storage: "sqlite" | "postgres" | null;
        execution: string;
        schemaVersion: number;
        format: string;
        id: string;
        releaseSha256: string;
        project: {
            revision: string;
            id: string;
            generation: number;
        };
        version: string;
        runtime: {
            version: string;
            sha256: string;
        };
    }[];
    after: string | null;
    examined: number;
}>;
export declare function previewReleaseZipEnvelope(receipt: ReturnType<typeof previewReleaseReceipt>, bytes: Buffer, evidence?: {
    sha256: string;
    selectionSha256: string;
    declaredPrivacy: string;
}): {
    schemaVersion: number;
    format: string;
    release: {
        notes?: string;
        storage: "sqlite" | "postgres";
        execution: string;
        schemaVersion: number;
        format: string;
        id: string;
        releaseSha256: string;
        project: {
            revision: string;
            id: string;
            generation: number;
        };
        version: string;
        runtime: {
            version: string;
            sha256: string;
        };
    };
    bytes: number;
    sha256: string;
    base64: string;
    evidence: {
        sha256: string;
        selectionSha256: string;
        privacy: string;
    } | null;
    execution: string;
    restoration: string;
};

export interface EvidenceDownload {
    filename: string;
    contents: string;
    bytes: number;
    sha256: string;
    snapshotSha256: string;
    runId: string;
    revision: string;
    workflowStatus: string;
    includePrivate: boolean;
}
/** Import-free, serializable admission of a runtime-produced JSON snapshot, shared by CLI and preview; not independent authenticity or secret scrubbing. */
export declare function prepareEvidenceDownload(expected: {
    runId: string;
    revision: string;
}, value: unknown, includePrivate?: boolean): Promise<EvidenceDownload>;

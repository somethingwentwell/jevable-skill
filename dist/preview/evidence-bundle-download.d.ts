export interface PreviewEvidenceSelection {
    schemaVersion: 1;
    runs: {
        id: string;
        revision: string;
    }[];
}
/** Browser-safe receipt/byte verification; the server builds/validates ZIP entries. This does not authenticate a publisher. */
export declare function prepareEvidenceBundleDownload(expected: PreviewEvidenceSelection, value: unknown, includePrivate?: boolean): Promise<{
    bytes: Uint8Array<ArrayBuffer>;
    sha256: string;
    selectionSha256: string;
    runs: number;
    summary: {
        id: string;
        workflowStatus: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
        assessment: "failed" | "pending" | "uncertain" | "passed" | undefined;
    }[];
    privacy: "metadata-only" | "private-execution-data";
    filename: string;
}>;

/** Offline consistency report only. No extraction, state access, payload display, authenticity claim or execution. */
export declare function inspectEvidenceZip(input: Uint8Array, expectedSha256?: string): Promise<{
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
}>;

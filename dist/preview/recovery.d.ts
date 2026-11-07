import type { WorkflowPreview } from './model.ts';
/** Serialized metadata-only admission hint. Only the runtime can prove a saved response exists and settle it. */
export declare function previewRecoveryTarget(preview: WorkflowPreview | undefined, run: any): {
    id: string;
    attemptId: string;
    checkpointSha256: string;
    identity: string;
    label: string;
} | null;

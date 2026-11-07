import type { WorkflowPreview } from './model.ts';
import type { ModelCallEvidence } from '../runtime/model-evidence.ts';
export interface PreviewModelHistory {
    format: 'jevable.preview-model-history/v1';
    runId: string;
    revision: string;
    workflowStatus: string;
    available: boolean;
    checksum: string;
    calls: ModelCallEvidence[];
}
/** Serialized, import-free metadata admission. Does not execute, infer dispatch, or authenticate the reported digest. */
export declare function projectPreviewModelHistory(preview: WorkflowPreview, runId: string, value: unknown): PreviewModelHistory;

import type { WorkflowPreview } from './model.ts';
export interface PreviewExecutionRecord {
    index: number;
    iteration?: number;
    port?: string;
    attemptId?: string;
    startedAt?: string;
    durationMs?: number;
    modelUsage?: {
        tries: number;
        inputTokens?: number;
        outputTokens?: number;
    };
    trace?: {
        traceId: string;
        spanId: string;
        traceFlags: number;
    };
}
export interface PreviewExecutionNode {
    id: string;
    status: 'unobserved' | 'settled' | 'next' | 'waiting' | 'unsettled' | 'failed' | 'stopped' | 'active-loop';
    count: number;
    iterations: number[];
    recordedDurationMs: number;
    timedRecords: number;
    records: PreviewExecutionRecord[];
    omittedRecords: number;
    currentIteration?: number;
    attemptId?: string;
    code?: string;
}
export interface PreviewExecution {
    format: 'jevable.preview-execution/v1';
    runId: string;
    revision: string;
    status: string;
    summary: string;
    ambiguousConnections: number;
    recordedSteps: number;
    graphs: {
        scope: string;
        nodes: PreviewExecutionNode[];
        edges: {
            index: number;
            status: 'unobserved' | 'observed' | 'ambiguous' | 'selected';
            count: number;
            selectedCount: number;
        }[];
        exits: {
            index: number;
            selectedCount: number;
        }[];
    }[];
}
/** Pure metadata projection, also serialized for the live page. No imports, execution, payloads or guessed ports. */
export declare function projectPreviewExecution(preview: WorkflowPreview, value: unknown): PreviewExecution;

import { type WorkflowCompilerLimits, type WorkflowNode } from '../workflow/index.ts';
import { validateSource } from '../validation.ts';
export interface PreviewNode {
    id: string;
    node: WorkflowNode;
    bodyScope?: string;
}
export interface PreviewGraph {
    scope: string;
    label: string;
    entry: string | null;
    nodes: PreviewNode[];
    edges: {
        from: string;
        to: string;
        port?: string | undefined;
    }[];
    exits: {
        from: string;
        port?: string | undefined;
        result: unknown;
    }[];
    diagnostics: string[];
}
export interface WorkflowPreview {
    format: 'jevable.preview/v1';
    sourceSha256: string;
    revision: string | null;
    name: string;
    workflowId: string;
    source: string;
    validation: ReturnType<typeof validateSource>;
    graphs: PreviewGraph[];
    execution: 'not-run';
    runtimeReadiness: 'not-checked';
    privacy: 'workflow-source-included; runtime-data-excluded';
}
/** Admit preview data independently of executable compilation. Never invent a revision for invalid structure. */
export declare function createPreview(source: string, limits?: WorkflowCompilerLimits): WorkflowPreview;

import type { WorkflowPreview } from './model.ts';
import type { PreviewExecution } from './execution.ts';
export interface PreviewBreakpointOverlay {
    revision: string;
    enabled: string[];
    draft?: string[];
    hit?: {
        nodeId: string;
        iteration?: number;
    };
}
export interface PreviewViewerController {
    setExecution(value: PreviewExecution | null): void;
    /** Optional for hosts providing an older read-only graph adapter. Never changes the runtime. */
    setBreakpoints?(value: PreviewBreakpointOverlay | null): void;
}
/** Serialized into the standalone artifact. No imports, network, storage or runtime access. */
export declare function previewViewer(data: WorkflowPreview, options?: {
    initialView?: 'readable';
    context?: 'live-workspace';
    onSelect?: (id: string | null) => void;
    onNodeSelect?: (node: {
        nodeId: string;
        graphScope: string;
    } | null) => void;
}): PreviewViewerController;

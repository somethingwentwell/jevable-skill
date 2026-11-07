import type { WorkflowPreview } from './model.ts';
import type { PreviewBreakpointOverlay } from './viewer.ts';
/** Serialized page controller. Draft edits have no network/storage side effects. */
export declare function liveBreakpointControls(ctx: {
    preview: WorkflowPreview;
    current: () => any;
    canEdit: () => boolean;
    overlay: (value: PreviewBreakpointOverlay | null) => void;
}): {
    observe: () => {
        id: string;
        checkpoint: string;
        enabled: string[];
        hit?: {
            nodeId: string;
            iteration?: number;
        };
    } | undefined;
    validate: (value: unknown) => string[];
    select(id: string | null): void;
    fields(): {
        breakpoints?: string[];
    };
    reconcile(run: any, request?: {
        id: string;
        requestId: string;
        breakpoints?: string[];
    }): void;
};
export declare const breakpointControlsHtml = "<section id=\"live-breakpoints\" hidden aria-label=\"Node breakpoints\"><h3>Node breakpoints \u00B7 draft before execution</h3>\n<p>Start paused first. Graph/node selection does not execute anything. Apply a draft only with Step or Continue above; Step still executes the current node. Drafts are cleared on reload or run change; submitted request identities retain their exact list for retry.</p>\n<label for=\"breakpoint-node\">Breakpoint node</label><select id=\"breakpoint-node\" disabled></select>\n<div class=\"live-controls\"><button id=\"breakpoint-toggle\" disabled>Add selected breakpoint to draft</button><button id=\"breakpoint-clear\" disabled>Draft clear all</button><button id=\"breakpoint-discard\" disabled>Discard draft</button></div>\n<p id=\"breakpoint-configured\"></p><p id=\"breakpoint-draft\"></p><p id=\"breakpoint-hit\" role=\"status\" aria-live=\"polite\"></p><p id=\"breakpoint-message\" role=\"status\" aria-live=\"polite\"></p>\n<p>Graph labels distinguish configured breakpoints, draft additions/removals and a recorded hit. Loop-body breakpoints apply to every iteration. Loop deadlines keep running during pauses.</p></section>";

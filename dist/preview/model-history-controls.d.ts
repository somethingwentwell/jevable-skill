import type { WorkflowPreview } from './model.ts';
import type { projectPreviewModelHistory } from './model-history.ts';
/** Serialized controller; only explicit metadata reads. No storage, dynamic HTML, external links or execution operations. */
export declare function liveModelHistoryControls(ctx: {
    request: (command: unknown) => Promise<unknown>;
    current: () => {
        runId: string;
        preview: WorkflowPreview;
    } | undefined;
}, project: typeof projectPreviewModelHistory): {
    observe: () => {
        runId: string;
        preview: WorkflowPreview;
    } | undefined;
};
export declare const modelHistoryHtml = "<section class=\"panel live\" id=\"model-history\" hidden aria-label=\"Retained model and retry history\"><h2>Model attempts and retries \u00B7 read-only</h2>\n<p>Request intent is not proof of dispatch. Model settlement is not workflow completion. Scheduled delay does not prove a later try occurred. Trace IDs do not prove collector delivery. Private provider payloads are not shown; identifiers still need review before sharing.</p>\n<div class=\"live-controls\"><button id=\"model-history-load\" disabled>Load / refresh history</button><button id=\"model-history-prev\" disabled>Previous intents</button><button id=\"model-history-next\" disabled>Next intents</button></div>\n<p id=\"model-history-message\" role=\"status\" aria-live=\"polite\"></p><p id=\"model-history-summary\"></p><p id=\"model-history-range\" aria-live=\"polite\"></p><div id=\"model-history-calls\"></div></section>";

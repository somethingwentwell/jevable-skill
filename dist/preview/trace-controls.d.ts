import type { traceNavigationTools, TraceViewerConfig } from '../telemetry/navigation.ts';
import type { prepareEvidenceDownload } from './evidence-download.ts';
/** Explicit metadata read; links are inert until clicked. No backend probing, token forwarding or stored navigation state. */
export declare function liveTraceControls(ctx: {
    request: (command: unknown) => Promise<unknown>;
    current: () => {
        runId: string;
        revision: string;
    } | undefined;
    viewer?: TraceViewerConfig;
}, tools: ReturnType<typeof traceNavigationTools>, verify: typeof prepareEvidenceDownload): {
    observe: () => {
        runId: string;
        revision: string;
    } | undefined;
};
export declare const traceControlsHtml = "<section class=\"panel live\" id=\"live-traces\" hidden aria-label=\"Retained trace navigation\"><h2>Trace references \u00B7 read-only</h2>\n<p>Only recorded trace/span IDs are linked. A sampled flag or a valid link does not prove delivery, availability or retention. Opening a link sends those IDs to the configured viewer; authenticate there separately. No runtime credentials are added to links.</p>\n<div class=\"live-controls\"><button id=\"trace-load\" disabled>Load / refresh trace references</button><button id=\"trace-prev\" disabled>Previous references</button><button id=\"trace-next\" disabled>Next references</button></div>\n<p id=\"trace-message\" role=\"status\" aria-live=\"polite\"></p><p id=\"trace-summary\"></p><ol id=\"trace-references\"></ol></section>";

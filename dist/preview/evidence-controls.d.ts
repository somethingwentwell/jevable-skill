import type { prepareEvidenceDownload } from './evidence-download.ts';
/** Explicit read and staged download. No storage, automatic downloads, workflow mutation or external destinations. */
export declare function liveEvidenceControls(ctx: {
    request: (command: unknown) => Promise<unknown>;
    current: () => {
        runId: string;
        revision: string;
    } | undefined;
}, prepare: typeof prepareEvidenceDownload): {
    observe: () => {
        runId: string;
        revision: string;
    } | undefined;
};
export declare const evidenceControlsHtml = "<section class=\"panel live\" id=\"live-evidence\" hidden aria-label=\"Download retained run evidence\"><h2>Export run evidence \u00B7 read-only</h2>\n<p>The default excludes source, inputs, outputs and actors. Identifiers still need review before sharing. This is an observation, not a runnable app, backup, restore format or proof of external outcomes.</p>\n<label><input type=\"checkbox\" id=\"evidence-private\">I authorize private source, inputs, outputs, approval data and recorded actors in this one snapshot. Inline secrets may be included.</label>\n<div class=\"live-controls\"><button id=\"evidence-prepare\" disabled>Prepare snapshot</button><a id=\"evidence-download\" hidden rel=\"noopener\">Download snapshot</a><button id=\"evidence-clear\" disabled>Clear prepared snapshot</button></div>\n<p id=\"evidence-message\" role=\"status\" aria-live=\"polite\"></p><pre id=\"evidence-receipt\"></pre>\n<p>Your browser chooses the download location, permissions and duplicate-file handling; this page cannot enforce a private directory or confirm that saving completed. Use CLI export for controlled file permissions. Clearing or disconnecting does not delete downloaded files.</p></section>";

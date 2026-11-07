import type { prepareEvidenceBundleDownload } from './evidence-bundle-download.ts';
/** Local explicit selection; never persisted, automatically populated or automatically downloaded. */
export declare function liveEvidenceBundleControls(ctx: {
    request: (command: unknown) => Promise<unknown>;
    scope: () => string | undefined;
    current: () => {
        runId: string;
        revision: string;
    } | undefined;
    changed?: () => void;
}, prepare: typeof prepareEvidenceBundleDownload): {
    observe: () => void;
    prepared: () => {
        selection: {
            schemaVersion: 1;
            runs: {
                id: string;
                revision: string;
            }[];
        };
        sha256: string;
        selectionSha256: string;
        privacy: "metadata-only" | "private-execution-data";
    } | undefined;
};
export declare const evidenceBundleControlsHtml = "<section class=\"panel live\" id=\"live-evidence-bundle\" hidden aria-label=\"Download selected evidence ZIP\"><h2>Selected run/test evidence ZIP \u00B7 read-only</h2>\n<p>Choose a run in Past runs, or use the current result, then add it here. No run is selected automatically. Historical test assessments are included when available; passing a test does not mean a waiting workflow is complete.</p>\n<div class=\"live-controls\"><button id=\"bundle-add\" disabled>Add selected run</button><button id=\"bundle-remove\" disabled>Remove selected run</button><button id=\"bundle-clear\" disabled>Clear selection and ZIP</button></div>\n<p id=\"bundle-count\"></p><label for=\"bundle-selection\">Exact selected run IDs and workflow revisions</label><textarea id=\"bundle-selection\" readonly rows=\"4\"></textarea>\n<label><input type=\"checkbox\" id=\"bundle-private\" disabled>I authorize private source, inputs, outputs, recorded actors, approval data and historical expected/actual test values in this one ZIP. Inline secrets may be included.</label>\n<div class=\"live-controls\"><button id=\"bundle-prepare\" disabled>Prepare selected evidence ZIP</button><button id=\"bundle-save-file\" hidden disabled>Save ZIP to a file\u2026</button><a id=\"bundle-download\" hidden rel=\"noopener\">Download selected evidence ZIP</a></div>\n<p id=\"bundle-message\" role=\"status\" aria-live=\"polite\"></p>\n<section id=\"bundle-review\" hidden aria-label=\"Selected evidence summary\"><h3>Review the selected runs</h3><p>This read-only overview shows each run and any saved test assessment. A passing test does not prove that a waiting workflow finished.</p><ol id=\"bundle-review-list\"></ol></section>\n<section id=\"bundle-full-review\" hidden aria-label=\"Complete selected evidence\"><h3>Read every file here</h3><p>The files below come from the prepared ZIP after its checksum, entry limits, file hashes and run identities were checked in this page. Open a file to read its full saved contents. Private exports can show source, inputs, outputs, actors, approval details and expected/actual test values; review before sharing. Closing a file hides its text, not the prepared bytes. Clearing or disconnecting removes this view without deleting runtime records or a copy already saved by your browser.</p><div id=\"bundle-full-list\"></div></section>\n<details id=\"bundle-technical\"><summary>Technical ZIP details</summary><pre id=\"bundle-receipt\"></pre></details>\n<p>This is review material, not a runnable app, backup, restore format or approval grant. Runs are separate observations, not an atomic batch snapshot. Preview ZIPs are limited to 12 MB; use CLI export for larger archives and controlled file permissions. A completed browser save operation is not independent verification of the file on disk; this page cannot delete saved files.</p></section>";

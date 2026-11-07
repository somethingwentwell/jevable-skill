import type { PreviewProjectPin } from './release.ts';
import type { PreviewEvidenceSelection } from './evidence-bundle-download.ts';
import type { prepareProjectDownload } from './project-download.ts';
/** Explicit authoring export. No tab storage, import, acceptance or execution. */
export declare function liveProjectExportControls(ctx: {
    request: (command: unknown) => Promise<unknown>;
    scope: () => string | undefined;
    project: () => PreviewProjectPin;
    evidence: () => {
        selection: PreviewEvidenceSelection;
        sha256: string;
        selectionSha256: string;
        privacy: 'metadata-only' | 'private-execution-data';
    } | undefined;
}, prepare: typeof prepareProjectDownload): {
    observe: () => void;
};
export declare const projectExportControlsHtml = "<section class=\"panel live\" id=\"live-project-export\" hidden aria-label=\"Download an editable project\"><h2>Transfer an editable project \u00B7 not a runnable app</h2>\n<p>Export this preview's pinned project as source, inspection-only HTML and a checksum manifest. Use the runnable release panel above for an executable workflow app. Source itself may contain inline secrets.</p>\n<label><input id=\"project-export-history\" type=\"checkbox\" disabled>Include private authoring history and recorded actors (external claims, not new approval authority)</label>\n<label><input id=\"project-export-tests\" type=\"checkbox\" disabled>Include latest test definitions for this accepted revision, including private inputs and expected values (import as drafts requiring review)</label>\n<label><input id=\"project-export-attach\" type=\"checkbox\" disabled>Attach exactly the prepared selected evidence ZIP</label><p id=\"project-export-evidence\"></p>\n<label><input id=\"project-export-private\" type=\"checkbox\" disabled>I authorize private evidence in this one project ZIP, including retained inputs, outputs, actors and historical test values. Inline secrets may be included.</label>\n<div class=\"live-controls\"><button id=\"project-export-prepare\" disabled>Prepare editable project ZIP</button><a id=\"project-export-download\" hidden rel=\"noopener\">Download editable project ZIP</a></div>\n<p id=\"project-export-message\" role=\"status\" aria-live=\"polite\"></p><pre id=\"project-export-receipt\"></pre>\n<p>No import or execution occurs here. Test definitions and attached historical results are distinct. Import never restores attached runs, results, credentials or approvals. A changed evidence checksum requires fresh review. Preview downloads are limited to 12 MB; browser saving and permissions remain unqualified. Use the CLI for controlled file permissions and larger archives.</p></section>";

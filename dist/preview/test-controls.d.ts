import type { projectPreviewTestResult } from './test-result-view.ts';
interface TestTabState {
    testId?: string;
    batchId?: string;
    pendingBatch?: boolean;
    batchTriggerMode?: 'api';
    runId?: string;
}
interface TestControlContext {
    request(command: unknown): Promise<any>;
    run(test: {
        id: string;
        generation: number;
        sha256: string;
    }): Promise<any>;
    state(): TestTabState | undefined;
    /** Validated identity on the currently inspected run, not the selected test draft. */
    testRun(): {
        id: string;
        generation: number;
        sha256: string;
    } | undefined;
    scope(): string | undefined;
    retain(): void;
    canRun(): boolean;
    message(text: string): void;
    error(error: unknown): void;
    readInput?(): unknown;
    triggerMode?(): 'api' | undefined;
    revision?(): string | undefined;
    /** Latest already-observed same-run checkpoint. No additional read authority. */
    checkpoint?(): string | undefined;
}
/** Serialized with the fixed live shell. Reads never accept, generate, run or decide an approval. */
export declare function liveTestControls(ctx: TestControlContext, projectResult?: typeof projectPreviewTestResult): {
    refresh: () => Promise<void>;
    buttons: () => void;
    observe(): void;
};
export declare const testControlsHtml = "<section class=\"panel live\" id=\"live-tests\" hidden>\n<header class=\"test-toolbar\"><div class=\"test-picker\"><label for=\"test-list\">Choose a saved test</label><select id=\"test-list\"></select></div><button id=\"test-refresh\">Refresh saved tests</button></header>\n<div class=\"tests-layout\"><section class=\"test-path-panel\" id=\"test-compose-panel\" aria-labelledby=\"test-compose-title\"><p class=\"test-step\">1 \u00B7 Save</p><h3 id=\"test-compose-title\">Set up your test</h3><p>Give this sample a name and choose what should happen.</p><div id=\"test-composer-host\"></div>\n<div class=\"live-controls test-save-actions\"><button id=\"test-create\">Save new test draft</button><button id=\"test-edit\" disabled>Save changes</button></div>\n<details class=\"test-details\"><summary>Advanced test definition (JSON)</summary><label for=\"test-editor\">Case JSON: title, input, expectations and optional triggerMode: api</label><textarea id=\"test-editor\" spellcheck=\"false\"></textarea><button id=\"test-copy-input\" type=\"button\">Use input from Try it</button><button id=\"test-use-entry\" type=\"button\">Use selected entry</button>\n<p>Accepted cases use their saved entry contract, not the current workflow selector. Generation retains that selector with its batch identity; retry never changes it. Omit triggerMode for the default manual/chat contract.</p>\n<p>Exactly one status expectation is required: completed, waiting, failed or cancelled. Optional assertions: output-equals, failure-code, node-visited, node-output-equals, node-port-equals. Port assertions require an exact recorded outgoing selection; they do not prove target completion. Missing legacy ports are unavailable, never inferred. Generation suggests completed; review it for your workflow.</p>\n</details></section>\n<section class=\"test-path-panel\" id=\"test-review-panel\" aria-labelledby=\"test-review-title\"><p class=\"test-step\">2 \u00B7 Review &amp; run</p><h3 id=\"test-review-title\">Review the saved version</h3><div id=\"test-saved-review-host\"></div><details class=\"test-details\"><summary>Exact saved definition and identity</summary><pre id=\"test-review\">No case selected.</pre></details><label class=\"test-consent\"><input type=\"checkbox\" id=\"test-authorize\">I reviewed and authorize this exact case definition.</label>\n<div class=\"live-controls\"><button id=\"test-accept\" disabled>Accept reviewed case</button><button id=\"test-run\" disabled>Run accepted case</button></div>\n<p class=\"test-execution-warning\">Running a test may call paid services or make outside changes. Test acceptance never approves a workflow decision.</p></section></div>\n<section class=\"test-outcome-panel\" id=\"test-outcome-panel\" aria-labelledby=\"test-outcome-title\"><p class=\"test-step\">3 \u00B7 Results</p><h3 id=\"test-outcome-title\">Test results</h3><div id=\"test-result-guidance\"></div>\n<p id=\"test-result-summary\" role=\"status\" aria-live=\"polite\"></p><p id=\"test-result-explanation\"></p><ul id=\"test-result-checks\"></ul>\n<div class=\"live-controls\"><button id=\"test-result\" disabled>Show expected and actual results</button><button id=\"test-result-clear\" type=\"button\">Clear inspected test result</button></div>\n<details class=\"test-details\"><summary>Privacy and exact result details</summary><p>Private displays are cleared on disconnect or session change; results also clear when the selected run or checkpoint changes. Clear and closing the page discard displayed data, not retained runtime evidence. Late replies never restore cleared results or trigger another run.</p><details><summary>Advanced test details (JSON)</summary><pre id=\"test-report\">No test result inspected.</pre></details></details></section>\n<details class=\"test-tools\"><summary>More test tools</summary><h3>Suggested drafts</h3><p>Suggestions are untested drafts. Review and accept each one before running it.</p><button id=\"test-generate\">Suggest test drafts</button><details><summary>Private generation receipt</summary><pre id=\"test-batch\"></pre></details>\n<details><summary>Earlier versions of this test</summary><h3>Retained case versions \u00B7 read-only</h3><button id=\"test-history-load\" disabled>Load selected case history</button>\n<label for=\"test-history-list\">Versions in this exact preview revision</label><select id=\"test-history-list\" disabled></select>\n<button id=\"test-history-inspect\" disabled>Inspect selected version\u2019s private definition</button><button id=\"test-history-clear\" type=\"button\">Clear inspected case history</button>\n<p id=\"test-history-status\" role=\"status\" aria-live=\"polite\"></p>\n<p>History lists retained version metadata only. Explicit inspection shows private input, expectations and review identity separately; it never replaces the latest editor or edit/accept/run guards. Clear, disconnect, case changes and closing the page discard displays, not retained history.</p><div id=\"test-history-reading\"></div><details><summary>Technical historical definition (JSON)</summary><pre id=\"test-history-detail\"></pre></details>\n</details><h3>Archive or restore this saved test</h3><div class=\"live-controls\"><button id=\"test-archive\" disabled>Archive reviewed case</button><button id=\"test-unarchive\" disabled>Restore reviewed case</button></div>\n<p>Archive/restore require the review authorization above and the exact saved definition. They append a lifecycle version, never erase data or change admitted runs. After a lost reply, refresh this case before another mutation; no automatic retry or newer guard is submitted.</p></details></section>";
export {};

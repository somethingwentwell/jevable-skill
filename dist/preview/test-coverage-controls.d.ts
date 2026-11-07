import type { WorkflowPreview } from './model.ts';
interface CoverageContext {
    request(command: unknown): Promise<any>;
    scope(): string | undefined;
    project(): {
        id: string;
        generation: number;
        revision: string;
    } | undefined;
    preview(): WorkflowPreview | undefined;
    error(error: unknown): void;
}
/** Serialized standalone controller. Selections live only in this page, never in storage.
 * Loading, choosing and reading retained tests cannot run or approve a workflow. */
export declare function liveTestCoverageControls(ctx: CoverageContext): {
    observe: () => void;
};
export declare const testCoverageHtml = "<section class=\"panel live\" id=\"live-test-coverage\" hidden aria-labelledby=\"test-coverage-title\">\n<h2 id=\"test-coverage-title\">What have your tests reached?</h2>\n<p>Choose past test runs to see which steps and branches they reached. This only reads saved results. It never runs a workflow or approves a decision.</p>\n<button id=\"test-coverage-load\" type=\"button\" disabled>Load past test runs</button>\n<fieldset class=\"test-coverage-picker\"><legend>Choose past test runs</legend><div id=\"test-coverage-runs\"></div></fieldset>\n<div class=\"live-controls\"><button id=\"test-coverage-show\" type=\"button\" disabled>Show coverage</button><button id=\"test-coverage-clear\" type=\"button\">Clear selection and report</button></div>\n<p id=\"test-coverage-status\" role=\"status\" aria-live=\"polite\"></p><p id=\"test-coverage-summary\" class=\"test-coverage-summary\"></p>\n<details><summary>Steps and branches not observed</summary><ul id=\"test-coverage-gaps\"></ul></details>\n<p>Clear, disconnect and closing the page discard this display, not saved tests or evidence. To check newer results, load and select the runs again.</p></section>";
export {};

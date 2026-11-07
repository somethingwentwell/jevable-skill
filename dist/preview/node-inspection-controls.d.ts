import type { WorkflowPreview } from './model.ts';
import type { projectPreviewExecution } from './execution.ts';
/** Serialized explicit-read controller. Private values live only in text nodes, never storage or exported HTML. */
export declare function liveNodeInspectionControls(ctx: {
    request: (command: unknown) => Promise<unknown>;
    current: () => {
        preview: WorkflowPreview;
        receipt: any;
        session: string;
    } | undefined;
}, project: typeof projectPreviewExecution): {
    observe: () => {
        preview: WorkflowPreview;
        receipt: any;
        session: string;
    } | undefined;
    select: (node: {
        nodeId: string;
        graphScope: string;
    } | null) => void;
};
export declare const nodeInspectionHtml = "<section class=\"panel live\" id=\"node-private\" hidden aria-label=\"Selected node private inspection\"><h2>This step's saved values</h2>\n<p>See what this step received and returned. Values stay private; hide them before sharing your screen.</p>\n<div id=\"node-private-picker\"><label for=\"node-private-record\">Result to view</label><select id=\"node-private-record\" disabled></select></div>\n<div class=\"live-controls\"><button id=\"node-private-load\" disabled>Show saved values</button><button id=\"node-private-clear\">Hide values</button></div>\n<div id=\"node-private-summary\"></div><p id=\"node-private-message\" role=\"status\" aria-live=\"polite\"></p><details class=\"exact-values\"><summary>Exact recorded inputs and outputs</summary><div class=\"live-grid\"><section><h3>Recorded input</h3><pre id=\"node-private-input\"></pre></section><section><h3>Recorded output</h3><pre id=\"node-private-output\"></pre></section></div></details><details class=\"exact-values\"><summary>Exact record identity</summary><pre id=\"node-private-receipt\"></pre></details><details class=\"exact-values\"><summary>Privacy and record details</summary><p>Private data is loaded only on request. Selecting a node, changing records or refreshing status never executes or reconstructs values. Values are excluded from portable HTML and tab storage. Result indices are global; loop iterations start at zero.</p></details></section>";

import type { previewUsageTools } from './usage.ts';
/** Explicit selected-run read, with drafts and private identifiers held only in memory. */
export declare function liveUsageControls(ctx: {
    request: (command: unknown) => Promise<unknown>;
    current: () => {
        runId: string;
        revision: string;
        session: string;
    } | undefined;
}, tools: ReturnType<typeof previewUsageTools>): {
    observe: () => {
        runId: string;
        revision: string;
        session: string;
    } | undefined;
    clear: () => void;
};
export declare const usageControlsHtml = "<section class=\"panel live\" id=\"live-usage\" hidden aria-label=\"Selected run retained model usage\"><h2>Model usage \u00B7 read-only selected run</h2>\n<p>Successful-response usage is counted once across retries, not multiplied by try count. Failed/pending calls may have unreported consumption. This is neither account-wide usage, pricing, billing nor proof of provider dispatch. No run discovery or model calls. Identifiers may be private.</p>\n<fieldset><legend>Usage draft \u00B7 applied only on Load</legend><div class=\"live-grid\">\n<label for=\"usage-group\">Requested identity grouping <select id=\"usage-group\"><option value=\"\">None \u00B7 identifiers excluded</option><option value=\"provider\">Provider \u00B7 opt into its identifier</option><option value=\"provider-model\">Provider and model \u00B7 opt into their identifiers</option></select></label>\n<label for=\"usage-from\">Original intent from \u00B7 inclusive <input id=\"usage-from\" type=\"text\" maxlength=\"24\" autocomplete=\"off\" spellcheck=\"false\" placeholder=\"2026-10-01T00:00:00.000Z\" aria-describedby=\"usage-help\"></label>\n<label for=\"usage-before\">Original intent before \u00B7 exclusive <input id=\"usage-before\" type=\"text\" maxlength=\"24\" autocomplete=\"off\" spellcheck=\"false\" placeholder=\"2026-10-02T00:00:00.000Z\" aria-describedby=\"usage-help\"></label>\n</div><p id=\"usage-help\">Omit both time bounds or provide both UTC timestamps with milliseconds. Whole calls follow original intent time, not each retry or settlement. Requested identity is not the provider response version or a billing identity. Drafts and results are not saved in browser storage.</p></fieldset>\n<div class=\"live-controls\"><button id=\"usage-load\" disabled>Load / refresh selected usage</button><button id=\"usage-clear\" disabled>Clear displayed usage</button></div><p id=\"usage-message\" role=\"status\" aria-live=\"polite\"></p><div id=\"usage-results\"></div></section>";

import { createHash } from 'node:crypto'
import { createPreview } from './model.ts'
import { previewViewer } from './viewer.ts'
import type { WorkflowCompilerLimits } from '../workflow/index.ts'
import { DEFAULT_COMPILER_LIMITS } from '../limits.ts'
import { previewVendorImport } from '../projects/vendor-import.ts'
import { importReviewScript } from './workspace.generated.ts'
import { workspaceCss } from './workspace-style.ts'
export { createPreview } from './model.ts'
export type { WorkflowPreview, PreviewGraph, PreviewNode } from './model.ts'
export { projectPreviewExecution } from './execution.ts'
export type { PreviewExecution, PreviewExecutionNode, PreviewExecutionRecord } from './execution.ts'
export { projectPreviewModelHistory } from './model-history.ts'
export { projectPreviewTestResult } from './test-result-view.ts'
export type { PreviewTestResultTarget, PreviewTestResultView } from './test-result-view.ts'
export { projectPreviewNotificationHistory } from './notification-history.ts'
export type { PreviewModelHistory } from './model-history.ts'
export { schemaInputTools } from './input-model.ts'
export { projectPreviewNodeInspection, previewNodeSelectionSchema, previewNodeInspectionRequestSchema } from './node-inspection.ts'
export type { PreviewNodeInspection, PreviewNodeSelection, PreviewNodeInspectionRequest } from './node-inspection.ts'

export const previewCss = `
:root{color-scheme:light;--bg:#f3f5f7;--panel:#fff;--ink:#162b37;--muted:#546975;--line:#d4dfe5;--accent:#007a78;--node:#edf9f7}
:root[data-theme=dark]{color-scheme:dark;--bg:#0e1720;--panel:#172531;--ink:#e8f1f6;--muted:#a8bcc9;--line:#344b5b;--accent:#55d9c1;--node:#193b3b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
header{padding:24px 30px 16px;border-bottom:1px solid var(--line);background:var(--panel)}.brand{font-weight:700;color:var(--accent);letter-spacing:.12em;font-size:12px}h1{font-size:26px;line-height:1.25;margin:8px 0}h2{font-size:17px;margin:0 0 8px}p{margin:8px 0}.muted{color:var(--muted)}#identity{font:12px/1.5 ui-monospace,monospace;overflow-wrap:anywhere}#validation{font-weight:600;color:var(--accent)}
button,input,select,summary{font:inherit}button,select,input{border:1px solid var(--line);border-radius:7px;padding:8px 11px;background:var(--panel);color:var(--ink)}button{cursor:pointer}button:hover{border-color:var(--accent)}:focus-visible{outline:3px solid var(--accent);outline-offset:3px}input,select{max-width:100%;min-width:0}button[disabled]{cursor:not-allowed;color:var(--muted)}
.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:14px 30px}.toolbar label{display:flex;gap:8px;align-items:center}.toolbar select{max-width:360px}.spacer{flex:1}.notice{margin:0 30px 14px;padding:10px 14px;border-left:3px solid var(--accent);background:var(--panel)}
main{display:grid;grid-template-columns:240px minmax(0,1fr) 330px;gap:14px;padding:0 30px 24px;align-items:start}.panel{min-width:0;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px}.canvas{padding:0;overflow:hidden}#scope-label{padding:14px 16px;margin:0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}#graph{display:block;width:100%;height:560px;touch-action:none;background:var(--panel)}
.edge{fill:none;stroke:var(--muted);stroke-width:2}.arrow{fill:var(--muted)}.edge-label{fill:var(--ink);font:12px system-ui;paint-order:stroke;stroke:var(--panel);stroke-width:5px;stroke-linejoin:round}.node{cursor:pointer}.node rect{fill:var(--node);stroke:var(--accent);stroke-width:1.5}.node.humanApproval rect{fill:var(--panel);stroke:#cb7b25;stroke-width:2}.node.custom rect{stroke-dasharray:6 4}.node[aria-pressed=true] rect,.node:focus rect{stroke-width:4}.node text{fill:var(--ink);pointer-events:none}.node .kind{font-size:11px;font-weight:700;fill:var(--accent)}.node .node-label{font-size:15px;font-weight:650}.node .node-id{font:11px ui-monospace,monospace;fill:var(--muted)}
#node-list{padding:0;list-style:none;margin:10px 0;max-height:480px;overflow:auto}#node-list li{margin:6px 0}#node-list button{width:100%;text-align:left;overflow-wrap:anywhere}#search{width:100%}#search-count{display:block;font-size:12px;color:var(--muted);margin-top:6px}#detail-kind{overflow-wrap:anywhere}pre{font:12px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:440px;overflow:auto}#detail-actions{display:flex;gap:8px;flex-wrap:wrap}details{margin-top:14px}summary{cursor:pointer;font-weight:600}#graph-diagnostics{white-space:pre-wrap;color:var(--muted);margin:0;padding:12px 16px}#graph-diagnostics:empty{display:none}#connections{padding-left:20px;overflow-wrap:anywhere;max-height:320px;overflow:auto}.lower{margin:0 30px 24px}.lower details{margin:0}noscript{display:block;padding:20px}
#graph .node .node-focus-ring[data-focus-ring]{fill:none;stroke:var(--accent);stroke-width:3;stroke-dasharray:none;opacity:0;pointer-events:none}#graph .node:focus-visible .node-focus-ring[data-focus-ring]{opacity:1}#graph-back{padding:10px 16px 0}#graph-keyboard-help{padding:10px 16px;margin:0;font-size:11px;color:var(--muted);border-top:1px solid var(--line)}
[hidden]{display:none!important}.execution-label{font:11px system-ui;paint-order:stroke;stroke:var(--panel);stroke-width:3px}.node[data-execution=unobserved] rect{stroke:var(--muted);stroke-dasharray:3 4}.node[data-execution=settled] rect{stroke-width:3}.node[data-execution=next] rect,.node[data-execution=active-loop] rect{stroke-width:4;stroke-dasharray:8 4}.node[data-execution=waiting] rect,.node[data-execution=unsettled] rect{stroke:#b77914;stroke-width:4;stroke-dasharray:4 3}.node[data-execution=failed] rect,.node[data-execution=stopped] rect{stroke:#d35858;stroke-width:4}.edge[data-execution=unobserved]{stroke-dasharray:3 5;opacity:.55}.edge[data-execution=selected]{stroke:var(--accent);stroke-width:4}.edge[data-execution=observed]{stroke:var(--accent);stroke-width:2;stroke-dasharray:10 3}.edge[data-execution=ambiguous]{stroke:#b77914;stroke-width:3;stroke-dasharray:7 4}#execution-summary{overflow-wrap:anywhere}#detail-execution{border-top:1px solid var(--line);padding-top:12px;margin-top:12px}
@media(min-width:1800px){#graph{height:700px}main{grid-template-columns:260px minmax(0,1fr) 380px}}
@media(max-width:1100px){main{grid-template-columns:200px minmax(0,1fr)}.inspector{grid-column:1/-1}#detail-body{max-height:260px}}
@media(max-width:700px){header{padding:18px}.toolbar{padding:12px 18px}.toolbar label{width:100%}.notice{margin:0 18px 12px}main{display:flex;flex-direction:column;padding:0 18px 18px}.panel{width:100%}#node-list{max-height:150px}#graph{height:420px}.lower{margin:0 18px 18px}h1{font-size:23px}}
`
export const previewBody = `<nav class="toolbar" aria-label="Preview controls"><label>Scope <select id="scope"></select></label><button id="fit">Fit graph</button><button id="read-steps" type="button">Read steps</button><button id="graph-earlier" type="button" aria-label="View earlier steps">← Earlier</button><button id="graph-later" type="button" aria-label="View later steps">Later →</button><button id="zoom-out" aria-label="Zoom out">−</button><button id="zoom-in" aria-label="Zoom in">+</button><span class="spacer"></span><button id="theme">Dark theme</button><output id="graph-view-status" aria-live="polite"></output></nav>
<p class="notice">Portable inspection only. Opening this file does not run anything. Real testing requires the Jevable workflow runtime. Workflow source is included; review it for secrets before sharing.</p>
<section class="panel lower" id="execution-overlay" hidden aria-label="Recorded execution overlay"><h2>Saved run path</h2><p id="execution-status" aria-live="polite" aria-atomic="true"></p><p id="execution-guidance"></p><details><summary>What these highlights mean</summary><p id="execution-summary"></p><p class="muted">Node labels describe retained results and the current checkpoint, not live provider activity. Result counts include loop return/aggregate records, not just attempts. Loop bodies combine recorded iterations; select a node to see individual iteration indices and timings. Solid accent connections indicate recorded port selections, not completed targets. Thin dashed accent connections show adjacency only (including the next checkpoint); amber dashed connections have an ambiguous legacy port. Other dashed connections are unobserved, not proven impossible.</p></details></section>
<main><aside class="panel"><label for="search">Find a node</label><input id="search" type="search" placeholder="Name, ID or type"><output id="search-count" aria-live="polite"></output><ul id="node-list"></ul></aside>
<section class="panel canvas" aria-label="Workflow graph"><h2 id="scope-label"></h2><div id="graph-back" hidden></div><svg id="graph" role="group" tabindex="0" aria-label="Workflow graph" aria-describedby="graph-keyboard-help"></svg><p id="graph-keyboard-help">Tab to a step. Arrow keys move between steps; Enter or Space opens details. Home and End reach the first and last step. Escape returns to the background, where arrows pan, + and − zoom, and 0 fits the graph. Navigation never runs the workflow.</p><p id="graph-diagnostics"></p></section>
<aside class="panel inspector" aria-label="Node inspector"><h2 id="detail-title">Inspect a node</h2><p id="detail-kind" class="muted"></p><div id="detail-actions"></div><section id="detail-execution" hidden><h3>Recorded execution metadata</h3><pre id="detail-execution-body"></pre></section><pre id="detail-body"></pre><details><summary>Exact connections and loop returns</summary><ul id="connections"></ul></details><details><summary>Compilation diagnostics</summary><pre id="diagnostics"></pre></details></aside></main>
<section class="panel lower"><details><summary>Workflow source · private authoring content</summary><pre id="source"></pre></details></section>`

const hash = (value: string) => createHash('sha256').update(value).digest('base64')
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')

/** A single network-disabled HTML file; no runtime tokens, run inputs, outputs or evidence are accepted. */
export function renderPreview(source: string, limits?: WorkflowCompilerLimits) {
  const data = createPreview(source, limits)
  return { data, html: renderPreviewPage(data, previewCss, '') }
}

function renderPreviewPage(data: ReturnType<typeof createPreview>, css: string, beforeGraph: string, importReview = false) {
  const json = JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll('&', '\\u0026').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')
  const script = `(${previewViewer.toString()})(JSON.parse(document.getElementById('preview-data').textContent));`
  const csp = `default-src 'none'; script-src 'sha256-${hash(script)}'${importReview ? ` 'sha256-${hash(importReviewScript)}'` : ''}; style-src 'sha256-${hash(css)}'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`
  const sourceMarker = '<section class="panel lower"><details><summary>Workflow source'
  const sourceIndex = previewBody.indexOf(sourceMarker)
  const body = importReview ? `<div id="import-workspace-root"></div><div id="import-original"><header><span class="brand">JEVABLE / IMPORT REVIEW</span><div id="import-heading"><h1 id="workflow-title">${escape(data.name)}</h1></div><div id="import-technical"><p id="identity"></p><p id="validation"></p></div></header>
${beforeGraph}<div id="import-diagram"><div id="preview-workspace">${previewBody.slice(0, sourceIndex).replace('<svg id="graph"', '<svg id="graph" data-initial-view="readable"')}</div></div><div id="import-source">${previewBody.slice(sourceIndex)}</div></div>` : `<header><span class="brand">JEVABLE / WORKFLOW PREVIEW</span><h1 id="workflow-title">${escape(data.name)}</h1><p id="identity"></p><p id="validation"></p></header>
${beforeGraph}${beforeGraph ? '\n' : ''}${previewBody}`
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escape(csp)}"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escape(data.name)} · Jevable preview</title><style>${css}</style></head>
<body>${body}
<noscript>This preview needs JavaScript for graph inspection. It cannot execute a workflow. Use the CLI to validate the original workflow source.</noscript>
<script id="preview-data" type="application/json">${json}</script><script>${script}</script>${importReview ? `<script>${importReviewScript}</script>` : ''}</body></html>`
  return html
}

/** Offline conversion + graph review. Raw upload bytes and retained-origin authority are never embedded. */
export function renderVendorImportPreview(source: string, limits: WorkflowCompilerLimits = DEFAULT_COMPILER_LIMITS) {
  const conversion = previewVendorImport(source, limits.source), data = createPreview(conversion.yaml, limits)
  const counts = { exact: 0, approximate: 0, unsupported: 0 }
  for (const mapping of conversion.mappings) counts[mapping.kind]++
  const reasons = {
    mapped: 'Mapped to a Jevable step; review its configuration.',
    'trigger-mode': 'The source trigger needs an explicitly configured Jevable entry mode; no source scheduler or webhook starts here.',
    'model-route': 'Review the provider, model and prompt before an authorized test.',
    expression: 'Review expressions and data bindings; source-platform evaluation may differ.',
    operator: 'Review the condition and branch behavior.',
    code: 'Custom code does not execute in the current runtime; replace or implement this step before testing.',
    'node-type': 'This source connector has no supported execution mapping; repair the draft before testing.',
    unreachable: 'This source step is unreachable in the converted graph; inspect the original routing.',
    language: 'Review the source language and translated behavior.',
    loop: 'Review loop bounds, entries and returns before testing.',
  }
  const rows = (kind: 'exact' | 'review') => conversion.mappings.filter(row => kind === 'exact' ? row.kind === 'exact' : row.kind !== 'exact')
    .map(row => `<li data-import-mapping="${row.kind}"><div><span class="import-kind">${row.kind}</span><strong>${escape(row.source)}</strong><span class="muted">${escape(row.sourceType)}</span></div><div><p>${row.target ? `Converted step: <code>${escape(row.target)}</code>` : 'No converted step.'}</p><p>${escape(reasons[row.reason])}</p></div></li>`).join('')
  const report = `<section class="panel lower import-review" id="import-review" aria-labelledby="import-review-title">
<h2 id="import-review-title">Review the conversion before testing</h2><p>${escape(conversion.format)} · ${counts.exact} exact · ${counts.approximate} approximate · ${counts.unsupported} unsupported</p>
<p>A converted graph is not proof of equivalent source-platform behavior. Review every approximate or unsupported step. Custom code does not execute in the current runtime. Provider readiness has not been checked.</p>
${counts.approximate + counts.unsupported ? `<h3>Steps that need your review</h3><ul class="import-mappings">${rows('review')}</ul>` : '<p>No approximate or unsupported mappings reported. Still review the workflow before testing.</p>'}
<details><summary>Exact mappings (${counts.exact})</summary><ul class="import-mappings">${rows('exact')}</ul></details>
<p>Find a converted step by its ID in the workflow diagram. Nothing runs when you select a step.</p>
<details><summary>Conversion identity and privacy</summary><p>Converter: ${escape(conversion.converter.name)} ${escape(conversion.converter.version)} · source format version: ${escape(conversion.version)}</p><p>Upload SHA-256: <code>${conversion.sourceSha256}</code><br>Conversion SHA-256: <code>${conversion.conversionSha256}</code><br>Converted revision: <code>${conversion.conversionRevision}</code></p><p>The report and converted workflow are private authoring content. Original upload bytes are not included; source labels and converted values can still be private. No project was created, no trusted vendor origin was restored, and no workflow was run. Review before sharing.</p></details>
</section>`
  const css = previewCss + workspaceCss + `\n.import-review{margin-top:18px}.import-review p{max-width:65ch}.import-review code{overflow-wrap:anywhere}.import-mappings{list-style:none;padding:0;margin:12px 0}.import-mappings li{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:20px;padding:14px 0;border-top:1px solid var(--line);overflow-wrap:anywhere}.import-mappings strong,.import-mappings span{display:block}.import-kind{font-size:12px;font-weight:600;color:var(--accent)}.import-mappings p{margin:0 0 6px}
.import-context{margin:18px 28px;color:var(--muted);font-size:13px;max-width:70ch}.import-offline{font-size:12px;color:var(--muted);white-space:nowrap}.import-app .import-review{max-width:1050px;margin:24px auto;padding:24px}.import-app .import-review h2{font-size:24px;letter-spacing:-.6px}.import-app #import-diagram{margin:24px 28px;border:1px solid var(--line);border-radius:12px;overflow:hidden}.import-app #preview-workspace main{grid-template-columns:170px minmax(0,1fr) 300px}.import-app #preview-workspace .inspector{grid-column:auto;border:0;border-left:1px solid var(--line);border-radius:0;padding:20px}.import-app #preview-workspace .toolbar{border-bottom:1px solid var(--line)}.import-app #preview-workspace #graph{height:480px}.import-details-page{max-width:1050px;padding:24px;margin:auto}.import-details-page>p{color:var(--muted);max-width:65ch}.import-details-page .lower{margin:20px 0}.import-details-page #validation{color:var(--ink)}
@media(max-width:1100px){.import-app #preview-workspace main{grid-template-columns:170px minmax(0,1fr)}.import-app #preview-workspace main>.panel:first-child{display:block}.import-app #preview-workspace .inspector{grid-column:1/-1;border-left:0;border-top:1px solid var(--line)}}
@media(max-width:700px){.import-review,.import-review~.lower{width:auto}.import-mappings li{grid-template-columns:minmax(0,1fr);gap:6px}.import-app .import-review{margin:18px;padding:18px}.import-app #import-diagram{margin:18px}.import-app #preview-workspace main{display:flex;flex-direction:column}.import-app #preview-workspace main>.panel:first-child{border-right:0;border-bottom:1px solid var(--line)}.import-app #preview-workspace .inspector{width:100%;border-top:1px solid var(--line)}.import-context{margin:16px 18px}.import-offline{display:none}.import-details-page{padding:18px}}
`
  return { conversion, data, html: renderPreviewPage(data, css, report, true) }
}
export { prepareEvidenceDownload, type EvidenceDownload } from './evidence-download.ts'
export { prepareEvidenceBundleDownload, type PreviewEvidenceSelection } from './evidence-bundle-download.ts'
export { previewReleaseTools, type PreviewReleaseReceipt, type PreviewReleaseEvidence, type PreviewReleasePage, type PreviewReleaseListRow } from './release-download.ts'
export { prepareProjectDownload } from './project-download.ts'
export { prepareTraceNavigation } from './trace-navigation.ts'
export { previewUsageTools, type PreviewUsage, type PreviewUsageQuery } from './usage.ts'

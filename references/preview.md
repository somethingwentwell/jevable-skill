# Portable workflow preview — experimental

```sh
node bin/jevable.mjs preview examples/approval.yaml --output approval.html --json
```

The command writes one self-contained HTML file using the core's own renderer. It needs no server, Docker, harness, desktop, CDN, font download or installed Archify skill. Existing destinations require `--overwrite`. No file is opened automatically. HTML generation and model/escaping tests are qualified; **browser interaction, layout, CSP behavior and accessibility remain unqualified** because the browser tool rejected opening the local file. Do not treat this prototype as the completed portable-preview milestone.

The viewer implements a node list/search, SVG graph, labelled branch edges, node configuration inspector, light/dark themes, fit/zoom and pointer/keyboard panning. A scope selector and loop inspector open loop-body graphs; the exact connection list includes body entry/return information and return bindings. Cyclic or missing-node connections are retained in the source/list with diagnostics, not silently corrected or replaced with fabricated workflow nodes. Large and complex routing needs browser qualification before a readability claim.

Keyboard navigation is view-only. Tab reaches each step; left/right moves to the nearest visual column and up/down between rows in that column, not along inferred routes. Home/End reaches the first/last visual step. Focus brings an off-view step into the viewBox without selecting it; an over-zoomed view expands only enough to contain that step. Enter/Space opens public step details. Escape focuses the background for pan/zoom; platform/IME shortcuts and ordinary Tab remain untouched. A distinct focus outline does not change execution or breakpoint status. **Explore loop body** focuses its graph; **Back to workflow** returns focus to the actual parent loop, without selecting it or loading private records. The selector retains focus on scope changes. These emitted-controller DOM/CSS/viewBox checks are not native keyboard, screen-reader, pixel layout or browser acceptance.

Compact node titles use [grapheme segmentation](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter) when available, so truncation does not split an emoji, accent or joined sequence. Full text remains in search, inspection, tooltips and accessible names. Older hosts without `Intl.Segmenter` shorten ASCII only and retain Unicode titles intact; long Unicode labels may need the inspector, and their actual layout remains unqualified.

Eight source-level node families are recognized. Custom code execution remains unavailable; displaying a Custom node does not enable it. Human Approval is supported inside bounded loop bodies by the Jevable workflow runtime; see [review each loop item](authoring.md#review-each-loop-item). Rendering that flow here neither starts a run nor decides an approval. This is an **inspection artifact**, not a runnable application, test result, release bundle or replacement for the Jevable workflow runtime. No Run/Approve controls or fake outputs are supplied. The separate experimental [authenticated live preview](live-preview.md) connects explicit testing controls to real execution; it remains browser-unqualified.

## Identity, validation and privacy

- `format: jevable.preview/v1` is the preview-data contract. `sourceSha256` hashes the exact input bytes. `revision` is the canonical admitted workflow revision, or `null` when the readable document has invalid graph structure.
- `validation` records real offline compilation diagnostics. A source-admitted draft can have a revision and still fail compilation. A readable malformed graph can be inspected without claiming admission. Invalid YAML/envelopes and exceeded budgets fail without publishing HTML.
- `runtimeReadiness: not-checked` and `execution: not-run` are explicit and unconditional. Rendering never opens runtime storage or contacts a provider.
- A written invalid-draft preview returns exit code 2 with its artifact receipt, not a successful compilation claim. The receipt's `visualReview: not-performed` is intentional.
- **The full workflow source and node configuration are included.** They may contain authored secrets or sensitive prompts; inspect them before sharing. Runtime tokens, credential-store values, run inputs/outputs and saved evidence are not loaded or included. There is no automatic redaction guarantee for author-supplied secrets.
- Labels/configuration are serialized as escaped JSON and rendered with text APIs. The emitted CSP permits only the hashed inline code/style and denies network connections, external content, forms and base-URL overrides. Browser enforcement still needs verification.

Current global view budgets are 2,000 nodes and 4,000 connections, alongside compiler source/per-graph limits. Nested loop execution is unsupported and shown as a diagnostic/configuration rather than recursively claiming runnable semantics.

SDK: import `createPreview(source)` or `renderPreview(source)` from `@jevable/core/preview`. `createPreview` returns immutable preview data; `renderPreview` returns `{ data, html }`. Neither starts a server or writes a file. Output-file publication belongs to the CLI's atomic, no-overwrite-by-default artifact helper.

## Same-app static review

When the user requests diagram review beside the conversation, the agent should open the generated HTML through the host's available rendered-file viewer or documented local-file browser capability. Use the actual output path from the artifact receipt. This is an optional presentation step: the CLI itself never launches a browser, requires a desktop agent or starts a service for static HTML.

Only claim a visible preview after confirming rendered content, not merely an opening request or an HTML source editor. If the host cannot render local HTML, provide a clickable artifact link and disclose that limitation. Respect local-file and browser-policy restrictions; do not rehost the artifact, start a server or switch browsers to bypass a refusal. A diagram-only request does not authorize runtime startup or workflow execution.

For inputs, explicit tests and recorded results, offer the separate [same-app live preview](live-preview.md#desktop-agent-preview). That viewer connects to the standalone Jevable workflow runtime; the HTML inspection file has no execution backend. Actual rendered-file interaction must be verified independently on each host before claiming support.

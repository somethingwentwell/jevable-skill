# Navigate retained trace references

Trace navigation is read-only. It reads a verified, payload-excluding run-evidence snapshot and prepares links from recorded IDs. It does not enable telemetry, contact a Collector/viewer, replay a run, resend spans or open a browser automatically. A valid link or sampled flag does not prove delivery, backend availability or retention.

## Configure the viewer separately

Use an operator-selected JSON file, not workflow source, model output or an OTLP credential file:

```json
{
  "schemaVersion": 1,
  "origin": "https://traces.example",
  "pathTemplate": "/trace/{traceId}",
  "spanParameter": "spanID"
}
```

The origin supports HTTPS or loopback HTTP (`127.0.0.1` / `[::1]`) and has no path, user information, query or fragment. The path has exactly one `{traceId}` and may contain ordinary ASCII route segments, not other placeholders, encoded escapes, queries, fragments or dot segments. Optional `spanParameter` is `spanID`, `spanId` or `span`; its value is always the recorded hexadecimal span ID. Omit it for a trace-only route.

This v1 route profile stays unchanged. It does not support arbitrary backend query languages or static query parameters. Use a compatible simple path, or the specific Grafana Tempo profile below; do not put login tokens or secrets in route segments. Runtime/OTLP/provider credentials are never read to construct links. Authenticate with the viewer separately. The approved origin/path is operator-controlled, not automatic secret detection.

Opening a link discloses trace/span IDs to the chosen viewer. Only configure a destination authorized to receive them. Preview links use a new tab with `noopener noreferrer` and no referrer; actual browser behavior and any backend redirects remain unqualified. There are no availability probes or automatic requests to the viewer, and there is no promise that an unsampled, delayed or expired trace can be found.

## Grafana Tempo Explore

For an explicitly reviewed Grafana/Tempo installation, choose this distinct configuration:

```json
{
  "schemaVersion": 2,
  "kind": "grafana-tempo-explore",
  "origin": "https://grafana.example",
  "datasourceUid": "tempo-reviewed_1",
  "orgId": 1,
  "range": { "from": "now-24h", "to": "now" }
}
```

The example destination/UID are illustrative, not a discovered or provisioned backend. Replace them with your authorized Grafana origin, exact Tempo datasource UID and organization ID. Optional `pathPrefix` supports a reviewed subpath such as `/tools/grafana`; omit it for an origin-root installation. Do not put `/explore` in the prefix. It permits plain nonempty ASCII path segments, without trailing slash, dot traversal, escaping, query or fragment. UID permits 1–40 ASCII letters/digits/underscore/hyphen; organization is a positive safe integer. The same HTTPS/literal-loopback origin rules apply as for v1.

Range is required; Jevable never guesses a window from wall-clock time or workflow payloads. Use either two canonical nonnegative epoch-millisecond strings with `from < to` (up to the JavaScript Date limit), or `from: now-<positive integer><s|m|h|d|w>` and `to: now`. Relative integers have at most six digits. For older retained executions, choose an absolute range covering the trace; a relative window can move past it before somebody opens the link. Mixed, rounded, signed, fractional and unknown range fields refuse. An admitted range is not evidence of retention.

The adapter creates a single encoded Explore pane, fixes its datasource type to Tempo, queries only the recorded hexadecimal trace ID and selects the recorded span ID. Operator-controlled origin/prefix/UID/organization/range and trace/span IDs enter the URL; workflow/run/node/request/attempt identities, payloads and credentials do not. No arbitrary queries, URL templates, static query values, short-link API or automatic browser navigation are accepted. `schemaVersion: 2` is Jevable's configuration version; the generated Explore URL uses Grafana's URL schema version `1`.

The pane structure follows [Grafana's external Explore URL contract](https://grafana.com/docs/grafana/latest/visualizations/explore/get-started-with-explore/#generate-explore-urls-from-external-tools). Tempo trace-ID query handling and span-selection fields were checked against the official [v11.6.3 Tempo datasource](https://github.com/grafana/grafana/blob/v11.6.3/public/app/plugins/datasource/tempo/datasource.ts) and [Explore state types](https://github.com/grafana/grafana/blob/v11.6.3/packages/grafana-data/src/types/explore.ts). This establishes a reviewed URL structure, not compatibility with every Grafana version/plugin or actual UI/backend qualification. Independently verify your deployed version, access policy, datasource mapping, selected span and range. Authenticate separately; generating a URL grants no Grafana authority.

Inspect `schemas show trace-viewer` for both consuming input shapes. JSON Schema omits semantic origin/path/range refinements; use actual CLI/SDK admission. Configuration is at most 4 KiB when loaded from a CLI file. Both profiles are optional and work without Jarness, a desktop app or an authoring server.

## CLI

```sh
node bin/jevable.mjs runs traces <run-id> --data-dir .jevable
node bin/jevable.mjs runs traces <run-id> --data-dir .jevable --trace-viewer-file viewer.json
```

Without a viewer file, the command returns retained references with `url: null`. With it, it adds validated URLs. The JSON includes run/revision, workflow status, snapshot SHA-256, recorded reference locations and explicit availability semantics. Missing trace context is reported as `trace-context-not-recorded`, not proof of no external call. Existing context is `delivery-unverified`; no backend check is implied. Exit 0 means the read succeeded, not that the workflow succeeded or a trace exists remotely.

The same command supports the ordinary explicit [Docker owner selection](docker-owner.md) or [direct PostgreSQL job](postgres.md) flags. It never starts a service, selects a different owner or falls back to local state. Viewer JSON is read on the CLI host before opening storage; it is not uploaded into project/release data. Do not add `--include-private`: trace navigation accepts only metadata-only evidence.

## Live preview

Add `--trace-viewer-file viewer.json` to a local or Docker-backed `preview --serve` command. The runtime validates and pins a copy at startup, before project creation. Only authenticated preview sessions receive the route configuration; it is not embedded in the unauthenticated HTML shell. This option is rejected with portable `preview --output`, which stays offline.

Select a retained run, then choose **Load / refresh trace references**. No trace history is loaded on connection, status refresh or pagination. Each explicit load verifies the run/revision/privacy and snapshot digest; stale responses are discarded on run selection or disconnect. The panel lists recorded segment contexts and links, pending/failed/settled node attempts, journal references and available model-try contexts. Repeated references to the same span remain visible with their source location. Pagination is local, 25 references at a time. It stores no trace history or viewer URLs in tab storage.

Click a prepared link only when navigation is authorized. The panel does not monitor the destination or claim that it is reachable. Identity and read-protocol checks are separate from still-required browser navigation/CSP/accessibility and real-backend qualification.

## SDK and limits

`prepareTraceNavigation({runId, revision}, evidence, viewer?)` from `@jevable/core/preview` verifies a runtime-produced v1/v2 envelope and returns the same navigation report without file writes or network access. PostgreSQL event sequence strings remain exact. The runtime remains responsible for domain/journal validation; a checksum alone cannot authenticate a forged third-party snapshot.

`traceNavigationTools()` from `@jevable/core/telemetry` exposes the import-free config parser and synchronous metadata projector used by the browser. The low-level projector does **not** verify the checksum; use the async helper for unverified runtime responses. It reads only known trace-bearing metadata fields, not arbitrary payload trees. Invalid contexts fail closed, and exports over 16 MB or projections over 50,000 references are refused rather than silently truncated.

Cancellation metadata additionally exposes `cancellation-admission`, `segment-cause`, `journal-cancellation-admission` and `journal-cause` references when recorded. Each carries the retained cancellation request UUID as `requestId`, distinct from worker parent/predecessor references. The projector validates exact agreement with the retained admission and refuses substituted request/context, non-cancel causes or authority fields. Request UUIDs do not enter viewer URLs. Missing historical context is not invented; these read-only links prove neither cancellation authority, provider termination nor Collector delivery.

For SDK preview startup, pass `preview: {source, traceViewer}` to `startRuntimeService`, or `traceViewer` to `startPreviewGateway`. Neither configuration changes an exporter or backend access policy. Viewer configuration is not included in run journals or portable workflow releases; future apps choose their own authorized navigation destination.

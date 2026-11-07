# Standalone HTTP/HTTPS API

SQLite and PostgreSQL management expose explicit `notifications.destinations|prepare|send|show` operations with host-assigned actors and startup-only destination configuration. See [notifications.md](notifications.md) for strict request pins, private configuration and receipt recovery. A client disconnect does not cancel delivery; shutdown drains the admitted send before releasing its owner. Scoped preview and exact-release notification routes remain unavailable.

Exact API-release services can separately opt into [signed webhook intake](webhooks.md), off by default. It uses separate private HMAC keys, stable message IDs and shared bounded async slots; it grants start-only access, not owner/approval/read authority. Normal owner JSON endpoints below retain their bearer/protocol guards.

Use this when keeping one Jevable workflow runtime open for multiple CLI/SDK requests. The default API uses the same independently owned compiler, project store, provider configuration, approvals and SQLite execution journal as direct local commands. An explicit experimental PostgreSQL service is available through the CLI or SDK below. Neither attaches to a harness or desktop. Importing either SDK entrypoint does not start a listener.

## Start and connect

Transport alone does not select an API workflow entry. Use explicit [API trigger selection](api-trigger.md) on management `check`/`runs.start`/`projects.run` or exact-release `release.check`/`runs.start`; all existing authentication/release/owner/review guards remain required. No webhook or schedule is provisioned.

For ordinary CLI commands or a scoped local HTML gateway targeting an existing HTTPS management service, use [explicit remote endpoint selection](remote.md). The JSON `runtime request` API below remains available for explicit operation files, including local loopback HTTP.

From an installed/built skill directory, in the first terminal:

```sh
node bin/jevable.mjs runtime token --output .jevable-http-token
node bin/jevable.mjs runtime serve --token-file .jevable-http-token --data-dir .jevable --port 4331
```

The first command creates a random 256-bit token in an owner-only file and never prints it. It refuses an existing destination. Keep that file out of version control and shared artifacts. The readiness receipt reports the URL, bound listener, instance ID, protocol and transport. Without TLS flags the listener binds only `127.0.0.1`; omit `--port` to select an available local port. There is no automatic discovery or browser launch.

In another terminal, using the URL from the readiness receipt:

```sh
node bin/jevable.mjs runtime status --endpoint http://127.0.0.1:4331 --token-file .jevable-http-token
node bin/jevable.mjs runtime request examples/http-list.json --endpoint http://127.0.0.1:4331 --token-file .jevable-http-token
```

While the service owns `.jevable`, do not run direct data-directory commands against it: the exclusive writer lock will refuse them. Use HTTP operations or stop the service first. Send SIGINT/Ctrl-C or SIGTERM to the process you own to drain it. Do not stop an unrelated shared instance.

`runtime request` reads a bounded JSON operation file. It returns the API envelope `{schemaVersion, instanceId, result}`. Exit code 0 means the HTTP operation returned successfully, **not** that a workflow completed: inspect `result.status` (`completed`, `waiting`, `paused`, `executing`, or `failed`). Direct `run` commands retain their separate workflow-specific exit codes. Set `--timeout-ms` explicitly for long requests (default 30 seconds; maximum one hour). No automatic HTTP retry occurs.

Authenticated SQLite health includes `runtime.storage: "sqlite"` and `runtime.telemetry`, including disabled status or per-signal exporter counters and sanitized failure categories. This is a process-local snapshot, not a database integrity check or proof of collector delivery. Reading it never flushes telemetry or starts/replays workflow execution; separately enabled HTTP request instrumentation may observe the health request itself. Exact-release services expose this same read-only status without granting management operations such as `telemetry.flush`. PostgreSQL adds actual owned-session health as described below.

## PostgreSQL management service

Start the PostgreSQL service explicitly:

```sh
node bin/jevable.mjs runtime serve --storage postgres \
  --database-file /private/jevable-database.json \
  --token-file /private/jevable-http-token --port 4331
```

The database file contains the raw `PostgresJournalOptions` object described in [postgres.md](postgres.md): explicit host, port, database, user, password, namespace, initialization decision and TLS policy. Do not wrap it in `runtime` or `database`. It must be a bounded UTF-8 JSON object in a regular, non-symlink file (maximum 1 MB). On POSIX it must belong to the runtime user with no group/other permissions, normally `0600`. Special files/FIFOs are refused. Never supply passwords as flags or copy this file into a workflow, release or image. Ambient `PG*` environment variables do not replace these settings.

Omitting `--storage` selects SQLite. PostgreSQL requires `--database-file` and rejects `--data-dir`; SQLite rejects `--database-file`. A failed selection or connection never falls back to another backend. The CLI readiness receipt includes `storage`. Use the same authenticated `runtime status` and `runtime request` clients for either service; PostgreSQL list operations require explicit pages below. Direct jobs also accept these explicit backend flags and open their own SDK owner without HTTP; see [direct CLI jobs](postgres.md#direct-cli-jobs). They refuse a namespace already owned by a service; use its API instead. Experimental [PostgreSQL HTML preview](live-preview.md#preview-with-postgresql-storage) is a separate loopback-only mode with a caller-retained fresh project UUID, not a remote or exact-release viewer. Browser and management Docker/Kubernetes profiles remain unfinished. Explicit exact-release serving is described below.

Both service backends accept `--telemetry-file` and `--drain-wait-ms` (1–60000, default 5000). The latter only controls when to report that shutdown is still draining, not a forced-termination deadline. SIGINT/SIGTERM seals admission, drains work, flushes telemetry and emits a final `closed` receipt before exit code 0. Repeated signals do not force a kill. A signal received while database startup is pending is retained: after startup finishes, the service closes without a misleading `ready` receipt and reports `startupCancelled: true`. It does not roll back initialization already in progress or cancel provider-side effects. Startup failures emit sanitized errors; signal/process-kill failures do not prove an operation was rolled back.

Import `startPostgresRuntimeService` from `@jevable/core/http/postgres`, separately from the SQLite service. Supply `{runtime: {database, telemetry?}, token, actor, port?}`; `database` is the explicit private configuration described in [postgres.md](postgres.md). The host must provision PostgreSQL and load credentials securely; this service never starts Docker, discovers another application's database or reconnects a lost session.

```js
import { startPostgresRuntimeService } from '@jevable/core/http/postgres'
import { RuntimeClient } from '@jevable/core/http'

// database and token are supplied by the trusted host from private configuration.
const service = await startPostgresRuntimeService({ runtime: { database }, token, actor: 'local:operator' })
try {
  const client = new RuntimeClient(service.url, token)
  const page = await client.operation({ operation: 'runs.list', page: { limit: 100 } })
  // Inspect page.result and follow nextCursor; do not assume this is the complete collection.
} finally {
  await service.close()
  await service.closed
}
```

This is management JSON over authenticated loopback HTTP or explicit direct HTTPS using the same TLS profile below. Preview and unknown top-level options are rejected. Explicit `release: { snapshot }` selects the separately scoped exact-release mode below. Provider configuration, authoring/review, saved tests, approvals, control/cancellation, paginated metadata, release records, evidence and telemetry operations use the owned PostgreSQL runtime. Capabilities identify PostgreSQL, v2 evidence and service/direct-job CLI selection. Release metadata creation verifies installed runtime bytes; `releasePackaging: false` means this HTTP service does not write ZIPs or build images. The CLI can independently package pinned SQLite or PostgreSQL runtimes; see [runnable releases](releases.md). HTML remains unavailable here.

Authenticated health checks query the actual owned database session and return `runtime.storage`, reachability, active runs and exporter status. Owner loss and uncertain commits return sanitized HTTP 503 codes (`ownership-lost`, `unavailable`, `commit-uncertain`); inspect the original retained identities after explicitly closing/reopening. Never interpret these responses as permission to create another run UUID. Capabilities describe the configured surface, not current database health. A failed database owner is not automatically restarted.

`close(timeoutMs)` seals admission and stops accepting connections, waits for admitted HTTP operations (including configuration and model calls), then flushes telemetry before releasing its database session. Its timeout only bounds the caller's wait: `{status: "draining"}` means shutdown continues. Await `service.closed` or call `close` again; do not start a competing owner or discard in-flight results. Close does not cancel workflows, undo external effects, or install process-signal handlers. The embedding host must handle SIGTERM/SIGINT and await shutdown. A process forcibly killed before settlement can leave uncertain evidence. This service drain is separate from direct `PostgresRuntime.close()`, which still refuses active work.

HTTP TLS does not qualify database TLS, cluster ingress or multi-user authorization. The experimental single-owner service is not yet a managed Docker/Kubernetes deployment profile.

## Exact-release serving

Both SDK service hosts accept `release: { snapshot }`, where `snapshot` is the exact immutable `release.snapshot` returned by release creation/inspection. It is validated and cloned before opening storage, so later caller mutation cannot retarget the service. The CLI can select this mode explicitly:

```sh
node bin/jevable.mjs runtime serve --storage postgres \
  --database-file /private/jevable-database.json --token-file /private/jevable-http-token \
  --release-file reviewed-snapshot.json --release-sha256 <reviewed-release-hash>
```

The file contains the bare snapshot, not the `{snapshot, sha256}` receipt envelope. The hash is the inspected release's `sha256`, not the raw JSON file hash. Both flags are required together; malformed or mismatched snapshots fail before database ownership. For SQLite use `--data-dir` instead of PostgreSQL settings. Readiness and health include the pinned release. Startup, info, health and readiness checks do not run the workflow. Configure providers/credentials under an authorized management owner before serving; the release service exposes no authoring, test-editing, provider or credential mutations.

Use `ReleaseClient` from `@jevable/core/releases` with `(endpoint, token, reviewedReleaseHash)`. It automatically supplies `releaseSha256` on each operation and never retries mutations. CLI `runtime request` can also send release operations, but the JSON file must explicitly include that hash. The source-free `runs.start` body accepts a retained UUID, input and optional `paused`, not YAML or another snapshot. All retained-run reads, evidence, controls, cancellation and approvals verify the release ID, checksum and workflow revision. Wrong-release run IDs return `not-found`; reusing a run UUID for another release is a conflict, not permission to overwrite it.

Like `RuntimeClient`, the SDK release client accepts `client.operation(command, traceParent?)`. The optional strict W3C parent is sent as an operation header, separate from the immutable release guard; it is neither discovered from ambient context nor accepted as a body field. The server validates it after authentication/admission and retains it only through the selected telemetry behavior. Passing a parent does not enable telemetry, grant approval/send authority or authorize replay. Existing pinned app bundles do not gain this client behavior automatically.

For PostgreSQL, `runs.list` requires `page: {}` (default limit 100, maximum 200). It returns schema v2 with only matching run summaries and a matching run ID as `nextCursor`, or `null` at the end. Continue with `page.after`. A foreign or missing cursor returns `not-found`; no foreign run ID is exposed as a cursor. Internally the PostgreSQL reader holds the typed-domain gate while scanning verified bounded journal pages, up to the runtime run-capacity limit. This can scan unrelated retained runs; the returned page bound does not promise constant database work. Across requests, pagination is live keyset traversal, not a frozen snapshot. SQLite's unpaged release list retains schema v1; optional `page` selects v2 and uses the release ID/hash/revision index before loading selected payloads. SQLite explicit release pages also reject foreign/missing cursors. Owner startup still validates retained state; indexed paging does not bound startup work.

PostgreSQL release events/evidence retain exact decimal sequence/version identities and schema v2. The same admitted-request drain, owned telemetry flush, error mapping and explicit direct HTTPS policy apply. A timeout reports draining rather than killing admitted work. Database loss or uncertain commits require inspection of the original identity after an explicit owner replacement, never automatic redispatch.

A snapshot's claimed runtime checksum is not attestation of the running SDK bytes; the trusted embedding host must verify its selected code artifact. The separately [exported app launcher](releases.md#select-the-runtime-backend) verifies its actual pinned SQLite or PostgreSQL bundle before importing it. Neither SDK service testing nor ZIP execution alone qualifies containers. See the separate [PostgreSQL Docker profile](images.md#run-independently-with-postgresql) for exact-artifact database-TLS/loopback-HTTPS evidence; production database deployment and Kubernetes remain unqualified.

## Metadata pages and evidence versions

Management service capabilities expose `api.operations`: the actual storage backend, run-evidence schema version, journal sequence encoding and pagination policy. Exact-release services have a separate operation surface and do not advertise management pagination.

`runs.list`, `tests.list`, `tests.generations`, `projects.deletions`, `releases.list` and `providers.audit` accept an explicit `page` object. For example:

```json
{"operation":"runs.list","page":{"limit":100}}
```

The five record lists return `{schemaVersion:2, runs|tests|generations|deletions|releases, nextCursor}`. Supply the returned UUID as `page.after`; stop at `nextCursor: null`. `page.limit` defaults to 100 and must be an integer from 1 to 200. Records are ordered by ID, not creation time. Management record cursors do not need to identify a currently existing record; exact-release run cursors must belong to that release. Pages are live keyset reads, not a transaction-wide snapshot: concurrent edits or insertion before a cursor can change what a traversal observes. SQLite `runs.list` pages select IDs before decoding selected records; other SQLite record lists currently materialize their validated list before selecting a page, bounding the response rather than scan work. Existing SQLite requests without `page` retain their complete-array response and original order (legacy `releases.list` has no schemaVersion), subject to the service response-size limit. Release listings omit workflow source; `releases.show` returns the full immutable snapshot.

Provider audit pages return `{schemaVersion:2, sequenceEncoding, events, cursor}` in sequence order. Start with `page: {}` or `after: "0"`, then pass `cursor` as `after`. An empty page preserves the supplied cursor; a full page may require another read to discover the end. Audit cursors are canonical decimal strings, never JSON numbers. SQLite event sequences remain safe integers; PostgreSQL event sequences are exact decimal strings. Cursors are scoped to the same service store and operation, not portable bookmarks between databases.

The PostgreSQL service requires explicit `page` for these six operations: an old unpaged request is rejected, never silently treated as a complete first page. Its run events and evidence envelopes use schema version 2, preserving decimal BIGINT sequence/version identities; SQLite retains v1. PostgreSQL service startup is explicit through CLI or SDK, not a qualified cluster deployment.

## SDK

Import `startRuntimeService`, `RuntimeClient`, `RuntimeHttpError` and the `RuntimeOperation` type from `@jevable/core/http`. A trusted host starts a service with `{runtime: {dataDirectory}, token, actor, port?}`. Read the token from protected storage rather than embedding it in source. The host must authenticate its owner before selecting `actor`; every bearer-token holder has that owner's full management authority. This is not multi-user authentication or per-user attribution.

Create `new RuntimeClient(endpoint, token)` and call `capabilities()`, `health()` or `operation(command)`. The SDK accepts loopback HTTP or verified HTTPS, refuses redirects and bounds response size/time. `service.close(timeoutMs?)` stops new connections and waits for active requests; `service.closed` resolves after the data store closes. A timed-out close returns `draining` rather than terminating an active model call. A custom SDK model adapter that never resolves can keep drain pending indefinitely. Explicit cooperative cancellation is implemented; forced recovery is not.

## Explicit direct HTTPS

For an authorized network listener, provision a certificate chain valid for the selected public hostname/IP, its matching private key, and a separate bearer token. Jevable does not obtain certificates, configure DNS/firewalls or deploy ingress. The local integration tests generate temporary test-only certificates; do not use those as production credentials.

```sh
node bin/jevable.mjs runtime serve --token-file /private/service-token --data-dir /private/workflow-state --port 8443 --public-origin https://workflow.example.com:8443 --bind-address 127.0.0.1 --tls-cert-file /private/server-chain.pem --tls-key-file /private/server-key.pem
node bin/jevable.mjs runtime status --endpoint https://workflow.example.com:8443 --token-file /private/service-token
```

The example remains bound to loopback. Select a non-loopback IP or `0.0.0.0`/`::` only when network exposure is explicitly authorized. All four TLS flags and an explicit nonzero listening port are required; incomplete profiles fail without opening storage. `--public-origin` is one canonical HTTPS origin, without a path, query, credentials or trailing slash. It pins the exact accepted Host and optional Origin headers. Its port may differ from the internal listening port for explicit port mapping; the readiness receipt distinguishes both. Configuration does not prove that DNS, routing or port mapping works.

Certificates must cover that origin via subject alternative names and be currently valid; the key must match. Files must be bounded regular non-symlink files. On POSIX the private key must belong to the runtime user and have no group/other permissions (typically `0600`). Provision Kubernetes projected secrets into an appropriate owned file before use; direct projected-secret mounts have not been qualified. Keys, certificates, bearer tokens and CA settings are not automatically included in releases or images. Certificate/token rotation currently requires an orderly service restart.

TLS uses a minimum of TLS 1.2. Clients verify the certificate chain and hostname using Node's configured default CA trust; add `--ca-file /private/selected-ca.pem` to `status`/`request` for an explicit PEM trust bundle. Explicit CA trust replaces the default trust list for that client. It cannot be used with a plaintext endpoint, and invalid CA input never falls back to default trust. No insecure-skip-verification flag exists; client verification stays enabled even if `NODE_TLS_REJECT_UNAUTHORIZED=0` is set. Transport errors remain sanitized; inspect certificate validity/name/trust and retained operation state rather than disabling verification.

SDK equivalents: add `tls: {publicOrigin, bindAddress, certificateFile, privateKeyFile}` and a nonzero `port` to `startRuntimeService`. For custom trust use `new RuntimeClient(endpoint, token, timeoutMs, maxResponseBytes, {ca: pemText})` or `new ReleaseClient(endpoint, token, releaseSha256, timeoutMs, {ca: pemText})`.

This is direct TLS with a **single-owner bearer**, not tenant isolation, user roles, mTLS or a trusted-proxy authentication scheme. The token grants every exposed operation, including approval and private inspection. Do not distribute it as a run-only credential. Forwarded, X-Forwarded-* and X-Real-IP headers are rejected rather than used for identity; no TLS-terminating proxy profile is implemented. Preview plus TLS is rejected: browser sessions remain a separate loopback-only qualification gate. An [operator-provisioned host-loopback Docker release profile](images.md#serve-https-to-the-local-host) is separately qualified. Managed Docker authoring and Kubernetes deployment remain unfinished.

## Operations and review

All JSON endpoints require `Authorization: Bearer <token>`. Owner-only `GET /v1/capabilities` discovers the version; other requests also require the matching `X-Jevable-Protocol` header. `GET /v1/health` is read-only. `POST /v1/operations` accepts strict owner JSON commands. Optional management-only [reviewer](grants.md#opt-in-reviewer-http-and-cli) and [caller](grants.md#opt-in-caller-http-and-cli) routes use separate exact-scope grants and mandatory reviewed instance pins, with no owner discovery or access. The caller interface also offers [bounded metadata-only SSE](grants.md#caller-scoped-event-stream), distinct from JSON operations and owner watch. The SDK adds headers; never put tokens in URLs, CLI arguments, workflow definitions or preview HTML. Optional [live preview](live-preview.md) serves a public inert HTML shell at `/`, with source/data behind a separate project-scoped credential. Normal `runtime serve` does not enable that surface.

Clients may pin a discovered runtime instance with `RuntimeClient`'s `expectedInstanceId` option, which sends `X-Jevable-Instance`. The service advertises `api.instanceGuard: x-jevable-instance` and rejects a mismatched or duplicate guard before operation dispatch. This closes the inspect/restart/submit race for clients that require the guard; it is not a durable request receipt or permission to retry an uncertain action. Existing clients may omit it. Docker-selected CLI commands require this capability and pin it automatically; a fresh invocation can observe a cleanly restarted owner without replaying an existing run.

| Operations | Required identity and behavior |
| --- | --- |
| `validate`, `check` | `yaml`; offline validation uses default compiler limits, while `check` uses this runtime's actual compiler/model/credential policy; neither executes |
| `templates.list`, `templates.render`, `import.preview` | Same offline authoring semantics as the CLI; an AI template needs explicit model/provider selection |
| `projects.list`, `projects.show`, `projects.diff`, `projects.deletions` | Read stored projects, revision comparisons or deletion receipts |
| `projects.command` | `command` follows the SDK project command schema **without actor**; server injects its owner identity |
| `projects.delete` | Exact `id`, `expectedGeneration`, matching `confirmId`; archived-only and no linked runs |
| `projects.export`, `projects.import.inspect`, `projects.import` | JSON bundle transfer with reviewed generation/revision or inspected SHA-256; optional `tests: true` exports private definitions in v2, imported atomically as new local drafts; ZIP files remain a direct CLI/SDK operation |
| `releases.list`, `releases.show` | Immutable release metadata pages or full snapshot by `id`; no execution or packaging |
| `releases.create` | Retained UUID `id`, `projectId`, reviewed `expectedGeneration` and `revision`, unique `version`, `runtimeStorage: sqlite\|postgres`, and exact `runtime: {version,sha256}` matching the server distribution; actor is server-owned. No caller paths/code, ZIP/image build or deployment. Exact-release services reject this management operation |
| `runs.start` | Required caller-chosen UUID `id`, exact `yaml` and `input`; optional `paused: true` admits without node dispatch |
| `projects.run` | Required caller-chosen `runId`, project `id`, `expectedGeneration`, accepted `revision`, and `input`; optional `paused: true` |
| `tests.list`, `tests.show`, `tests.history` | Read saved cases; show/history include private definitions |
| `tests.command` | Create/edit/accept a case with exact review guards; actor supplied by the server |
| `tests.run`, `tests.result` | Accepted `{id,generation,sha256}` plus stable `runId`; inspect retained evidence without implicit approval or retry; `inspect: true` reveals expected/actual values |
| `tests.generate`, `tests.generation`, `tests.generations` | Schema-derived drafts committed atomically under a retained batch `id`, project `{id,generation,revision}` and optional `limit` (1–32, default 12); no provider calls, acceptance or execution. Full receipt is private; listing omits inputs. See [generation/retry semantics](testing.md#generate-candidate-drafts) |
| `runs.list`, `runs.show`, `runs.events` | No execution; receipts omit source/input/intermediate payloads, but completed output is returned |
| `runs.cancel` | Run `id` and retained `requestId`; durable owner-attributed request before cooperative abort, never external rollback. See [cancellation receipts and retry](cancellation.md) |
| `runs.inspect` | Explicit private inspection of the retained full run; not suitable for public sharing |
| `runs.export` | Run `id`; bounded read-only [evidence snapshot](evidence.md), including hashes/identities/journal metadata but no payloads or actors by default. Optional strict `includePrivate: true` includes full retained run/journal; response only, no server-side file write |
| `usage.report` | Explicit `selection` of run IDs/revisions; read-only [reported tokens and coverage](usage.md), no provider dispatch or billing estimate. Exact-release services enforce release membership for every selected run. |
| `approvals.list` | Required `page` (`after`, `limit`); metadata-only [live approval inbox](approvals.md). Follow the cursor even for an empty task page. No automatic decisions or expiry settlement; exact-release services restrict tasks/cursors to their release. |
| `runs.resume` | Only safe paused checkpoints; never redispatch an uncertain attempt |
| `runs.advance` | Run `id`, retained `requestId`, reviewed `expectedCheckpointSha256` and `mode: step\|continue\|pause`; server-owned actor, durable admission and no redispatch on identical retry. See [control semantics](control.md) |
| `approvals.show`, `approvals.decide` | Actual private review data; decision requires exact `id`, `attemptId` and allowed `action`, attributed to the server owner; optional `pauseAfter: true` prevents immediate downstream continuation |
| `providers.list`, `providers.set`, `providers.audit`, `credentials.status`, `credentials.set` | Same generation checks and protected-store behavior as the local SDK; values must be protected in transit/client memory and never logged |
| `telemetry.status`, `telemetry.flush` | Process-local trace exporter health and bounded flush; no implicit destination change or execution retry |

See [projects.md](projects.md), [testing.md](testing.md), [transfer.md](transfer.md) and [providers.md](providers.md) for command semantics. The shipped TypeScript `RuntimeOperation` union is the exact request contract. Clients cannot submit an `actor` override. Bearer possession is authority to mutate, not user permission to automatically approve a workflow: the skill must still obtain the relevant user decision.

## Lost responses and bounds

Optional startup-only [request-rate policy](rate-limits.md) adds shared instance-local token buckets with a separate bounded owner/scoped status/stop reserve. SDK hosts accept `rateLimits`; local foreground CLI and independently exported apps accept `--rate-limits-file`. Omission preserves the existing behavior. Rate refusals return `429`/`rate-limit` and numeric `Retry-After` before dispatch; clients never automatically retry. This does not provide distributed or account/provider quotas.

Choose and retain a run UUID **before** submitting execution. If the client disconnects or times out, server work may continue. Inspect that same ID, or resend the exact same start command with the same ID; never generate a replacement ID to overcome an uncertain response. A conflicting source/input/provenance is rejected. A saved `executing` attempt is uncertain and is not automatically dispatched again, including after restart.

Other mutations are not universally idempotent. Retain project/proposal identities and review guards; inspect after errors before deciding whether a retry is safe. A `response-limit` error can follow a committed mutation; it is not a rollback receipt. Approval retries can conflict after the first decision committed: inspect the saved run.

Defaults: 4 MB request body, 20 MB JSON response, 16 concurrent ordinary requests, 16 KB headers. One extra bounded shared control slot accepts `runs.show`, `runs.cancel`, or `runs.advance` with `mode: pause` when ordinary capacity is full; it does not admit new execution. SDK service options may explicitly adjust bounded body/response/concurrency policies. Invalid UTF-8, excessive nesting, duplicate sensitive headers, non-JSON/compressed requests, foreign Host/Origin, cross-site fetches and token query parameters are rejected. Errors do not echo credentials, workflow input, provider errors or raw request bodies. Store limits also apply. No CORS access is granted.

## Qualification boundary

The local JSON API has loopback integration tests for identity/security guards, bounded bodies, project review, approvals, credential audit, lost-response recovery and shutdown. The production-only package test launches the installed CLI server outside the source checkout, runs a workflow, retries its ID, drains with SIGTERM and reads the retained result from a fresh direct CLI process.

Direct HTTPS has local certificate/authority integration tests and independently installed CLI/extracted-release checks; see `qualification/tls.json` for exact evidence. These local checks do not establish public-network or cluster behavior; the separate `qualification/images.json` records actual host-loopback Docker HTTPS. Opt-in trace export and authenticated incoming trace context have separate [telemetry qualification](telemetry.md). Local cancellation is covered by owner/transport tests; forced termination and deployed cancellation are not. The optional preview shell and project-scoped API have protocol, controller-double and installed-package tests, not browser qualification. Neither mode serves arbitrary files. Proxy authentication, Docker-managed authoring, Kubernetes, distributed storage and full OTel observability remain unqualified. Browser preview qualification remains separate and must not bypass the existing browser-policy restriction.

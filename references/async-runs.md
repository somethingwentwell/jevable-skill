# Durable asynchronous run admission

For separately authenticated external messages, [stable released-workflow message admission](release-messages.md) provides a sender/release-scoped deterministic UUID. The separate opt-in [signed webhook adapter](webhooks.md) reuses this identity and the same HTTP async capacity/drain, without owner read/control/approval authority.

Use this when an application embedding the standalone core needs a durable run identity before execution finishes. Both `LocalRuntime` (`@jevable/core/runtime`) and `PostgresRuntime` (`@jevable/core/storage`) expose `runAsync`, `runProjectAsync` and `runReleaseAsync`. No server, desktop agent or in-memory work queue is required. PostgreSQL still requires its explicitly selected database; SQLite remains the Node-only default.

These are trusted owner SDK methods, not new delegated permissions. SDK hosts and explicit CLI service startup additionally offer bounded HTTP admission below. Direct synchronous submission interfaces remain available and need no persistent server.

## Submit and retain

Retain a stable run UUID before calling any method. Options are strict: `{id, paused?, triggerMode?}`. `id` is required; API entry requires explicit `triggerMode: 'api'` and a graph declaring that entry. Public options cannot inject project/release/test provenance, callbacks or actor authority.

```js
import { LocalRuntime } from '@jevable/core/runtime'

// yaml, input and runId are already reviewed; runId was saved before submission.
const owner = await LocalRuntime.open({ dataDirectory: './workflow-state' })
try {
  const admitted = await owner.runAsync(yaml, input, { id: runId })
  // Hand the identity to your application; retain this owner and completion promise.
  console.log({ id: admitted.run.id, observation: admitted.observation })
  const observed = await admitted.completion
  console.log({ id: observed.id, status: observed.state.status })
} finally {
  await owner.close()
}
```

Use `runProjectAsync(projectId, generation, reviewedRevision, input, options)` for an accepted project pin, or `runReleaseAsync(snapshot, input, options)` for an inspected immutable release. Release execution does not require the originating project store. Graph/input/provider admission and existing review guards apply before creation; asynchronous model readiness cannot consume a stale project review.

## Receipt meaning

The result is `{observation, run, completion}`:

- `created`: creation was durably saved and acknowledged. `run` is a detached snapshot of the initial safe checkpoint before the first node dispatch. Its `paused` status does **not** mean execution is still paused when your caller receives it. Only explicit `paused: true` requests a start-paused run.
- `retained`: an identical UUID/submission already exists. The snapshot and completion promise observe retained state without redispatch. They do not join another invocation's in-flight work. Existing reservation rules can instead return `busy`; inspect the same UUID rather than inventing a replacement.
- `completion`: the original invocation's execution/observation promise. It resolves to the recorded status or rejects with the original error. It may resolve to an approval wait, a paused checkpoint or retained uncertain intent, not necessarily a terminal workflow result. A rejected execution does not fabricate a terminal failure.

The SDK snapshot includes private workflow source, input and intermediate state. Do not serialize it as a public ingress receipt or include it in telemetry; use existing metadata projections for that purpose. A completion promise is an in-process handle, not an exportable protocol field.

## Lifetime, uncertainty and recovery

Keep the owner alive and observe completion. SDK close remains idle-only: it refuses `busy` while admitted work is active. Configuration rotation is protected by the existing lifecycle guards. Application/server adapters must track background completions and drain them before closing storage; returning admission does not transfer ownership to a queue or a second runtime. Cancellation, approval, pause and continuation remain separate explicit guarded operations.

Failure before acknowledged creation rejects admission. A write can commit even if its acknowledgement is lost: inspect the retained UUID; do not infer rollback or resubmit under a new ID. An acknowledged receipt is not an exactly-once provider guarantee. Process restart never automatically resumes work. A safe persisted checkpoint needs explicit reviewed continuation; an unsettled `executing` intent cannot be replayed to resolve uncertainty. Normal storage-owner/lock recovery rules still apply.

The original execution pipeline retains trace ancestry and node/journal evidence; retries create no new execution segment. Source SQLite tests include reopen, lost-acknowledgement, cancellation, explicit API entry and sampled/unsampled OTLP trace checks. PostgreSQL source checks use a journal/model double, not real SQL durability or interruption qualification. Independent installed-package, actual PostgreSQL, image/platform and production observability gates remain separate.

## Opt-in owner HTTP admission

Start a standalone SDK host with `asyncRuns: {maxConcurrentRuns: 1}` (integer 1–64). The SQLite `startRuntimeService` and PostgreSQL `startPostgresRuntimeService` use the same owned admission adapter; PostgreSQL still needs its independently provisioned database. Default hosts do not expose these routes. Preview hosts refuse this option. Exact-release hosts accept only their inspected immutable release pin. No desktop, harness, service discovery, scheduler or second storage owner is involved.

```js
import { startRuntimeService, AsyncRunClient } from '@jevable/core/http'

// token is independently provisioned, protected and never printed or placed in a URL.
const service = await startRuntimeService({
  runtime: { dataDirectory: './workflow-state' }, token, actor: 'application:owner',
  asyncRuns: { maxConcurrentRuns: 1 },
})
try {
  const client = new AsyncRunClient(service.url, token, service.instanceId)
  const admitted = await client.start({ kind: 'workflow', id: runId, yaml, input })
  console.log({ id: admitted.run.id, observation: admitted.observation })
  const observed = await client.show(runId) // One read; no automatic polling or execution.
  console.log({ id: observed.run.id, status: observed.run.status })
} finally {
  await service.close()
  await service.closed // A draining timeout is not final shutdown.
}
```

Use the explicitly selected verified-HTTPS endpoint/TLS configuration for authorized non-loopback listening; never disable certificate validation. The client requires a known instance UUID and an owner token. It performs no discovery, handshake, reconnect, retry or capability-driven replacement. Select a new owner explicitly after a clean replacement; old clients refuse before dispatch. Its optional settings are `{timeoutMs?, maxResponseBytes?, ca?, release?}`. Requests are admitted as bounded strict JSON (4 MB, depth 64); no callbacks, actor overrides, arbitrary runtime options or credentials belong in them.

| Request | Contract |
| --- | --- |
| `POST /v1/async-runs` | `{kind: 'workflow', id, yaml, input, paused?, triggerMode?}`; or `{kind: 'project', id, project: {id, generation, revision}, input, paused?, triggerMode?}`; or `{kind: 'release', id, release: {id, sha256, revision}, input, paused?, triggerMode?}`. Project/release pins are reviewed, not guessed. |
| New creation | `202`, exact relative `Location: /v1/async-runs/{id}`, `observation: 'created'`; only after durable creation acknowledgement, before completion. |
| Identical retained UUID | `200`, same Location, `observation: 'retained'`; no redispatch or attachment to another invocation's completion. Conflicts/active reservation rules can refuse instead. |
| `GET /v1/async-runs/{id}` | `200`, `observation: 'read'`, recorded metadata only; no execution or caller trace-parent adoption. |

Every request requires bearer owner authentication, the current `X-Jevable-Protocol` and mandatory `X-Jevable-Instance`. Existing Host/Origin/proxy/media/body/connection/admission protections still apply. Delegated caller/reviewer grants do not authenticate these routes. An exact-release status read also requires `X-Jevable-Release-Sha256`; construct `AsyncRunClient` with the reviewed `release: {id, sha256, revision}` so reads carry the hash and all responses are scope-checked. Foreign run reads are unavailable; uploaded release source cannot widen the service.

Receipts are strict `{format: 'jevable.ai/async-run', schemaVersion: 1, instanceId, observation, run}`. Run metadata contains ID, revision, recorded status/timestamps and applicable project/release/test pins, API mode or original start-paused flag. It excludes source, input/output, actors, node state, trace context and completion promises. These are authenticated owner observations, not signed portable proof or provider exactly-once guarantees. The creation snapshot normally says `paused` even if execution has already advanced; only explicit `paused: true` requests a retained paused start.

Capacity reserves pending admission as well as post-response execution. Excess starts return `429 async-concurrency-limit`, without an in-memory queue; normal read/control capacity remains separate. Shutdown seals admission and drains original completion promises before releasing storage and telemetry. A lost HTTP response never cancels work. A failed completion may leave uncertain `executing` intent rather than a fabricated failure. Status reads and same-ID retries only observe; explicit existing guarded controls remain separate. Save the UUID before submission and inspect it after timeout, malformed response or lost commit acknowledgement; never create another ID to resolve uncertainty.

When HTTP request instrumentation is explicitly enabled, the `202` request span can end before its child run span. Start propagation remains authenticated; read-only status never adopts a supplied execution parent. Metrics use `/v1/async-runs` and `/v1/async-runs/{id}` templates, never run-ID labels. Source tests cover sampled/unsampled instrumentation, private loopback wire export, lost creation acknowledgement, disconnect/drain, stale instances and exact-release narrowing. This is not renewed real PostgreSQL/installed-image/production Collector/browser qualification; those gates remain open.

For capacity observation, `httpRequests: true` plus an explicit `metricsEndpoint` also exports `jevable.http.async.slots` with fixed `admitting|completing` phase labels. It tracks this service's held slots through pending admission and original completion, not queued jobs, unique runs or distributed workers. Approval waits/paused runs stop occupying a slot when their invocation settles. See [HTTP telemetry](telemetry.md#optional-http-request-observations) for sampling, reset and availability limits; this never changes the concurrency policy or authorizes execution.

## Explicit CLI submission and observation

Start a foreground owner only when a service is requested:

```sh
node bin/jevable.mjs runtime serve --token-file /private/service-token \
  --data-dir /private/workflow-state --async-concurrency 2
```

`runtime start --runtime local` accepts the same option. Omission keeps async routes disabled. PostgreSQL service startup accepts it with the existing explicitly selected private database configuration; the launcher never provisions a database or falls back. Existing runtime TLS/notification/telemetry/release startup guards apply. Stop normally and await the final `closed` receipt; a drain timeout does not permit replacing an active owner.

### Docker-owned service

Add `--async-concurrency 2` to the reviewed [Docker startup command](docker-owner.md#optional-asynchronous-run-admission). The SDK equivalent is `startDockerOwner({...options, asyncRuns: {maxConcurrentRuns: 2}})`. The private owner record pins this bounded policy; the exact container command, advertised owner-only/no-replay metadata contract and bounded health count must match it. Inspection and clean restart do not accept policy overrides. Omitted older owners remain async-disabled and accept either absent or false async capability metadata. This works for SQLite or an independently provisioned TLS PostgreSQL database; it adds no skill, harness or desktop dependency to the container.

After explicit startup and authenticated inspection, use `runtime submit` / `runtime observe` below with the reviewed HTTPS endpoint, current instance and trusted `--ca-file`. These transport commands do not take `--runtime docker` or discover/launch a container. Normal exact-container SIGTERM stop drains the service's original completion promises; `draining` is not stopped. Restart does not resume retained work. Source command-double coverage is separate from actual container/database/interruption qualification of the updated image.

Save a strict `retained-start.json` before submitting. Use one of the workflow/project/release contracts in the table above, a pre-retained UUID, reviewed source/pins and input. The CLI never creates a replacement run ID, refreshes a project generation or turns a failed request into a synchronous run. A raw source JSON string is just the file transport: the output remains a real runnable workflow, not a YAML/HTML-only artifact.

```sh
node bin/jevable.mjs runtime submit retained-start.json \
  --endpoint http://127.0.0.1:4331 --token-file /private/service-token \
  --instance-id <reviewed-ready-instance-uuid> --json

node bin/jevable.mjs runtime observe <retained-run-uuid> \
  --endpoint http://127.0.0.1:4331 --token-file /private/service-token \
  --instance-id <same-reviewed-instance-uuid> --json
```

Use the actual readiness URL and instance, not the illustrative port. Both commands require these three flags before file/credential access. They make one explicitly selected HTTP call, with no health/capability handshake, automatic polling, retry, local owner, service startup, Docker/desktop discovery or fallback. Optional `--timeout-ms` is canonical decimal 1–3600000, default 30000; `--ca-file` applies only to verified HTTPS. Submit accepts an explicit private `--trace-context-file`; observe refuses it and never adopts an execution parent. Exit 0 means admission/read success even for paused, waiting or uncertain recorded metadata—not workflow completion, human approval or external rollback.

For an exact-release service, add `--release-pin-file reviewed-release.json` containing `{id, sha256, revision}` to both commands. Request and pin are checked before credentials; source/project requests cannot use this narrowed profile. Reads without the hash are refused. A wrong/stale instance is never adopted from discovery. After a clean replacement, independently review the new instance and inspect the original run UUID. Retrying the original file can only observe compatible retained intent; it does not redispatch.

`runtime submit --help --json` exposes deterministic `inputContracts` for `async-run-start` and `async-release-pin`; `runtime observe` exposes the pin, and `runtime serve/start` exposes `async-run-policy`. Each uses the actual consuming structural validator and a schema SHA-256. These are context-specific help contracts, not extra IDs in general `schemas list`. Structural success does not prove compilation, provider readiness, permission or current review/ownership. Text help links this guide; neither form opens input files, credentials, storage or a service.

### Exported workflow app

The generated Node-only app has its own `submit <retained-start.json>` and `observe <run-uuid>`. They use the reviewed endpoint, instance UUID and protected token but supply the app's inspected release/hash/revision scope internally—no authoring YAML, arbitrary release pin file, local state/database configuration or management fallback. The submitted file must still be `kind: 'release'` with that exact pin and the retained run ID/input. These transport commands never open the app's storage, including on a PostgreSQL app.

```sh
node app.mjs serve --token-file /private/app-token --async-concurrency 2
node app.mjs submit retained-start.json --endpoint <ready-origin> \
  --token-file /private/app-token --instance-id <reviewed-ready-instance-uuid>
node app.mjs observe <retained-run-uuid> --endpoint <same-origin> \
  --token-file /private/app-token --instance-id <same-reviewed-instance-uuid>
```

App startup still needs its normal persistent storage configuration (PostgreSQL requires the protected database file) and owns the same sealed completion drain. Info/README command references report available flags; no persistent host daemon, agent skill, desktop, Docker or npm install is required by the extracted SQLite workflow app. Docker/Kubernetes still run the **Jevable workflow runtime**, not a skill runtime. Source adapter/grammar tests are not independently built-app, real PostgreSQL, container, interruption or production observability acceptance; retain those gates separately.

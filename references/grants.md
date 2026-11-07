# Delegated grant administration

The standalone **owner-administered grant ledger** is available in SQLite and PostgreSQL. Experimental SDK methods and separate opt-in management HTTP/CLI paths support pinned-release caller starts, isolated result reads, own-run opaque checkpoint/control, cancellation and exact-attempt reviewer decisions. Grant tokens are refused on owner and preview routes; an exact-release host can explicitly enable its distinct reviewer-only routes. Do not share an owner bearer as a substitute for caller/reviewer access. Availability is not independently installed or deployed qualification; inspect the exact build/profile evidence separately.

## Prepare, review and issue

Prepare a token offline with a caller-retained fresh UUID:

```sh
node bin/jevable.mjs grants token --id <retained-grant-uuid> --output <new-private-token-file>
```

The command creates a private regular file without overwriting existing files or following an existing output symlink. It prints the grant ID, token digest and path, never the bearer. Preparation opens no runtime and issues no grant. Privately retain this file **before** issuance: the runtime stores only its domain-separated digest and cannot recover the token. Retrying preparation generates a different token; it is not issuance recovery. Never put the bearer in arguments, workflow source, a URL, a request body or shared logs.

Review a bounded JSON command with these fields: `id`, `tokenSha256` from preparation, `expiresAt` (a future ISO UTC date/time) and `scope`. Do not include `actor` or `token`.

| Scope | Required pins | Explicit permissions |
| --- | --- | --- |
| `kind: caller` | `release: {id, sha256, revision}` for one retained immutable release | Nonempty unique `permissions` subset of `start`, `read`, `control`, `cancel` |
| `kind: reviewer` | `runId`, `attemptId`, `revision` for the current non-cancelled, unexpired approval wait | Nonempty unique `decisions` subset of that node's named actions, up to 200 |

Callers use `start`, `read`, `control` and `cancel` independently; `control` permits own-run checkpoint inspection and guarded control, not output reads. Reviewer SDK actions are separately limited to the grant's exact approval attempt and decision subset. There is no wildcard scope, owner role, arbitrary source replacement or approval permission for callers. Issuance checks the actual retained release or current approval attempt and appends audit history without running, deciding, cancelling or notifying anything. A reviewer grant may have a longer expiry than the wait; it cannot extend that wait, and action admission rechecks its exact current state.

```sh
node bin/jevable.mjs grants issue <reviewed-command.json> --data-dir <private-state>
node bin/jevable.mjs grants show <grant-id> --data-dir <private-state>
node bin/jevable.mjs grants list --page --limit 100 --data-dir <private-state>
```

Lists require an explicit page on both backends. Follow `nextCursor` with `--after`; UUID order is not chronological order. Pages are live, not snapshots. Start a fresh traversal to observe insertions before a previous cursor. Metadata omits both the bearer and digest, reports its observation time, and distinguishes active, expired and revoked records. Expiry does not fabricate a revocation event.

After an uncertain issuance response, inspect the retained ID or retry the **identical** command. The same ID, digest, issuer, scope and expiry return the original metadata—even after expiry, revocation or approval settlement. They never regrant, rotate or extend access. Changed retries refuse with conflict. A new grant requires separate owner authorization, a new ID and separately retained token.

## Revoke

Retain a fresh revocation request UUID before dispatch:

```sh
node bin/jevable.mjs grants revoke <grant-id> --request-id <retained-request-uuid> --expected-generation 1 --data-dir <private-state>
```

Revocation atomically advances generation one to two and appends its actor/time/history. The identical request observes generation two on retry; changed request identity or actor conflicts. Revocation does not cancel a run, undo external effects or retract already admitted work. Unavailable storage or an uncertain commit is not proof of revocation: inspect/retry the retained request against the same owner; do not promise successful revocation from a timeout.

## Selected owner, API and SDK

Administrative commands support the existing [selected owner](remote.md) options: direct private SQLite state, explicitly configured PostgreSQL, an explicit HTTPS management endpoint, or a reviewed Docker management owner. Selection never starts a replacement owner or falls back to another installation. The service fixes the issuer/revoker actor; request bodies cannot override it. Local CLI attribution is the operating-system user label, not multi-user identity authentication.

Strict management operations are:

- `grants.issue` with `command` containing the reviewed fields above.
- `grants.show` with `id`.
- `grants.list` with `page: {limit, after?}`.
- `grants.revoke` with `command: {id, requestId, expectedGeneration: 1}`.

The trusted owner SDK exposes `prepareGrantToken` from `@jevable/core/runtime` (also `@jevable/core/storage`), and runtime `issueGrant`, `grant`, `grants`, `revokeGrant`. SDK actor labels are explicitly supplied owner audit data, not authorization or impersonation-resistant human identity. SDK imports do not start a server. Grant stores, internal principal lookup and mutation guards are not public caller APIs.

Records and immutable issuance/revocation history live only in the selected owner's storage. Project transfer, duplication and runnable release exports do not carry grant authority, tokens or digests. A destination installation issues its own grants with its own reviewed records and private token delivery. Database audit hashes detect inconsistent history, not malicious rewriting by a privileged database administrator.

## Direct SDK caller integration

On an already opened `LocalRuntime` or `PostgresRuntime`, call `startWithGrant(token, input, {id, paused?, triggerMode?})` with a privately retained opaque token and a caller-retained run UUID. The runtime resolves the release from the authenticated grant; options cannot supply YAML, a release override, actor, project, test, ownership or authority. It rechecks the actual grant and retained release in creation admission after asynchronous provider admission. SQLite checks inside its creation transaction; PostgreSQL pins the verified grant/release versions and canonical snapshots under its domain queue, then rechecks those pins and the grant deadline inside the journal commit after acquiring the namespace lock. Creation snapshot and event atomically retain the immutable grant ID, derived `grant:<id>` actor, admitted time and exact original scope. Historical replay/reopen verifies that binding against retained issuance/revocation evidence; expiry/revocation do not erase admitted history.

The start response is metadata only: run ID, revision, release pin, timestamps and recorded status. It excludes output even when the grant also permits reads. `readWithGrant(token, runId)` requires explicit `read`, selects only this grant's exact-release run before loading private payloads, verifies retained execution evidence and rechecks authorization after asynchronous reads. It adds completed workflow output only—not input, YAML, steps, wait details, reviewer identity, model/provider evidence or credentials. A workflow author still controls what the final output contains; this is not secret redaction inside deliberately published output.

Same-ID/same-input/options start retries observe the retained checkpoint without resuming or redispatching. Changed retries conflict; owner and other-grant IDs are not adopted. Unknown and foreign IDs return the same scoped not-found result. Expired/revoked credentials cannot retry or read; privileged owner inspection remains the recovery path. After a lost response retain the UUID and original options. Do not invent a new UUID to bypass uncertainty. Revocation does not cancel or retract work admitted before it.

These methods are an experimental integration boundary inside a trusted SDK host, not a sandbox against code that already holds the privileged runtime object. Keep owner methods inaccessible to untrusted clients. There is no bearer discovery, desktop attachment or SDK server prerequisite. PostgreSQL requires an explicitly configured database; it never substitutes SQLite or another application's service. Independently installed package, SQL, image and deployment qualification must be recorded for each exact build.

## Direct SDK caller controls

On an already opened trusted `LocalRuntime` or `PostgresRuntime`, use `controlCheckpointWithGrant(token, runId)` to inspect metadata and the opaque `checkpointSha256`, then `advanceWithGrant(token, runId, request)` for an explicitly authorized control. Only the creating caller grant with explicit `control` permission can act, even if another grant pins the same release. Neither operation implies output/read, cancellation, reviewer, owner or source-replacement authority. Unknown/foreign runs and insufficient permissions are scoped not-found results before loading private payloads or invoking a trusted context.

```ts
// Obtain token from protected host storage; retain the exact request before dispatch.
const checkpoint = await runtime.controlCheckpointWithGrant(token, retainedRunUuid)
const request = {
  requestId: retainedControlUuid,
  expectedCheckpointSha256: checkpoint.checkpointSha256,
  mode: 'step' as const,
}
const receipt = await runtime.advanceWithGrant(token, retainedRunUuid, request)
// After response loss, an explicit identical retry observes only; it never executes again.
```

Inspect the structural request with `schemas show caller-control`. Its strict fields are `requestId`, `expectedCheckpointSha256`, `mode` and optional `breakpoints`. UUIDs are canonicalized to lower case; the parsed command and context's reviewed release pin are isolated from caller mutation. Actor, grant, scope, time, deadline, trace parent and private payloads are not request fields. Checkpoint/receipt projections contain run/release/revision pins, timestamps, recorded status and an opaque checkpoint hash; the control receipt adds request UUID, mode and admitted time. They do not contain YAML, input, output, steps, node/attempt details, breakpoint lists or private attribution. A hash is a concurrency guard, not authority or proof of a live worker.

| Mode | Required recorded state | Effect after fresh guarded admission |
| --- | --- | --- |
| `step` | Paused, exact checkpoint, no cancellation | Execute at most one node; can enter an approval wait or finish |
| `continue` | Paused, exact checkpoint, no cancellation | Execute until a breakpoint, cooperative pause, approval wait or terminal result |
| `pause` | Paused or executing, exact checkpoint, no cancellation | Retain a cooperative stop request; an active node may finish before a safe pause |
| `recover` | Inactive executing model checkpoint, exact checkpoint, no cancellation | Verify an already committed model response and settle that node only; never call the provider or execute downstream nodes |

Step/Continue can supply graph-valid `breakpoints`: omission retains the list, `[]` clears it. Retain omission versus an explicit list exactly on retry. Pause/Recover refuse breakpoint changes. A new Step/Continue/Recover while a worker is active refuses as busy, but the original admitted UUID can still be observed and a fresh guarded Pause can be admitted. Pause does not abort, settle uncertain work, imply cancellation or prove provider termination. No control crosses an approval wait or makes a decision; explicit reviewer authority remains separate. Recovery refuses missing/uncertain responses, non-model intent and active workers. A newly inspected/authorized continuation is required to execute downstream after recovery.

The optional trusted `CallerContext<CallerControlCheckpoint>` or `CallerContext<CallerControlReceipt>` receives a cloned release pin only after scoped authentication. The runtime reauthenticates after awaited context, provider admission and retained-response reads. SQLite atomically checks the actual grant/run, legal phase/hash and expiry immediately before mutation. PostgreSQL pins exact verified grant/run bytes, versions, admitted time and deadline in the journal transaction; the control request UUID is its admission batch UUID. Private writer-derived grant/scope/actor/deadline metadata and event history are replay-checked against retained creation and grant history, not accepted from the caller.

An identical retained command freshly authenticates and **only observes** its receipt/current checkpoint—even after the original work completed, an active worker is busy, or a successful admission response was lost. It writes no new event and never resumes, re-pauses, recovers or dispatches. Changed mode/hash/breakpoints or an owner-origin request UUID conflicts; a matching actor label is not delegated authority. Lost admission acknowledgment can leave a saved control pending with no execution across reopen. Do not mint a replacement UUID to bypass uncertainty. Use privileged inspection and a separately authorized fresh guarded operation when recovery is actually needed. Revoked/expired credentials cannot inspect/retry/admit, though work admitted earlier may settle; revocation cannot retract external effects.

These controls are an experimental trusted-host SDK boundary, not a sandbox against code holding the owner object. They start no listener, need no Docker/Jarness, and never call owner `advance` as a fallback. The separate opt-in management transport below routes to these same guarded methods. Source SQLite cases use actual private storage; PostgreSQL source cases use journal/model doubles. Installed/actual PostgreSQL, received-signal, fault/replacement, image and deployment qualification remain explicit build/profile gates.

## Direct SDK caller cancellation

On a trusted, already opened `LocalRuntime` or `PostgresRuntime`, use `cancelWithGrant(token, runId, {requestId})`. Retain a fresh cancellation request UUID before dispatch. The strict request cannot provide actor, attribution, time, grant, release, scope or owner authority. Only the same caller grant that created the run can cancel it; that grant must explicitly include `cancel`. Permission to cancel does not imply permission to read output, control execution or approve an attempt. Owner runs and another grant's runs remain unavailable even when they use the same release.

SQLite freshly authenticates and checks the actual scoped run inside its writer transaction, then checks again immediately before writing. PostgreSQL binds the exact grant and run snapshots/versions, admitted time and expiry to the atomic journal commit; the action UUID is also the journal batch UUID. Saved private cancellation attribution contains the derived grant actor, original scope and deadline. Shared replay/reopen verifies it against retained creation and grant history. Tokens and digests never enter run evidence; default export excludes attribution, while explicitly private export includes it.

The metadata-only receipt gives run/release/revision pins, observed status, `requestId`, `requestedAt` and a warning that external effects are not reverted. A fresh admitted request signals this owner's active worker; it may still report `executing` until that worker settles. An inactive paused/waiting run can settle immediately. Neither request acceptance nor an abort signal proves that a provider stopped or that external effects were undone.

An identical retry freshly authenticates but **only observes** the saved cancellation: no repeated abort, settlement, model dispatch or evidence event. If the admission committed but its response was lost, the receipt can remain pending (`paused`, `waiting` or `executing`) across reopen. Inspect it with the privileged owner; an explicitly authorized owner recovery may settle it, but caller retry must not. Do not create a new UUID to bypass uncertainty. A changed request or an owner-origin cancellation conflicts; a matching actor string alone does not make an owner cancellation delegated. Revoked/expired grants cannot cancel or inspect retry receipts, though already admitted worker settlement can finish.

The optional trusted `CallerContext<CallerCancellationReceipt>` receives a cloned release pin after permission/ownership authentication. Admission reauthenticates after an awaited hook. The hook is observation/propagation plumbing, not caller-supplied authority. The opt-in management caller transport below exposes the same guarded operation, not an owner cancellation wrapper; preview and exact-release routes still refuse delegated access. Local SDK cancellation starts no listener and needs no Docker or Jarness; PostgreSQL uses only the independently configured database. Qualify actual installed/storage/model/telemetry/deployment profiles separately.

When telemetry is configured, first admission also retains its explicit trace context, if any, alongside the cancellation request in that guarded write. Active settlement preserves worker ancestry and adds a separate cause referencing the original request UUID/context. Default evidence exposes correlation but excludes grant attribution. Caller input cannot supply `traceParent` or `cause`, and identical retries—even with a new incoming parent—never replace retained context, reabort or reconstruct execution signals. Missing historical context stays missing. See [cancellation causality](telemetry.md#cancellation-admission-and-later-settlement) for metadata, compatibility and delivery limits.

## Opt-in caller HTTP and CLI

Management services may explicitly enable `callerOperations: true` in either service SDK or `--caller-operations` on local `runtime serve`/`runtime start`. Disabled by default; preview and exact-release modes refuse before opening state. Managed Docker startup does not expose this option yet. The service owns independent Jevable configuration, state and credentials; it does not attach to Jarness. Direct SDK caller methods still require no listener or Docker.

Privately retain a start JSON file containing only `input` and `options: {id, paused?, triggerMode?}`. `id` is the original caller-retained run UUID; `triggerMode`, if present, is `api`. Separately review a release-pin JSON containing exactly `{id, sha256, revision}` from the issued caller grant. It confirms the intended release; it cannot retarget grant authority.

```sh
node bin/jevable.mjs caller start <retained-start.json> \
  --endpoint <reviewed-https-origin> --instance-id <reviewed-service-uuid> \
  --release-pin-file <reviewed-release-pin.json> --token-file <private-caller-token>
node bin/jevable.mjs caller read <retained-run-uuid> \
  --endpoint <reviewed-https-origin> --instance-id <reviewed-service-uuid> \
  --release-pin-file <reviewed-release-pin.json> --token-file <private-caller-token>
node bin/jevable.mjs caller cancel <retained-run-uuid> --request-file <retained-cancellation.json> \
  --endpoint <reviewed-https-origin> --instance-id <reviewed-service-uuid> \
  --release-pin-file <reviewed-release-pin.json> --token-file <private-caller-token>
node bin/jevable.mjs caller checkpoint <retained-run-uuid> \
  --endpoint <reviewed-https-origin> --instance-id <reviewed-service-uuid> \
  --release-pin-file <reviewed-release-pin.json> --token-file <private-caller-token>
node bin/jevable.mjs caller control <retained-run-uuid> --request-file <retained-control.json> \
  --endpoint <reviewed-https-origin> --instance-id <reviewed-service-uuid> \
  --release-pin-file <reviewed-release-pin.json> --token-file <private-caller-token>
```

Optional `--ca-file` adds verified custom HTTPS trust; normal system trust or private `http://127.0.0.1:<port>` also work. `--timeout-ms` bounds the client wait, not server execution. Receive the instance and release pins through a trusted operator, not caller discovery. No owner bearer, storage/Docker selector, redirect, automatic retry, fallback or service replacement participates. CLI success means accepted/observed operation, not successful workflow completion. Start returns metadata only; read adds only this grant's own completed workflow output. Output is deliberately published workflow data, not automatically redacted.

`POST /v1/caller/operations` requires grant `Authorization`, current `X-Jevable-Protocol` and exact `X-Jevable-Instance`. Strict bodies are `{operation: "start", release, input, options}`, `{operation: "read", release, id}`, `{operation: "cancel", release, id, request: {requestId}}`, `{operation: "checkpoint", release, id}` or `{operation: "control", release, id, request}`. The control `request` is the exact [SDK control command](#direct-sdk-caller-controls), never an owner operation. Request/response limits, origin/proxy guards and draining/capacity policy apply; callers, including checkpoint/control/cancellation, cannot take the owner-reserved slot. If ordinary capacity is full, they receive 429 rather than privileged admission. The host authenticates the exact permission and run ownership, compares the reviewed release pin **before execution**, then adopts optional W3C parent context. SDK admission freshly rechecks authority after an awaited trusted hook. Neither pins nor telemetry headers are authority. Health, capabilities and owner/reviewer operations are unavailable to caller tokens.

`CallerClient` from `@jevable/core/http` takes `(endpoint, token, instanceId, releasePin, timeoutMs?, maxResponseBytes?, {ca}?)` and exposes `start({input, options}, traceParent?)`, `read(runId, traceParent?)`, `checkpoint(runId, traceParent?)`, `control(runId, request, traceParent?)` and `cancel(runId, {requestId}, traceParent?)`. It bounds JSON data, checks strict metadata/output/checkpoint/control/cancellation schemas and exact run/instance/release/revision response pins, and never retries itself. Control additionally checks exact request UUID/mode, an opaque checkpoint hash and ordered timestamps; cancellation checks request UUID/timestamps and the external-effect warning. Neither receipt permits private attribution, input, output or extra fields. An uncertain start retains its original UUID, input and options; an explicit identical retry observes retained state without resuming. Revoked/expired tokens cannot start, cancel, control, inspect, retry or read. Owner inspection remains the recovery path. Scoped source/wire checks are not actual SQL, received-signal, independently deployed TLS/image/browser/production qualification; record each exact build/profile separately.

The control JSON file contains only `requestId`, `expectedCheckpointSha256`, `mode` (`step`, `continue`, `pause` or `recover`) and optional `breakpoints`, and is limited to 16384 bytes in this CLI/client profile. Inspect an opaque checkpoint, authorize the exact intended action and privately retain its command UUID before dispatch; the CLI never generates one. File structure, run UUID and reviewed release pin are validated before opening the protected token or contacting the host. New work needs a fresh exact checkpoint; an identical retained retry ignores later checkpoint movement and only observes its saved receipt/current state. A control UUID cannot adopt an owner request. Pause is cooperative and never an abort; recovery settles one already saved response without provider/downstream work. None crosses an approval wait or supplies output/read/cancel/reviewer/owner permission. After timeout or response loss, keep the exact command and use explicit same-ID observation; never switch to owner `runs` commands, refresh its guard or mint a replacement to bypass uncertainty.

The cancellation JSON file contains exactly `{"requestId":"<retained-cancellation-uuid>"}` and is limited to 4096 bytes. The CLI validates that file, run UUID and reviewed release pin before opening the protected token or contacting the host; it never generates a replacement UUID. Explicit `cancel` permission and the creating grant are required independently of `read`. Acceptance may report a still-pending status; neither CLI exit zero nor an HTTP 200 proves termination or external rollback. Identical retries only observe the retained request, including after response loss or replacement; they never reabort, settle or resume. Use the [SDK cancellation contract](#direct-sdk-caller-cancellation) for recovery semantics.

## Caller-scoped event stream

`caller stream` and `CallerClient.stream` observe one already retained caller-owned run through a bounded POST SSE connection. Enable the existing management-only `callerOperations: true` / `--caller-operations` explicitly; preview and exact-release hosts cannot enable it. The creating grant must still have `read` permission, including on every unchanged-state read. Owner, reviewer, foreign caller, read-only noncreating and revoked/expired grants cannot substitute. No Jarness/desktop service, source checkout, storage fallback or persistent server is needed for ordinary direct SDK/CLI execution; this optional transport requires the explicitly selected running management service.

```sh
node bin/jevable.mjs caller stream <retained-run-uuid> \
  --endpoint <reviewed-https-origin> --instance-id <reviewed-service-uuid> \
  --release-pin-file <reviewed-release-pin.json> --token-file <private-caller-token> \
  --interval-ms 1000 --duration-ms 15000
```

The CLI outputs NDJSON, not raw SSE. Snapshots contain only run/revision/release identity, created/updated times and status, with a pinned instance and connection-local `sequence`. They never contain completed output, private input/source/steps, actors, grant IDs, provider data or bearer values. `caller read` remains the separately explicit completed-output read. Sequence numbers detect gaps/substitution within one connection; they are not durable journal/event cursors or replay receipts.

The SDK async generator is `client.stream(runId, {intervalMs?, durationMs?, follow?, signal?})`. Poll intervals range from 100 to 60000 ms (default 1000); connection duration ranges from 1 to 60000 ms (default 15000). Waiting/paused stops with `attention` unless `follow: true`; follow only observes, never resumes or approves. Terminal snapshots stop with their retained status. Unchanged authorized reads send fixed heartbeat comments instead of duplicate snapshots. A deadline ends observation, not execution. The client's separately configured timeout bounds its whole connection (default 30000 ms); explicitly set it above the desired duration for longer streams. Cancelling the AbortSignal or returning early closes only this connection. There is no automatic reconnect, redirect, fallback or retry. After an incomplete response, the run's outcome is unknown to this observer; inspect its retained identity with authorized reads instead of starting or resuming anything.

`POST /v1/caller/stream` requires `Accept: text/event-stream`, JSON `Content-Type`, grant bearer authorization, current protocol and exact instance headers. The strict body is `{id, release: {id, sha256, revision}, intervalMs?, durationMs?, follow?}` (4096-byte maximum). `Last-Event-ID`, query strings, unknown body fields, foreign Host/Origin and proxy headers are refused. The route never adopts supplied trace context or reconstructs workflow telemetry. Initial read refusal stays a JSON HTTP error; refusal after a snapshot emits metadata-only `stopped` with `read-refused`. Service drain closes observation before releasing storage; an interrupted frame may yield an incomplete-stream error instead of a final receipt. Both are observation outcomes, not cancellation.

One stream occupies ordinary request capacity, never the reserved owner-control slot. It keeps at most one outgoing frame pending, bounds total bytes, and closes a consumer whose frame write stalls for five seconds. Server shutdown stops streams without force-killing workers, replaying models or changing run journals. The SDK bounds response/frame/event sizes, validates UTF-8, strict metadata and run/release/instance/sequence identity, and refuses SSE reconnect directives. This is current-state observation over SSE, not a durable async worker/job queue, 202/Location admission, coordinated per-grant rate limiting, browser EventSource, signed webhook ingress or full deployment qualification.

CLI stop codes: completed `0`, attention `3`, failed `4`, cancelled `7`, deadline `8`, draining/read-refused `9`, SIGINT `130`, SIGTERM `143`. Transport/protocol/incomplete failures retain the normal CLI error result. An exit code never proves external-effect rollback or provider/backend delivery.

## Direct SDK reviewer integration

On an already opened trusted `LocalRuntime` or `PostgresRuntime`, use `decideWithGrant(token, {requestId, action, pauseAfter?})`. Privately retain a fresh decision request UUID **before** dispatch. The strict request accepts one valid named approval action and an optional boolean; that action must exist in both the live node and this exact grant. It cannot override actor, run, revision, attempt, scope, source or authorization. The token supplies those exact pins. Caller and owner tokens do not substitute for reviewer authority. Opening an SDK imports no desktop and starts no HTTP server; the local SQLite path needs no Docker.

```ts
// token comes from the host's protected credential store, never from a URL or command argument.
// Keep this request unchanged if its response is lost.
const request = { requestId: retainedRequestUuid, action: 'approve' as const, pauseAfter: true }
const receipt = await runtime.decideWithGrant(token, request)
```

The runtime authenticates the reviewer/action before loading a private run, verifies retained execution and grant history, and rechecks authorization after asynchronous reads/provider admission. SQLite checks the actual grant and wait inside the decision writer transaction and again immediately before mutation. PostgreSQL pins verified grant/run versions and canonical snapshots, then forwards mandatory conditions to the atomic journal commit. Its checkpoint writer requires those grant/run pins and the exact admitted time/deadline; the retained decision UUID must match its journal batch UUID at write and replay. New decisions refuse revoked/expired grants, cancellation, settled or different attempts and the inclusive earliest deadline of the grant, actual wait and enclosing loop. Expiry-less legacy waiting events require an owner decision; a grant cannot invent historical deadline proof.

Snapshot inspection and decision event atomically retain the derived `grant:<id>` actor, admitted time, request UUID, exact scope, deadline and pause option. Shared replay verifies this private binding against retained grant issuance/revocation, original wait and inspection, including terminal rejection and loop scope. Retained hashes detect inconsistent history, not a privileged writer rewriting every source. Default evidence excludes the binding and actor; explicit private owner inspection retains them, never the bearer/digest.

When telemetry is explicitly configured, the actual decision span context is appended to the run's segment chain **in the same guarded decision transaction**, not in a separate pre-decision write. This includes paused approvals and terminal rejections. The decision event retains that segment; metadata-only evidence exposes trace/previous/parent context for trace navigation while still excluding private attribution. Downstream continuation reuses this span. Failed or uncertain writers may emit a failed-or-uncertain diagnostic without claiming a committed decision; a lost commit acknowledgment may leave the actual atomic decision retained. Neither receipt retries nor reopening reconstruct spans, exports or model calls. Unsampled context is retained but does not imply a received span. Collector receipt is not proof of downstream storage or dashboard availability.

The receipt contains only request/run/attempt/revision, action, admitted time, pause option and observed run status—not input, output, YAML, steps, private review data or identity. Identical requests freshly authenticate, then observe the saved decision/current status without writing, continuing or redispatching. Changed action/pause options conflict; another grant cannot adopt the receipt. An expired/revoked token cannot observe a retry; owner inspection remains the recovery path. A saved decision may be observed after its wait deadline because observation is not a new approval.

`pauseAfter: true` stops after decision settlement. Omission/false authorizes ordinary downstream continuation once, matching the owner decision behavior. Revocation cannot retract admitted work or external effects. After response loss, inspect/retry the original request—do not mint a new UUID, call owner `decide`, or resume automatically. This is an experimental SDK boundary inside a trusted host, not a sandbox against code already holding privileged owner methods.

Source/SQLite fault and PostgreSQL domain-double tests alone do not establish actual PostgreSQL locking/fault recovery, received OTel, independent package or deployed-owner acceptance. A later exact installed-package check used fresh PostgreSQL 17.11 SQL for two independently issued reviewer grants, guarded reviewer/cancel settlement and elapsed-deadline competition; it also exercised the opt-in management reviewer and owner routes over test-CA verified loopback HTTPS. See source-checkout `qualification/postgres-delegated-cancel-race-2026-10-16.md`. It used one runtime owner, deterministic cancellation timing and host-loopback test database transport, not k3s deployment, cross-process ownership, verified database TLS or production PKI. Qualification must pin the exact artifacts and profiles; older SQL/image receipts are historical for their original bytes. Approval-link delivery and bearer discovery are not enabled.

## Opt-in reviewer HTTP and CLI

An independently configured standalone management host may enable `reviewerDecisions: true` in `startRuntimeService` or `startPostgresRuntimeService`, or pass `--reviewer-decisions` to local `runtime serve`/`runtime start`. Disabled by default; preview hosts reject the option. Exact-release hosts have a separate opt-in reviewer page and request endpoint, scoped to the host's immutable release; see [optional separate reviewer page](releases.md#optional-separate-reviewer-page). Managed Docker authoring startup does not yet expose it. This is not desktop/Jarness attachment: the service owns its own configuration, state and credentials. Direct SDK use remains server-free.

The owner issues and privately delivers an exact-attempt reviewer grant as above. Retain the decision JSON before dispatch:

```json
{"requestId":"<retained-decision-uuid>","action":"approve","pauseAfter":true}
```

```sh
node bin/jevable.mjs reviewer decide <retained-decision.json> \
  --endpoint <reviewed-https-origin> --instance-id <reviewed-service-uuid> \
  --token-file <private-reviewer-token-file> --ca-file <protected-custom-ca.pem>
```

Omit `--ca-file` for normal system trust; private `http://127.0.0.1:<port>` is also supported without a CA. Obtain the instance UUID through the trusted operator, not reviewer discovery. Replacement hosts require separately reviewed instance identity. No owner bearer, local storage selection, automatic handshake, redirect, retry or fallback participates. The CLI accepts only request UUID/action/pause option and prints the metadata-only receipt; success means the decision was accepted/observed, not that downstream work succeeded.

`POST /v1/reviewer/decisions` requires the reviewer bearer in `Authorization`, the current `X-Jevable-Protocol` and exact `X-Jevable-Instance`. Bodies are bounded to 4096 bytes (or a lower configured host limit). Responses add `schemaVersion: 1` and `instanceId` around the SDK receipt. Existing origin/proxy, request capacity and draining protections apply; reviewers never consume the owner-reserved control slot. They cannot use health, capabilities or owner operations.

`ReviewerClient` from `@jevable/core/http` takes `(endpoint, token, instanceId, timeoutMs?, maxResponseBytes?, {ca}?)` and exposes `decide(request, traceParent?)`. It validates strict receipts, UUID/action/pause equality and instance identity. Optional trace propagation begins only after live reviewer/action authentication, and admission freshly rechecks authorization after a trusted observation hook. Never treat trace headers as identity. On response loss, retain the exact request; an explicit identical retry only observes it, never continues or redispatches. Revoked/expired tokens cannot observe retries.

This transport is experimental. Source and isolated host checks are not deployed TLS/PostgreSQL/image/browser/production qualification; record each exact build/profile separately.

## Remaining gates

SDK and opt-in management caller checkpoint/control HTTP/CLI implementation do not close exact-build installed/actual-SQL/fault/replacement/received-signal/deployment qualification, link delivery, scoped SSE, rate limits or grant exchange. Qualify the refreshed artifacts and each storage/transport/profile separately; routing doubles are not actual SQL proof. Earlier caller cancellation/control evidence retains its exact-build scope. Browser and Kubernetes acceptance remain separate as well. No desktop/Jarness service, credentials or state participate.

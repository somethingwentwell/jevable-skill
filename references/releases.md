# Runnable workflow releases

For explicitly authorized approval notifications from an exported workflow app, see [exact-release notifications](notifications.md#exact-release-workflow-apps). The app supports a direct `notify operation.json` job and guarded service requests, with private operator configuration and exact-release history isolation. No Jarness, harness or authoring skill is required; notification deployment qualification is tracked separately.

Use this for a reviewed, immutable workflow app that runs outside the authoring environment. Unlike a project ZIP, a release ZIP includes its pinned Jevable workflow runtime and bundled dependencies. Local execution needs Node.js >=22.19, but no npm install, agent skill, harness, desktop or Docker. The release app supports CLI jobs, an exact-release JSON service using loopback HTTP or configured direct HTTPS, and a browser operator page at `/` when explicitly served. It does not provision managed ingress.

## Create and export

Start from a saved project's accepted revision, not a draft. Inspect `projects show <id>` and retain its exact generation/revision. Creating a release does not execute it or prove its provider configuration works.

```sh
node bin/jevable.mjs releases create <project-id> --revision <accepted-hash> --expected-generation <n> --version 1.0.0 --data-dir .jevable
node bin/jevable.mjs releases show <release-id> --data-dir .jevable
node bin/jevable.mjs releases export <release-id> --release-sha256 <reviewed-release-hash> --format zip --output workflow-1.0.0.zip --data-dir .jevable
```

The create receipt includes a fresh release UUID, version, source project/generation, canonical workflow/revision, creator/time and exact runtime build SHA-256. `--id` can supply the release UUID in advance; duplicate creation conflicts rather than creating another release under the same identity. Versions are unique within a source project. Inspect a known release ID after a lost create response before attempting another creation.

Archived projects cannot create new releases. A saved release is immutable and stays exportable after project edits/archive; deletion of a locally referenced source project is refused. Pending proposals never enter a release. Unsupported executable nodes, unversioned native Decision routes, provider modes and retry settings are rejected; configuration-dependent readiness remains a target-environment check. [Loop-body approvals](authoring.md#review-each-loop-item) retain iteration-specific tasks and the original loop deadline in the bundled app. Explicit [System One Decisions](systemone.md) retain their native protocol/output-contract requirements in the exported configuration.

Export requires the reviewed release hash and the exact original runtime bundle. An updated bundle, even with the same development version string, is not silently substituted. Retain the original distribution/artifact for older releases. Immutable metadata does not retain a second runtime binary inside the database. These are pre-publication formats; downgrade and cross-runtime-version migration are not supported yet.

### Optional immutable release notes

Add `--notes-file /absolute/path/release-notes.txt` to `releases create` to include reviewed plain text. The CLI reads and validates the file before opening storage or contacting a selected owner. Notes must be nonblank, valid UTF-8, at most 16,384 bytes, with no ASCII control characters except tab, CR and LF. Exact text, including whitespace, line endings and a UTF-8 BOM, is preserved; it is not rendered as HTML or executed.

The SDK `createRelease` and authenticated management `releases.create` accept the same optional `notes` string. Notes are part of the immutable snapshot and release SHA-256. They appear in list/show metadata, `release.json` in exported ZIPs and images, offline `app.mjs info`, and the top-level `notes` field of exact-release `release.info`. Treat them as publishable text: do not include credentials, private run data or instructions to bypass review. They are not workflow input, provider configuration, telemetry payload or proof of approval.

Omitting notes retains the old snapshot shape and hash. Adding or changing text changes the release identity; there is no notes-edit operation. Create a separately reviewed version/UUID for new notes rather than changing retained evidence. A lost creation response is still uncertain: inspect the original retained ID, never mint a replacement automatically. Older binaries that do not support notes cannot consume a note-bearing snapshot. The experimental [HTML preview](live-preview.md#runnable-release-zips) accepts optional plain-text notes and retains the reviewed text/UUID before dispatch; receipt/export checks refuse substituted text. Actual browser/CSP/accessibility and saving qualification remain separate; use CLI exports when controlled filesystem permissions are needed.

### Attach selected run/test evidence

An optional release ZIP v2 can carry an already reviewed [selected-evidence ZIP](evidence-packages.md). Without attachment options, the existing v1 release ZIP remains unchanged.

```sh
node bin/jevable.mjs releases export <release-id> --release-sha256 <reviewed-release-hash> --format zip --output workflow-with-evidence.zip --data-dir .jevable --evidence-file evidence.zip --evidence-sha256 <reviewed-evidence-archive-hash>
```

If the evidence declares private execution data, add `--include-private-evidence` only with explicit consent. This is separate from the original `runs export-bundle --include-private` choice. No archive is selected automatically; incomplete options or a checksum mismatch fail before opening the authoring owner. Malformed archives, mixed/mismatched revisions and missing private consent fail without publishing an output. `--overwrite` is required to replace an existing file, and failed validation preserves it.

The public SDK exposes `createReleaseZipWithEvidence(release, artifact, {bytes, sha256, includePrivate})` from `@jevable/core/releases`. It returns ZIP `bytes`, a metadata-only `evidence` descriptor and `inspection`. The saved release identity and its runtime bytes are unchanged; the outer package checksum changes. The synchronous `createReleaseZip` and normal image-build path remain evidence-free.

The archive adds `evidence.zip`, a checksum-bearing descriptor and its exact file inventory. Inspection is bounded to 16 MB compressed evidence, with the existing nested ZIP limits and a 48 MB aggregate release-file limit. All selected runs must match the release's workflow revision. This is **revision-only association**, not proof of project ownership, execution of this release, passing tests or publisher authenticity. Privacy is declared, not independently attested; the export receipt does not display private payloads.

The launcher verifies attachment size/hash and descriptor before importing the runtime. It never unpacks or restores attached runs, tests, credentials, approvals or storage. Execute against separately configured fresh/persistent state. Missing or changed evidence refuses startup. To deliver without evidence, export a new ordinary ZIP; do not edit checksums to bypass integrity checks. Inspect the extracted evidence separately with `runs inspect-bundle evidence.zip --sha256 <reviewed-evidence-hash>` from a trusted standalone CLI, not by running an untrusted release.

**Image disclosure:** the included Dockerfile and Compose build include `evidence.zip`, including private payloads, in any image built from this ZIP. Protect that image as carefully as the archive. Normal `releases build-image` does not accept attachment flags and excludes this evidence. Export neither builds nor publishes an image. The [evidence-bearing image checks](images.md#images-built-from-evidence-bearing-zips) qualify standalone SQLite/PostgreSQL jobs and archive reload on the recorded Linux arm64 profile, not Compose lifecycle, HTTP serving or Kubernetes for those attached images. Evidence-free image receipts remain a separate packaging profile.

## Run the exported app

For API-only workflows, select [API entry](api-trigger.md) explicitly with `node app.mjs check|run --trigger-mode api` or `triggerMode: "api"` in exact-release JSON operations. `configuration.json` records this requirement. A supported graph is not automatic ingress or authorization to execute it.

The experimental HTML preview also offers [scoped create/review/export controls](live-preview.md#runnable-release-zips), including an explicitly reviewed evidence attachment. It uses the same standalone release packager, not a desktop service. Protocol/controller checks do not qualify actual browser downloads or target deployment.

### Optional Docker authoring owner

`releases list|show|create|export|build-image|export-kubernetes` accept the complete [Docker owner selection](docker-owner.md#author-test-and-run-through-the-selected-owner) instead of local storage flags. Docker `create` requires a retained `--id <release-uuid>` and the reviewed project generation/revision. The server records its authenticated actor and verifies the requested runtime version/hash against its own bundled bytes before saving a snapshot. The host independently validates the returned release identity. A different host/server build is refused, even when their version strings match; retain matching trusted distributions rather than substituting or downloading code automatically.

The owner stores release metadata; packaging stays on the host. ZIPs, image receipts and Kubernetes bundles are local outputs. `build-image` still requires its own explicit `--docker-context`, cached base, platform and fresh tag; the management container gets no Docker socket, source mount or image-build API. `save-image` is receipt-based and does not use owner flags. No command pushes an image, applies Kubernetes resources or runs the exported workflow implicitly.

Selected-owner release creation and ZIP export are qualified in source-checkout receipt `qualification/docker-transfer.json`: the guarded release pins exact runtime bytes, wrong-hash overwrite is refused without execution, and the exported app runs with Node only, without the skill, checkout, harness or npm. Selected-owner `build-image` and `export-kubernetes` routes remain unqualified end to end.

The management JSON API exposes `releases.list` (explicit pages required for PostgreSQL), `releases.show` and guarded `releases.create`. It does not expose remote ZIP/image building or deployment. Exact-release execution services reject these authoring commands. Project ZIPs remain editable transfer artifacts; release ZIPs include executable runtime bytes; saved image archives are Docker-loadable packages.

### Select the runtime backend

`releases create --runtime-storage sqlite|postgres` selects the exported app's storage implementation independently of authoring storage. When omitted it matches the author's `--storage` (SQLite by default) or the explicitly selected Docker owner's backend. For example, add `--runtime-storage postgres` to the SQLite authoring command above to produce a PostgreSQL app without opening a database during authoring. The release pins that backend's exact bundled runtime checksum. `export` and `build-image` resolve only that saved checksum; they never silently convert it to the current default backend.

For an explicitly reviewed SQLite app with shared PostgreSQL HTTP quotas, select **both** `--runtime-storage sqlite --runtime-rate-coordinator postgres` at creation. This is a separate optional bundle/hash, not PostgreSQL workflow storage. The default SQLite bundle remains driver-free. Read the [optional SQLite quota profile](postgres-rate-limits.md#optional-sqlite-workflow-app-profile) for SDK/management selection and protected serving configuration. Its manifest/configuration/info distinguish the capability; direct jobs need no quota server, and credentials are never bundled. Export does not retrofit an old release. Optional-profile image/Kubernetes acceptance remains separate.

PostgreSQL apps bundle their JavaScript database driver and need no npm dependencies, but do require an independently provisioned database. Add `--database-file /private/path/database.json` to **every stateful app command**, including `check`, `run`, retained reads/controls, provider configuration and `serve`. `info`, `token`, `status` and `request` do not open a database. This app rejects `--data-dir`; the SQLite app rejects `--database-file`. Read [PostgreSQL configuration](postgres.md) for explicit endpoints, owner-only files, verified database TLS, initialization authority and single-owner namespaces. Database configuration, provider secrets and journals are never included in the ZIP or image context. Ambient PG variables and native-driver selection are not used.

PostgreSQL HTTP `runs.list` requires `page: {}` or an explicit bounded page; events/evidence use v2 decimal string identities. See [exact-release serving](http.md#exact-release-serving). PostgreSQL image generation uses the same explicit local Docker build/archive commands. Its [separately tested container profile](images.md#run-independently-with-postgresql) covers database trust/hostname verification, non-root private configuration, retained controls and loopback HTTPS; production database roles/provisioning/migration/restore and Kubernetes remain separate gates. Export/build success alone is not deployment qualification.

### Execute and inspect

Verify the ZIP SHA-256 against its trusted export receipt before unpacking into a private, new directory. Archives include executable JavaScript: checksums detect corruption, not publisher authenticity. Do not execute an untrusted release simply to inspect it.

```sh
node app.mjs info
node app.mjs check
node app.mjs run --input /absolute/path/input.json --id <fresh-run-uuid>
node app.mjs show <run-uuid>
node app.mjs events <run-uuid>
node app.mjs export <run-uuid> --output evidence.json
```

The launcher verifies packaged file sizes/checksums and release/workflow/runtime agreement before importing the engine. It will not accept replacement workflow arguments. For SQLite the default private state directory is `.jevable` beside the app; use `--data-dir` for another explicit location. PostgreSQL requires the explicit private configuration described above. Different installations do not discover or share authoring state. Node itself, a PostgreSQL server and external model providers are not included in the ZIP.

Retain the run UUID before execution. Retrying the same release/input/UUID reads its recorded state without redispatching. A lost response does not mean no side effect occurred. An uncertain attempt remains uncertain; do not invent another UUID to bypass it. Each run retains release ID/hash as well as workflow revision, and startup validates that linkage against the saved release snapshot. Transferred creator/project fields are historical claims, not locally authenticated review evidence.

For approvals:

```sh
node app.mjs review <waiting-run-id>
node app.mjs decide <waiting-run-id> --attempt <reviewed-attempt-id> --action approve
```

Only submit a decision with explicit authority for that review. Approval waits and results survive process restart. `show`/`events` do not execute. Outputs can contain private business data; `review` intentionally exposes the stored review input to the local owner.

### Local interface and headless jobs

The extracted release supports both an optional local browser interface (`serve`, below) and one-shot headless commands. The commands above require no browser, desktop app, container or always-on Jevable HTTP service. Use an explicit, retained `--data-dir` for SQLite or `--database-file` for PostgreSQL on every stateful invocation; a disposable function filesystem is not durable state. An approval wait is a checkpoint, not a background process. A separately authorized later `decide` or `continue` invocation can advance it. Retain the original run/request IDs and inspect saved state after a lost reply before submitting anything again.

The browser interface and headless commands belong to **the same runnable workflow app** and show the same saved run IDs, checkpoints and history. `serve` needs a local HTTP process while the interface is in use; stopping it leaves retained work on disk. With SQLite, the service owns its storage namespace while running: use its authenticated `request` API instead of opening a competing direct CLI owner against the same data directory. The two modes do not require two different workflow definitions or a desktop app.

For automatic **fully local, scale-to-zero** operation, the operator must supply an event source that starts the exact release job on demand and wakes it again after a scheduled event or authorized decision. That source may be a local queue/scheduler or a locally deployed event platform. External webhooks require an ingress to receive them while the Jevable job is absent; the [signed webhook SDK](webhooks.md#server-free-sdk) can be embedded in such a host, but the exported CLI does not install a scheduler, queue, ingress or function adapter. Protect credentials and persistent state, enforce one owner per namespace, bound job duration and concurrency, and reuse the stable event/run identity after uncertain responses. The current one-shot commands support manual headless execution; automatic local serverless delivery and its failure/recovery behavior are not yet qualified.

### One-shot local event delivery

New source builds add `event-id` and `event` to the **exported workflow app**. Older ZIPs must discover commands with `info`; they do not gain commands from an updated guide. These commands are the local execution adapter for a separately operated scheduler/consumer, with no listener or background worker. They do not install that event source.

Prepare a private regular UTF-8 JSON file in a trusted directory (POSIX mode `0600`, owned by the runtime user), using the real `releaseId`, `releaseSha256` and `revision` from this app's `info`:

```json
{
  "format": "jevable.ai/local-release-event",
  "version": 1,
  "release": {"id": "<release UUID>", "sha256": "<release hash>", "revision": "<workflow revision>"},
  "source": "local/orders",
  "messageId": "order-event-001",
  "input": "A reviewed workflow input"
}
```

The Trigger must declare `api`. No actor, run UUID, paused flag, credentials, decision or control operation may be added. `source` and `messageId` use the [stable-message identity rules](release-messages.md#identity-and-recovery). The exact release/source/message tuple derives the same UUIDv8 as `ReleaseMessageSession`; event input and delivery time are excluded. The 1,100,000-byte file limit contains the existing 1,000,000-byte/depth/value input policy.

```sh
node app.mjs event-id /private/path/event.json
node app.mjs event /private/path/event.json --event-sha256 <reviewed eventSha256> --data-dir /private/path/workflow-state
```

`event-id` validates the release and owned file, then reports the exact byte hash and derived run UUID without opening storage, telemetry or a listener. It excludes source/message identity and input from output. Retain and review that hash before execution. `event` requires it, captures the bounded bytes before opening state, selects API entry, executes the original run and closes the owner. PostgreSQL apps use their required `--database-file` instead of `--data-dir`. Optional `--telemetry-file` uses the existing execution signals and durable run/attempt identity; no event/message identity is added to metric labels.

After an execution or response-loss retry, the same release/source/message/input observes the retained checkpoint without dispatching again. Changed input under that identity conflicts, even with a new file hash. A waiting/paused/uncertain result is not successful business completion and never authorizes resume or approval. Use a separately authorized existing `decide` or guarded `continue` operation for a saved wait; redelivering the start event cannot wake it automatically.

The event file is local operator execution authority, **not remote sender authentication**. Final symlinks, nonregular files, group/other-readable POSIX files, invalid UTF-8, incorrect pins/hashes or unsupported input refuse before runtime ownership. Parent directories must be trusted; no ancestor ACL policy or Windows ACL qualification is implied. Keep event files/state/receipts private and do not expose this local command as an anonymous webhook.

A local system scheduler may run the command when an event is ready. Preserve the original file/hash/message identity across scheduler retries; inspect exit codes and the original UUID after response loss. A recurring schedule needs a distinct retained message ID for each intended occurrence, not a fresh ID per retry. Do not race jobs against an active SQLite interface owner.

### Durable local inbox and drain-once scheduler

New source builds add `event-inbox` and `scheduler` to the exported app. `event-inbox` validates an event exactly like `event-id` and stores the pinned bytes in a **private owner-only durable inbox** (`--inbox <directory>`); re-queuing identical bytes is idempotent, and the command never opens workflow storage.

```sh
node app.mjs event-inbox /private/path/event.json --inbox /private/path/inbox
node app.mjs scheduler --inbox /private/path/inbox --data-dir /private/path/workflow-state
node app.mjs scheduler --inbox /private/path/inbox --interval-seconds 30 --data-dir /private/path/workflow-state
```

`scheduler` takes a cooperative single-process inbox lock (a live second scheduler refuses `busy`; a provably exited owner is replaced), then delivers each non-terminal entry by spawning this app's exact `event` command in a **separate bounded child process** (`--event-timeout-ms`, default 120000, kills the child and records `timeout-uncertain`), and **exits after the pass** — scale to zero between work. `--interval-seconds` starts an explicitly operated local polling loop instead; it is infrastructure the operator owns, never a required Jevable service.

Inbox entries replay under their original pinned identity and run UUID: a crash or lost child response before the record update leaves the entry replayable, and the next pass observes the retained run instead of dispatching a duplicate. `waiting`/`paused`/`executing` entries are only **re-observed** on later passes until an authorized decision or continuation settles them — the scheduler never resumes, retries execution or approves. `conflict` (changed input under the original identity) and `invalid` entries stop retrying for operator inspection. Tampered event bytes, public permissions or unparsable records refuse before any delivery. External HTTP wakeups still require a separately operated listener or event platform; this is local-file authority, not ingress.

### SQLite crash ownership and recovery boundaries

An abruptly killed SQLite owner (for example a `SIGKILL`ed serving container) leaves a retained runtime lock; every later owner **fails closed** — verified in the 2026-11-02 on-cluster drill, where replacement containers refused rather than touching the crashed state. The lock's recovery context is deliberately bound to the original Linux boot and process namespace: `inspectRuntimeLock`/`recoverRuntimeLock` (installed SDK `runtime` entry) refuse takeovers from a different context (`unsupported-context`/`owner-not-proven-exited`), so a crashed lock cannot be recovered from another container or machine, and the exported app intentionally exposes no lock-recovery command. For persistent on-cluster deployment use the **PostgreSQL storage profile**, whose supported replacement path (`503 ownership-lost`, then an explicit owner replacement) is qualified separately; treat a retained SQLite lock as operator-inspection state and never delete it to force startup.

`export` writes [retained run evidence](evidence.md) for this exact release without execution. The default excludes source, inputs, outputs and actors; `--include-private` explicitly includes the full retained run/journal. Files are owner-only and refuse overwrite unless `--overwrite` is requested. An evidence JSON is neither a runnable release nor a restorable database. Checksums are not signatures or proof of external effects.

For [step-by-step execution](control.md), add `--paused` to `run`, then use `step` or `continue` with the run ID, retained `--request-id` and reviewed `--checkpoint-sha256`. Add `--pause-after` to an authorized `decide` when downstream execution must wait. These commands enforce this exact release and never redispatch a retained control request. `step`/`continue` also accept `--breakpoints-file` for persistent node breakpoints. `pause` accepts the same retained request/checkpoint guards without breakpoint changes; an active owner exposes cooperative Pause through its exact-release API. It lets the current node settle, never aborts or rolls back it, and retains uncertain intents.

Use `node app.mjs cancel <run-id> --request-id <retained-cancellation-uuid>` to cancel a saved wait or inactive uncertain run belonging to this release. It retains the stopped checkpoint, never undoes external effects, and refuses competing ownership. See [cancellation](cancellation.md).

The packaged `README.txt` includes a complete command/flag inventory generated from the app's own parser grammar, with SQLite/PostgreSQL storage requirements and required versus optional flags. It is the exported workflow app's interface, not the authoring CLI. `info.commands` lists the same commands without opening storage.

For an explicitly authorized [already-saved model response settlement](control.md#recover-an-already-saved-model-response), inspect `show`, retain a recovery UUID and reviewed checkpoint hash, then use `node app.mjs recover <run-id> --request-id <uuid> --checkpoint-sha256 <hash>` (plus the backend's state configuration). It settles only the original committed model response; no provider call, next-node execution, approval, stale-lock repair or automatic reconnect occurs. Usually it returns a safe paused checkpoint, requiring a separately authorized Step/Continue. A retained `executing` state alone does not establish recoverability. An active service requires its `request` API with `runs.advance`, `mode: recover`; never start a competing direct owner.

Direct execution exit codes: 0 completed/read or pause/cancellation-submission success; 1 operation failure; 2 invalid command/readiness; 3 waiting/paused; 4 workflow failure; 5 uncertain dispatch or incomplete output; 7 cancelled execution/retry; 130 SIGINT or 143 SIGTERM after graceful local owner shutdown. The first signal stops further dispatch but lets admitted work settle and closes telemetry/storage before exit; repeated signals never force-kill or cancel it. A draining stderr receipt is not proof that shutdown finished. See [job shutdown](job-shutdown.md). Newly exported apps share [bounded CLI output](cli-output.md): no truncated JSON or automatic execution/overwrite after output loss. A CLI job does not start a background server. Explicit `serve` stays running until drained; `request` exit code 0 means HTTP success, not workflow completion—inspect `result.status`.

## Serve the exported app

New PostgreSQL workflow apps can explicitly attach to shared HTTP quotas with `serve --rate-coordinator-file /private/shared-quota.json`, separately from their required `--database-file`. Read the [protected shared-quota contract](postgres-rate-limits.md#postgresql-exported-workflow-apps): pre-provisioned scope/policy, initialize:false, no combination with local rate limits, and coordinator cleanup after HTTP drain. Nothing is added to the workflow source or archive automatically. Default SQLite apps keep their no-PostgreSQL-driver bundle and refuse this option; the separately selected [optional SQLite profile](postgres-rate-limits.md#optional-sqlite-workflow-app-profile) supports it with SQLite `--data-dir` instead. This feature does not imply image/Kubernetes or production acceptance.

For reviewed incoming events, newly exported apps additionally accept `--webhooks-file` with explicit `--async-concurrency`; read [signed intake](webhooks.md) before startup. This is separate start-only HMAC authority, one pinned API release, not an anonymous owner API or automatic vendor integration.

After unpacking and configuring any required providers, start the app itself as the Jevable workflow runtime:

```sh
node app.mjs token --output /private/path/service-token
node app.mjs serve --token-file /private/path/service-token --data-dir /private/path/workflow-state
```

Token generation refuses overwrite, writes an owner-only file and never prints its value. The readiness receipt includes the public URL, bound listener, transport, instance/protocol and exact release identity. Without TLS, optional `--port` selects a fixed loopback port; default is an ephemeral port. There is no automatic browser launch. Starting/restarting does not execute a run, create an authoring project, approve a gate or recover an unsettled attempt.

The service's `/` page is an inert, no-store shell until the owner enters the service token; it contains no release source or private run data. After authentication, it shows a left-to-right graph, explicit Run, paginated Log, Approvals and Guide tabs. Its Run form supports bounded closed objects, nested fields, primitive choices and add/remove arrays from the accepted input schema; it omits enum choices the schema itself would reject and counts Unicode code points as the runtime validator does. Open or unusually large schemas use the complete JSON editor. A guided form can switch to JSON after its fields are valid without dropping the draft. Approval requests, completed results and recorded values display readable nested fields, with exact JSON in a collapsed disclosure. Each graph card labels its saved-run state in words, including not reached. A saved run shows its published version, recorded times and step timing/branch/trace/attempt metadata; **View audit events** explicitly reads saved event kinds/times, excludes payloads and shows at most 500 in-page (use the authenticated API for all). Private input, intermediate outputs, API-grant identity (when present) and recorded approval action/actor require a separate **View recorded values** click. The page holds the owner token only in memory, not a URL or browser storage. Its owner token still authorizes all release operations; an optional separate reviewer experience is described below. Scoped extracted-ZIP browser checks are recorded in the source checkout's qualification receipts; they do not replace visible user-watched Codex/Claude handoff, complete accessibility/schema, container or deployment acceptance.

### Optional separate reviewer page

Start this **same exact-release workflow runtime** with `serve --reviewer-decisions` to add `/review` and the grant-only `/v1/reviewer/request` and `/v1/reviewer/decisions` routes. Omission keeps them disabled. It is not an authoring/desktop service, and it does not grant run, source, credential or owner access to a reviewer. The owner can open a waiting request in **Approvals → View request → Create review token**; the browser generates a private token, submits only its digest, then displays the token once. Give the reviewer the `/review` URL and token separately through a trusted channel; never put the token in a URL. The reviewer page shows only that release/run/attempt's currently waiting review and its allowed named actions, including custom actions from that node, requires explicit confirmation, and does not store the token in browser storage. An action can continue the workflow and contact configured services. The page's **Check same decision** retains the original decision UUID after a lost reply; it does not automatically retry or generate a replacement.

For a CLI-controlled installation, `node app.mjs reviewer-token --id <retained-grant-uuid> --output /private/reviewer-token` prepares an owner-only token file **without opening storage or issuing access**. Keep the returned digest and token file private. Through the owner `request` client or `/v1/operations`, issue `{operation:"reviewers.issue",id,tokenSha256,runId,attemptId,expiresAt,decisions:["approve"]}` (or any nonempty subset of that node's named actions) with the exact release hash supplied by the app client. The owner can inspect `reviewers.show` and revoke with `{operation:"reviewers.revoke",id,requestId:<retained-uuid>,expectedGeneration:1}`. Issuance is limited to a live approval in this release and only actions the approval node actually offers. Names are bounded to 128 ASCII characters, cannot be reserved route names and grants contain at most 200 unique names. The same issuance ID/digest/scope/expiry is observation-only on retry, including after the wait settles; a changed request conflicts. A revoked/expired reviewer token cannot read or retry a decision. Revocation cannot retract an already committed decision or downstream effects. There is no reviewer inbox across runs, signed link or Email delivery; the owner remains responsible for secure token delivery and recovery after lost credentials.

For direct HTTPS use the [explicit TLS profile](http.md#explicit-direct-https) with the bundled `serve` command: `--port <nonzero-port> --public-origin <https-origin> --bind-address <ip> --tls-cert-file <chain.pem> --tls-key-file <private.pem>`. Use `--ca-file <ca.pem>` with bundled `status`/`request` only when explicit private-CA trust is needed. The app includes the transport code but never your keys, token or CA configuration. Only explicitly authorize non-loopback exposure; TLS does not add user roles or reduce this token's authority. Proxy authentication, automatic certificate rotation and deployment orchestration are not implemented.

From another terminal, use the same exported app as the client:

```sh
node app.mjs status --endpoint http://127.0.0.1:<reported-port> --token-file /private/path/service-token
node app.mjs request /private/path/operation.json --endpoint http://127.0.0.1:<reported-port> --token-file /private/path/service-token
```

For the echo example, a run operation file contains:

```json
{"operation":"runs.start","id":"<fresh UUID retained before submission>","input":"Hello from the independent app."}
```

Use the actual workflow input schema in `configuration.json`. Add `paused: true` for paused admission. The app client supplies its own release hash on every operation; operation files must not supply `releaseSha256`, a replacement source or an actor. Optional `--timeout-ms` bounds the client wait only. A timeout/disconnect does not cancel server execution. Inspect the original UUID, and explicitly retry that identity if needed; never replace it merely because the response was lost.

The API exposes authenticated `GET /v1/openapi.json`, `GET /v1/capabilities`, `GET /v1/health`, and `POST /v1/operations`. The owner page's Guide can load and display the OpenAPI 3.1 contract plus examples without placing the token in a URL. Direct callers send `Authorization: Bearer …`; `GET /v1/health` and `POST /v1/operations` also require `X-Jevable-Protocol: jevable/v1alpha1`. POST calls require JSON content type and the exact `releaseSha256` in every body. Do not place secrets in command arguments, URL parameters, workflow files or chat. The pinned command set is:

- `release.info`, `release.check`: identity/configuration requirements and provider readiness; neither executes or contacts models.
- `runs.start` (`id`, `input`, optional `paused`), `runs.list`, `runs.show`, `runs.inspect`, `runs.events`, `runs.export` (optional `includePrivate`): all reads/controls are restricted to this exact release.
- `runs.advance` (`id`, retained `requestId`, reviewed `expectedCheckpointSha256`, `mode: step|continue|pause|recover`) and `runs.cancel` (`id`, retained `requestId`).
- `approvals.show` and `approvals.decide` (`id`, exact `attemptId`, reviewed `action`, optional `pauseAfter`). Human decision authority remains required.
- `approvals.list` with an explicit live page, plus the separately guarded `notifications.destinations|prepare|send|show|list|abort` described in [notifications](notifications.md#exact-release-workflow-apps).

`release.info.graph` is a read-only, top-level diagram projection: workflow name and description, compiled node order, node IDs/kinds/titles/descriptions, named Human Approval actions, and exact directed edges with branch ports. It excludes executable node configuration, bindings, source YAML and credentials. Loops remain one card in this projection; internal-step inspection requires its own guarded view. A successful info read does not check provider readiness or run the workflow. The exact-release service uses this projection for its authenticated in-container operator page; this is not a general authoring preview or proof that a delivered ZIP/image has been browser-qualified.

The token is **single-owner authority for every exposed operation**, including private inspection and approvals. It is not a restricted run-only token, multi-user identity or authorization-role system. The host supplies the recorded actor. Other release/ordinary runs are hidden even when the state store contains them. Authoring, source replacement, preview bootstrap, provider settings and credential mutations are rejected. Source, input/output and approval reviews remain private; use default evidence exports when sharing is authorized.

Configure providers/credentials before starting the service. It exclusively owns its state directory: use its API while it runs, not competing direct CLI owners. Ctrl-C/SIGTERM drains admitted requests and then releases storage. Drain timeout reports unfinished work and keeps ownership; it does not force termination or imply rollback. Saved waits and evidence survive restart, and an uncertain model attempt is never automatically redispatched. A reserved bounded shared slot for run status, guarded Pause and Cancel remains available at ordinary request capacity.

The previously qualified container profile binds to loopback **inside** an exported container, reachable through an internal client. Direct HTTPS also has a separately qualified [host-loopback Docker profile](images.md#serve-https-to-the-local-host), with explicit non-root key provisioning, inspected port mapping and verified host client trust. Managed authoring, public-network/proxy ingress and Kubernetes remain separate gates.

## Providers and artifacts

`configuration.json` contains the workflow input schema and required model routes/providers/model IDs/timeouts. It includes no originating connection endpoints, credential store or model evidence. Follow packaged `README.txt` to use `providers-set`, `credentials-set`, `providers-list`, `credentials-status` and `check` with fresh target configuration. Secrets enter through owner-only files, never command-line values. Authored secrets in workflow source are not automatically redacted—review source before export/sharing.

The default v1 archive has a fixed allowlist: `app.mjs`, `runtime.mjs`, `release.json`, `workflow.yaml`, `configuration.json`, `manifest.json`, `NOTICES.txt`, `README.txt`, `Dockerfile`, `compose.yaml`, `.env.example`, and `.dockerignore`. It excludes project history, authoring sessions, run databases, input/output evidence, provider credentials and test results. An explicitly selected v2 attachment adds `evidence.zip` as described above: its historical payloads/tests may include private data or inline secrets, but are never restored as executable storage. Package creation is atomic and refuses an existing output unless `--overwrite` is explicitly requested.

Dockerfile/Compose default to optional non-root CLI jobs with separate persistent storage and explicitly mounted input. The image also contains the exact-release HTTP/HTTPS service; Compose remains a job example and does not publish a service port. The documented host-loopback HTTPS profile uses explicit Docker invocation and is not Compose qualification. ZIP generation alone is not image qualification. [Build and save an image explicitly](images.md) using the same fixed release files, a trusted cached Node base digest and a local Docker engine. Linux arm64 checks are pinned to exact artifacts; `qualification/release-evidence-images.json` refreshes the ordinary SQLite/PostgreSQL release profiles and separately covers evidence-bearing jobs. Compose orchestration and other deployment profiles remain unqualified. No command pushes or deploys. Browser testing, remote release HTTP ingress, forced container termination, distributed storage and full OpenTelemetry are still pending. Exported apps support separately configured [OTLP trace/metric/log export](telemetry.md) with `--telemetry-file`; operational exporter configuration and credential tables are not bundled. The refreshed PostgreSQL profile checks actual model/collector traffic and all three signals in a private loopback fixture, not external hosted provider/collector networking.

The build-only bundler uses [esbuild's Node bundling API](https://esbuild.github.io/api/#platform). Build checks reject non-builtin external imports and source paths outside this repository, and collect included dependency license notices. The shipped ZIP needs neither esbuild nor npm. Packaging does not hide JavaScript source or grant distribution rights that have not been published.

## SDK and evidence

`@jevable/core/releases` exports `loadReleaseRuntime`, explicit optional `loadReleaseRuntimeProfile`, `createReleaseZip`, `inspectRelease`, `releaseRequirements` and release types. A trusted SDK host reads the distribution's runtime identity, then calls `LocalRuntime.createRelease` with reviewed project guards and the authenticated creator. Do not invent the runtime hash. `runRelease(snapshot, input, {id})` registers/validates a release snapshot in an independent store and executes that source; the packaged launcher is responsible for verifying the actual bundled code bytes first. Snapshot metadata alone is not runtime attestation.

For trusted embedding, `startRuntimeService` from `@jevable/core/http` accepts `release: {snapshot}` instead of `preview`; the two modes are mutually exclusive. It pins a validated copy before async startup and exposes only release operations. `ReleaseClient` and `ReleaseOperation` from `@jevable/core/releases` provide the explicit endpoint/token/reviewed-release-hash client; no discovery or automatic retries occur. SDK hosts still own code-byte verification; use the packaged launcher when delivering a self-verifying app.

SQLite schema 6 adds immutable release records and release-pinned runs. The release store verifies retained hashes/source, rejects identity replacement and refuses downgrade. Release records currently have no deletion/retention command.

`npm run test:package` exports with the production-only installed CLI and starts extracted apps in a separate directory with no `node_modules`: deterministic results, approval wait/decision and cancellation across processes, stable retry, tamper refusal, configured model execution and trace/metric/log export against local fixtures. It also exercises the extracted app's token/serve/status/request surface, pinned-source refusal, stepping, approval waits across server replacement, evidence privacy and direct CLI inspection after drain. This does not qualify real hosted providers or telemetry backends, Docker/Kubernetes, all platforms, minimum Node, UI or forced in-flight termination.

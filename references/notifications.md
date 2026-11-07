# Approval notification implementation status

Approval notifications are an **experimental SQLite and PostgreSQL capability** in the SDK, management CLI/API and exact-release app/API. The experimental live viewer adds [read-only project history](live-preview.md#project-notification-history), not destination configuration, sends, private-event inspection or abort controls. Actual browser interaction remains unqualified. Do not use a harness service or direct destination call to fill an unsupported route. The [read-only inbox](approvals.md) remains independently available.

## CLI and management API

The local default needs neither Docker nor a running authoring server. Store the startup configuration shown below as an owner-only regular JSON file (not a symlink; at most 100,000 bytes), with no signing key value. Provision the signing key separately using the protected credential commands. Then:

```sh
jevable approvals notify destinations --notifications-file notifications.json --data-dir .jevable
jevable approvals notify prepare <run-id> --revision <reviewed-revision> --attempt <current-attempt-id> --destination review --notifications-file notifications.json --data-dir .jevable
jevable approvals notify send reviewed-request.json --notifications-file notifications.json --data-dir .jevable
jevable approvals notify show <retained-request-id> --data-dir .jevable
jevable approvals notify abort <retained-request-id> --data-dir .jevable
jevable approvals notify list --page --limit 100 --data-dir .jevable
```

Preparation is read-only. Review its event and destination fingerprints, then create and retain `reviewed-request.json` with exactly `runId`, `revision`, `attemptId`, `endpointId`, `endpointSha256`, `eventSha256`, and a fresh UUID `requestId`. Copy the reviewed pin values without the preparation-only `event` and `delivery` fields. Do not put an actor, destination URL, credential reference or signing key in a send request. Explicit redelivery adds `redeliverOf` naming the latest prior request and requires a new request UUID; it uses the same command, not an automatic retry loop. Changed endpoint configuration requires a separately reviewed destination identity for this event, rather than silently retargeting a redelivery chain.

### Exact historical project history

To inspect one project's deliveries, supply all three retained provenance pins:

```sh
jevable approvals notify list --page --project-id <project-uuid> --generation <historical-generation> --revision <workflow-sha256> --limit 100 --data-dir .jevable
```

The SDK method is `listProjectApprovalNotifications({id, generation, revision}, {after?, limit?})` on either owner. The management API operation is `notifications.project-list` with strict `project: {id, generation, revision}` and an explicit `page` object. The reply includes that exact `project` pin and metadata-only delivery summaries. Selected-owner CLI transport uses the same operation; an older owner can refuse it rather than falling back to an unfiltered list. Exact-release apps and scoped preview/caller/reviewer routes do not expose this management-owner operation.

This filters the original project generation and revision retained in each signed event, not today's accepted project. Renaming, editing or archiving a project does not retarget the query. All three pins are required together; never substitute the current generation merely because the historical page is empty. The page does not prove that the project still exists or that every workflow has a notification.

History scans bounded 200-record keyset batches, retaining one result page, with the owner's 100,000-delivery bound. Only matching delivery IDs can serve as cursors; unknown, other-project, other-generation or other-revision cursors are refused. Order is UUID identity order, not event time. It is a live filtered traversal, not an indexed project query or an atomic cross-batch snapshot; new IDs before a cursor require a fresh traversal. Inspection needs no configured destination or signing key and never sends, approves, expires, cancels, resumes or replays anything.

### Read-only outcome, lifecycle and creation-time filters

Find retained deliveries without sending or retrying them:

```sh
jevable approvals notify list --page --outcome uncertain --event-kind requested \
  --created-from 2026-10-01T00:00:00.000Z --created-before 2026-10-02T00:00:00.000Z \
  --data-dir .jevable
```

Every filter is optional and combined with AND. Outcomes are `pending`, `accepted`, `rejected` or `uncertain`; lifecycle kinds are `requested`, `decided`, `expired` or `cancelled`. Omitted historical `eventKind` means `requested`. Bounds require UTC ISO timestamps with exactly milliseconds: `createdFrom` is inclusive, `createdBefore` exclusive, and a supplied pair must increase. These describe delivery-intent creation time, not the original approval event, settlement time, receipt time at a recipient or human delivery. No outcome is proof of approval or absence of external effects.

SDK/API page requests accept `filter: {outcome?, eventKind?, createdFrom?, createdBefore?}` on `listApprovalNotifications`, `listProjectApprovalNotifications`, `notifications.list` and `notifications.project-list`. Exact-release `notifications.list` composes the same filter with its immutable release scope. A supplied filter must be nonempty; unknown fields and malformed bounds are refused before storage traversal. The reply echoes the canonical filter, and the CLI verifies that echo and every returned summary against the request. Omission preserves the original unfiltered request/response shape. Older servers can refuse filtered requests; there is no unfiltered fallback.

```ts
await runtime.listApprovalNotifications({ limit: 50, filter: { outcome: 'uncertain' } })
```

Use the same filter and scope for subsequent pages. A cursor must still match both, and only a matching delivery ID is returned as `nextCursor`. If a pending delivery settles between reads, its old pending-query cursor can be refused: restart the read-only traversal rather than assuming snapshot stability. New identities before a cursor need a fresh traversal. Filtering scans bounded 200-record batches up to the retained 100,000-delivery limit, keeping only one result page; it is not an indexed time/status query or an atomic snapshot. No destination, signing key or notification configuration is needed for inspection. The experimental [preview history controls](live-preview.md#project-notification-history) offer explicit draft/apply filters for their retained project only; actual browser/CSP/accessibility qualification remains separate.

### Recorded approval lifecycle

Preparation accepts `--event-kind requested|decided|expired|cancelled`; omission preserves the original requested-event behavior and bytes. In the SDK/API, put the optional `eventKind` in the strict approval pin and copy it into the reviewed send request. Do not confuse it with the preparation-only `event` body. The same selector works through the explicitly selected owner and exact-release app/API.

| Kind | Required evidence | Send-time rule |
| --- | --- | --- |
| `requested` | Current waiting attempt and its unique request journal event | Wait must still be current and unexpired at admission. |
| `decided` | Committed action decision for that exact attempt | Historical event remains available after continuation or another approval wait. It does not disclose which action or who chose it. |
| `expired` | Committed expired decision for that exact attempt | Crossing the clock deadline alone is insufficient; preparation does not settle the wait. |
| `cancelled` | Committed run cancellation whose retained previous checkpoint was this exact waiting attempt | Cancellation elsewhere in the workflow is not cancellation of this approval. |

For example, after an explicitly authorized decision has been recorded:

```sh
jevable approvals notify prepare <run-id> --revision <reviewed-revision> --attempt <recorded-attempt-id> --event-kind decided --destination review --notifications-file notifications.json --data-dir .jevable
```

The CloudEvent type is `ai.jevable.approval.<kind>`. Its time is the retained lifecycle event time, never preparation/send time. It carries the original approval deadline and the same thin run/revision/node/attempt/project/release identifiers, but no actor, action label, review body or model payload. For historical lifecycle events, `expiresAt` describes the original wait, not a notification delivery deadline. New explicit sends/redeliveries can therefore occur after that deadline, with separately reviewed delivery authority and a fresh request UUID. Each event/endpoint has its own predecessor chain: a requested receipt cannot be a decided event's predecessor.

New lifecycle preparation requires the historical deadline in the original request journal. Legacy journals missing it remain readable under the original requested-receipt contract; no deadline is invented or history rewritten. Such legacy lifecycle preparation is refused. Storage tables/schema 16 are unchanged, but older binaries that only understand requested events refuse newly retained lifecycle records: do not downgrade an owner with that history. Keep independent backups before upgrading.

This is explicit delivery, not an automatic notification policy or background worker. Run/decision/cancellation, deadline checks, prepare/show/list, startup and restart never send automatically. A `decided` event is evidence of a recorded action decision, not approval of the action; every notification remains descriptive rather than workflow execution authority.

For a send, exit 0 means a retained accepted HTTP response, exit 1 means rejection or an operation failure, and exit 5 means retained pending/uncertain delivery. Inspect the response body to distinguish these outcomes. `show` exits 0 for a successful inspection even when delivery is pending/uncertain. Do not infer human delivery, approval, or absence of external effects from an exit code.

For PostgreSQL, replace `--data-dir .jevable` with `--storage postgres --database-file database.json`, using the independently provisioned private database configuration described in [postgres.md](postgres.md). This selects PostgreSQL directly; it never opens SQLite or starts a database container implicitly.

For an explicitly requested service, add `--notifications-file notifications.json` to `runtime serve` or local `runtime start` with either storage backend, including an explicitly pinned release. Configuration is validated/copied at startup and cannot be overridden by a request. Exported archives exclude this host configuration and keys. Preview commands still refuse the flag. Explicit [Docker management startup](docker-owner.md#optional-approval-notification-configuration) also accepts it, with optional `--notifications-ca-file` for reviewed process-wide private-CA trust. The runtime stages private configuration independently and never sends on startup/restart; deployed-profile qualification is recorded separately.

The authenticated management API exposes:

| Operation | Strict request fields beyond `operation` |
| --- | --- |
| `notifications.destinations` | None; returns destination IDs and configuration hashes only |
| `notifications.prepare` | `pin: { runId, revision, attemptId }`, `endpointId` |
| `notifications.send` | `request`, containing the reviewed send-file fields above |
| `notifications.show` | `requestId` |
| `notifications.abort` | `requestId`; signals only this owner's active delivery, returns acknowledgement and receipt snapshot |
| `notifications.list` | `page: { after?: requestId, limit?: 1..200, filter?: {outcome?, eventKind?, createdFrom?, createdBefore?} }`; explicit page object required |
| `notifications.project-list` | `project: {id, generation, revision}`, the same optionally filtered `page`; exact historical pins and explicit page required |

Use these through `RuntimeClient` or the existing `runtime request` command. Dedicated notification CLI commands can also target an explicitly selected verified HTTPS management endpoint or existing Docker owner; they do not start it or configure destinations there. Never combine selected-owner options with `--notifications-file` or local storage flags. Check the selected owner's installed capabilities; older owners may not support notifications. Exact-release clients use the separately guarded routes below, not management authority. Scoped preview tokens cannot invoke these management notification routes. The separate preview adapter exposes only its pinned, read-only history operation.

## Exact-release workflow apps

The exported app supports the same six notification operations, restricted to its immutable release ID, release checksum and workflow revision. Use `ReleaseClient`, or `node app.mjs request operation.json --endpoint <explicit-url> --token-file <private-token>` against a running release service. The client supplies the exact release guard. `node app.mjs serve --token-file <private-token> --notifications-file <private-config>` loads operator-supplied destinations without sending. Provision signing keys beforehand with the app's protected `credentials-set` command; no credential mutation API is exposed.

For a direct local job with no server, use `node app.mjs notify operation.json --notifications-file <private-config>`. The file is one strict `notifications.*` operation from the table above; omit `releaseSha256`, which the app supplies. `notifications.send` contains the retained reviewed request, not a URL, key or actor. Receipt/history reads and identical retries need no destination file. PostgreSQL apps additionally require `--database-file`; SQLite accepts `--data-dir`. Never open a competing direct owner while a service holds the same state.

The direct job validates the bounded JSON file with the release service's strict command schema before acquiring database ownership or loading destination/telemetry configuration. Malformed files, unsupported operations, invalid fields and caller-supplied release guards are refused without opening state. Valid commands still require the selected backend's explicit configuration, exact-release authorization and retained request pins; this preflight does not send, approve or retry anything.

For authorized private-CA recipients in local/extracted apps, Node's startup `NODE_EXTRA_CA_CERTS=<reviewed-CA-file>` can extend the runtime process's trust. This is process-wide trust that can also affect provider and OTLP HTTPS; it is not endpoint-specific and is distinct from the release client's `--ca-file`/SDK `ca` used to trust the API server. Do not copy another application's trust configuration or disable TLS verification. Default untrusted-certificate failure is retained as an uncertain transport outcome, not proof that a receiver performed no effect. Adding trust never permits replay of that retained request ID; a separately reviewed new predecessor-linked request is required for redelivery.

`notify` and `serve` accept optional private `--telemetry-file` configuration. SDK `ReleaseClient.operation(command, traceParent?)` forwards an explicit operation parent while preserving the exact release guard. With request observations enabled, a notification's persisted parent names the authenticated API span, which in turn references the caller parent. The signed event remains unchanged; no trace headers or baggage are sent to the notification recipient. Separate source-checkout records `qualification/release-notification-observability.json` and `qualification/release-notification-secure-telemetry.json` own the Node-only HTTPS/OTLP fixture scopes; production Collector retention/alerts, real recipients, workflow containers, forced termination and Kubernetes remain separate gates.

For a private-CA Collector, independently review its CA and destination. Provision the recipient and Collector roots in a reviewed startup CA bundle when both require additional trust; the API client's `ca` does not configure either outbound connection. Recipient-only trust must not authenticate an unrelated Collector. If export fails because its certificate is untrusted, an accepted notification remains accepted and its trace identity remains in the receipt. Adding Collector trust later does not resend or reconstruct lost telemetry. A separately authorized new delivery links the earlier retained identity even if that earlier span never reached the Collector. With `sampleRatio: 0`, spans are not exported, while independently enabled logs/metrics and retained unsampled trace identity remain available. Neither successful TLS nor an OTLP response proves backend retention or alerting.

Preparation and sending reject foreign runs even when their YAML revision matches. Receipt inspection, request-ID reuse, predecessor links and history cursors also enforce exact-release membership. History returns only matching deliveries and matching cursors, requires an explicit page, and retains the same live UUID-order semantics. Internally it scans bounded 200-record keyset batches, keeping at most one result page; this is not a release-specific index or a cross-batch snapshot. Sparse histories can require scanning the owner's retained notification history, bounded by its 100,000-delivery maximum. Unknown/foreign cursors fail rather than exposing foreign IDs.

The single-owner release token authorizes explicit notification sends as well as its other exposed operations; configuration itself is not delivery authority. Startup, history reads, decisions and restarts never automatically send. A direct `notify` send returns exit 0 for accepted HTTP, 5 for pending/uncertain, and 4 for rejected HTTP; generic `request` reports transport success, so inspect the returned delivery outcome. Release-app source integration does not by itself qualify an extracted ZIP, PostgreSQL deployment, container, Kubernetes workload or production recipient; those require their own current-byte evidence.

The single-owner bearer authorizes all exposed management operations. The API assigns its configured host actor; direct CLI jobs use `local:<username>`. Actor overrides are refused and actors are omitted from public notification receipts. This audit label is not multi-user business authorization. Identical send retries must use the same actor; after an actor change, inspect the retained ID instead of assuming another send is safe.

A disconnected HTTP client or client timeout does not cancel an admitted send. The service completes or times out the one delivery, retains its outcome, and drains admitted operations before closing storage. A short close deadline can report `draining`; it does not authorize killing the owner or replaying the request. Reconnect and inspect the original UUID. Sending notification metadata requires explicit authority independently of any authority to approve the workflow action.

## Explicit per-delivery abort

Use `notifications.abort` with the retained `requestId`, `runtime.abortApprovalNotification(requestId)`, or `approvals notify abort <request-id>` against the explicitly selected running owner. No actor, destination, key or signal override is accepted. The exact-release API checks receipt membership before signalling. Scoped preview tokens cannot invoke this route. One shared bounded HTTP control slot permits an abort while ordinary sends fill capacity; new requests are still refused after drain begins.

The result contains `schemaVersion: 1`, `requestId`, `status: "abort-requested" | "not-active"`, a redacted `receipt` snapshot, and `semantics: "process-local-signal; inspect-retained-send-outcome; no-effect-retraction"`. `abort-requested` acknowledges a signal to this process's active delivery, **not** its final settlement or proof that no POST arrived. Await the original SDK send or inspect its retained receipt. A response already observed can still settle as accepted; a stopped transport normally settles uncertain with reason `aborted`. If persistence fails, pending evidence stays pending. Repeated abort requests do not send or rewrite terminal outcomes and produce no new delivery telemetry.

`not-active` means no pending delivery controller exists in this owner now; it does not mean “not delivered.” After restart, retained pending intents remain pending and are never repaired, settled or replayed by abort. Unknown IDs are refused, not preemptively registered. A direct local CLI job cannot abort another process holding the same state: explicitly select that service, or use the same SDK owner. No discovery or alternate owner is tried. The CLI exits 0 for a valid acknowledgement even if its receipt is pending/uncertain. Workflow cancellation, external-effect retraction and redelivery remain separate operations requiring their own authority.

## Explicit SDK use

`LocalRuntime.open({ dataDirectory, notifications })` and `PostgresRuntime.open({ database, notifications })` accept independently supplied startup configuration. Import `PostgresRuntime` from `@jevable/core/storage`; both owners expose the same notification methods:

```ts
import { LocalRuntime, type NotificationRuntimeConfig } from '@jevable/core/runtime'

const notifications: NotificationRuntimeConfig = {
  endpoints: [{ id: 'review', url: 'https://receiver.example/events',
    credentialRef: 'notifications/review-key', timeoutMs: 5000 }],
  maxInFlight: 16, maxDeliveries: 10000, maxEvents: 20000,
}
```

Use an operator-authorized receiver, not the example domain. Provision its signing credential separately with `setCredential` or the existing protected credential CLI. Never embed it in workflow text, a URL, a command argument or a package. Configuration is copied/validated before opening storage; no configuration file, provider, desktop or service is discovered implicitly. Omitting endpoints disables new sends but preserves historical inspection and same-ID receipt reads.

1. Call `runtime.notificationDestinations()` for IDs and configuration hashes; it returns no URLs or credential references.
2. Call `runtime.prepareApprovalNotification({ runId, revision, attemptId, eventKind? }, endpointId)` to inspect the thin event and reviewed event/destination hashes. Preparation requires the verified current wait or selected recorded lifecycle evidence, but no signing credential or network request.
3. With explicit delivery authority, retain a fresh UUID and submit `runtime.sendApprovalNotification(request, actor, { signal })`. The strict request contains the prepared run/revision/attempt IDs, endpoint ID, endpoint/event hashes and `requestId`; omit the preparation-only `event` and `delivery` fields. `signal` is optional and belongs only to this delivery.
4. Inspect `runtime.inspectApprovalNotification(requestId)`. It omits the actor, destination URL and secret. Same-ID `send` retries read the retained receipt, even after approval settlement or endpoint removal; they never send again.
   To stop only an active delivery, call `runtime.abortApprovalNotification(requestId)` on this same owner and await the original send; the optional caller `signal` remains supported.
5. An explicitly authorized redelivery uses a fresh request UUID plus `redeliverOf` naming the latest retained request for this event/endpoint. Requested events need a current unexpired wait; lifecycle events need the same verified retained lifecycle evidence. Review duplicate-effect risk before requesting it.

For retained history, use `runtime.listApprovalNotifications({ limit: 100 })`, `notifications.list` with an explicit `page`, or `approvals notify list --page`. Follow `nextCursor` with `after` / `--after` until it is `null`. The limit defaults to 100 and is bounded to 1–200 on both backends. A supplied cursor must name an existing notification request in this owner; it is not a run, event sequence, timestamp or authorization token. Invalid/missing cursors fail rather than restarting a traversal.

Each page contains `deliveries`, `nextCursor`, `order: "request-id-ascending"`, `consistency: "live-keyset; not-a-snapshot"` and the delivery semantics warning. Entries include reviewed request pins, creation time, retained pending/terminal outcome and the actual delivery trace triple when retained. They omit the event body, node labels, actor, credential generation, destination URL, signing material and private review content. Use `show` for the retained detailed receipt. This is management-owner history, not a project/release-scoped or per-user inbox; no status or time filters are implied.

Order is immutable UUID identity order, **not chronological order**. Pages are live reads, not a cross-page snapshot: settlement may update an earlier entry, and a new UUID may sort before an already-used cursor. Start a fresh traversal to refresh outcomes or include such insertions; reaching `null` does not establish an eternal or point-in-time complete history. No automatic paging, polling, send, settlement or telemetry reconstruction occurs. History works after approval/restart and after destination configuration is removed, without resolving signing keys. PostgreSQL still requires its explicit independent database configuration. SQLite uses its existing primary-key index; PostgreSQL uses the journal's bounded keyset read and shared owner gate. Startup still validates all retained history. A configured PostgreSQL byte limit may require a smaller page; errors never silently truncate results.

Opening a runtime, executing a workflow, listing waits, preparing a notification and inspecting receipts never send notifications. An admitted send holds the runtime's operation guard: direct SDK close and credential/configuration mutations are refused while it is active. Abort stops only this delivery, records an uncertain outcome when possible and does not cancel the workflow or retract external effects. Await the send before directly closing the SDK owner; the HTTP host separately drains admitted handlers as described above. No background worker, automatic redelivery or delivery on restart is implemented.

SQLite schema 16 adds delivery snapshots/audit tables in the existing owner's initialization transaction. A failed migration rolls back the schema change; version-16 databases with missing delivery tables are refused rather than recreated. Older runtimes must not open schema 16. The same private runtime database/lock owns workflows, credentials and notification records; no second process or data directory participates. Keep operator backups before upgrading retained state; this is not a complete production migration/backup facility.

## Delivery engine

The core projects thin requested and recorded decided/expired/cancelled approval events from verified run journals as described above. Events contain run/revision/node/attempt identifiers, original expiry and optional project/release pins. They exclude review inputs, titles, action labels, actors, credentials and model payloads. Event IDs and bodies stay stable across delivery attempts. A notification describes an observed event; state can change while delivery is in flight. It never authorizes approval.

The explicit-send engine first prepares the event and endpoint fingerprints without resolving a credential or sending. A send requires a retained request UUID plus those reviewed fingerprints. An identical request UUID reads the existing receipt without redispatch, even if the approval has since settled or the endpoint configuration has been removed. Reusing an ID with different pins/actor fails. Another attempt requires a new UUID linked to the latest predecessor for the same event/endpoint, including after uncertain delivery. Redelivery of an actively sending predecessor is refused. This is one dispatcher per exclusive storage owner, not a distributed queue.

Before dispatch, the engine verifies the selected current wait/expiry or recorded lifecycle evidence, resolves the configured signing key and its retained generation atomically, and commits an intent carrying that generation (never the key). Explicit redelivery can use a rotated credential while preserving the event; each attempt records which generation it used. Endpoint configuration is supplied independently by an operator, never inferred from workflow text/imports. Each endpoint has an ID, HTTPS URL (or explicit loopback HTTP), credential reference and bounded timeout. URL credentials, query strings and fragments are refused. The transport performs one POST with TLS verification, no redirects, no automatic retries and no retained response body. It has no ambient proxy discovery. In-flight dispatch capacity is explicit and bounded.

The wire payload uses [CloudEvents 1.0 JSON attributes](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md). Signing follows the [Standard Webhooks v1 HMAC/header scheme](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md): a per-endpoint `whsec_` key, stable event ID, current attempt timestamp and exact serialized body. Receivers must verify signatures and timestamp tolerance, and deduplicate stable event IDs. These choices do not establish receiver identity, human delivery, business authorization or production compatibility by themselves.

## Retained outcomes

| Outcome | What is actually known |
| --- | --- |
| `pending` | An intent is retained. Dispatch or remote acceptance may or may not have happened. |
| `accepted` | A 2xx HTTP status was observed and its receipt committed; not evidence that a person received or approved anything. |
| `rejected` | A 3xx–5xx HTTP status was observed and committed; not proof the receiver made no side effect. Redirects are not followed. |
| `uncertain` | Timeout, abort, transport error or invalid response prevented a trustworthy HTTP result. No automatic retry. |

Intent-commit uncertainty exits before POST. Settlement-commit uncertainty never authorizes another POST on the same ID. A backwards wall clock cannot be hidden by fabricating a settlement timestamp; the existing pending intent remains for inspection. Do not convert pending/uncertain into “not delivered.” Explicit redelivery can duplicate a receiver's external effects.

The SQLite adapter uses the owning core database, not a second independently opened runtime. It reserves intent/settlement capacity before admitting dispatch, writes snapshots and audit entries atomically, retains predecessor chains, validates journal/snapshot agreement on activation and refuses repair-by-overwrite. Effective delivery capacity is the smaller of `maxDeliveries` and half `maxEvents`; lowering limits below retained history refuses activation. The dispatcher/persistence interfaces require a sole exclusive owner; constructing multiple dispatchers over one owner is not supported.

The PostgreSQL adapter uses the same independently owned journal connection and shared domain queue as workflow execution. A new intent atomically commits its delivery record, latest event/endpoint predecessor head and audit entry with expected-version checks and the journal's owner/epoch fence. Run decisions and cancellation cannot interleave the final verified-wait check and intent commit. Settlements are immutable pending-to-terminal transitions. Activation checks the full notification audit against snapshots, predecessor heads and verified run histories; it never dispatches. Credential value and generation come from one verified row read.

PostgreSQL notification limits reserve two domain audit entries per delivery. They do not reserve space against other domains in the shared journal: global record/event/batch/byte limits or database errors can still refuse a settlement after an HTTP effect. Keep such receipts pending and inspect the original ID; never replay automatically. Ownership loss aborts the active HTTP attempt and fences persistence, without reconnecting or cancelling the workflow. A replacement owner reads retained evidence only. This is single-owner delivery, not a multi-replica queue or exactly-once receiver guarantee.

Activation and receipt reads verify notification run/revision/project/release pins, node-intent identity, the unique approval-requested event and any selected lifecycle settlement against retained workflow history. New approval journals retain the exact expiry, allowing deadline comparison after a decision. Legacy approval journals are not rewritten: while waiting, the snapshot supplies the deadline; after settlement, their requested-notification receipt retains the previously observed deadline without independent historical proof. New lifecycle preparation requires a recorded deadline. Checksums and local journals detect inconsistency, not an attacker who can rewrite all related evidence. A final synchronous wait/lifecycle check immediately precedes SQLite intent admission; a workflow can still change after admission or while a network request is in flight.

## Opt-in notification observability

With explicitly configured [OpenTelemetry](telemetry.md), SQLite and PostgreSQL management owners observe new explicit sends. The existing private `--telemetry-file` applies alongside `--notifications-file`; it neither configures a receiver for notifications nor authorizes delivery. HTTP/protobuf and gRPC use the existing bounded exporters. Without telemetry configuration, no delivery trace context is created or exported.

An admitted intent retains optional `telemetry` metadata: its actual `trace`, the observed verified `workflow` segment, the previous delivery's trace when available, and the explicit API/SDK `parent` when present. This metadata is immutable through settlement. It is committed before invoking notification transport, separately from the signed event: webhook bodies and event IDs do not change, and no traceparent/baggage is added to receiver requests. Explicit redelivery gets a new span linked to the retained workflow and predecessor. Startup checks those stored workflow/predecessor associations; identifiers are correlation evidence, not authorization or proof of collector retention.

The span is `jevable.notification.delivery`; the structured log event is `jevable.notification.delivery.ended`. Both carry fixed metadata: run/revision/attempt/request identifiers, event/destination fingerprints, the four-value `jevable.notification.event_kind` and applicable trace links. They omit actors, destination names/URLs, credential references/values, review inputs, webhook bodies/headers, responses and raw exception text. Logs use the same actual trace/span identity even when traces are unsampled or disabled. Metrics/logs-only operation retains unsampled identity without claiming a trace was exported. Existing delivery counters aggregate event kinds; the kind is not a new metric label.

The counter `jevable.notification.attempts` and histogram `jevable.notification.duration` observe ended explicit-send attempts, not unique deliveries or human receipts. Their only labels are `jevable.notification.outcome`, `jevable.notification.intent_acknowledged`, `jevable.notification.transport_attempted` and `jevable.notification.settlement_acknowledged`. No request/run/event/destination IDs become metric labels. Duration covers instrumentation and intent/transport/settlement, not preparation or credential lookup. Process-local counters reset on restart.

| Observed outcome | Interpretation |
| --- | --- |
| `accepted`, `rejected`, `uncertain` | The corresponding receipt settlement was acknowledged to this process. |
| `intent-not-acknowledged` | Admission failed or its acknowledgement was lost. This invocation did not call transport; a committed intent may still exist. |
| `settlement-not-acknowledged` | Transport was invoked but settlement acknowledgement was not obtained. Inspect the durable receipt; the database may already contain a terminal outcome. |
| `receipt-only` | A raced admission found the ID already retained; no new transport invocation occurred. |

`transport_attempted` means the transport function was invoked, not that bytes reached the receiver. `*_acknowledged` describes this process's observation, not an independent commit proof. Rejected/malformed requests before observation do not increment this counter. Ordinarily, existing-ID receipt reads, inspection, preparation and startup create no delivery spans/logs/counters and never reconstruct historical telemetry. A raced new admission can produce the separate `receipt-only` observation. Older receipts without telemetry remain unchanged; enabling telemetry later does not invent missing historical links.

Exporter failure never changes the delivery receipt or permits redispatch. Failed/unacknowledged admission spans may have no matching retained intent. Process loss can leave an intent trace whose span/log never ended or reached a collector. Always use the retained receipt and workflow journal to resolve uncertainty. No notification OTel destination, dashboard, alert recipient or browser integration is discovered implicitly; production receiver/TLS/networking and deployment qualification remain separate.

## Remaining integration and release gates

- Qualify explicit per-delivery abort and filtered history in remaining independent-package/PostgreSQL/deployment profiles. The API still drains admitted sends and never treats client disconnect as cancellation. Browser filter controls, atomic snapshots and indexed status/time queries remain separate.
- Broaden PostgreSQL fault/deployment qualification beyond the notification-specific lost-intent/lost-settlement-COMMIT fixtures, including forced-process interruption and production database operations.
- Qualify the project-scoped read-only preview history panel in actual browsers and independent packages/backends. Broader notification actions/configuration remain owner-only; preview tokens cannot use exact-release metadata/prepare/send/show/list/abort routes or management notification operations directly. Docker management configuration does not by itself qualify workflow-release containers or clusters.
- Qualify recorded decided/expired/cancelled events across the remaining deployment/interruption matrix, and separately design any reviewed opt-in automatic delivery policy. Current lifecycle delivery is explicit only. Opening a skill, viewer, runtime or inbox must not silently configure outbound delivery.
- Qualify notification observability in deployed workflow/management containers, approved cluster/backend profiles, production endpoint TLS and authorized real receivers; local SDK/CLI/API and extracted-management fixtures do not establish those deployment properties.
- Keep browser inbox/notification controls, multi-user assignment and business approval authority separate. No real notification recipient has been contacted by the local fixture tests.

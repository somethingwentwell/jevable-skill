# Approval inbox and decisions

`jevable approvals list --page` lists retained Human Approval waits. It is a read-only inbox, not notification delivery, an approval permission grant or an automatic decision/expiry worker.

```sh
node bin/jevable.mjs approvals list --page --limit 100 --data-dir .jevable
node bin/jevable.mjs approvals list --page --after <last-scanned-run-id> --limit 100 --data-dir .jevable
```

Use the actual `nextCursor` from each response. Continue until it is `null`, **including when `tasks` is empty**. Each page scans at most 200 run summaries (default 100); completed, failed, cancelled, paused and executing runs occupy scan positions but do not produce tasks. Waiting candidates are checked again against current retained state. `changedCandidates` counts those no longer waiting by the time they were read.

This is live run-ID ordering, not a snapshot or an oldest-first queue. A run behind the current cursor can later reach approval, so restart from the first page on an explicit refresh. Refreshing never starts/resumes a workflow, repeats a model call or decides an approval. SQLite metadata pages select IDs before reading payloads; exact-release pages use an index on the release ID, release hash, workflow revision and run ID. They do not load unrelated run payloads. PostgreSQL uses its existing bounded page/scoped-reader contracts. Large/corrupt retained records or unavailable storage fail the report rather than returning a partial inbox.

The SQLite index is added transactionally on owner startup without changing the stored record format or approval/event history. Existing owners still validate retained state on startup: bounded page reads are not a claim of bounded startup time. A malformed legacy record prevents index creation and startup rather than being silently skipped or repaired. Legacy unpaged `runs.list` retains its original complete-list behavior; use explicit pages for bounded reads.

## Inspect, then decide

Tasks retain run/revision, node and attempt IDs, expiry, observation time and optional project/release/test pins. They exclude review inputs, titles, action labels, actors, credentials and model payloads. Identifiers can still be sensitive; review them before sharing.

- `not-expired-at-observation` is not a promise that a task is still eligible when a later decision arrives.
- `expired-at-observation` means the retained expiry time has passed. Listing does not settle or remove that wait.
- `cancellationRequested: true` means a cancellation request is retained. Do not infer eligibility or reverse it.

Use `jevable approvals show <run-id>` on the same owner to inspect the actual current review data and allowed actions. Submit `approvals decide <run-id> --attempt <reviewed-attempt-id> --action <authorized-action>` only with authority for that particular decision. `--pause-after` can stop an authorized approval before downstream execution. Runtime guards enforce the current attempt and expiry; an old inbox row does not override those guards. A stale, expired, cancelled or already-decided task must be inspected, not retried with a replacement identity.

The experimental preview can explicitly settle an already elapsed review through the owner API's `approvals.decide` with `expireOnly: true`, after an owner-side deadline observation and a human confirmation. This option is not a CLI flag or an automatic timer. The runtime rechecks the exact attempt and deadline and refuses before a business decision when the deadline is not yet past. A terminal timeout records expiry with no later node; a configured timeout branch can continue, so the preview submits `pauseAfter: true` and requires a separate explicit continuation before downstream work. A changed or uncertain result still needs read-only inspection of that same run, not a new action or assumed rollback.

Reading `approvals show` exposes private review data, unlike the inbox. Permission to test a workflow is not permission to approve its business actions. The single-owner API token permits technical access to the exposed operations; it does not establish business authorization for an agent.

## Backends and SDK

The normal CLI accepts explicit SQLite/PostgreSQL configuration, [Docker owner](docker-owner.md) flags or an [HTTPS endpoint](remote.md). When a service owns the state, use its API instead of opening a second direct owner. No desktop/Jarness state, credential discovery or automatic fallback is involved.

Management and exact-release services accept:

```json
{ "operation": "approvals.list", "page": { "limit": 100 } }
```

`page` is mandatory on both backends; `{}` requests defaults. Exact-release requests retain the normal release-hash guard. They only return that release's tasks and cursors, reject a foreign cursor, and include the exact release pin even for an empty inbox.

Exported workflow apps support `node app.mjs approvals --page [--after <cursor>] [--limit <1-200>]` with their independent `--data-dir` or `--database-file`. They do not need the skill or an authoring server.

`@jevable/core/runtime` and the PostgreSQL-safe `@jevable/core/storage` entrypoint export `createApprovalInbox`, its host/page/result types and `APPROVAL_INBOX_LIMITS`. Supply verified owner reads; a checksum or arbitrary caller-provided object is not a substitute for runtime validation:

```js
const inbox = await createApprovalInbox({
  listRuns: ({ after, limit }) => runtime.listPage(after, limit), // SQLite
  showRun: id => runtime.show(id),
}, { limit: 100 })
```

For PostgreSQL, use `runtime.list(after, limit)` instead of `listPage`. SQLite also exposes `runtime.listReleasePage({ id, sha256, revision }, after, limit)` for exact-release metadata, rejecting cursors outside that pin. The host must return ordered metadata pages with a truthful continuation cursor, and checked full runs for selected IDs. The projector excludes private fields and bounds candidate bytes to 64 MB and report bytes to 4 MB. It has no execution or notification method. For a release-scoped integration, prefer the exact-release API so its membership guards cannot be omitted accidentally.

Browser inbox controls, multi-user assignment and production approval authorization remain separate capabilities. This inbox does not implement them. For experimental SQLite/PostgreSQL management notifications through the SDK, `approvals notify` CLI and authenticated API, read [notifications.md](notifications.md). Scoped routes and notification deployment qualification remain open. Notification delivery never grants approval authority.

# PostgreSQL SDK runtime and storage

Status: experimental standalone PostgreSQL execution SDK, including reviewed projects, immutable releases, saved tests and opt-in OTLP execution traces/metrics/logs. `PostgresRuntime` retains run checkpoints, approvals, cancellation, test expectations and configured model evidence in PostgreSQL; it does not start a server. For persistent management HTTP/HTTPS, explicitly use [`startPostgresRuntimeService` from `@jevable/core/http/postgres`](http.md#postgresql-management-service). `LocalRuntime` uses SQLite. Exported apps can pin either storage implementation at release creation. Direct CLI jobs explicitly select PostgreSQL with `--storage postgres --database-file <private-file>`. Management startup supports `runtime serve --storage postgres --database-file <private-file>` with explicit private configuration and signal-driven drain. Experimental [PostgreSQL preview](live-preview.md#preview-with-postgresql-storage) uses the same scoped HTML/protocol with loopback-only serving and a retained project UUID. Browser qualification, production database provisioning/migration/restore, Kubernetes qualification and multi-replica execution remain open. The [local container profile](images.md#run-independently-with-postgresql) separately qualifies exact release images with database TLS and retained execution. Do not connect it to an existing Jevable/harness database or treat generic journal records as validated workflow state.

## Direct CLI jobs

Direct jobs do not need a running HTTP service, Docker or Jarness. Provision a private database and the owner-only JSON configuration described in [HTTP setup](http.md#postgresql-management-service), then select it explicitly on every invocation:

```sh
node bin/jevable.mjs run workflow.yaml --input input.json --id <retained-run-uuid> \
  --storage postgres --database-file /private/jevable-database.json
node bin/jevable.mjs runs show <run-id> \
  --storage postgres --database-file /private/jevable-database.json
node bin/jevable.mjs runs list --page --limit 100 \
  --storage postgres --database-file /private/jevable-database.json
```

The same flags support `check`, provider/credential setup, project review/lifecycle/run, JSON/ZIP project transfer, saved tests/generation/results, run controls/approvals/evidence and release metadata (`create/list/show`). Each invocation opens the owned SDK, awaits committed operations and closes it after flushing configured telemetry. An existing service/SDK owner of the same namespace returns `busy`; use its authenticated API or stop only an instance you own. No HTTP listener or SQLite fallback is started. Omission still selects SQLite. Do not combine PostgreSQL with `--data-dir`. Model calls and approval decisions require the same authority as on SQLite.

PostgreSQL `runs list`, `tests list`, `tests generations`, `projects deletions`, `providers audit` and `releases list` require `--page`. `--limit` is 1–200 (default 100). Record pages return schema v2 and `nextCursor`; pass it as `--after` until it is `null`. Provider audit uses a decimal-string `cursor`; an empty page retains the supplied cursor, so stop on an empty events array. Never convert PostgreSQL sequences/versions to JavaScript numbers. `projects list` and `providers list` are bounded complete lists, not page commands. Pages describe live keyset reads, not a frozen snapshot. SQLite retains its unpaged receipts; explicitly requesting `--page` selects v2 without changing old callers.

Retain run/control UUIDs and reviewed hashes before execution. Direct workflow exit codes are unchanged (including waiting/paused 3, uncertain 5 and cancelled 7); `runs show` and cancellation submission are read/receipt success, not evidence of workflow completion. A lost command response is not permission to create a new UUID. `runs export --output evidence.json` writes the v2 read-only evidence snapshot. Imported test receipts enumerate all drafts for the new project across pages and never silently return the first page; they do not accept or run those drafts.

Direct jobs do not inherit the persistent service's graceful signal handler. Forced interruption may leave uncertain committed intent: reopen and inspect the original identity without redispatch. Full direct-process interruption qualification is still pending. `preview --serve --storage postgres` is a persistent loopback session, requires `--database-file`, `--token-file` and a retained fresh `--project-id`, and uses signal-driven drain. It never attaches to a committed preview project implicitly. `releases create` defaults its runtime profile to the authoring backend; use `--runtime-storage sqlite|postgres` to select it explicitly. `releases export` and `releases build-image` resolve the saved runtime checksum without changing the release. Creating metadata alone still does not deliver an app. The installed core can explicitly serve a reviewed snapshot through the [exact-release SDK/CLI service](http.md#exact-release-serving), with authoring/configuration operations excluded. The [exported PostgreSQL app](releases.md#select-the-runtime-backend) includes its JavaScript driver and runtime, verifies the actual bundle bytes and requires `--database-file` for stateful commands. No credentials or originating database state are packaged. Container execution has a separate exact-artifact [local Docker profile](images.md#run-independently-with-postgresql); do not infer production database or Kubernetes qualification.

## Owned implementation

`@jevable/core/storage` exports `PostgresRuntime`, `PostgresJournal`, `JournalError`, `PostgresProviderStore`, `PostgresProjectStore`, `PostgresReleaseStore`, `PostgresTestStore`, `PostgresRunStore`, `ConfiguredModels` and their public types. The implementation and schema belong to this core; they do not import harness storage, credentials, coordination services or workspace packages. `pg` is a pinned normal production dependency. The SQLite release runtime does not bundle or require the PostgreSQL driver.

Opening the journal requires explicit host, port, database, user, password, namespace, `initialize` and TLS policy. It does not discover credentials, accept connection URLs, use a connection pool or reconnect automatically. Opening a journal establishes a database connection; simply importing the module does not.

For configuration discovery use `schemas show postgres-config`. To validate an already supplied in-memory object without loading the database driver, import `parsePostgresConfiguration` from `@jevable/core/storage/configuration`. This is the same parser used by journal startup, with the same sanitized `JournalError` identity; it checks explicit fields, literal-loopback test policy and supplied PEM CA validity, and returns detached normalized configuration. Do not print that return value: it contains the supplied password. It does not read/protect a file, connect, verify credentials, initialize storage or acquire ownership. The structural schema alone omits those semantic checks; protected file admission still applies to CLI/service input.

## Operator credential and TLS changes

Database credentials and server TLS material are operator-managed, not automatically rotated by this runtime. A password change or `NOLOGIN` must not be treated as eviction of existing sessions. Drain owners you control; if immediate revocation is necessary, identify and separately terminate only the authorized database sessions. Reopen explicitly with the reviewed protected configuration and inspect retained run IDs. Do not rerun workflows or approve a retained wait to test new credentials.

A successful `pg_reload_conf()` result acknowledges the reload request, not installation of the new certificate. PostgreSQL can reject malformed certificate data, a mismatched key or unsafe key permissions and keep the previous TLS context active. Check the actual server diagnostics and a **fresh** verify-full connection's certificate identity; an existing connection may still use its earlier TLS session. Do not disable verification, relax key permissions or infer success from `pg_isready`. [PostgreSQL SSL reload behavior](https://www.postgresql.org/docs/17/ssl-tcp.html#SSL-SERVER-FILES).

Retain the last reviewed valid certificate/key and make rollback an explicit operator action. Verify a new connection after rollback as well. Self-signed local fixtures do not qualify managed CA chains, expiry/CRL/client-certificate policy, deployed rotation or active external-effect recovery. This SDK has no automatic reconnect or replay path for lost ownership; inspect the original journal and reconcile uncertain effects before any newly authorized work.

## Experimental execution SDK

`PostgresRuntime.open({ database, maxRuns?, maxTransitionsPerRun?, telemetry? })` owns one exact database session/namespace and the configured-model adapter. `database` is the explicit `PostgresJournalOptions` object described above; no existing journal instance or custom model executor is accepted. The host uses the core's default compiler limits. Run capacity defaults to 10,000 and retained node-intent capacity to 10,000 per run. Unknown options and malformed telemetry policies are rejected before opening storage.

```js
import { readFile } from 'node:fs/promises'
import { PostgresRuntime } from '@jevable/core/storage'

const database = JSON.parse(await readFile('postgres.private.json', 'utf8'))
const runId = process.argv[2] // Retain this UUID before submitting; reuse it to inspect a lost response.
if (!runId) throw new Error('Supply a retained run UUID')
const runtime = await PostgresRuntime.open({ database })
try {
  const yaml = await readFile('echo.yaml', 'utf8')
  const run = await runtime.run(yaml, 'Hello', { id: runId })
  console.log({ id: run.id, status: run.state.status })
} finally {
  await runtime.close()
}
```

Keep the configuration file private. Database creation/provisioning is an operator responsibility; this SDK does not start Docker or PostgreSQL. `loopback-test` is plaintext test transport, not a production deployment profile. Verified database TLS/provisioning qualification remains open.

The asynchronous methods are `run`, `show`, paginated `list`, `events`, `check`, `resume`, `advance`, `decide`, `cancel`, `health`, `connections`, `configureConnection`, `credentialStatus`, `setCredential`, `providerAudit` and `close`. `show` and `events` contain private payloads; `list` omits them. `run` accepts only `{ id?, paused? }`, never project/release/test provenance. Reusing the same run UUID and original source/input/options returns retained state without executing it. Different content conflicts, including after cancellation.

Use `advance(id, { requestId, expectedCheckpointSha256, mode: 'step' | 'continue' }, actor)` for guarded controls and exact control-request retries; compute the hash with `executionCheckpointHash` from `@jevable/core/runtime`. Plain `resume` is an explicit new continuation, not a retry token, and refuses executing/uncertain checkpoints. `decide(id, attemptId, action, actor, { pauseAfter? })` requires the saved waiting attempt and configured action; an elapsed deadline records expiry instead of accepting the action. The embedding application must authenticate actors and authorize decisions—this SDK does not supply multi-user approval authority.

`cancel(id, requestId, actor)` commits cancellation before signalling an active model call. A submitted request is not proof execution has stopped: inspect until the run is cancelled or terminal. Cancellation may conflict with a concurrent checkpoint version; no abort occurs unless its write succeeds. It cannot undo external effects. Database owner loss aborts model transport, poisons that host and preserves uncertain intents; it never reconnects or redispatches. After an uncertain response, close the failed owner and reopen explicitly, then inspect the original run identity.

One execution/control operation owns a run at a time. Provider mutations exclude all pending host operations, active execution, explicit telemetry flushes and in-flight automatic exports; reads/execution also refuse admission during a configuration mutation. Direct SDK `close` refuses while execution/reads/configuration are pending, seals new admission once accepted, flushes exporters before releasing their credential storage, joins admitted flushes and closes the exact owned session. Await admitted operations (or request cancellation and await settlement) before closing. The separate management service seals HTTP admission and drains its own requests before calling this idle-close API; neither implements forced shutdown. Startup verifies projects, deletion receipts, releases, test histories/generation records and run checkpoints without executing them; corrupt startup data closes the acquired owner and requires explicit repair.

### Evidence snapshots

`await runtime.exportRun(id, includePrivate = false)` returns a coherent, read-only v2 evidence envelope. It includes exact decimal PostgreSQL sequence/version identities, reviewed project/release/test pins, available attempt/timing/trace metadata and a snapshot checksum. Payloads and actors are excluded unless explicitly requested. The domain gate covers the checkpoint, journal, historical references and model-evidence validation, so supported concurrent writes cannot produce a mixed snapshot. It never dispatches or resumes execution. See [evidence.md](evidence.md#postgresql-v2-snapshots) for privacy, limits and the v1/v2 distinction. The storage package exports the `PostgresRunEvidence` type; the lower-level run adapter exposes `evidence(id, includePrivate?)`.

### PostgreSQL telemetry

Pass the same explicit `telemetry` configuration documented in [telemetry.md](telemetry.md). Export is disabled by default; no desktop settings, environment-derived collector or ambient credentials are used. `telemetryStatus()` is a synchronous process-local snapshot, also readable after close; `telemetryFlush()` is asynchronous. `health()` includes that status. `withTraceParent(header, () => operation())` admits only the documented W3C version-00 parent format. No baggage or tracestate is imported.

For bearer authentication, first provision the referenced credential with `setCredential` in this namespace, then reopen with telemetry enabled. Missing credentials refuse startup and release the owner. Every export reads the current credential asynchronously from the owned PostgreSQL store; it does not cache a secret or read SQLite/desktop state. The request timeout includes credential lookup. Lookup/collector failures produce sanitized exporter health and never retry execution. Automatic exports defer while a provider mutation is pending, retaining queued records; provider mutations refuse while an export is active. A flush timeout can return before a request finishes, so a subsequent mutation can still return `busy`.

The journal retains execution segments and node trace identities before dispatch. Approval, resume and cancellation segments link to the prior retained context across owner replacement. The resource includes `jevable.storage.kind: postgres`; `jevable.runtime.mode: local` means the SDK process executes locally, not that SQLite is used. Read-only reopen and exact run/control retries do not re-export old execution. Metrics/logs can be enabled without trace export; retained unsampled IDs then support correlation but do not imply a delivered trace. Collector outage does not erase these identities or change a completed workflow into a failed one.

This is SDK execution telemetry, not full database/API instrumentation, a PostgreSQL-backed HTTP deployment profile or cluster observability. A lost trace-segment commit acknowledgement remains `commit-uncertain`: end the old owner and inspect the original run before explicitly deciding whether to continue. Telemetry delivery is never evidence that an uncertain external action can safely be retried.

### Reviewed domain execution

The host also exposes asynchronous `projects`, `project`, `editProject`, `diffProject`, `exportProject`, `inspectProjectImport`, `importProject`, `releases`, `release`, `createRelease`, `testCases`, `testCase`, `testHistory`, `editTest`, `generateTests`, `testGeneration` and `testGenerations`. Their command/review formats match the typed adapters below. Projects return a bounded complete array; releases, cases and generation summaries use explicit `{ releases | tests | generations, nextCursor }` pages. The host's generation list omits case definitions; `testGeneration` returns the private full batch. These asynchronous/paginated shapes are not a drop-in replacement for the synchronous SQLite metadata API.

- `runProject(id, expectedGeneration, reviewedRevision, input, { id: runId, paused? })` executes only the current accepted revision of an unarchived project. It records the exact project generation. A proposed revision is not executable through this path until explicitly accepted.
- `runRelease(snapshot, input, { id: runId, paused? })` verifies and retains the immutable snapshot, then records its release ID/checksum on the run. It does not require the origin project to remain active or present. Snapshot creator/project fields remain provenance, not local approval authority. This SDK uses its installed evaluator; it does not fetch, install or attest runtime bytes named in a snapshot. Use the separately qualified release packaging path for an exact runnable application artifact.
- `runTest({ id, generation, sha256 }, runId)` requires the current accepted case and its exact current project generation/revision. `testResult(runId, inspect = false)` re-evaluates retained evidence against the historical accepted case pinned by that run. There is no mutable result row and no model dispatch during assessment. A failed expectation is distinct from workflow failure. Explicit `inspect: true` adds expected/actual assertion values; even default results include a run receipt that may contain private workflow output. Neither form is a public-data projection.

Retain each run UUID before submission. An identical request retrieves the same retained run/result after edits, archival or reopening; it never resumes or dispatches again. New execution uses current review guards. Project/test review is rechecked after asynchronous model admission, under the same owner-local mutation queue as the run's creation write, so a concurrent edit cannot slip an unreviewed definition into execution. Subsequent edits do not rewrite the evidence or expectations of a run already admitted. Raw journal mutations are unsupported.

Project/test authoring, schema generation and imports do not execute workflows. Imported tests remain fresh drafts requiring local acceptance. Generation samples suggest assertions, not branch coverage. The CLI can explicitly host the PostgreSQL management service or own a direct SDK job; cluster deployment remains unfinished.

The initial supported server family is PostgreSQL 17. Recorded real qualification includes PostgreSQL 17.11 on Linux arm64 in a local Docker engine, and a current installed-package reviewer journey against private PostgreSQL 17.11 on macOS loopback. Neither is a production cluster or broad version matrix. Other major versions fail with `version-mismatch` until deliberately supported and tested.

- Production configuration uses `tls: { mode: 'verify-full', ca?: pem }`, with certificate verification and minimum TLS 1.2. Explicit CA replaces default trust. This database TLS path still needs real certificate/hostname qualification; the HTTP service's TLS tests are not evidence for it.
- `tls: { mode: 'loopback-test' }` permits plaintext only to the literal addresses `127.0.0.1` or `::1`. It is a fixture/development mode, not a cluster deployment profile.
- Supply credentials through a private application configuration loader, never command arguments, generated manifests, public receipts or preview HTML. The low-level journal stores the JSON values its caller explicitly supplies; it is not a secret encryption or redaction layer.
- `initialize: true` explicitly creates the owned `jevable_journal` schema/tables and namespace metadata. It requires DDL privileges and is not a general migration tool. `initialize: false` refuses missing metadata. Least-privilege provisioning, schema migration and backup/restore remain separate work.

## Transactions and ownership

Each namespace has one dedicated session holding an exclusive advisory lock. Opening a second owner returns `busy`; another namespace may have its own owner. A successful new owner increments a durable epoch. Every queued operation locks and checks that namespace's owner/epoch row in the same transaction as its reads or writes. This is single-owner storage, not a distributed lease or external-effect fencing guarantee.

`commit(batch)` atomically writes version-checked records, append-only events and a retained receipt. Every batch has a caller-retained UUID. The same admitted content and UUID return the original receipt, including after reopening; different content under that UUID is a conflict. Duplicate changed identities and events unrelated to a changed record are refused before database mutation. Tombstones retain versions so deletion/recreation cannot reset a record's concurrency guard to zero.

Admission bounds JSON size/depth, clones data before queueing and rejects malformed identities. Batch retry hashes use sorted keys, but record/event payloads preserve admitted JSON key order so existing checkpoint and test-definition hashes remain stable after read/reopen. A batch admits at most 1,001 record changes and 1,001 events, allowing one project plus the bundle format's maximum 1,000 test drafts in one transaction; configured byte/value/capacity limits still apply. Transactions run sequentially on the same connection. Namespace capacity limits are explicit and count tombstones and retained evidence; exhausting capacity does not silently evict data. Decimal string versions, epochs and event cursors preserve BIGINT precision. Event sequence gaps are allowed; a rolled-back transaction need not reclaim an allocated sequence.

Receipts expose `recordedAt`, a database timestamp captured inside the transaction, not the independently observed commit instant. Receipt hashes identify admitted content; they are not signatures or independently attested external outcomes. Reads validate structural bounds, not the workflow-domain replay invariants currently enforced by the SQLite stores.

`get`, `count`, `records`, `receipt`, `events` and `health` are fenced database operations, not cached success indicators. `count(collection)` counts live records without loading private payloads. `records(collection, limit)` returns a complete bounded live-record snapshot or fails; it never silently truncates the collection. Event pages optionally filter selected collections. `close()` aborts the ownership signal, rejects new work, drains already admitted journal transactions and ends the exact owner connection. Pending higher-level commands not yet admitted to the journal may fail rather than drain; await them before deliberate shutdown. Connection loss or ownership mismatch also aborts `signal` and makes the owner unusable. There is no reconnect or automatic resubmission.

`page(collection, after?, limit = 100)` returns `{ records, nextCursor }` ordered by UTF-8 keys, excluding tombstones. Pass the last non-null cursor into the next call; null means the observed page reached the end. Each page is bounded by at most 1,000 records and the configured byte budget. A page is a fenced transaction, not a snapshot spanning all pages: concurrent insertions before the cursor are not included retroactively. Use an idle owner when a complete inventory must describe one unchanged collection. Page byte-limit failures are explicit, not silent truncation.

If the COMMIT acknowledgement is lost, the caller receives `commit-uncertain`. Preserve the batch UUID and exact contents; open a new owner only when the old owner has ended, then inspect `receipt(id)` or submit the identical batch to retrieve its retained result. Storage retry identity does not authorize retrying a model call, sending a message, approving a business action or repeating any other external effect.

## Typed provider adapter

Construct `new PostgresProviderStore(journal)` to read/change provider connections and credentials with exact generation guards, inspect metadata-only audit pages, and retain model evidence. Reads validate the record identity, generation and schema. Adapters sharing the same journal serialize provider mutations, including collection capacity checks. Do not bypass them with raw writes to their collections; the generic journal is an internal storage primitive, not a second supported provider-management API.

`new ConfiguredModels(store)` uses the same transport and response validation as the default SQLite-backed adapter. The `ProviderPersistence` port permits asynchronous reads and writes. Admission awaits actual connection/credential reads; no HTTP dispatch precedes acknowledged pending evidence, and no model result is returned before its terminal evidence is acknowledged. The store's owner-loss signal cancels an active HTTP call without classifying database loss as a retryable provider error. Pending evidence never authorizes redispatch; a completed retained response may be verified without contacting the provider again.

All provider-store operations are asynchronous. `auditEvents(after?, limit?)` returns `{events, cursor}` with decimal-string event sequence numbers. Audit events exclude secrets and request/response payloads; the private credential/model record tables intentionally contain their admitted values. A fresh pending attempt is insert-only and may acquire exactly one terminal settlement for the identical saved route/request. Failed storage acknowledgements retain uncertainty; no automatic retry policy is introduced.

In a test or explicit SDK integration, pass `models: new ConfiguredModels(providerStore)` to `LocalRuntime.open`. The caller owns the PostgreSQL journal lifecycle and must prevent provider setup/rotation from racing active executions; full runtime-wide configuration ownership is not yet integrated. This is a mixed-storage configuration, not a Kubernetes deployment profile or an atomic transaction across SQLite and PostgreSQL. The qualification fixture uses it to verify evaluator/approval integration without falsely claiming that run state has moved to PostgreSQL.

## Typed project/review adapter

Construct `new PostgresProjectStore(journal, DEFAULT_COMPILER_LIMITS.source)` using compiler limits exported from `@jevable/core`. This adapter and the SQLite project store use the same owned `ProjectLedger` for commands, replay, revision hashes, historical generations, import provenance and approval-change acknowledgement. Every read replays and validates the retained project history. PostgreSQL also checks the envelope generation and local storage version; imported source history is provenance, not fictitious local database commits.

Await `execute(command)` for create, propose, accept, reject, restore, rename, archive/unarchive and accepted-revision duplication. `get`, `list`, `diff`, `export` and `import` are asynchronous; `inspectImport` only parses local data and is synchronous. Use exact expected generations and reviewed revision hashes. Acceptance and restoration require acknowledgement of changed Human Approval nodes. No authoring operation starts a run or calls a model.

Provider and project mutations share an owner-local queue. Project records and metadata-only events commit atomically. The 1,000-project capacity guard is serialized across adapter instances; listing fails explicitly if the complete snapshot exceeds journal byte limits. Commands are cloned at admission. Raw journal writes to typed collections are unsupported because they bypass domain rules.

JSON imports accept project-only bundles and version-2 bundles containing saved test definitions, including history from independent SQLite owners. Imports create fresh local project/test identities and retain source provenance. The project, every remapped test draft and their metadata-only audit events commit in one transaction, never in separately committed chunks. All tests require fresh local acceptance, even when the source marked them accepted. Their definitions pin the newly imported project's generation/revision; source IDs, hashes, status and project pins remain provenance. Archived history can be imported and inspected, but does not bypass current-project guards for later acceptance.

The import checks the reviewed bundle SHA-256, definition hashes, input schema, expected node references, configured compiler limits and project/test capacities. Invalid definitions and a late SQL failure leave no partial project, tests, events or reserved project identity. To customize schema/binding admission, the project's constructor accepts a fourth `testLimits` argument (`Omit<WorkflowCompilerLimits, 'source'>`); the constructor's source limits still apply. Use the same limits as the intended test/runtime adapter. No model call, workflow run, credential or prior run result is imported.

Retain an explicit `newId` when calling `import(json, reviewedSha256, actor, newId)` so an uncertain commit can be inspected. Once the old owner ends, inspect that project and its test summaries with the new owner; retrying an already used project ID conflicts instead of creating a second draft set. For explicit removal, use the guarded deletion operations below.

`export(id, expectedGeneration, reviewedRevision, history = false, includeTests = false)` is read-only. By default it returns a version-1 project-only bundle and does not inspect or expose tests. Explicit `includeTests: true` (the fifth positional argument) returns a version-2 bundle containing the latest definitions for that project's accepted revision. Original case IDs/generations/hashes, project pins and draft/accepted status remain source evidence; `excludedOtherRevisions` counts omitted definitions from other revisions of that project. Tests from unrelated projects are not exported. Test history, run results, generation batches, provider settings and credentials are not included. Test inputs and expectations can contain private data, so review before sharing.

The full export is serialized with typed mutations on the same owner, including across keyset pages; a queued test/project edit cannot produce a mixed-generation bundle. It validates retained test history and project pins using the same decoder as direct case reads. This coherence contract requires the supported typed adapters, not raw journal mutations that bypass their queue. Exports admit at most 1,000 selected cases and the configured bundle byte limit; history/page limits or corrupt records fail explicitly rather than silently truncating. Version-2 bundles interoperate with SQLite, which imports their tests as new drafts requiring local acceptance.

On `commit-uncertain`, do not automatically resubmit a project command. After the prior owner ends, inspect the known project ID, generation and history with a replacement owner to determine whether the change committed. Supply and retain explicit create/import/duplicate identities when recovery matters. This inspection does not authorize replaying workflow effects.

## Guarded project deletion

Use `PostgresRuntime.deleteProject(id, expectedGeneration, actor)` only for an explicitly authorized deletion. The corresponding typed adapter method is `PostgresProjectStore.deleteArchived({ id, expectedGeneration, actor })`; it enforces the same complete guard, not a weaker low-level delete. The project must be archived at exactly the reviewed generation. Active or stale generations return `conflict`.

Any retained project-linked run (including paused, completed or cancelled runs), release with a matching origin ID, historical test definition, or generation batch prevents deletion with `referenced`. Empty generation batches still retain their source project. Test checks validate every historical version, not only the latest definition. Cases may update their pinned generation/revision within the same project; changing the case's project ID is refused. Independent imported/duplicated project source lineage is provenance and does not require retaining the origin project. External release imports may also claim an already absent origin; they never recreate that project.

The guard holds the shared typed-mutation queue across all reference pages and the final write. Run references use the same internal verified reader as ordinary checkpoint reads, including historical review and model evidence; no models execute. Corrupt evidence or scan limits refuse deletion rather than skip records. Scans admit at most 100,000 runs and 10,000 records in each release/test/generation collection, with bounded pages and per-record limits. Raw generic-journal mutation is unsupported and bypasses these domain guarantees.

A successful transaction replaces the project record with a versioned tombstone, adds an immutable metadata-only deletion receipt, and appends both audit events atomically. It never cascades into runs, releases, tests, generation records, credentials or telemetry. The deleted identity remains reserved; receipt capacity is 10,000 and journal tombstones still consume configured record capacity. Deletion removes the source/revision history from the live project store. The receipt cannot restore it; retain an export beforehand when recovery is needed.

Inspect `runtime.projectDeletion(id)` or page `runtime.projectDeletions(after?, limit?)`, returning `{ deletions, nextCursor }`. Adapter equivalents are `deletion` and `deletions`. Receipt reads validate the immutable receipt version, project tombstone version and matching deletion event. Startup validates retained receipts without changing state.

If deletion returns `commit-uncertain`, end the lost owner and reopen explicitly. Read the known project ID's deletion receipt: if present and valid, deletion committed; otherwise inspect the current project before deciding on another operation. Repeating a completed deletion returns `not-found`, not a second deletion or a new receipt. A failed late capacity check rolls back the entire deletion transaction.

## Typed immutable release adapter

Construct `new PostgresReleaseStore(journal)`. `create({ id?, projectId, expectedGeneration, revision, version, runtime, actor })` reads the accepted project snapshot under the same owner-local mutation guard as project edits. It refuses stale review hashes/generations, archived projects, unsupported execution graphs, reused IDs and an already retained project/version. The compatible runtime version and exact runtime SHA-256 are pinned in the immutable snapshot; storing a claimed hash does not independently verify supplied runtime bytes.

`put(snapshot, reuse = false)` imports an executable release without requiring the origin project. Its creator/project fields remain external provenance, not a new local approval. Exact same-ID/hash reuse is available only when explicitly requested, even at capacity; different content under that ID is always a conflict. Independent external snapshots may share an origin project/version under different IDs, matching SQLite import behavior. Their version index prevents subsequent local creation from claiming that version is unused.

Release records and the first-release project/version index commit atomically with metadata-only audit events. Records/indexes are immutable at storage version 1; reads revalidate the executable snapshot, checksum, record identity and referenced index. The adapter admits at most 10,000 releases and serializes the final capacity slot across instances. `get(id)` returns a verified release; `list(after?, limit = 100)` returns `{ releases, nextCursor }` using the pagination contract above. Raw writes or deletion in `releases`/`release-versions` bypass these invariants and are unsupported.

No operation on the storage adapter runs a workflow, installs runtime bytes, builds an image or approves an external action. Explicit execution is provided by `PostgresRuntime.runRelease`. After `commit-uncertain`, retain the requested release ID, end the previous owner and inspect `get(id)` under a replacement owner before deciding what to do. The immutable snapshot and version index either committed together or not at all. Retained releases prevent deletion of a matching local origin project.

## Typed saved-test adapter

Construct `new PostgresTestStore(journal)`. It shares the owned `TestLedger` with SQLite for draft/edit/accept history, definition hashes, exact project/revision pins, historical reads and generation records. Await `execute(command)` to create or edit a draft or accept its exact reviewed hash with an expected generation. Current project generation/revision and archived status are checked under the same owner-local mutation guard as project edits. Accepted historical definitions remain immutable; editing creates a new draft, not an altered prior approval.

`get(id, generation?)` and `history(id)` validate every retained version and its historical project reference. `list(after?, limit = 100)` returns `{ tests, nextCursor }` with summaries excluding input and expectations. Cases admit at most 100 versions and the collection at most 10,000 cases. Case updates and metadata-only audit events commit together. Private definitions remain in the test records; audit events are not a substitute for access control on those records.

`generate({ id, actor, project, limit })` derives schema samples without calling a model. All generated drafts and the immutable generation record commit in one transaction; failure leaves no partial batch. Retain the caller-supplied generation UUID. Repeating that UUID with the same project/limit request returns the original batch and draft identities, even after project edits or later case acceptance. A different request conflicts. `generation(id)` verifies the original create versions, hashes and project pin; `generations(after?, limit?)` returns `{ generations, nextCursor }`. There are at most 10,000 generation records. Suggested completion assertions require review and are not proof of branch coverage.

After `commit-uncertain`, end the old owner, then inspect the known case ID/history or generation UUID with a replacement owner. An identical generation request can retrieve its retained batch; do not blindly repeat a draft edit or acceptance. No operation in this adapter executes a workflow or approves a Human Approval node.

Atomic project-plus-test imports and opt-in test-inclusive exports are provided by `PostgresProjectStore`, not a separately committed test import method. `PostgresRuntime.runTest` now executes accepted definitions with PostgreSQL checkpoints; assessments derive from retained run evidence and historical test definitions. Historical test definitions retain their exact project generations; the shared ledger forbids changing a case's project ID. Executing an exported definition in an independent SQLite project is a separate interoperability check, not evidence for PostgreSQL execution. Raw journal writes to these typed collections are unsupported.

## Save and restore a standalone application

Back up **both the database and the exact runnable app**. A project transfer or run-evidence ZIP is not a database backup. Release metadata pins runtime bytes but does not store the executable binary; retain the original release ZIP/image and its trusted receipt, plus separately protected configuration, certificates and any external attachments. A database dump can contain prompts, inputs, actor identities and provider credentials: treat it as private even if ordinary evidence exports omit them.

This is an operator-managed logical restore, not a new Jevable CLI command, automatic failover, PITR or production backup service. Use reviewed PostgreSQL 17 tools and independently authorized source/destination endpoints. [pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html) backs up one database, not cluster roles/tablespaces or the app's filesystem. Restoring an untrusted dump can execute source-controlled SQL; never treat a checksum as publisher authentication.

### 1. Save a quiet, reviewable recovery point

Drain all workflow owners using the documented shutdown path. Retain pending run/request IDs and uncertain outcomes; do not force-kill or resume them to make a backup look complete. Quiesce writers to coordinate database state with external files. Never let the original and restored copies both accept work during cutover: their separate database locks cannot fence each other or prevent duplicated external effects.

Use a fresh private backup directory. Supply connection settings through a protected PostgreSQL [service file](https://www.postgresql.org/docs/17/libpq-pgservice.html) and its private [password file](https://www.postgresql.org/docs/17/libpq-pgpass.html), not a password in an argument, URL or report. The following commands require an operator-created `backup_source` service entry with the exact source host/port/database/user and verified TLS; set `PGSERVICEFILE` and `PGPASSFILE` to their protected paths. On Unix the password file must be owner-only, such as mode `0600`, or libpq ignores it. This native libpq service file is **separate** from Jevable's explicit JSON database configuration.

```sh
export JEVABLE_BACKUP_DIR="$(mktemp -d /tmp/jevable-backup.XXXXXX)"
pg_dump --dbname=service=backup_source --no-password \
  --format=custom --file="$JEVABLE_BACKUP_DIR/workflow-state.dump"
pg_restore --list "$JEVABLE_BACKUP_DIR/workflow-state.dump"
```

Check command exit codes and warnings. Preserve the dump and its independently retained checksum in protected storage, alongside the exact runnable release archive and its checksum. Listing the archive proves neither successful restoration nor safe SQL. Do not copy a running database's data directory as a substitute for a supported backup.

### 2. Restore into a new, isolated database

Provision a **new empty destination**, with separately reviewed roles, trust and grants. Do not use the source database, `--clean` or `--create` to overwrite existing state. Configure a distinct protected `backup_restore` service entry pointing to that destination, then restore the reviewed dump:

```sh
pg_restore --dbname=service=backup_restore --no-password \
  --single-transaction --exit-on-error --no-owner --no-privileges \
  "$JEVABLE_BACKUP_DIR/workflow-state.dump"
```

For this small logical profile, [single-transaction restore](https://www.postgresql.org/docs/17/app-pgrestore.html) prevents a failed restore from leaving partially applied commands. Large databases need a separately designed and tested strategy. `--no-owner --no-privileges` deliberately omits restored ownership/grants: it does not create production permissions or prove least privilege. A refusal is not permission to strip constraints, edit journal records, bypass validation or automatically try another destination.

### 3. Inspect before allowing new work

Verify complete journal schema, records, batches, events and sequence state before opening the runtime. Restore the trusted app archive separately into a new directory and verify its files against the original release receipt. Point a private Jevable database JSON file to the new endpoint and the **original namespace**, with `initialize: false`; never silently fall back to SQLite or initialize missing history.

Use read-only inspection first:

```sh
node app.mjs info
node app.mjs show <retained-run-uuid> --database-file /private/restored-database.json
node app.mjs events <retained-run-uuid> --database-file /private/restored-database.json
```

Opening an owner advances its ownership epoch; compare raw database snapshots before opening, then compare domain run IDs, revisions, histories, approvals and test assessments afterward. Waiting approvals remain waiting, with their original attempt/deadline. Restoring state does not authenticate a new approver or authorize approval, Continue, a new run UUID or retrying uncertain external work. Reconcile external outcomes separately and explicitly authorize cutover only after verification; keep the old owner quiescent.

The private macOS ARM64/PostgreSQL 17.11 drill verifies this quiescent logical profile with full four-table/schema/sequence equality, a failed truncated-archive restore, two independently runnable apps, original-ID observation, a retained saved test and explicit synthetic approval. It does not qualify production TLS/roles, physical recovery/PITR, online effects, backups of arbitrary attachments, Kubernetes/HA or other platforms.

## Physical backup and a named recovery point

Use this mode when you need to recover to a point **after** a base backup. It is PostgreSQL operator work, not a Jevable command, desktop dependency or automatic recovery service. Physical backup covers the whole database cluster, including sensitive role data; a logical dump cannot supply WAL recovery. Retain the exact app, private configuration and external files separately as described above. [Continuous archiving](https://www.postgresql.org/docs/17/continuous-archiving.html).

### Prepare and verify the base backup

Before backup, provision and test private WAL archiving with `wal_level=replica` or higher and `archive_mode=on`. Its archive command must acknowledge only a successfully persisted copy, refuse different existing contents and keep the complete required WAL chain. Monitor failures, lag and disk capacity. A local `cp` example is not off-machine/power-loss durability or retention proof; no production archiver is supplied by the skill.

Use matching PostgreSQL 17 tools. This example assumes an explicitly authorized `physical_backup` libpq service entry, replication permission/HBA, verified TLS and separately protected `PGSERVICEFILE`/`PGPASSFILE`. Its password lookup must match the replication connection's service parameters; it is not the workflow runtime's DML credential. Do not change a running operator configuration or discover another application's credentials implicitly.

```sh
export JEVABLE_PHYSICAL_BACKUP="$(mktemp -d /tmp/jevable-physical.XXXXXX)"
PGSERVICE=physical_backup pg_basebackup --no-password \
  --pgdata="$JEVABLE_PHYSICAL_BACKUP/base" --format=plain \
  --wal-method=stream --checkpoint=fast --manifest-checksums=SHA256 --no-clean
pg_verifybackup "$JEVABLE_PHYSICAL_BACKUP/base"
```

Default synchronization remains enabled. `--no-clean` retains a failed backup for diagnosis, not acceptance or permission to reuse that destination. Check exits; keep the original backup/manifest unchanged and protected. Plan explicit safe tablespace mappings before using plain format on a cluster with additional tablespaces. Verification checks the manifest, files and WAL needed for the base backup, not every later archived segment or successful recovery to your chosen target. Perform a real restore drill too. [Base backup options](https://www.postgresql.org/docs/17/app-pgbasebackup.html), [verification limits](https://www.postgresql.org/docs/17/app-pgverifybackup.html).

### Retain the target, then recover a separate engine

After the base backup completes, use an authorized operator connection to create a **unique** reviewed target. Drain application writers first when the point must align with external files/effects. Retain the exact name and returned LSN privately:

```sql
SELECT pg_create_restore_point('jevable_reviewed_point');
SELECT pg_walfile_name(pg_switch_wal());
SELECT archived_count, last_archived_wal, failed_count FROM pg_stat_archiver;
```

A WAL switch alone does not prove archival completion. Confirm the required segment and full chain are durably available, with no unresolved archive error. Before cutover, stop original workflow owners normally and isolate both database destinations from application traffic.

Copy the verified base backup into a **fresh private data directory**, never the source or another existing database. Preserve the original backup. Configure the copied engine's own reviewed HBA/TLS/socket/port paths; WAL does not restore later edits to configuration files. Add `recovery.signal` and explicit settings. For a local-file drill only, the restore-command illustration is:

```conf
restore_command = '/bin/cp "/your/private/wal-archive/%f" "%p"'
recovery_target_name = 'jevable_reviewed_point'
recovery_target_timeline = 'current'
recovery_target_action = 'promote'
```

Replace the archive path/retrieval strategy and target with your reviewed values before startup. `current` follows the base backup's timeline, not an automatically discovered newer fork. Promotion permits database writes; keep Jevable owners/traffic disabled until you verify the recovery log, selected target and system identity. Missing/unreachable targets must not be bypassed by clearing the target or silently recovering to the latest state. [Recovery target settings](https://www.postgresql.org/docs/17/runtime-config-wal.html#RUNTIME-CONFIG-WAL-RECOVERY-TARGET).

### Inspect without replay, then explicitly cut over

Compare complete schema and journal tables before opening an application owner. Physical recovery can advance a sequence beyond committed event IDs; preserve/report that difference rather than editing the counter or inventing missing events. Then use the separately retained trusted app and `initialize: false` configuration for the original namespace; inspect original run IDs/history as in the logical walkthrough. Approval remains subject to its saved attempt/deadline, not renewed authority from restoration. A post-target effect may have happened even when its journal record is absent: reconcile it externally before any new execution. Never run original and restored owners concurrently.

The private PostgreSQL 17.11/macOS ARM64 drill recovers a completed workflow written after the base backup, matches all target schema/four-table journal rows, excludes later project/run commits, and reads waiting/completed histories without approval or replay. It observes a 28-value sequence prelog advance and rejects a one-file-corrupted backup before startup. This same-machine archive/normal-shutdown/plaintext-loopback operator profile is **not** production TLS, off-machine durability, missing/corrupted-WAL qualification, HA, forced Kubernetes/PVC loss or arbitrary artifact recovery.

## Qualification

Run ordinary configuration-admission tests with `npm test`. The real database suite is explicitly opt-in:

```sh
npm run test:postgres -- --docker-context desktop-linux \
  --image postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24
```

Select an actual local Docker context and a cached supported image digest for your machine. The command never pulls, pushes, deploys a cluster, or touches an existing database. It creates a uniquely named fixture with an inspected host-loopback-only port, stages a random password through stdin into a private volume, and tests real SQL behavior. `--installed /absolute/path/to/independently-installed/node_modules/@jevable/core` tests that installed library instead of the checkout's build. The helper's admin connection exists only to inject faults into its new fixture database.

The suite covers atomic rollback, stable retries, tombstones, concurrent queue admission, graceful close, bounds, collection snapshots, event pagination/corruption, competing owners, ownership mismatch, backend termination, statement timeout, schema version refusal and a real wire-level dropped COMMIT acknowledgement. Typed provider checks include generation/capacity races, audit privacy, immutable evidence, a real local HTTP request and workflow approval/reopen, lost intent/settlement acknowledgements, and database termination during an active HTTP request. Project checks cover review hashes and approval acknowledgement, historical reads/reopen, stale-proposal refusal, restore/duplication/archive, cross-backend bundle exchange, corrupt history/version refusal, final-capacity-slot races and lost commit acknowledgement. Run/approval checkpoints in this integration fixture are explicitly SQLite. The fixture proxy forwards the selected COMMIT, observes PostgreSQL's completed response, then destroys the client connection without delivering it. No SQL driver mock substitutes for these checks.

After testing, the script verifies a clean database stop and removes only its own stopped container. The database/password volume and local report remain for inspection. These contain test credentials and fixture data; do not publish them. A failed or uncertain stop retains the container for diagnosis instead of deleting it speculatively.

Release qualification additionally checks project/edit races, immutable version reservations, external snapshot exchange with independent SQLite execution, bounded keyset pages, corrupt snapshots/indexes, rollback of a partially admitted multi-record batch, the final 10,000-release capacity slot and a dropped release COMMIT acknowledgement. Pagination checks include UTF-8 ordering, tombstone exclusion and explicit byte-limit refusal.

Saved-test qualification covers exact review/history and reopen, queued input cloning, competing acceptance and project-edit races, atomic generation/retry after edits, capacity rollback, hash/version/reference corruption, cross-backend definition hashes, the final 10,000-case slot, private-input-excluding pages and recovery of original draft identities after a lost generation COMMIT response. SQLite independently accepts and executes a matching definition; PostgreSQL stores no run in that check.

Atomic-transfer qualification imports actual SQLite bundles with and without archived history, verifies remapped draft provenance and local reacceptance, and imports the full 1,000-case format limit in a single transaction. It reads the 1,001-record receipt again after reopening, refuses oversized batches, checks semantic/hash rejection and late SQL capacity rollback, races two imports using one project ID, and inspects the complete draft set after a dropped COMMIT acknowledgement.

Test-inclusive export qualification round trips PostgreSQL bundles through SQLite with and without project history, requires fresh local test acceptance before independent SQLite execution, and imports them back into PostgreSQL as drafts. It exports all 1,000 cases across pages, refuses 1,001 selected cases, verifies original pins and other-revision exclusions, serializes competing project/test edits and rejects corrupt or oversized bundles without writes. Neither transfer direction qualifies PostgreSQL workflow execution.

## Run checkpoint adapter

`PostgresRunStore(journal, limits?, maxRecordBytes?, maxRuns?)` owns checkpoint validation and persistence, not execution or the journal connection. Its asynchronous `get(id)` returns `{ record, version }`; `events(id)` returns the checked run's private history; `list(after?, limit?)` returns bounded summaries and a keyset cursor. Versions and event sequences remain decimal strings. Reads join the typed-domain owner queue to avoid mixing concurrently edited review references.

`save({ requestId, expectedVersion, record, kind, data })` accepts a bounded, finite JSON tree (not aliased evaluator objects). Retain the exact command and UUID before submission. It atomically commits one version-guarded checkpoint, one event and a retry receipt. New runs must start at the initial checkpoint; later writes preserve source/input/provenance, require a matching node intent before settlement and bind control, approval and cancellation evidence. It uses the shared `RunLedger` and verifies settled model evidence through the same namespace's provider adapter, without model dispatch. Creation checks current review references; subsequent replay uses pinned historical references.

An exact retry returns its original receipt, including after later checkpoint writes. Following `commit-uncertain`, end the lost owner, open a new one and inspect the retained checkpoint/receipt. A saved executing intent is uncertain work, not permission to redispatch it. This adapter neither resumes workflows nor approves actions. It has no deletion API. Raw generic-journal writes bypass its admission and are unsupported.

Run history is record-key filtered and paginated, capped at 50,000 events and 64 MB; run capacity defaults to 10,000. Reads validate contiguous per-run versions, creation/control/cancellation evidence, current checkpoint replay and settled models. They do not reconstruct and validate every historical intermediate transition, authenticate business actors or independently attest external effects. Run/event payloads can contain private inputs and outputs; they are not metadata-only telemetry.

The real database fixture drives the owned evaluator through this adapter for deterministic nodes, waiting approval/reopen/explicit decision and cancellation. It also checks stale-write races, missing intents, capacity, separate run histories, corrupted event versions and dropped intent/result COMMIT acknowledgements. These are checkpoint-adapter checks, not a public PostgreSQL runtime, CLI, HTTP service or cluster qualification.

## Remaining runtime integration

The owned `RunLedger` separates source/checkpoint and retained review/control/cancellation replay from database reads. Both run stores supply resolved historical references and journal events. The ledger itself does not commit intents, dispatch effects, recover an owner or prove that all event transitions are valid. Asynchronous execution integration and workflow-level interruption qualification remain required.

The internal `executeWorkflow` driver in `src/runtime/execution.ts` now owns the execution loop used by `LocalRuntime`: step budgets, loop deadlines, node/model spans and intent/result progression. Its persistence port awaits reads, events, segment writes, checkpoints and cancellation completion. The SQLite host retains lifecycle/active-run ownership and rejects a stale write if cancellation changed the observed record during an asynchronous boundary. Failed recovery reads preserve the original write/dispatch error, including `commit-uncertain`.

The internal boundary is now consumed by both `LocalRuntime` and the experimental `PostgresRuntime` SDK. Additional PostgreSQL driver fixtures cover scoped loops and model evidence. Public SDK checks cover execution/reopen, controls, approval decisions, cancellation during an actual model request, owner termination, lost creation/intent acknowledgements, configuration exclusion and corrupt startup ownership release. Domain execution checks cover project review pins, release provenance, historical saved-test assessment, transferred-draft reacceptance and edits during model admission. The race fixture temporarily delays the actual configured-model admission after its database reads; it does not replace SQL or execute a paid provider call. Telemetry checks inspect real OTLP wire requests, PostgreSQL credential rotation/configuration locks, shutdown and linked journal evidence. Explicit CLI/SDK management service startup and direct CLI jobs are available; deployment authorization and the full termination matrix remain required.

The existing `RunStore`, `ProjectStore`, SQLite `ProviderStore`, `ReleaseStore` and `TestStore` use synchronous SQLite transactions. The explicit PostgreSQL execution owner is separate; its deletion guards serialize verified reference scans and the final atomic tombstone/receipt write with all supported typed mutations. Switching a connection string cannot change `LocalRuntime`. Direct CLI jobs and management services select PostgreSQL explicitly through `--storage postgres`; SDK owners use separate entrypoints. Remaining integration must preserve exact project/test/release review guards, replay validation, cross-domain atomicity and owner-loss/cancellation propagation. Runtime selection and the service capability handshake must describe only the backend actually in use.

Full model/loop interruption qualification, database TLS, migrations, backups/restore, non-database artifact persistence, cluster security and pod replacement remain open. Replica scaling additionally needs leases, competing-worker and approval-race tests; the single-owner SDK does not complete those gates.

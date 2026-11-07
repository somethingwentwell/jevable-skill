# Export retained run evidence

Use this for a read-only audit/debugging snapshot, not a runnable app, backup, replay instruction or restored run. Export never starts, resumes, approves or cancels execution. It works through the standalone SDK, CLI, authenticated HTTP owner and extracted release launcher.

To package multiple explicitly selected runs together with their historical test assessments, use [selected evidence ZIPs](evidence-packages.md). That separate SDK/management-CLI command includes expected/actual checks only with private opt-in; single-run JSON exports below remain unchanged.

## Local files

```sh
node bin/jevable.mjs runs export <run-id> --output run-evidence.json --data-dir .jevable
```

The default excludes workflow source, inputs, intermediate/final outputs, approval review payloads and actors. It retains identifiers, revision/project/release/test pins, status, recorded step/attempt order, loop scopes, available timing/model usage, trace links and metadata-only journal entries. Unlike `runs show`, a completed final output is not included. Identifiers and node names can still disclose business context: review before sharing.

Only when inclusion of private execution data is authorized:

```sh
node bin/jevable.mjs runs export <run-id> --include-private --output private-evidence.json --data-dir .jevable
```

This adds the full retained run and journal, including source, inputs, outputs, approval data and recorded actors. Provider configuration, credential tables, separate model request/response records and test definitions/expectations are not copied. Secrets authored inline in source or returned in workflow payloads **can still be present**. This is not automatic secret scrubbing or a complete test-result package.

Files are atomically published, mode 0600 on POSIX, and refuse an existing destination unless `--overwrite` is explicit. Standard output contains an artifact receipt, not the private snapshot. Exit 0 means export succeeded; inspect `workflowStatus` separately. Waiting, paused, failed, cancelled and uncertain executing checkpoints are exportable without changing their status.

## SDK, HTTP and release apps

- SDK: `await runtime.exportRun(runId)` or explicit `await runtime.exportRun(runId, true)`. The runtime package exports SQLite's `RunEvidence` type and `RUN_EVIDENCE_LIMITS`; `@jevable/core/storage` exports `PostgresRunEvidence` for the experimental PostgreSQL SDK, described below.
- Owner API: `{ "operation": "runs.export", "id": "<run-uuid>" }`, optionally `"includePrivate": true`, sent through the authenticated [HTTP API](http.md). It returns the snapshot in the response rather than writing a server-side file. Treat a private response and any captured CLI output as private.
- Preview-scoped API: `{ "operation": "evidence", "id": "<run-uuid>" }`, with the same optional boolean. Only runs belonging to the admitted project/revision are accessible. The experimental download controls below use this operation; browser qualification remains separate.
- Extracted app: `node app.mjs export <run-id> --output evidence.json`, optionally `--include-private`, `--overwrite` and `--data-dir`. It first enforces the exact release identity. A release container uses the same `export` command; choose an explicitly writable private volume path such as `/data/evidence.json`.

An open service owns its data directory. Use its API or stop your service before a direct CLI export; never erase the owner lock or start a competing runtime. No model execution or telemetry reconstruction is performed. Configured model adapters must implement side-effect-free retained-evidence verification.

## HTML preview downloads

In an explicitly started local or Docker-backed live preview, select a retained run and use **Prepare snapshot**, then **Download snapshot**. Preparation is a read, never a run, retry, approval or cancellation. Opening the page, loading history and refreshing status do not prepare or download evidence. The prepared snapshot stays fixed until explicitly replaced; it is not a live feed.

Payloads and actors are excluded by default. The separate private-data checkbox authorizes only the next preparation and resets immediately. Private snapshots can contain inline secrets and business data; this is not automatic scrubbing. A response with the wrong run/revision, privacy declaration or SHA-256 is refused. The client checks the snapshot digest and reports a second digest over the exact downloaded JSON bytes. Neither proves authenticity, workflow success, external outcomes or telemetry delivery.

The link uses an in-memory object URL, with a filename derived only from the run UUID, privacy mode and file hash. No snapshot, URL or private consent is stored in tab storage. Replacing/clearing the snapshot, selecting another run, reconnecting/disconnecting or leaving the page revokes the prepared link and discards late responses. Clearing the page cannot remove an already downloaded file.

Browser downloads do **not** inherit the CLI's atomic no-overwrite publication or POSIX mode 0600. The browser controls destination, permissions and duplicate-file handling; the page cannot confirm saving completed. Use CLI export when those file controls are required. Controller-double, generated-HTML and installed-API tests are not actual browser saving, CSP, focus or accessibility qualification.

SDK consumers can call `prepareEvidenceDownload({runId, revision}, envelope, includePrivate?)` from `@jevable/core/preview` to obtain the verified JSON contents, filename, byte count and digests without starting a server or writing a file. It accepts runtime-produced v1/v2 JSON envelopes up to 16 MB, preserves PostgreSQL decimal sequence identities and uses Web Crypto. It checks the envelope's identity/privacy declarations and checksum, not every journal record's domain semantics; the runtime's evidence validation remains authoritative. Passing an untrusted forged envelope cannot establish evidence authenticity.

## Meaning and limits

### Recorded route choices

New settlements add optional `port` metadata to retained steps and `routes` to their `node-result` or `approval-decided` journal event. Each route identifies a zero-based `stepIndex`, `nodeId`, selected `port` and optional loop scope. Replay checks present ports against deterministic workflow evaluation and binds journal routes to the corresponding intent/settlement and checkpoint. A selected port is not proof of successor completion or successful loop-return binding. Terminal outputs and loop iteration-result bookkeeping have no port; loop aggregate completion uses `done` or `limit`. Decision steps use `next`, with explicit Rule nodes routing typed answers.

These fields are included in default metadata exports, including approval action/timeout port names. Names may disclose business context even though actors and review payloads are excluded. Older records without port metadata remain readable and are not backfilled, including when continued. New PostgreSQL typed writes require current settlement metadata. The additions do not change v1/v2 envelope versions or SQLite table layout; older binaries with strict record schemas may reject new records. Use the matching runtime artifact, not a downgrade against updated state. This is consistency validation, not signed authenticity: coordinated alteration of both journal and checkpoint is not independently attested.

### Model attempts and retries

Current runtime exports add `snapshot.models`, with format `jevable.model-history/v1`, to both SQLite v1 and PostgreSQL v2 envelopes. Older exports may lack it; that means unavailable history, not zero requests. `calls` follows the run's model-node intents in journal order, keyed by node attempt UUID and optional loop/iteration scope. Reads use the core-owned configured-model store, never desktop or harness services. Custom adapters without records there return `evidence: not-recorded`, not a fabricated attempt count.

Recorded entries retain the evidence schema version, intent/settlement timestamps, pending/failed/completed status, fixed failure code and available successful-result usage. Optional `trace` retains the model call's own span context (`traceId`, `spanId`, `traceFlags`), committed with intent before dispatch, for both single-try and retry-enabled calls. Local retention does not enable provider propagation: a connection must still explicitly authorize the outbound header. With telemetry disabled there is no call context; unsampled or logs/metrics-only telemetry can retain context without exporting a span. Old records remain unchanged: neither a header-only record nor a node's parent context is backfilled as the call's own span. Retry-enabled records additionally include the reviewed retry policy and ordered tries: UUID, number, status, intent/settlement times, recorded HTTP failure status, scheduled delay and optional child trace context. Single-try records have no per-try list or invented child try context. Prompts, system instructions, request/response bodies, route/endpoint, credential references, provider model/response IDs and raw error text are excluded even with `--include-private`; that option still applies only to the run and run journal.

Interpret these as retained observations:

- A pending intent does not prove dispatch or provider receipt. Completed model evidence does not prove the enclosing workflow step or workflow completed.
- A failed try with `scheduledDelayMs` records a retry schedule, not proof that the next request happened. Cancellation/timeout during backoff may settle the call without creating another try.
- Missing evidence is not proof that no external call occurred. Never execute or retry to fill an inspection gap.
- Call and child trace IDs join locally retained evidence to OTel spans; dispatch, provider receipt and collector delivery remain unproven. Present call context must agree with its retained node context's trace ID/sampling flag and use a distinct span ID; present retry children must agree with the call and use distinct span IDs. These consistency checks are not signed parentage or authenticity. Outgoing provider context is still the parent model span, not each child try.

The exporter validates retained request identity, exact prepared request and retry policy against the source-pinned model intent, including unsettled records, without loading current credentials. SQLite reads checkpoint/journal/model records in one synchronous owner turn after validation; PostgreSQL holds its shared mutation gate through the model-record reads. An additional cumulative 64,000,000-byte model-record read budget and the existing artifact budget fail closed rather than truncate history. History changes affect the checksum even if the workflow checkpoint has not advanced. The experimental [live preview panel](live-preview.md#model-history-snapshots) now renders this metadata on explicit load, with checksum verification and local paging; actual browser and cluster qualification remain open.

The optional local call-context field changes neither v1/v2 model record versions nor SQLite table layout. Earlier strict binaries may reject newly written fields; use the supporting runtime artifact, not a downgrade against updated state. Read-only inspection/reopen never remints a call context or repeats a provider request to repair a trace gap.

SQLite's envelope is `{schemaVersion: 1, snapshot, checksum}`; `snapshot.format` is `jevable.ai/run-evidence`. PostgreSQL uses version 2 below. The checksum is SHA-256 of the UTF-8 bytes of `JSON.stringify(snapshot)` in its emitted property order, not canonical JSON. Reordering snapshot keys changes this digest. The file receipt separately hashes the complete file bytes. A reader can recompute the snapshot digest with Node's `createHash('sha256').update(JSON.stringify(evidence.snapshot)).digest('hex')`.

Checksums detect changes relative to a trusted receipt; they are not signatures, publisher identity, independent attestation or proof that a remote side effect happened. Retained checkpoints are checked against workflow semantics and settled model results through the configured adapter. Metadata headers/order are validated, but this is not an independently authenticated reconstruction of every journal field. Trace IDs allow correlation; they do not prove delivery to an OTel collector.

The SQLite owner validates a run, then compares it with the current stored checkpoint before synchronously reading its journal. If execution changed during asynchronous validation, export retries **the read**, at most three times, then returns `busy`. PostgreSQL instead holds its domain mutation gate across the verified read, as described below. Unchanged retained state produces the same snapshot across reads/restarts. No capture timestamp is fabricated. This is a bounded observation, not a live subscription or distributed transaction.

Limits are 50,000 journal events, 64,000,000 bytes of stored journal data and a 16,000,000-byte artifact budget (including reserved envelope space). Oversized exports fail with `limit`; they do not silently truncate. HTTP response policies can be smaller. Malformed supported metadata or unsupported journal kinds fail with `corrupt`. These errors do not authorize execution retries, database changes or relaxed safety limits.

`boundary.terminal` means completed, failed or cancelled—not that all external effects are known or undone. Cancellation preserves unsettled attempts and never proves external rollback. Missing step timing/usage remains missing rather than estimated. Test identity is correlation, not a claim that expectations passed; use `tests result --inspect` for the private retained assessment.

## PostgreSQL v2 snapshots

The experimental [PostgreSQL SDK](postgres.md) supports `await runtime.exportRun(runId, includePrivate = false)`. The typed checkpoint adapter also provides `await store.evidence(runId, includePrivate = false)`; the runtime wrapper additionally enforces lifecycle/configuration admission. These return objects rather than writing files. The explicit [PostgreSQL management service](http.md#postgresql-management-service) exposes the same v2 snapshot through `runs.export`; CLI `runtime serve --storage postgres` and `runtime request` can start/access this service; direct `runs export` also supports `--storage postgres --database-file <private-file>` and writes this v2 evidence without starting HTTP. A competing service owner is refused; use that owner's API instead.

Both envelope and snapshot have `schemaVersion: 2`, with the same `jevable.ai/run-evidence` format name and checksum rule. Version 2 deliberately does not alter the established numeric-sequence v1 contract:

- `storage` contains `{ kind: 'postgres', recordVersion: '<decimal>' }`.
- Each projected journal entry retains its exact PostgreSQL `sequence` and per-run `version` as decimal strings. Global sequence gaps are valid and unrelated runs are excluded.
- `boundary.sequenceEncoding` is `decimal-int64`; `firstSequence` and `lastSequence` are the original decimal strings. Never convert these identifiers to `Number`: valid values can exceed its exact integer range. Compare with `BigInt` when necessary; JSON itself contains strings, not BigInt values.
- Explicit private inclusion retains the original run and journal, including these exact identifiers. Default exports reuse the same allowlisted metadata projection as SQLite and exclude source, inputs, outputs and actors. Credential/configuration/model-evidence tables are never copied.

The adapter holds the shared typed-domain gate across reading the checkpoint, bounded event pages, historical review references and settled-model verification, then creates the projection before releasing that gate. A concurrent cancellation or checkpoint mutation waits; the export contains one complete observation, not a mixture of its before/after states. Export never commits a record/event, dispatches a model, reconstructs telemetry or resumes an uncertain attempt. Opening/exporting a retained uncertain run is inspection only.

The same event, journal and artifact budgets apply. Corrupt history refuses export; repairing a private test fixture is not an instruction to modify production history. Coherence relies on the owned session and supported typed adapters; raw SQL/generic-journal mutations bypass domain coordination and are unsupported. This snapshot is not a database backup, restore format, signed attestation or full test-result package.

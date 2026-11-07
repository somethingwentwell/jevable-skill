# Reviewed saved-test suites

A suite is a saved manifest of accepted test identities and preallocated run UUIDs. It groups real executions, not model-generated grading or a simulated preview. The standalone core owns orchestration through `@jevable/core/testing`; it uses the same guarded saved-test operations as individual cases. No desktop, Jarness or Docker is required for direct local use.

## Prepare without executing

After reviewing and accepting cases as described in [saved tests](testing.md), write a selection file:

```json
{
  "title": "Support workflow regression",
  "failurePolicy": "stop",
  "tests": [
    { "id": "<accepted-case-uuid>", "generation": 2, "sha256": "<reviewed-definition-hash>" }
  ]
}
```

```sh
jevable tests suite create selection.json --output regression.suite.json
jevable tests suite inspect regression.suite.json
```

Creation is offline: it validates the selection, allocates one run UUID per entry, and atomically publishes an owner-only file without overwriting by default. It does not check current acceptance, contact a provider or open storage. The manifest permits 1–100 entries and is bounded to 100 KB. Repeated test identities deliberately allocate independent executions; duplicate run UUIDs are rejected.

Keep the generated manifest before execution. Its `schemaVersion: 1`, `kind: JevableTestSuite`, title, failure policy, optional concurrency and ordered `{test,runId}` entries form its identity. The returned `sha256` hashes the validated canonical manifest, not raw file whitespace; `artifact.sha256` separately hashes the written bytes. Inspect the exact selected cases, order, policy, concurrency and run identities before approving execution. A hash is not a signature or permission to spend model credits.

## Run or read results

```sh
jevable tests suite run regression.suite.json \
  --suite-sha256 <reviewed-canonical-manifest-hash> --data-dir .jevable
jevable tests suite result regression.suite.json --data-dir .jevable
```

Direct PostgreSQL uses `--storage postgres --database-file <private-config>`. While a service owns the directory or namespace, replace direct-storage flags with `--endpoint <reported-url> --token-file <private-token>` and, for explicit certificate trust, `--ca-file <ca.pem>`. Never mix modes. Service requests use verified HTTPS or literal-loopback HTTP; they do not discover another application's services or credentials. Remote timeout defaults to 30 seconds and permits `--timeout-ms 1–3600000`; timeout is not server-side cancellation. The loopback HTTP suite host first performs a read-only capabilities handshake and pins its client before any operation; every later request carries the immutable owner guard. A failed handshake poisons that host rather than automatically retrying/discovering another owner. A replacement is rejected before operation dispatch, with no fallback. The selected Docker/HTTPS command routes retain their existing reviewed-owner handshake and per-dispatch guards.

The runner first reads existing results. It validates every not-yet-observed case's latest accepted generation/hash and active project generation/revision before submitting any new test. A draft, stale pin, missing case, malformed result or read failure blocks new execution. This is review-state preflight, not model/credential readiness, a global lock or a transaction across runs. The runtime rechecks admission on each real submission; a concurrent edit or provider failure can still stop a later case after earlier work completed.

Execution defaults to serial. Existing runs are assessed under their historical accepted definitions and are never submitted again by the suite runner, even after current case/project edits. Any retained unfinished run stops further admissions. A submitted case also stops new admissions when it waits for approval, pauses or becomes uncertain. A matching expected approval wait remains nonterminal; it is not a completed suite. Suites never approve, resume, cancel or retry a model attempt.

`failurePolicy: "stop"` stops after a terminal assertion failure. Explicit `"continue"` permits later cases after that failure only; it does not bypass approval, uncertainty, admission or transport errors. Expected workflow failure may pass its assertions; workflow completion may fail them. Reports keep these outcomes separate.

Retry only the same saved manifest under the user's continuing execution authority. A submission error says `may-have-started; inspect-retained-run`, not that nothing happened. Reading `suite result` is the safe first step. An explicit `suite run` retry reads existing results and may start remaining cases; it does not replay existing ones. Never regenerate a manifest or replace run UUIDs to recover a lost response. To intentionally execute a fresh regression batch, create and review a new manifest. Already completed effects are not rolled back when another case fails.

SIGINT/SIGTERM during `suite run` asks the orchestrator to stop between operations; an admitted direct run is awaited, not forcibly cancelled. Model/runtime limits still apply. Remote timeout may leave the server running. Inspect the retained run and use separately authorized controls if needed; repeated signals do not grant recovery authority.

## Explicit bounded parallel execution

For independent cases that may safely overlap, add `"concurrency": 2` (integer 1–8) to the **selection file before creating/reviewing the manifest**. The prepared manifest retains it and includes it in the reviewed hash; changing it requires a new review. Omission preserves old v1 manifest/report serialization, hashes and serial behavior. Explicit `1` is also serial but forms a different reviewed manifest. There is no ambient setting, execution-time flag override or automatic parallelism.

The shared SDK schedules at most that many new `runTest` calls per invocation, in manifest order, and returns entries in manifest order even when results finish out of order. This is a local/client-side bound, not a distributed worker lease, owner-wide quota, provider rate limit or scheduled queue. Multiple invocations can overlap; shared runtime UUID/review guards still decide admission. The selected HTTP service may impose a smaller request limit and refuse a case. Choose a concurrency within independently authorized provider/service capacity; parallelism does not authorize additional cases, model credits or external effects.

The entire missing-case review preflight still completes before any dispatch. Once a failure/wait/pause/uncertainty/submission error or interruption stops admissions, **already submitted peers are awaited**, never abandoned, cancelled or rolled back. They can finish or reach additional approval waits. No new case is submitted after the stop is observed, but cases already admitted can have real external effects. With `failurePolicy: "continue"`, only terminal assertion failures permit further admissions; waits, transport errors and uncertain evidence still stop. For parallel runs with `"stop"`, any historical terminal assertion failure already known after preflight prevents all new admissions, even if it occurs later in the manifest. Inspect/fix/review the failure or intentionally choose a reviewed continue policy; do not replace UUIDs to bypass it. Serial manifests retain their original ordered stop behavior.

An interrupted parallel report is returned only after all submitted client calls settle, not after every remote workflow necessarily completes. Remote acknowledgement loss is still `may-have-started`; retained UUID inspection comes first. Retry the same reviewed manifest only under continuing execution authority: it reads peers' results, refuses further work while any retained run is unfinished, and never resubmits a UUID already observed. Neither API success nor a matching wait proves suite completion.

## Reports and persistence

The report includes suite hash, failure policy, explicit concurrency when supplied, per-entry test/run identity, observation origin (`retained`, `submitted`, `not-observed`), assessment, workflow status, terminal flag, revision/checkpoint hash, observed timestamp and matched/total check counts. `submitted` means a request was made; concurrent idempotent admission can return an already retained run. `not-observed` is not proof of absence when observation was interrupted or blocked.

Private test titles, inputs, expected/actual values, workflow outputs, approval actors and arbitrary errors are excluded. Suite preparation/inspection does show the authored suite title and IDs. The ordinary owner HTTP APIs may transfer private case/project/result data to the authenticated client for validation; report redaction is not a new read-only permission boundary. Use individual `tests result --inspect` only with authority to view private values.

| Suite run status | Exit | Meaning |
| --- | --- | --- |
| passed | 0 | Every selected run is terminal and its assertions match |
| blocked | 1 | Read/admission/submission failure; inspect the stage and retained UUID |
| pending / attention | 3 | Missing results or unfinished workflow requiring attention |
| uncertain | 5 | Retained executing intent; no automatic redispatch |
| failed | 6 | At least one terminal assertion mismatch |
| interrupted | 130 / 143 | Observer/orchestrator stopped; not workflow cancellation |

Invalid flags use exit 2; malformed manifests use the existing invalid-command error contract. `suite result` exits 0 for successful inspection regardless of assessment, and 1 for blocked inspection. Reports are per-run observations, not an atomic cross-run snapshot, exhaustive coverage claim or telemetry-delivery receipt. Approval or other separately authorized actions may change later assessment.

The manifest is the saved suite definition; no mutable suite catalog or aggregate result record is added to the database. Retain it alongside the normal authoritative run journals and historical test definitions. Suite hash/run mapping lives in the manifest/report; optional invocation telemetry includes that hash as described below, without adding a new aggregate journal record. Existing run/test/revision/attempt traceability is preserved. Losing the manifest loses its ordering/policy mapping, though individual runs remain available.

## Suite invocation observability

Direct owned SQLite and experimental PostgreSQL SDK hosts, and direct local CLI suites, use the owner's explicitly configured [telemetry destinations](telemetry.md#supported-signal-matrix). No additional flag, server or Docker is needed; telemetry remains off unless configured. Use the normal private `--telemetry-file` for the direct CLI. `--trace-context-file` may supply an explicitly reviewed incoming W3C parent and independently allowlisted baggage; child scopes preserve that carrier without recording baggage in signals or durable evidence.

An actual `runTestSuite` or `testSuiteResult` invocation opens `jevable.test.suite` and emits `jevable.test.suite.ended` on report/error. Attributes contain only the canonical `jevable.suite.sha256`, mode (`run|result`), failure policy (`stop|continue`), entry count, reviewed concurrency (omission means 1), and ended outcome. Logs also include elapsed seconds and the owned trace/span IDs. Suite titles, case input/expectations, workflow output, actor, baggage and raw errors are excluded. The hash and correlation identities are diagnostic metadata and may still be sensitive.

Newly executed run segments adopt that live invocation span as their parent and retain the parent through their existing journal trace metadata. Existing saved runs are never reparented. Retry of the same manifest can produce a **new invocation observation**, but observing retained IDs does not emit reconstructed execution/node/model spans or repeat model work. `suite result` similarly observes the inspection itself, not historical execution. Later separately authorized approval/continuation remains a separate execution segment, not a span held open during human wait.

| Instrument | Meaning |
| --- | --- |
| `jevable.test.suite.invocations` | Cumulative count of ended explicit run/result invocations, including retained-only retries; not unique manifests, executed cases or completed workflows |
| `jevable.test.suite.duration` | Cumulative histogram in seconds from invocation admission through report/error; includes preflight and awaiting already submitted peers, excludes later human wait |

Both instruments use only `jevable.suite.mode`, `jevable.suite.failure_policy` and `jevable.suite.outcome`: at most 32 combinations across two modes, two policies and eight outcomes. No suite hash, case/run UUID, concurrency, title or payload is a metric label. Duration uses the runtime's existing explicit buckets (`0.001, 0.01, 0.1, 0.5, 1, 5, 10, 30, 60, 300, 3600` seconds plus overflow), not individual samples or reconstructed averages. Counters reset with the owner; do not sum successive cumulative snapshots. Trace sampling does not sample these metrics or logs.

Outcomes are `passed|failed|pending|attention|uncertain|blocked|interrupted`, plus `operation-failed` for an unexpected thrown orchestration error. Assertion mismatch, uncertainty, blocked admission and unexpected errors use ERROR span/log status; other reports remain unset/INFO. `passed` means terminal assertions matched, not necessarily workflow success. `attention` can include an assertion-matching approval wait and is never completion. An interrupted observer does not claim workflow cancellation or rollback.

Malformed manifests, mismatched review hashes and invalid options are refused before suite observation. Optional diagnostic hooks cannot replace the original report/error, invoke work twice, dispatch deferred work or authorize retries. Export failure remains best-effort and never replays a case. Custom SDK hosts may implement `observeTestSuite(identity)` for an owned synchronous invocation scope; the shared orchestrator guards its work callback exactly once.

### Remote client observations

Remote orchestration can opt into a separate **client** pipeline. The selected Jevable workflow runtime still owns execution, storage and its own telemetry configuration; the suite client never starts another runtime or opens fallback storage. Without this opt-in, the existing explicitly admitted request context is forwarded unchanged and no aggregate suite observation is emitted.

```sh
jevable tests suite run regression.suite.json \
  --suite-sha256 <reviewed-canonical-manifest-hash> \
  --endpoint <reported-url> --token-file <management-key> \
  --suite-telemetry-file <private-client-telemetry.json> \
  --suite-telemetry-credential-file <separate-exporter-key>
```

The same client flags work with `suite result` and existing selected Docker/verified-HTTPS owner flags. The owner-only JSON uses the [existing explicit telemetry configuration](telemetry.md); bearer export requires a dedicated protected key file, while `authentication.kind: "none"` refuses that key flag. Direct or hard-linked reuse of the management key file is refused. Use genuinely separate credentials even when filenames differ. Neither workflow credential storage nor management authentication is an exporter credential source. Direct SDK/local CLI owners continue using their own telemetry configuration, not these client flags.

SDK callers create `createTestSuiteTelemetry(config, {credential?})` from `@jevable/core/testing`, then pass it as the third argument to `createHttpTestSuiteHost(client, explicitContext, telemetry)`. Keep it open through the invocation and explicitly `flush()`/`close()` it afterward. A custom already-pinned normalized operation client can use `createOperationTestSuiteHost(client, explicitContext, telemetry)`; that adapter does not perform another discovery handshake. The credential callback is explicit and used only by the private exporter.

Client resources default to `service.name: "jevable-suite-client"` and identify `jevable.component: "suite-client"`, with their own instance identity and no storage-kind attribute. Owner-only instrumentation flags (storage, retained state, runtime work, HTTP sockets/requests and grant administration) are refused, not represented by fabricated zeroes. Exporter-health metrics remain optional. No ambient destination, global OpenTelemetry provider or runtime configuration change is introduced.

The client invocation is the parent of its existing guarded owner requests. With owner HTTP telemetry enabled, ancestry is incoming context → client suite → owner request → new execution; without that HTTP instrumentation it is incoming context → client suite → new execution. Already-retained executions are not reparented. Client baggage is filtered by its explicit allowlist before forwarding, then by the owner's policy; it is never promoted into suite attributes or exporter headers. Invalid diagnostic carrier hooks preserve the original admitted context. Failed owner handshakes/pins remain failures with no rebind or local fallback; diagnostics do not grant execution authority.

Invocation counters reset with each client pipeline (each CLI invocation creates one), not with the remote owner. Never treat them as a distributed unique-suite count or sum successive cumulative snapshots. Client and owner may export to independently selected destinations; correlation alone does not guarantee shared backend retention or dashboards. Release-only apps and the project-scoped preview do not acquire authoring suite operations. Actual PostgreSQL suite wire, deployed containers/cluster and Collector/backend/dashboard qualification remain separate from private SQLite HTTP/verified-HTTPS fixtures.

## Which nodes and branches did these tests exercise?

After executing reviewed cases, inspect their **retained** results against the exact workflow source:

```sh
jevable tests suite coverage regression.suite.json --file workflow.yaml --data-dir .jevable
```

This command does not run missing cases, accept drafts, resume a checkpoint or approve anything. It works through direct SQLite/PostgreSQL storage or the existing explicit suite HTTP/selected-owner options. Use the original matching source for historical runs, not a newer edited workflow. Mixed revisions or substituted test/run pins are refused. Current project/case edits and archival do not invalidate already recorded historical observations.

The report lists each node's `settledResults` and distinct observed `runs`, plus each outgoing route's recorded `selections` and distinct `runs`. Zero means **not observed in these selected runs**, not unreachable. A chosen port is not proof that its target completed. Waiting, paused and unsettled checkpoints do not count as settled node results; an assertion-matching approval wait can still have zero approval-node results. Rejected/expired approvals that fail without a settled result do not invent a continuation. Loop-body nodes are scoped separately, and iteration-return bookkeeping is counted separately from actual node results. An empty completed loop does not imply its body ran.

Older results without recorded ports contribute node results but never guessed branch choices; `resultsWithoutRecordedPort` exposes that gap. Coverage here means observed settled nodes and explicit port choices, **not** condition/path coverage, correctness, provider quality, authenticity or external-effect success. It includes failed and nonterminal observations without relabelling them as passing tests. Private inputs/outputs, source, titles, actors, prompts and answers are excluded from the report.

`observationStatus: complete` means every selected run was read, not every node/route was exercised or every workflow finished. Missing runs produce `partial` without execution. An unavailable/mismatched owner stops further reads and produces a redacted read error; the command exits 1. Malformed evidence/source or mixed revisions fail rather than return a guessed partial report. SIGINT/SIGTERM stop between reads and await the in-flight read; they never cancel a workflow. As with suite results, observations are per-run, not an atomic snapshot. At most 100 runs, 50,000 results per run and 100,000 total results are admitted; limit failure never silently truncates coverage.

The SDK exports `testSuiteCoverage(host, suite, source, {signal?, limits?})` from `@jevable/core/testing`. Its host only needs `testResult(runId)`. The existing owned runtimes, `createHttpTestSuiteHost` and `createOperationTestSuiteHost` satisfy that interface. No new general management operation or execution permission is required. The experimental [preview coverage panel](live-preview.md#what-have-your-tests-reached) uses a project-scoped read-only wrapper around this SDK. Existing per-request/owner diagnostics may observe reads; coverage does not create an aggregate suite invocation or accept client suite-telemetry flags. Actual browser presentation, deployed owner/platform and PostgreSQL coverage qualification remain separate from local/HTTP source tests and standalone package checks.

## SDK and boundaries

`createTestSuite(selection)` returns `{suite,sha256}`. `inspectTestSuite(value)` validates and hashes a manifest. `runTestSuite(host,suite,reviewedSha256,{signal?})` orchestrates execution; `testSuiteResult(host,suite)` only reads assessments. Pass an owned `LocalRuntime` or `PostgresRuntime`, or `createHttpTestSuiteHost(new RuntimeClient(...))`, to these functions. The SDK does not save files: persist the prepared manifest before dispatch. Keep the host open while the call is pending; an abort signal stops between operations and does not cancel an in-flight call.

For direct SDK clients, `RuntimeClient.pinInstance(uuid)` is an explicit one-way pin applying to later capability, health and operation requests, including inherited exact-release clients. Repeating the same pin is allowed; malformed pins or rebinding to another owner are refused. It does not retroactively guard/cancel already in-flight requests or verify database ownership. The suite host performs its read-only handshake before operations itself; other callers may provide a reviewed `expectedInstanceId` at client construction.

This adds no suite execution to the release-only app launcher or project-scoped browser preview. A release app does not contain the authoring test catalog. Scheduled suites, distributed scheduling, browser suite controls and cluster qualification remain open. Bounded parallel host/artifact/deployment qualification is recorded separately; a SDK capability does not qualify every management image, service limit or provider.

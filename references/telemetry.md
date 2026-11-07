# OpenTelemetry traces, metrics and logs

Use this when the user explicitly wants diagnostic telemetry sent to their chosen collector/backend. Export is disabled by default. The current implementation exports **execution traces, bounded-cardinality metrics and structured execution logs over OTLP HTTP/protobuf or explicit gRPC**, with separately opted-in HTTP request, connection/transport and grant-administration observations, W3C provider trace propagation, explicit allowlisted baggage and resource metadata. Optional local dashboard examples are available separately. Complete access/journal instrumentation, production deployment and cluster qualification remain pending. Three signal types do not by themselves complete the full observability scope.

The SQLite and PostgreSQL owners load the collector pipeline only when a valid explicit telemetry configuration is supplied. Without it, local execution, retained history, status and disabled probe reports do not initialize the OTel exporters. The runtime/storage/telemetry subpath report exports are SDK-free; report validation never selects a collector. With configuration, startup still validates credentials and creates the same bounded pipeline before returning the owner—there is no background enablement, environment-derived destination or fallback if loading fails. This is an internal loading boundary, not a promise that the single-file runnable app omits the exporter code; exported apps still bundle the complete runtime.

## Supported signal matrix

This is an **implementation map**, not a claim that every signal has passed every database, container, Collector/backend or Kubernetes profile. Use the qualification receipt for the exact runtime bytes and deployment being evaluated. All exports require a reviewed private startup configuration and an explicit destination for that signal: `endpoint` for traces, `metricsEndpoint` for metrics and `logsEndpoint` for logs. Omit a destination to send none of that signal. Every instrumentation flag below defaults to false; trace sampling does not sample metrics or logs.

| Observed boundary | Traces / structured logs | Metrics | Additional opt-in and host limits |
| --- | --- | --- | --- |
| [Execution segments and node attempts](#correlation-and-durability) | Run/resume/approval/cancel segments; node attempts and their ended logs | `execution.*`, `node.*` | No extra flag; SQLite and experimental PostgreSQL owners, including supporting exported apps. Human waits end active spans. |
| [Model calls, tries and backoff](#retry-enabled-model-tries) | Model call; built-in retry-enabled tries and admitted waits; corresponding ended logs | `model.*`, including reported tokens | No extra flag; tries/backoff require the reviewed retry policy and adapter hooks. Missing usage is not estimated; custom adapters must supply accurate observations. |
| [Saved-response recovery](#saved-response-recovery) | Linked resume segment and ended log with recovery mode/settlement | `recovery.*`, overlapping execution-segment totals | No extra flag; only explicitly admitted recovery. Never redispatches the model or recounts its original usage. |
| [Committed Rule routes](#committed-rule-route-correlation) | Node attributes `rule.port` / `rule.settled` and node-ended logs | No branch/port-labelled instrument | No extra flag; If/Else or Switch route only after acknowledged result persistence. Not a Decision answer/confidence export. |
| [Explicit approval-notification sends](notifications.md#opt-in-notification-observability) | Delivery span, correlated ended log, retained workflow/redelivery links | `notification.*` | No extra flag; an explicitly authorized send is required. Receipt inspection never sends or reconstructs telemetry. |
| [Reviewed suite invocations](suites.md#suite-invocation-observability) | Explicit run/result invocation span and ended log; suite hash as metadata, new run segments as children | `test.suite.invocations`, `test.suite.duration` | Owned SDK/direct local CLI use owner configuration. HTTP/Docker/HTTPS clients opt into a separate `createTestSuiteTelemetry` / `--suite-telemetry-file` pipeline and dedicated exporter credential, never owner configuration or fallback storage. Retained-only retry counts a new invocation, never reconstructed execution. |
| [HTTP requests and async slots](#optional-http-request-observations) | Owned server request span and ended log | `http.requests`, `http.duration`, `http.async.slots` | `httpRequests`; owned management/preview/exact-release HTTP(S) only. Slots additionally need metrics and enabled async routes; no slots for preview/direct SDK jobs. |
| [Connections and transport failures](#optional-http-connection-and-transport-observations) | Root socket lifetimes and bounded transport-failure events | `http.connections.*`, `http.connection.duration`, `http.transport.failures` | `httpConnections`; owned servers only, not outbound providers/exporters or the separate preview gateway. |
| [Transport admission checks](http-access-telemetry.md) | Independent-root predicate spans and correlated ended logs; optional owned HTTP links to local/coordinated request/control quota checks | `http.access.evaluations`, `http.access.duration` | `httpAccessDecisions`; quota request/log joins also require `httpRequests`. Fixed reached server guards, not complete grant admission or durable audit. |
| [Grant administration](#optional-grant-administration-observations) | Entered get/page/issue/revoke call span and ended log | `access.grant.*` | `grantOperations`; both SDK owners. API-call outcomes, not permission decisions or unique committed mutations. |
| [Retained-target grant policy](#optional-retained-target-grant-policy-decisions) | Synchronous predicate span and ended log | `access.policy.*` | `grantPolicyDecisions`; six fixed actions after retained-target lookup. Not every authentication/authorization attempt. |
| [Current process work](#optional-process-local-runtime-work-gauges) | None | `runtime.work.*` gauges | `runtimeWorkMetrics` + metrics; both owners. In-memory operation scopes/reservations, not distributed workers or queued runs. |
| [Retained runs and approval age](#optional-retained-state-and-approval-metrics) | None | `retained.*` gauges | `retainedStateMetrics` + metrics; validated selected-store projection, including retained history. Not live execution or automatic approval expiry. |
| [Storage queue occupancy](#optional-postgresql-storage-queue-metrics) | None | `storage.queue.*` gauges | `storageQueueMetrics` + metrics; PostgreSQL domain/journal queues. SQLite reports unavailable and omits occupancy. |
| [PostgreSQL journal paths](#optional-postgresql-journal-transaction-observations) | Transaction span/ended log under separate `journalTransactions` | `storage.journal.*`: availability, totals, seconds and duration histogram | `storageTransactionMetrics` + metrics; `journalTransactions` separately needs traces and/or logs. SQLite metrics report unavailable; SQLite startup refuses journal tracing. |
| [SQLite native calls](#optional-sqlite-native-call-observations) | None | `storage.sqlite.*`: availability, calls, seconds and duration histogram | `sqliteStatementMetrics` + metrics; owned connection only. PostgreSQL reports unavailable. Native calls are not SQL-statement/transaction counts. |
| [Exporter health](#optional-exporter-health-metrics) | Local SDK/management status is separate from OTLP spans/logs | `telemetry.*`: totals, occupancy and last outcome | `exporterMetrics` + metrics; enabled exporters only. Receiver acknowledgment is not downstream retention. |

Metric prefixes above abbreviate the fully qualified `jevable.` names listed in the linked sections. Metrics use bounded fixed labels; run/node/attempt IDs and Rule ports are not point labels. Traces/logs can contain validated diagnostic IDs, hashes and reviewed node/port names, but never prompts, generated text, Decision answers/confidence, approval actors, credentials or raw errors. [Resource identity](#optional-resource-identity) is shared across signals and can still be sensitive metadata.

The protected journal retains execution/approval/model evidence under its own access rules; OTLP is a best-effort diagnostic view, not a replacement audit ledger. Missing spans/logs or a false settlement flag cannot prove rollback. Historical reads/reopen/stable-ID retries never rebuild execution observations, although opted-in HTTP/storage reads can produce new diagnostics of those reads. Gauges require availability/freshness checks; cumulative counters reset under a new owner instance and successive snapshots must not be summed as events.

[W3C provider propagation and allowlisted baggage](#provider-context-propagation) are separate destination policies, not additional exported signals or authentication. Neither configuration nor this map starts a Collector, Docker service or cluster. Distributed scheduler/worker backlog, arbitrary stdout/stderr, complete access/journal coverage, real-provider downstream correlation and full end-to-end deployment/alert qualification remain outside this implemented map.

## Optional process-local runtime work gauges

Set `"runtimeWorkMetrics": true` with an explicit `metricsEndpoint` in the private startup telemetry JSON. It defaults to false, independently of trace sampling and other instrumentation. The option enables interval/flush/close collection even when execution counters have not changed. Both standalone SQLite and PostgreSQL owners supply their existing memory-local operation and run-reservation counts; no server, Docker, desktop or Jarness is required.

Discover support through `capabilities.workflowRuntime.runtimeWorkTelemetry` in the core CLI/API, or `runtimeWorkTelemetry` in an exact-release service's capability report. The shared metadata describes the startup option, default, destination requirement, gauge names/units and process-local limits; it does not report whether that particular owner enabled telemetry or its current counts. Discovery never configures telemetry or executes work. Exact-release services still expose no management `telemetry.status`, `telemetry.flush` or telemetry-configuration operation; normal interval and shutdown collection use the operator's private startup configuration.

| Instrument | Unit and meaning |
| --- | --- |
| `jevable.runtime.work.available` | `1` when the open owner supplies complete current counts; `0` means unknown, not idle |
| `jevable.runtime.work.operations` | `{operation}`: admitted asynchronous SDK operation scopes, including readiness, reads and nested scopes |
| `jevable.runtime.work.run_reservations` | `{run}`: run IDs currently reserved during admission, execution, control or settlement |

These gauges have **no point labels**. Counts overlap and must not be added together. A reservation can precede node execution or await a model/storage response; it is not an executing-node or thread count, queue, capacity, unique request total, distributed worker lease or successful mutation. Synchronous facade operations outside the existing async gate are not counted. A sampled gauge can miss short work. Saved waiting/paused/uncertain checkpoints without live ownership are not reservations; use retained-state metrics for those separate facts. The same run's exact-ID retry may briefly enter an operation scope without dispatching or reserving that run.

Collection copies only these two nonnegative safe integers and reads no database, workflow payload, ID, credentials or queue. Exporter credential lookup remains the existing independent export behavior. Work admission, concurrency, cancellation, shutdown, storage formats and retry authority are unchanged. Closing/lost PostgreSQL owners, missing/throwing/invalid sources and unsupported telemetry-only hosts export availability zero and omit occupancy—including cached earlier gauges—instead of inventing zeroes. A later valid diagnostic source can restore availability; it does not reopen or repair an owner.

Counts reset under a new runtime `service.instance.id` and are not rebuilt from history. Reopen with retained work can legitimately be idle; that does not resolve an uncertain external effect. Collector failure never resumes or retries work. Gate dashboards on owner identity, availability and freshness: a disconnected backend cannot receive even an unavailable flag. These are current process-local work diagnostics, not a scheduler/backlog implementation, durable audit, production monitoring or complete worker/deployment qualification. Use runtime bytes supporting this option; older strict bundles may reject it. Real database, installed/bundled/container/browser/Collector/backend/Kubernetes qualification remains separately scoped.

## Optional retained-target grant-policy decisions

Set `"grantPolicyDecisions": true` in the private startup telemetry JSON. It defaults to false independently of `grantOperations`, HTTP instrumentation and trace sampling. The SQLite transaction guard and PostgreSQL guarded-action planner observe their existing **synchronous retained-target policy predicate**, after token/record/target lookup. This is not a new authority path or a prerequisite for standalone SDK/CLI execution. No server, Docker, desktop or Jarness is needed.

Each evaluation produces an internal `jevable.access.policy` span and correlated `jevable.access.policy.ended` log, subject to the configured signal destinations and export bounds. Explicit runtime request context parents the observation, never ambient global context or baggage. `jevable.access.policy.evaluations` is a cumulative ended-evaluation counter; `.duration` is a cumulative explicit-bucket histogram in seconds, with the existing runtime duration bounds. Timing covers only the synchronous policy predicate, excluding token/target lookup, queue wait and later storage writes. The two fixed metric keys are `jevable.access.action` (`caller.start|caller.read|caller.control|caller.cancel|reviewer.approve|reviewer.reject|reviewer.custom`) and `jevable.access.policy.outcome` (`admitted|refused|failed`), at most twenty-one groups. Custom names never become metric label values.

`admitted` means the predicate returned its exact scoped admission, **not** that a write committed, execution started or a caller received a result. `refused` means its existing masked `not-found` policy refusal. This is an expected decision and uses INFO/unset span status; other evaluation faults use ERROR and fixed span/log `error.type: grant_policy_failed`, never raw error details. This distinction follows [OpenTelemetry's context-dependent error guidance](https://opentelemetry.io/docs/specs/semconv/general/recording-errors/). Metrics retain only the two fixed action/outcome keys.

The PostgreSQL writer must still submit the exact planned grant/target conditions with its commit; an admitted observation cannot bypass those guards. SQLite may evaluate the predicate multiple times inside one transaction; each counts separately, even if the transaction later rolls back. No token/digest/grant/run/release/attempt ID, actor, scope, target/input/output or baggage enters these diagnostics. Hooks cannot change original values/errors, repeat the predicate or authorize a retry.

Preliminary token syntax/lookup, role/read/retry admission, invalid commands and failures before reaching this predicate are **not counted**. Read-only retries can therefore produce no policy evaluation. Direct internal policy evaluation remains unobserved unless its trusted host explicitly supplies the optional fixed-action observer; this predicate is not a public SDK entry point. These signals are neither all authentication/authorization attempts nor unique requests, permission guarantees, a durable access audit or business-success totals. Ordinary exporter loss and process resets retain the existing telemetry semantics; enabling/reopening never reconstructs past evaluations. Broader packaged/received-wire/PostgreSQL/container/platform/backend and full access/journal qualification remain separate. Older strict bundles may reject this startup field; use a release pinned to supporting runtime bytes.

## Optional grant-administration observations

Set `"grantOperations": true` in the private startup telemetry JSON to observe the standalone SQLite/PostgreSQL owner's administrative `grant`, `grants`, `issueGrant` and `revokeGrant` calls, including their management API/CLI equivalents. It defaults to false, is independent of `httpRequests`/trace sampling, and uses only configured signal destinations. No server, Docker, desktop or Jarness is needed for direct SDK/local CLI use.

Each entered owner call emits an internal `jevable.access.grant` span and `jevable.access.grant.ended` log on return/throw, subject to normal sampling/export bounds. Explicit request context can parent it; no ambient global context is used. `jevable.access.grant.calls` is a cumulative ended-call counter; `jevable.access.grant.duration` is a cumulative histogram in seconds with the existing runtime duration buckets. Duration includes validation/storage queue wait until the owner call returns or throws. Both metric labels are fixed: `jevable.grant.operation` is `get|page|issue|revoke`, and `jevable.grant.outcome` is `returned|threw`—at most eight combinations. Logs/spans add elapsed seconds/error status and the fixed error type `grant_operation_threw`, never a raw error. Fixed dimensions follow the [OpenTelemetry cardinality guidance](https://opentelemetry.io/docs/specs/otel/metrics/sdk/#cardinality-limits).

These are API-call diagnostics, **not permission decisions, unique mutations, database commit certainty, client receipt, durable access auditing or business success**. Identical issue/revoke retries count again while retaining the original grant history. A throw can mean validation, not-found, conflict or storage uncertainty; no error code/actor/token/digest/scope/run/release ID, input/output or baggage value is recorded. Closed-owner refusals occur before observation; disabled configuration produces no grant signals. No new reads/writes, credential lookup, permission change, retry, grant expiry or revocation is triggered by instrumentation. Synchronous SQLite reads remain synchronous; PostgreSQL/native Promise calls settle before the observation ends, and diagnostic failures preserve the original result/error.

Counters reset on owner reopen; do not sum cumulative snapshots or merge owner instances without reset handling. Export loss never replays work. Production, actual PostgreSQL wire, packaged/container/platform and full access/journal qualification are separate from source/private SQLite fixtures. Older strict bundles can reject the new startup field; preserve compatible readers and qualify the supporting exact runtime hashes instead of treating historical receipts as current acceptance.

## Optional HTTP quota SQL observations

With `httpAccessDecisions: true`, the built-in PostgreSQL HTTP rate coordinator's entered debit calls emit `jevable.http.rate.sql` child spans, `jevable.http.rate.sql.ended` logs and cumulative `jevable.http.rate.sql.operations`/`jevable.http.rate.sql.duration` counter/histogram metrics to the explicitly configured destinations. Five fixed operations (`begin`, `lock`, `debit`, `commit`, `rollback`) combine with `acknowledged`, `failed` or `uncertain`. Metrics have only operation/outcome labels; spans/logs additionally identify PostgreSQL and the fixed statement type. No SQL text, parameters, scope/request IDs, policy, credentials, actor, payload, baggage or raw driver error is exported. This uses the existing opt-in; omission remains disabled.

SQL spans are children of the server's explicitly owned quota predicate, never the request's incoming or ambient trace context. Sampling can omit spans while ended logs/cumulative metrics remain available. The optional trusted SDK `consume` observer is diagnostic only and separate from the debit command; malformed/aborted/sealed calls and queued refusals before SQL emit no SQL calls. Coordinator startup/initialization is not attributed to an HTTP request. Hosts that do not implement the observer produce no SQL observations; missing signals are not fabricated.

An acknowledgement records the driver's SQL-call return, not business success or durable backend certainty. A thrown COMMIT records `uncertain`, seals the existing owner and returns no debit receipt; it never triggers rollback, refund, reconnect or retry. Abort after acknowledged COMMIT still suppresses admission without inventing rollback. Diagnostic faults do not change original SQL results/errors or dispatch authority. Counts are entered calls, not transactions, unique requests or committed workflows; cumulative snapshots reset with owner replacement and must not be summed. Source driver-double and local HTTP serialization tests are not actual PostgreSQL/TLS fault, packaged-image, Collector decoding, Kubernetes or production acceptance; supporting exact-runtime delivery and received-wire qualification remain separate.

## Optional PostgreSQL journal transaction observations

Set `"storageTransactionMetrics": true` with `metricsEndpoint` to observe the owned PostgreSQL journal. It defaults to false and is independent of trace sampling. SQLite currently reports availability zero, not fabricated transaction totals. Direct `PostgresJournal` SDK users may explicitly call `enableTransactionMetrics()` and read `transactionMetrics()`; neither performs SQL or reconstructs earlier observations.

The runtime enables observations after startup validation. Six fixed groups combine `read|write` with `acknowledged|failed-before-commit|commit-uncertain`. `jevable.storage.journal.transactions` is a cumulative ended transaction-path counter; `jevable.storage.journal.duration` is cumulative active-path seconds, not a histogram or percentile. Timing starts when queued work actually enters the transaction path, includes failed BEGIN, SQL/row-lock and COMMIT/ROLLBACK wait, and excludes local queue wait. It does not assert that BEGIN was acknowledged. Queued owner-loss refusals and invalid/closed pre-admission calls are not transaction observations. A write call retry that reads an existing batch receipt is still a write-path transaction, not another unique mutation.

The same opt-in also exports `jevable.storage.journal.transaction.duration`, a cumulative explicit-bucket histogram in seconds for those same six ended-path groups. Bounds are `0.001, 0.01, 0.1, 0.5, 1, 5, 10, 30, 60, 300, 3600`, inclusive at the upper edge, plus the final overflow bucket. Count and sum match the counters in the same collection; nonempty groups include observed min/max, while empty groups omit extrema. Six fixed twelve-bucket arrays are maintained at recording time: no event list, database query or reconstruction from a cumulative average. Collection copies the same validated snapshot once and uses the counter's SDK collection timestamps. The start timestamp is diagnostic series creation, not a journal event or exact transaction-start receipt. See the [OpenTelemetry histogram contract](https://opentelemetry.io/docs/specs/otel/metrics/data-model/#histogram).

Older/custom SDK sources may supply all six counter-only groups; they remain valid but omit the histogram rather than inventing a distribution. Partial, malformed or internally inconsistent distributions invalidate the entire observation and omit stale counters/histograms. This histogram describes ended active transaction paths, not human wait, local queue delay, transaction throughput, unique mutations or known commit durability. A percentile computed by a backend is an estimate limited by these buckets. Do not sum successive cumulative snapshots or mix restarted owners without their resource-instance and reset semantics.

The histogram shares the duration counter's serialized SDK sum. Cumulative counter delta re-aggregation can round by an ULP relative to the direct journal snapshot; distributions and extrema still use the recorded observations, with no sample replay. Consistency guards allow accumulated floating-point error but reject impossible populations. Counts and bucket totals remain exact safe integers.

Acknowledged means the local journal received COMMIT acknowledgement and had not observed ownership loss at that point. It does not prove client receipt, backup/replica durability, external effects or business success. Failure before commit does not assert that rollback was acknowledged. Commit uncertainty is never relabelled as success or failure with known durability; inspect retained evidence independently and never retry work to repair telemetry.

`jevable.storage.journal.available` indicates that process-local observation totals are known, not live database health/ownership. Ended totals remain known after close/loss until process exit; reopening creates fresh process observations. Recording overflow/invalid timing, throwing/invalid sources or unsupported storage yield zero availability and omit stale totals. Labels contain only the two fixed enums: no namespace, collection/key, batch/owner/run identity, SQL, payload or raw error. Snapshot collection is memory-only, never entering a storage queue. Ordinary health, inspection and exporter-credential reads are real read transactions and may increase totals; these are storage-workload observations, not workflow activity statistics.

Collector failure neither resets observations nor replays journal/workflow operations. Missing export credentials can prevent delivery; counters and histograms are not a guaranteed durable audit log. Source tests cover the journal control flow and serialized SDK metrics, not real PostgreSQL/received-wire, container, production backend or Kubernetes qualification. Each qualification receipt identifies its exact artifact and scope; earlier counter-only runtime/image receipts do not qualify the newly added histogram bytes. Request-owned journal spans/logs have the separate opt-in below; full execution/storage ancestry and end-to-end deployment observability remain separate work.

## Optional PostgreSQL journal spans and logs

Set `"journalTransactions": true` at PostgreSQL workflow-runtime startup with an explicit trace `endpoint` and/or `logsEndpoint`. It defaults to false, requires at least one of those destinations, and is independent of `storageTransactionMetrics` and trace sampling. SQLite startup refuses this option before opening state; it does not pretend to implement PostgreSQL journal tracing. No desktop, Jarness, Docker or persistent server is required by the SDK.

`jevable.storage.journal.transaction` is an internal span; `jevable.storage.journal.transaction.ended` is its correlated ended log. Attributes contain only `jevable.storage.transaction.kind` (`read`/`write`), `jevable.storage.transaction.outcome` (`acknowledged`/`failed-before-commit`/`commit-uncertain`) and, for failed/uncertain paths, a fixed `error.type`. Logs additionally include a measured duration. No SQL, namespace, collection/key, batch/owner/run identity, credential, payload, baggage, actor or raw error is admitted. Resource service/runtime-instance/storage labels still apply.

Observations begin at the actual queued transaction path immediately before BEGIN, not at admission. They exclude queue wait and startup/acquisition/history reconstruction. A queued operation refused before BEGIN has no transaction span/log. Ordinary SDK health/inspection reads are real transactions and may emit signals. The original acknowledgement/uncertainty semantics described above still apply: these diagnostics are not durable receipts, database health checks or permission to retry.

During execution, journal parentage uses the live span that owns the work: segment setup/reads use the segment, node trace/result persistence uses the node, and model-adapter persistence uses the model call. Cursor-level segment context is only a fallback, never an override of a narrower node/model scope. Successor setup does not inherit the prior completed node. Direct SDK runs therefore correlate execution-time journal work without an incoming request parent. Queued concurrent operations preserve their own captured contexts; scopes restore after normal returns and exceptions.

Only actual span objects created by this telemetry owner are eligible for execution scopes. No global OTel context, foreign owner, saved identifier object or historical reconstruction is consulted. Journal ancestry has its own ephemeral context: request parents, baggage and retained execution-segment parent/link metadata remain unchanged. Cancel settlement uses its new cancel segment; approval/recovery cursor writes use their new segments, and continued approval execution uses the same live approval span.

For retry-enabled configured calls, each try's intent and settlement writes now use its own still-live `jevable.model.try` span. The runtime supplies an optional ephemeral `ModelTryObservation.withJournalScope` callback using the actual owned span, never a saved trace identifier. Sampling zero does not make that live span ineligible. Preparation/reentry/historical verification remains under the model call or existing outer scope, not an invented try. Retry backoff waits contain no storage writes while live; the wait ends before a later intent or cancellation/deadline settlement. Those later operations therefore use the next live try or enclosing model, never the ended backoff/try. Queued operations still choose live ancestry at their actual transaction begin.

The built-in adapter snapshots the optional diagnostic callback and guards persistence work exactly once. A throwing, duplicate, ignored, deferred or result-substituting custom callback cannot replay a write, replace its result/Promise or mask its error. This adds no retry/dispatch authority and changes no SQL control flow, evidence format, request/baggage carrier or provider header. Source regressions exercise shared execution/configured retries with private provider/OTLP receivers and simulated journal transactions; changed-build real PostgreSQL, independently installed try-lifetime and deployment qualification remain separate.

Before a live execution/approval/cancel/recovery span exists, admission/authentication/preparation reads still use an explicitly owned request context if supplied, or start an independent trace. Read-only historical retries and later health calls do not inherit an ended execution scope. This is not a claim that every authoring or storage operation has workflow ancestry. Sampling zero omits spans but retains correlated logs if configured. Logs-only mode creates correlation IDs without exporting invented traces.

Exporter bearer-credential reads execute real SQL and remain included in opted-in transaction statistics. Request-local suppression prevents only those reads from creating new journal spans/logs, avoiding recursive exports. It does not suppress other concurrent requests or other journal owners. Export failure neither reruns SQL/workflows nor replaces original results/errors. Bounded queues, shutdown and dropping are best-effort; saved execution evidence remains authoritative.

Source tests decode actual HTTP/protobuf packets from private test receivers and exercise the journal/runtime against explicitly labelled SQL-client and in-memory persistence doubles, with the real execution and transition guards. These are not real PostgreSQL persistence/hook/fault, real provider/Collector/backend, deployed-container or live-Kubernetes qualification. Use the receipt for the exact installed artifact; historical build receipts do not qualify changed runtime bytes.

## Optional SQLite native-call observations

Set `"sqliteStatementMetrics": true` with `metricsEndpoint` at startup to observe this local owner's SQLite connection. It defaults to false, requires no server, desktop, Jarness or Docker, and is independent of trace sampling. PostgreSQL owners without a SQLite source report availability zero, not invented zero activity. This is separate from PostgreSQL `storageTransactionMetrics`.

The runtime wraps only its own connection after schema setup/migration; native prototypes and other connections are untouched. Retained startup validation and ordinary project/provider/test/release/run reads and writes on that connection are included. Counts represent native method calls, **not SQL statement counts, transactions or workflow successes**: one `exec` can contain several statements, `prepare` does not execute, and `iterator.next` includes the final completion probe. The implementation follows the synchronous [Node SQLite API](https://nodejs.org/download/release/v22.19.0/docs/api/sqlite.html). Iterator construction, each `next` and early `return` are separately timed, excluding application work between steps.

`jevable.storage.sqlite.calls` and `.seconds` are cumulative counters; `.duration` contains actual cumulative duration buckets with the same bounds as journal duration observations. All sixteen groups use only `jevable.sqlite.method` (`exec`, `prepare`, `all`, `get`, `run`, `iterate`, `iterator.next`, `iterator.return`) and `jevable.sqlite.outcome` (`returned`, `threw`). No SQL, arguments, rows, database paths, identities or raw errors are retained as observations or labels. A returned method may subsequently be rolled back; neither outcome proves commit durability or external/business success.

`jevable.storage.sqlite.available` reports known process-local totals, not live database health. Invalid timing/overflow makes them unavailable for that owner; missing/invalid/throwing sources omit stale totals and histograms. Collection reads memory only and never executes SQL. Ordinary exporter bearer-credential lookup is a real database read and can appear in a subsequent sample. Export failure does not replay storage/workflows or reset these observations. Reopening creates fresh totals under a new service instance; never sum cumulative snapshots or merge restarted owners without reset handling. Telemetry hook failures cannot replace native results/errors or authorize retries. These observations are not a durable audit log or full storage tracing. Installed-artifact, received-wire, container/backend and live-cluster qualification remain separately scoped.

## Configure the destination

Explicit approval-notification sends have their own persisted trace identities, workflow/redelivery links, structured ended logs and bounded outcome metrics on both SQLite and PostgreSQL. See [notification observability](notifications.md#opt-in-notification-observability) for acknowledgement uncertainty and privacy rules. Reading a retained receipt does not replay delivery or rebuild telemetry; these signals never grant approval authority.

For an optional real local Collector/backend and Jevable dashboard, see [observability.md](observability.md). That separately started development profile does not become a runtime dependency or prove production/Kubernetes readiness.

Write a small JSON file outside any shared artifact:

```json
{
  "endpoint": "http://127.0.0.1:4318/v1/traces",
  "metricsEndpoint": "http://127.0.0.1:4318/v1/metrics",
  "logsEndpoint": "http://127.0.0.1:4318/v1/logs",
  "authentication": { "kind": "none" },
  "serviceName": "jevable-workflow-runtime",
  "environment": "local",
  "sampleRatio": 1,
  "queueSize": 256,
  "batchSize": 64,
  "timeoutMs": 3000,
  "flushTimeoutMs": 5000,
  "intervalMs": 1000
}
```

This example requires a separately configured receiver; Jevable does not install or launch one. With the default `"protocol": "http/protobuf"`, `endpoint`, `metricsEndpoint` and `logsEndpoint` are exact trace, metric and log URLs, not base URLs. Omit a URL to disable that export signal; at least one is required. No destination is inferred from another. HTTPS is required except for explicit loopback HTTP fixtures/local collectors. Credentials in the URL, query strings and fragments are refused. No `OTEL_*` variable, ambient resource detector, default global SDK, workflow file or desktop setting selects a destination. Private tracer/meter/logger providers do not register globally. Signals share the explicitly selected authentication policy and resource metadata; configure receiver-side routing if different downstream credentials are needed.

For collector authentication, use `{"kind":"bearer","credentialRef":"otel/key"}` and provision that reference in the selected runtime's protected credential store, using `credentials set otel/key --file <owner-only-key-file> --expected-generation 0 --data-dir <directory>`. Never place secret values in the telemetry JSON, CLI arguments, workflow source, previews or chat. A configured but missing exporter credential is a startup error; later rotation/removal can cause export loss without rerunning work.

Configuration defaults match the example. Limits: each trace/log queue 1–4096 records, each trace/log batch 1–128 (no larger than queue), request timeout 10–30000 ms, flush timeout 10–60000 ms and interval 10–60000 ms. The same queue/batch limits apply independently to the two record queues; their combined capacity is twice `queueSize` when both are enabled. Trace sampling ratio is 0–1; metrics and logs are not sampled. Export requests are bounded to 4 MB and responses to 64 KB. Each signal has at most one in-flight request. Traces/logs use bounded queues; metrics aggregate locally with a fixed cardinality cap and no snapshot queue. There is no exporter retry; failed batches are counted as dropped. Optional receiver-side retry/buffering is a separate operational choice.

## Explicit OTLP/gRPC

Set `"protocol": "grpc"` and use **origin-only URLs** for each selected signal, without `/v1/traces`, `/v1/metrics`, `/v1/logs` or a custom RPC path:

```json
{
  "protocol": "grpc",
  "endpoint": "https://collector.example:4317",
  "metricsEndpoint": "https://collector.example:4317",
  "logsEndpoint": "https://collector.example:4317",
  "authentication": { "kind": "bearer", "credentialRef": "otel/key" }
}
```

Replace the example host with the user's authorized receiver and provision the credential separately. Remote connections require verified TLS; there is no insecure, custom-authority or hostname-verification bypass. Node's trusted roots are used; a private additional CA may be explicitly provisioned via `NODE_EXTRA_CA_CERTS` **before starting the process**, as with the existing Kubernetes extra-CA packaging. That changes process-wide trust, not a single workflow. It does not choose a destination or authorize export. Plaintext `http://` is accepted only for loopback fixtures/local collectors. `grpc://`, DNS resolver URIs, arbitrary metadata and URL credentials are refused. The optional local backend's [gRPC override](observability.md#optional-grpc-receiver) is a development example, not remote TLS provisioning.

The core uses Node's built-in HTTP/2 transport and the existing official OTLP protobuf serializers. Each export uses the fixed unary Export method for its signal, one uncompressed request/message and a fresh connection, with no channel pool, proxy discovery, compression, gRPC-Web, streaming or automatic retry/fallback. The deadline includes credential lookup, connection/TLS setup and response consumption. Missing or nonzero gRPC status, malformed/compressed/oversized responses, disconnects and resets count as export failures; raw status messages and binary error details never enter health output. Partial-success protobuf replies retain the existing rejected-record accounting. Limits remain 4 MB request and 64 KB response payload, plus the five-byte gRPC envelope; record queues and per-signal concurrency are unchanged. See the [OTLP contract](https://opentelemetry.io/docs/specs/otlp/#otlpgrpc) and [gRPC HTTP/2 framing](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md).

`telemetry.status` reports the selected `protocol` at the top level and for enabled metric/log exporters. Earlier runtime bundles may reject the new option; use a release pinned to the supporting runtime rather than editing bundled bytes. Wire compatibility does not imply production proxy, collector, database, container or cluster qualification. Collector loss never authorizes workflow/model replay.

For standalone release notifications, API, recipient and Collector trust have distinct roles. Node's explicitly reviewed startup additional-CA bundle can trust outbound HTTPS HTTP/protobuf or TLS gRPC; the SDK's API `ca` configures only that API connection. Export certificate refusal must not change a retained notification outcome. Later inspection or same-ID retry does not reconstruct lost exports. `sampleRatio: 0` preserves unsampled intent/request identities and correlated enabled logs/metrics without exporting traces. Source-checkout qualification `qualification/release-notification-secure-telemetry.json` records the private Node-only fixture scope separately from production backend retention, container/cluster networking and alert qualification.

## Optional resource identity

Add `resource` to the same private telemetry JSON only when these infrastructure identifiers may be sent to the selected collector:

```json
{
  "serviceNamespace": "automation",
  "kubernetes": {
    "namespace": "workflows",
    "podName": "workflow-123",
    "podUid": "11111111-1111-4111-8111-111111111111",
    "containerName": "workflow",
    "nodeName": "node.example",
    "clusterName": "production"
  }
}
```

This is the `resource` object's value, not a complete telemetry file. Every field is optional; omit unknown identities rather than inventing them. Service namespace/cluster name accept 1–128 printable non-space ASCII characters; Kubernetes namespace/container names are bounded lowercase names (63 characters), pod/node names 253 characters, and pod UID must be a UUID. Unknown fields, labels, annotations and arbitrary resource attributes are refused. Treat operator-supplied metadata as a claim, not an attestation of cluster membership.

All enabled signals share `service.namespace` and the corresponding `k8s.namespace.name`, `k8s.pod.name`, `k8s.pod.uid`, `k8s.container.name`, `k8s.node.name`, `k8s.cluster.name` resource fields. These are resource attributes, not additional metric point labels. Names follow the [OpenTelemetry Kubernetes resource conventions](https://opentelemetry.io/docs/specs/semconv/resource/k8s/).

The runtime still owns `service.name`, `service.version`, `deployment.environment.name`, storage kind and a fresh random `service.instance.id` per runtime owner. Do not substitute pod UID for instance ID: restarting a container can retain pod identity while starting fresh cumulative metric counters. No `OTEL_RESOURCE_ATTRIBUTES`, Kubernetes environment variables, API server, host detector or harness settings are read by the core. [Kubernetes export](kubernetes.md#optional-pod-telemetry-identity) can explicitly stage Downward API metadata into this configuration; direct SDK/CLI and other deployment hosts supply it themselves. Older runtime bundles may reject this optional schema; export a release pinned to a supporting runtime instead of modifying its bundled bytes.

Supporting runtime builds expose the generated ID as `telemetryStatus().resource.serviceInstanceId`, including authenticated `runtime.telemetry.resource.serviceInstanceId` in health. Owned SDK services and default CLI/app readiness receipts additionally include `telemetryResource.serviceInstanceId` before callers dispatch requests. This is exactly the resource ID shared by traces, metrics and logs, not the separate HTTP `instanceId` used for API fencing. Disabled telemetry omits this metadata; status returns a fresh copy and never exposes the collector, credentials, arbitrary resource labels or payloads. Normal reopen creates a new telemetry ID. Capture it from trusted startup metadata before recording a `service.instance.id` caller ledger; do not infer intended owners from signals, replace HTTP fencing pins with it, or retroactively upgrade older failed captures. Disclosure proves neither exporter delivery nor backend retention. New bundled/image profiles require separate qualification; old installed apps remain unchanged.

## CLI, service and release app

Commands that accept `--data-dir` also accept `--telemetry-file`:

```sh
node bin/jevable.mjs run examples/echo.yaml --input examples/echo-input.json --data-dir .jevable --telemetry-file /private/path/otel.json
node bin/jevable.mjs runtime serve --token-file /private/path/api-token --data-dir .jevable --telemetry-file /private/path/otel.json
```

An exported app accepts the same option on execution/state commands:

```sh
node app.mjs run --input input.json --id <retained-run-uuid> --telemetry-file /private/path/otel.json
node app.mjs decide <waiting-run-id> --attempt <reviewed-attempt-id> --action approve --telemetry-file /private/path/otel.json
```

Telemetry settings/credentials are not included in release/project exports. Supply them separately at the destination. Raw input/output is excluded from exported spans/logs, but run/project/release IDs, revision hashes, node IDs, loop positions, timing and configured service/environment names are diagnostic metadata and leave the machine. Review the destination and metadata sensitivity before enabling export. In particular, user-chosen node IDs can themselves contain sensitive text. This is not an anonymization guarantee.

For an explicitly owned Docker management service, `runtime start --runtime docker --telemetry-file <private-json>` provisions configuration independently. Bearer authentication additionally requires `--telemetry-credential-file <private-token>` to initialize the named credential before service startup; it is never included in the telemetry JSON or exports. See [Docker telemetry setup](docker-owner.md#optional-opentelemetry-configuration) for private-file bounds, container-loopback meaning, trust and partial-start behavior. Ordinary Docker-selected run/test commands cannot override a running owner's telemetry destination.

The Docker-owner qualification (source-checkout receipt `qualification/docker-telemetry.json`) verifies all three authenticated signals, metadata-only correlation with retained run segments, collector-rejection isolation and fresh resource identity after clean restart. Its receiver is a test-only loopback fixture inside the owned container, not a real Collector/backend deployment or proof of external collector reachability.

## Correlation and durability

The journal commits execution-segment trace IDs and links, node intent, then node trace identity before model dispatch. Node spans end only after settlement commits; a failed commit is an error span and leaves an uncertain attempt. Each node carries its run ID, actual attempt UUID/ordinal and loop scope. Model spans are children of the node attempt and include reported token usage where available, never prompts, generated text, credentials or raw error messages.

Approval waits end their active spans rather than keeping them open for hours. After restart, an authorized decision creates a fresh linked segment referencing the saved earlier segment; both approve and reject outcomes retain that link. The original approval request's node trace stays attached to its saved attempt. Read-only inspection, startup validation and stable-ID retries do not manufacture execution spans or rerun work.

The single-owner HTTP API accepts a strict W3C version-00 `traceparent` on an authenticated operation. Invalid/duplicate trace-parent headers are rejected. Without request instrumentation, the segment retains the incoming parent identity; with `httpRequests`, it retains the API span as its parent instead. `tracestate` is ignored. Baggage is ignored by default; the separate explicit policy below is required to admit it. SDK hosts can use `runtime.withTraceParent(header, () => operation())` explicitly; this legacy method clears baggage for its scope. No ambient async context is automatically trusted.

Both SDK clients expose `operation(command, traceParent?)`: the exact-release `ReleaseClient` preserves this inherited contract while injecting its own reviewed release checksum. Retained run/delivery identity, sampling flags and exact-ID retries remain unchanged. This is explicit caller correlation, not a CLI ambient-context detector or authorization mechanism. Read-only retry can create a new API observation when enabled, but never recreates an execution or notification-delivery span.

### Cancellation admission and later settlement

With telemetry configured, the first authorized owner or caller cancellation admission atomically saves its current explicit context as `cancellation.traceParent`, when one exists. Caller requests still accept only `{requestId}`: a trace header or trusted SDK propagation hook is correlation, never actor, scope or authority. With `httpRequests`, the saved admission context is the authenticated cancellation API span; otherwise it is the explicit incoming parent. Admission records precede cooperative abort. An uncertain acknowledgement can leave the admission retained without settlement.

A later `cancel` execution segment keeps the context of the actual worker that settles it. In particular, active cancellation does not replace the original worker/start parent with the cancellation API parent. The segment separately retains `cause: {kind: "cancellation", requestId, parent}` derived only from committed admission. Its span links to the prior execution segment and the cancellation admission context, deduplicating identical trace/span pairs. The cancel span and ended log carry validated `jevable.cancellation.request_id`, `jevable.cancellation.trace_id` and `jevable.cancellation.span_id`; these are diagnostic metadata, never metric labels or private actor/scope data. Metadata-only evidence and trace navigation preserve both relationships.

Identical caller retries only observe the saved request: a different retry parent never changes admission, settles inactive uncertainty or rebuilds execution spans/logs/counters. Freshly revoked/expired grants still refuse before parent adoption. Opening storage without telemetry preserves existing context but never reconstructs delivery. Admissions without explicit context or older records remain unlinked; enabling telemetry later does not fabricate a historical parent. Unsampled context remains valid metadata, not a received span. Retained journal consistency is not authentication against a privileged writer changing all records, and Collector acknowledgement is not backend retention.

These optional JSON fields are readable by the current core alongside older records. Older strict runtime bundles may reject newly written fields; preserve a compatible reader/backup, do not downgrade shared state or edit pinned bundle bytes. Independent installed, actual database and deployment qualification must refer to the supporting runtime hashes, not earlier receipts.

## Optional HTTP request observations

Set `"httpRequests": true` in the private startup telemetry JSON to observe the owned SQLite/PostgreSQL management, scoped preview and exact-release HTTP/HTTPS services. It defaults to `false`; existing execution-only telemetry remains unchanged. It uses only the explicitly configured signal endpoints. The separate Docker preview gateway does not own an exporter: the selected management service observes forwarded operations when its own configuration enables this option.

Each request reaching the service handler produces a `jevable.http.request` server span and a correlated `jevable.http.request.ended` log, subject to sampling/queue/export limits. `jevable.http.requests` counts ended observations; `jevable.http.duration` measures seconds until **both** the handler and response finish or disconnect. A disconnected request can still commit work: these observations are not transaction receipts or evidence that a client received the response. No operation is cancelled or retried by telemetry. The server drains these observations before closing its runtime exporters.

Only an authenticated, otherwise admitted operation can supply the strict incoming W3C parent. Its API span becomes the parent of any new execution segment, including the identity retained in the run journal. Rejections and non-operation requests are independently rooted; health, capabilities, static HTML, bootstrap and logout do not trust inbound trace context. Invalid parent headers yield an independently rooted refusal. Concurrent requests have isolated context. A stable run-ID retry generates another API observation but does not manufacture another execution segment or replay work.

### Optional response correlation

Add `"httpResponseContext": true` alongside `"httpRequests": true` to expose the request's own context in the response header `X-Jevable-Traceparent`. It defaults to false, requires request observations and never changes authentication, routing, sampling, destinations or retry behavior. Opt in only after reviewing disclosure of trace IDs to callers, including callers receiving refusals and unauthenticated preview HTML. The value is strict version-00 W3C-shaped metadata identifying the **server HTTP span**, not an echoed incoming header or an execution/run ID. No baggage, tracestate, credentials or payloads are returned. Reads and refusals remain independently rooted; admitted operations retain their existing parent and execution ancestry. Static management capability metadata advertises support; enabled `telemetry.status` reports the setting.

This permits an independent caller ledger to retain intent, response status/time and returned context, then join health/readiness requests, refusals or other responses to the same span/log identity at its reviewed Collector. Unsampled contexts carry `00`; they may join logs without an exported span. A header is not proof of exporter acknowledgement, backend retention, handler settlement, workflow commit or a complete traffic population. Disconnection before headers, parser/handshake failures, disabled observations or diagnostic faults may yield no header. The separately hosted preview gateway is not covered by this owned-server feature. Collection needs its own secure retention/limits; this option does not create a ledger, change the Kubernetes readiness script or retroactively resolve earlier fixed-population failures. HTTP metric labels remain unchanged and never include these IDs.

With `httpRequests: true`, an explicit `metricsEndpoint` and enabled asynchronous HTTP routes, `jevable.http.async.slots` is a non-monotonic sum of currently held process-local capacity slots (`{slot}`). Its only point label is `jevable.http.async.phase=admitting|completing`. Admission starts after a capacity slot is reserved and includes readiness/durable creation; completion starts when the owned SDK returns its admission and ends when its original completion promise settles, even after the client disconnects. Readiness failures release admission slots; quota refusals and status reads reserve none. Identical retained submissions can briefly hold a slot without execution. A waiting/paused workflow can have zero slots after its invocation settles. Counts are not unique runs, executing nodes, a scheduler backlog, available-capacity promises or distributed worker leases. Interval/flush/shutdown snapshots can miss short phases, reset with the owner and be lost during export/process failure. No run IDs, payloads, request URLs or actors label this metric. Collection never resumes, retries, cancels or changes capacity. Direct SDK jobs, preview routes and a traces-only/logs-only setup generate no async-slot points. Source/private loopback coverage is not deployed PostgreSQL, container, Collector/backend or Kubernetes acceptance.

Inspect `workflowRuntime.httpAsyncCapacityTelemetry` in management `capabilities`, or `httpAsyncCapacityTelemetry` in workflow-release capabilities, for this instrument's startup prerequisites, phases, labels and exclusions. This is static support metadata: it does not prove that this owner enabled async routes or metrics, report available capacity, or grant telemetry-management operations to an exact-release client. Discovery never starts a service or changes configuration.

Allowed metadata is method (standard methods or `_OTHER`), an exact known service path when present, response status if headers were sent, bounded status class and `response-finished`/`disconnected` outcome. Unknown paths and paths with queries are omitted, never copied or normalized from user input. No URL, host/IP, headers, tokens, cookies, actor, command name, IDs, body, response payload or raw error is recorded by this instrumentation. The known-path label is not proof that a route or caller was admitted. Metric labels exclude exact status codes, trace IDs and errors and retain the existing 128-series-per-instrument overflow bound.

5xx and disconnects mark the API span as an error; 4xx leave server span status unset, following [OpenTelemetry HTTP span conventions](https://opentelemetry.io/docs/specs/semconv/http/http-spans/). The custom duration deliberately includes handler settlement after disconnection and is not advertised as the standard `http.server.request.duration` metric. A workflow failure returned in a successful protocol response can still have HTTP 200: inspect execution evidence for the workflow outcome.

Metrics/logs remain available with unsampled traces or no trace endpoint. The private providers do not auto-instrument collectors or other HTTP clients, so exporting observations does not recursively count exporter requests. An explicit `telemetry.flush` request is observed only after its own flush finishes; another flush or shutdown may export that request. Counters reset with the runtime owner. Parser errors before a request callback, TLS handshakes and connection admission require the separate option below. Process crashes, generic stdout/stderr and journal access auditing remain outside both options. Local protocol tests do not qualify a production Collector, dashboard or Kubernetes service.

### Offline SDK response verification

The source SDK exports `verifyHttpObservations`, `httpObservationLedgerSchema` and `HttpObservationVerificationError` from `@jevable/core/telemetry`. This is a pure, bounded reader: it does not start a server, contact a Collector, dispatch a workflow, replay requests or load exporter/storage SDKs. It is not a CLI command. The previously delivered ZIP and deployed containers do not gain this export until separately rebuilt and qualified.

Supply an independent schema-version-one ledger: `ownerAttribute` (`k8s.pod.uid` or `service.instance.id`), unique UUID `owners`, `clockDomain: "shared-unix-milliseconds"`, `intents` and `settlements`. Persist each intent before dispatch with unique UUID `id`, independently known `ownerId`, `startedMs`, bounded `method` and known `route` (or `null` for an omitted unknown/query path). Record its settlement only after the complete response body ends: same `id`, `endedMs`, actual `status`, returned sampled `context` and `bodyEnded: true`. Clocks must share a Unix-millisecond domain; remote unsynchronized clocks are not supported. Never derive the intended population or owners from the signals being checked.

```js
import { verifyHttpObservations } from '@jevable/core/telemetry'

// Values supplied by your independently retained caller ledger and reviewed collection.
const report = verifyHttpObservations(ledger, {
  traces: tracesNdjson, metrics: metricsNdjson, logs: logsNdjson,
})
```

Each signal input is unfiltered OTLP JSON export-request NDJSON, not a trace-viewer API response or protobuf bytes. The verifier requires one runtime instance per declared owner, sampled response contexts (`01`), one matching HTTP server span and ended log per completed response, and matching cumulative counter/histogram snapshots. This strict profile also requires the server handler/span/log to settle before the caller finishes reading its response body; handlers with post-response work are unsupported. It checks status, bounded labels, owner/context identity, shared-clock intervals, duration sum/min/max/buckets, stable metric start times and exact integer populations. Repeated unchanged snapshots do not add requests. Counts come from independent recorded responses: there is no fixed 22-request or equal-per-pod requirement. Missing settlements, foreign/extra HTTP observations, duplicate identities, resets, unsampled responses, incompatible capture shapes or discrepancies refuse. Ledger admission is capped at 5,000 responses/128 owners, signal input at 16MiB each, and HTTP metric series at 128 per owner. Failures expose only `invalid-input`, `incomplete-evidence`, `inconsistent-evidence` or `limit`, not captured payloads. A refusal is not proof that a workflow or business operation failed.

Owned quota correlation is accepted only as the complete fixed `jevable.http.rate.trace_id`, `jevable.http.rate.span_id` and boolean `jevable.http.rate.sampled` trio, identical on the HTTP span and ended log. The span must contain exactly one matching non-self link with consistent sampling flags and no private link attributes, dropped attributes or tracestate. Partial, orphaned, mismatched or extra links refuse. Metric labels and independent response-population requirements are unchanged. When present, `rateAdmissionLinks` reports the HTTP-side context count split into sampled/unsampled quota contexts; an unsampled quota context does not make the separately sampled HTTP response unsupported. This report does **not** verify a received quota span, its outcome, database debit, admission receipt or SQL/COMMIT. Those need separately retained evidence; links are diagnostics, never authority. Unlinked reports keep their previous shape. Previously installed readers that reject these fields remain unchanged until separately rebuilt and installed.

`matched-recorded-http-observations` means only that the supplied completed-response ledger matches the supplied received/serialized HTTP signals. It does not certify capture completeness, abandoned/disconnected requests, requests lost before headers, exporter acknowledgement, business commits, backend retention or production readiness. Protect input files independently; this function does not establish their provenance or secure retention. It does not repair lost probe intents or upgrade a historical failed qualification. Current source tests cover constructed populations and actual local runtime HTTP/SDK serialization, not a production Collector or backend.

Counter and histogram are separate cumulative metric streams. Their first-measurement start timestamps may differ; each must remain stable independently across snapshots and precede every included observation. Collection timestamps, counts and the complete duration distribution must still match. A reset in either stream refuses, even if the other remains stable. This follows the [OpenTelemetry cumulative timestamp model](https://opentelemetry.io/docs/specs/otel/metrics/data-model/#temporality); the verifier does not normalize, overwrite or discard received timestamps. Earlier equal-start verifier artifacts and their failed receipts remain historical, not retroactively accepted by this correction.

## Optional HTTP connection and transport observations

Set `"httpConnections": true` in the same private startup telemetry JSON. It defaults to `false` independently of `httpRequests`; neither requires the other. It observes only the owned SQLite/PostgreSQL management, preview and exact-release servers, not the separately hosted preview gateway, outbound provider/Collector connections or arbitrary Node servers. Direct SDK jobs without a server generate no connection observations. No Jarness, desktop or ambient instrumentation is involved.

Each accepted TCP socket has a root `jevable.http.connection` server span and a correlated `jevable.http.connection.ended` log when its underlying socket closes. Duration includes TLS setup, keep-alive and idle time; two requests can share one connection. `closed` means a socket close event without Node's `hadError` flag, not a successful request or handshake. `socket-error` marks that flag and an error span. The owned server waits for observed socket close settlements before closing its exporters during normal drain; an observation timeout still means draining, not permission to force termination.

Emitted `clientError` events produce independent-root `jevable.http.transport.failure` error spans/logs, with fixed `http-parser` for Node `HPE_*` codes and `http-client` for other client transport errors. `tlsClientError` produces `tls-handshake`; the same error forwarded by HTTPS to `clientError` is counted only once. Node's `drop` event at the server connection limit produces `connection-limit`, without fabricating an accepted connection or an HTTP request. Counts are emitted observations, not unique clients or failures. Failed handshakes/parser events are not joined to connection spans by guessed socket identity, and incoming trace headers never parent these roots or execution segments.

| Instrument | Meaning | Point labels |
| --- | --- | --- |
| `jevable.http.connections.opened` | Accepted sockets, including pre-handshake | transport |
| `jevable.http.connections.ended` | Observed socket closes | transport, close outcome |
| `jevable.http.connections.active` | Currently observed sockets in this owner | transport |
| `jevable.http.connection.duration` | Seconds from acceptance to socket close | transport, close outcome |
| `jevable.http.transport.failures` | Emitted parser/client/TLS/limit events | transport, failure kind |

The label keys are `jevable.http.transport`, `jevable.http.connection.outcome` and `jevable.http.transport.failure`. Transport is only `loopback-http` or `direct-https`; close outcomes and failure kinds use the fixed vocabulary above. No peer IP/port, hostname, URL, header, body, certificate, raw error message/code/stack, credential or workflow ID is admitted. Failure span/log `error.type` repeats the fixed failure kind, not the raw error. Existing metric cardinality, record queues, sampling and export limits apply. Metrics/logs remain independent of trace sampling; final active count is zero after an observed normal shutdown. Crash/export loss can leave stale backend samples and lost diagnostics: use owner instance/freshness gates, never replay workflow actions to reconstruct telemetry. These observations do not constitute an access or durable journal audit, prove TLS/client receipt, or close production/container/Kubernetes qualification gates. Older bundles may reject the option; create a release pinned to the supporting runtime rather than changing its bytes.

## Provider context propagation

For each authorized model destination, optionally set `"tracePropagation": "w3c"` in its provider connection. The built-in transport sends the private **model span's** version-00 `traceparent`, retaining the exact header in pending model evidence before dispatch. This makes the outbound parent a child of the journaled node context, rather than copying the inbound parent or inventing a detached trace. Omission/`"none"` disables propagation; no runtime span means no header. Unsampled contexts carry flag `00`; correlation does not guarantee exported spans. Baggage remains disabled unless separately approved below; `tracestate` and arbitrary inbound headers are never forwarded. Provider authentication remains independently configured. Redirects are refused rather than sending context to a second endpoint. Existing settled evidence remains readable after connection policy changes, and inspection/retry does not send another request.

The model span's own context is separately retained in the configured-model record as optional `trace`, regardless of outbound propagation policy, before any dispatch. Redacted `snapshot.models.calls[].trace` exposes only its IDs and sampled flag. This closes the local model-call correlation gap when propagation is disabled; it is not proof of dispatch, exporter acknowledgement or backend retention. When both local context and outbound header exist they must match exactly. Retry child contexts must belong to that trace and have distinct span IDs. Metadata-only trace navigation adds `source: "model-call"` alongside `model-try` references; destinations remain explicitly reviewed and are not contacted or opened by inspection. Old header-only records are not backfilled, and enabling telemetry later cannot reconstruct a missing span. See [model history](evidence.md#model-attempts-and-retries) for storage compatibility and privacy limits.

Trace IDs themselves can be sensitive correlation metadata. This explicit destination policy follows the [W3C trace-context format and privacy considerations](https://www.w3.org/TR/trace-context/) and avoids automatically forwarding [OpenTelemetry baggage](https://opentelemetry.io/docs/concepts/context-propagation/). A compatible downstream server may join the trace; local fixture checks do not prove a hosted provider does so.

### Explicit allowlisted baggage

Baggage is user-supplied metadata, not a verified tenant/account identity, permission, routing rule, approval or workflow input. Do not place credentials, personal data, prompts or business secrets in it. Approve each receiving provider before enabling this option: that provider can retain the values it receives.

Add `"baggageKeys": ["request.class"]` to the runtime telemetry configuration **and** to each approved provider connection, where `"tracePropagation": "w3c"` is also required. Absent/empty lists disable admission at that boundary. The runtime and destination lists intersect; unrelated keys cannot pass through a broadly configured destination. Key lists contain at most 64 unique case-sensitive ASCII HTTP tokens of at most 128 characters. Configuration stores names, never baggage values.

The SQLite and PostgreSQL SDK owners expose `runtime.withTraceContext({ traceparent, baggage }, () => operation())`. `traceparent` is optional; baggage can accompany a new runtime trace. Owner, exact-release, reviewer and caller JSON clients accept the same object in their existing optional trace argument; the previous string argument remains supported:

```js
await runtime.withTraceContext({ baggage: 'request.class=interactive' }, () => runtime.run(yaml, input));
await client.operation(command, { traceparent, baggage: 'request.class=interactive' });
```

Authenticated owned JSON operation routes admit the `baggage` header after authentication, role/release checks and command admission. Multiple fields combine as a single list. Unauthorized requests never adopt it. Health/capabilities, HTML bootstrap/logout and caller SSE observation do not adopt it. The remote preview gateway still drops baggage; it has no runtime key policy.

CLI operation commands support `--trace-context-file <private-context.json>` for direct local execution or an explicitly selected Docker/remote owner. `runtime request`, reviewer decisions and caller start/read/cancel/checkpoint/control support it too. The file contains only optional `traceparent` and `baggage` string fields, for example:

```json
{"baggage":"request.class=interactive"}
```

Provision the file separately with owner-only permissions (0600 on POSIX). Admission refuses symlinks, non-regular files, invalid UTF-8/JSON, unknown fields, malformed carriers and files larger than 65536 bytes; POSIX owner/group checks are not Windows ACL qualification. Read once before opening runtime storage or credentials: changing the file mid-invocation does not alter admitted retries. Failure is sanitized without disclosing the path or values. It does not alter retained request IDs, approval authority, provider destination approval or uncertainty/retry semantics.

```sh
jevable run workflow.yaml --input input.json --data-dir ./state \
  --telemetry-file ./telemetry.json --trace-context-file ./private-context.json
jevable runtime request operation.json --endpoint http://127.0.0.1:8080 \
  --token-file ./owner.token --trace-context-file ./private-context.json
```

The first example requires an explicitly configured provider and both runtime/destination key lists to forward baggage. The second requires an already running explicitly selected owner; it does not start or discover one. A multi-call invocation may carry the same approved snapshot across its own calls; a new CLI invocation reads a new snapshot. SDK callers of `openCliOperations` may explicitly replace it with their optional trace argument; a legacy trace-parent string clears baggage rather than merging it. Help, status, startup, portable/live preview and caller SSE do not accept this file option. No carrier is read from environment variables or inline command values, retained data or desktop/Jarness settings, and exports never include the private file.

The wire parser uses the [W3C baggage format](https://www.w3.org/TR/baggage/), retaining member order, duplicate keys, percent-encoded values, additional equals signs and whole semicolon properties. It validates at most 64 members and 8192 combined ASCII bytes; overflow or malformed opted-in input is refused without echoing values. Percent escapes must be complete. No value is decoded, interpreted, truncated or promoted into attributes; a retained member's properties travel with it, so key approval includes its entire metadata. This is an explicit allowlisted application profile, **not** an unrestricted W3C platform that propagates every key.

Values live only in the owner's request-local async scope. Concurrent requests and separate owners cannot share them. Nested `withTraceContext` replaces rather than merges its carrier; `withTraceParent` clears it. Currently admitted provider retries use the same filtered snapshot, but settled reentry, journal inspection, restart, approval waits and later resume never reconstruct it from storage. Supply a new explicitly approved carrier for a later operation if needed. Do not use it for replay/audit identity: baggage deliberately has no durable value receipt.

No baggage value enters runtime/model records, request bodies, evidence exports, metric labels, resources, span/log attributes, OTLP Collector requests, notification calls or default ZIP/image configuration. Custom `ModelCalls` adapters receive the ephemeral carrier and must preserve this boundary themselves; only built-in provider transports enforce their own destination key list. Source fixtures qualify local SQLite SDK/HTTP/provider retry behavior; independently packaged PostgreSQL, native provider, delegated-role, HTTPS/container/Kubernetes and production interoperability remain separate qualification gates.

Runs expose `traceSegments` and settled-node trace IDs when tracing was enabled. Those identifiers do not prove collector delivery; unsampled runs still retain valid contexts with `traceFlags: 0`. The sampler applies the configured ratio rather than letting an inbound sampled flag override it. Schema 7 adds these optional fields and preserves earlier run evidence; older development snapshots cannot read the new store version.

## Execution metrics

### Saved-response recovery

`jevable.recovery.attempts` counts ended observations of explicitly admitted saved-response recovery. `jevable.recovery.duration` measures seconds from that recovery segment's start through attempted node settlement—not the original model duration, time since interruption, or time waiting for an operator. Recovery also remains one `resume` in the existing execution-segment instruments; these are overlapping views, not additive totals.

Both instruments use only bounded `jevable.outcome` and boolean `jevable.recovery.settled` labels. `settled: true` means this process acknowledged the recovered node-result commit, even if the retained model result leads to a failed node. It does not mean downstream execution completed. `settled: false` means no such acknowledgement was observed; the database may nevertheless have committed. Inspect retained evidence before deciding what happened. Failed segment persistence, lost node acknowledgements and cancellation races do not become successful recovery counts.

The linked `jevable.resume` span and its existing `jevable.execution.segment.ended` log carry `jevable.recovery.settled`. The log additionally includes `jevable.control.mode: recover` and the validated control-request UUID, joining it to the guarded journal request without exporting the actor or response payload. Request/run IDs never become metric labels. Metrics and logs work with unsampled traces or no trace endpoint.

Invalid, stale or unknown-response requests rejected before recovery admission/segment observation do not increment these instruments. Identical admitted-request retries, inspection and restart do not reconstruct counts or resend earlier logs. A separately authorized fresh recovery after an unacknowledged settlement can produce another observation, so counts are neither unique recovered runs nor a complete request audit. Recovery never recounts the original node/model/token metrics. These process-local cumulative observations can be lost on a crash or exporter failure; the journal remains authoritative.

### Retry-enabled model tries

For the built-in adapter with reviewed `maxAttempts > 1`, `jevable.model.try` child spans represent individual tries under the existing `jevable.model` span. A unique try UUID, sequential try number, run ID and node-attempt ID join each span to private format-2 model evidence. The child context is included in the pending intent before dispatch, and its span ends after acknowledged settlement. Intent/settlement write failure ends with `commit-or-execution-failed` and `settled: false`; this is uncertainty, not proof that a commit failed on the database server. Cancellation during backoff creates no new try span. The parent model span still covers backoff and the full call.

`jevable.model.try.dispatched` means a fetch invocation was attempted, not that the provider received or completed it. `jevable.model.try.settled` means this process acknowledged the model-evidence settlement, not the enclosing workflow-node settlement. Trace attributes additionally include a received HTTP status when known. Failed tries never export raw provider bodies or exception messages. Outgoing W3C headers retain the existing parent-model context for the whole call; child-span context is local diagnostic correlation and does not claim exact downstream per-try spans.

`jevable.model.try.attempts` counts ended try observations, and `jevable.model.try.duration` measures seconds from intent observation through settlement, excluding the following backoff. Labels are bounded node kind, outcome, `jevable.model.try.phase` (`initial`, `retry`, or defensive `other`) and boolean `jevable.model.try.dispatched` / `jevable.model.try.settled`. Filter phase `retry` for additional tries, dispatched `true` for attempted dispatches and settled `true` for observed evidence-write acknowledgements—not proof of provider receipt or workflow commit. No try number, try UUID, HTTP status, provider name or workflow identity becomes a metric label. These counters cover retry-enabled calls only; single-try calls keep their existing model span/metrics and format-1 evidence. They are not global HTTP-request totals or durable billing counts. The added settlement label changes series identity; do not double-count old/new label sets across a mixed-version deployment.

`jevable.model.try.ended` logs carry validated try UUID/number, trace/span identity, outcome, duration and the dispatched/settled booleans. Metrics/logs work with unsampled contexts when the trace endpoint is absent or sampling is zero. Observer exceptions and export failures do not change model execution or retry limits. Restart inspection neither reconstructs spans nor increments counters. Older strict readers can reject the new optional per-try trace field; preserve a compatible reader or backup rather than downgrading retained evidence.

SDK adapters receive optional `ModelExecutionContext.startTry` diagnostic hooks. The built-in adapter ignores observer failures, validates returned child contexts against the parent, and ends each observation once. A custom adapter must implement its own accurate observation/durability behavior; receiving the hook grants no extra execution or external-export authority.

### Retry backoff waits

After a failed try's retry-delay evidence has been acknowledged, the built-in retry adapter observes the following wait separately. `jevable.model.backoff` is a child of the same parent model span, with the preceding retained try UUID/number and planned `jevable.model.backoff.delay_ms` (100–3,600,000 ms). It is not a new request, intent, attempt or provider-side span. The parent model duration still includes this wait: these views overlap and must not be added together.

| Instrument | Boundary |
| --- | --- |
| `jevable.model.backoff.waits` | Ended wait observations, including cancellation/deadline/ownership loss; not successful retries |
| `jevable.model.backoff.duration` | Observed seconds spent in that wait, excluding subsequent evidence writes or dispatch |
| `jevable.model.backoff.active` | Currently observed waits in this process; not scheduler backlog, worker capacity or retained pending calls |

Wait counters/duration use only bounded node kind and outcome; the active up/down counter uses only node kind. Try IDs/numbers, planned delay, provider names and runtime/workflow identities are not point labels. Duplicate observation endings count once. A wait already interrupted at admission can end with zero observed duration; planned delay is not actual elapsed time.

`jevable.model.backoff.ended` logs carry validated preceding try UUID/number, planned delay, outcome, elapsed seconds and actual diagnostic trace/span context. Cancellation or timeout ends only this wait and creates no next try. Lost storage ownership is `commit-or-execution-failed`; this is not proof that a remote database failed to commit. Wait success means only that the wait ended without an observed abort—it does not imply another request was sent or succeeded. Failure-settlement writes happen after this observation ends, and can remain uncertain independently.

Declined retries, unacknowledged preceding settlements and single-try calls create no backoff observation. Restart/inspection/exact-ID retries never rebuild waits or counters from retained `scheduledDelayMs`. The backoff span's own ID is transient diagnostic metadata, not a new durable recovery identity; its preceding try ID joins existing model history. Metrics/logs are independent of trace sampling, and exporter loss never changes execution or retry limits. These signals describe the core's in-process retry lifecycle, not complete retry billing/accounting, scheduler behavior, downstream instrumentation or deployed backend qualification.

Custom SDK adapters may use optional `ModelExecutionContext.startBackoff({ afterTryId, afterTryNumber, delayMs })`. The built-in configured adapter snapshots it before awaits, contains getter/start/end failures and ends each observation once. It grants no execution, retry or external-export authority and does not modify persisted model-evidence formats.

Metrics use cumulative, process-local counters and explicit-bucket duration histograms. Each instrument admits at most 128 attribute combinations, with an additional fixed attribute-key allowlist. Labels use only bounded runtime operation, compiled node kind, outcome, token direction, retry phase, dispatch state and model/recovery settlement-acknowledgement values. Run/project/release/node IDs, revision hashes, provider/model names, exception text, prompts and outputs are not metric labels. Resource service/environment/instance metadata is still exported. Unknown internal kinds/outcomes map to `other`.

| Instrument | Meaning |
| --- | --- |
| `jevable.execution.segments` | Ended run/resume/approval/cancel segments by operation and outcome; **not unique completed runs** |
| `jevable.execution.duration` | Active segment duration in seconds, excluding time waiting for a human |
| `jevable.execution.active` | Active segments in this process; **not persisted approval backlog** |
| `jevable.node.attempts`, `jevable.node.duration` | Ended node attempts and seconds through durable settlement, including failed/uncertain commits |
| `jevable.model.calls`, `jevable.model.duration` | Ended model adapter calls and seconds; not provider HTTP retry counts |
| `jevable.model.tokens` | Reported nonnegative integer input/output tokens; missing usage is not estimated |

Histograms use second boundaries `0.001, 0.01, 0.1, 0.5, 1, 5, 10, 30, 60, 300, 3600`. An approval wait ends a `run` segment with outcome `waiting`; a later decision ends a separate `approval` segment. A rejected decision is not silently reported as success. Node approval admission has outcome `paused`; it is not another finished workflow.

Metrics observe execution even when trace sampling is zero or the trace endpoint is omitted. Metrics-only execution retains unsampled diagnostic identities in the local journal but sends no spans. Reading saved evidence, opening a fresh owner and stable-ID retries do not increment execution counters. Restart starts a new resource instance and new cumulative series, without replaying historical work into counters. Aggregate counters are not durable accounting or billing evidence.

Changed aggregates export on the configured interval, explicit flush or close. By default, unchanged snapshots are not re-exported as heartbeats. A failed/partially rejected snapshot is not automatically retried; later execution changes produce a new cumulative snapshot that can include earlier counts. Optional exporter-health and retained-state sampling also collect new cumulative snapshots during idle periods. Do not sum successive cumulative snapshots as independent events. Crashes may lose the most recent unexported observations; the journal remains authoritative. Broader recovery metrics and scheduler/worker queue instrumentation remain pending.

## Optional retained-state and approval metrics

Set `"retainedStateMetrics": true` with an explicit `metricsEndpoint` to sample the selected runtime owner's retained checkpoints, including approvals. It defaults to `false` and is independent of `exporterMetrics`. Either option enables idle sampling at the configured interval and on flush/close. The gauges describe the selected SQLite data directory or PostgreSQL namespace, not every Jevable installation. In an exact-release service, they still describe its whole configured store; use independent storage when release isolation is required. No project, release, run, node or actor ID is a metric label.

| Instrument | Meaning |
| --- | --- |
| `jevable.retained.available` | `1` for a complete validated projection under the current owner; `0` means unknown, **not an empty store** |
| `jevable.retained.runs` | Retained counts for `paused`, `executing`, `waiting`, `completed`, `failed`, `cancelled` |
| `jevable.retained.approvals` | Unsettled waiting checkpoints, split into `awaiting` and `expired` by the saved deadline at sampling time |
| `jevable.retained.approval_oldest_age` | Oldest request age in seconds for each approval bucket; zero when that bucket is empty |

These are gauges, not cumulative starts/completions or durable accounting. The sole point label is `jevable.retained.state`, with the fixed values above; a complete sample has 11 points. `executing` means a retained node intent and can include uncertain work after interruption; it is not a live-worker count. `paused` can include deliberately paused or safely resumable work; it is not a scheduler queue. Completed/failed/cancelled records remain counted while retained. Use `jevable.execution.active` for currently observed execution segments.

Approval age starts at the matching journaled `approval-requested` event, not runtime startup or the most recent run update. Restart and downtime therefore do not reset it. A past deadline changes only the diagnostic bucket: sampling never writes expiry, approves, rejects, cancels, resumes or retries anything. The approval remains a `waiting` checkpoint until an explicit operation settles it. Wall-clock changes can move the bucket or age; negative ages are clamped to zero, not turned into invented monotonic durations.

At startup, the owner builds a bounded metadata-only projection from its existing ledger/model validation. Serialized, acknowledged commits update that projection. Interval collection reads memory and the clock, not the database, and does not retain workflow payloads in the projection. This avoids a full journal scan on every scrape. Run IDs and approval attempt IDs are internal map keys only, never exported labels. The projection is bounded by the configured `maxRuns`; it is not an additional storage authority or a detector of out-of-band database edits.

Incomplete initialization, a missing approval request timestamp, observed corruption, an uncertain write or lost PostgreSQL ownership makes the projection unavailable. Invalidation is conservative and sticky for that owner; explicit reopen with complete validation rebuilds it. When unavailable, only the availability gauge is exported: old retained gauges are removed from the outgoing snapshot, not re-emitted as current or replaced with misleading zeroes. Dashboards should gate these series on availability and apply absence-of-data alerts, since a disconnected metrics receiver cannot carry even the unavailable flag. Metric failures never repair storage or authorize execution.

This projection supports standalone SQLite/PostgreSQL runtimes and their packaged execution apps. A telemetry-only host without a retained-state source reports unavailable. It does not implement multi-worker aggregate ownership, scheduling, retention/garbage collection, production dashboard alerts or cluster qualification.

An optional SDK diagnostic reader that throws or supplies an incomplete/inconsistent snapshot reports `available=0` for that collection, with all other retained gauges omitted—including previously collected values. Counts must be nonnegative safe integers, the two approval buckets must total the retained waiting count, ages must be finite/nonnegative, and an empty bucket must have zero age. Only fixed fields are copied; extra payload fields are not evaluated or exported. A later complete snapshot can restore availability. This collection-local failure is distinct from the owner's sticky projection invalidation described above; neither retries workflow actions nor suppresses independent request/execution observations.

## Optional PostgreSQL storage queue metrics

Set `"storageQueueMetrics": true` with an explicit `metricsEndpoint` to observe process-local PostgreSQL contention. It defaults to `false`. The option enables idle collection at the configured interval and on explicit flush/close, independently of trace sampling. Existing private destination, credential, flush and configuration-mutation guards still apply; collection never enters a storage queue, queries the database or dispatches work.

| Instrument | Meaning |
| --- | --- |
| `jevable.storage.queue.available` | `1` when this open PostgreSQL owner supplies current in-memory counts; `0` when unavailable or unsupported |
| `jevable.storage.queue.operations` | Current admitted operation count, with fixed `jevable.storage.queue=domain\|journal` and `jevable.storage.queue.state=waiting\|active` labels |

The **domain** queue serializes read/guard/write operations; one domain operation may contain several journal transactions. The **journal** queue serializes transactions on the exact owned database session and includes reads. Waiting excludes the currently active operation. Active is at most one per queue and includes time awaiting database responses or commit acknowledgement. A count does not prove a mutation, successful commit, provider receipt or completed workflow. These are different stages: do not add their counts to estimate unique requests or queued runs.

Only admitted work is counted. Failed/aborted work releases its occupancy when its promise settles; sampling never aborts, drains, retries, repairs locks or resumes it. Queued work refused after ownership loss settles without dispatch. Counts reset with the runtime process and are not reconstructed from journal history. No namespace, run/project/release/grant, SQL, payload, actor or credential is a point label. Separate service-instance resource identity distinguishes owners.

After owner loss or shutdown, and for SQLite or a telemetry-only SDK host without a source, availability is `0` and occupancy points are omitted—including cached gauges from earlier collections. Missing observations mean unknown, not an empty queue. Collector failure affects telemetry delivery only and never replays storage or workflow work. This is not a distributed scheduler/worker backlog, queue-capacity limit, journal outcome/latency instrumentation, production alert, durable backend receipt or Kubernetes qualification; those remain separate work.

## Optional exporter-health metrics

Set `"exporterMetrics": true` in the private telemetry JSON to include exporter health. It defaults to `false` and requires an explicit `metricsEndpoint`. This opt-in changes idle behavior: a new cumulative snapshot is collected on each interval, explicit flush and close even without new execution. It never starts a workflow, replays journal events, retries model calls or resends failed trace/log batches. Counter changes do not trigger an immediate recursive export. Concurrent flushes share any in-flight collection; request/flush limits and credential-mutation exclusion still apply.

| Instrument | Type and meaning |
| --- | --- |
| `jevable.telemetry.records` | Cumulative accepted/exported/rejected/dropped items for each enabled signal |
| `jevable.telemetry.batches` | Cumulative successful/failed export batches |
| `jevable.telemetry.occupancy` | Gauges for queued and in-flight items, **not workflow backlog** |
| `jevable.telemetry.last_failure` | One-hot gauges for `none`, `transport`, `response`, `serialization`, `collection`, `partial-rejection`, `other` |
| `jevable.telemetry.last_success` | Unix seconds of last receiver acknowledgement, or zero when none was observed |

Only `jevable.telemetry.signal` (`traces`, `metrics`, `logs`) and `jevable.telemetry.state` fixed-vocabulary point labels are admitted. Disabled signals have no health series. There are 16 health points per enabled signal, at most 48. All last-failure categories are emitted on each sample, including zeroes, so an old category clears after recovery. No receiver URL, credential, raw error text, run ID or workflow payload is included in these labels. Configured resource identity still accompanies the metrics.

For traces, items are sampled spans; for logs, log records; for metrics, **data points in collected snapshots**, including health points. Metrics totals therefore grow with sampling even while idle; they are not unique workflow measurements. Queue-overflow drops were never accepted, whereas failed-batch drops were accepted, so `accepted = exported + rejected + dropped` is not a valid general invariant. Metric occupancy has no snapshot queue. Self-observation describes the metrics exporter's state immediately before the current attempt; that attempt's success/failure can only appear in a later sample. Peer exporters are sampled concurrently, not atomically drained first.

These counters reset with a fresh runtime owner and its new `service.instance.id`. Acknowledgement is not proof of backend retention. A failed metrics receiver cannot report its own current/final failure through that same unavailable receiver; use local SDK/API exporter status and external absence-of-data monitoring too. Shutdown's last sample may precede peer exporter outcomes. Health export is best effort, not durable accounting or an end-to-end delivery guarantee.

## Structured execution logs

### Committed Rule route correlation

An If/Else or Switch node's trace and `jevable.node.attempt.ended` log can carry `jevable.rule.port` with `jevable.rule.settled: true` after the owner acknowledges the result write. The port is the exact declared routing identifier (If/Else `true|false`, or a Switch case port/`default`), not the condition input, case value, Decision answer, confidence or downstream result. Switch port names are workflow metadata: review them before enabling export, just as you review node IDs. They are never metric point labels.

Before acknowledgment, the Rule span has `jevable.rule.settled: false`; its ended log also reports false and omits the port if no valid acknowledged route was observed. A lost write acknowledgment can leave the actual route committed in storage without a settled diagnostic: inspect the retained journal, never infer rollback or retry the workflow from that flag. Invalid evaluation has no fabricated route. These fields describe the Rule's result boundary, not business completion, successful downstream execution, client receipt or Collector retention.

Logs retain this correlation at sample ratio zero or without a trace endpoint. Reads, retained-ID submissions and process reopen never reconstruct prior endings. No workflow state/schema, dispatch, retry, approval, cancellation or persistence policy changes; export remains best effort. Hosted providers, actual PostgreSQL, packaged/deployed route signal paths and backend/browser qualification remain separate from source fixture tests.

Logs use fixed event names and fixed message bodies, not free-form application text:

| Event | Boundary |
| --- | --- |
| `jevable.execution.segment.ended` | A run, resume, approval or cancel segment ends, including waiting/failed/uncertain/cancelled outcomes |
| `jevable.node.attempt.ended` | A node attempt ends after its settlement commit, or reports that commit/execution failed |
| `jevable.model.call.ended` | A model adapter call returns or throws; this is not proof that the enclosing node committed |
| `jevable.model.try.ended` | A retry-enabled transport try ends through acknowledged or uncertain model-evidence settlement |
| `jevable.model.backoff.ended` | A scheduled retry wait ends before a new intent or failure-settlement write; not a provider receipt |

Each event carries its actual trace/span context, a fixed outcome and observed duration. The metadata allowlist admits validated run/attempt/project/release UUIDs, revision/release SHA-256 hashes, bounded node/loop IDs, attempt ordinals, loop indices, project generation, node kind and local runtime mode. Model events may include valid reported input/output token counts and tries. Approval-segment logs include the previous segment's trace/span IDs to preserve navigation across restart. Actor identities and review payloads stay in the protected journal, not log export.

Errors use severity `ERROR`; other ended operations use `INFO`. Raw exception messages/stacks, arbitrary events/attributes, workflow names, prompts, generated text, credentials, provider/model names, approval actors and baggage are never admitted into these log records. Unsupported kinds/outcomes become `other`; invalid/oversized identity metadata is omitted rather than truncated into a misleading identity. Log records are limited to 32 attributes and 128-character string values, with stricter field validation before the SDK.

Logs are independent of trace sampling. Logs-only execution retains unsampled identities in the journal and exports no spans; the log's trace ID does not imply that a backend has the matching trace. Read-only inspection and stable-ID retries do not reconstruct or re-export earlier execution logs. The implementation observes ended operations and, separately when opted in, the bounded HTTP request events described above—not arbitrary application stdout/stderr, startup logs or a complete access/journal event stream. A crash may prevent an end event or lose queued records. Use the journal to investigate missing/uncertain events; never infer successful settlement solely from model-call logs.

## Exporter status and shutdown

SDK: pass `telemetry` in `LocalRuntime.open` or the experimental `PostgresRuntime.open`, call `telemetryStatus()` / `telemetryFlush()`, then `close()`. PostgreSQL uses its own namespace's async credential store; see [PostgreSQL telemetry](postgres.md#postgresql-telemetry) for setup and lifecycle exclusions. Credential lookup shares the request timeout, and credential changes refuse while explicit or automatic exports are active. `@jevable/core/telemetry` exposes config types/validation. The live HTTP operations `telemetry.status` and `telemetry.flush` return the same exporter health view through `runtime request`. Configuration remains an operator startup choice; an API request cannot silently select a different collector.

`signals` lists configured exports. When traces are configured, existing top-level counters describe spans. Nested `logs` status reports accepted/exported/rejected/dropped log records, queued/in-flight occupancy, batch outcomes and fixed failure categories. Nested `metrics` status reports data-point counts, successful/failed batches, in-flight points, pending changes, last success time and a fixed failure category. Metrics `queued` is always zero: observations aggregate rather than enqueue snapshots. `abandonedChanges` counts aggregate updates not included in a snapshot before shutdown, not lost workflow executions. Collector error text is never returned. Health counters are process-local and reset on restart; they are not durable monitoring history. A partial-success response increments rejected counts without pretending those records were delivered. Export success means the receiver acknowledged the batch, not that every downstream backend retained it.

Close flushes configured signals concurrently within their configured budgets, aborts remaining requests and accounts for discarded data before releasing storage. A normal flush can return with a request still in flight after its deadline; inspect status. CLI completion closes/flushed its exporters, but the workflow exit code reports execution/durability, not telemetry delivery. Use live service/SDK health to inspect exporter outcomes. A disconnected receiver, rejected record or dropped queue entry never authorizes retrying a workflow or model call.

The [OTLP specification](https://opentelemetry.io/docs/specs/otlp/) defines HTTP/protobuf responses and partial rejection. The implementation uses official OpenTelemetry trace/metrics/log SDKs and serializers; see [JavaScript export guidance](https://opentelemetry.io/docs/languages/js/exporters/). Automated qualification currently uses local protocol fixtures and independent wire checks, not a production Collector/backend deployment.

## Trace viewer navigation

For read-only links from retained run/node/attempt IDs, see [trace navigation](trace-navigation.md). Viewer routing is explicitly configured separately from OTLP signal destinations and authentication. Preparing a link neither contacts the backend nor proves export delivery or retention.

# Explicit Collector probe

Use this only when the user wants to test delivery to an already selected OpenTelemetry receiver. API `telemetry.status`/health describe existing exports; API `telemetry.flush` sends existing observations. Neither creates this synthetic probe. The probe needs no Jarness, desktop, authoring agent, Docker or workflow/model execution.

```sh
jevable telemetry probe --data-dir /private/workflow-state --telemetry-file /private/telemetry.json --json
jevable telemetry probe --storage postgres --database-file /private/database.json --telemetry-file /private/telemetry.json --json
```

Provision any referenced bearer credential separately in that owner's protected provider store. Do not put secret values in arguments or workflow source. Startup configuration and trust follow [telemetry.md](telemetry.md); no endpoint, authentication, resource or sampling override is accepted in the probe operation. A local CLI command owns the selected storage; do not open a competing owner to probe a running service.

For a running owner use an explicitly selected management HTTPS endpoint with its own token, CA and instance identity, or the reviewed Docker-owner selectors from [docker-owner.md](docker-owner.md). Selection never starts a service, reads another app's settings or falls back to local state. The management API accepts exactly `{"operation":"telemetry.probe"}`. Preview and exact-release APIs do not grant this management diagnostic; never substitute wider authority silently.

Both `LocalRuntime` and `PostgresRuntime` provide `await runtime.telemetryProbe({ signal })`; the optional SDK signal aborts only the probe, not workflows. Their entrypoints and `@jevable/core/telemetry` export `collectorProbeReportSchema` and `CollectorProbeReport`. No probe runs on construction, startup, readiness refresh, workflow execution or inspection. No configuration produces a `disabled` report without contacting anything.

Each explicit invocation makes a fresh, non-durable UUID and independent root trace identity. It generates exactly one synthetic record for each configured signal: `jevable.telemetry.probe` span, counter data point and/or log record. Normal workflow sampling, queued observations and runtime/exporter counters are unchanged. A configured trace probe is deliberately sampled even when normal workflow sampling is zero. The probe UUID is explicitly identifying diagnostic resource metadata across all three signals, not a high-cardinality label on ordinary runtime metrics. Review configured resource values before sending them.

Only one probe can be admitted per owner at a time. SDK owner close and credential/configuration mutation refuse `busy` while the probe is admitted; close explicitly after it settles. Direct telemetry shutdown aborts and joins its probe. One configured `timeoutMs` bounds the probe, including protected credential lookup; each signal has at most one transport attempt, with no redirect, endpoint discovery, fallback or automatic retry. HTTP/protobuf and explicit origin-only gRPC share the existing verified-TLS transport. Aborting or timing out cannot retract data already received.

The report excludes endpoints, credentials, actor/project/workflow payloads and raw Collector text. It includes the probe UUID, timestamps, protocol, trace identity, enabled signals and their bounded outcomes. `attempted` means the signal entered the configured transport attempt, including credential resolution; it is not proof a POST reached the receiver. A partial rejection fails that signal; a partial-success warning with zero rejected records remains `warning`, without copying remote diagnostic text. Other signals keep their own outcome.

CLI exit 0 means all configured signals were acknowledged, possibly with a reported warning. Disabled, rejected, failed or aborted probes exit 1; invalid input remains exit 2. Preserve the report and use its UUID/trace IDs to look for the synthetic records in the selected receiver/backends. An [OTLP acknowledgement](https://opentelemetry.io/docs/specs/otlp/#otlphttp-response) proves only receiver acceptance of that request—not storage, downstream export, indexing, retention, dashboards or production observability.

There is no durable probe journal, retry identity or recovery catalogue. A disconnected client may lose the response after the receiver accepted data. Do not automatically repeat a probe or run a workflow to fill that gap; inspect the receiver, or request a separately authorized fresh probe. Source/private-loopback tests do not establish real PostgreSQL, deployed-owner/image, production receiver, database TLS, browser or Kubernetes qualification; consult the developer evidence for the exact current artifact scope.

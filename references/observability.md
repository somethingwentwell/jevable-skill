# Optional local observability backend

Use this when the user wants to inspect Jevable signals in a real Collector, Prometheus, Tempo, Loki and Grafana. This is an **explicit local development/test profile**, not a production monitoring service, managed cloud integration or Kubernetes deployment. The runtime does not depend on this profile or on Docker. Existing OTLP receivers remain supported through [telemetry configuration](telemetry.md).

The shipped `examples/observability/` directory contains a digest-pinned Compose profile, Collector configuration, Prometheus naming/alert rules, a provisioned Jevable dashboard and an opt-in runtime telemetry file. Grafana's [LGTM image](https://grafana.com/docs/opentelemetry/docker-lgtm/) is upstream development/demo/testing software. A persistent volume does not make it production-ready. The image includes several backends and needs roughly 4 GB of available container memory plus image/data disk space.

## Start explicitly

Copy the **whole** `examples/observability/` directory to a private working directory outside your source/export tree. Review the files first. All commands below are operator actions, not automatic skill setup. Use a local Docker context you have reviewed; the examples use `desktop-linux` only as an illustration.

1. Generate a fresh owner-only password file with the installed CLI, for example `jevable runtime token --output /absolute/private/path/grafana-password`. This file is a new Grafana credential, **not** a Jevable API token or provider credential. Do not paste its contents into chat or arguments.
2. Set `JEVABLE_OBSERVABILITY_PASSWORD_FILE` to that absolute path. Keep the file outside the copied config directory. Grafana uses it for its initial admin password and local encryption key; keep it with the retained volume. Changing this file is not an admin-password rotation procedure.
3. Download the reviewed image explicitly:

   ```sh
   docker --context desktop-linux pull grafana/otel-lgtm@sha256:b966ea107831d526d9eb8fe4d2d86c9e5731392fad9dce8296bcf2072031f07c
   ```

4. From the copied directory, inspect the resolved configuration, then start that named project only:

   ```sh
   docker --context desktop-linux compose -p jevable-observability config
   docker --context desktop-linux compose -p jevable-observability up -d --no-build --pull never
   ```

The backend serves Grafana on `127.0.0.1:3000` and OTLP HTTP on `127.0.0.1:4318`. Optional `JEVABLE_GRAFANA_PORT` / `JEVABLE_OTLP_PORT` select other host ports; update `telemetry.json` when changing the latter. Grafana requires user `admin` and the password from the private file. Anonymous access, Grafana plugin preinstallation and eBPF auto-instrumentation are disabled in this profile. The project bridge permits outbound traffic: this is **not a network-egress sandbox**. Internal-only bridges did not publish the requested host ports on the tested engine; do not silently switch networks or broaden port bindings on an existing deployment. No Docker socket, runtime database, harness, desktop state or broad host directory is mounted. The upstream development image runs as root with only the explicitly retained file-reading capability; this is not a hardened production/non-root deployment.

The OTLP receiver is unauthenticated and has no CORS configuration. Published ports bind only to host loopback, but **other local processes and containers on the same project network can still send data**. Do not use this on an untrusted multi-user machine, publish its ports remotely, or forward them through a tunnel. Remote collectors require an independently reviewed authenticated TLS deployment. Backend APIs are not published directly; authenticated Grafana proxies its internal data sources. The custom Grafana file is mounted at the direct binary's `conf/custom.ini` path; this LGTM image does not use the official Grafana Docker entrypoint's `GF_PATHS_CONFIG` handling. Verify authenticated access and default-password rejection before sending any data.

## Connect the workflow runtime

The pinned upstream image also attempts an optional MCP bootstrap with a default password. This profile directs only that bootstrap's `GRAFANA_URL` to the unused container-loopback port `1`, preventing repeated failed logins against the real admin account. Grafana itself still listens on port 3000. Do not point this bootstrap URL at a remote service or replace the private credential with `admin`. The upstream startup banner still prints its default login/ports; use the resolved Compose bindings and verified private credential, not that banner.

Pass the copied `telemetry.json` explicitly when starting your local owner:

```sh
jevable runtime serve --token-file /absolute/private/path/jevable-api-token --data-dir /absolute/private/path/workflow-state --telemetry-file /absolute/private/path/observability/telemetry.json
```

Provision the API token separately. This command starts the **Jevable workflow runtime**, not Jarness or an authoring agent. For a one-shot CLI command, add `--telemetry-file` to a supported local command instead; it may finish before a dashboard has enough samples for rates. No configuration is inferred from `OTEL_*` or Docker environment variables by the core. The example opts into request, retained-state and exporter-health metrics and sends metadata diagnostics locally; review [privacy and signal limits](telemetry.md) first.

Open the **Jevable workflow runtime** dashboard in Grafana. Choose one service, environment and runtime instance. A restarted runtime has a new instance ID; never add old and new retained-state counts together. The dashboard includes segment/node/model rates and latency, reported usage, retry/recovery observations, API status/duration, approval counts/age, export health and correlated structured logs. Use Explore → Tempo with an exact retained trace ID from `jevable runs traces <run-id>`, or follow a trace ID from a log. Missing traces may be unsampled, delayed, dropped or expired; do not replay a workflow to manufacture them.

## Optional gRPC receiver

The Collector also listens on port 4317 inside its project network, but the default Compose file does not publish that port. To select it deliberately, review and include the shipped override for the **same named project**:

```sh
docker --context desktop-linux compose -p jevable-observability -f compose.yaml -f compose.grpc.yaml config
docker --context desktop-linux compose -p jevable-observability -f compose.yaml -f compose.grpc.yaml up -d --no-build --pull never
```

This adds only `127.0.0.1:4317`; Grafana and HTTP ports remain unchanged. Use `telemetry-grpc.json` instead of `telemetry.json` when starting the workflow runtime. `JEVABLE_OTLP_GRPC_PORT` changes the published port; update all three origin-only URLs in that file to match. There is no automatic protocol detection or fallback. Use the same Compose file selection for subsequent inspection/stop operations. Changing an existing project's profile can replace its container: coordinate that explicitly and preserve its volume/password. The same local-process/project-network injection risks apply, and no remote plaintext publication is authorized. The runtime's [gRPC configuration](telemetry.md#explicit-otlpgrpc) is separate from the Collector's downstream HTTP export to local backends.

## Interpretation and alert policy

The profile deliberately selects Prometheus `UnderscoreEscapingWithoutSuffixes`: dots become underscores without adding counter/unit suffixes. The dashboard and alert expressions share that contract. When adapting to another backend, verify its translation and resource labels rather than silently using these expressions. See [Prometheus OTLP configuration](https://prometheus.io/docs/prometheus/latest/configuration/configuration/#configuration-file).

- Segment observations are not unique workflow completions. HTTP success is not workflow success or proof of client receipt. Model-call completion is not necessarily node settlement.
- Retained counts/approval ages are shown only when the projection is available and its measurement is less than 30 seconds old. The example exports every second. If you change cadence, review the freshness gate. Missing data is **unknown**, never an invented zero or green status.
- Retained state is checkpoint history, not a distributed scheduler queue. Approval age includes downtime. A past deadline does not automatically settle an approval.
- Rates need at least two samples. No model/retry/recovery activity legitimately produces no data for those instruments. Reported token counts are not durable billing.
- Exporter acknowledgement does not prove downstream retention. When the metrics path fails it cannot reliably report its own outage; the expected-service absence alert is a separate check.

`alerts.yaml` includes examples for the explicitly expected local service/environment being absent, unavailable retained state, telemetry loss, past-deadline/old approvals, failed or uncertain segments, and API 5xx. Thresholds (including 30-second freshness and 15-minute approval age) are **demonstration choices, not production SLOs**. Review service/environment selectors, grace periods, ownership and escalation with the user. No Alertmanager or notification destination is configured; enabling external delivery requires separate authorization. Alerts never approve, expire, retry, cancel or repair workflows.

Runbooks: for absence, inspect the runtime process, selected config and Collector/backend health; for unavailable state, inspect owner/storage health and the journal; for export loss, examine queue/drop counters and receiver errors; for approval age, review the exact pinned request with its authorized approver; for execution/API errors, inspect retained run/control IDs before deciding whether any action is safe. Preserve uncertain intent and reuse original request identities.

## Stop and retain evidence

Stop only your named project with `docker --context desktop-linux compose -p jevable-observability stop`. Inspect completion if shutdown takes longer than expected; do not start a replacement solely because a wait timed out. The upstream image has a bounded component-shutdown watchdog, so a clean container exit alone is not proof that every backend flushed its last record. This profile does not guarantee exactly-once telemetry delivery.

The named `data` volume contains private diagnostic data and Grafana state. Do not use `down -v`, broad prune commands or delete the password file automatically. Back up and delete the exact retained resources only with an explicit retention/erasure decision. The profile limits Prometheus storage to three days/512 MB; other bundled stores retain according to the pinned image's defaults. This is not a uniform retention policy or a secret-erasure guarantee.

## Qualification boundary

The local verifier checks actual receiver/backend storage, trace/log correlation, metric translation, provisioning and PromQL/alert behavior, runtime replacement, exporter outage without execution replay, and a stopped/recreated backend using its retained volume. It does not establish browser rendering/accessibility, production auth/TLS, HA, backup/restore, hosted-provider behavior, notifications or Kubernetes observability. Do not represent an imported/provisioned dashboard as visually reviewed. Production deployment and the remaining observability roadmap stay separate gates.

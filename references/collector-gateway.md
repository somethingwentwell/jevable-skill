# Optional telemetry gateway export

Use `jevable telemetry export-gateway` when the user wants a reviewed, offline OpenTelemetry Collector configuration bundle. It does not install or start a Collector, publish a port, apply Kubernetes manifests, send telemetry, inspect a workflow owner or require Docker/Jarness. The Jevable workflow runtime can also export directly to its configured OTLP backend; this gateway is optional.

This experimental configuration profile targets the independently provisioned **Collector contrib 0.136.0** component names/options. It is not a latest-version recommendation or a claim that the user's binary, image or cluster has been qualified. Validate the exact trusted distribution before startup; newer distributions can rename components or change configuration. The core never downloads a Collector or substitutes a legacy service.

## Export and inspect

Copy [the reference-only example](../examples/collector-gateway.json), replace its public example destinations and explicitly review enabled signals, network binding and memory/queue bounds. Keep secrets out of this file. Inspect `jevable schemas show collector-gateway-options` for the structural shape; actual core admission also enforces URL, memory and byte-limit refinements.

```sh
jevable telemetry export-gateway \
  --options-file gateway.json --options-sha256 <reviewed-file-sha256> \
  --output gateway.zip
```

The reviewed hash is SHA-256 of the **exact input file bytes**, not normalized JSON. Wrong hashes or invalid configuration refuse before replacing output. Existing output requires `--overwrite`. Output is atomically published as a private file. The ZIP contains `collector.yaml`, normalized `gateway-options.json`, a provisioning/lifecycle `README.md`, and `manifest.json` with file hashes, enabled signals and required private-file names. The returned CLI receipt includes both reviewed-input and normalized-options hashes plus the ZIP checksum. Hashes establish bytes, not signatures, deployment permission or backend ingestion.

SDK integrations use `createCollectorGatewayBundle(options)` and `inspectCollectorGatewayOptions(options)` from `@jevable/core/telemetry`. These are pure packaging functions: imports and calls start no service, read no credentials and access no runtime state. Core validation returns sanitized `invalid-command`; supplied values are not echoed.

## Provision separate TLS and credentials

The single explicitly chosen HTTP/protobuf or gRPC receiver always uses TLS and bearer-file authentication. Bind address must be one of `127.0.0.1`, `::1`, `0.0.0.0`, `::`; a wildcard is only a configuration choice, never authorization to expose a service. There is no plaintext, insecure TLS, automatic discovery or ambient environment selection.

Provision `receiver.crt`, `receiver.key` and `receiver.token` beneath `/private/gateway` in the Collector environment. The certificate must match the authority used by the runtime. The token is an independently generated single Collector bearer credential; never reuse a workflow management, delegated grant or approval token. The application gets a separately provisioned reference to that credential, not access to the Collector's file system.

For each enabled backend, select `authentication: none` or `bearer-file` explicitly. Bearer mode requires a **separate** `/private/gateway/<signal>.token`; `extraCa: true` additionally references `<signal>.ca.crt`. All destinations are canonical HTTPS URLs without URL credentials, queries, fragments or Collector interpolation. HTTP uses the exact signal endpoint; gRPC requires an origin with its trailing `/`, which is converted to Collector host:port with TLS enabled. System CA trust is used unless an explicit extra CA file is selected. No secret files or bytes are generated/read/exported by Jevable.

Review the exact extension's token-file parsing, reload/rotation and TLS behavior before use. Do not leave projected secrets world-readable or treat a successful export as proof of file permissions, valid certificates, usable credentials or network reachability. In Kubernetes, independently provision the Collector workload, Secret volumes, DNS, resource limits and ingress/egress policies. The workflow deployment exporter remains separate and never embeds a Collector or authoring skill in the workflow pod.

## Identity, forwarding and loss

Each enabled signal has its own reviewed exporter and pipeline. `memory_limiter` is first, followed by optional explicit `resource/explicit` enrichment. The shipped example uses bounded batching and a **memory-only** exporter queue with a finite retry budget; it is not a durable delivery ledger. Size a process/container budget above the specified heap limit and qualify load/GC behavior. Shutdown, saturation and outages can lose telemetry; forwarding retries can duplicate records, but cannot execute/replay workflow actions. Received OTLP acknowledgements do not prove backend storage, trace search, dashboards or alerts.

An opt-in persistent exporter queue can narrow Collector process-restart loss without changing the Jevable workflow runtime. In reviewed options, **omit** `batch`, set `forwarding.retryMaxElapsedMs` to `0`, and add an explicit POSIX absolute directory:

```json
"forwarding": {
  "queueSize": 128,
  "retryMaxElapsedMs": 0,
  "persistentQueue": { "directory": "/var/lib/otelcol/jevable-queue" }
}
```

This generates `file_storage/queue` with `fsync: true`, `create_directory: false` and `recreate: false`; each exporter names it in `sending_queue.storage`. The in-memory `batch` processor is absent so it cannot acknowledge records held only in a pre-queue batch. The queue directory must exist before Collector startup, be writable by its dedicated user, and be backed by separately reviewed storage retained across the intended Pod/container replacements. Give it one writer and preserve the same extension/exporter identities. The `0` retry limit means transient backend failures are retried without a time cutoff, **not** unlimited queue capacity: a full queue must reject new telemetry. Monitor capacity, exporter failures and backend readback. Do not delete a corrupt queue or turn on automatic recreation to make readiness green; retain the bytes for investigation. The upstream [Exporter Helper persistent-queue contract](https://github.com/open-telemetry/opentelemetry-collector/blob/v0.136.0/exporter/exporterhelper/README.md) and [File Storage extension](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.136.0/extension/storage/filestorage/README.md) describe this pinned profile.

This is **not a general crash-safe or production backend claim**. A selected private same-host test on the pinned Collector survived one `SIGKILL` per HTTP/gRPC pairing and replayed traces, metrics and logs after temporary backend refusals. A receiver may still fail before enqueue, a queue can fill or fail, permanent refusals can discard records, in-flight duplicates can occur, and backend acceptance may precede durable storage. Repeat process-loss testing on the intended deployment; node/PVC loss, backup and retention remain unqualified. It does not repair the malformed test-only [Minikube JSONL file-exporter result](kubernetes.md#minikube-and-k3s-testing), and file export should not be treated as the downstream production store.

## Optional Collector self-metrics

Omitting `selfMetrics` explicitly generates `service.telemetry.metrics.level: none`. No implicit default Prometheus listener is enabled. To request instance-local gateway diagnostics, add a reviewed, separate loopback address/port:

```json
"selfMetrics": { "bindAddress": "127.0.0.1", "port": 8889 }
```

Only `127.0.0.1` and `::1` are admitted, with integer ports 1024–65535 distinct from the OTLP receiver port. The generated normal-level Prometheus reader suppresses type/unit suffixes for this pinned Collector profile. It can expose receive/export failures, queue size/capacity and process measurements; names and resets must be checked against the actual binary. There are no arbitrary labels, detailed mode, secret values, scraper configuration or automatic internal-metric forwarding inputs.

This reader serves **unauthenticated loopback HTTP**, unlike the TLS/authenticated OTLP receiver. The loopback is inside the Collector's own network namespace; it is not automatically reachable from a different container or pod. Treat diagnostics as potentially sensitive. Do not expose them with wildcard binding, host networking, public ingress, port forwarding or another application's proxy without separately reviewed access control and authorization. Packaging starts no listener and grants no networking or deployment authority. Use an explicitly selected local scraper only when requested.

Collector counters are not workflow run counts, approval receipts, durable backend ingestion or exactly-once delivery proof. Queue size is instantaneous; a memory queue is not durable and a persistent queue still needs disk/receiver/backend qualification. Counters reset with Collector replacement. Missing/stale metrics mean unknown. Collector self-metrics remain separate from the application's exported telemetry and retained workflow evidence. Production/Kubernetes and load/capacity acceptance require their own checks. See the [upstream internal telemetry configuration](https://opentelemetry.io/docs/collector/internal-telemetry/).

## Resource identity and collection boundaries

Optional `enrichment.clusterName` and `enrichment.environment` only **insert missing** `k8s.cluster.name` and `deployment.environment.name`. Existing application attributes win. This never replaces application service/pod/instance identity, invents a pod UID, requests Kubernetes API access, collects labels/annotations or adds metric point labels. These defaults are operator assertions, not kubelet-attested metadata; prefer the runtime's explicit [Downward API resource staging](kubernetes.md#optional-pod-telemetry-identity) for actual workflow pod identity.

The generated gateway receives application OTLP only. It has no host metrics, scraping, file log collection, payload/debug exporter or tail-sampling processor. Optional agents must collect distinct sources rather than duplicate the application's exported signals. Adding tail sampling requires trace-ID-affine routing, consistent sampling policy, bounded state and decision windows that handle long approval waits, retries and recovery segments. Head-unsampled spans cannot be recreated; late resumed segments are not necessarily present during the original decision window. Qualify those choices separately before enabling them.

## Evidence and remaining gates

Source tests verify schema/semantic refusal, TLS/auth references, per-signal routing, immutable identity enrichment, bounded forwarding, persistent-queue configuration, deterministic ZIP/file checksums, protected atomic output, review guards, no-owner CLI/help and absence of secret-value inputs. Separate pinned-binary private tests validate generated configuration, all four HTTP/gRPC forwarding combinations, and one timed same-host `SIGKILL`/queue replay per combination. Those tests use synthetic local receivers, so **production/Kubernetes acceptance is still open**. Validate the exact deployed binary and credentials, loss/drop visibility, memory pressure, downstream retention/search, dashboards, agent/tail-sampling routing and cluster isolation/lifecycle before production claims.

Primary configuration references: [Collector 0.136.0 OTLP HTTP exporter](https://github.com/open-telemetry/opentelemetry-collector/blob/v0.136.0/exporter/otlphttpexporter/README.md), [bearer token authentication](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.136.0/extension/bearertokenauthextension/README.md), [memory limiter](https://github.com/open-telemetry/opentelemetry-collector/blob/v0.136.0/processor/memorylimiterprocessor/README.md), and [resource insert semantics](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/resourceprocessor/README.md). These documents informed the profile; they do not replace execution qualification.

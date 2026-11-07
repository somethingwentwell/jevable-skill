# Kubernetes release export

`releases export-kubernetes` creates a reviewed deployment ZIP for a pinned **Jevable workflow runtime** release. Packaging never contacts a registry, Kubernetes or the target database, and never publishes or applies anything. The default local owner needs no Docker; selecting a Docker authoring owner additionally verifies its container metadata and reads the release over HTTPS. Generated manifests and local script tests are not cluster qualification.

Discover this separately with `capabilities`: `kubernetesExport.available: true` advertises local package generation, its command/SDK, PostgreSQL exact-release scope and one-replica workflow runtime. The existing `kubernetes: false` flag still means cluster execution is not supported/qualified; it does not disable package export. Discovery does not verify a registry image, provision Secret values, apply manifests or execute a workflow.

Cold start: generated pods now wait for verified PostgreSQL TLS transport after staging configuration, before launching the runtime. `databaseTransportWaitSeconds` defaults to 60; choose 1–300 seconds per init attempt, or 0 to disable. Only transient connection/DNS failures retry against the same configured destination; certificate and protocol refusals fail closed. Kubernetes can retry failed init containers, so this is not a total pod-lifetime deadline. The gate sends no database credentials, StartupMessage, SQL, schema/owner admission or workflow work. It checks transport only; runtime authentication, database health and release readiness remain separate. This does not add reconnection or uncertain-write retries, or liveness restarts after outages. Qualification of the earlier image/export does not qualify this new gate on a live cluster.

This first profile serves one exact PostgreSQL release, not the authoring/preview API. Create it with `releases create --runtime-storage postgres`, then follow [image packaging](images.md) to retain an image receipt. The installed distribution must still contain the release's exact runtime bytes. The exporter checks release, runtime, revision and package-manifest hashes against that receipt; it does not substitute a newer runtime.

## Review the deployment inputs

Supply a registry **manifest** digest for the image you independently published and verified. A local Docker image ID can be a configuration digest and is not interchangeable with that digest. `imageBinding` records your assertion that the registry image contains the reviewed release and target platform; the exporter does not attest it. There is no push command in this workflow.

Example `deployment.json` (replace example names, digest and network selectors with reviewed values):

```json
{
  "name": "workflow",
  "namespace": "automation",
  "image": "registry.example/workflow@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "imageBinding": "operator-verified-release-and-platform",
  "publicOrigin": "https://workflow.automation.svc.cluster.local:8787",
  "configurationSecret": "workflow-private",
  "imagePullSecrets": ["registry-access"],
  "telemetry": true,
  "telemetryExtraCa": false,
  "telemetryPodMetadata": false,
  "terminationGracePeriodSeconds": 3600,
  "resources": {
    "requestCpuMillis": 250,
    "limitCpuMillis": 1000,
    "requestMemoryMiB": 256,
    "limitMemoryMiB": 512
  },
  "network": {
    "dns": { "kind": "pods", "namespace": "kube-system", "labels": { "k8s-app": "kube-dns" } },
    "ingress": [{ "kind": "pods", "namespace": "clients", "labels": { "app": "workflow-client" } }],
    "egress": [
      { "peer": { "kind": "pods", "namespace": "database", "labels": { "app": "postgres" } }, "port": 5432 },
      { "peer": { "kind": "pods", "namespace": "observability", "labels": { "app": "otel-collector" } }, "port": 4318 }
    ]
  }
}
```

All names/settings are explicit; replicas, container commands, host mounts and arbitrary environment overrides are not accepted. Optional `imagePullSecrets` lists independently provisioned registry Secret names in the workload namespace; omit it for images that need none. Add separately reviewed model-provider egress when needed. A peer can alternatively be `{ "kind": "cidr", "cidr": "192.0.2.5/32" }`; `/0` is refused. These rules describe IP/port access, not DNS-name authorization. DNS, pod labels, Service translation, external ranges and any NodeLocal DNS configuration need cluster-specific review. Policies are additive and need a supporting CNI; the exporter does not prove effective isolation. See [Kubernetes NetworkPolicy semantics](https://kubernetes.io/docs/concepts/services-networking/network-policies/).

```sh
jevable releases export-kubernetes <release-id> \
  --release-sha256 <reviewed-release-sha256> \
  --image-receipt image-receipt.json --receipt-sha256 <reviewed-file-sha256> \
  --options-file deployment.json --options-sha256 <reviewed-file-sha256> \
  --output deployment.zip --data-dir .jevable
```

The ZIP has `workload.yaml`, `deployment-options.json`, `image-receipt.json`, `README.md` and `manifest.json` with file byte counts/hashes. The CLI returns the ZIP checksum. It excludes workflow source, state, private payloads and Secret values. Existing outputs require explicit `--overwrite`. Local packaging does not need Docker installed. SDK callers use `createKubernetesBundle` from `@jevable/core/deployment` with a reviewed release, runtime artifact, image receipt and options.

For a release held by a Docker authoring owner, replace `--data-dir` with the complete [owner selection](docker-owner.md#author-test-and-run-through-the-selected-owner). The host reads the receipt/options files and verifies their reviewed hashes, obtains the pinned release, resolves its exact local runtime bundle and writes the deployment ZIP. No file paths, Docker socket, database files or deployment authority are granted to the management container. A mismatched image/release or options hash is refused before replacing the output. The deployment image runs only the Jevable workflow runtime; it does not connect back to this owner or require the skill.

## Secret and state provisioning

Provision the namespace, database schema/role, registry access and a Secret named by `configurationSecret` independently. Required keys are `database.json`, `service-token`, `server.crt`, `server.key` and `ca.crt`. With telemetry enabled, add `telemetry.json`; with `telemetryExtraCa`, also add `telemetry-ca.crt`. No Secret objects or credential bytes are generated.

Database configuration must use `tls.mode: verify-full` with explicit matching DNS/CA as needed; see [PostgreSQL](postgres.md). Service TLS must cover the exact `publicOrigin`; `ca.crt` is the corresponding probe trust chain. The 64-character lowercase hex token carries full release-owner authority, including private inspection and approvals. Provider/collector credential references must already be provisioned in the database before serving; see [telemetry](telemetry.md).

Kubernetes Secret projections use symlinks and may have group-readable modes, while runtime readers intentionally require owner-only regular files. A UID/GID 1000 init container resolves only links contained in its Secret volume and copies bounded files to a private memory-backed directory, mode 0700/0600. Only the init container sees the projection. The runtime sees the copied volume read-only and runs without root, capabilities, privilege escalation or a writable root filesystem. The image/base must support UID 1000. No permission checks in the core are weakened. Review [Kubernetes security contexts](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/) for volume ownership behavior on your cluster.

Staging retries replace only regular, singly linked pending files owned by the init user. Pending pipes, directories, symlinks and shared hard links are refused before writing configuration or truncating an existing inode; a leftover pipe cannot wait for a reader. This does not qualify hostile filesystem races or actual kubelet behavior, and refusal does not authorize repairing or deleting retained files.

Secret updates do not refresh the private copy. Rotate with an explicitly reviewed replacement and drain. Memory-backed files are configuration only, not durable run storage. PostgreSQL retains workflow state externally; database backup/restore, migrations and non-database artifact persistence are separate unfinished deployment work.

## Optional shared HTTP quota

In a build containing this exporter change, set `rateCoordinator: true` in the reviewed deployment options to attach the PostgreSQL workflow runtime to an independently provisioned PostgreSQL HTTP quota. Omit it for the unchanged default. The generated pod projects `rate-coordinator.json` from the configuration Secret, stages it into a private regular file, and passes `--rate-coordinator-file /private/config/rate-coordinator.json`. No quota settings or credentials are embedded in the ZIP.

Supply the complete [coordinator options](postgres-rate-limits.md), with **`initialize: false`** and **`connection.tls.mode: verify-full`**. The file is bounded to 65,536 bytes. Independently provision the retained scope/policy and restricted serving role; the app does not bootstrap, reset balances, reconnect or retry uncertain debits. Staging checks JSON, attach-only mode and TLS; the runtime validates the complete schema before acquiring workflow ownership. Secret updates still require a reviewed normal replacement.

Quota and workflow databases may differ. Explicitly review the quota host, CA and required NetworkPolicy egress: this option adds no egress rule or separate quota transport gate. The existing cold-start gate covers only workflow database transport. Reserve control-lane capacity for health/readiness traffic from every sharing owner. Sharing a quota provides neither a workflow lease nor permission to scale the one-replica deployment; independent owners still need separate workflow namespaces.

This is export and protected-staging support, not live shared-quota Kubernetes acceptance. Previously tested images and manifests are unchanged and do not gain this option automatically. Current container/pod admission, replacement, faults and received telemetry need their own exact-artifact qualification. This exporter remains PostgreSQL-workflow-only; it does not add a SQLite Kubernetes profile.

## Optional pod telemetry identity

Set `telemetryPodMetadata: true` only with `telemetry: true` and permission to export infrastructure names. It defaults to false. The generated init container receives four explicit [Downward API](https://kubernetes.io/docs/concepts/workloads/pods/downward-api/) fields: `metadata.namespace`, `metadata.name`, `metadata.uid` and `spec.nodeName`. It stages these as `resource.kubernetes.namespace`, `podName`, `podUid` and `nodeName`, with the runtime container name `workflow`, in the private telemetry JSON. This needs no API token, RBAC or API-server call.

Leave those five fields absent in the Secret's telemetry file, or supply exactly matching values. Missing/invalid injected values or conflicting configured identities fail staging with a sanitized error. Collector endpoints/authentication, optional `resource.serviceNamespace` and operator-supplied `resource.kubernetes.clusterName` are preserved; no cluster name is guessed. Labels, annotations and arbitrary environment variables are not exported. The core validates the complete resulting telemetry configuration before startup. With enrichment disabled the telemetry file is copied unchanged.

The app consumes the staged file, not Kubernetes environment discovery. A new runtime instance retains pod metadata but gets a fresh `service.instance.id` so restarted cumulative metric series remain separate. The scoped Minikube trial below also verified actual pod identities in received Collector signals; this does not qualify other clusters or production backends.

## Service and lifecycle

The bundle emits a ServiceAccount without an API token or RBAC grants, an immutable script ConfigMap, a one-replica `Recreate` Deployment, ClusterIP HTTPS Service and an explicit NetworkPolicy. It does not emit Ingress, LoadBalancer, a database, Collector or authoring skill. Configure DNS/certificates for the stated public origin; the runtime rejects other Host/Origin values and proxy identity headers.

The readiness script talks to pod loopback while verifying the configured TLS hostname, bearer protocol, release/runtime identity and database health. It never starts a run or acquires a second database owner. No liveness probe is emitted: a transient database outage must not automatically restart an admitted external action. Review [probe behavior](https://kubernetes.io/docs/concepts/workloads/pods/probes/) before adding probes.

After a database Pod replacement, the old workflow owner may remain Not Ready with `503 ownership-lost` even when PostgreSQL is Ready. This is an intentional stop, not a self-healing restart trigger. The generated bundle README now gives an exact, context-scoped operator recovery sequence: verify the database and durable state, preserve the old run/request IDs, resolve any active or uncertain provider effects, confirm the old owner is fail-closed, then explicitly authorize a `Recreate` rollout of only the workflow Deployment. Read the original run/checkpoint/events/evidence under the new owner before further action. If the provider outcome cannot be established, stop; do not use a new run ID, automatic resume, liveness restart or PVC deletion to make the service green. This guide is a source change and does not retroactively alter previously exported ZIPs.

`Recreate` avoids normal rollout overlap but is not a distributed lease or guarantee against all concurrent pods. The database's exclusive owner remains authoritative. Do not scale beyond one, force-delete an owner, or treat a drain timeout as successful closure. Kubernetes can force-kill at the end of the selected termination grace period; qualify maximum admitted work, OTLP flush, pod loss and uncertain-effect recovery before production. Retain original run UUIDs; replacement never authorizes approval or replay.

## Minikube and k3s testing

The pod runs the **Jevable workflow runtime**, not the skill, desktop app or Jarness. Local Node execution needs no Docker. The current image builder needs a supported local Docker engine; an already-built image can run on k3s using its container runtime instead.

| Path | Current evidence | Dependencies you provision |
| --- | --- | --- |
| Minikube | Nine live checks passed on Kubernetes 1.35.4, Linux arm64, containerd and Calico | Exact image, verified-TLS PostgreSQL, private configuration, allowed client and optional Collector |
| k3s | Earlier pinned Linux arm64 image passed nine scoped lifecycle/TLS/policy/approval/replacement/OTel checks on v1.35.9+k3s1; startup caveats retained. Separate **current-package** generated PostgreSQL echo, Human Approval and typed Jev Decision releases passed admission, verified HTTPS execution, normal Pod replacement/cold-start retention and actual Collector-received traces/logs/metrics. The approval run linked waiting and decision segments across distinct Pods; a later synthetic waiting approval also survived an exact container-task `SIGKILL`. The generated Jev Decision run exercised synthetic Choice/Score/Noul output, model retry/backoff, approval continuation and provider trace-context propagation. Active-effect, real provider quality, database/PVC/node loss and durable backend retention remain open. | Linux node/VM, matching image architecture, enforcing NetworkPolicy, TLS/database/configuration and node-local image availability |
| Production | Not qualified by these local trials | Least-privilege roles, certificate lifecycle, backup/restore, retention, forced-failure recovery and deployment-specific security |

The exact current-guide PostgreSQL workflow image has a separate source-checkout receipt `qualification/current-guide-pg-minikube-durable-short-grace-2026-10-20.md`: one idle synthetic run survived a one-second-grace database Pod deletion on the same Bound PVC; the original workflow owner became Not Ready and returned verified-TLS `503 ownership-lost`; one explicit `Recreate` rollout read the unchanged original checkpoint/events/evidence. The same profile, PVC and run then survived a normal outer-VM restart. This private qualification file is **not included in the skill ZIP**. The result does not validate automatic failover, active external effects, zero-grace loss, multi-node or production recovery. The preceding `/tmp`-profile loss is separately recorded and was **not** treated as a successful continuation.

The separate current-package k3s echo/PVC smoke (source-checkout report `qualification/current-k3s-echo-pvc-2026-10-16.md`) exercised a SQLite one-shot Job, not this PostgreSQL export profile. It found that the local-path PVC root was too permissive for Jevable state and that a replacement Pod's default `fsGroup` handling widened private SQLite file modes, causing a safe refusal. An owner-created private child directory and subsequent Pods without repeated `fsGroup` mutation retained the same run across Pod and k3s-container restart. Do not treat this as support for SQLite as a Kubernetes service or as qualification of the generated PostgreSQL Deployment.

The current-package PostgreSQL/k3s echo qualification (source-checkout report `qualification/current-pg-k3s-echo-2026-10-16.md`) separately used the actual generated release Deployment and a test-only PostgreSQL PVC. One exact run and its event/export evidence survived a normal workflow Pod replacement and a normal cold restart of the same single-node k3s container, with verified service TLS and a scoped policy-path check. It did not exercise approval, Jev Decision, received OTel, forced loss, multi-node placement or production security. Neither scoped test makes the Kubernetes profile generally production-ready.

A subsequent current-package received-OTel trial (source-checkout report `qualification/current-pg-k3s-otel-2026-10-16.md`) re-exported that same pinned release with telemetry enabled and verified actual Collector-received traces, metrics and logs for a fresh synthetic echo. The run/node/attempt trace-log joins and Kubernetes resource identity were checked against a private saved copy of the Collector files. Its file exporter used test-only `emptyDir`; it does not prove backend retention, alerting, secure production Collector authentication or general observability completeness.

**Collector file retention is a separate deployment decision.** A `file` exporter on `emptyDir` is only a received-signal fixture; `emptyDir` is not durable telemetry storage. A PVC alone is insufficient: in a current-image isolated k3s trial, the three files shrank after a normal Collector Pod replacement because the OpenTelemetry file exporter defaults to truncation. If using its JSONL file exporter on a separately provisioned single-node PVC for a test, set `append: true` on **each** trace, metric and log exporter, with no `rotation` stanza. The [pinned v0.162.0 file-exporter documentation](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.162.0/exporter/fileexporter/README.md) specifies that default and the append/rotation incompatibility. Keep one Collector writer per file, a private owner-controlled directory, verified file modes and bounded storage. The current-image source-checkout receipt `qualification/current-k8s-guide-pg-k3s-otel-retention-2026-10-20.md` verified exact file prefixes across a normal Collector Pod replacement and same-node VM restart after enabling append. The original failed/truncated snapshots remain retained as negative evidence. **Neither a Bound PVC nor exact old-byte prefixes prove that the resulting JSONL is valid after forced process loss; parse the entire retained stream as a separate integrity check.** This does **not** establish cross-node availability, a production backend, backups, rotation/retention policy, crash-consistent writes, alerting, or long-term capacity; provision and qualify those independently before claiming full traceability.

A separate source-checkout Collector task-loss receipt `qualification/current-k8s-guide-pg-k3s-otel-collector-task-loss-2026-10-20.md` sent one `SIGKILL` to the exact isolated Collector containerd task. Kubelet recorded exit 137; the same Pod/PVC recovered, all three **already written** file prefixes remained exact, the original run's trace/log/metric joins stayed readable, and a new synthetic run produced new joined signals. This does not establish preservation of unflushed in-memory telemetry at arbitrary crash timing or any stronger backend-durability guarantee.

The later **Minikube** task-loss trial `qualification/current-guide-pg-minikube-otel-collector-task-loss-2026-10-20.md` reached the opposite integrity result at another crash timing. After one exact Collector task `SIGKILL` and kubelet exit 137, all three pre-fault byte prefixes survived on the same PVC, but metrics JSONL contained one line with **two complete JSON objects and no separating newline**. The full metrics file failed standard parsing, even though Collector became Ready and later traces/logs arrived. The pinned [file exporter implementation](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.162.0/exporter/fileexporter/file_writer.go) writes a JSON payload and newline in separate calls; this explains the observed failure as a plausible interrupted boundary, not a proven instruction-level trace. Do **not** promote `append: true` plus PVC as crash-safe or production-durable, silently fix a live evidence file, or extrapolate the earlier k3s pass. Choose and qualify a backend/framing/recovery design against the actual forced-failure model.

The current-package Human Approval/k3s trial (source-checkout report `qualification/current-pg-k3s-approval-2026-10-16.md`) then deployed a separate PostgreSQL release and journal namespace from its own generated ZIP. A synthetic request waited through normal Pod replacement, refused a wrong attempt, completed only after explicit approval, and survived k3s cold restart; received OTel links joined the waiting and approval segments across the two Pods. It does not qualify real reviewer roles, competing decisions, typed Jev Decision, forced failures or durable telemetry storage.

A separate current-package approval-container crash trial (source-checkout report `qualification/current-pg-k3s-approval-crash-2026-10-16.md`) reused that exact image/bundle and forcibly killed only its resolved containerd task during a new synthetic approval wait. Kubelet recorded exit 137 and restarted a new container within the same Pod. The same run/attempt/checkpoint/evidence reopened without replay; a wrong attempt was refused, explicit approval completed it, and actual Collector files joined linked traces/logs plus metrics across the two telemetry instances. The original concurrent metrics copy had a partial final JSONL packet; the separately retained complete-packet prefix passed offline verification. This is narrowly a waiting-state container-process failure, not a Pod deletion, active external-effect crash, database/PVC loss or durable telemetry backend qualification.

The current-package typed Jev Decision trial (source-checkout report `qualification/current-pg-k3s-decision-2026-10-16.md`) ran a separate exact generated PostgreSQL image and ZIP against a synthetic verified-HTTPS `systemone-v1` adapter. Structured Choice/Score/Noul output drove both a real `503→200` retry and a Human Approval branch. The waiting run and the completed runs retained their checkpoints and export hashes through normal Pod replacement and k3s cold restart. A real Collector received model retry/backoff spans, logs joined to 18 spans, W3C provider trace context, metrics and a waiting-to-approved cross-Pod link. This is protocol/runtime qualification only: it does not test real Jev/Laya output quality, in-flight external-effect faults or production OTel retention.

A later concurrent-request trial found a **specific flaw in the older PostgreSQL approval image above**: simultaneous approval and cancellation could return approval `409/conflict` and cancellation `200` yet retain only `cancellation-requested` while the run stayed `waiting`. Repeating the original cancellation UUID safely finished the two affected synthetic runs. A source fix now re-reads and settles a committed cancellation after this pre-continuation optimistic conflict. A **new** exact generated PostgreSQL release/image passed the same verified-HTTPS race, committed a single cancellation terminal event, and retained its run/checkpoint/evidence across normal Pod replacement (source-checkout report `qualification/current-pg-k3s-approval-race-fix-2026-10-16.md`). Do not infer that the old pinned image contains the correction. Two HTTP requests used one owner token; real independent reviewer grants, expiry competition on PostgreSQL, active external effects and production HA remain unqualified.

The grant-authorized reviewer path later exposed the analogous cancellation gap. Its source fix, exact-deadline journal regressions, full source/installed-package suites and fresh **actual PostgreSQL SQL plus test-CA loopback management HTTPS** checks with two independently issued reviewer grants passed (source-checkout report `qualification/postgres-delegated-cancel-race-2026-10-16.md`). The preceding `pg-race-fix` image predates this additional fix. Exported exact-release workflow apps intentionally reject reviewer-grant HTTP routes; they are not management services. The management Kubernetes exporter now has a separate, default-off `reviewerDecisions` option that emits `--reviewer-decisions` only for the management Pod. Do not use the old owner-token image result, offline export or host-loopback SQL/HTTPS result as proof of deployed management HTTPS/k3s reviewer behavior. That requires its own exact current-byte management deployment and verification.

### Check request headroom before deploying

A Ready node is not necessarily able to fit another workflow. Kubernetes schedules using resource **requests**, not current CPU/RAM usage or summed limits. A retained test deployment can exhaust request headroom even with no node pressure condition. See the [Kubernetes resource guide](https://v1-35.docs.kubernetes.io/docs/concepts/configuration/manage-resources-containers/).

For k3s or Minikube nested inside a Docker container or VM, also inspect that outer host's hard CPU/memory limit and current usage. Kubelet may report the machine's allocatable resources rather than the tighter outer cgroup; a Kubernetes request calculation can then look healthy while the node container is already overcommitted. The offline capacity command cannot see Docker or VM limits. Do not use its green result to place another database, Collector or workflow until both layers have independently verified headroom; do not stop existing workloads or weaken requests merely to make a trial fit.

Check **disk headroom before loading an image**, too: image import can unpack layers into the node and consume substantially more outer-VM space than the archive or tagged image suggests. A scoped current-image Minikube Collector attempt was halted after the private VM rose from 88% to 93% disk use on image load, before any Collector pod or telemetry workload was applied. Removing only that newly imported image reference did not immediately recover the space; neither a successful import nor an image-reference deletion proves that garbage collection has freed storage. Inspect the outer filesystem and node image store again before proceeding. Do not use `--force`, prune retained volumes/images, remove a PVC or weaken the workload to make a qualification pass. This stopped attempt is not received-telemetry evidence; the separate k3s Collector receipt remains scoped to k3s.

A later current-image **Minikube received-signal trial** enlarged only that stopped owned VM from 16 to 24 GiB, retained the existing profile/PVC, rechecked 8.9 GiB post-import headroom, and bound the node's actual Linux/arm64 Collector manifest digest. Its source-checkout receipt `qualification/current-guide-pg-minikube-received-otel-2026-10-20.md` records one new synthetic run's joined Collector-received traces/logs and nonzero metrics, retained original-run evidence through a normal workflow Pod replacement, and one paired allowed/denied Collector Service path. That first Collector used test-only `emptyDir`; only a separate private snapshot was independently retained. The earlier disk-gated attempt remains a distinct negative result.

A **separate later Minikube PVC/append trial** (`qualification/current-guide-pg-minikube-otel-pvc-retention-2026-10-20.md`) changed only the isolated test Collector to a new `standard` PVC with `append: true` on all three file exporters, one `Recreate` writer and a private checked directory. Three mode-0600 host snapshots independently showed exact already-written trace/metric/log byte prefixes through a normal Collector Pod replacement and clean restart of that same outer VM; the PVC identity stayed fixed and new synthetic runs continued sending joined signals. This narrows the earlier `emptyDir` gap **for that single-node, clean-restart file path only**. Its separate forced-task trial above **failed JSONL integrity**; the clean-restart pass must not be used as forced/process/node/PVC loss recovery, unflushed-batch persistence, rotation/capacity policy, production backend durability or complete observability evidence.

`kubernetes capacity` is an offline diagnosis, not an apply command. Save complete node and all-namespace pod snapshots from one **explicitly reviewed** kubeconfig/context, then inspect the exact additional workload manifest. Collecting snapshots needs your Kubernetes read permissions; Jevable itself never opens a kubeconfig, runs kubectl, talks to the cluster or reads a Secret through this command.

```sh
kubectl --kubeconfig "$jevable_cluster_dir/kubeconfig" \
  --context "$jevable_cluster_profile" get nodes -o json > nodes.json
kubectl --kubeconfig "$jevable_cluster_dir/kubeconfig" \
  --context "$jevable_cluster_profile" get pods --all-namespaces -o json > pods.json
node bin/jevable.mjs kubernetes capacity deployment-workload.yaml \
  --nodes-file nodes.json --pods-file pods.json
```

Use the exact retained cluster variables from the setup below or your explicitly selected existing cluster; do not substitute your default context. Snapshot files can contain private metadata, commands or environment values: keep them private, never commit them, and remove them only after deciding they are no longer needed. The output includes only names/resource budgets and input byte/hash identities, not container commands, environment values, annotations or Secret data.

The SDK equivalent is `inspectKubernetesCapacity({ nodes, pods, workloadYaml })` from `@jevable/core/deployment`. It is pure: the caller supplies snapshots and YAML, with no server, Docker or desktop dependency. Supported workloads are Pods, Deployments, StatefulSets and Jobs, including their replicas/concurrency and `v1/List` wrappers; generated Service/ConfigMap/Secret/NetworkPolicy/ServiceAccount/PVC/Namespace objects do not consume a new pod directly. Unsupported controllers or incomplete/continued, duplicate or malformed snapshots refuse rather than silently disappear.

Accounting follows the [Kubernetes v1.35 request helper](https://github.com/kubernetes/kubernetes/blob/v1.35.4/staging/src/k8s.io/component-helpers/resource/helpers.go): app-container sums, ordered restartable init sidecars, effective init peaks, pod overhead and configured pod-level/in-place resize semantics. Quantities use exact arithmetic, with final CPU-millisecond/memory-byte rounding. It counts bound nonterminal pods, including terminating pods, against **allocatable** CPU, memory and pod slots. It does not credit a same-name replacement or automatically stop old workloads. Suspended Jobs and zero-replica workloads request no additional pods.

| Result | CLI exit | Meaning |
| --- | --- | --- |
| `insufficient-capacity` | 1 | An additional pod has no matching node budget, or the additional batch exceeds aggregate headroom. Review capacity/resources before any apply. |
| `no-obvious-request-shortage` | 0 | These snapshots show no tested CPU/memory/pod-count shortage. This does **not** reserve capacity or prove placement/readiness. |
| Invalid input | 2 | Bounded regular-file, complete-list, supported-workload or resource validation failed. Input values and parser details are withheld. |

Snapshots are not authenticated, atomic or guaranteed current. Unbound pending pods and concurrent actors may consume apparent headroom. Bin packing, taints, affinity/topology, quota, PVC placement, admission mutations, image access, extended resources, networking/security and readiness are **not** simulated. Clusters with other versions/feature semantics need their own verification. Inspect actual scheduler events for Pending pods; a capacity report is never permission to delete, resize, restart, weaken requests or bypass retained ownership.

### Isolated Minikube setup

Install Minikube, kubectl and a supported Docker engine separately. After approval for cluster creation and its resource/download cost, this POSIX-shell example keeps cluster state private and leaves the normal kubeconfig untouched:

```sh
jevable_cluster_dir="$(mktemp -d "${TMPDIR:-/tmp}/jevable-k8s-XXXXXX")"
jevable_cluster_profile="jevable-$(basename "$jevable_cluster_dir" | tr '[:upper:]' '[:lower:]')"
MINIKUBE_HOME="$jevable_cluster_dir/minikube" \
  KUBECONFIG="$jevable_cluster_dir/kubeconfig" \
  minikube start -p "$jevable_cluster_profile" \
  --driver=docker --container-runtime=containerd --cni=calico

kubectl --kubeconfig "$jevable_cluster_dir/kubeconfig" \
  --context "$jevable_cluster_profile" get nodes
```

Keep both variables for subsequent commands; in another terminal restore their exact values instead of creating another cluster. Calico is explicit because network isolation needs an enforcing CNI, not just a NetworkPolicy object. See the official [Docker driver](https://minikube.sigs.k8s.io/docs/drivers/docker/) and [NetworkPolicy guide](https://minikube.sigs.k8s.io/docs/handbook/network_policy/).

If Minikube itself runs **inside a Linux VM**, put `MINIKUBE_HOME`, `KUBECONFIG` and the verified Minikube binary on that VM's persistent private disk, not its `/tmp`: some VMs clear `/tmp` on reboot even while the Docker node volume survives. Keep a recoverable copy of the profile and kubeconfig before stopping the VM. A retained Docker volume alone is not a recoverable Minikube profile. If the profile is missing, do not run `minikube start` under a fresh home with the old profile name and assume it will adopt the node; it may replace the node container. Inspect and preserve the exact volume and cluster identity, then restore the saved profile or build a **new** isolated fixture. Do not treat an unverified replacement as same-PVC readback or proceed to fault injection.

Create a reviewed PostgreSQL release with `releases create --runtime-storage postgres`, then use [image packaging](images.md#build-and-export), selecting the node's architecture and retaining the image receipt. For a reviewed tag `my-workflow:1.0.0` in Docker context `desktop-linux`:

```sh
MINIKUBE_HOME="$jevable_cluster_dir/minikube" \
  KUBECONFIG="$jevable_cluster_dir/kubeconfig" DOCKER_CONTEXT=desktop-linux \
  minikube -p "$jevable_cluster_profile" image load --daemon my-workflow:1.0.0

MINIKUBE_HOME="$jevable_cluster_dir/minikube" \
  KUBECONFIG="$jevable_cluster_dir/kubeconfig" \
  minikube -p "$jevable_cluster_profile" ssh -- 'sudo ctr -n k8s.io images ls'
```

Use your reviewed Docker context if it differs. Daemon loading is the path exercised in the scoped trial; archive loading is also supported by [Minikube](https://minikube.sigs.k8s.io/docs/handbook/pushing/) but was not qualified here.

Inspect the imported manifest and matching platform/configuration before export. Import can re-encode manifests and layers: the source Docker image ID is **not** the target manifest digest. Bind the inspected target to a fresh digest-qualified containerd reference and place that exact reference in `deployment.json`. Never invent a digest, overwrite an existing binding or claim that local import published an image. The trial used `local.jevable/workflow@sha256:…`, a node-local reference, not a public registry. It is available only on nodes where it was loaded and bound. The exporter requires your explicit `operator-verified-release-and-platform` assertion; it cannot inspect the image store for you. Do not change the generated digest pin to a mutable tag.

### Existing isolated k3s node

Before importing or deploying, run the shipped **offline preflight** beside either the npm CLI or an extracted agent-skill CLI. It composes the existing core capacity calculation with observed Ready/cordoned state and the reviewed image platform. It does not run kubectl, inspect kubeconfig, execute credential plugins, contact a cluster, import an image or apply resources.

Collect the following snapshots yourself from the same explicitly reviewed kubeconfig/context. These are operator read operations; a kubeconfig may invoke its configured credential plugin. Review that configuration separately. Save complete lists and keep the files private: pod snapshots can contain credentials or private environment values. Do not use `--raw` kubeconfig export or collect Secrets.

```sh
kubectl --kubeconfig /absolute/private/test-kubeconfig --context reviewed-test-context get nodes -o json > nodes.json
kubectl --kubeconfig /absolute/private/test-kubeconfig --context reviewed-test-context get pods --all-namespaces -o json > pods.json
kubectl --kubeconfig /absolute/private/test-kubeconfig --context reviewed-test-context version -o json > version.json
node bin/kubernetes-preflight.mjs \
  --workload-file workload.yaml --nodes-file nodes.json --pods-file pods.json \
  --version-file version.json --platform linux/arm64
```

Use the exact reviewed export's `workload.yaml` and image platform (`linux/arm64` or `linux/amd64`), never the agent host's architecture. Snapshots need not contain only k3s nodes; this helper also diagnoses a selected Minikube cluster. Input files must be bounded regular files, not pipes or final symlinks. The helper binds every input's byte count/SHA-256 to the capacity subprocess and refuses observed file changes. It prints allowlisted node identity/version/runtime and resource budgets, not labels, annotations, condition messages, environment values or paths. Exit **1** means an observed capacity/Ready/cordoning/platform blocker, **2** means invalid input/checker failure, and **0** means only `snapshot-checks-pass-live-review-required`—never deployable or production-ready. The report retains the original capacity shortages and charges bound pods even on unready/cordoned nodes; their resources are not credited to another node.

Version strings are hints, not attestation. Resource accounting currently follows Kubernetes v1.35; `capacitySemanticsMatch: false` calls for explicit version/feature review, not an inferred compatibility claim. All snapshot provenance/freshness, taints/affinity/quota/storage/packing, image availability, TLS/auth and network enforcement require independent verification. K3s includes an embedded policy controller that can be disabled with `--disable-network-policy`; a k3s version string or NetworkPolicy object does **not** prove allowed/denied traffic behavior. See the official [K3s networking services](https://docs.k3s.io/networking/networking-services) and [kubectl version reference](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_version/). Passing this offline check is not Jevable-on-k3s qualification or authorization to deploy.

On macOS/Windows, k3s needs a Linux machine/VM or a separately operated wrapper; the skill does not install it. With a selected test node, a checksum-verified `releases save-image` archive and authority to modify its image store, its operator can import and inspect it:

```sh
sudo k3s ctr -n k8s.io images import my-workflow-image.tar
sudo k3s ctr -n k8s.io images list
```

Run this on the intended node, not blindly on the agent's host. Inspect and bind the actual target manifest/configuration as above. Load every eligible node or constrain scheduling, and supply an explicit kubeconfig/context for kubectl. k3s documents [image importing](https://docs.k3s.io/add-ons/import-images); neither those upstream instructions nor Minikube success qualifies Jevable on k3s. Do not disable TLS, authentication or network isolation to pass a test.

### Deliberate deployment and acceptance

1. Provision a dedicated namespace, independently owned PostgreSQL state with verified TLS, the private Secret keys listed above, a permitted client and, when selected, a real Collector. Export does not create these dependencies. Temporary certificates and test superuser accounts are not production settings.
2. Export with the exact release/image/options receipts. Extract and review `workload.yaml` in a fresh directory. First use `kubectl --kubeconfig … --context … apply --dry-run=server -f workload.yaml`; this validates admission, not execution or networking.
3. Apply only after deployment approval, using the same explicit kubeconfig/context. Verify readiness and both allowed and denied network paths. Keep one workflow replica and the restricted security context; never mount host source, skill files or the Docker socket.
4. From the allowed client, verify HTTPS, authentication and expected release/runtime identity before an authorized synthetic run. Retain its original UUID and inspect the approval wait; approval needs its own authority. The exact-release service has no authoring/preview API: local HTML preview is a separate session, not a cluster viewer.
5. For an authorized normal replacement test, keep the database and original run UUID. Compare retained state/evidence before and after replacement instead of starting another run. Forced pod death, stale-lock recovery and uncertain external outcomes require separate decisions and tests.
6. Verify actual received traces, metrics and logs, joining run/attempt IDs, old/new pod identities and trace segments. Readiness or exporter configuration alone does not prove delivery. Preserve failures and private state; stop/delete only explicitly selected owned resources when requested.

The local trial passed nine security/network/approval/replacement/signal checks. A separate fresh PostgreSQL initialization passed without manual SQL repair or restarts after making the default socket directory writable. Source-checkout receipts `qualification/minikube-local.json` and `qualification/minikube-fresh-database.json` pin the exact tested profile; they are not shipped credentials or an automated deployment feature. The CLI still reports `kubernetes: false` for managed cluster execution: offline export and operator-run success do not add an apply command.

## Qualification still required

For an optional independently operated Collector gateway, use [offline gateway export](collector-gateway.md). It packages TLS/auth references and explicit resource enrichment, not a Collector workload or cluster credentials. The workflow runtime can also export directly to a backend; it never requires the gateway or Jarness. Review agent duplication and trace-ID routing before adding collection or tail sampling.

The selected-owner export-route record (source-checkout receipt `qualification/docker-export-routes.json`) exercises the installed CLI against a real Docker management owner and an actual PostgreSQL release-image receipt. It verifies the emitted ZIP inventory/checksums, release/runtime pin, non-root workload structure, Secret references, OTel pod fields, unchanged authoring run count and refusal of wrong options or image identity. The registry digest is fictional test data, never a publication claim; no cluster is contacted. This establishes the export route, not that applying its manifests will succeed.

The scoped Minikube trial qualifies admission, kubelet Secret staging, DNS/Calico, normal replacement and received signals only for its recorded local profile. Separately, source-checkout receipt `qualification/readable-decision-k3s-workflow.json` records nine live checks of an earlier pinned image on isolated Linux arm64 K3s v1.35.9+k3s1. K3s denied connections are joined to actual kube-router REJECT-counter increases and live allowed controls, not simply accepted as arbitrary errors. That trial retains two initial workflow startup exits and one pre-run fixture-client crash; it does not pass the original zero-restart profile or qualify this newly generated transport gate. Neither trial qualifies other architectures/distributions, production database provisioning, registry contents/publication, real hosted providers, production observability, forced termination, HA or scaling. Existing Docker results apply only to their exact runtime/image profile. Review the generated guide, validate against the intended cluster version, and request deployment separately.

The current database-transport runtime has separate renewed evidence, rather than inheriting that historical image's result. Source-checkout receipt `qualification/database-transport-cold-start.json` records an actual newly generated restricted init waiting while fresh PostgreSQL is deliberately delayed for25seconds; all three test pods become Ready with zero init/application restarts, followed by verified-TLS exact-runtime health. `qualification/database-transport-k3s-lifecycle.json` then records all nine live lifecycle checks on the same image: private staging, TLS/authentication, witnessed ingress/egress isolation, one retained-ID synthetic approval, normal replacement without replay and received Collector traces/metrics/logs. All five final pods pass the original unchanged zero-restart predicate. Saved verification joins two linked run segments and three node attempts across both actual pod UIDs, and all15 original evidence tests pass, including14 mutation refusals. This is a single-node Linuxarm64 K3s v1.35.9+k3s1 test profile—not an apply command, generic platform promise, production/HA/forced-loss qualification, backend-dashboard review or proof of complete HTTP accounting. These private source-checkout receipts are not shipped deployment credentials or installed downloads.

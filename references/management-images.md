# Jevable workflow runtime management images

Use a management image for authoring, project review, tests, provider configuration and repeated execution through the full CLI/API. For a single immutable workflow with a restricted execution API, use a [release image](images.md). Neither runs a skill, authoring conversation, desktop app or Jarness process. Local CLI/SDK execution requires no Docker.

## Build and save

Review the management SHA-256 from `runtime export` (the `runtimes` entry with `role: management`). Building must match this installed program hash; it never accepts an arbitrary ZIP or source directory.

```sh
jevable runtime export --output management.zip
jevable runtime build-image \
  --runtime-sha256 <reviewed-management-bundle-sha256> \
  --base-image node@sha256:<trusted-cached-base-digest> \
  --platform linux/arm64 --docker-context <local-context> \
  --tag my-jevable-management:1.0.0 --output management-image.json
jevable runtime save-image management-image.json \
  --receipt-sha256 <receipt-file-sha256-from-build-output> \
  --output management-image.tar
```

The [local engine/base restrictions and failure rules](images.md#build-and-export) also apply here: explicit local Unix-socket Linux engine, context-named Buildx `docker` driver, trusted cached Node >=22.19 digest, no `ONBUILD`, fresh tag, no automatic pull/push/deployment. Build steps have no network, but BuildKit can resolve a base through a registry; this is not an air-gap guarantee. Accepted `linux/arm64` and `linux/amd64` options are not claims that both are qualified.

The fresh context contains only the standalone management program and owned Dockerfile/ignore file. It includes no user workflows, credentials, database, source checkout, `node_modules` or skill instructions. Dependency notices remain included. The image runs as `node` in `/app`, disables inherited health checks, uses SIGTERM, and defaults to `capabilities`: it prints metadata and exits rather than starting a server or workflow.

The distinct `jevable.ai/management-image-receipt` pins core version, three runtime hashes, program manifest, recipe, base, platform, engine, tag and immutable image ID. Release receipts cannot substitute for it; management receipts cannot be used for immutable-release export. The separate management Kubernetes exporter below accepts only a matching management receipt. Labels/checksums are consistency checks, not signatures or proof of trust.

Building refuses an existing receipt path; tag checks are not atomic against another publisher. Failure can leave a built image/tag without a receipt: inspect before retrying. Saving verifies the immutable ID before/after streaming, bounds the archive to 4 GB, and publishes atomically. Existing files and dangling symlinks require explicit `save-image --overwrite`. Loading/tagging the archive is a separate action; save does neither.

## Kubernetes management export

Use `runtime export-kubernetes` for the full management CLI/API on Kubernetes, rather than `releases export-kubernetes` for one immutable workflow. This initial profile uses PostgreSQL only; it does not install a database or expose the local HTML preview server.

```sh
jevable schemas show management-kubernetes-options --json
jevable runtime export-kubernetes \
  --image-receipt management-image.json --receipt-sha256 <reviewed-receipt-file-hash> \
  --options-file management-kubernetes.json --options-sha256 <reviewed-options-file-hash> \
  --output management-deployment.zip
```

Options use `storage: "postgres"` and `imageBinding: "operator-verified-management-and-platform"`. Supply the same explicit origin, Secret name, digest-pinned image, resources, termination grace and network peers described in [Kubernetes export](kubernetes.md). `asyncConcurrency` defaults to 8 (1–64). Telemetry, pod metadata, extra CA and shared PostgreSQL quota are explicit opt-ins. `reviewerDecisions: true` separately enables the restricted reviewer-grant decision route on this **management** service; omission or `false` leaves it disabled. Provision and deliver each exact-attempt grant independently, and allow only reviewed reviewer peers through the ingress policy. The owner token still has full management authority and must never be given to a reviewer. Caller grants, notification delivery and release-only webhooks are not enabled by this export profile.

Export compares the receipt's program manifest and three runtime hashes to the installed fixed management package. It creates five files, including an immutable scripts ConfigMap, one Recreate/non-root/read-only management pod, ClusterIP service and NetworkPolicy. The reviewer opt-in is pinned in deployment options and bundle manifest, and adds `--reviewer-decisions` only to the management container. Readiness checks fixed program file hashes, authenticated service TLS, management mode and database reachability without executing workflows; it does not prove a grant was issued or a decision accepted. The private staging step identifies the container as `management` in opt-in OTel pod metadata. There is no liveness restart, RBAC, service-account token, Ingress, Docker socket or SQLite fallback.

Before applying, independently verify the registry manifest's contents/platform, provision the namespace/Secret and a dedicated PostgreSQL schema/role, and review CNI enforcement and drain bounds. Local Docker image IDs are not necessarily registry manifest digests. One replica is not a distributed lease; never force replacement or share a live-owned journal. Readiness uses health/control credits when quota is enabled. No credential values, state or Collector are included. Export is offline packaging, **not a successful cluster deployment or production qualification**. Minikube/k3s testing remains a separately authorized isolated step.

## Independent jobs and state

Use the exact reviewed image ID and a dedicated fresh volume. Do not mount a home directory, checkout, Docker socket, desktop/harness state, or data currently owned by another process.

```sh
docker --context <local-context> volume create my-jevable-data
docker --context <local-context> run --rm --pull never \
  --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --mount type=volume,source=my-jevable-data,target=/data \
  sha256:<reviewed-image-id> capabilities
```

Stateful commands use `--data-dir /data/state`; the app-relative default is unsuitable for a read-only root filesystem. Provide workflow/input files through a narrowly scoped read-only mount or reviewed provisioning. Keep private files owned by the non-root image user. Commands are the full CLI (`projects create`, `tests run`, `run`), not the reduced release-app command set. Preserve run UUIDs and review generations across replacements; uncertain attempts must not be redispatched automatically.

Both backend programs are included. PostgreSQL still requires independently provisioned private `--database-file` configuration, verified TLS and single-owner namespace access; no SQLite fallback. A build or SQLite image check does not qualify PostgreSQL management execution.

## Explicit management service

Provision an independent token, certificate and key in protected storage matching the image's `node` UID (1000 on the tested base), with regular owner-only token/key files. `runtime token --output /data/token` in a network-disabled one-shot container creates a token; certificate issuance is an operator responsibility.

```sh
docker --context <local-context> run --detach --name my-jevable-management \
  --pull never --read-only --cap-drop ALL --security-opt no-new-privileges \
  --publish 127.0.0.1:8787:8787 \
  --mount type=volume,source=my-jevable-data,target=/data \
  sha256:<reviewed-image-id> runtime serve \
  --data-dir /data/state --token-file /data/token \
  --port 8787 --bind-address 0.0.0.0 --public-origin https://127.0.0.1:8787 \
  --tls-cert-file /data/server.crt --tls-key-file /data/server.key
```

The certificate must cover the public origin. Host clients use separate private token files and explicit CA trust when needed, never disabled TLS verification. Use `runtime status`/`runtime request` while the service owns storage. Each management token holder has owner authority, including approval and private/provider access; this is not multi-user authorization.

Default HTTP is container-internal loopback, unreachable merely by adding port publication. Omitting `127.0.0.1` changes exposure and is not authorized by a build request. Await successful drain before replacing the selected owner; forced Docker timeout/SIGKILL requires separate uncertain-effect analysis. There is no proxy trust, automatic stale-owner repair or public ingress setup.

Provider/OTLP destinations must be configured for container networking; container loopback is not the host. Provision their credentials independently. The management-image fixture uses deterministic workflows and does not qualify external model/collector connectivity or actual browser behavior.

## Qualification boundary

Run `npm run test:management:images -- --installed <independent-package> --docker-context <context> --base-image <cached-digest> --platform linux/arm64` for real-engine checks. The report pins the image/platform and records non-root jobs, HTTPS authoring, saved tests, archive reload, persisted approvals, state-free management re-export and workflow-release export. Only fresh private fixtures are used; completed test containers are removed, while images, private volumes and artifacts are retained.

This record qualifies image packaging and an operator-provisioned service profile. The explicit [Docker owner commands](docker-owner.md) provide separate SQLite and explicitly configured PostgreSQL startup/readiness/shutdown paths, including selected-owner import/release metadata operations and host-side packaging. The PostgreSQL owner record (source-checkout receipt `qualification/docker-owner-postgres.json`) additionally covers the installed management image, database TLS/exclusion, preview protocol, retained approvals and separate-container HTTP/protobuf/gRPC telemetry. Actual HTML browser behavior, other platforms, production model/database/collector operations, forced in-flight termination and Kubernetes remain open. Apply each receipt only to its recorded runtime hashes and profile.

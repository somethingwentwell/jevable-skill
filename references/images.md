# Workflow release images

Use this after saving and reviewing an immutable [release](releases.md). Image packaging delivers the **Jevable workflow runtime** plus the pinned workflow as CLI jobs or an explicitly started HTTP/HTTPS service. It does not deploy the authoring skill, Jarness, a browser UI or a management API. Local SDK/CLI execution still needs no Docker.

## Build and export

Choose an explicit local Docker context, target platform, compatible trusted Node >=22.19 base pinned by digest, and unused image tag. The base must already exist in that engine. The current builder accepts a Linux engine reached through a local Unix socket with its context-named `docker` Buildx driver; remote/container builders and Windows socket contexts are unsupported. `linux/arm64` and `linux/amd64` are accepted targets, not a claim that both have been qualified.

```sh
jevable releases build-image <release-id> \
  --release-sha256 <reviewed-release-sha256> \
  --base-image node@sha256:<trusted-compatible-base-digest> \
  --platform linux/arm64 --docker-context <local-context> \
  --tag my-workflow:1.0.0 --output image-receipt.json --data-dir .jevable

jevable releases save-image image-receipt.json \
  --receipt-sha256 <receipt-file-sha256-from-build-output> \
  --output my-workflow-image.tar
```

The build receipt pins release/source/runtime identities, base digest, manifest checksum, platform, engine version, tag and inspected immutable image ID. Building never executes the workflow. The archive receipt includes byte count and SHA-256; saving streams by immutable ID, not the mutable tag. Default publication refuses existing files, including dangling symlinks; `save-image --overwrite` explicitly replaces the destination atomically. The archive limit is 4 GB.

### Release stored in a Docker authoring owner

`releases build-image` can replace `--data-dir` with the complete [selected-owner flags](docker-owner.md#author-test-and-run-through-the-selected-owner). The CLI obtains and validates the immutable release over the owner's instance-pinned HTTPS API, then builds on the host using its separately specified `--docker-context`. The host must contain the exact saved runtime bytes. It never asks the management container to build an image, mounts a Docker socket there, or copies its database/credentials. Packaging errors never fall back to another release or local project store.

`releases save-image` remains receipt-based: it does not accept runtime owner flags or need a running authoring owner. Its reviewed receipt identifies the local engine and immutable image. Exporting an image is independent of executing it; initialize the exported workflow runtime with its own state and configuration.

The build context contains only the twelve release-package files. Authoring state, credentials, input/output history and the checkout are not mounted or enumerated. Build steps use no network, but BuildKit may contact a registry to resolve the pinned base: this is not an air-gapped build guarantee. A digest ensures identity, not that the selected base is trustworthy. Base images with `ONBUILD` instructions are rejected. No automatic pull command, registry push, image replacement or deployment is performed.

Existing tags are checked before build and again before tagging. Docker does not provide atomic compare-and-swap tagging here: do not concurrently publish to the same tag through another client. Timeout or error may leave a built image or tag; inspect local state before retrying. `image-receipt-write-failed` means the build/tag may have succeeded without receipt publication. Do not automatically delete images or repeat a build to hide that failure. Raw daemon error output is deliberately excluded from normal receipts.

### Inspect an interrupted or failed build

Once packaging starts, the core records a private `build-observation.json` outside the image's COPY allowlist. It records the selected engine context, platform, base and requested tag, current phase and exact owned input hashes—not raw daemon output or credentials. Build failures include a `build.directory` recovery location in the SDK error and CLI JSON error response. A successful build removes its temporary directory as before.

Uncertain build/tag failures retain their owned packaging files, image-ID file and Buildx metadata if produced. A builder that returned successfully followed by an image-verification refusal removes only the COPY staging directory, retaining the input hashes and result metadata. `contextFiles` records that distinction. None of these failure observations is a successful image receipt, a proof that BuildKit stopped, or permission to retry.

Inspect the retained directory and the explicitly selected engine's build history before taking another action. If a launcher was forcibly terminated, its checkpoint may still say `in-progress` and no final error response may exist. The original Buildx job may still be active. Do not start another build, delete recovery files/images, or assume that a missing CLI process means the daemon-side job has ended. Recovery retention is local; this does not replace production OpenTelemetry collection or a durable build-job controller.

Build identity is read from [Buildx result metadata](https://docs.docker.com/reference/cli/docker/buildx/build/#write-build-result-metadata-to-a-file---metadata-file), then verified through the local engine. Config-ID and manifest-ID stores differ; receipts retain the actual inspected immutable ID.

## Images built from evidence-bearing ZIPs

This is distinct from `releases build-image`, which stays evidence-free. An explicitly exported [release ZIP v2](releases.md#attach-selected-runtest-evidence) includes its reviewed `evidence.zip` in the shipped Dockerfile's COPY allowlist. Building that Dockerfile includes the evidence in the image and any saved archive—even private inputs, outputs, test data or inline secrets. Review that disclosure before sharing; exporting the ZIP does not authorize a build or publication. Evidence remains review material, never a database restore or an approval grant.

`scripts/check-release-evidence-images.mjs` builds the actual shipped Dockerfile and `.dockerignore` through the installed package's shared local build transport, without replacing them with a test Dockerfile. Its four Linux arm64 cases cover SQLite/PostgreSQL × echo/approval, metadata-only/private attachments, exact `/app` file hashes, exclusion of unrelated context canaries, non-root/read-only execution, startup refusal for altered evidence, fresh state under historical run IDs, explicit fresh approval and image-save/reload. SQLite jobs have networking disabled; PostgreSQL uses a private verified-TLS database. No skill, Jarness, harness or checkout is mounted into these applications.

The 16 attached-image checks and refreshed ordinary release profiles (17 SQLite and 18 PostgreSQL checks) are recorded with exact runtime/image/archive hashes in `qualification/release-evidence-images.json`. The ordinary PostgreSQL profile also checks HTTPS replacement, model execution, graceful drain and OTLP signals against local fixtures. Those ordinary-image service checks do not qualify evidence-bearing HTTP/Compose lifecycle, managed authoring images, other platforms or Kubernetes. These are development fixture results, not a production deployment guarantee.

## Run independently with SQLite

Inspect `image-receipt.json`, then substitute its exact image ID below. Use a fresh dedicated named volume and an explicit `/data` directory. The image runs as `node`; `/data` is prepared for that user. The default app-relative data directory is not suitable for a read-only root filesystem. Inputs must be readable by the container's non-root user; do not loosen permissions on credential files to make an input example work.

```sh
docker --context <local-context> volume create my-workflow-data
docker --context <local-context> run --rm --pull never \
  --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --mount type=volume,source=my-workflow-data,target=/data \
  --mount type=bind,source=<absolute-input-json>,target=/input.json,readonly \
  sha256:<reviewed-image-id> \
  run --input /input.json --id <retained-run-uuid> --data-dir /data
```

This model-free example deliberately has no network access. AI workflows require separately reviewed provider networking and credentials; no originating credentials are bundled. Do not mount a home directory, harness checkout, live local authoring database or Docker socket.

The default job exits when completed or waiting. It does not start a background HTTP server. Reusing the same volume permits `show`, `events`, `review` and an explicitly authorized `decide` in a new container; see the release command/exit-code contract. Retain the UUID before dispatch, and reuse it after an uncertain client response instead of creating a new run. Container replacement does not itself authorize approval or replay uncertain effects. Abrupt termination can leave an owner lock requiring explicit recovery inspection.

The same image also contains the [exact-release HTTP service](releases.md#serve-the-exported-app). Without TLS flags, `serve` binds to **container-internal** `127.0.0.1`; an in-container `status`/`request` client can use it. Generate the token independently in the private data volume using the image's `token --output` command, and keep its file owner consistent with the non-root runtime user. No token is baked into an exported image. The server owns the volume until SIGTERM drain finishes; use its API rather than a second direct runtime. Port mapping alone does not make this internal loopback listener reachable.

## Run independently with PostgreSQL

Create the release with `--runtime-storage postgres` before building its image; [release backend selection](releases.md#select-the-runtime-backend) is immutable and independent of authoring storage. A PostgreSQL app does not accept `--data-dir` or silently create SQLite state. Every stateful command requires `--database-file`; `info`, `token`, `status` and `request` do not open a database.

Provision a fresh, authorized PostgreSQL namespace and database role separately. Do not point the app at another application's database. Mount an owner-only regular database JSON file from a dedicated private configuration volume, read-only in the app, with ownership matching the image's `node` user (UID 1000 on the tested base). The containing private directory should be mode `0700`, files `0600`. Its explicit host/port/database/user/password/namespace/initialize/TLS fields follow [PostgreSQL configuration](postgres.md). Use `tls.mode: verify-full` and an explicit private CA when needed; the configured DNS name must match the server certificate. Container loopback is not the host or another database container. `loopback-test` is not a deployment shortcut.

For an explicitly authorized job on a network that can reach that database:

```sh
docker --context <local-context> run --rm --pull never \
  --network <reviewed-database-network> --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  --mount type=volume,source=<private-config-volume>,target=/config,readonly \
  --mount type=bind,source=<absolute-input-json>,target=/input.json,readonly \
  sha256:<reviewed-postgres-image-id> \
  run --input /input.json --id <retained-run-uuid> --database-file /config/database.json
```

Database records, approvals, controls and evidence persist across replacement containers without a SQLite volume. If writing evidence files, mount a separate private writable output volume; keep the configuration mount read-only. Provider secrets are provisioned independently through the runtime credential commands using protected files, never image layers, environment values or workflow source. One active owner holds the namespace: use its API while serving, then wait for final successful drain before replacing it. No automatic reconnect, uncertain redispatch or distributed lease is implied.

For persistent HTTPS, use the same explicit token/certificate/origin flags in the next section, replacing `--data-dir /data` with `--database-file /config/database.json`. Mount token/key/certificate files separately in the private configuration volume. Bind deliberately inside the container and publish only the intended host interface; host-local access uses `127.0.0.1:<host-port>:<container-port>`. A successful image build never opens listeners, provisions a database or authorizes public ingress.

The PostgreSQL image check (`npm run test:postgres:images -- --installed <isolated-package> --docker-context <context> --base-image node@sha256:<digest> --postgres-image postgres@sha256:<digest> --platform linux/arm64`) creates only fresh local fixtures from cached images. Its receipt records exact image/runtime identities. It tests echo, approvals and a model workflow on a dedicated Docker bridge: a TLS-only PostgreSQL server with no host-published database port, read-only non-root configuration, host-loopback HTTPS, retained controls across replacement, own-image archive unload/reload, and SIGTERM drain through model completion and all three OTLP signals. Wrong CA and a same-address/wrong-hostname alias are refused even with an insecure ambient Node TLS setting. Never set that insecure variable in real use.

When the local Docker engine's default bridge-address pool is exhausted, the development checker accepts `--network-subnet <explicitly-reviewed-unused-private-CIDR>` for its own temporary bridge; inspect existing Docker networks and host routing before selecting it. This changes only the isolated test fixture, not a workflow image or Kubernetes export. A recorded earlier 821-file installed artifact on Engine 29.4.1/Linux arm64 passed all 19 local PostgreSQL image checks. Its immutable image/archive identities are retained in the source checkout's private qualification report, not bundled with the published skill; the current rebuilt package has **not** repeated this image check and cannot inherit it.

The model/collector fixture shares the app's network namespace and listens on loopback; this proves container execution/export, not networking to an external hosted model or collector. The bridge is dedicated, not air-gapped. Qualification uses a generated test certificate and a fixture superuser, not production least-privilege roles, PKI rotation, migrations, backup/restore, multi-replica fencing, forced in-flight termination or Kubernetes. The PostgreSQL and SQLite image reports are separate; do not transfer qualification between their runtime hashes.

## Recover a saved response in a replacement container

Use the exact reviewed release image and its original state/configuration. First confirm the prior owner has exited; a timeout or lost client connection is not that confirmation. While a service still owns the state, use its authenticated API instead of opening a competing job.

Run `show <retained-run-uuid>` with the same backend flags to inspect the checkpoint. If a model response was committed but its node result was not, an explicitly authorized job can use:

```sh
docker --context <local-context> run --rm --pull never \
  --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  --mount type=volume,source=<original-private-state-volume>,target=/data \
  sha256:<reviewed-sqlite-image-id> \
  recover <retained-run-uuid> --data-dir /data \
  --request-id <retained-recovery-uuid> --checkpoint-sha256 <reviewed-checkpoint-hash>
```

For PostgreSQL, use the reviewed database network and private read-only configuration mount from the previous section, select its exact PostgreSQL image, and replace `--data-dir /data` with `--database-file /config/database.json`. Recovery needs database access, not model access. If telemetry is enabled, its exporter separately needs its authorized destination. Do not configure fallback networking or credentials to make recovery dispatch a new model request.

Recovery verifies retained response evidence and settles that attempt only. A paused result (exit 3) still requires a separately authorized guarded `continue` or `step`; a Human Approval still needs an explicit decision. Reusing the identical recovery request only reads current state. If recovery admission was saved but node settlement failed, that retry can return `executing` (exit 5); inspect the new checkpoint before authorizing another recovery UUID. Never automate new UUIDs to conceal uncertainty.

If the response itself was never committed, recovery refuses it without another provider call. Cancellation preserves the unresolved attempt and does not undo any external effect. This command does not repair a stale SQLite lock, reconnect a lost database owner or establish whether an unknown provider request succeeded. See [recovery semantics](control.md#recover-an-already-saved-model-response).

The opt-in `scripts/check-recovery-images.mjs` development check uses independently installed release images, private fixture volumes, cached base images and real database transaction refusals. It covers Jev/Laya on SQLite/PostgreSQL, explicit recovery and approval across jobs, linked OTLP signals and image archive reload. Its exact receipt, when present, is in `qualification/recovery-images.json`. Transaction refusal is not forced process termination or lost COMMIT acknowledgement qualification; release jobs do not qualify management owners, HTTP service recovery, browsers, real hosted providers or Kubernetes.

## Serve HTTPS to the local host

The direct HTTPS profile supports an explicit container bind address and an independently pinned public origin. For a local Docker host, publish only `127.0.0.1:<host-port>:<container-port>`; omitting the host IP changes the exposure. Docker documents the host-loopback publication boundary in its [port-publishing guide](https://docs.docker.com/engine/network/port-publishing/). Our real-engine check covers Docker Desktop 4.71.0 / Engine 29.4.1 on macOS arm64 with Linux arm64 containers, not every network environment or older engine.

Before starting, provision a fresh private volume with a separate service token, a valid certificate chain covering the public hostname/IP, and its matching private key. In the example below these are `/data/service-token`, `/data/server.crt`, and `/data/server.key`. The token/key must be owned by the image's `node` user (UID 1000 on the qualified base), mode `0600`, and regular non-symlink files. The runtime refuses an exposed or wrong-owner key; do not weaken permissions to accommodate host UID differences.

Use the bundled `token --output /data/service-token` in a network-disabled one-shot container mounting that volume to create the token. Provision the certificate/key through your reviewed secret-management process or an explicit non-root initialization step. The qualification uses bounded stdin to a one-shot `node` process, exclusive file creation and mode `0600`; no secret bytes enter command arguments, image layers or logs. This is an operator-provisioned service, not automatic certificate issuance or a managed Docker launcher. The host client separately needs its protected token file and, for private PKI, the selected CA certificate—not the server private key.

```sh
docker --context <local-context> run --detach --name my-workflow-service \
  --pull never --network bridge --read-only --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 128 --memory 512m \
  --publish 127.0.0.1:8443:8787/tcp \
  --mount type=volume,source=my-workflow-data,target=/data \
  sha256:<reviewed-image-id> serve --data-dir /data \
  --token-file /data/service-token --port 8787 \
  --public-origin https://127.0.0.1:8443 --bind-address 0.0.0.0 \
  --tls-cert-file /data/server.crt --tls-key-file /data/server.key
```

Here `0.0.0.0` is inside the container; the explicit Docker publication is host loopback. Inspect the created container's exact image ID, non-root user, mounts and `HostConfig.PortBindings` before using it. Check its readiness receipt; internal port 8787 and accepted public origin port 8443 are intentionally different. Connect through the [bundled release client](releases.md#serve-the-exported-app) or the installed SDK with explicit CA trust:

```sh
node app.mjs status --endpoint https://127.0.0.1:8443 --token-file /private/client-token --ca-file /private/selected-ca.pem
node app.mjs request /private/operation.json --endpoint https://127.0.0.1:8443 --token-file /private/client-token --ca-file /private/selected-ca.pem
```

The host's `app.mjs` must be from the same reviewed release. Omit `--ca-file` only when the certificate is already trusted by Node's configured trust store. Never disable verification. Certificate validation, bearer authorization, exact release hash, Host/Origin and protocol checks still apply. Forwarded proxy identity headers are rejected; this is not a TLS-terminating proxy or multi-user authentication design. Each token holder has approval/private-inspection authority for the release.

Send SIGTERM to the exact owned container, then inspect/wait for its confirmed successful exit before removing it. A draining service retains storage ownership; a timeout is not permission to force-kill or start a replacement against the same volume. After clean exit, a replacement using the same image, volume and TLS configuration can inspect retained runs and approvals. It never automatically approves or repeats uncertain work. Keep the volume, original image/archive and configuration for recovery. No public interface, registry push, model-provider networking or Kubernetes deployment is implied by this local profile.

## Transfer the image

Verify the `.tar` SHA-256 against a trusted receipt before loading executable content. Loading is an explicit operator action, not an untrusted-import API. Save-by-ID archives may be untagged; inspect the loaded immutable ID and release labels, then restore an unused reviewed tag explicitly.

```sh
docker --context <destination-context> image load --input my-workflow-image.tar
docker --context <destination-context> image inspect sha256:<reviewed-image-id>
docker --context <destination-context> image tag sha256:<reviewed-image-id> my-workflow:1.0.0
```

The destination must support the target platform. Registry publication, managed Docker authoring/testing, public-network/proxy ingress and Kubernetes deployment remain separate work.

## Qualification

The separate selected-owner route record (source-checkout receipt `qualification/docker-export-routes.json`) covers host builds from a Docker authoring owner, exact SQLite/PostgreSQL image archive save/unload/reload and independent SQLite execution after loading. It also checks wrong receipt hash and existing receipt refusal. It does not reuse another runtime's image qualification or claim PostgreSQL database execution from its metadata-only image check. The expanded owner suite passes 27 checks on the recorded local Linux arm64 engine profile.

The recorded real-engine pass covers an earlier exact image on Docker Engine 29.4.1/Linux arm64, using the cached Node 22.23.1 base. Deterministic and persisted-approval fixtures passed as CLI jobs, container-internal HTTP services and host-loopback-published HTTPS services. This is that image's exact-release execution qualification, not current-build or full Docker authoring acceptance. See the repository's `qualification/images.json` for exact identities and evidence paths.

`npm run test:images -- --installed <isolated-production-package-directory> --docker-context <local-context> --base-image <cached-digest-reference> --platform <linux-platform>` is an opt-in real-engine test. It builds echo/approval fixtures through the installed CLI, runs non-root network-disabled jobs with independent volumes, verifies retained identities across container replacement, saves/checksums each archive, unloads only its own image, loads it again and runs it. After reload it checks both container-internal HTTP and host-to-container HTTPS with a temporary, explicitly inspected `127.0.0.1` port binding. HTTPS requires test-only certificates generated by OpenSSL, non-root key provisioning via stdin and verified host SDK trust. Both services accept fresh requests, retain approvals across replacement and export evidence; HTTPS also checks guarded stepping, cancellation and rejection paths. Images, volumes, private fixture credentials, archives and receipts remain available for inspection. Ephemeral jobs use `--rm`; named services are removed only after confirmed successful SIGTERM exit, closing their published ports. Drain timeout leaves the exact container for inspection without forced kill. The check never publishes a public-interface port, pushes a registry image or deploys to a cluster.

Record the exact engine/base/platform and package integrity in `qualification/images.json` only after this test succeeds. Passing on one local engine is not qualification of all targets, model/telemetry networking, in-flight shutdown, Compose, public-network/proxy ingress or Kubernetes.

SDK users import `buildReleaseImage`, `saveReleaseImage`, `inspectImageReceipt` and their types from `@jevable/core/images`. Pass a reviewed saved release and `loadReleaseRuntime()` from the same installed distribution; the builder verifies exact bundled bytes. Imports do not contact Docker. The image service performs no hidden provider configuration or workflow execution.

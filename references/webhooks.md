# Signed events into a standalone workflow app

Use this when a reviewed sender needs **start-only** access to one immutable API-enabled release. The endpoint is off by default. It runs the **Jevable workflow runtime**, without an agent, desktop, Jarness or Docker dependency. A host embedding the SDK can verify and admit events without any HTTP server.

This is an explicit Standard Webhooks **v1 HMAC-SHA256** profile, not automatic compatibility with vendor-specific signatures or a new workflow Trigger family. The workflow Trigger must declare `api`. The entire JSON body becomes workflow input; its schema still applies. No sender-selected source, actor, run ID, release, approval or control options are extracted from it.

## Startup

Provision a separate random signing secret with the sender through a trusted channel. Use one key per endpoint/release/source relationship. Do not reuse the owner bearer, provider credentials or outgoing notification keys. The HTTP host refuses a signing key whose decoded bytes equal its owner bearer. Protect a JSON file containing exactly:

```json
{ "source": "orders/tenant-a", "keys": ["<canonical whsec_ signing secret>"] }
```

The example secret is illustrative, not valid configuration. `source` uses the [stable message namespace](release-messages.md); select and retain it before dispatch. Keys are canonical standard base64, prefixed `whsec_`, decoding to 24–64 bytes. One to four distinct keys support a reviewed rotation overlap. The regular non-symlink file is bounded to 4096 bytes; POSIX ownership and mode must be private (normally `0600`). No environment discovery, key download, secret display or automatic rotation occurs.

`help runtime serve --json` exposes this consuming structural schema in `startupContracts` under `release-webhooks`, without opening the file. Key canonicalization, uniqueness, private permissions and release/capacity guards remain semantic startup checks; a JSON-schema pass alone is not admission.

For a newly exported, independently runnable app:

```sh
node app.mjs serve --token-file /private/owner-token \
  --webhooks-file /private/webhooks.json --async-concurrency 2 \
  --data-dir /private/workflow-state
```

For a PostgreSQL app, replace `--data-dir` with its explicitly provisioned private `--database-file`; startup never provisions a database or falls back. Existing exported programs do not acquire this feature automatically. For the core CLI, additionally supply the reviewed bare `--release-file` and matching `--release-sha256` to `runtime serve` or `runtime start --runtime local`. Management/preview startup without an exact release refuses. Missing explicit async capacity refuses before ownership. The normal owner token remains necessary for private observation/controls, but is **not** sent by webhook producers.

This command binds loopback by default. For authorized remote exposure configure the existing [direct HTTPS profile](http.md#explicit-direct-https), origin and bind address; HMAC authenticates bytes but does not encrypt them. No tunnel, proxy trust, public deployment, browser launch, scheduler or managed Docker secret staging is created. Container operators may explicitly mount private configuration and launch the exported workflow runtime themselves; new container/Kubernetes/public ingress qualification remains separate.

## Signed POST contract

`POST /v1/webhooks`, `Content-Type: application/json`, uncompressed raw UTF-8 body up to 1,000,000 bytes (or the host's smaller request limit). JSON depth/value limits and runtime input policy also apply.

| Header | Required value |
| --- | --- |
| `webhook-id` | Retained message ID: 1–256 printable ASCII characters, no spaces or `.`; exact case, no normalization |
| `webhook-timestamp` | Canonical nonnegative integer Unix seconds for this delivery attempt, within ±300 seconds of host time |
| `webhook-signature` | One to eight space-separated `v1,<canonical base64 HMAC>` values; each signature decodes to 32 bytes |

Sign `id + "." + timestamp + "." + rawBody` using HMAC-SHA256 with the decoded key bytes. Verify the bytes before parsing; JSON reserialization changes a signature. Unsupported algorithms, malformed signatures and stale/future timestamps refuse. The profile follows the [Standard Webhooks signature specification](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md), with the bounded v1-only acceptance above.

Existing Host, Origin, cross-site, proxy, path, connection and request bounds remain enforced. Duplicate sensitive/signature headers refuse. Owner Authorization, Jevable protocol/instance/release headers and incoming traceparent/baggage are refused on this route: a sender never becomes an owner or chooses execution ancestry. The host assigns the release/source and roots any enabled request trace. No credential or message ID is added to metric labels.

After acknowledged durable creation the endpoint returns `202`; an identical retained submission returns `200`. Both use the existing metadata-only `jevable.ai/async-run` receipt and relative `Location: /v1/async-runs/{id}`. They exclude source, input/output, actors, private node values, signatures and keys. `202` acknowledges a durable checkpoint, **not workflow completion**. Its initial `paused` snapshot can already have advanced. Approval waits stay waiting.

Location observation requires the separate owner bearer, current instance/protocol and release-hash guard. Signing-key possession grants neither reads nor approval, cancellation, continuation, credential setup or authoring. `401 webhook-unauthorized` is sanitized; authenticated malformed JSON returns `400 invalid-command`. A conflict, active reservation, capacity/rate refusal, transport error or lost response is not rollback proof.

## Recovery, capacity and tracing

The run UUID comes from the existing [release/source/message tuple](release-messages.md#identity-and-recovery), not timestamp, signature, key or process instance. Retain it **before** dispatch using `releaseMessageRunId` or the offline `releases message-id` command. The signed-wire ID has the additional no-dot restriction.

Identical logical input under the same tuple observes retained state; changed input conflicts. Signed whitespace/key-order differences can represent the same logical JSON input. A different release or sender namespace intentionally creates a different run: retargeting is new execution authority, not recovery. A creation acknowledgement can be lost after commit; an original safe checkpoint stays paused, an unsettled intent stays uncertain. Never fabricate success, mint another message/run identity or automatically resume it. Re-signing a deliberate redelivery with a current timestamp does not change its stable ID or authorize further business effects.

Webhook and owner async starts share the explicitly bounded slots, including pending admission and post-response completion. No queue or automatic retry is installed. Optional [instance-local rate policy](rate-limits.md) charges only authenticated webhook requests to ordinary credit; no owner control reserve is available. Shutdown seals admission and drains original completion promises before key cleanup and owner release. Client disconnect never cancels work. Normal signal/drain handling belongs to the embedding application or bundled launcher.

Enabled OTel uses the fixed `/v1/webhooks` route label and the existing persisted release/run/node/attempt evidence. HTTP receipt, execution completion and exporter delivery are separate observations; no trace header overrides come from the sender. Default telemetry remains disabled, and exporters never retry execution.

## Server-free SDK

`@jevable/core/releases` exports `SignedWebhookVerifier`, `SignedReleaseWebhookSession`, `releaseWebhookConfigSchema`, `WEBHOOK_LIMITS` and `WebhookAuthenticationError`.

```js
const intake = new SignedReleaseWebhookSession(runtime, reviewedSnapshot, privateConfig);
const retainedId = intake.runId(reviewedMessageId); // Offline derivation, not authentication.
const admitted = await intake.start({ id, timestamp, signature, body: rawBytes });
const checkpoint = await admitted.completion; // May be waiting, paused or uncertain.
intake.close(); // Disables authentication and clears owned key buffers; does not close runtime.
```

The host must retain/admit bounded work, acknowledge the external transport deliberately and drain completion before closing storage. SDK results include private owner data; only the HTTP adapter projects metadata. Key buffers are cleared on verifier/session close; JavaScript strings and externally held configuration copies cannot be promised securely erased. The standalone verifier does not open storage or dispatch. The session verifies first, then reuses `ReleaseMessageSession`; neither import starts a listener.

Source tests use private SQLite owners, synthetic models and loopback requests. They cover signature/rotation/refusals, input bounds, exact scope, loss, retained waits and shared drain. Source PostgreSQL startup admission is not real database execution. Installed/extracted-app, received OTel, container, Kubernetes, public ingress, all-platform and real sender/provider qualification are separate evidence gates. Signed approval links and distributed quotas are **not** implemented by this start-only intake.

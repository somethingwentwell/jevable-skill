# HTTP request-rate policy

Use this only when the user requests a request-rate limit on an explicitly owned HTTP service. Direct SDK/CLI jobs remain server-free and are not throttled. Rate limits are disabled by default; never infer a policy from account, workflow, provider or agent settings.

## Configure instance-local limits at startup

Provide this strict JSON shape in a bounded regular UTF-8 file (maximum 4096 bytes):

```json
{
  "requests": { "capacity": 30, "refillTokens": 10, "refillIntervalMs": 1000 },
  "controls": { "capacity": 10, "refillTokens": 5, "refillIntervalMs": 1000 }
}
```

Review values for the expected load. Each bucket starts with `capacity` credits, refills continuously at `refillTokens / refillIntervalMs`, and never accumulates beyond capacity. Capacity and refillTokens are integers 1–10000; refillIntervalMs is an integer 1000–3600000. Both buckets and all fields are required; unknown fields are refused. The file contains policy, not credentials; do not embed secrets or target identities.

```sh
node bin/jevable.mjs runtime serve --token-file /private/service-token \
  --data-dir /private/workflow-state --rate-limits-file reviewed-rate-policy.json
```

Foreground `runtime start --runtime local` accepts the same flag. For PostgreSQL, explicitly select `--storage postgres --database-file <private-file>` instead of `--data-dir`. Independent exported applications accept `node app.mjs serve --token-file <private-file> --rate-limits-file <policy-file>`; they use the bundled Jevable workflow runtime, not the authoring skill. Existing exported bundles do not gain new behavior automatically.

SDK `startRuntimeService`, `startPostgresRuntimeService` and `startPreviewGateway` accept `rateLimits` with this shape. `HttpRateLimits` is exported from `@jevable/core/http`. Validation and policy cloning precede transport/storage startup. Individual requests, ordinary commands, portable HTML and CLI preview startup do not accept this flag.

For explicitly reviewed Docker startup, add `--rate-limits-file /private/rate-policy.json` to the [owned service startup](docker-owner.md#optional-http-request-rate-policy), or SDK `startDockerOwner({..., rateLimitsFile})`. This profile additionally requires a regular owner-only, non-symlink file. It stages validated canonical JSON in the read-only configuration volume and pins its checksum in the private owner record. Restart reuses staged bytes without rereading the host file or accepting policy overrides. Select an image built with this feature; older images are not silently upgraded and a missing/mismatched advertised policy never proves readiness. Container operators can also use the exported app's explicit serve command. Actual rate-policy container/image and deployment qualification remain separate from source lifecycle tests.

## Shared admission and control reserve

One pair of buckets is shared by every connection to one runtime HTTP instance, independent of IP, bearer string or claimed actor. Credit debit is synchronous before dispatch; simultaneous requests cannot each claim the last credit. A monotonic clock supplies refill time. No unbounded identity map, background timer, queue, durable policy store or scheduler is created.

The ordinary bucket covers every admitted POST, including owner operations, preview bootstrap/logout/operations, async admission, reviewer/caller operations and one initial caller SSE request. Continued reads inside an already admitted bounded SSE connection are not independently debited. Parsed requests rejected later by schema/action policy still consume credit; failures, cancellations, response loss and idempotent observations do not refund it. Transport authentication/protocol/instance refusals precede debit. Delegated token syntax is not live grant authority: a syntactically valid invalid/revoked grant can consume ordinary credit, but never control reserve. This is not a brute-force/unauthenticated socket firewall.

Only authenticated owner/scoped-preview requests can use the independently bounded control bucket:

- Owner `runs.show`, `runs.cancel`, `notifications.abort` and `runs.advance` with `mode: pause`.
- Scoped preview `show`, `cancel` and `advance` with `mode: pause`.
- Owner health GET and instance/release-pinned async metadata GET.

Classification never grants authority or skips command, scope, attempt, release, checkpoint or actor validation. Continue, Step, recovery, test execution and approval decisions use ordinary credit; delegates cannot access reserve. The existing concurrency control slot remains separate: health GET can still be refused when concurrency is full; the reserved POST status/pause/cancel slot is unchanged.

Credential-free static HTML and authenticated capability discovery are exempt and execute no workflow. Existing body/header/connection/concurrency limits still apply. Rate limiting occurs after bounded POST-body parsing; it does not replace those controls.

## Refusal and recovery

An exhausted bucket returns HTTP `429`, code `rate-limit`, `execution: not-dispatched`, `retryAfterSeconds`, `Cache-Control: no-store` and numeric `Retry-After`, following the [HTTP 429 standard](https://www.rfc-editor.org/rfc/rfc6585#section-4). Typed clients expose bounded canonical delta seconds as `RuntimeHttpError.retryAfterSeconds` for this error only. They never wait or automatically retry; date-form, ambiguous and out-of-profile headers are not adopted as instructions.

Inspect retained state and preserve the original mutation identity after uncertainty. A confirmed rate refusal did not dispatch that request, but cannot prove a previous request with the same identity never committed. Waiting for credit is not permission to resume, approve or create a replacement UUID. Control reserve is also bounded; if exhausted, use an explicit later read, never a forced kill or lock removal.

For `rateLimits`, capabilities describe the immutable policy, algorithm and instance scope, not live balance, account usage or durable audit. Explicit replacement resets local credit and creates a new instance; old instance guards still refuse. Do not restart an owner to evade limits. Docker readiness verifies policy identity before reading health and returns unproven readiness plus the bounded hint if health is rate-refused; it does not poll that refusal automatically. Separate local policies, SDK jobs and replicas do not share credit. The explicit SDK coordinator boundary below is different; built-in cluster coordination, account/provider quotas, public ingress, actual browser and deployed PostgreSQL/container qualification remain separate gates.

## Explicit coordinated admission for trusted SDK hosts

The current source adds `coordinatedRateLimits` to `startRuntimeService`, `startPostgresRuntimeService` and `startPreviewGateway`. It is an SDK embedding boundary; the separately selected [PostgreSQL coordinator](postgres-rate-limits.md) supplies a shared backend. Local `runtime serve`/`runtime start` and capable exported apps can explicitly attach through their protected `--rate-coordinator-file` with `initialize:false`, mutually exclusive with local policy. The PostgreSQL [Kubernetes exporter](kubernetes.md#optional-shared-http-quota) additionally supports explicit `rateCoordinator:true` to stage this attach-only file; it adds no automatic egress or quota provisioning. These configuration capabilities are not live shared-quota Docker/Kubernetes or production distributed-service qualification. Earlier installed packages and exported programs do not acquire new behavior automatically; a new build and artifact qualification are required. No desktop, harness, discovery service or implicit backend is introduced.

Choose either `rateLimits` **or** `coordinatedRateLimits`; supplying both is refused before transport/storage ownership. The latter has exactly four fields:

- `scope`: the reviewed shared UUID, independent of each HTTP instance UUID.
- `policy`: the same strict request/control bucket policy above.
- `timeoutMs`: an integer 100–5000, bounding the HTTP admission wait.
- `consume(request, signal)`: an explicitly supplied trusted function returning a receipt asynchronously. The embedding host owns its authentication, transport, lifecycle and shared state.

Types `CoordinatedHttpRateLimits`, `HttpRateDebit`, `HttpRateDebitReceipt` and `HttpRateLane` are exported from `@jevable/core/http`. Startup pins scope, policy, deadline and function before opening the runtime. Each debit carries only a fresh HTTP-attempt `requestId`, `scope`, canonical `policySha256`, `lane` (`requests` or `controls`) and a detached `policy`. It does not contain a bearer, actor, workflow input, run UUID, model setting or execution permission. Attempt IDs are not workflow mutation identities.

The host adapter must perform an atomic shared token-bucket debit, using authoritative shared time and an immutable scope/policy binding. It must reject policy conflicts rather than silently resetting quota. Admission is not a permission grant: all existing authentication, instance/protocol, action, release, grant and checkpoint guards still apply, and delegates still cannot access owner reserve. Do not dispatch workflows inside the adapter or refund failed operations. A service replacement must continue the same coordinator state if continued shared quota is required; the HTTP server neither initializes nor attests durable state.

Return exactly the request's `requestId`, `scope`, `policySha256` and `lane`, plus `admitted: true`, or `admitted: false` with integer `retryAfterSeconds` 1–3600. Unknown fields, wrong identities, mismatched policy/lane and malformed results are refused. Only a validated denial returns the ordinary 429 response. Adapter exceptions—even a thrown rate-limit error—produce sanitized HTTP 503 `rate-coordinator-unavailable`, `execution: not-dispatched`, `quota: uncertain; no-retry-or-refund`, without adopting upstream messages or `Retry-After`.

A timeout aborts the supplied signal and ends admission without dispatch, local fallback, automatic retry or refund. A late reply cannot execute the request. The adapter may already have committed its debit: abort is not rollback. Beginning HTTP drain while a debit is pending also prevents subsequent workflow dispatch. Existing concurrency limits bound pending HTTP admission; no work queue is created. Receipt binding is not authentication of an untrusted backend or proof of durable/shared enforcement; protect the coordinator connection explicitly.

Capabilities expose the pinned policy, shared UUID/hash/deadline, `host-coordinated-token-bucket`, `explicit-shared-scope` and `coordinator-defined; not-attested` persistence. They expose neither balance nor credentials. The original boundary tests use an atomic **in-process test adapter** across independent SQLite HTTP owners; they are not database/distributed acceptance. The PostgreSQL implementation has separate scoped native evidence described in its reference. Deployed replicas, production quotas and remaining implementation/fault/observability gates stay separate.

## Observe quota admission without changing it

Use the protected telemetry startup configuration with `httpAccessDecisions:true` and explicit signal destinations. [Transport-admission diagnostics](http-access-telemetry.md) describe the four local/coordinated request/control stages, fixed outcome labels and duration histogram. Add `httpRequests:true` for the owned HTTP request's link and ended-log context join. Sampling zero or logs-only operation still permits diagnostic log correlation; metrics contain no trace/span, scope, policy or debit UUID labels.

A validated denial is `refused`; coordinator exception, malformed receipt, timeout or drain before dispatch is `failed`, with fixed error detail only. Neither outcome proves backend rollback or authorizes retry/refund. An admitted quota check does not prove command authority, dispatch or commit. Enabling telemetry never selects/initializes a coordinator or changes limits. Source received-wire checks use local and in-process fixture adapters; current real PostgreSQL coordinator, installed/exported app and deployed Collector/backend qualification must be renewed separately for the changed runtime bytes.

# Standalone model connections

The built-in adapter supports OpenAI-compatible Chat Completions over HTTPS and loopback HTTP. It supports streamed text, non-streamed text, and the sole structured result collector `jevable_return_result`. It never executes provider-requested tools. Decision nodes can select `provider: llm` for that compatibility path, or opt into experimental [native System One execution](systemone.md) with an explicitly versioned output contract. The Chat Completions wire format follows the [official reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create). Compatibility with a particular hosted provider requires a real authorized test; local fixture tests are not that evidence.

## Configure without a desktop or harness

The setup below is for Chat Completions. Native connections use [System One setup](systemone.md#configure-and-run) instead, without chat generation settings. Never fabricate a confidence field for a native Noul result to fit the compatibility schema.

Copy `examples/provider.json` and replace the endpoint, provider name and allowed model ID with your selected provider's values. The ID `settings-default` is the default connection reference used by shared templates; it does not read any desktop settings. Choose `max_tokens` or `max_completion_tokens` to match that provider/model. Authentication is explicitly `bearer` with a credential reference, or `none` for a deliberately unauthenticated endpoint. Remote HTTP, URL credentials, query parameters, redirects and arbitrary workflow-owned custom endpoints are refused.

```sh
node bin/jevable.mjs providers set provider.json --expected-generation 0 --data-dir .jevable
node bin/jevable.mjs credentials set models/main --file /absolute/path/to/private-key-file --expected-generation 0 --data-dir .jevable
node bin/jevable.mjs providers list --data-dir .jevable
node bin/jevable.mjs credentials status models/main --data-dir .jevable
node bin/jevable.mjs templates render support-reply --provider my-provider --model your-model-id --output support.yaml
node bin/jevable.mjs check support.yaml --data-dir .jevable
```

The credential file must be a regular, non-symlink, owner-readable file with no group/other permissions on POSIX (normally 0600). Its content is the bearer value with at most one trailing newline. Alternatively, pipe a secret-manager output into `credentials set models/main --stdin --expected-generation 0`. Interactive TTY input is refused so the tool never echoes a typed secret. Never put the secret in CLI arguments, YAML, provider JSON, shell command text or chat. The value is stored in the protected runtime database, not encrypted by an OS keychain; the private data directory and host disk protection are part of its security model. The runtime database is not an export artifact.

Creation requires generation 0. Updates/rotation require the exact generation shown by `providers list` or `credentials status`; a stale request fails without replacing the record. `providers audit` shows the actor, reference and generation changed, never credential values. Changing configuration while this runtime instance is executing is refused. `check` is local and model-free: it validates the workflow against actual compiler limits, available connections, model allowlists, credentials and supported execution settings. It never claims the remote service is reachable or the credential is valid there.

After the user authorizes model usage, execute with `run support.yaml --input ticket.json --id <uuid> --data-dir .jevable`. Reuse the UUID to inspect the same execution after a lost reply. Creation/configuration/listing/checking alone do not send prompts or spend credits.

## Clear a local credential

Read `credentials status <ref>`, then explicitly run `credentials clear <ref> --expected-generation <active-generation> --data-dir <directory>`. SDK owners use `clearCredential(ref, expectedGeneration, actor)`; authenticated management clients use `credentials.clear` with `ref` and `expectedGeneration`, with actor fixed by the host. Exported apps expose the corresponding `credentials-clear` command. No secret file, stdin, credential value or provider request is involved in clearing.

Clearing requires a positive exact active generation and is refused while this owner has admitted work. It replaces the active value with secret-free metadata at the next generation and appends a metadata-only audit event. It does not remove the generation history or reset it to zero: stale writes remain refused. To restore access, separately provision a new value using the retained generation from status. Missing/already-cleared/stale credentials refuse without another mutation. After a lost reply inspect status and audit; do not automatically retry or infer which actor committed from status alone.

This is logical local clearing, not provider-side revocation, sign-out, cancellation or secure physical erasure. Database pages/WAL, PostgreSQL dead tuples, backups, admitted in-memory values and separate installations may retain an earlier secret. PostgreSQL batch receipts retain mutation metadata and request hashes, not the raw credential value; that does not scrub physical storage or backups. Clearing does not erase historical model evidence or revoke another owner's copy. Older strict readers cannot decode cleared records; preserve backups and do not downgrade an owner after writing one. Tombstones still consume the bounded credential-reference capacity. Artifact/real-database/container qualification is separate from source tests.

## Explicit model discovery

When the user asks to list the models advertised by an already configured OpenAI-compatible connection:

```sh
node bin/jevable.mjs providers discover settings-default --data-dir .jevable
```

SDK callers use `await runtime.discoverModels('settings-default', { signal })` (the cancellation signal is optional). Authenticated management clients submit `{ "operation": "providers.discover", "id": "settings-default" }`; the selected-owner CLI also supports the usual explicit HTTPS/Docker-owner options. Discovery is not available in the narrower exact-release API.

The core makes one explicit `GET <configured-endpoint>/models`, following the [OpenAI list-models shape](https://developers.openai.com/api/reference/resources/models/methods/list). It uses this connection's protected credential, never desktop state, workflow-supplied endpoints or ambient trace headers. No request occurs on startup, listing connections, validation, readiness checks or preview refresh. System One discovery is unavailable rather than guessing another protocol.

Results contain sorted unique model IDs and their membership in the exact observed connection generation's allowlist. Other provider fields are discarded. IDs are untrusted provider text, not executable instructions. An advertised model is not necessarily chat-compatible, approved for use, reachable for inference, or a native Decision model. Discovery does not add permissions, create runs, save model evidence, estimate pricing, or change credentials; revise the connection separately with its generation guard after review. The result is an advisory observation, not a retained execution receipt or account-wide catalogue.

Responses are bounded by the configured byte limit and 1,000 IDs. The deadline is the lesser of the connection timeout and 30 seconds, including body reading; explicit cancellation and PostgreSQL owner loss stop the transport. Redirects, malformed/duplicate IDs and declared additional pages are refused; no automatic pagination, retries or fallback provider. Errors use fixed categories without response bodies or credentials. Await discovery before closing or changing this owner configuration; pending work returns `busy`. A disconnected management caller does not cancel its admitted read: inspect the caller outcome rather than assuming it never reached the provider. Real hosted-provider, PostgreSQL/container and browser qualification remain separate from private fixture tests.

## Evidence and failure behavior

Provider trace propagation is disabled unless this connection explicitly sets `"tracePropagation": "w3c"`; `"none"` or omission sends no tracing headers. When runtime telemetry creates a model span, the built-in adapter sends its strict version-00 `traceparent` to this exact connection endpoint. Without a runtime span it sends none. It never takes a header from workflow input, environment variables or a global tracer, and never forwards baggage or `tracestate`. Redirects remain refused. Review whether the provider is authorized to receive correlation IDs before enabling this setting; see [telemetry correlation](telemetry.md#correlation-and-durability).

`ModelCalls.execute` has an optional fifth argument `{ trace }` with a cloned validated context from the private model span. Existing four-argument SDK adapters remain compatible. Custom adapters own their outbound policy and durable evidence; merely receiving this context does not authorize transmitting it.

Retry observations may also provide optional `ModelTryObservation.withJournalScope(work)` to correlate that try's persistence with its live private span. The hook is synchronous and transparent, although work itself may return a Promise. The configured adapter snapshots/binds the hook and preserves exactly one real work invocation and its result/error even if optional diagnostics fail, duplicate/defer the callback or substitute a value. It never stores the hook, reconstructs a historical span, changes outgoing trace propagation or grants dispatch/retry authority. Existing observers without the hook keep enclosing-model ancestry. See [journal span scope](telemetry.md#optional-postgresql-journal-spans-and-logs).

SDK callers must await `runtime.check(yaml)`. Injected `ModelCalls.admit` may return a promise, which the runtime awaits before creating or continuing execution. The built-in transport consumes the `ProviderPersistence` interface: reads and evidence writes may be asynchronous, but a pending write must be acknowledged before dispatch and a settlement acknowledged before returning output. An optional storage owner-loss signal aborts active transport without turning ownership failure into an automatic retry. See the experimental [PostgreSQL provider adapter](postgres.md#typed-provider-adapter); it does not move workflow checkpoints off SQLite.

Before dispatch, the runtime retains the exact model-visible request body, selected connection generation/endpoint and attempt ID. Authorization headers and secret values are never part of that record. On success it retains the exact text or structured collector arguments and reported token usage, response ID and model identifier when present. The typed output schema and Decision consistency checks still decide whether the node succeeds. No missing usage is invented.

When propagated, the exact `traceparent` is committed with pending model evidence before the HTTP request and cannot change at settlement. It is correlation evidence, not proof the provider received or honored the header, and not a receipt for collector delivery. Old records without propagation fields retain their original shape. Older strict readers may reject newly configured propagation/evidence fields; do not downgrade a database after writing them without a compatible reader or backup.

Independently of propagation policy, the built-in adapter also commits the supplied model-call `trace` context with pending evidence and preserves it through settlement/retries. This local metadata is available in redacted model history and trace navigation; it does not grant permission to transmit identifiers. When both fields are present, the retained outbound header must exactly match the local call context. No context is fabricated without telemetry or backfilled into old records. Retry child spans remain separate from the call span. The same strict-reader downgrade limitation applies to this optional field.

Completed model evidence is checked against the immutable workflow and prepared input without network calls during restart/inspection. Historical evidence uses the saved route, so current credential rotation or model allowlist changes do not make it unreadable. New execution still checks current permissions. Prompts and model output are private execution data, not automatically included in portable exports or ordinary CLI receipts.

An incomplete request, missing finish marker, truncated output, refusal, wrong collector/tool, over-limit response, redirect, timeout or transport error never silently changes providers or starts another call. An unsettled run is reported as uncertain and cannot be resumed automatically. Durability errors are not caught as retryable transport errors. Explicit reconciliation of a retained response after a workflow-journal failure remains unimplemented.

## Bounded HTTP retries

The built-in adapter accepts reviewed `execution.maxAttempts` from 1 to 10. One means no retry. Values above one select `transient-http-v1`: retry only a received HTTP 408, 429, 500, 502, 503 or 504 response. The endpoint, model, request body, credential and optional trace context remain fixed for this call. This applies to streamed/non-streamed LLM calls, typed Decision compatibility and explicit native System One calls, not arbitrary tool execution. It does not silently add provider-specific statuses such as 529.

The delay starts at 100 ms, doubles after each failed try and caps at 2 seconds. A parseable `Retry-After` can increase it; a server delay that cannot fit the remaining budget ends the call without another request. An oversized delay header also stops retries conservatively. `timeoutSeconds` is one overall budget after the initial intent acknowledgement, including subsequent evidence writes and backoff—not a fresh timeout per request. Caller cancellation, storage-owner loss and uncertain commits stop dispatch. A storage operation itself is governed by its storage timeout; model timeout does not roll it back.

Every request needs its own acknowledged durable intent. Each failed try is settled before scheduling the next, with its unique try UUID, sequential number, timestamps, HTTP status and delay, linked to the original node attempt. Multi-try calls use model-evidence format 2; single-try records retain format 1. Immutable history and policy checks are shared by SQLite and PostgreSQL. Reopening an unfinished call, including one interrupted during backoff, is inspection-only: it never sends the remaining tries. A completed call can be verified and reused offline. The evidence-format number is distinct from the SQLite database-schema version; older readers cannot read format 2, so preserve backups and do not downgrade after writing it.

Retries can spend additional provider credits, and an HTTP error does not prove the provider did no work. Choose the maximum as part of workflow review and authorized execution; the adapter provides no exactly-once guarantee at the provider. Successful `usage.tries` counts admitted transport tries; token counts describe only the successful reply's reported usage, not a fabricated total for failed requests. The workflow's AI-step limit counts nodes, not transport tries. Configured telemetry adds child spans, bounded counters and correlated logs for retry-enabled calls; see [try observability](telemetry.md#retry-enabled-model-tries). Protected model evidence holds the retry history; ordinary receipts and telemetry do not expose raw error bodies or credentials.

Source-level retry tests and installed-artifact/database qualification are separate gates. Check the qualification records for the tested artifact; do not treat this policy as proof of compatibility with any hosted provider or of production Kubernetes behavior.

Schema version 2 adds connection, credential, model-evidence and configuration-audit tables in the same transaction as the migration. Existing version-1 run journals are retained. Rollback/downgrade to the old implementation is not supported after migration; preserve a database backup before upgrading an existing installation.

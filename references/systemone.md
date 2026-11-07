# Native System One Decisions

Status: experimental native execution is implemented through the shared configured-model executor. Select `provider: jev` or `laya`, an explicit configured `protocol: systemone` connection, and `answerFormat: systemone-v1`. The public `@jevable/core/providers/systemone` SDK also remains available as a pure request/reply codec. Capability metadata names this contract and marks real services/deployments unqualified. Local fixture verification does not establish compatibility with a particular hosted or self-hosted model. Never silently replace the native route with an LLM.

The implementation follows the [TypeSafe System One OpenAPI contract](https://api.typesafe.ai/openapi.json) (API version 0.2.0, inspected 2026-09-30) and the [laya-serve protocol documentation](https://stiermid.github.io/laya-serve/dev/api/). These documents are protocol references, not evidence of an authorized run against either service. No remote model was called during codec qualification.

## Versioned output contract

The native response contract is not the existing LLM compatibility contract. In particular, native Noul returns `noul` with no separate confidence. Score uses numeric string keys and a rubric legend. The original workflow answer schema requires `probability` and confidence for Noul, and a probability array for Score. Existing definitions and retained LLM evidence keep that contract; no default or stored source is rewritten. Old unversioned native definitions still cannot execute through this adapter. Migrating one requires a reviewed source change and updated bindings.

For `systemone-v1`, a Decision's output is the exact validated `answers` map. Use `nodes.judge.output.review.noul` for a Noul probability, `nodes.judge.output.urgency.probabilities["2"]` for a Score level, and `nodes.judge.output.team.confidence` for reported Choice confidence. The native schema rejects `review.confidence` and `review.probability`. The full raw JSON response, including whitespace, model and usage, is retained privately before workflow settlement. Values are not converted to collector arguments or renormalized. Choice/Score confidence remains provider-reported, not a calibration guarantee.

The live viewer's reading view labels a native Noul answer **Chance of yes**, as a percentage, without adding confidence or a yes/no verdict. Display percentages use at most two decimal places; values strictly between zero and 0.01%, or between 99.99% and 100%, show bounds instead of rounding into certainty. Exact JSON keeps the original number. Unknown fields or an invalid envelope remain visible as ordinary recorded fields, rather than being hidden by specialized formatting. Viewing an answer never approves or continues a run.

## Configure and run

Copy `examples/provider-systemone.json` and `examples/native-decision.yaml` into your project. Replace `your-explicit-model-id` in both with the model you are authorized to use. Select `jev` or `laya` consistently in the connection and workflow. The endpoint is an operator-selected HTTPS or loopback HTTP base ending in the service's API prefix (for TypeSafe, `/v1`); the adapter appends `/systemone`. It never appends `/chat/completions`, follows redirects, discovers credentials, or starts a model server. A self-hosted Laya service is provisioned separately; Docker is not a Jevable requirement.

```sh
node bin/jevable.mjs providers set provider-systemone.json --expected-generation 0 --data-dir .jevable
node bin/jevable.mjs credentials set models/native --file /absolute/path/to/private-key-file --expected-generation 0 --data-dir .jevable
node bin/jevable.mjs check native-decision.yaml --data-dir .jevable
# Only after authorizing model usage; retain the run UUID before submission:
node bin/jevable.mjs run native-decision.yaml --input ticket.json --id <retained-uuid> --data-dir .jevable
```

The example input is a JSON string. General native state may be a string, object or array. Readiness validates configured protocol/provider/model/credential permissions and native question limits without contacting the service. Native connections reject chat-only `tokenParameter` and `maxStreamEvents`. Keys enter through the same protected file/pipe mechanisms as other providers; never put them in workflow YAML, arguments or chat. Use the matching explicit PostgreSQL storage flags when that backend is selected; its ownership rules are unchanged.

Intent must be acknowledged before dispatch and raw response settlement before returning output. Inspection/restart reconstructs the exact request from saved source/input and verifies the retained native reply, reported model and usage without a network call. Failed or uncertain requests do not automatically resume or switch providers. Explicit cancellation/ownership loss aborts cooperative transport, not external provider effects. Approval continuation reuses the committed Decision result.

Reviewed `execution.maxAttempts` uses the existing `transient-http-v1` policy and one total timeout budget; it is not a provider-specific retry recommendation. In particular, HTTP 529 is not retried by that policy. Additional attempts may spend provider credits. Trace propagation remains an explicit per-connection `w3c` opt-in and the exact header is retained with intent. Credentials and raw state/answers are excluded from ordinary metadata evidence and default telemetry.

Connection records and model evidence retain the explicit protocol. Their existing record-format numbers do not imply compatibility with older strict readers: do not downgrade a store after writing native records without a compatible reader or backup. Exported releases state the native protocol/output contract and require independent target credentials. Packaging is not a successful run or deployment; use the qualification receipt for the exact tested artifact/backend.

## SDK

```js
import { createSystemOneRequest, parseSystemOneReply, readSystemOneReply }
  from '@jevable/core/providers/systemone'

const limits = {
  maxRequestBytes: 100_000, maxResponseBytes: 100_000,
  maxDepth: 32, maxValues: 10_000,
}
const request = createSystemOneRequest({
  model: 'explicit-model-id',
  state: { message: 'Please review this request.' },
  questions: {
    needsReview: { type: 'noul', instructions: 'Does a human need to review this?' },
  },
}, limits)
// Inspect a retained response, without network access or workflow execution:
const evidence = parseSystemOneReply(savedRawJson, request, limits)
// Or read an already obtained Response; this function never sends a request:
// const evidence = await readSystemOneReply(response, request, limits)
```

`savedRawJson` is caller-supplied private response data, not a built-in sample or a completed workflow receipt. The return value is `{raw, reply}`. The request and result are detached and frozen. The caller owns authorization, network timeout/cancellation and durable storage; these helpers have no credentials, service discovery, retries or dispatch. Raw state and answers are private data and must not enter public telemetry by default.

Admission supports the current workflow question subset: nonempty string instructions, string Choice criteria with 2–255 labels, and 2–10 unique string Score levels. It does not claim all structured-prompt or optional-criteria variants offered by the underlying APIs. State must be a string, object or array; other scalar values are refused rather than silently serialized. Request/reply budgets are explicit. Reserved properties, cyclic/accessor objects, oversized/deep data, unknown fields, mismatched question/label/level keys, inconsistent choices/scores and invalid usage are refused with content-free errors.

The client and versioned workflow validator admit probability mass within `0.00001` of one and Score agreement within that tolerance times the number of levels. This is an explicit local rounding policy, **not a vendor guarantee**. They do not renormalize probabilities, recompute scores, add explanations or manufacture missing usage/confidence. The original compatibility contract retains its stricter numerical checks.

The asynchronous reader accepts successful JSON responses only, bounds actual body bytes irrespective of Content-Length, checks UTF-8, snapshots request/policy before reading and releases its reader on failure. It refuses redirects/error responses and SSE; it does not follow a redirect or decide whether to retry. An already-locked body belongs to its existing reader and is not released by this helper.

## Remaining integration gates

Local fixtures now cover native `jev` and `laya` execution in independently built SQLite/PostgreSQL release images on Linux arm64, plus the installed CLI, extracted apps, PostgreSQL restart/pause behavior and the scoped preview protocol. The image checks retain exact native answers/raw JSON, retry and approval history, image archive reload and correlated OTLP traces/metrics/logs. These are simulated model/collector services, not qualification of either real provider. The preview checks exercise HTTP operations, not browser rendering or interaction. See the source repository's `qualification/native-decision.json` for exact artifacts and exclusions.

- Exact-artifact database, CLI/preview/release/container verification beyond the recorded fixture profiles.
- Full forced-termination, database interruption and uncertain-effect recovery matrix for native calls.
- Actual browser use, broader deployment platforms and Kubernetes execution.
- Authorized real-service checks for each advertised provider; no fixture-only claim of hosted or self-hosted model compatibility.

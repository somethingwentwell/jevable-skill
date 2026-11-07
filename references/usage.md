# Retained model usage

Use `jevable usage report selection.json` to report recorded usage for explicitly selected runs. This is workflow evidence, not provider billing, account-wide usage, a pricing estimate or OpenTelemetry delivery verification. Reading a report never calls a model, resumes a workflow, approves a step or enumerates other runs.

For retained installation project/proposal/import/run-outcome counts rather than selected token fields, use [activity report](activity.md).

## Select runs

Use IDs and revisions from retained run receipts. The selection format is shared with evidence ZIP export:

```json
{
  "schemaVersion": 1,
  "runs": [
    { "id": "11111111-1111-4111-8111-111111111111", "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
  ]
}
```

Replace these example identities with actual receipts. Duplicate IDs, wrong revisions and missing runs fail the entire report; there is no partial-success output. At most 100 selected runs, 10,000 model intents, 64 MB of source evidence and 16 MB of output are admitted. Each source snapshot has its existing 16 MB limit. The command outputs JSON; it does not save a file automatically.

```sh
node bin/jevable.mjs usage report selection.json --data-dir .jevable
node bin/jevable.mjs usage report selection.json --storage postgres --database-file /private/database.json
```

When a service owns the store, use its API instead of opening another direct owner. The same command accepts the explicit [Docker owner](docker-owner.md) flags or [HTTPS endpoint](remote.md) flags. Connection does not authorize deployment or lifecycle changes. Management HTTP accepts `{"operation":"usage.report","selection":...}`, with `selection` containing the complete object above.

The public `@jevable/core/evidence` SDK exports `createUsageReport(host, selection)`, `inspectUsageSelection`, `UsageSelection`, `UsageReport`, `UsageReportHost` and `USAGE_REPORT_LIMITS`. An ungrouped host needs only `exportRun(id, false)`; both runtime backends implement it. For a remote SDK host, unwrap the authenticated operation envelope and preserve the client's instance guard.

Exported workflow apps include `node app.mjs usage <run-id>` with their own `--data-dir` or `--database-file`. Their exact-release API also accepts `usage.report`, with the normal release-hash guard; every selected run must belong to that exact release. No authoring skill or management server is required by the exported app.

## Select an intent-time window

Usage selections optionally add a strict `window` object. Both endpoints must be UTC ISO timestamps with exactly three fractional digits, and `from` must precede `before`. The start is inclusive and the end exclusive. Invalid windows fail before source reads; the CLI validates its selection before opening state. This usage-only field is not accepted in evidence ZIP selections.

```json
{
  "schemaVersion": 1,
  "runs": [
    { "id": "11111111-1111-4111-8111-111111111111", "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
  ],
  "window": {
    "from": "2026-10-01T00:00:00.000Z",
    "before": "2026-10-02T00:00:00.000Z"
  }
}
```

The SDK, management CLI/API and exact-release API use the same selection. A direct exported app takes paired flags:

```sh
node app.mjs usage <run-id> --from 2026-10-01T00:00:00.000Z --before 2026-10-02T00:00:00.000Z --data-dir ./state
```

PostgreSQL apps instead require their private `--database-file`. Selection still names every run explicitly; there is no time-based discovery. Calls are allocated by their original configured-model intent timestamp, not workflow creation, response settlement, HTTP dispatch or each retry. An included retrying call contributes its whole successful-response usage once, even if later tries/settlement lie outside the window. No proration or provider billing-period inference is performed.

Scoped reports include `window`, per-run/aggregate `windowCoverage` and the included calls' `intentAt`. Valid retained UTC timestamps with second or finer fractional precision remain accepted and are preserved in output; the selected window endpoints alone require milliseconds. `observedModelIntents` counts every intent in the selected available snapshots, while `outsideWindow` counts known excluded timestamps and `unlocatedModelIntents` counts missing timestamps. Unlocated calls are not allocated to the window and prevent complete coverage/known-zero claims; their token totals may be unknown. Missing histories remain separately unavailable. An empty window with fully located source calls can report zero observed in-window usage. Every source call still undergoes accounting validation, including excluded calls; filtering cannot hide malformed timestamps, duplicate attempts or inconsistent retries. The selection checksum includes the window, and source snapshot checksums still identify the complete observed snapshots. Omitted windows retain the original unscoped result shape and selection hash.

## Opt into requested provider/model grouping

Add `"groupBy": "provider"` or `"groupBy": "provider-model"` to a usage selection. This is explicit consent to include those identifiers, and can compose with the optional `window`. Omit it to preserve ungrouped output/privacy and the existing selection hash. Evidence ZIP selections do not accept it.

```json
{
  "schemaVersion": 1,
  "runs": [
    { "id": "11111111-1111-4111-8111-111111111111", "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
  ],
  "groupBy": "provider-model"
}
```

```sh
node app.mjs usage <run-id> --group-by provider-model --data-dir ./state
```

Both runtime backends expose the read-only `exportUsageRun(id)` SDK method. It holds the existing coherent evidence/owner guard and projects only a verified configured-model record's requested provider and requested model. It never reads today's credentials for dispatch, includes a provider's raw request/response, or resolves an absent model record from today's connection or YAML alone. Native Jev/Laya and explicit LLM compatibility use the actual effective request plan. Requested model is not the provider-reported response model/version, billing SKU or priced account identity.

A grouped `UsageReportHost` must implement `exportUsageRun(id)`; an older/custom host without it is refused before reads, without private/ordinary evidence fallback. The returned checksum-protected snapshot must carry the explicit `privacy.modelIdentities` marker and `models.usageIdentities` format. Recorded calls require strict provider/model identity; unrecorded calls cannot claim one. Ordinary `exportRun`, evidence CLI/API/preview/package paths and ungrouped usage do not opt into identity projection. The identity-bearing source snapshot checksum is intentionally different from ordinary evidence. For remote hosts, use the authenticated `usage.report` operation directly rather than fabricating this projection from model settings.

Per-run and aggregate `groups` contain a strict `key` and the same exact token/call/coverage summary, plus `unlocatedModelIntents`. Provider-only keys omit model; provider-model keys include both. A `null` identity bucket retains missing histories/unrecorded calls instead of attributing them to a provider. An available history with no intents has empty groups and known-zero overall observed usage. At most 1000 groups per run and across the whole selection are admitted; exceeding the bound fails the entire report. Ordering is deterministic and keys do not depend on delimiter parsing or object property names.

With windows, known outside calls are not grouped. Missing intent time keeps an otherwise verified identity bucket visible with unlocated coverage, but does not allocate its tokens to the window. Missing/unrecorded identity stays in the unknown bucket. Group coverage describes only assigned observed records: complete coverage for a known bucket does not establish provider/account completeness when another bucket/history is unknown. Groups sum completed responses once across retries; failed/pending tries may have unreported provider consumption. There is no discovery, billing API, price estimate or execution mutation. Provider/model identifiers may themselves be sensitive operator-authored values: review grouped reports before sharing.

## Read the result

Each run retains its workflow status, observed update time, revision and source snapshot checksum. Reports combine separate per-run observations, not an atomic database snapshot. A waiting, paused or executing run may acquire further usage later. Checksums detect changes; they do not authenticate a provider's bill or independently prove retained history.

| Field | Meaning |
| --- | --- |
| `reportedTokens` | Exact decimal integer string; `null` when no token count is available. A provider-reported `"0"` is distinct from missing data. |
| `reportingCalls` | Completed model responses with this token field present. |
| `completedCallsWithoutField` | Completed responses that omitted this particular token count. |
| `coverage` | `complete-for-observed-intents`, `partial` or `unavailable`, separately for input and output. Never a billing-completeness guarantee. |
| `recordedTries` | Retained attempt records, not proof each request reached a provider. |
| `failedOrPendingTries` | Attempts whose usage is unavailable to this accounting model. They may have incurred provider usage. |
| `unrecordedCalls` | Model intents without configured-provider evidence, including some custom SDK adapters. Not proof of no call. |
| `unavailableHistories` | Selected snapshots without model history. Counts from available histories are then only a partial view. |

Usage is summed from configured-provider model records, once per completed model call. It is **not** multiplied by `tries`, and duplicated step/journal metadata is not added again. A three-try operation whose successful response reports 12 tokens contributes 12 reported tokens and two failed/pending tries; coverage is partial. Loop iterations have separate attempt IDs and keep their loop scope. Legacy single-try and current retry records use the same accounting rule. OpenAI-compatible and native Jev/Laya responses share this retained usage contract.

No model intents in an available snapshot means zero **observed** model usage. Missing history never becomes a known zero. Tokens from failed responses, unsupported/custom adapters and provider-side processing after interrupted requests may be unknown. Do not infer dollars, savings, dispatch counts or total account consumption.

Reports exclude prompts, workflow inputs/outputs, review actors, credentials, provider endpoints and raw model responses. Run/node/attempt IDs, loop scopes, revisions, timestamps and counts remain: review these before sharing. Grouped reports separately opt into requested provider/model identities, never connection/credential references or provider response IDs. An experimental [selected-run preview panel](live-preview.md#selected-retained-usage) offers explicit summary reads, time windows and grouping drafts; actual browser qualification remains open. Billing integration, time-window discovery and broader account dashboards remain separate work. Explicit window filtering/grouping is not discovery or account-wide accounting.

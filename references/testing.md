# Saved workflow tests

For [API-entry workflows](api-trigger.md), review optional `triggerMode: "api"` in each definition or use `tests generate --trigger-mode api` to prepare drafts. It changes the reviewed hash; case/suite execution consumes that accepted mode, never infers it from a graph or HTTP transport. Old definitions remain unchanged. The experimental [HTML editor](live-preview.md#saved-tests-in-the-preview) preserves that field, offers an explicit unsaved entry-copy action and a basic exact-text output check; structured values and other assertions remain in Advanced JSON. Only the recorded, scoped browser paths are qualified; broader browser acceptance remains open.

Saved tests belong to the standalone Jevable core, not an agent conversation or desktop session. Each definition pins a project ID, accepted workflow revision and project generation. Case edits append new versions; acceptance records the reviewed definition hash and actor. Execution pins that accepted case version in the run and its creation journal event. No server or Docker is required for the SDK/CLI.

## Define and review

Create a project first, then use its returned ID, generation and accepted revision in a JSON definition. For the shipped echo workflow:

```json
{
  "title": "Echo preserves its input",
  "project": {
    "id": "<project-uuid>",
    "generation": 1,
    "revision": "<accepted-workflow-sha256>"
  },
  "input": "Hello from a saved test",
  "expectations": [
    {"kind": "status", "value": "completed"},
    {"kind": "output-equals", "value": "Hello from a saved test"},
    {"kind": "node-visited", "nodeId": "result"}
  ]
}
```

```sh
jevable tests create echo-test.json --data-dir .jevable
jevable tests show <test-id> --data-dir .jevable
jevable tests accept <test-id> --expected-generation 1 --sha256 <reviewed-definition-hash> --data-dir .jevable
```

Creation is a draft and never starts a workflow. Acceptance also never executes. `edit <test-id> --file <definition.json> --expected-generation <n>` appends another draft that must be reviewed and accepted again. The returned generation after acceptance is the execution guard; do not keep using the preceding draft generation. Inputs must satisfy the pinned workflow schema, and asserted nodes/scopes must exist.

Every definition requires exactly one `status` expectation: `completed`, `failed`, `waiting` or `cancelled`. Additional assertions are:

| Assertion | Meaning |
| --- | --- |
| `output-equals` with JSON `value` | Deep equality of final output; requires `completed` status |
| `failure-code` with `value` | Exact runtime failure category; requires `failed` status |
| `node-visited` with `nodeId` | Node has a settled step in retained evidence |
| `node-output-equals` with `nodeId` and JSON `value` | Deep equality of that settled step's output |
| `node-port-equals` with `nodeId` and string `value` | Exact outgoing port recorded on that settled step; never inferred from output, adjacency or a completed target |

For a loop-body node, include `"scope":{"loop":"<loop-node-id>","index":0}`. Omitting scope selects only a top-level step, never an arbitrary loop iteration. A waiting or uncertain attempt is not a settled node visit. Failure categories are `invalid-node-value`, `loop-limit`, `loop-timeout`, `approval-rejected`, `approval-expired`, and `ai-budget`.

Use `{"kind":"node-port-equals","nodeId":"route","value":"true"}` to test an If/Else route even when both ports reach the same node. Switch ports use their authored names or `default`; approval ports use the configured actions (and enabled rejection/timeout branches); completed loops use `done` or their enabled `limit` branch. For a body exit, add its exact loop/index scope. A Decision node normally records `next`: assert the downstream Rule's port to test routing based on the typed Jev answer/confidence. Draft admission rejects ports not declared by that pinned compiled node or body exit, including assertions on final Output nodes.

A matching port proves only retained selection, not successful execution of its target or a loop return binding. Pair it with the relevant status/output/visited assertions. An unvisited, unsettled or legacy step without a recorded port yields `available: false` and cannot match—even if the selected path looks inferable. Reading an old run never backfills port evidence. The default report omits expected/actual port values; owner `--inspect` shows them. This is runtime evidence testing, not actual browser qualification.

Assertions execute no JavaScript, expressions or model-based grading. Prefer explicit expected routes and structured outputs when prose from a model is intentionally variable; a successful sample does not prove exhaustive branch coverage or deterministic model behavior. Arbitrary predicates are not implemented. For reviewed serial-default or explicitly bounded parallel batches with stable run identities and separate retained assessments, see [saved-test suites](suites.md).

## Generate candidate drafts

```sh
jevable tests generate <project-id> --expected-generation <project-generation> \
  --revision <accepted-workflow-sha256> --id <retained-batch-uuid> --limit 12 --data-dir .jevable
jevable tests generation <batch-uuid> --data-dir .jevable
jevable tests generations --data-dir .jevable
```

The core derives sample inputs from the accepted workflow's schema. It does not execute nodes, contact providers, require model credentials, accept tests or decide approvals. It samples scalar bounds/enums, nested fields, optional omissions and bounded array lengths; it varies the first array item rather than every combination. Every emitted input passes the same compiler-owned schema validation used by execution. Optional fields that cannot be sampled within the bounds may be omitted.

The receipt identifies `schema-boundary/v1`, `execution: not-run`, and `coverage: schema-samples-not-branch-proof`. Each generated case starts as a draft with a **suggested** `completed` status expectation, not an inferred correct output. Review and edit inputs, expected routes, failures, approval checkpoints and outputs for the actual business behavior before accepting each case. Generation never establishes branch coverage, provider readiness or test success.

Retain the batch UUID before submission. The batch and all drafts commit atomically. Repeating the same UUID and project pin/limit returns the original receipt, even after later case or project edits; changing the request under that UUID is a conflict. A fresh batch requires the current active project generation and accepted revision. Original draft definitions remain in the batch receipt, while `tests show` returns the case's current version.

`--limit` defaults to 12 and allows 1–32 candidates. Generation caps attempts at 256, each input at 100 KB, all emitted inputs at 1 MB, constructed strings at 16,384 characters and arrays at 256 items, with additional value/depth/runtime budgets. `diagnostics` reports attempted candidates, validation rejections, skipped oversized attempts, total emitted input bytes, limit stopping and inability to construct a seed. These are generation diagnostics, not exhaustive counts of omitted fields or unsampled combinations. `no-candidates` is an explicit retained outcome, not a claim that the workflow is invalid or untestable; supply a suitable case manually when needed.

## Archive and restore

```sh
jevable tests archive <test-id> --expected-generation <current-generation> \
  --sha256 <reviewed-definition-hash> --data-dir .jevable
jevable tests show <test-id> --data-dir .jevable
jevable tests unarchive <test-id> --expected-generation <archived-generation> \
  --sha256 <reviewed-definition-hash> --data-dir .jevable
```

Use explicit authority for the exact case. This appends a lifecycle version, not data erasure. The definition/hash and draft/accepted status remain unchanged; list/show/history retain the `archived` marker. Archived cases cannot be edited, accepted or used for a new test run or suite admission. Already admitted runs are not cancelled, resumed or approved. Their original expectations, evidence and same-run UUID observations remain readable, even after restart.

Restore requires the exact current generation/hash and changes only archival state. A restored draft still requires acceptance; a restored accepted case requires its new generation for fresh execution. Neither operation refreshes project pins, restores an archived project or authorizes execution. Obsolete cases may be retired/restored using their historical project pin, but fresh runs still require an unchanged active project. No automatic archive/restore, stale-guard refresh or retry is performed. After an uncertain response, inspect show/history and the original guarded generation rather than resubmitting a mutation with newer guards.

Project JSON/ZIP test exports exclude archived cases for the reviewed revision, reporting `excludedArchived` only when nonzero. Definitions on other revisions continue to count under `excludedOtherRevisions`, without double-counting. No archived test history or results are transferred or reactivated. Ordinary unarchived records/exports retain their prior shape and omission behavior. All historical case/batch/run references still prevent project deletion; archival does not free storage or bypass capacity/history bounds. Physical case/batch erasure and retention tooling remain unavailable. Older binaries cannot read new archive versions; do not downgrade retained state.

The SDK uses `editTest({operation:"archive",id,expectedGeneration,reviewedSha256,archived:true|false,actor})`; authenticated management uses the same command with actor omitted/host-fixed. The CLI shares local, explicit PostgreSQL, Docker-owner and remote selectors; it never starts an owner or falls back. Experimental [preview controls](live-preview.md#saved-tests-in-the-preview) label archived cases, disable edit/accept/run and support explicitly reviewed archive/restore with the same exact guards. Actual browser qualification remains separate.

## Pure erasure-review foundation

`@jevable/core/testing` exports `testHistorySha256(history)` and `reviewTestErasure(history, request, references)`. These are pure review helpers: they never open storage, scan references, change archival state, erase data or authorize a mutation. SQLite and PostgreSQL SDKs implement the separate guarded logical-removal operations below; Owner CLI/API logical removal is described below; preview, delegated and exact-release removal remain unavailable.

The `archived-draft-v1` policy considers only archived manual drafts that have never been accepted. Any accepted history, imported provenance, retained run, generation-batch reference or other retained reference blocks eligibility. Supply all three strict nonnegative safe-integer reference counts (`runs`, `generationBatches`, `otherReferences`); missing or unknown facts must not be replaced with zero. `eligible` means eligible under the supplied facts, not proof that the live owner is unreferenced.

The request pins `{test:{id,generation,sha256},reviewedHistorySha256}`. The history digest covers the entire schema-normalized, integrity-checked case history, including earlier draft versions and attribution—not just the latest definition. A stale/foreign pin is a conflict. Review output contains identities/digests/reasons/counts, not titles, inputs, expectations or actors; it explicitly reports `referenceFacts: supplied-not-discovered`, `authority: none` and `storageMutation: not-performed`.

Persistence derives complete reference facts and repeats the exact history review under the owner's mutation boundary, retains metadata, forbids identity reuse and handles lost acknowledgements without replay. The SDKs below implement that contract for archived manual drafts only, with their distinct storage semantics. Broader retention remains unfinished; owner CLI/API transport uses the separate guarded operations below. Files, WAL, database backups and external exports are separate retention surfaces; logical removal must never be advertised as secure physical erasure.

## SQLite SDK logical removal

Use `LocalRuntime.eraseTest({requestId,test:{id,generation,sha256},reviewedHistorySha256,actor})` only with explicit authority for the exact archived draft and its full private history. Keep a fresh request UUID before calling; `testHistorySha256(owner.testHistory(id))` supplies the complete-history review guard. Never refresh stale pins or automatically erase cases to free capacity. This synchronous method uses SQLite; PostgreSQL has the asynchronous equivalent below. The owner CLI/API below expose the same limited logical-removal contract; no browser control, delegated grant action or exact-release operation exists. Do not fall back to another owner or raw database edits.

Within one `BEGIN IMMEDIATE` transaction, the core validates the current case/history, derives retained run/generation/alias facts, refuses accepted/imported/generated/run-linked history, inserts a metadata receipt and removes the unused draft's case row. A write refusal rolls back both changes. The receipt retains case/version/definition and history hashes, its project revision pin, trusted owner actor and timestamp; it contains no test title, input or expectations. Actor attribution may be private: inspect receipt sharing separately. Archived manual drafts remain the only removal scope; this is not accepted-case or batch purging.

Inspect `owner.testErasure(requestId)` after a lost response. An identical `eraseTest` request returns the original retained receipt without another removal, even after reopening. Changed pins/actor or a new request UUID for the removed case conflict. The original case UUID cannot be reused, including alternate letter case. The project remains referenced by the retained receipt; logical removal never bypasses archived-project deletion guards or reconstructs a test run. Reading receipts never executes, approves or resumes workflows.

SQLite schema 18 adds retained `test_erasures` metadata, capped at 10,000 receipts. Existing case/run/generation evidence migrates unchanged; a missing schema-18 receipt table or inconsistent receipt/case/project fails closed rather than being repaired. Older runtimes cannot read schema 18; do not downgrade. Status is `logically-removed` with `securePhysicalErasure: false`: old pages, WAL, backups and already exported copies may still contain private drafts. No VACUUM, file wiping, backup deletion or external copy removal is performed.

## PostgreSQL SDK logical removal

`await PostgresRuntime.eraseTest(request)` and `await owner.testErasure(requestId)` use the same strict request and receipt as SQLite. Obtain the full-history guard with `testHistorySha256(await owner.testHistory(id))`; retain the exact request UUID, pins and trusted actor before mutation. The owner CLI/API below expose the same contract with host-fixed attribution; delegated-grant erasure authority remains unavailable.

The shared domain queue excludes all competing typed owner mutations throughout bounded case/run/generation scans and history review. Reads use separate journal transactions: this is owner serialization, not one cross-page SQL snapshot or exclusion of raw journal/admin writes. Do not mutate this namespace through another low-level adapter or SQL administrator while its workflow runtime owns it.

One journal write transaction atomically stores an immutable metadata receipt, binds the lowercase case UUID to its request, tombstones the exact case key (`value: null`) and records one payload-free audit event. The request UUID is also the commit batch UUID. A CAS or database write refusal cannot commit partial receipt/removal changes. Normal case creation, generation and project import all reject retained case identities and normalized erasure bindings. Metadata remains a project reference.

Retained reads validate receipt/checksum, original commit/event identity, subject binding, case tombstone version, absence of live aliases and the pinned historical project. Startup checks all receipts/subjects and retained removal events; inconsistent or missing counterparts fail closed, not repaired. Receipts and bindings each have a 10,000-record cap, subject to the journal's separate total record/event/batch limits. Old PostgreSQL binaries do not understand these new journal collections; do not downgrade a namespace containing them.

After `commit-uncertain` or ownership loss, stop using that owner, close it and explicitly reopen with the same namespace/configuration. Read the original receipt or submit the exact retained request only to observe it; do not mint a new UUID, rebuild newer pins or repeat removal. Same-request observation returns the original timestamp/receipt without another write. Logical tombstoning is not secure wiping of PostgreSQL MVCC pages, WAL, backups or exported copies; `securePhysicalErasure` remains false.

## Owner CLI/API logical removal

```sh
jevable tests erasure-review <test-id> --data-dir .jevable
jevable tests history <test-id> --data-dir .jevable
jevable tests erase retained-erasure-request.json --confirm-delete <test-id> --data-dir .jevable
jevable tests erasure <retained-request-uuid> --data-dir .jevable
```

Review the full private history before authorizing removal. `erasure-review` returns exact latest `test:{id,generation,sha256}` and normalized `historySha256`, plus intrinsic archival/acceptance/import blockers. It does **not** discover live references, assess eligibility or grant authority. Missing reference facts are never zero. Removal independently scans and validates retained references under the selected owner's mutation boundary.

Privately retain a strict JSON request file **before** dispatch, containing only:

```json
{
  "requestId": "<fresh-retained-request-uuid>",
  "test": {"id": "<reviewed-case-uuid>", "generation": 2, "sha256": "<reviewed-definition-sha256>"},
  "reviewedHistorySha256": "<reviewed-full-history-sha256>"
}
```

The displayed generation is illustrative, not a default; use the exact reviewed values. No actor, reference counts, execution options or confirmation belong in this file. The CLI requires `--confirm-delete` to match the exact case ID, including letter case. Missing/malformed flags and mixed selectors fail before file reads; the bounded file and confirmation are validated before opening an owner or reading credentials. The request UUID is normalized to lowercase, but the case ID preserves its retained spelling.

Owner management HTTP exposes `tests.erasure-review` with `id`, `tests.erase` with the strict nested `request` above plus `confirmId`, and `tests.erasure` with `requestId`. Authentication and the service's instance guard still apply. Clients cannot submit actor or reference facts. The selected host assigns attribution: direct CLI uses its local owner actor; a service uses its configured trusted actor. An exact retry must retain that actor as well as the UUID and all pins. Switching to a differently attributed owner is not an equivalent retry; inspect the original receipt instead.

Shared selectors support direct SQLite, explicitly configured PostgreSQL, a reviewed Docker owner or an explicit HTTPS endpoint. Selection never starts/discovers a service or falls back to Jarness, another owner or raw SQL. While a service owns storage, use its endpoint rather than opening a competing direct owner. After uncertain ownership/commit, follow that backend's explicit close/reopen contract; the CLI never replaces it automatically.

After a lost response, `tests erasure` reads the **original request UUID**, not the case ID. An identical removal request only observes its original receipt; new UUIDs, newer history guards or changed attribution cannot bypass the removed identity. Receipts retain project references and private actor attribution but no title/input/expectations. Logical removal is not secure wiping of files, WAL, MVCC pages, backups or exported copies. Archived manual never-accepted unreferenced drafts remain the only scope. Preview, caller/reviewer grants and exact-release services reject these owner operations; do not substitute their tokens or create a fallback route.

## Run and inspect

```sh
jevable tests run <test-id> --expected-generation <accepted-case-generation> \
  --sha256 <reviewed-definition-hash> --id <retained-run-uuid> --data-dir .jevable
jevable tests result <run-id> --data-dir .jevable
jevable tests result <run-id> --inspect --data-dir .jevable
jevable tests history <test-id> --data-dir .jevable
jevable tests show <test-id> --generation <historical-generation> --data-dir .jevable
```

Retain the UUID before dispatch. An identical retry returns saved evidence without executing again, even after later case/project edits. A new run requires the latest accepted case generation and an unchanged active project generation/revision. Even renaming the project changes its generation: review an updated case definition before a fresh test. A pending workflow proposal is never executed by testing the accepted revision.

Tests use real workflow execution and provider permissions. They are not a sandbox: model calls may incur charges and supported external effects require the user's execution authority. Human Approval remains enforced. Use the ordinary `approvals show` and explicitly authorized `approvals decide` commands; testing never decides automatically. An uncertain model attempt is not retried to obtain a passing result.

The report separates `assessment` from `workflowStatus` and `terminal`. A workflow can complete while an assertion fails. Conversely, an expected failure can satisfy the test. An expected approval checkpoint can match with `assessment: passed`, `workflowStatus: waiting`, and `terminal: false`; this is not workflow completion. Other waiting or safely paused runs are pending, and uncertain executing runs are always uncertain.

An explicitly cancelled run is terminal for the workflow, even if its stopped attempt has an unknown external outcome. Only an explicit `cancelled` expectation matches that status; a `completed` expectation fails. Tests never initiate cancellation automatically. See [cancellation](cancellation.md) for request/final-state and external-effect limits.

`tests run` exits 0 for a terminal matched result, 6 for a terminal expectation mismatch, 3 for waiting/paused work (even a matching wait checkpoint), and 5 for uncertainty. Admission or operational errors remain errors, not synthetic test failures. Read-only `tests result` exits 0 when inspection succeeds regardless of assessment.

Results are evaluations of retained run evidence against the immutable accepted case, not a separate mutable grading record. `observedRunUpdatedAt` identifies the observed checkpoint; an authorized approval/resume may change later assessment. Reading, listing and inspecting never advance execution. Past case edits cannot rewrite the expectations of an existing run.

## Privacy, persistence and APIs

Case definitions/history, full generation receipts and `--inspect` reveal private test input and expected/actual values to the runtime owner. Schema enum values may themselves be private. Default checks omit expected/intermediate actual values, but their run receipt still includes completed workflow output. Case and generation lists exclude inputs and expectations. None are automatically embedded in portable HTML, telemetry or default project/release exports. Explicit [project export `--tests`](transfer.md) uses format v2 to transfer latest definitions for the accepted revision, rebinding them as new local drafts on import. Case history, batch receipts, run evidence and test results are not transferred. Format v1 remains test-free.

SQLite schema 8 added append-only case histories; schema 9 adds immutable generation receipts, and schema 18 adds the limited removal receipts above. Existing projects/runs/cases remain intact on migration. Definition commands are limited to 250 KB, cases to 100 versions and the store to 10,000 cases and 10,000 generation receipts, subject to the runtime's record-size limit. Case history, generation checksums/source pins/original drafts and run provenance are checked on reopen. Projects referenced by any saved case, generation receipt (even an empty batch) or logical-removal receipt cannot be deleted. Broader case/batch retention and physical erasure are not implemented. Do not remove rows manually to bypass these guards.

The runtime SDK exposes `testCases`, `testCase`, `testHistory`, `editTest`, `runTest` and `testResult`; types come from `@jevable/core/runtime`. HTTP operations are `tests.list`, `tests.show`, `tests.history`, `tests.command`, `tests.run` and `tests.result`. The HTTP host assigns the actor; clients cannot override it. `tests.run` takes `{test:{id,generation,sha256},runId}`. The case command is `{operation:"create",definition}`, `{operation:"edit",id,expectedGeneration,definition}`, `{operation:"accept",id,expectedGeneration,reviewedSha256}`, or `{operation:"archive",id,expectedGeneration,reviewedSha256,archived}` (SDK adds its trusted host actor). Actor attribution is not independently delegated authorization.

Generation SDK methods are `generateTests({id,project:{id,generation,revision},limit?,actor})`, `testGeneration(id)` and `testGenerations()`. Equivalent HTTP operations are `tests.generate` (same request without caller-supplied actor), `tests.generation` with `id`, and `tests.generations`. A lost HTTP response does not roll back a committed batch: retrieve or retry the retained UUID instead of submitting a new one.

Experimental [live-preview controls](live-preview.md#saved-tests-in-the-preview) expose generation, draft/edit/accept/run and private expected/actual inspection for one pinned preview project. Their scoped API and controller behavior have automated tests; actual browser interaction remains unqualified. Owner API case/history operations remain available independently of the preview.

Opt-in execution spans and structured end-event logs include case ID, generation and definition hash alongside run/revision identity. They exclude test names, inputs, assertions and actual payloads. Workflow execution telemetry is not a test-grading metric: a completed workflow with mismatching expectations still has execution outcome `completed`. Test-specific aggregate metrics and browser result-view qualification remain future work.

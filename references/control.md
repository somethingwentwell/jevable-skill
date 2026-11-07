# Step, continue and cooperatively pause a retained workflow

Use explicit execution controls when inspecting a workflow between real node attempts. These operations run the same standalone engine as normal execution; they are not simulated previews. Each step can call a configured model or produce effects and needs the user's execution authority.

## Start before the first node

```sh
node bin/jevable.mjs run workflow.yaml --input input.json --id <retained-run-uuid> --paused --data-dir .jevable
```

`projects run` also accepts `--paused` with its required project generation/revision guards. This validates and admits the workflow, stores its input and initial checkpoint, but dispatches no node. Configured execution readiness is still required. The receipt has `status: paused`, an empty `steps` array, `nodeId` for the next node and `checkpointSha256`. Exit code 3 means paused/waiting, not failure or successful completion.

Retain the run UUID and original `--paused` option when retrying a lost start response. Same-UUID retry reads the current retained run, even after it advanced; it does not reset it. Reusing the UUID with changed source, input, project pin or start mode conflicts.

## Explicit controls

Read `runs show <run-id>` and inspect the checkpoint you intend to advance. Choose and retain a new control request UUID **before** submitting each authorized action:

```sh
node bin/jevable.mjs runs step <run-id> --request-id <control-uuid> --checkpoint-sha256 <reviewed-hash> --data-dir .jevable
node bin/jevable.mjs runs continue <run-id> --request-id <another-control-uuid> --checkpoint-sha256 <new-reviewed-hash> --data-dir .jevable
```

Step admits at most one evaluator transition. Trigger and loop-entry transitions count, and a loop body exit may add several recorded items (node output, iteration result and loop aggregate) in one transition. Step therefore does not mean “add exactly one displayed result.” It stops at the next safe checkpoint, an actual approval wait, a terminal result or an error. It does not interrupt a model call mid-attempt.

Continue advances from that exact safe checkpoint until a configured breakpoint, completion, approval wait, failure or existing runtime limits. Neither operation accepts a waiting approval, resumes a cancelled run or redispatches an uncertain `executing` attempt. Custom execution remains unavailable; native Decisions require the explicit [System One contract and configured route](systemone.md).

The runtime atomically records the request ID, checkpoint hash, mode, actor and time before dispatch. A stale checkpoint conflicts. Reusing the same request ID with changed guards/mode/actor conflicts. An identical retry returns **current retained state**, not necessarily the original response, and never executes again. While the owner is actively executing it may return `busy`; use read-only inspection and the same identity after a lost response. A successful acknowledgement proves request admission, not workflow completion.

If request admission succeeded but execution failed before node intent, a retry still does not start it. Inspect the new checkpoint and retained evidence before explicitly authorizing a fresh control UUID. Do not automate fresh UUIDs to conceal failures. An uncertain attempt cannot be bypassed by a new Step/Continue UUID. Only an already committed model response is eligible for the explicit settlement operation below. `runs resume` is the older unguarded safe-checkpoint operation, not an idempotent substitute for Step/Continue.

The checkpoint hash binds run/revision, exact stored execution state, cancellation identity, latest admitted control UUID and latest breakpoint hit when present. It is a concurrency guard, not a signature. Recorded control actors are private; ordinary receipts expose control identity/mode and breakpoint metadata. Private inspection and evidence export retain full control history.

## Recover an already saved model response

A process can stop after committing a model response but before committing its enclosing node result. `runs recover` reconciles that exact response with the original node attempt. It is a state-changing, explicitly authorized operation, not ordinary inspection or an automatic retry policy.

```sh
node bin/jevable.mjs runs show <run-id> --data-dir .jevable
node bin/jevable.mjs runs recover <run-id> --request-id <retained-control-uuid> --checkpoint-sha256 <reviewed-hash> --data-dir .jevable
```

The SDK/management/exact-release APIs use `advance(..., {mode: 'recover', requestId, expectedCheckpointSha256}, actor)` / `runs.advance`. An extracted app uses `node app.mjs recover <run-id> --request-id ... --checkpoint-sha256 ...`. Select the existing owning service for active services; never open a competing direct owner. The experimental HTML has an explicit [Recover saved response control](live-preview.md#recover-saved-response), using the same project-scoped mode; actual browser interaction remains unqualified.

Recovery requires an idle `executing` LLM/Decision attempt with a committed, verified model result in its original store. It checks the historical request, route, raw response and usage; it does not require today's provider credentials or permissions because it makes no provider call. Missing, pending, failed, corrupt, cancelled, already-settled and non-model attempts are refused. Custom SDK adapters must explicitly implement the read-only `ModelCalls.recover` port; `execute` is never a fallback. This does not recover a broken database lock, reconnect a lost owner, retry a remote action or infer whether an unrecorded request succeeded.

Exactly one node is settled, preserving its original attempt/trace and real reported usage. No new node intent or model/try span is created. Recovery never runs the next node or approves a Human Approval; usually the result is a safe `paused` checkpoint (exit 3), requiring a separately authorized Step/Continue. Invalid retained model content can settle as the evaluator's normal failure. Existing loop deadlines are not extended. Missing original node timing remains missing, rather than being manufactured from recovery time.

Admission records the request ID/hash/actor before node settlement. Identical request reuse only reads current retained state, including after restart; changing its fields or actor conflicts. If recovery admission commits but its node settlement does not, retrying that ID reports the still-executing state without further work. Inspect it and authorize a new recovery UUID/hash only if another settlement attempt is intended. A cancellation received during the read takes priority. Telemetry emits a linked `jevable.resume` segment with `jevable.control.mode=recover`; it does not replay model telemetry or guarantee Collector delivery.

SQLite schema 15 admits the new control mode; existing checkpoint hashes are unchanged until a new control is admitted. Older binaries must not reopen upgraded SQLite state. PostgreSQL uses the same strict control record, so readers must support recovery records before any downgrade. Full forced-termination, browser/container/Kubernetes and unknown-external-outcome recovery remain separate qualification gates.

## Request Pause during execution

Pause is a durable, checkpoint-guarded control, not cancellation. Read the current run from its owning service, retain a new request UUID, then submit `runs.advance` with `mode: "pause"` and that `expectedCheckpointSha256`. The project-scoped preview protocol uses `advance`; the exact-release API uses `runs.advance`. Both retain the same semantics and owner-assigned actor.

```json
{
  "operation": "runs.advance",
  "id": "<run-uuid>",
  "requestId": "<retained-control-uuid>",
  "expectedCheckpointSha256": "<reviewed-current-checkpoint-hash>",
  "mode": "pause"
}
```

Submit the file through `runtime request <request.json> --endpoint <owner-url> --token-file <private-token-file>` (plus the explicit CA for HTTPS). An active service owns its database: do not open that same directory through a direct CLI job. For an idle local checkpoint, use `runs pause <run-id> --request-id <uuid> --checkpoint-sha256 <hash> --data-dir <directory>`. The selected Docker-owner CLI supports the same command with its normal explicit owner flags. An exported app has its own `pause` command and exact-release `request` client.

Pause is accepted only for a paused checkpoint or an executing intent; an existing approval wait or terminal outcome is not a new pause target. It cannot edit breakpoints. A stale guard conflicts; inspect again rather than automatically inventing a new request. Reusing the exact ID/guard/actor returns current retained state, including after restart or subsequent completion, without dispatch. CLI `pause` exits 0 for a successful request receipt, **not proof that execution has stopped**.

The current node, including its configured model retry policy, may finish. The executor records its real outcome and stops before the next node. Pause neither aborts the provider nor rolls back effects. If that node completes or fails the entire run, the terminal outcome wins. If it enters Human Approval, the approval still requires its normal explicit decision; a successful decision leaves downstream execution paused. Cancellation and expired loop deadlines take priority; time spent paused does not extend a deadline.

Receipts/evidence expose a payload-free `pause` summary: `at-safe-checkpoint`, requested with an active-or-uncertain attempt, approval wait with downstream pause, terminal-before-next-checkpoint, or superseded-by-cancellation. The request never fabricates an acknowledged result for an uncertain model intent. Process restart preserves that uncertainty; it does not redispatch or convert it to a safe pause.

At a safe checkpoint, a **new guarded Step or Continue** supersedes the pause and authorizes execution. Legacy `resume` does not clear a requested pause. Breakpoint configuration is retained. Read-only inspection/retry does not execute. The HTTP service reserves one bounded shared slot for single-run status, Pause and Cancel when ordinary capacity is full; authorization, project/release scope, strict schema, instance guards and response bounds still apply.

The experimental live HTML page provides **Request Pause** during execution, including while a Run or Continue response is pending. It reads the current checkpoint, retains a separate Pause UUID/guard before dispatch, and leaves any outstanding Step/Continue identity intact. **Retry retained Pause** resends exactly that request after response loss; refresh/reconnect only reads. A changed checkpoint resolves the stale request without claiming it was admitted or automatically replacing its guard. Pause does not apply breakpoint drafts. The page distinguishes requested/uncertain work from a safe checkpoint, approval waiting, cancellation and terminal outcomes. Protocol/controller-double checks do not qualify actual browser behavior.

## Persistent node breakpoints

Start paused, then provide a JSON file containing the node IDs to stop **before** dispatching, for example `["review", "result"]`:

```sh
node bin/jevable.mjs runs continue <run-id> --request-id <control-uuid> --checkpoint-sha256 <reviewed-hash> --breakpoints-file breakpoints.json --data-dir .jevable
```

The configuration is per run, pinned to its immutable workflow. It accepts up to 128 unique existing node IDs. Omit the file to retain the last configuration; supply `[]` to clear it. Step accepts the same flag but advances one evaluator transition even if that node is a breakpoint. Configuration changes are part of the admitted control: retain the same file contents on a request retry. They are not a separate read-only settings operation or an in-flight Pause request.

A hit retains `status: paused`, `breakpoints`, `breakpointConfigurationRequestId` and a `breakpoint` object with node ID, checkpoint hash, step count, time and loop/index scope where applicable. It writes a `breakpoint-hit` journal event without dispatching that node. Inspection, restart and identical control retries do not advance it. A fresh authorized Step/Continue from a recorded hit passes that hit once; later matching nodes and later loop iterations stop again. Legacy `resume` and automatic downstream continuation after an authorized approval also honor the retained configuration. Starting paused without a recorded hit does not bypass an enabled first-node breakpoint.

There are at most 10,000 retained hits, subject also to record/event limits. Failed hit persistence never authorizes dispatch; inspect retained state and use the existing uncertain-write rules. Loop deadlines keep running during pauses. Cancellation and an expired loop deadline take priority over breakpoints. A breakpoint on a loop entry does not start its deadline until that node is actually dispatched. The configured list and journal metadata are non-payload evidence but may contain sensitive identifiers; review before sharing.

The SDK/API control field is `breakpoints?: string[]`. The exact-release app accepts `--breakpoints-file` on `step`/`continue`, and the project-scoped preview protocol accepts the same field. The experimental HTML page supports node selection, local breakpoint drafts and recorded-hit labels. Only explicit Step/Continue submits a draft and executes; selecting a graph node never toggles or dispatches anything. See [live-preview.md](live-preview.md) for stale drafts and exact retries. Actual browser qualification remains open.

## Approvals and limits

To commit an authorized decision but inspect before downstream execution:

```sh
node bin/jevable.mjs approvals decide <run-id> --attempt <reviewed-attempt-id> --action approve --pause-after --data-dir .jevable
```

The decision is real and journaled. If it produces a safe continuation, that continuation remains paused for another explicit Step/Continue. Rejection or expiry may instead finish with failure. Permission to debug never authorizes a business approval. Decision retries still use the existing exact-attempt/conflict semantics; inspect after a lost response rather than resubmitting blindly.

Global transition limits do not reset between controls. There are at most 10,000 retained controls per run, plus existing record and event limits. Loop deadlines are wall-clock deadlines and continue during manual pauses; stepping does not suspend or extend them. In-flight Pause is cooperative as described above. Cancellation remains a separate durable stop and never proves rollback of external effects.

## SDK, service and exported apps

- SDK: `runtime.run(yaml, input, {id, paused: true})`, `runProject(..., {id, paused: true})` or `runRelease(..., {id, paused: true})`; then `runtime.advance(id, {requestId, expectedCheckpointSha256, mode: 'step' | 'continue'}, authenticatedActor)`. `executionCheckpointHash(run)` and `ExecutionControl` are exported from `@jevable/core/runtime`.
- SDK approval: `runtime.decide(id, attemptId, action, authenticatedActor, {pauseAfter: true})`.
- Owner HTTP: `runs.start` / `projects.run` accept strict optional `paused: true`; `runs.advance` accepts the run `id` plus the same control fields. `approvals.decide` accepts strict optional `pauseAfter: true`. The server supplies the actor.
- Preview protocol: `run` accepts `paused: true`, `advance` accepts the same control fields, and `decide` accepts `pauseAfter: true`. Exact admitted project/revision isolation applies. Experimental [live-preview controls](live-preview.md#step-by-step-execution) call this protocol, with retained request IDs and no automatic replay; actual browser qualification remains unfinished.
- Extracted release app: `node app.mjs run --input input.json --id <uuid> --paused`; `node app.mjs step|continue <run-id> --request-id <uuid> --checkpoint-sha256 <hash>`; `node app.mjs decide ... --pause-after`. Controls enforce the exact release and work through the same commands in release-job containers with an explicit writable `--data-dir`.

SQLite schema 14 admits cooperative Pause controls on top of schema 13's breakpoint evidence and schema 12's paused-start/control evidence. Earlier runs and checkpoint hashes are preserved; older development binaries must not reopen upgraded state. PostgreSQL uses the same run record/control semantics without a new SQL table. Trace-enabled execution controls use linked `jevable.resume` segments with control request ID/mode attributes; breakpoint hits add `jevable.pause.reason=breakpoint` and `jevable.breakpoint.node_id`. A running segment stopped by a requested pause adds `jevable.pause.reason=requested` and `jevable.pause.request_id`; request admission alone emits no execution span. Merely starting paused creates no execution span. Metrics still count execution segments, not distinct runs. Reading/retrying a control does not reconstruct telemetry or guarantee collector delivery.

An open service exclusively owns its directory: use its API instead of competing direct CLI processes. Reading, page refresh and opening stored state never call `advance`. Experimental controller implementation and test doubles do not complete browser debugging qualification, forced-termination recovery or Kubernetes delivery. Independent package and container protocol checks must be distinguished from browser interaction evidence.

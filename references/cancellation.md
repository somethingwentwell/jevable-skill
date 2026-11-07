# Explicit workflow cancellation

Cancel only the run the user intends to stop. Cancellation prevents further workflow dispatch; it does not reverse settled steps, roll back business effects, prove a provider stopped computing, or remove charges. Run identity, settled outputs and any unsettled attempt remain inspectable.

## Commands and ownership

```sh
jevable runs cancel <run-id> --request-id <retained-cancellation-uuid> --data-dir .jevable
jevable runs show <run-id> --data-dir .jevable
```

The SDK exposes `runtime.cancel(runId, requestId, authenticatedActor)`. For a running HTTP owner, submit `{"operation":"runs.cancel","id":"<run-id>","requestId":"<retained-cancellation-uuid>"}` through `runtime request` or `RuntimeClient`; the server supplies the actor. Do not start a competing direct CLI process against the service's data directory. HTTP retains one bounded shared slot for single-run status, guarded Pause and Cancel beyond ordinary request capacity. It is still subject to authentication, body/response limits and admission before service drain.

Retain the request UUID before submission. The request is committed with an audit event before signalling the active adapter. Repeating that UUID returns the current receipt without a new request or dispatch; a different cancellation UUID for the same run conflicts. Completed/failed runs reject a new cancellation. Lost responses are not evidence of rollback: inspect or retry the same request, never delete the owner lock or journal to force a stop.

The command exits 0 when cancellation submission/retrieval succeeds, **not** as proof the run stopped. Read the receipt:

| Receipt | Meaning |
| --- | --- |
| `cancellation.status: requested` | Request is durable; the active owner is still settling or stopping. Keep inspecting the same run. |
| Run `status: cancelled`, cancellation `status: stopped` | This runtime will dispatch no further steps for this run. `previousStatus`, node and available attempt ID identify the exact retained stop position. |
| `cancellation.status: terminal-before-stop` | A previously dispatched node settled the workflow as completed/failed before a stop checkpoint was recorded. Inspect that actual terminal outcome. |

A stopped `executing` attempt remains unsettled evidence: its provider-side outcome can be unknown. A stopped approval wait is not an approval or rejection decision. A result returned by an adapter that ignores abort is committed before stopping at the next checkpoint; it is not discarded to pretend nothing happened. An adapter that never settles can keep the request pending indefinitely. There is no forced thread/process kill, automatic compensation or external rollback.

Deterministic execution yields between nodes so control requests can arrive. Configured model transport receives an abort signal. Synchronous work already executing cannot be preempted; injected adapters should honor their signal and retain exact request/response evidence. The owner cannot close while active work is unsettled. SIGINT/SIGTERM service drain remains distinct from explicit run cancellation.

## Persistence, tests and releases

SQLite schema 10 admits cancellation requests and final stopped snapshots. Request identity and the final checkpoint hash are checked against journal events on reopen. Earlier project/run/test evidence is preserved. Opening, reading and listing never advance a pending cancellation. An explicit retry with its original request UUID can finish a previously committed request after a stop-write failure. Ordinary crash-lock recovery still requires verifying the original owner has exited; cancellation never deletes that lock.

Cancelled runs cannot resume or receive approval decisions. Reusing the original start UUID returns the cancelled evidence, not another execution. Direct execution/retry commands report exit code 7 for a cancelled run; read/cancel commands exit 0 on successful inspection/submission. Saved tests can explicitly expect `cancelled`; a terminal cancellation fails a `completed` expectation instead of passing as success. Test execution does not cancel automatically.

Exported runnable apps expose `node app.mjs cancel <run-id> --request-id <uuid> [--data-dir <directory>]`. They verify the run belongs to that release. A stopped CLI-job container can be replaced by another job using the same owned data volume to cancel a saved wait; this is not remote control of a still-running container owner. Managed Docker HTTP authoring, forced shutdown and Kubernetes cancellation remain unqualified.

With telemetry enabled, a committed stop has a linked `jevable.cancel` segment and `cancelled` outcome in execution traces, metrics and structured end-event logs. The request actor/input are not exported to telemetry. A request receipt or trace ID does not prove telemetry delivery or provider-side termination. Read-only retries do not create another cancellation segment.

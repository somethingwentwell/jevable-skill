# Watch a retained run

`runs watch` observes an explicitly selected Jevable workflow service. It never starts a service, opens a database, resumes execution, submits approvals or retries a failed operation. Direct SDK jobs do not require a server; watching concurrent service work uses that service's API instead of creating a competing storage owner.

```sh
jevable runs watch <retained-run-uuid> \
  --endpoint http://127.0.0.1:4317 --token-file /private/path/service-token
```

Use the actual endpoint reported by the selected service, not the example port. HTTPS uses normal verified trust or an explicit `--ca-file`. The owner token has broader authority than this read-only command; keep it private. For an exact-release service, also supply `--release-sha256 <reviewed-release-hash>`. Missing or incorrect release identity fails; there is no management fallback. Both storage backends expose the same retained-read operation.

Output is newline-delimited JSON, with or without `--json`: an initial `snapshot`, changed snapshots, then a `stopped` record. Each snapshot includes run/revision/checkpoint/owner identities, status, timestamps and the number of recorded steps. Source, inputs, outputs, node payloads, approval actors and arbitrary remote errors are withheld. The owner API still transfers its normal receipt, potentially including final output, over the authenticated connection; watch filters its printed output rather than introducing a payload-free server endpoint. Identifiers may still be sensitive when sharing.

Default interval is 1,000 ms and observation duration 60,000 ms. `--interval-ms` permits 100–60,000 and `--duration-ms` permits 1–3,600,000. Polls are serial; slow requests do not cause catch-up bursts. Each CLI request is bounded to at most three seconds (or the shorter configured duration). The deadline and interruption are checked between reads, so shutdown can take that additional in-flight request time. A late response is not printed as fresh progress.

Completed, failed and cancelled are terminal observations. Waiting and paused stop with `attention` by default. `--follow` keeps observing those states until a terminal result or deadline; it never acts on them. `executing` means retained intent, not proof of a live worker or a safely repeatable model call. A deadline is not workflow failure, and stopping the watcher does not cancel the workflow.

| Stop | Exit |
| --- | --- |
| Completed | 0 |
| Read/protocol/identity failure | 1 |
| Invalid command | 2 |
| Waiting or paused, without `--follow` | 3 |
| Workflow failed | 4 |
| Workflow cancelled | 7 |
| Observation deadline | 8 |
| SIGINT / SIGTERM | 130 / 143 |

Unknown runs and transport errors stop immediately; watch does not retry or wait for a future run to appear. A changed instance, revision or creation identity also stops instead of silently attaching to a replacement. Reinspect the selected service and retained evidence before explicitly starting another watch. This is sampled observation, not an event subscription or a complete execution history. Use [run evidence export](evidence.md) for retained details; telemetry delivery and test assertion success are separate from run completion.

## SDK

`watchRun` from `@jevable/core/http` is an async generator accepting a `RuntimeClient` or exact-release `ReleaseClient`, a run UUID and `{ intervalMs?, durationMs?, follow?, signal? }`. It calls only `operation({ operation: 'runs.show', id })`. Configure a bounded client timeout; the generator cannot interrupt an arbitrary supplied client's in-flight promise. `AbortSignal` stops observation, not execution. Breaking iteration releases its timer and makes no further reads. No ambient service or credential discovery is performed.

The exported app's own launcher does not yet include a watch command; it remains independently runnable without the authoring CLI. This observer is an optional client, not a runtime dependency. Browser watching and managed Docker/Kubernetes lifecycle qualification remain separate.

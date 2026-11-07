# Suite dispatch counts

These instruments extend [suite invocation observability](suites.md#suite-invocation-observability) in the current source/private candidate. They are not in the earlier preserved shipped package.

| Instrument | Meaning | Fixed labels |
| --- | --- | --- |
| `jevable.test.suite.cases.active` | Process-local up/down count of new cases waiting for dispatch or awaiting an admitted host call | `jevable.suite.failure_policy`: stop/continue; `jevable.suite.case.phase`: waiting/running |
| `jevable.test.suite.cases.settled` | Cumulative count of settled dispatch calls, including failed or uncertain submissions | `jevable.suite.failure_policy`: stop/continue |

Waiting begins only after whole-suite preflight. Running means awaiting a host call, not a running workflow node. Settled does not mean a successful assertion or completed workflow. No case/run IDs, titles, payloads, raw errors or outcomes are metric labels: active has at most four series and settled at most two. Counters reset on process restart; do not sum successive cumulative snapshots.

Stop or abort clears waiting cases immediately, while admitted calls remain running until they settle. Invocation closure removes only its own counts, preserving other concurrently running suites. Retained-only retry and `suite result` never add settled cases or reconstruct past queue activity. Diagnostic failure cannot change a report, mask its error, or replay work.

These counts exclude preflight, retained runs, approval backlog and distributed scheduler capacity. Owned SDK/direct local CLI counts belong to the configured owner pipeline. For a remote suite they describe the explicitly opted-in client orchestrator, not the remote owner or server workers. Incoming trace context does not remove case observations. Sampling does not suppress counts, but metrics require an explicitly configured destination; nothing is enabled or discovered from the environment automatically.

Distributed scheduling, PostgreSQL/container/Kubernetes qualification of these new instruments, dashboards and production acceptance remain separate open work.

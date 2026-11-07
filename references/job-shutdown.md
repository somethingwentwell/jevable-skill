# Stopping a local executable job

Direct SDK-owned CLI commands and exported workflow-app jobs own their explicit SQLite or PostgreSQL state. They require neither a service nor Jarness. SDK imports do not install process handlers.

The first SIGINT (Ctrl-C) or SIGTERM received while opening, using or closing that owner is retained. The executable writes one `draining` JSON diagnostic to stderr, stops further CLI-level dispatch, waits for already admitted work, and closes telemetry and storage. The settled operation can still write its ordinary JSON result to stdout. After cleanup the executable returns 130 for SIGINT or 143 for SIGTERM; the first signal wins.

Do not equate interruption with workflow failure or cancellation. A run may complete or reach an approval checkpoint during drain. Retain its UUID and read the saved result before any retry. Repeated signals do not force-kill, roll back, clear a lock, replay a request, approve work, or create cancellation authority. Explicit [cancellation](cancellation.md) remains a separate reviewed operation.

A signal during owner startup waits for initialization already in progress, then closes without admitting a new job. A signal during an operation allows that operation to finish; it does not abort its provider request. A draining diagnostic is not a closed receipt. Slow storage, a provider timeout or a non-settling injected adapter can delay shutdown; there is no forced deadline or permission to start a competing owner. Cleanup errors remain operational errors and cannot prove release or rollback.

Explicit remote/Docker owner clients do not install this local-owner lifetime and cannot shut down the selected service by closing the client. Dedicated [services](http.md), [suites](suites.md) and [watchers](watch.md) retain their own documented shutdown contracts. SIGKILL, crashes, power loss, stale-lock recovery, deployed PostgreSQL/image/Kubernetes processes and production provider/observability delivery require separate qualification. Private received OTLP paths do not establish production signal delivery.

# CLI receipts and lost output

The installed CLI, extracted management CLI and newly exported workflow apps share the same executable-output boundary. Ordinary JSON receipt shapes and pretty formatting are unchanged. `runs watch` and `caller stream` emit one compact JSON object per line, not a single aggregate JSON document. Runtime service/preview startup and stop receipts are separate JSON writes. A persistent server can remain alive after an undelivered readiness receipt; inspect its retained process/owner before starting a replacement.

## Limits and delivery

- Each complete stdout response or NDJSON record is limited to 32,000,000 UTF-8 bytes, including its newline. Each stderr write is limited to 64,000 bytes. These are decimal byte counts, not character counts or MiB.
- At most 64,000,000 output bytes can await writer completion. Native stdout/stderr writes wait for their callbacks; asynchronous broken-pipe errors are observed before the executable returns. Injected CLI writers may return a completion promise, which is also awaited.
- Oversized output is refused before its first write. No field omission, JSON truncation, silent record slicing, automatic file export, output-limit override or execution retry is performed. Previously delivered NDJSON records remain independent observations, not a complete event journal.
- These bounds cover encoded writes and pending delivery, not serialization heap, total lifetime stream size, recipient parsing/storage or business-effect success. A write failure can leave partial bytes at the receiver; discard incomplete JSON rather than treating it as a receipt. A successful writer callback is not proof that the recipient saved or processed it.

`help <command> --json` includes the shared `output` budgets. Normal operation and validation failures retain their existing meanings. Output size/encoding/write failure returns exit **5**, unless an admitted job's SIGINT/SIGTERM status takes precedence as **130/143**. This means the result is not confirmed delivered, not that a workflow necessarily remains uncertain or failed. The output handler never cancels, rolls back, replays, deletes an artifact or repairs storage. Original operation/owner guards remain authoritative.

When stderr is still writable, the bounded error reports `code: output-limit|output-encoding-failed|output-write-failed`, the channel, budgets and `output: not-confirmed-complete`. It includes no response, arguments, private path, raw writer error or cause. If stderr is also broken there may be no diagnostic; the exit code still reports failure. Existing explicitly private owner reads can expose business data in successful output; limits are not redaction or permission to share it.

## Inspect before another mutation

Retain run/request/artifact identities and reviewed revision/checkpoint hashes **before** dispatch. After output loss, use a fresh read-only operation against the same owner to inspect the original identity. While a service owns state, use its API instead of opening a competing direct runtime. A timeout, exit5, broken pipe or absent receipt does not prove that a database write, approval, notification, export or external effect failed.

For a completed/waiting run, `runs show <original-id>` and `runs events <original-id>` inspect retained state. A matching same-ID run receipt may be explicitly observed through the operation's documented retry semantics; never manufacture a new UUID or automatically resume/approve. For a written artifact, inspect its existing bytes and checksum before deciding whether another export is needed. Do not use `--overwrite` merely to replace a lost receipt. Unknown model/notification outcomes and stale owner locks keep their separate recovery restrictions.

Source tests cover byte/queue boundaries, unencodable values, synchronous/asynchronous writer errors, signal precedence, retained real CLI and exact-release completion, approval waits and artifacts. Qualify actual installed/extracted executables and native pipes separately; source callback doubles do not prove another platform, browser, Docker/Kubernetes, full descendant accounting or consumer delivery.

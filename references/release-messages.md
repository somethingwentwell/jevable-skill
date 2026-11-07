# Stable message admission for released workflows

Use `ReleaseMessageSession` when your application already authenticates incoming events and owns a Jevable runtime. A reviewed sender namespace plus a stable message ID maps to one run of one immutable released workflow. The runtime records the input, release and API-entry intent under that UUID; repeating a settled identical start observes the retained run, while changed input conflicts.

This adapter is the SDK foundation for a separately authenticated consumer; it does not itself verify signatures or start a listener. For explicitly requested signed intake, read [webhooks](webhooks.md): a separate opt-in Standard Webhooks v1 adapter reuses this stable identity without granting approval/control/read authority. Desktop, Jarness, Docker and an agent are not required.

## Owned SDK consumer

```js
import { readFile } from 'node:fs/promises';
import { LocalRuntime } from '@jevable/core/runtime';
import { ReleaseMessageSession } from '@jevable/core/releases';

// Review this immutable artifact; provision providers independently.
const snapshot = JSON.parse(await readFile('./release.json', 'utf8'));
const runtime = await LocalRuntime.open({ dataDirectory: './private-workflow-state' });
const messages = new ReleaseMessageSession(runtime, snapshot, 'orders/tenant-a');

// Your host authenticates the sender BEFORE this call.
// Retain the original message ID; never mint a new one on retry.
const request = { messageId: 'evt_001', input: 'A reviewed workflow input' };
const runId = messages.runId(request.messageId); // Offline, before submission.
const admission = await messages.start(request);
const checkpoint = await admission.completion;
// A checkpoint may be waiting/failed/cancelled, not completed.
// Your host owns acknowledgement, explicit controls and shutdown.
await runtime.close(); // Only after all original work has settled.
```

The Trigger must declare `api`. The adapter always selects `triggerMode: 'api'`; a manual-only graph refuses. The constructor validates and owns a detached release snapshot, without opening storage or executing. `release` returns detached `{id, sha256, revision}` metadata. `start` accepts only `{messageId, input}`: no source replacement, actor, sender namespace, run UUID, paused flag, approval, signature or trace-context overrides. Input uses the default bounded JSON policy (1,000,000 bytes, depth 64, 100,000 values); the runtime independently enforces its input schema and policy.

The port requires only `runReleaseAsync` and `show`, and is structurally compatible with `LocalRuntime` and `PostgresRuntime`. The adapter does not open or close either backend. New execution/fault tests cover private SQLite owners on Node 22.19. Actual PostgreSQL, installed-package, image, Kubernetes and wider-platform qualification of these new bytes remains pending; earlier runtime qualification is not automatically renewed.

## Identity and recovery

| Method | Meaning | Does not do |
| --- | --- | --- |
| `runId(messageId)` | Derive the UUIDv8 before sending | Read storage or prove authority |
| `start({messageId, input})` | Acknowledge creation or observe an identical retained submission | Retry, resume or approve |
| `show(messageId)` | Read the exact API run under the pinned release | Execute or expose a foreign release/caller/project/test run |
| `releaseMessageRunId(identity)` | Pure identity helper for SDK/CLI integrations | Verify an artifact, signature or deployed runtime |

The versioned tuple is JSON UTF-8 encoding of `["jevable.ai/release-message/v1", release.id.toLowerCase(), release.sha256, release.revision, source, messageId]`. Its SHA-256 first 16 bytes are encoded as UUIDv8 with RFC variant bits. Both hash pins require 64 lowercase hex characters. Source is 1–128 ASCII characters, starting with a letter or digit, followed by letters, digits or `._:/@+-`. Message IDs are 1–256 exact printable ASCII characters excluding spaces. Source/message case matters; nothing is trimmed or silently normalized. Validate any source-platform conversion in your host and keep it stable and unambiguous.

Input, credentials, timestamps, transport attempts and service instance are excluded. Changing input under the same identity conflicts instead of creating another run. Different sender namespaces or immutable releases intentionally derive different runs: retargeting to a new release is new execution authority, not recovery. Credential rotation does not change identity.

While the original execution holds its reservation, another `start` can return `busy`; use `show` to inspect the same identity. No automatic retry is installed. Completed, waiting, cancelled or uncertain retained runs are observed, never replayed. A lost creation acknowledgement may leave a durable paused checkpoint; a lost model reply may leave uncertain executing intent. Do not fabricate success, mint another identity or automatically continue either state. Existing guarded recovery/approval controls remain separate.

`ReleaseMessageRun` contains the original SDK `completion` promise and a detached admission-time run snapshot, both private owner data. Returned `message: {source, id}` is caller metadata, not a signed receipt or separately persisted message journal. Retain the reviewed identity in your consumer. The durable workflow UUID and retained evidence provide existing trace/log correlation; message IDs are not added to metric labels. Deterministic identity is not a mathematical collision guarantee, provider idempotency or exactly-once external effects.

## Offline CLI identity

Prepare a reviewed `identity.json`:

```json
{
  "release": {
    "id": "11111111-1111-4111-8111-111111111111",
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "revision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  },
  "source": "orders/tenant-a",
  "messageId": "evt_001"
}
```

These example pins are illustrative, not an executable release. Supply actual reviewed release pins before using the derived run ID.

```sh
jevable releases message-id identity.json --json
jevable help releases message-id --json
```

The command emits `format: "jevable.ai/release-message-id"`, `runId`, `execution: "not-run"` and `authentication: "not-verified"`. It does not print the sender/message identity. Input must be bounded regular UTF-8 JSON (4096 bytes maximum); final symlinks refuse. No owner, database, credentials, provider, network or output artifact is opened. Help projects the same consuming structural schema without reading a file.

An authenticated owner can deliberately use the UUID and exact pin in the existing [async HTTP submission](async-runs.md) contract, explicitly setting `triggerMode: "api"`. This does not add a webhook route: bearer/instance/release guards and reviewed startup capacity are still required. The helper neither submits nor acknowledges an external delivery.

## Verification scope

`tests/release-messages.spec.ts` covers fixed derivation, bounded identity, release/source separation, API-only admission, immutable copies, duplicates/change refusal, approval waits, clean owner replacement, live model reservation, lost creation acknowledgement and uncertain model intent. `tests/cli-release-messages.spec.ts` covers offline derivation, private identity non-disclosure, no owner/publication, parser-before-file refusal, regular-file admission and help/schema parity. These are source tests with synthetic models, not a real sender/signature, queue acknowledgement, provider or deployment acceptance.

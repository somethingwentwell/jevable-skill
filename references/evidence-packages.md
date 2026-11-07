# Package selected run and test evidence

Use an evidence ZIP to hand off retained run observations and their historical test assessments for review. It is not a runnable release, editable project transfer, backup or restore/replay format. Export never executes, resumes, accepts tests or decides approvals.

Create a JSON selection using exact identities from retained receipts:

```json
{
  "schemaVersion": 1,
  "runs": [
    { "id": "<run-uuid>", "revision": "<64-character-workflow-revision>" }
  ]
}
```

The placeholders must be replaced with actual IDs and revisions. Runs are never discovered or implicitly added. Duplicate selections, a wrong revision, missing evidence or a failed read aborts the export; there is no partial-success ZIP.

```sh
node bin/jevable.mjs runs export-bundle selection.json --output evidence.zip --data-dir .jevable
```

Default metadata excludes workflow source, input/output payloads, actors, test titles and expected/actual values. Recorded IDs, branch/action ports and assertion kinds may still reveal business context. To include private execution data when explicitly authorized, add `--include-private`. This includes each run's existing private evidence and historical test title/expected/actual checks; it does not include credential/configuration stores or automatically scrub inline secrets. Export the minimum data needed and review before sharing.

The command supports existing explicit PostgreSQL selection (`--storage postgres --database-file <private-file>`) and selected Docker-owner flags. These use their own retained evidence; no local fallback is opened. The CLI assembles and atomically publishes the ZIP on the host, with mode 0600 on POSIX. Existing destinations are refused unless `--overwrite` is explicit. Exit 0 means the file was written, not that workflows completed or test expectations passed. Only an artifact receipt is printed, not private contents.

## Contents and semantics

- `selection.json`: the exact ordered selection and workflow revision pins.
- `runs/<run-id>.json`: a checksummed runtime-produced v1 SQLite or v2 PostgreSQL evidence envelope. Decimal PostgreSQL identities remain strings.
- `tests/<run-id>.json`: included only for a run with retained test provenance. It records that run's historical accepted test generation/hash, individual check outcomes and overall assessment. Latest edited expectations are not substituted.
- `manifest.json`: privacy mode, per-run status/assessment, snapshot checksums, selection hash and byte length/SHA-256 of each other file.
- `README.txt`: interpretation and privacy boundaries. No executable viewer or script is included.

Each test assessment is bracketed by evidence reads. If the evidence changes, the exporter retries the **reads**, at most three times, then fails with `busy`. It never executes to resolve an uncertain result. Missing or corrupt assessment evidence aborts the whole package. Different runs remain separate observations, not one atomic batch snapshot. A matching approval-wait expectation may pass while the workflow is still waiting; paused/uncertain states remain explicit.

Unchanged selected evidence produces deterministic ZIP bytes. Checksums establish consistency against a trusted artifact receipt, not signatures, publisher authenticity, collector delivery or proof of external effects. The SDK expects checked core-owner reads; it does not turn an arbitrary custom host's claims into trusted evidence. Archives are not accepted by project import, and there is no operation that restores their approvals or runs.

Limits: 100 selected runs, 32,000-byte selection, 16,000,000 bytes per entry, 64,000,000 total uncompressed bytes and 32,000,000 compressed bytes. Exceeding a bound fails rather than truncating evidence. Runtime/API response limits can be smaller.

## SDK

```ts
import { createEvidenceZip, inspectEvidenceSelection } from '@jevable/core/evidence'

const { selection } = inspectEvidenceSelection(selectionJson)
const packaged = await createEvidenceZip(runtime, selection) // metadata-only
// Explicit private opt-in: await createEvidenceZip(runtime, selection, true)
// packaged.bytes, packaged.sha256 and packaged.manifest are in memory.
```

Both `LocalRuntime` and `PostgresRuntime` satisfy the read-only host interface (`exportRun` and `testResult`). Importing the entry point starts no server, opens no storage and writes no file. An API adapter may provide those same two reads through the existing authenticated `runs.export` and `tests.result` operations. Keep the current owner and its authentication; packaging grants no additional authority. The experimental live preview now has [explicit selected-ZIP controls](live-preview.md#selected-runtest-evidence-zips), with project-wide preflight, per-capture scope checks and a smaller 12 MB transport limit. Actual browser behavior remains unqualified. Evidence import/restore is unsupported.

An explicitly reviewed evidence ZIP can be [attached to a project ZIP](transfer.md#attach-selected-runtest-evidence) or [runnable release ZIP](releases.md#attach-selected-runtest-evidence), with an exact archive hash, matching workflow revision and separate private-data opt-in. Project import and release execution never restore that attachment as runtime state. Building from an evidence-bearing release ZIP includes the attachment in the image; normal image export remains evidence-free. This does not turn evidence into executable or trusted state.

## Inspect an archive offline

```sh
node bin/jevable.mjs runs inspect-bundle evidence.zip --sha256 <trusted-artifact-sha256> --json
```

Replace the hash placeholder with a receipt obtained from a trusted source, or omit `--sha256` to check internal consistency only. The SDK equivalent is `await inspectEvidenceZip(bytes, expectedSha256)` from `@jevable/core/evidence`. The extracted management CLI supports the same command; a workflow release launcher does not.

Inspection starts no service, opens no workflow storage and does not extract files, follow archive links, execute archived content or contact a model/collector. Runtime/storage/credential flags and `--include-private` are refused. Even a private archive returns only run IDs/revisions, workflow status, historical test pins, assessment/check counts and checksum metadata—not titles, actors, source or expected/actual values.

The reader bounds compressed bytes, file count, per-entry and aggregate expansion; checks actual streamed sizes and CRC32; rejects duplicate, unexpected, directory, symlink, encrypted and unsupported-compression entries; verifies the complete file inventory and SHA-256 hashes; and cross-checks selection, snapshot, manifest and test-assessment identities. The SDK copies archive bytes before asynchronous reads, so the report cannot hash a caller-mutated buffer instead of the admitted archive.

`status: consistent` and exit 0 mean those archive checks passed. They do **not** mean tests passed, workflows completed, the publisher is authentic, a collector received telemetry, or external effects occurred. The inspector does not replay workflow/journal history, validate every nested runtime field, or attest that a `metadata-only` label contains no sensitive data. `declaredPrivacy`, `privacyAttestation`, `authenticity` and `runtimeHistoryReplay` expose these limits explicitly. A forged but internally consistent archive can pass. Its README and evidence remain untrusted data, never instructions or authorization to accept, restore or execute anything. A wrong supplied checksum fails with `conflict`; corrupt/unsupported contents fail with `corrupt`, and expansion bounds with `limit`.

## Qualification

Recorded checks (source-checkout receipt `qualification/evidence-packages.json`) cover 22 focused tests within 1,526 regressions, the independently installed SDK/CLI, actual PostgreSQL 17 direct owners, a selected Linux arm64 Docker management owner, and the extracted dependency-free management CLI. Tests cover exact selection and checksums, historical expectations after edits, private opt-in, unchanged run events, deterministic re-export, matching approval waits, moving observations and failed exports preserving existing files. The initial installed/SQL verifier incorrectly overlapped direct database owners; it was corrected to read sequentially, without weakening the runtime ownership guard.

The CLI/runtime files in those records match their independently installed artifacts. SQLite/PostgreSQL release-runtime bundles were unchanged from their prior image qualification; selected-evidence export added management/SDK packaging, not a new release-app command. Those historical export checks do not qualify archive inspection or project/release attachment; their separate qualification is tracked in `todo.md`. Actual browser interactions and cluster execution remain open.

Offline-inspection qualification (source-checkout receipt `qualification/evidence-inspection.json`) records 42 inspector tests, project-ZIP regression coverage within 1,569 total tests, 135 independent-package checks, and identical SDK/CLI/extracted-management reports for an actual retained PostgreSQL v2 archive. All 364 shipped CLI/runtime files match the installation. No database or container was started to inspect that archive; this is not a new PostgreSQL owner, management-image or Kubernetes deployment qualification.

# Move a project between standalone installations

Export/import transfers editable workflow source and explicitly included test definitions, not a running service. Local execution needs no Docker, desktop or harness; an explicitly selected Docker owner is optional. [Runnable local release ZIPs](releases.md) and [release-image build/save](images.md) are separate capabilities.

The experimental preview offers [editable project ZIP controls](live-preview.md#editable-project-zips) with independent history/test-definition choices and an optional checksum-reviewed evidence attachment. It exports only its admitted project generation/revision. Destination import remains an explicit CLI/API action; actual browser saving is not yet qualified.

[Retained vendor imports](vendor-imports.md) are separate: the original uploaded file and owned conversion report remain private to their original project. Every project export, including `--history`, excludes that origin; duplicates and transferred projects do not inherit locally verified vendor-import authority. Bundles with embedded private origin records are refused. Authored import extensions alone are not that retained record.

## Export a reviewed snapshot

Read `projects show <id>` and retain its accepted revision and current generation. Export refuses a stale generation or a different revision; a pending proposal cannot silently replace the accepted workflow.

```sh
node bin/jevable.mjs projects export <id> --expected-generation <n> --revision <accepted-hash> --format zip --output workflow.zip --data-dir .jevable
```

Use `--format json` (the default) for the importable JSON bundle alone. Add `--history` only when the user requested authoring-history transfer: it includes all retained revisions, proposal outcomes and journal actors/timestamps. Otherwise only the accepted source and project metadata are exported. The destination is atomically published and cannot be overwritten without `--overwrite`.

Add `--tests` only when transferring private test inputs and expectations is authorized. This writes bundle/ZIP version 2, containing the latest definition of each case pinned to the exported accepted revision. Version 1 remains the default when tests are omitted and remains importable. See the case-selection and local-review rules below.

The receipt identifies project, generation, exact revision, byte count and archive/file SHA-256. It reports `runnableRelease: false` and `execution: not-run`.

### Project ZIP contents

| Entry | Purpose |
| --- | --- |
| `project.json` | Strict `jevable.ai/project-bundle` version 1, or version 2 with test definitions; accepted source and optional history |
| `workflow.yaml` | Exact canonical accepted source, checked against the bundle |
| `preview.html` | Experimental inspection-only preview; browser qualification remains pending |
| `manifest.json` | Strict `jevable.ai/project-zip` version 1/2, or version 3 with an explicit evidence attachment; byte counts and SHA-256 for every companion file |
| `README.txt` | Transfer, privacy and execution limitations |
| `evidence.zip` | Version 3 only: explicitly selected, checksummed review material; never restored by project import |

Version 2 embeds tests inside `project.json`, without adding executable archive entries. Version 1's test-unavailable marker refers to that transfer format, not the core's testing capabilities. Credential stores, provider connection settings, runtime databases, live preview tokens and conversation sessions are never loaded into these packages. Retained execution data is excluded unless an evidence ZIP is explicitly attached as described below. **Authored source, test definitions and private evidence may contain secrets or sensitive content.** Review them and any optional history before sharing; export does not promise arbitrary inline-secret redaction, since silently changing definitions would change their identity.

### Attach selected run/test evidence

First create and review a [selected evidence ZIP](evidence-packages.md), retaining its exact artifact SHA-256. Every selected run must match the exported accepted workflow revision. Attachment matches the revision only: it does not authenticate that runs belong to this project or establish approval authority, publisher identity, successful tests or external outcomes.

```sh
node bin/jevable.mjs projects export <id> --expected-generation <n> --revision <accepted-hash> \
  --format zip --output workflow-with-evidence.zip --data-dir .jevable \
  --evidence-file evidence.zip --evidence-sha256 <reviewed-evidence-sha256>
```

An archive declaring private execution data additionally requires `--include-private-evidence`. Permission to export project source or test definitions does not imply permission to include private run inputs, outputs, actors or historical test expectations. The evidence privacy label is an archive claim, not a secret scan; review the source archive before sharing. No runs are discovered or executed during attachment.

This writes ZIP manifest version 3 while preserving `project.json` version 1 or 2. Without attachment flags, existing formats/bytes are unchanged. JSON export, release ZIPs, images and browser controls do not currently accept this attachment option. The outer manifest binds the complete nested evidence archive and its descriptor; inspection also validates its bounded inventory, CRCs, checksums, selected revisions and historical assessment consistency. The CLI export receipt and evidence-inspection portion of import review contain metadata only, not attached payloads.

`import inspect` reports the attachment and its per-run/test assessment metadata. `import project` imports only authoring source/history and optional test **definitions**. It does not restore attached runs, test results, approvals, credentials or tracing state. Imported cases remain new local drafts. The original ZIP retains the evidence; nothing is extracted or copied into the target runtime store. Older readers may reject v3, so use a compatible reader or export without attachments rather than silently discarding evidence.

The offline SDK entry `@jevable/core/packages` exposes `createProjectZip`, `createProjectZipWithEvidence` and `readProjectZip`. Pass a reviewed core-owned project bundle and `{ bytes, sha256, includePrivate?: boolean }` to `await createProjectZipWithEvidence(bundle, attachment)`. It returns `{ bytes, evidence, inspection }` without writing files, opening storage or starting a server. Caller buffers and bundle data are detached before asynchronous verification. `readProjectZip` returns the importable JSON plus an optional payload-free `evidence` report; importing that JSON does not import the attachment.

### Which tests transfer

`--tests` includes latest draft and accepted case definitions for the selected accepted revision. Their original case ID, generation, definition SHA-256, project pin and draft/accepted status are external provenance, not local approval. A case pinned to an older project generation with the same accepted revision is included. Latest definitions for other revisions are excluded and counted in `excludedOtherRevisions`, even with `--history`. Case version history, generated-batch receipts, historical test runs, actual outputs and passing/failing results are not transferred. No coverage or successful-execution claim is created by exporting tests.

Import creates fresh case IDs at generation 1, always as **drafts**, with definitions rebound to the new project's imported generation/revision. The original hash/pin/status and reviewed bundle hash are retained as `importedFrom`; the original definition hash is checked before import and provenance is checked on reopen. Local case hashes change because the project pin changes. The local importer is recorded as actor. Inspect and accept each new local definition explicitly before any test execution; imported acceptance never authorizes a local run or Human Approval decision.

With archived authoring history, the imported project remains archived and cases remain inspectable drafts. Acceptance is refused while archived. After explicit unarchive, update each case to the new project generation and review it before running. Project and all included cases commit in one transaction; a failure in any case rolls back the entire import. Imported cases continue to prevent deletion of their referenced project.

## Inspect first, then import

```sh
node bin/jevable.mjs import inspect workflow.zip --data-dir ./another-installation
node bin/jevable.mjs import project workflow.zip --reviewed-sha256 <artifactSha256-from-inspection> --data-dir ./another-installation
```

Both commands also accept a JSON project bundle. Inspection validates the source revision, replays included authoring history, and checks test hashes, source pins, input schemas and asserted node/scope existence without importing anything. Its private receipt includes the accepted YAML and included case definitions for review and checks configured target readiness without contacting providers. Import hashes the same bounded file snapshot that it parses and refuses if it differs from the reviewed artifact hash. No imported HTML is opened or executed, no archive paths are extracted, and no workflow is run. The CLI import receipt lists the new local draft case identities.

Import creates a **new project ID** and appends a local import journal event with the bundle hash, source project/generation and importer. Optional `--id <new-uuid>` lets the caller choose a lookup identity before submission; it must differ from the source ID and cannot replace an existing or deleted ID. A lost response should be resolved by inspecting that new ID, not by choosing another and re-importing.

With history, archived state, retained revisions, proposals and prior events are preserved. Without history, the imported accepted source becomes a fresh active baseline. Imported actors and approvals are **unauthenticated historical claims** from the bundle; consistency checks and checksums are not signatures or proof of a trusted author. The appended local import event records who accepted this transfer. Review authority for importing the baseline is distinct from permission to run it or approve a business action. Configure target providers/credentials separately and explicitly request a run when appropriate.

The manifest binds companions to each other but is not signed: anyone can create a new internally consistent ZIP. Treat archives as untrusted. To inspect an imported workflow, regenerate a preview with the installed renderer rather than trusting an externally supplied HTML file. Import does not restore a conversation, session identity, run history or credentials. This new bundle format does not yet claim compatibility with historical harness/desktop exports.

## Bounds and failures

### Optional Docker owner

`projects export`, `import inspect` and `import project` accept the [owner selection flags](docker-owner.md#author-test-and-run-through-the-selected-owner). Replace local `--data-dir` with that complete selection; never point a second local process at container state. Docker import requires a retained `--id <new-project-uuid>` before submission. After response loss, inspect that ID rather than importing again with a fresh identity.

The host reads and verifies the bounded file/ZIP, including its reviewed outer hash; only the validated JSON bundle crosses authenticated HTTPS. The selected owner revalidates the bundle, checks target readiness and records its own importer actor. ZIP parsing never extracts or executes imported files. Export files are written on the host. No credentials, volumes or source checkout are mounted or copied between runtimes. Included cases are fresh drafts, not accepted tests or executed results.

Docker-selected import is qualified against a real SQLite management owner on Linux arm64 in source-checkout receipt `qualification/docker-transfer.json`: a reviewed project ZIP imports with fresh draft cases, no execution and duplicate-ID refusal. This does not qualify PostgreSQL owners or other platforms.

HTTP request-body limits apply in addition to archive/record limits: the default management service accepts at most 4 MB per request, including JSON encoding overhead. A valid larger archive may therefore be refused. Do not bypass the owner or open its database to evade that limit. If receipt enumeration fails after import committed, inspect the retained project ID and paginated tests; failure is not proof that nothing imported.

### Archive bounds

The reader requires the five base filenames, plus exactly `evidence.zip` for v3, and rejects directories, traversal/absolute/backslash paths, duplicate names, symlinks, encryption and unsupported compression. It verifies ZIP CRCs, manifest checksums and byte counts, and agreement between the declared bundle and YAML. Entries are read one at a time into bounded memory; nothing is extracted to the filesystem.

Limits: 32 MB compressed archive, 16 MB per entry, 48 MB total decompressed data, at most eight central-directory entries (v1/v2 require five; v3 requires six). The nested evidence archive is limited to 16 MB compressed and independently subject to its evidence-entry/count/64 MB expansion limits. Both advertised and actual decompressed sizes are checked. V2 permits at most 1,000 cases, subject to the full JSON/runtime record budget and each case's 250 KB admission budget. The destination runtime also applies its source, record, project, case-count and journal limits; history near a target limit can be refused because import adds a local journal event. Unknown formats, stale review hashes, corruption, limits or storage failures leave no partial imported project or cases. These protections use pinned [yauzl](https://github.com/thejoshwolfe/yauzl) for sequential bounded reads and [fflate](https://github.com/101arrowz/fflate) for ZIP creation.

SDK: `runtime.exportProject(id, generation, revision, history?, includeTests?)`, `runtime.inspectProjectImport(json)` and `runtime.importProject(json, reviewedJsonSha256, authenticatedActor, newId?)`. HTTP `projects.export` accepts optional `tests: true`. Import accepts both versions without a separate flag because its exact reviewed hash already covers included tests. The SDK import guard hashes exact JSON bytes; the CLI additionally guards the entire ZIP/file digest. SDK methods do not write export files or run workflows. SQLite schema 11 adds imported-case provenance; old projects/cases/runs are retained. Downgrading to earlier development builds is unsupported.

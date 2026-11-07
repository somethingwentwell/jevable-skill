# Review and retain a vendor workflow

Use this for Coze, Dify, n8n, Zapier, Make or Power Automate uploads. It is different from [project bundle transfer](transfer.md): an owned converter produces a draft; explicit creation retains the bounded original upload and conversion report atomically with its new project. No desktop/harness, server, provider call or Docker is needed for local commands.

## Preview and review

```sh
node bin/jevable.mjs import preview vendor.json --output draft.yaml --json
node bin/jevable.mjs validate draft.yaml --json
```

Preview returns `sourceSha256`, `conversionSha256`, `conversionRevision`, the owned converter/version, node mappings and validation diagnostics. The written draft is canonical Jevable source. The conversion fingerprint covers the source hash, converter identity, format/version/title, canonical converted YAML/revision and full mapping report. Do not fabricate or substitute these values.

Prefer to review the mappings with the graph? Write a separate offline HTML file:

```sh
node bin/jevable.mjs import preview vendor.json --output review.html --output-format html --json
```

Ask your desktop agent to open the reported file where supported. The branded Animate UI review starts on **Review conversion**, with counts, every approximate/unsupported mapping and expandable exact mappings. **Workflow** opens the left-to-right diagram at readable step scale; find converted step IDs in its search field, use Earlier/Later to inspect a long workflow, or Fit graph for the overview. **Details** contains compilation status, workflow identity and the private converted source. Keyboard tabs and Skip to workflow only navigate; they never select a run or approve anything. It does not start a server, create a project, check a provider, open a browser automatically or run anything. Default output remains YAML; use the first command to save an editable draft separately. HTML requires `--output`; existing files refuse unless you explicitly choose `--overwrite`.

The file includes the bounded conversion report and converted source, not the raw upload. Source labels and converted values can still be private: review before sharing. The network-disabled page pins both local scripts and its stylesheet with CSP, without a CDN or a frontend install. Its graph and conversion hashes are not vendor-equivalence, trusted-origin, execution or authenticity claims. Compilation diagnostics remain available even when an inspectable draft cannot run. The original report and viewer remain as a fallback if the UI enhancement cannot mount. Custom code and unsupported source connectors still require repair. The same offline renderer is exported as `renderVendorImportPreview(source, compilerLimits?)` from `@jevable/core` and `@jevable/core/preview`.

Review every approximate/unsupported mapping. Placeholder connectors do not execute, and a supported vendor trigger does not imply scheduler or signed webhook ingress. You may edit the draft to resolve gaps; validate again and retain its new exact revision. The reviewed draft must retain the converted workflow's metadata ID. Creation accepts a structurally admitted baseline, not proof of executable readiness, vendor equivalence or test success. Existing runtime admission still applies.

Retain a fresh project UUID before submission, then use the reviewed values:

```sh
node bin/jevable.mjs import vendor vendor.json --file draft.yaml \
  --title "Reviewed workflow" --id <retained-project-UUID> \
  --reviewed-source-sha256 <upload-hash> \
  --reviewed-conversion-sha256 <conversion-hash> \
  --reviewed-revision <validated-draft-revision> --data-dir .jevable --json
```

The core re-runs its converter and checks all three pins before creating anything. Caller-supplied origin/report/attribution overrides are refused. Original uploads containing recognizable credentials are refused; this is not a promise to detect every arbitrary secret or private value. Review the original file and authored draft before storing or sharing them.

Creation writes project and origin in one record/transaction, never executes a run or test, and establishes generation one as the accepted baseline. An identical request for the same ID returns that original creation snapshot even if the project was subsequently edited; inspect current state separately. Changed title, actor, source bytes, conversion hash or authored revision conflicts. Old/deleted/ordinary project identities cannot be adopted as imports. After uncertain transport, inspect the retained ID; do not create another identity. Converter upgrades may invalidate a creation retry's old conversion fingerprint; read the retained record first rather than silently re-convert/recreate.

## Inspect private provenance

```sh
node bin/jevable.mjs import show <project-id> --data-dir .jevable --json
node bin/jevable.mjs import show <project-id> --inspect --data-dir .jevable --json
```

Default output is metadata: project/original revision, source/conversion/request/record hashes, converter/format/version, timestamp and mapping counts. `--inspect` explicitly includes the original upload, converter YAML and complete report/creation attribution. Treat that output as private; do not include it in shared diagrams, previews, logs or evidence unless separately authorized. Null means a retained ordinary/duplicate/transferred project has no locally verified vendor origin; an unknown project is not-found. `execution: not-run` describes this operation, not whether the project has ever run.

Ordinary project/list/run reads do not expose the original upload, but authored YAML can still contain private values. Retained origin stays tied to the original revision through later proposals, renames and restores; it is not a new conversion of current accepted source. Hash consistency is not signed authenticity, exact vendor behavior or authenticated execution evidence.

## Explicit private evidence export

Review the metadata-only `import show` result and retain its exact `sha256` before requesting private bytes:

```sh
node bin/jevable.mjs import export-origin <project-id> \
  --reviewed-origin-sha256 <reviewed-origin-hash> --include-private \
  --output origin.zip --data-dir .jevable --json
node bin/jevable.mjs import inspect-origin origin.zip \
  --reviewed-sha256 <export-receipt-sha256> --json
```

Export requires explicit private-data consent and the immutable origin hash. It checks metadata before requesting the private record; stale review refuses. The output is an atomic private file (0600 where supported); an existing path is refused unless you explicitly request `--overwrite`. The receipt contains file checksums and inspection metadata, not the upload or creation attribution. Consent to create a file does not authorize publishing it.

The deterministic ZIP includes `origin.json`, `source.txt`, `conversion.yaml`, `conversion-report.json`, `README.txt` and a checksum manifest. It retains the original converter/report, never re-runs conversion or executes a workflow. `conversion.yaml` is the original converter draft: it is not necessarily the reviewed creation draft and is not the current accepted workflow. This is an **evidence package**, not a runnable application, project-transfer bundle, container image, credential export or database backup. Normal project/history/release exports remain private-origin-free.

Inspection is offline and in-memory: it never opens an owner, extracts files or restores trusted origin authority. Optional `--reviewed-sha256` checks the exact artifact against your retained receipt; without it, inspection checks internal consistency only. Output excludes the upload, full report, actor, request attribution and timestamp. Checksums are not signatures or authenticated ownership. Import/restoration of this archive is unsupported; never treat archived actor, request or review claims as local authority.

Version-one limits are six regular ZIP members, 32 MB compressed, 16 MB per entry and 48 MB total uncompressed (decimal bytes). Conversion identity inspection is separately bounded to 16 MB source, depth 128, 1,000,000 values, 10,000 nodes and 100,000 edges. These are archive-reading limits, not permission to execute under a larger compiler policy. Oversized/malformed, duplicate/path/link, inconsistent or substituted members refuse; there is no unbounded fallback.

## Transfer and deletion

Project JSON/ZIP exports exclude the original vendor upload and report, **including with `--history`**. Duplication copies source, not origin. A transferred project's import extension is only authored source/external claims; it does not create a locally verified vendor origin. Incoming bundles containing embedded private origin records are refused. Runnable releases/run evidence likewise consume authored source, not the private upload. The dedicated opt-in evidence ZIP above preserves the original bytes separately; trusted-origin transfer/restoration is not implemented.

Explicit guarded archived-project deletion also removes its embedded private origin. Existing retained run/release/test/generation reference guards still apply. Preserve the original authorized upload separately when required; a normal project export is not its backup. No automatic cleanup or cascading deletion is added.

## SDK, API and selected owners

`previewVendorImport(source, workflowLimits)` is an offline export of `@jevable/core` and `@jevable/core/runtime`. Both `LocalRuntime` and `PostgresRuntime` expose `createVendorImport(command)` and `vendorImport(projectId, inspect?)`; await PostgreSQL methods. The strict command has `id`, `title`, trusted adapter `actor`, `source`, `yaml`, `reviewedSourceSha256`, `reviewedConversionSha256`, `reviewedRevision`. Records preserve the converter/version originally used; reads verify retained identities without silently running a newer converter. SDK actor is attribution supplied by a trusted host, not user authorization.

Authenticated management operations are `import.preview`, `projects.import.vendor` with `command` (actor omitted/host-fixed), and `projects.import.vendor.show` with `id` and optional `inspect: true`. Body/response and runtime record budgets apply, including JSON overhead. Preview uses the default source policy; a more restrictive configured owner's creation may refuse it. Do not bypass that owner or its policy.

The new CLI commands share explicit [remote](remote.md), [Docker-owner](docker-owner.md) and [PostgreSQL](postgres.md) selectors. They never start another owner, use desktop state, fall back to local storage or provision a database. Exact-release and scoped preview APIs do not expose these authoring operations. Real PostgreSQL/deployed-owner/browser qualification is separate from host SQLite fixtures and method/journal-double tests.

For dedicated evidence, `@jevable/core/packages` exports `createVendorOriginZip(privateView, { projectId, reviewedOriginSha256, includePrivate: true })` and `inspectVendorOriginZip(bytes, reviewedArchiveSha256?)`. Obtain the separately authorized private view through the existing owner method/API; the pure packaging helpers grant no owner access. Export uses the selected owner, while `import inspect-origin` accepts no owner selector and stays offline. No new management operation, schema of owner authority or trusted-origin restoration route is added.

Source/read/report size bounds, structural/hash verification, guarded persistence and ordinary provider/runtime readiness all remain required. The current report admits at most 1,000 mapping rows; each upload and authored/converted source is subject to source limits, and the complete retained project is subject to the owner's record limit. Storage/review failure leaves no partial project. This does not authorize running the imported workflow, accepting proposals, approving business actions or delivering notifications.

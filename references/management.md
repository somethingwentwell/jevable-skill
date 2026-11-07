# Standalone management runtime

Use this when delivering the full authoring/execution CLI and management API, rather than a single immutable workflow. The **Jevable workflow runtime** owns these capabilities. No desktop, Jarness/harness, skill, ongoing agent conversation or source checkout participates in execution.

## Export and start

```sh
jevable runtime export --output jevable-management.zip
# Extract the reviewed archive into a fresh program directory.
# From that directory, with Node.js >=22.19.0 installed:
node bin/jevable.mjs capabilities
node bin/jevable.mjs --help
node bin/jevable.mjs doctor
node bin/jevable.mjs runtime token --output /private/config/service-token
node bin/jevable.mjs runtime serve --token-file /private/config/service-token --data-dir /private/jevable-data
```

The absolute paths above are operator-selected placeholders; create their private parent directories first. No `npm install`, Docker or persistent server is needed for direct CLI commands. Only explicit `runtime serve` starts a service. Use `node bin/jevable.mjs` wherever the other references say `jevable`.

The ZIP contains a management bundle, its metadata/notices, both exact-release runtime bundles, a CLI entrypoint, README and checksum manifest. Bundles externalize only Node built-ins. Export verifies runtime bytes against shipped metadata and refuses missing/inconsistent assets. The build rejects source inputs outside the core and Jarness/harness package inputs; it collects dependency licenses. No directory enumeration, configuration discovery or state-store opening is part of export.

For the separate SQLite-workflow/PostgreSQL HTTP-quota release profile, explicitly include its fourth runtime:

```sh
jevable runtime export --output jevable-management-coordinated.zip --runtime-rate-coordinator postgres
# After reviewing and extracting that archive:
node bin/jevable.mjs releases create <project-id> --runtime-storage sqlite --runtime-rate-coordinator postgres --data-dir /your/private/workflow-state
```

The default remains schema 1 with three runtimes and 12 ZIP members. Explicit selection produces schema 2 with `rateCoordinator: postgres`, four runtimes and 15 members; older schema-1-only readers must refuse it. Selection includes capability, not configuration: no quota connection, credential or database is bundled or initialized, and workflow storage is not converted. Direct workflow jobs require no quota server. Only explicitly configured HTTP serving uses the shared PostgreSQL quota backend; see [PostgreSQL rate limits](postgres-rate-limits.md). Missing optional assets refuse export; there is no fallback to a different runtime. Retain the fourth runtime's metadata and notices alongside its code.

Publication is atomic and refuses an existing destination, including a symlink. `--overwrite` explicitly replaces the output file. The receipt includes the archive SHA-256 and each selected runtime hash. Checksums detect corruption, not publisher authenticity; verify the archive through a trusted distribution channel. The launcher does not authenticate its own installed code. Keep every extracted file together: release creation/export and `doctor` need the sibling release assets. The extracted CLI can re-export the identical management ZIP without a checkout; repeat the explicit profile flag when re-exporting schema 2.

## Choose the right delivery

| Delivery | What it contains | What it can do |
| --- | --- | --- |
| `runtime export` | Full management program; no user state | Author, review, test, execute, manage models and export releases |
| `projects export` | Reviewed source and optional history/test definitions | Transfer a project for explicit import/review; not an executable app |
| `releases export` | Exact workflow and pinned runtime | Run that workflow independently; no general authoring API |

No projects, workflow source, credentials, inputs/outputs, saved tests, run journals or conversation state are included in the management ZIP. Migrate selected projects through the reviewed project-transfer commands; provision credentials and providers independently. Do not mount another application's data directory or run competing direct/service owners. Local SQLite and explicitly configured PostgreSQL retain their existing single-owner rules.

The management API exposes more authority than a release-only API. Each bearer token holder has owner-level access, including approval and private inspection. Follow [HTTP service setup](http.md): loopback HTTP by default, explicit certificates and public-origin validation for direct HTTPS, no forwarded-header trust. Export neither starts a listener nor authorizes external exposure. Browser preview remains experimental and browser-unqualified.

## Qualification and remaining Docker work

The independent-package check extracts this archive into a fresh directory with no `node_modules`. It exercises the bundled CLI, project review/execution, saved tests, persisted approval after service drain, metadata-only evidence, loopback management API and configured-model retries/OTLP against local fixtures. It also exports pinned releases and checks repeat export/overwrite behavior. It does not call real model providers.

This ZIP is not itself a Docker image. [Management image packaging](management-images.md) adds explicit `runtime build-image` and `runtime save-image` commands with separate identity receipts. [Docker owner commands](docker-owner.md) add default SQLite or explicit PostgreSQL service startup, inspection, graceful stop and clean restart from the host CLI, plus ordinary authoring/import/release selection. They require a separately installed local Docker CLI/engine; release packaging stays on the host, never through a Docker socket mounted into the workflow container. The PostgreSQL managed-image profile has separate local fixture evidence; production database operations, additional platforms, actual browser behavior and Kubernetes remain open. Do not transfer release-image receipts to the management bundle or image.

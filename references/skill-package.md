# Install and deliver the standalone agent skill

## Install from a git clone

This is the primary supported way to install the skill. You need git, Node.js 22.19+ and npm, plus network access to the npm registry for the dependency install.

```sh
git clone https://github.com/somethingwentwell/jevable-skill <approved-skill-directory>/jevable
cd <approved-skill-directory>/jevable
npm ci --omit=dev
node bin/jevable.mjs capabilities
node bin/jevable.mjs run examples/echo.yaml --input examples/echo-input.json --data-dir /your/private/workflow-state
```

- The repository includes prebuilt `dist/` output, so there is no build step. `npm ci --omit=dev` installs only the runtime dependencies pinned in `package-lock.json` into `node_modules/` inside the checkout. It does not install anything globally, start a service or run workflows.
- Without that step, `node bin/jevable.mjs` stops with a message naming the missing package and the install command.
- Clone directly into the agent's user-approved skill directory, or clone elsewhere and place the checkout there yourself. Do not overwrite an existing installation. `SKILL.md` sits at the checkout root.
- Install from this repository. Do not substitute `npm install @jevable/core`: the npm registry package of that name is published from a different repository and is not this checkout.
- Rebuilding `dist/` is only needed after changing `src/`. It needs the full development dependencies: `npm ci && npm run build`. See [development](development.md).

A clone and an exported skill ZIP carry the same skill instructions, examples and CLI commands. A ZIP bundles the CLI with its dependencies, so it runs without `npm install`. That is useful for handing the skill to an agent without npm or network access.

## Export a self-contained skill ZIP

`skill export` creates the agent-facing distribution: instructions, references, examples, editable Archify diagrams/screenshots, notices and the bundled Jevable CLI. It is not a workflow release, image or developer checkout.

```sh
node bin/jevable.mjs skill export --output /your/output/jevable-skill.zip
# Optional: also carry the separate SQLite-workflow/PostgreSQL HTTP-quota runtime.
node bin/jevable.mjs skill export --output /your/output/jevable-skill-coordinated.zip --runtime-rate-coordinator postgres
```

Choose a fresh destination; `--overwrite` deliberately replaces an existing file. Export is offline and writes only that artifact, atomically with owner-only permissions. It does not install the skill, open workflow storage, start services, contact providers, use Docker or apply Kubernetes resources. No Jarness or desktop discovery, imports, credentials or fallback are used.

## Use an extracted distribution

Verify the delivered archive SHA-256 against a separately trusted release channel before extraction or execution. The included `manifest.json` lists file sizes/hashes and the selected bundled runtime identities; these are consistency checks, not signatures or publisher authentication. Retain all notices. Proprietary distribution terms remain unpublished; export does not authorize publication.

Default export stays schema 1 with three runtimes. Explicit `--runtime-rate-coordinator postgres` selects schema 2, adds exactly three files (the fourth runtime, metadata and notices), and marks both outer and nested management manifests with `rateCoordinator: postgres`. No quota configuration, credentials, state or bootstrap permission is included. Use `releases create <project-id> --runtime-storage sqlite --runtime-rate-coordinator postgres` to select it later; workflow history remains SQLite. Direct jobs do not need PostgreSQL. See [PostgreSQL rate limits](postgres-rate-limits.md) for explicitly configured HTTP serving. Missing optional assets refuse export rather than silently changing the selected runtime. Older schema-1-only inspectors must refuse schema 2.

With a separately trusted Jevable CLI already installed, inspect before extraction:

```sh
node /trusted/jevable/bin/jevable.mjs skill inspect /your/download/jevable-skill.zip --sha256 <trusted-archive-sha256> --json
```

The public SDK equivalent is `inspectAgentSkillZip(bytes, expectedSha256?)` from `@jevable/core/packages`. Both check the exact inventory for the declared schema, ZIP CRCs, every file hash, the matching nested management manifest and all selected program/metadata identities. Schema 2 requires the fourth runtime's SQLite storage identity and PostgreSQL quota marker; mixed generations or undeclared optional assets are refused. Input is copied before asynchronous parsing; no archived code or instructions are imported or executed. No state, credentials, service or network is opened, and no files are extracted or installed. A runtime-only trusted management CLI can inspect a skill ZIP even though it cannot export one without authoring resources.

The inspector supports this version's curated package layout. Unknown/missing/duplicate members, links, directories, unsafe paths and inconsistent identities are refused. Limits are 65 MB archive, 64 MB expanded total, 32 MB per entry and 4 MB per public resource. Oversize input/entries return `limit`; a supplied archive-hash mismatch returns `conflict`. Invalid structure/content returns `corrupt`; malformed hash arguments return `invalid-command` (CLI invalid input exits 2 before file reads). CLI operational refusal exits 1; success exits 0.

Supply a regular archive file, not stdin or a pipe. On POSIX the inspection reader opens nonblocking with final-symlink refusal and verifies the opened file's regular type before reading; an unconnected FIFO is rejected without waiting for a writer. This is scoped to `skill inspect`, not a change to ordinary explicitly selected workflow/file paths. Input refusal neither rewrites the target nor repairs permissions. Archive consistency cannot prove input provenance; Windows/special-filesystem and broader platform qualification remain separate.

`status: consistent` is not a signature, trusted publisher identity, code audit or privacy attestation. Recomputing an archive's own hash is not a separately trusted release channel. The report excludes resource/code contents; it cannot determine whether authored instructions or resources contain secrets. Inspection does not authorize later installation or execution. Do not run the downloaded CLI merely to check its own trust.

Extract into a fresh directory. The archive contains one `jevable/` root with `SKILL.md` and `bin/jevable.mjs`. From that root, with Node.js 22.19+:

```sh
node bin/jevable.mjs capabilities
node bin/jevable.mjs validate examples/echo.yaml --json
node bin/jevable.mjs run examples/echo.yaml --input examples/echo-input.json --data-dir /your/private/workflow-state
```

No npm install, source checkout, server or Docker is needed. A run writes the independently selected state directory; do not use another application's state or credentials. Use an absolute CLI path from an agent working in another directory. Opening instructions/examples does not authorize execution, model cost, approval or deployment. To make the skill discoverable, manually place its `jevable/` directory in the agent's user-approved skill directory without overwriting an existing installation. Export never performs that step.

The included `agents/openai.yaml` supplies Jevable's Codex skill-list label and a suggested build-and-preview prompt. It declares no browser, MCP or desktop dependency and does not change installation or execution permissions. Other agents can use `SKILL.md` without interpreting this optional host metadata. Same-app opening still depends on the browser tools exposed in the current session; metadata does not enable a browser or establish a successful preview.

The included CLI can validate, author, review, execute, inspect and export with the core's existing capabilities and limitations. The SDK-only npm entry points are not supplied by this ZIP; use the core package for direct SDK imports. Browser controls remain experimental; actual Codex qualification covers only the recorded model-free journeys in README, not full no-guidance/accessibility/provider acceptance. Diagram screenshots are documentation, not workflow execution evidence. The explicitly curated `assets/saved-tests-approval.gif` is a real model-free browser screenshot sequence, not continuous video or a native Jev demonstration. `assets/import-preview.gif` animates an actual CLI conversion receipt, and `assets/import-to-app.gif` animates verified synthetic local import-to-app receipts; neither is a continuous screen recording or hosted-provider qualification. `assets/full-delivery.gif` is a separate illustrated capability path, not a continuous execution or proof of its individual steps. Use a matching trusted inspector for the delivered curated inventory; an older inspector may correctly refuse newly added resources rather than silently accept them.

## Keep artifact roles distinct

| Delivery | Purpose | Needs the skill after delivery? |
| --- | --- | --- |
| `skill export` | Agent instructions/resources plus bundled CLI | This **is** the authoring skill distribution |
| `runtime export` | Node-only management CLI/API, without skill resources | No |
| `releases export --format zip` | One reviewed runnable workflow application | No |
| `releases build-image` / `save-image` | Container image/archive for a reviewed workflow runtime | No |
| `releases export-kubernetes` | Reviewed deployment manifests, not an applied cluster | No |

The skill ZIP uses a fixed public-resource inventory rather than sweeping the checkout; user-added files, source, dependencies, roadmaps, qualification reports, workflow state, tokens and histories are excluded. Resources must be regular package-owned files without symlinks. Missing resources or inconsistent runtime bytes refuse before output publication. A runtime-only ZIP/image deliberately cannot re-export the skill: reinstall the trusted authoring distribution rather than attaching to another application. Re-exporting an unchanged extracted skill produces the same ZIP bytes; repeat the explicit profile flag for schema 2. The public SDK exporters accept `createManagementZip(readBytes?, { rateCoordinator: 'postgres' })` and `createAgentSkillZip(readBytes?, { rateCoordinator: 'postgres' })`; omitting options preserves default delivery.

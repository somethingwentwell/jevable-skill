# Discover this installed CLI

For shared UTF-8 output limits, native write completion, exit5 and lost-receipt recovery, read [CLI output](cli-output.md). Help JSON reports the same fixed budgets; they do not alter normal receipt shapes or authorize replay.

For input-file structures, use `schemas list` / `schemas show <schema-id>` and read [offline schema discovery](schemas.md). These are projections of core input validators, not replacements for semantic validation, ownership, review or authority.

Use the standalone authoring/management CLI itself to find its commands and parser options:

```sh
jevable help
jevable projects --help
jevable help projects run
jevable runs recover --help --json
jevable runtime start --help
```

In a skill installation, prefix the command with `node <skill-directory>/bin/jevable.mjs`. In an extracted management ZIP, use `node bin/jevable.mjs`. Both use the same dispatcher and bundled help, without Jarness, desktop, a source checkout, server startup or Docker.

`help` lists commands; a group lists its descendants. A complete command reports its actual parser's positional count and string/boolean options, including implicit telemetry and pagination options. It also reports the shared **presence, finite-choice, integer and argument-format rules** applied before reading files, credentials, state or services: unconditional/conditional requirements, exactly-one choices, together groups, fixed selections, literal values, numeric bounds/defaults and identity formats. `runtime start` shows separate local and Docker profiles, not a union that can be mixed. `--json` returns discovery metadata with `schemaVersion: 4`, `execution: not-dispatched`, `variants[].requirements.rules`, `requirements.positionals`, operator notes, guide routes and exit meanings. Version 2 added `choices`; version 3 added `integer`; version 4 adds `format` rules and positional formats. Consumers must check the version rather than treating every non-fixed rule as a flags array. Normal operation/error receipt schemas are unchanged. Bare `--help`/`-h` retain the longer overview.

Help accepts only the command path and optional `--json`. Do not append a workflow, run ID, credentials, storage selection or other execution options. For example, use `jevable help run`, not `jevable run workflow.yaml --help`. Unknown or mixed requests fail with exit 2 before dispatch, rather than reading a file or partially executing a command. Help never opens runtime storage, reads credentials, contacts an endpoint or inspects a Docker engine.

For example, `help projects accept` identifies `--expected-generation`, `--proposal-id` and `--revision` as required; `help runs recover` requires a retained `--request-id` and `--checkpoint-sha256`. `credentials set` chooses exactly one protected file or stdin. Selected Docker/HTTPS execution requires a retained run UUID, while direct local execution can create one. Missing/empty required strings and selected invalid combinations fail with exit 2 before I/O, including before opening local state. These same executable rules generate the help; they are not a separate documentation-only requirements list.

Finite choices are exact and case-sensitive: `storage`/`runtime-storage` use `sqlite|postgres`; execution selection uses `local|docker` (lifecycle/start profiles narrow this); project export uses `json|zip`, release export uses `zip`; template language uses `en|zh`; image platform accepts `linux/arm64|linux/amd64`; notification preparation uses `requested|decided|expired|cancelled`. A choice rule has `{kind: "choices", flag, values}` and applies only when supplied; it does not imply a default or make the flag required. Exporting a container image uses separate `build-image`/`save-image` commands, not `--format container`. Accepted platform values do not mean both are qualified. Human approval actions, model/provider IDs and destinations are configuration/workflow-specific and are not global enums.

An integer rule has `{kind: "integer", flag, minimum, maximum, encoding: "canonical-unsigned-decimal", defaultValue?}`. Bounds are inclusive. Supply plain decimal digits, without a sign, exponent, decimal point, whitespace or leading zeros (except `0` itself). Unsafe integers are refused. Generation guards for existing projects/tests/releases start at `1`; provider/credential creation permits `0`. Tests `--generation` starts at `1`. Numeric defaults describe the consuming mode only: they never supply flags, enable pages, create an owner, start a service or run anything.

Useful numeric distinctions:

| Flag/mode | Inclusive range | Default when applicable |
| --- | --- | --- |
| Local service/preview `--port` | 0–65535 | 0 (ephemeral) |
| Docker startup `--port` | 1024–65535 | Required; no default |
| Docker `--memory-mb` / `--cpus` | 128–65536 / 1–64 | 512 / 1 |
| Docker `--wait-ms` | 0–60000 | 10000; zero is a bounded observation, not forced shutdown |
| Service `--drain-wait-ms` | 1–60000 | 5000 |
| Doctor `--timeout-ms` | 1–30000 | 3000 |
| Request/selected-owner/suite `--timeout-ms` | 1–3600000 | 30000 |
| Watch `--interval-ms` / `--duration-ms` | 100–60000 / 1–3600000 | 1000 / 60000 |
| Paged history `--limit` | 1–200 | 100; still requires explicit `--page` |
| Test generation `--limit` | 1–32 | 12; creates drafts only |

Format rules are `{kind: "format", flag, format}`; positional formats are `{index, format}` in `requirements.positionals`, with zero-based indexes. They check shape without changing case, trimming values or inventing missing identities. UUID acceptance follows the core's UUID schema (including uppercase, nil and max forms); retain the exact submitted identity. Hashes must be exactly 64 lowercase hexadecimal characters with no `sha256:` prefix. Docker container/network IDs have the same character shape but are IDs, not checksums, and shortened IDs are refused.

| Input | Format |
| --- | --- |
| Project, run, release, test, generation and notification-request positional IDs | `uuid` |
| `--id`, `--new-id`, `--proposal-id`, `--project-id`, `--request-id`, `--attempt`, `--instance-id`, `--confirm-delete` | `uuid` |
| Revisions, `--from`/`--to`, `--sha256` and named reviewed checksum flags | `sha256` |
| `--container-id`, `--network-id` | `docker-id` (full 64-character lowercase hex) |
| Record-list `--after` | `uuid` |
| Provider-audit `--after` | `audit-sequence`: canonical decimal 0–9223372036854775806, kept as a string |

Workflow/file paths, template IDs, credential references, provider/model/destination IDs and approval actions are not UUIDs and are not reinterpreted as such. Presence, supported values and correct format are not full validity or permission. Rules do not certify a hash's contents, reviewed generation identity, file schemas, UUID existence/ownership or every mutually exclusive option; they never read a file to discover its schema or a credential to authorize a command. `--confirm-delete` must still match the exact archived project; a formatted checksum must still match reviewed bytes. Existing operation/owner checks remain authoritative. Invalid values fail with exit 2 before I/O, with bounded messages showing allowed shapes/values/bounds, not echoing submitted values. Follow the routed guide for actual input shapes and reviewed values; `capabilities` describes implemented scope, not a deployment/provider qualification. The discovery path index is curated and checked against the actual dispatcher; command options/counts still come directly from that dispatcher, not a parallel flag catalog. The full command/value-schema/reference/operator-walkthrough audit remains open.

Some important distinctions:

- Owner/storage selection is admitted before workflow, suite-manifest, trace-viewer, database, telemetry or credential reads. These checks reuse the consuming mode's pure selector rather than starting a service to discover its mode. Valid selection still requires file contents, reviewed identities and authorization checks afterward. Suites retain explicit loopback HTTP; general remote management remains explicit HTTPS. Portable preview rejects runtime options before reading its workflow source. No discovery, implicit owner startup or fallback is added.
- Direct local storage, a reviewed Docker owner and an explicit HTTPS endpoint are mutually exclusive. Selecting an owner never starts/restarts it or falls back to local storage. Retain IDs and guards after uncertainty.
- Approval inbox and notification history require explicit pages on both backends; other paginated PostgreSQL lists require `--page`. Follow cursors even if a task page is empty.
- Recover settles already committed model evidence without calling the provider, continuing to the next node or approving a gate. Pause/cancellation/notification-abort submission success is not proof of termination or external-effect rollback.
- Export/build only packages artifacts. It does not run workflows, publish an image, mutate a cluster or qualify deployment. Preview remains experimental and browser-unqualified.

Npm/skill distributions include the guide files named by help. Extracted management ZIPs provide the same inline grammar and operational notes but do not include those reference files. Exported immutable workflow apps have a different command interface: use their integrity-protected generated README and `node app.mjs info`, not this authoring command index.

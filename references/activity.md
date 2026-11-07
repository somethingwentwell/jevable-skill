# Retained installation activity

Use `jevable activity report` for a bounded read of the selected Jevable owner's retained projects, proposals, import origins and run outcomes. This is not account-wide usage, provider billing, a lifetime counter or an OpenTelemetry delivery probe. It requires neither Jarness nor desktop; direct local SDK/CLI reads need no server or Docker.

```sh
node bin/jevable.mjs activity report --data-dir ./state --json
node bin/jevable.mjs activity report --storage postgres --database-file /private/database.json
```

When a service owns the data, select that owner with the normal [Docker owner](docker-owner.md) or [HTTPS endpoint](remote.md) flags instead of opening a competing direct owner. The command does not discover/start an owner or fall back to another store. It outputs JSON without saving a file. PostgreSQL observes all bounded pages internally; there is no `--page` selection or caller-supplied namespace override.

Both `LocalRuntime` (`@jevable/core/runtime`) and `PostgresRuntime` (`@jevable/core/storage`) provide `await runtime.activityReport()`. Those entrypoints also export `activityReportSchema`, `ActivityReport` and `ACTIVITY_LIMITS`. Authenticated management accepts the strict empty-field request `{"operation":"activity.report"}`. Unwrap its ordinary result envelope and preserve the client's instance guard. This is owner authority, not a delegated account statistics permission. Exact-release and preview APIs do not expose installation totals; never substitute a management service to widen their scope.

## Interpret the result

| Field | Meaning |
| --- | --- |
| `projects.total`, `active`, `archived` | Currently retained projects, not every project ever created. |
| `projects.origins` / `imports` | Mutually exclusive retained origins: authored, duplicated, imported project bundle or owned vendor conversion. Import retries do not add another project. Transfers exclude vendor origin; a transferred project is a project-bundle import, not another vendor conversion. |
| `proposals.pending/accepted/rejected` | Current states of proposals in all retained project histories, including imported external claims. |
| `proposals.importedHistory` | Proposals created before that project's local import boundary. These are not locally authenticated authoring/review actions. |
| `proposals.localActions` | Propose/accept/reject ledger actions after the local import boundary. Locally rejecting an imported pending proposal counts as a local reject, but not a local proposal. Restore/rename/archive are not proposals. |
| `runs.total` / `byStatus` | Unique retained run IDs and their recorded checkpoint states; includes saved-test and release runs. Retrying the same ID is not another run. `executing` means retained intent, not proof of a live worker; a wait may be expired without having been settled. |
| `runs.links` | Project-pinned, release-pinned or unlinked run counts. Test runs are included in their corresponding link, not counted twice. |
| `runs.triggerSelection` | Explicit API entry versus omitted historical local entry; omission is not a webhook/schedule/public ingress. |
| `runs.firstRetainedRun` | Earliest retained creation time, then case-normalized UUID and exact stored-key tie-break. Preserves finer timestamp fractions and shows the current recorded status, not the initial status or first-ever deleted run. Null for an empty run store. SQLite's historical exact case-sensitive keys remain distinct; the report does not rename/merge them. |

The result includes storage kind, observation time and explicit scope/consistency/privacy/non-execution labels. It excludes project titles, workflow source, proposal/run payloads, actors, credentials and provider/model routes; the first run's ID, revision and time are intentionally included. Review that identifying metadata before sharing. Deleted projects cease contributing, even though their deletion receipts remain. Archival preserves counts. Omitted data is not inferred from other installations, source trees or services.

## Consistency and refusal

All source ledgers/checkpoints and retained model-result evidence are read and verified without dispatching a provider, run, approval, notification or telemetry export. PostgreSQL holds the same single-owner domain gate as typed mutations across project reads and all run pages. SQLite verifies that captured project generations/run IDs/checkpoint fingerprints still coexist at the final synchronous observation. A concurrent change yields `conflict`, never mixed or silently retried totals. Observe again only when appropriate; do not stop active work merely to obtain a report.

At most 1,000 projects, 100,000 runs and 1,000,000 project-history counts are admitted, with existing owner/source/record/event limits still enforced. A lower configured PostgreSQL run limit also applies. Capacity, corruption, ownership loss or closed state fail the whole report without truncating. This is not a SQL snapshot for arbitrary out-of-band database writers; bypassing the runtime's ownership/journal contract is unsupported. Reports may wait behind admitted PostgreSQL work and are not a cheap live dashboard endpoint.

This interface has source/domain tests and standalone package qualification. Real PostgreSQL activity, current-byte deployed/container profiles and production observability remain separate gates. The existing selected-token [usage report](usage.md) answers a different question and does not replace this report; neither report is a bill or synthetic Collector probe.

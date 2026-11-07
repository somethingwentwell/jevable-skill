# Projects, revisions and review

Use these commands for saved authoring; they operate on the core's own private SQLite directory without an HTTP server, harness or desktop. Use `--data-dir` consistently. `projects show` includes retained source and the authoring journal: it is private inspection, not a redacted public export.

## Create, propose, review

```sh
node bin/jevable.mjs projects create examples/echo.yaml --title 'Echo app' --data-dir .jevable
node bin/jevable.mjs projects show <project-id> --data-dir .jevable
node bin/jevable.mjs projects propose <project-id> --file candidate.yaml --expected-generation 1 --data-dir .jevable
node bin/jevable.mjs projects diff <project-id> --from <accepted-hash> --to <candidate-hash> --data-dir .jevable
```

Creation makes the supplied source the initial accepted baseline; do it only when the user authorized that initial workflow. It does not execute anything. Proposing a change retains a new revision without moving the accepted pointer. Source admission allows some drafts that cannot compile or run: acceptance is a review decision, not proof of validation, provider readiness or successful execution. Run `validate` and `check` on the exact candidate before reporting those properties.

Inspect the source, diff and returned proposal ID/revision. Use the current generation from `projects show`, not an assumed value. Only with the user's authority to accept this exact change:

```sh
node bin/jevable.mjs projects accept <project-id> --proposal-id <proposal-id> --revision <reviewed-hash> --expected-generation <current-generation> --data-dir .jevable
```

Use `projects reject` with the same identity arguments to reject it. A proposal whose base no longer matches the accepted revision cannot be accepted; it can still be rejected. Rebase by authoring a new proposal against the current accepted workflow and review it again. Never silently refresh a stale generation and retry acceptance.

`projects diff` returns `approvalChanges`, a sorted list of existing approval gate names requiring acknowledgment. This version conservatively lists all prior gates for any execution-spec change, including routing changes that could bypass a node left intact. Presentation-only or workflow-name-only edits do not require acknowledgment. Explain the impact and get authorization; only then pass the exact list, for example `--ack-approvals '["review"]'`. Do not populate it automatically to bypass a conflict. Duplicate, missing or extra names are refused. An actor string records attribution by the host; it does not establish that a human approved the edit. A future remote adapter must authenticate and authorize callers separately.

## Run an accepted snapshot

```sh
node bin/jevable.mjs projects run <project-id> --revision <accepted-hash> --expected-generation <current-generation> --input examples/echo-input.json --id <stable-run-uuid> --data-dir .jevable
```

Execution must be separately within the user's request. The run retains the canonical workflow, revision, project ID and reviewed generation. Later proposals, acceptance, rename or archive cannot retarget that run. `runs show` verifies it against historical accepted state; it does not dispatch work. Reusing the same run UUID with the same original project/generation/revision/input returns retained evidence even after the project changes. Different identity or input conflicts. File-based `run` remains available for explicitly authorized unsaved execution but cannot claim a saved project's approval provenance.

## Lifecycle and recovery

- `projects rename <id> --title <title> --expected-generation <n>` changes the display title.
- `projects archive|unarchive <id> --expected-generation <n>` changes archive state. Archived projects cannot start new runs or accept new proposals; existing waiting runs retain their approval lifecycle.
- `projects restore <id> --revision <previously-accepted-hash> --expected-generation <n>` restores only an accepted historical revision, with the same `--ack-approvals` rule. Rejected/pending-only revisions cannot be restored.
- `projects duplicate <id> --revision <accepted-hash> --title <title> --expected-generation <n> [--new-id <uuid>]` copies a previously accepted snapshot into a fresh project. Its first journal event retains source-project/generation/revision attribution. Runs, proposals, credentials and original history are not copied. Pending-only and rejected-only revisions cannot be duplicated. The copy is independent even if its source project is later removed.
- `projects delete <id> --expected-generation <n> --confirm-delete <same-id>` permanently removes an archived project's source, revisions, proposals and authoring journal. Use only with explicit user authority for that exact deletion and a prior backup if recovery is needed. There is no undo command. Deletion is refused if **any** run references the project, including completed runs: there is no cascading evidence deletion. Unrelated projects, runs and credentials are untouched. This is logical deletion, not secure erasure of SQLite pages, WAL or backups.
- `projects deletions` inspects durable deletion receipts (ID, last generation, accepted hash, actor and time; no workflow source). Deleted IDs cannot be reused. After a lost delete response, inspect this receipt before assuming failure.

Every authoring mutation commits its journal event and revisions together. A response lost after commit is not an invitation to repeat a mutation with a new generation: inspect `projects show` and its journal first. `create --id <uuid>` and `propose --proposal-id <uuid>` allow the caller to choose lookup identities before dispatch. Repeated IDs conflict rather than create another record; this is not an automatic idempotent-success protocol.

Current retention limits: 1,000 projects, 100 distinct revisions and 1,000 changes per project, 10,000 deletion receipts, plus the runtime's record-byte limit (16 MB by default). Exhaustion fails without a partial write. Automated retention/pruning is not implemented. SQLite schema 3 added the project table, schema 4 added deletion receipts, and schema 5 admits import journal events. Migrations from versions 1–4 retain existing runs, provider data and authoring history. Preserve a backup before upgrading; downgrade is not supported. Project/run journals are consistency-checked, not cryptographically tamper-proof evidence. See [transfer.md](transfer.md) for optional history export/import and its external-evidence boundary.

SDK equivalents on `LocalRuntime`: `projects()`, `project(id)`, `editProject(command)`, `diffProject(id, from, to)`, `deleteProject(id, expectedGeneration, authenticatedActor)`, `projectDeletions()` and `runProject(id, expectedGeneration, reviewedRevision, input, { id: runId })`. Import `Project`, `ProjectCommand` and `ProjectDeletion` types from `@jevable/core/runtime`. No module import starts a server.

## SDK integration example

Save this as `app.mjs` in a Node.js 22.19+ application with a trusted local installation of `@jevable/core`, then run `node app.mjs`. The package is not publicly published yet; use your verified build/tarball, not a guessed registry download. An extracted skill or runtime-only ZIP supplies a CLI, not this npm SDK installation.

This synthetic echo example creates fresh private state, accepts only its initial fixture baseline, and explicitly executes one run. It requires no model, HTTP listener, Docker or desktop agent. It records request IDs before dispatch and revision pins before execution, closes its owner, then reads the original run through a new owner. Reusing the original run request returns retained evidence, not another execution. The state directory remains for inspection; no automatic deletion or stale-lock recovery is performed.

```js
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSource } from '@jevable/core';
import { LocalRuntime } from '@jevable/core/runtime';

const source = JSON.stringify({
  apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow',
  metadata: { id: 'sdk-echo', name: 'SDK echo' },
  spec: { inputSchema: { type: 'string' }, nodes: {
    start: { type: 'trigger', config: { modes: ['manual'] } },
    result: { type: 'output', config: { value: '${{ inputs }}' } },
  }, edges: [{ from: 'start', to: 'result' }] },
});
assert.equal(validateSource(source).status, 'valid');
const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-sdk-app-'));
const request = { projectId: randomUUID(), runId: randomUUID(), input: 'Hello from the SDK' };
await writeFile(join(dataDirectory, 'request.json'), JSON.stringify(request), { mode: 0o600, flag: 'wx' });
let pins;
let first;
const runtime = await LocalRuntime.open({ dataDirectory });
try {
  const project = await runtime.editProject({ operation: 'create', id: request.projectId,
    title: 'SDK echo', yaml: source, actor: 'example:trusted-local-host' });
  pins = { generation: project.generation, revision: project.acceptedRevision };
  await writeFile(join(dataDirectory, 'pins.json'), JSON.stringify(pins), { mode: 0o600, flag: 'wx' });
  first = await runtime.runProject(request.projectId, pins.generation, pins.revision,
    request.input, { id: request.runId });
  assert.equal(first.state.status, 'completed');
  assert.equal(first.state.output, request.input);
} finally {
  await runtime.close();
}

const reopened = await LocalRuntime.open({ dataDirectory });
try {
  assert.deepEqual(await reopened.show(request.runId), first);
  const events = await reopened.events(request.runId);
  const retained = await reopened.runProject(request.projectId, pins.generation, pins.revision,
    request.input, { id: request.runId });
  assert.deepEqual(retained, first);
  assert.deepEqual(await reopened.events(request.runId), events);
  console.log(JSON.stringify({ status: retained.state.status, projectId: request.projectId,
    runId: request.runId, revision: pins.revision, retainedWithoutReplay: true, dataDirectory }));
} finally {
  await reopened.close();
}
```

A real UI supplies its own authenticated actor and explicit review/execution authority; copying this actor string does not authenticate a user. Keep one owner per state directory and await admitted work before closing it. Creation accepts a baseline; later edits use propose/diff/review/accept and their exact guards above, not recreation or unguarded source replacement. After response loss, inspect the retained identities before deciding on a retry. If an outcome is uncertain, do not create another run ID, remove its lock or silently replay it. For nonblocking integration, use [asynchronous admission](async-runs.md); for an already service-owned directory, use its [HTTP client](http.md), not a competing SDK owner.

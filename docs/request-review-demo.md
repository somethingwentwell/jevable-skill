# Request review — verifiable runbook

[README](../README.md) · [繁體中文 README](../README.zh-TW.md)

This runbook walks the model-free [Request review](../examples/request-review.yaml) example end to end: inspect the graph, run a routine request, run a request marked for review, inspect the waiting approval, optionally approve it, and read the same run back.

## What this example is — and is not

- **`needsReview` is a boolean branch, not AI sensitivity detection.** The `route` Rule reads `inputs.needsReview` from your input JSON. `true` goes to Human Approval; `false` goes straight to Output. Nothing classifies the message text.
- **The example messages do nothing outside the run.** "Please send the onboarding guide." does not send a guide or an email. "Please change my billing account." does not touch any billing system. Both strings are only returned as run output.
- **No model, network provider, Docker or account is involved.** Every node is a trigger, Rule, Human Approval or Output.
- Version `0.1.0-alpha.1` is an early implementation, not a production release.

Input files:

| File | Content | Expected path |
| --- | --- | --- |
| [`examples/request-review-routine-input.json`](../examples/request-review-routine-input.json) | `{"message":"Please send the onboarding guide.","needsReview":false}` | `start → route (false) → directResult`, status `completed`, exit 0 |
| [`examples/request-review-sensitive-input.json`](../examples/request-review-sensitive-input.json) | `{"message":"Please change my billing account.","needsReview":true}` | `start → route (true) → review`, status `waiting`, exit 3 |

## Install and choose the CLI

**Primary path: a git clone with its runtime dependencies.** You need git, Node.js 22.19+ and npm, plus npm registry access for the one-time install. The clone ships prebuilt `dist/`, so there is no build step.

```sh
git clone https://github.com/somethingwentwell/jevable-skill
cd jevable-skill
npm ci --omit=dev
```

Run every command below from the checkout root. If you skip `npm ci --omit=dev`, `bin/jevable.mjs` stops with a message naming the missing package and the install command.

**Alternative: an extracted skill ZIP.** Run the same commands from the root of an extracted, verified skill ZIP (its `jevable/` directory). The bundled CLI there needs no `npm install`. See the [installation guide](../references/skill-package.md).

Use an absolute path for `bin/jevable.mjs` when your agent works in another directory. Confirm the installed grammar before relying on any command:

```sh
node bin/jevable.mjs capabilities
node bin/jevable.mjs help run --json
```

## Steps

Choose one **new, private** state directory for all steps, and generate two run UUIDs up front so you can read them back later:

```sh
STATE=/your/private/request-review-state      # fresh directory, not another app's state
mkdir -m 700 "$STATE"
ROUTINE_ID=$(node -e 'console.log(crypto.randomUUID())')
REVIEW_ID=$(node -e 'console.log(crypto.randomUUID())')
```

### 1. Show the graph (executes nothing)

```sh
node bin/jevable.mjs validate examples/request-review.yaml --json
node bin/jevable.mjs preview examples/request-review.yaml --output /your/output/request-review-preview.html
```

`validate` checks structure and bindings. `preview --output` writes a self-contained, inspection-only HTML file; open it in a browser to see the five nodes left to right. Neither command starts a run. For the interactive live viewer, see [live preview](../references/live-preview.md).

### 2. Run the routine input

```sh
node bin/jevable.mjs run examples/request-review.yaml \
  --input examples/request-review-routine-input.json \
  --id "$ROUTINE_ID" --data-dir "$STATE" --json
```

Expect exit code **0**, `"status": "completed"`, `"output": "Please send the onboarding guide."` and steps `start`, `route` (port `false`), `directResult`.

### 3. Run the input marked for review

```sh
node bin/jevable.mjs run examples/request-review.yaml \
  --input examples/request-review-sensitive-input.json \
  --id "$REVIEW_ID" --data-dir "$STATE" --json
echo "exit=$?"
```

Expect exit code **3** and `"status": "waiting"` at `"nodeId": "review"`, with an `attemptId` and an `expiresAt` 24 hours later. Exit 3 means *waiting for a person*: not success and not failure.

### 4. Show the approval

```sh
node bin/jevable.mjs approvals list --page --data-dir "$STATE" --json
node bin/jevable.mjs approvals show "$REVIEW_ID" --data-dir "$STATE" --json
```

`approvals show` returns the review request (`"title": "Review this request"`, `"input": "Please change my billing account."`), the current `attemptId` and `deadlineStatus`. Reading an approval does not decide it. Follow `approvals list` pagination even when a page is empty but has a next cursor.

### 5. Optional: approve explicitly

Only do this if you intend to make the decision; do not approve merely to finish the example. Read [approvals](../references/approvals.md) first.

```sh
node bin/jevable.mjs approvals decide "$REVIEW_ID" \
  --attempt <attemptId from approvals show> --action approve \
  --data-dir "$STATE" --json
```

The run continues through `review` (port `approve`) to `reviewedResult` and completes with the message as output. Approving changes nothing outside this run: no billing account is changed. With this release, `--action reject` instead ends the run with `"status": "failed"`, `"code": "approval-rejected"` and exit code 4.

### 6. Read the same run back (executes nothing)

```sh
node bin/jevable.mjs runs show "$ROUTINE_ID" --data-dir "$STATE" --json
node bin/jevable.mjs runs show "$REVIEW_ID" --data-dir "$STATE" --json
node bin/jevable.mjs runs events "$REVIEW_ID" --data-dir "$STATE" --json
```

`runs show` and `runs events` read retained state from a separate process. The review run reports `waiting` if you skipped step 5, or `completed` if you approved it. Running `run` again without the same `--id` starts a **new** run instead of reading this one.

## Acceptance checks

- Routine run: exit 0, `completed`, output equals the routine message, `route` took port `false`.
- Review run: exit 3, `waiting` at `review`, no output yet.
- `approvals show` lists the same run ID and attempt ID as the waiting run.
- `runs show` from a new process returns the same run IDs, revision and status.
- No model call, network request, email or account change happens on either path.

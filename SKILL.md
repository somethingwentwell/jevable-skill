---
name: jevable
description: Build, revise and preview Jevable workflow applications with typed Decision (Jev) nodes, rules, approvals, validation and import review using the standalone Jevable CLI.
---

# Jevable

Build an entire runnable workflow application, not merely YAML or inspection HTML. The agent authors and reviews; the **Jevable workflow runtime** executes, persists approvals/results and emits telemetry independently afterward.

Use `node <skill-directory>/bin/jevable.mjs`. Local/offline use needs neither Docker nor an authoring server. If the skill directory is a git clone, run `npm ci --omit=dev` there once before first use: runtime dependencies are not committed, but prebuilt `dist/` is, so there is no build step. An extracted skill ZIP already bundles its dependencies. If the CLI reports a missing runtime dependency, that install is the fix. See [installation](references/skill-package.md#install-from-a-git-clone). Do not substitute another package or installation. Never fill a missing capability by attaching to Jarness, a desktop/harness service, their credentials or data. No parent-checkout imports, workspace links, automatic source synchronization or harness mounts. Future desktop integrations consume this core, never the reverse; deployed workflow containers do not need the skill or agent.

## Choose the actual installed capability

Start with `capabilities` and command-scoped `help <complete command path> --json`. Help takes no execution options or input values. Read [CLI discovery](references/cli-help.md) for profiles and [schemas](references/schemas.md) when preparing structured input. Use only commands present in this distribution; a planned README command is not evidence of availability.

For output budgets, exit5 or a lost CLI receipt, read [CLI output](references/cli-output.md). Output failure does not prove a write failed; inspect retained identities without replay or automatic overwrite.

Read the guides relevant to the requested operation **before using it**, not every guide by default. Each carries its mode's exact flags, guards, limits and qualification scope. For setup diagnosis use [doctor](references/doctor.md); for an unbuilt distribution use [development](references/development.md), and for explicitly authorized crash-lock recovery read [owner recovery](references/owner-recovery.md). Never use a harness fallback. A healthy installation is not workflow/provider readiness or permission to repair a lock.

## Author, review, test, deliver

1. For creation/editing, read [authoring](references/authoring.md). Prefer deterministic Rules for known logic, Decision (Jev) for typed judgment and LLM nodes for writing. Keep approvals before effects and expose unsupported integrations. Decision returns through `next`; a following Rule routes the typed answer. Inspect `templates list` / `templates show` for starters.
2. Write the candidate and `validate <file> --json`. Compilation validates structure/bindings, not execution. `check <file> --data-dir <private-directory>` checks configured readiness without contacting a provider. Schemas, validation and readiness do not authorize a run.
3. For saved projects, read [projects](references/projects.md). Creation establishes an accepted baseline; later changes use proposal → exact diff review → acceptance. Preserve generation/proposal/revision guards. Acceptance and approval-gate acknowledgments require authority for that exact change, never automatic stale-guard refresh or gate acknowledgment. Acceptance does not authorize execution.
4. For cases read [testing](references/testing.md), and for batches [suites](references/suites.md). Generation creates schema-derived drafts without model calls; expectations need review, not assumed correctness or branch coverage. Accept the exact generation before execution. Report assertion assessment separately from workflow status: a matching approval wait is not completion.
5. When execution is requested, retain a stable run UUID before dispatch, the exact revision and any mutation request IDs. A local job can use `run <file> --input <file> --id <uuid> --data-dir <private-directory>`. Inspect with `runs show` / `runs events`; these do not execute. Saved projects/releases use their guide's pinned execution path.
6. Deliver the requested artifact with its revision, diagnostics, execution status and limitations. A graph, project ZIP, validated draft, runnable release and tested app are different outcomes.

For model setup read [providers](references/providers.md) before configuring a route, rotating/clearing credentials or changing retries. AI templates require explicit provider/model selection. `execution.maxAttempts > 1` can spend additional credits; never increase it, switch providers or create another UUID to bypass uncertainty. For native Jev/Laya read [System One Decisions](references/systemone.md): use a matching `systemone` route and explicit reviewed `systemone-v1` contract. Noul returns `noul` without separate confidence; do not invent confidence or silently substitute another route.

## Execution boundaries

- For a delivered release, offer the same app in two local modes: `serve` for its optional browser interface and authenticated API, or one-shot headless `run`/`show`/authorized `decide` jobs. Read [releases](references/releases.md#local-interface-and-headless-jobs) first. Both modes use the exact release and retained state; stop the service before taking over its SQLite directory with direct commands. The interface needs a listener while in use; automatic job wakeup needs a separately qualified local event source.
- Use one storage owner. While a service owns state, operate through its API, not a competing direct runtime. An HTTP acknowledgment, timeout, recorded intent or `executing` status does not prove completion or a live worker.
- Preserve uncertain work. After response loss/restart, inspect the retained identity and follow that operation's retry semantics. Never automatically redispatch, resume, change IDs or delete evidence to bypass an uncertain external outcome.
- Human Approval returns `waiting` and exit code 3. Read [approvals](references/approvals.md) before inspecting/deciding; decide only the actual attempt with authority for that particular business action. Testing permission is not approval permission. Follow pagination even on empty pages with a next cursor.
- Before stopping a job read [job shutdown](references/job-shutdown.md). Normal signals drain admitted work; repeated signals do not force shutdown. For workflow cancellation read [cancellation](references/cancellation.md): a request is not final cancellation, rollback or replay permission.
- Before Step/Continue/Pause or saved-response recovery read [controls](references/control.md). Recovery only settles an already committed response; it never calls the provider or runs downstream nodes. Missing/uncertain responses and locks are not recoverable by inventing a new request.
- Keep credentials out of workflow files, arguments, chat, URLs, HTML and reports. Use protected files/configuration. Private source/input/output/evidence inclusion needs separate explicit consent; checksums establish consistency, not authenticity or external success. Overwriting/deleting existing artifacts needs scoped intent; otherwise choose a fresh destination.

## Preview beside the conversation

For diagram-only review read [portable HTML](references/preview.md); it includes source and cannot execute. For requested interactive preview/testing read [live preview](references/live-preview.md), especially its desktop-agent section, **before startup or browser actions**. The live viewer talks to the real scoped runtime; it remains experimental and actual browser qualification is separate from controller tests.

Use the readiness receipt's URL/instance/project/revision and retain the original foreground process and tab. With a permitted embedded browser tool, show the viewer beside this conversation rather than merely printing a URL. Respect an explicit browser choice. Detect tools exposed in this session; a product name does not guarantee a browser or access to another environment's localhost. An HTML source editor is not a rendered viewer.

For reopening an existing project, use the live-preview guide's explicit reviewed project-pin file/hash instead of creating a fresh preview project. Require its current generation and accepted revision to match the selected source. Attachment only reads; stale/archived/missing pins or an uncertain read never authorize create, restore, retarget or execution. After owner replacement, explicitly review the new owner instance before starting a new gateway for the same unchanged project pin; never relax the old gateway's instance guard.

Use the credential-free URL only. Normally the user chooses their protected preview key file in the viewer (local read, no file upload), or enters the token in its password field, then chooses Connect. File selection alone does not connect. For explicitly requested no-key-entry local preview, read the live-preview automatic-local-connection boundary first: select `--token-env VARIABLE_NAME` or a private token file, and opt into `--auto-connect` only with user consent to local-machine trust. The browser mints its own project-only session; never read/display/inject the owner key. Docker/remote gateways refuse these options. Never print/inject tokens, copy cookies or substitute an owner bearer. Report readiness, queued/visible opening, authenticated pin-checked graph and authorized test results separately. Opening/refreshing is not Run, test acceptance, Continue or approval authority.

Keep the exact viewer available for feedback; use documented tab retention where exposed. Do not shut it down at reply end or silently replace a stale session. If opening is unavailable, explain and give the URL; do not claim same-app success. Browser-policy refusal is binding: no alternate browser, tunnel, cloud publication or disabled checks as a workaround. Creation without a preview request may offer visual review, but does not silently start a persistent service.

## Import and delivery modes

| Requested result | Read before operating | Important distinction |
| --- | --- | --- |
| Bring an existing workflow | [Vendor imports](references/vendor-imports.md); [n8n support example](references/import-support.md) | Review gaps and upload/conversion/draft hashes. Private origin is retained; importing never runs. |
| Editable project JSON/ZIP | [Transfer](references/transfer.md) | History/tests are separate private opt-ins. Imported tests remain new drafts; history/evidence never restores approval authority. |
| Independently runnable app ZIP | [Releases](references/releases.md) | Immutable accepted revision and runtime pins; Node-only execution needs neither npm nor the skill. Packaging is not provider readiness. |
| Workflow container image/archive | [Images](references/images.md) | Build/save have distinct receipts and explicit context/base/tag. No automatic push/deployment, tag replacement or untrusted archive load. |
| Full authoring CLI/API ZIP | [Management runtime](references/management.md) | Different from a workflow release; configure state/credentials independently. |
| Full authoring container | [Management images](references/management-images.md) | Owner authority differs from exact-release service; no Docker socket or harness mounts. |
| Agent-facing skill ZIP | [Skill package](references/skill-package.md) | Fixed resources and bundled CLI, not global installation or service startup. |
| Selected run/test evidence ZIP | [Evidence packages](references/evidence-packages.md) | Not a runnable app, backup, restored state or replay instruction. |
| Kubernetes export or Minikube/k3s trial | [Kubernetes](references/kubernetes.md); full management: [Management images](references/management-images.md#kubernetes-management-export) | Single-owner PostgreSQL workflow runtime, not the skill. `releases export-kubernetes` packages one immutable workflow; `runtime export-kubernetes` packages management using its distinct receipt. Offline `bin/kubernetes-preflight.mjs` checks explicit snapshots; no cluster access. Export does not apply/publish/attest. Dedicated kubeconfig/context and deployment/execution authority remain separate. |

Inspect private attachments before sharing. A release ZIP's Dockerfile carries attached evidence into an image built from it; disclose private inclusion. Ordinary release-image builds are evidence-free. Scoped Minikube success does not qualify k3s, forced failure, HA or production.

## Services, integrations and inspection

Select only the relevant mode; SDK calls need no server unless the chosen integration uses HTTP. Startup, connection, execution and exposure are separate actions, never implicit fallbacks.

| Task | Required guide and boundary |
| --- | --- |
| Persistent JSON API/direct HTTPS | [HTTP](references/http.md): explicit token/TLS/origin and one owner; ordinary serving is not HTML preview or public ingress. |
| Existing HTTPS owner/HTML gateway | [Remote](references/remote.md): endpoint/instance pins and separate gateway token; closing a viewer never stops that owner. |
| Local/Docker managed-owner lifecycle | [Docker owner](references/docker-owner.md): image/container/owner pins and private configuration; selection never starts/replaces an owner. |
| Explicit PostgreSQL storage | [PostgreSQL](references/postgres.md): private database configuration, no SQLite fallback; retain decimal event IDs as strings and required pages. |
| Foreground asynchronous submission | [Async runs](references/async-runs.md): retain IDs/keep owner alive; receipts/observation are not a queue or automatic retry/resume. |
| Workflow API entry | [API trigger](references/api-trigger.md): explicit trigger mode, not a public webhook. |
| Signed event intake | [Webhooks](references/webhooks.md): opt-in Standard Webhooks v1, one immutable API release, separate private signing keys and bounded async drain; start-only, never approval/read authority or automatic resume. |
| Caller/reviewer delegation | [Grants](references/grants.md): separate permissions and instance/release/token pins; never substitute owner authority or infer approval permission. |
| Startup HTTP limits | [Rate limits](references/rate-limits.md): refusal does not prove earlier attempts failed; no retry/restart to evade quota. |
| Approval notification history/delivery | [Notifications](references/notifications.md): configured destinations and retained request pins; uncertainty is not redelivery permission. Acknowledgment is neither human delivery nor approval; abort is not rollback. |
| Explicit website-account integration | [Account](references/account.md): separate issuer/private session and human authorization, not workflow/provider credentials; no automatic browser, uncertain exchange/revocation retry or credential erasure. |
| Run observation | [Watch](references/watch.md): metadata-only reads; disconnect/owner change never authorizes reconnect, replay or recovery. |
| Journal snapshot/export | [Evidence](references/evidence.md): private payloads/actors excluded by default; review identifiers before sharing. |
| Retained token usage | [Usage](references/usage.md): missing is unknown, not zero; not a bill/account total or proof of no charge. |
| Project/import/outcome totals | [Activity](references/activity.md): local retained scope; intent is not a live worker and imported history is not local action. |
| OpenTelemetry configuration/baggage | [Telemetry](references/telemetry.md): reviewed destinations/trust/credentials/baggage, no ambient discovery. Export failure never retries execution. |
| Requested HTTP admission diagnostics | [Transport access telemetry](references/http-access-telemetry.md): explicit startup opt-in, fixed reached predicates, independent roots; syntax admission is not grant authority or durable audit. |
| Synthetic signal-delivery probe | [Collector probe](references/collector-probe.md): explicit send without workflow execution; acknowledgment is not dashboard visibility. |
| Offline Collector gateway package | [Collector gateway](references/collector-gateway.md): config/references only, not installation/exposure or received-signal proof. |
| Navigate to retained trace | [Trace navigation](references/trace-navigation.md): reviewed credential-free viewer and authorized ID sharing, no automatic opening/probing. |
| Optional development dashboards | [Observability](references/observability.md): separately authorized Compose startup/private volumes, not production qualification. |

## Handoff

Return exact artifact/revision/run identities and observed outcomes, distinguishing validation, readiness, assertion assessment, waiting, completed and uncertain states. State which viewer/process remains available, what needs a user decision, and which requested integrations or qualification remain unavailable. Never spend credits, send notifications, approve effects, deploy or publish merely to complete a demonstration.

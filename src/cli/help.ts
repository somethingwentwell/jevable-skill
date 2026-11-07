import { CORE_VERSION } from '../capabilities.ts'
import { httpRateLimitsSchema } from '../http/rate-limits.ts'
import { cliFlagRequirements, cliPositionalRequirements, cliArgumentFormatDescription, type CliFlagCondition } from './requirements.ts'
import { asyncRunRequestSchema, asyncReleasePinSchema, asyncRunPolicySchema } from '../http/async-runs.ts'
import { releaseMessageIdentitySchema } from '../releases/messages.ts'
import { releaseWebhookConfigSchema } from '../releases/webhooks.ts'
import { previewProjectPinSchema } from '../preview/project-pin.ts'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { CLI_OUTPUT_LIMITS } from '../process/cli-output.ts'

/** Discovery paths only. Flag/count declarations come from the dispatcher, not this index. */
export const CLI_HELP_PATHS = [
  'capabilities', 'doctor', 'kubernetes capacity', 'validate', 'preview', 'check', 'run',
  'runtime lock inspect', 'runtime lock recover',
  'runtime lock inspect-recovery', 'runtime lock complete-recovery',
  'schemas list', 'schemas show',
  'skill export', 'skill inspect',
  ...['start', 'inspect', 'stop', 'restart', 'build-image', 'save-image', 'export-kubernetes', 'export', 'token', 'serve', 'status', 'request', 'submit', 'observe'].map(x => `runtime ${x}`),
  ...['list', 'show', 'deletions', 'create', 'propose', 'accept', 'reject', 'diff', 'rename', 'archive', 'unarchive', 'duplicate', 'delete', 'export', 'restore', 'run'].map(x => `projects ${x}`),
  ...['list', 'show', 'create', 'export', 'build-image', 'save-image', 'export-kubernetes', 'message-id'].map(x => `releases ${x}`),
  ...['list', 'show', 'history', 'erasure-review', 'erase', 'erasure', 'create', 'generate', 'generations', 'generation', 'edit', 'accept', 'archive', 'unarchive', 'run', 'result'].map(x => `tests ${x}`),
  ...['create', 'inspect', 'run', 'result', 'coverage'].map(x => `tests suite ${x}`),
  ...['list', 'show', 'events', 'export', 'traces', 'resume', 'cancel', 'step', 'continue', 'pause', 'recover', 'watch', 'export-bundle', 'inspect-bundle'].map(x => `runs ${x}`),
  ...['list', 'show', 'decide'].map(x => `approvals ${x}`),
  ...['destinations', 'prepare', 'send', 'show', 'list', 'abort', 'automatic-status', 'automatic-show', 'automatic-list'].map(x => `approvals notify ${x}`),
  ...['list', 'set', 'audit', 'discover'].map(x => `providers ${x}`),
  ...['status', 'set', 'clear'].map(x => `credentials ${x}`),
  ...['token', 'issue', 'show', 'list', 'revoke'].map(x => `grants ${x}`),
  'reviewer decide',
  'caller start', 'caller read', 'caller cancel', 'caller checkpoint', 'caller control', 'caller stream',
  ...['list', 'show', 'render'].map(x => `templates ${x}`),
  ...['preview', 'inspect', 'project', 'vendor', 'show', 'export-origin', 'inspect-origin'].map(x => `import ${x}`),
  'usage report',
  'activity report',
  'telemetry probe',
  'telemetry export-gateway',
  ...['prepare', 'inspect', 'link', 'exchange', 'status', 'revoke'].map(x => `account ${x}`),
] as const

export class CliHelpInputError extends Error {}
export interface HelpRequest { path: string[]; json: boolean }

/** Only bare command paths are help requests. Never ignore a submitted input or service option. */
export function parseHelpRequest(argv: string[]): HelpRequest | undefined {
  const prefix = argv[0] === 'help'
  const markers = argv.filter(x => x === '--help' || x === '-h')
  if (!prefix && !markers.length) return undefined
  if (markers.length !== (prefix ? 0 : 1) || argv.filter(x => x === '--json').length > 1)
    throw new CliHelpInputError('Use help <command path> [--json] or <command path> --help [--json].')
  const path = (prefix ? argv.slice(1) : argv).filter(x => !['--help', '-h', '--json'].includes(x))
  if (path.some(x => !/^[a-z][a-z0-9-]*$/u.test(x)))
    throw new CliHelpInputError('Help accepts only a command path and --json; omit input files, credentials and execution options.')
  return { path, json: argv.includes('--json') }
}

export interface HelpGrammar { positionals: number; strings: readonly string[]; booleans: readonly string[] }
export class CliCommandHelp extends Error {
  constructor(readonly variants: { profile: string; grammar: HelpGrammar }[]) { super('Command help') }
}

export function commandHelp(argv: string[], positionals: number, strings: readonly string[], booleans: readonly string[]) : never {
  if (argv.length) throw new CliHelpInputError('Help accepts a complete command path, without positional values or execution options.')
  throw new CliCommandHelp([{ profile: 'command', grammar: { positionals, strings, booleans } }])
}

function argumentLabel(path: string) {
  if (path === 'releases message-id') return 'release-message-identity.json'
  if (path === 'kubernetes capacity') return 'workload.yaml'
  if (path === 'skill inspect') return 'jevable-skill.zip'
  if (path === 'grants issue') return 'reviewed-command.json'
  if (path === 'reviewer decide') return 'retained-decision.json'
  if (path === 'caller start') return 'retained-start.json'
  if (path.startsWith('caller ')) return 'run-id'
  if (path.startsWith('grants ')) return 'grant-id'
  if (path === 'import show' || path === 'import export-origin') return 'project-id'
  if (path === 'import inspect-origin') return 'vendor-origin.zip'
  if (path === 'import vendor' || path === 'import preview') return 'vendor-file'
  if (['validate', 'preview', 'check', 'run', 'projects create'].includes(path)) return 'workflow.yaml'
  if (path === 'usage report' || path === 'runs export-bundle' || path === 'tests suite create') return 'selection.json'
  if (path.startsWith('tests suite ')) return 'suite.json'
  if (path === 'runs inspect-bundle') return 'evidence.zip'
  if (path.endsWith('save-image')) return 'image-receipt.json'
  if (path === 'runtime request') return 'operation.json'
  if (path === 'runtime submit') return 'retained-start.json'
  if (path === 'runtime observe') return 'run-id'
  if (path === 'tests create') return 'definition.json'
  if (path === 'tests erase') return 'retained-erasure-request.json'
  if (path === 'tests erasure') return 'retained-request-id'
  if (path === 'tests generate' || path === 'releases create' || path.startsWith('projects ')) return 'project-id'
  if (path === 'tests generation') return 'generation-id'
  if (path === 'tests result' || path.startsWith('runs ') || path === 'approvals show' || path === 'approvals decide' || path === 'approvals notify prepare') return 'run-id'
  if (path.startsWith('tests ')) return 'test-id'
  if (path.startsWith('releases ')) return 'release-id'
  if (path === 'providers set') return 'connection.json'
  if (path === 'providers discover') return 'connection-id'
  if (path === 'schemas show') return 'schema-id'
  if (path.startsWith('credentials ')) return 'credential-ref'
  if (path.startsWith('templates ')) return 'template-id'
  if (path === 'import preview') return 'vendor-export-file'
  if (path.startsWith('import ')) return 'project.json-or-zip'
  if (path === 'approvals notify send') return 'reviewed-request.json'
  if (path === 'approvals notify show' || path === 'approvals notify abort' || path === 'approvals notify automatic-show') return 'retained-request-id'
  return 'argument'
}

const references: Record<string, string[]> = {
  'runtime lock inspect': ['owner-recovery.md'],
  'runtime lock recover': ['owner-recovery.md'],
  'runtime lock inspect-recovery': ['owner-recovery.md'],
  'runtime lock complete-recovery': ['owner-recovery.md'],
  'runtime export-kubernetes': ['management-images.md', 'kubernetes.md'],
  'releases message-id': ['release-messages.md'],
  kubernetes: ['kubernetes.md'],
  account: ['account.md'],
  skill: ['skill-package.md'],
  runtime: ['management.md', 'docker-owner.md', 'http.md'], doctor: ['doctor.md'],
  validate: ['authoring.md'], preview: ['preview.md', 'live-preview.md'], check: ['providers.md'],
  run: ['providers.md', 'control.md'], runs: ['control.md', 'evidence.md'],
  projects: ['projects.md', 'transfer.md'], releases: ['releases.md', 'images.md', 'kubernetes.md'],
  tests: ['testing.md', 'suites.md'], approvals: ['control.md', 'notifications.md'],
  providers: ['providers.md'], credentials: ['providers.md'], templates: ['authoring.md'],
  import: ['vendor-imports.md', 'transfer.md', 'authoring.md'], usage: ['usage.md'], capabilities: ['development.md'],
  activity: ['activity.md'],
  telemetry: ['collector-probe.md', 'telemetry.md', 'collector-gateway.md'],
  grants: ['grants.md'],
  reviewer: ['grants.md'],
  caller: ['grants.md'],
  schemas: ['schemas.md', 'cli-help.md'],
}
const baseNotes = [
  'Read-only command discovery: no files, storage, credentials, services or Docker engine are opened.',
  'Shared flag-presence, finite-choice, integer and argument-format rules identify required inputs, supported values, numeric bounds/defaults, UUID/hash/cursor formats and selected combinations before I/O. File schemas, review guards and permission checks still apply.',
  'Defaults describe the selected consuming mode; they do not enable a server, Docker owner, page or execution. Validation never supplies missing flags or changes submitted values.',
  'Runtime/diagnostic/suite/preview target selection is admitted before workflow, manifest, trace-viewer or configuration reads. Conflicting owner/storage flags never trigger fallback. Suites retain their explicit loopback-HTTP mode; portable preview rejects runtime options.',
  'No Jarness, harness or desktop dependency. Local execution is the default; server and Docker are explicit choices.',
]
const selectedNotes = [
  'Choose exactly one owner: direct local storage, an explicitly reviewed Docker owner, or an explicit HTTPS endpoint. Never combine their options.',
  'Local SQLite defaults to .jevable in the current directory. PostgreSQL requires --storage postgres and an owner-only --database-file; no fallback.',
  'Docker selection requires --runtime docker, --owner-file, --owner-sha256, full --container-id and --token-file; optional --ca-file and --timeout-ms. It never starts/restarts an owner.',
  'Endpoint selection uses --endpoint and --token-file, optional --ca-file/--instance-id/--timeout-ms; no local/Docker selection or configuration overrides. Retain reviewed identities after uncertainty.',
]

function notesFor(path: string, variants: { profile: string; grammar: HelpGrammar }[]) {
  const notes = [...baseNotes]
  if (path.startsWith('runtime lock ')) notes.push('Explicit owned private --state-dir only; no default directory, endpoint, database, Docker or telemetry options. Inspection never acquires an owner or opens SQLite. Recovery requires reviewed lock owner/hash, a retained request UUID and --confirm-recover, same supported Linux boot/PID namespace/directory, and proven process absence. Legacy/macOS/Windows/cross-boot/remote-filesystem locks remain blocked. inspect-recovery/complete-recovery address proof-bearing v2 interrupted intent only: original owner and recoverer must be exited; completion is exclusive and any interrupted completion stays blocked. Never starts, resumes, approves or redispatches workflow work.')
  if (path.startsWith('account ')) notes.push('Optional website-account session, not workflow/provider credentials or an owner selector. Explicit issuer and private POSIX session path; no desktop dependency, discovery, browser opening, automatic retry or credential erasure. Account help never reads the session. prepare/inspect/link are offline; exchange/status/revoke explicitly contact the selected issuer. Local workflows do not need an account.')
  if (path === 'account prepare') notes.push('Create a fresh session beneath an existing owned mode-0700 parent; never overwrite. Returns only the human authorization URL and immutable session/authorization pins. The user must authorize separately; preparing a link does not sign in.')
  if (path === 'account inspect' || path === 'account link') notes.push('Read the same protected session without network access. inspect returns retained metadata and review pins; link returns the original authorization URL only while prepared. Neither returns codes, verifiers, keys or private account details.')
  if (path === 'account exchange') notes.push('Retain exact session/authorization pins, explicitly confirm exchange and select exactly one protected code file or stdin. Never put the code in arguments. Complete private intent persistence precedes the single exchange; a recorded attempt cannot be redispatched. Metadata success follows private grant persistence. Exit 5 means outcome unknown; exit 3 means an attempt is already recorded. Inspect the same session and the issuer console without automatic retry.')
  if (path === 'account status') notes.push('Explicit service observation using the exact retained grant pin; it may update server last-used metadata. Default output excludes email, plan, balance and console links. --include-private deliberately includes validated account details, never the key. A 401 is observed unauthorized, not proof of revocation; local credentials remain retained.')
  if (path === 'account revoke') notes.push('Explicit single-attempt remote key revocation using exact grant pins; --confirm-revoke must equal the reviewed key UUID. Not local erasure, subscription cancellation or workflow cancellation. Lost/refused outcomes remain retained and are not retried. Successful revocation also retains the private grant. Exit 5 means outcome unknown; exit 3 means the session cannot admit another attempt.')
  if (path === 'runtime submit' || path === 'runtime observe') notes.push('Owner-only asynchronous HTTP admission/metadata observation on an explicitly enabled service. Mandatory reviewed endpoint, instance UUID and private owner token file; optional immutable release pin JSON is required for exact-release reads. Strict retained-start JSON uses kind workflow/project/release, a saved run UUID, input and reviewed source/pins. Submit returns creation or retained metadata, not completion; observe never resumes or returns private output. Request/pin/trace validation precedes credentials. No discovery, handshake, local storage, Docker fallback, polling, retry, service startup or automatic execution resume. Exit 0 means admission/read success only. See references/async-runs.md for the exact request contract.')
  if (variants.some(v => v.grammar.strings.includes('async-concurrency'))) notes.push('--async-concurrency 1..64 explicitly enables owner-only async start/status routes and bounds pending admission plus background completion. Omission disables routes; no queue or automatic resume. Normal shutdown drains original completion promises before releasing storage/telemetry. A disconnect/timeout never cancels the workflow. This startup-only option supports local, exported-app and Docker owners. Docker pins the reviewed policy and exact service command in its owner record; inspection and clean restart verify it without overrides or workflow replay. See references/async-runs.md.')
  if (variants.some(v => v.grammar.strings.includes('webhooks-file'))) notes.push('--webhooks-file enables start-only Standard Webhooks v1 HMAC intake at /v1/webhooks for one api release. Requires release-file/release-sha256 and explicit async-concurrency. Private regular JSON holds source and 1..4 distinct canonical whsec_ keys. Entire signed JSON body becomes input; stable message identity never retries/resumes or grants reads/approval/control. Timestamp tolerance is 300 seconds, body 1 MB, at most eight v1 signatures. Existing Host/Origin/proxy/TLS and instance-local request quotas apply; no incoming trace adoption. Managed Docker startup does not stage this option; independently exported apps accept it. See references/webhooks.md.')
  if (variants.some(v => v.grammar.strings.includes('rate-limits-file'))) notes.push('--rate-limits-file selects a strict bounded JSON policy with requests/controls token buckets, each requiring capacity, refillTokens and refillIntervalMs. Shared by one HTTP runtime instance, not per-IP/account or distributed. Disabled by default; owner/scoped status/stop reserve is unavailable to delegates. A 429 rate-limit includes Retry-After and does not dispatch; clients never automatically retry. Restart resets credits. Docker startup requires a protected policy file, stages it read-only and pins its canonical checksum in the owner record; restart reuses it without policy overrides. Cluster-wide coordination remains separate.')
  if (variants.some(v => v.grammar.strings.includes('rate-coordinator-file'))) notes.push('--rate-coordinator-file selects an explicit protected PostgreSQL 17 shared-quota configuration for local runtime serve/start or managed Docker startup; mutually exclusive with --rate-limits-file. Requires a pre-provisioned scope/policy and initialize:false; serving never initializes or resets quota state. Docker additionally requires verified TLS, stages the configuration read-only and pins its checksum, scope, policy hash and deadline; clean restart reuses it without host-file access or overrides. Independent from workflow storage, no environment discovery/reconnect/retry/refund/fallback. Backend failure returns safe 503 before dispatch; only committed quota denial returns 429. The CLI drains its HTTP owner before closing the coordinator. Preview and deployment qualification remain separate. Read references/postgres-rate-limits.md before selecting this backend.')
  if (path === 'tests erasure-review') notes.push('Read-only exact latest-case/full-history pins and intrinsic blockers only. Live references are not discovered and eligibility is not assessed. Inspect the full private history separately before authorizing removal; never treat this output as permission or zero retained references.')
  if (path === 'tests erase') notes.push('Owner-only logical removal of an archived manual never-accepted unreferenced draft. Retain a request UUID and exact case/full-history pins in the strict JSON file; actor is host-fixed and --confirm-delete must equal its case ID. File/confirmation validation precedes owner and credential access. Complete reference checks happen under the runtime mutation boundary. An identical retry observes the original metadata receipt; never mint a new ID or refresh stale pins automatically. Accepted/imported/generated/run evidence and project-reference guards remain protected. No secure physical erasure, preview, delegated or exact-release authority.')
  if (path === 'tests erasure') notes.push('Read-only lookup by the original retained removal request UUID, not case UUID. Inspect after response loss without another removal. The receipt contains trusted actor attribution but no private definition; sharing it requires review. Never replace an uncertain owner or bypass storage guards automatically.')
  if (path === 'skill export') notes.push('Offline agent skill ZIP with fixed instructions/examples/diagrams and bundled CLI. Requires package-owned authoring resources; extracted runtime-only ZIPs/images refuse. No source checkout, npm install, user state, credentials, global installation, service startup or workflow execution is included. Checksums are not signatures; verify through a trusted distribution. Existing output requires --overwrite.')
  if (path === 'skill export' || path === 'runtime export') notes.push('Optional --runtime-rate-coordinator postgres explicitly selects schema-2 archive delivery with the fourth SQLite workflow/PostgreSQL HTTP quota runtime. Default schema-1 archives keep their three runtimes. No quota configuration, credentials, server initialization or workflow storage conversion is included. See references/postgres-rate-limits.md.')
  if (path === 'skill inspect') notes.push('Bounded offline inspection of the supported fixed-inventory skill ZIP, nested management manifest and runtime checksums. Optional --sha256 checks a separately trusted archive hash before ZIP reading. No extraction, installation, state access, network or code execution. Consistency is not publisher authentication or proof that file contents contain no private data.')
  if (path.startsWith('grants ')) notes.push('Owner-only durable grant ledger. Caller start/read and reviewer decisions have separate opt-in management routes. Prepare and privately retain a token before digest-only issuance; identical UUID requests recover metadata, never regrant or rotate. Revocation needs its own retained UUID and generation 1; it does not cancel admitted work. Grants never transfer with projects or releases.')
  if (path.startsWith('caller ')) notes.push('Experimental caller-only start/read/checkpoint/control/cancel on an explicitly enabled management host. Mandatory reviewed endpoint, instance UUID, exact release pin JSON and protected grant token file; no owner discovery, state/Docker selection, automatic retry or fallback. Retain input/options/run UUID before start. Only read adds own completed output; checkpoint/control/cancel return metadata only. Control needs the creating grant’s explicit control permission, reviewed opaque checkpoint and retained strict request UUID/mode JSON file; step/continue/cooperative-pause/recover never imply output read, approval or owner authority. Recover settles only an already retained response, not provider or downstream dispatch. Identical control/cancellation retries only observe. Cancellation needs explicit cancel permission and never implies external-effect rollback. Caller operations use ordinary capacity, never the reserved owner slot; preview and exact-release hosts refuse this mode. Artifact/deployment qualification is separate.')
  if (path === 'reviewer decide') notes.push('Experimental reviewer-only route on an explicitly enabled management host. Mandatory reviewed endpoint, instance UUID and protected reviewer token file; no capability discovery, owner credentials, storage/Docker selection, automatic retry or fallback. Retain the strict decision request UUID/action/pause option before submission. Receipt-only retries never resume. Preview and exact-release hosts refuse this mode; deployment qualification remains separate.')
  if (path === 'caller stream') notes.push('One bounded POST SSE connection projected as metadata-only NDJSON, using fresh creating-grant read authorization on every poll. Stop at waiting/paused unless --follow; duration defaults to 15000 ms and is limited to 60000 ms. Default request timeout is 30000 ms; set it above the selected duration for longer observations. No private output, run events, durable cursor, Last-Event-ID, automatic reconnect, owner discovery, resume, model dispatch or cancellation. Disconnect/deadline only stops observation; initial refusals remain HTTP errors and later refusal emits read-refused. CLI stop exits: completed 0, attention 3, failed 4, cancelled 7, deadline 8, draining/read-refused 9, SIGINT 130, SIGTERM 143. Browser/deployment qualification remains separate.')
  const names = new Set(variants.flatMap(x => [...x.grammar.strings, ...x.grammar.booleans]))
  if (path === 'kubernetes capacity') notes.push('Read-only offline additional CPU/memory/pod request budget from complete explicit snapshots. No cluster contact, apply, reservation, cleanup or replacement credit. Exit 1 means a shortage, 2 invalid inputs; exit 0 is not scheduler, readiness or production acceptance. Snapshots may be stale or incomplete in reality; unbound pods, concurrent actors, admission, packing, quota, storage and other constraints remain separate.')
  if (names.has('trace-context-file')) notes.push('Optional private JSON trace context is read once before owner/credential access. Only traceparent and baggage are admitted; values are never CLI arguments, authority or durable input. Runtime and provider key opt-ins still apply. No ambient context, service-discovery fallback, receipt replay or automatic retry is implied; later operations need a newly approved carrier.')
  if (names.has('owner-file') && names.has('endpoint')) notes.push(...selectedNotes)
  if (names.has('page')) notes.push('Paginated lists use --page with optional --after and --limit (1–200). PostgreSQL requires a page; follow nextCursor even when a task page is empty. --after/--limit cannot stand alone.')
  if (path === 'approvals list' || path === 'approvals notify list') notes.push('This command requires --page on both backends. Approval inbox and notification delivery history are different lists.')
  if (path === 'approvals notify list') notes.push('Optional --project-id, --generation and --revision must be supplied together. They filter exact historical event provenance, not the current accepted project; no notification is sent.')
  if (path === 'approvals notify list') notes.push('Optional --outcome and --event-kind filter retained metadata. --created-from is inclusive and --created-before exclusive, both UTC ISO timestamps with milliseconds; order remains live UUID keyset, not time order. A cursor must still match the query.')
  if (['run', 'projects run', 'import project', 'releases create'].includes(path)) notes.push('Selected-owner execution/import/release creation requires a caller-retained --id before submission. Never invent another ID after a lost response.')
  if (path === 'releases create') notes.push('Optional --notes-file reads nonblank UTF-8 text (maximum 16384 bytes). Notes are immutable, included in the release hash and shared with exports; exclude secrets. They do not authorize execution.')
  if (path === 'releases create') notes.push('Explicit --runtime-storage sqlite --runtime-rate-coordinator postgres selects a separate pinned SQLite app bundle with PostgreSQL HTTP quotas only. Default SQLite has no PostgreSQL driver. Serving quota configuration/credentials are never included; direct jobs do not connect to quota storage. See references/postgres-rate-limits.md.')
  if (/^(?:runs (?:step|continue|pause|recover)|approvals decide)$/u.test(path)) notes.push('Review the retained run/checkpoint or approval attempt before authorizing this control. Preserve its exact request/attempt identity and guard. No automatic approval, stale-lock repair or uncertain redispatch.')
  if (path === 'runs recover') notes.push('Recover settles an already committed model response only. It does not contact the provider, execute the next node or approve a gate; inspect, then authorize continuation separately.')
  if (path === 'runs pause') notes.push('Pause is cooperative at a node boundary, not an abort or rollback. Submission success is not proof of stopping; inspect the retained outcome.')
  if (path === 'runs cancel') notes.push('Cancellation submission success is not proof of termination or external-effect rollback; inspect the retained stopped/uncertain state.')
  if (path === 'approvals notify abort') notes.push('Signals only this owner’s active delivery. Inspect final send outcome; no effect retraction, workflow cancellation or redelivery.')
  if (path.startsWith('approvals notify')) notes.push('Notification configuration stays on the selected service host. Retain the reviewed requestId before send. HTTP acceptance is not human delivery or approval; retrying an uncertain send does not authorize redelivery.')
  if (path.startsWith('approvals notify automatic-')) notes.push('Read-only automatic admission diagnostics. No policy file, destination configuration, replay, approval, expiry or resume. Local status describes the newly opened policy-free reader; select the existing host to inspect its live policy/work. Reservations and failures are not proof of no external effect; use the retained delivery request ID for its separate result.')
  if (path === 'import vendor') notes.push('Retain --id before submission. Review upload, owned conversion and exact authored draft hashes. Creation stores private origin atomically and never runs; identical retries return the original generation-one snapshot. Inspect that identity after uncertainty, not a new ID.')
  if (path === 'import show') notes.push('Default origin view is metadata only. --inspect includes the private original upload and conversion report. Project exports, including history, exclude this origin; conversion provenance is not runtime success or vendor behavioral equivalence.')
  if (path === 'import export-origin') notes.push('Requires the reviewed immutable origin SHA-256 and explicit --include-private before owner access. Writes a private evidence ZIP of the original upload/conversion/attribution, not a runnable app, editable project, current accepted source or restorable origin authority. Normal transfers/releases/duplicates still exclude origin. No conversion, execution or publication is authorized. Existing output requires --overwrite.')
  if (path === 'import inspect-origin') notes.push('Offline bounded metadata-only consistency inspection. Optional --reviewed-sha256 pins trusted archive bytes; checksums are not publisher authentication. Never extracts files, displays private upload/attribution, restores origin authority or runs the converter/workflow.')
  if (path.startsWith('tests suite')) notes.push('Create/inspect are offline; run/result can use direct storage or a selected owner. Explicit loopback HTTP is also supported by suites. Run requires --suite-sha256. Serial by default; optional manifest concurrency 1–8 is reviewed and bounded per invocation. Stops await already submitted peers without cancellation. Cases never auto-approve or resume; result is read-only.')
  if (path === 'tests suite run' || path === 'tests suite result') notes.push('Optional --suite-telemetry-file configures only the remote suite client, not its selected runtime. Bearer export requires a separate --suite-telemetry-credential-file; never use the management credential. Direct storage instead uses --telemetry-file. No local storage or owner-instrumentation fallback. Suite span context parents existing guarded owner requests; export is diagnostic, not execution authority or completion proof.')
  if (path === 'tests suite coverage') notes.push('Read-only observed coverage against --file matching the retained workflow revision. Counts settled results and explicitly recorded port choices, not inferred legacy routes, target completion, condition/path coverage or correctness. Missing runs are partial; approval waits can pass assertions without settling their node. Loop return bookkeeping is separate. No cases execute, accept, resume or approve; no aggregate suite telemetry is emitted.')
  if (path === 'tests archive' || path === 'tests unarchive') notes.push('Append a guarded lifecycle version, never erase history/results or cancel admitted work. Archive refuses new test runs; unarchive preserves draft/accepted state but requires its new generation for execution and never refreshes project pins. Lists retain lifecycle metadata; project test exports exclude archived cases. Inspect show/history after an uncertain response; do not refresh stale guards automatically.')
  if (/^(?:releases|runtime) (?:build-image|save-image|export-kubernetes|export)$/u.test(path)) notes.push('Packaging is explicit and host-side. No registry push, application execution, container startup or cluster mutation is implicit. A successful export/build is not deployment qualification.')
  if (path === 'runtime export-kubernetes') notes.push('Distinct PostgreSQL management profile. Requires reviewed management image receipt and options-file hashes; matches installed program manifest and all three runtime identities. Use schemas show management-kubernetes-options. Exports one Recreate owner with protected Secret references, TLS readiness and explicit networking/resources. No live HTML preview, SQLite fallback, notification delivery, registry attestation or cluster apply.')
  if (path === 'runtime start') notes.push('Local profile is foreground service startup (default or --runtime local). Docker profile is --runtime docker with reviewed management image/TLS/token and private owner record. Do not mix profile flags. Docker database, network and CA configuration are explicit; CA additions affect process-wide Node trust.')
  if (['runtime inspect', 'runtime stop', 'runtime restart'].includes(path)) notes.push('Docker lifecycle only: requires --runtime docker and reviewed owner identities. Stop sends SIGTERM only and retains volumes. Restart requires the private token; no automatic replay or fallback.')
  if (path === 'preview') notes.push('Portable --output is inspection-only and refuses runtime options. --serve requires exactly one --token-file or --token-env VARIABLE_NAME (64 lowercase hex characters). Direct local previews may opt into --auto-connect: trusts other local processes, never embeds the owner token, never executes on opening. Disconnect requires explicit reconnection. Docker/remote owners refuse both convenience options and require a separate --preview-token-file. Use a fresh retained --project-id to create, or --project-pin-file with its exact reviewed --project-pin-sha256 to attach an existing active accepted project. Attachment only reads and requires the source revision and current generation to match; stale/archived/missing targets never create, restore or retarget. Local SQLite/PostgreSQL attachment uses the same guards. Browser qualification remains open.')
  if (path === 'credentials set') notes.push('Use exactly one protected --file or --stdin and the reviewed --expected-generation. Never put secret values in command arguments or workflow source.')
  if (path === 'credentials clear') notes.push('Requires the exact positive active generation. Logical local clearing retains a secret-free generation and audit metadata; no provider revocation, secure physical erasure, cancellation or retry. Inspect status after a lost reply; restore only with a new guarded credential write.')
  if (path === 'providers discover') notes.push('Explicit advisory GET to one configured OpenAI-compatible connection, using its protected credential. No prompt, permission change, execution-readiness guarantee, automatic pagination, redirect or retry. Never invoke automatically on startup or refresh.')
  if (path === 'activity report') notes.push('Read-only coherent counts from one selected installation/namespace, not account/billing/lifetime totals. Imported proposal history is distinct from local actions; firstRetainedRun is earliest retained creation, not first-ever success. Recorded executing does not prove an active worker. Concurrent changes may refuse with conflict; no automatic retry or execution.')
  if (path === 'telemetry probe') notes.push('Explicit outbound synthetic telemetry to configured startup destinations only: one record/request per enabled signal, no workflow/model execution, destination override, discovery or retry. Independent of workflow sampling and queues. Acknowledgement is not backend/dashboard visibility or a durable receipt; lost replies remain unknown. Disabled/failure/abort exits 1; warning is reported even when no records are rejected.')
  if (path === 'telemetry export-gateway') notes.push('Offline optional Collector configuration ZIP only. Requires exact reviewed options bytes; includes TLS/bearer private-file references, not values. No runtime owner, Docker engine, network, Collector binary or cluster is opened. Existing output requires --overwrite. Collector/downstream/platform qualification remains separate.')
  if (path === 'validate' || path === 'import preview' || path.startsWith('templates')) notes.push('Offline compilation/rendering does not execute nodes, check provider readiness, approve a workflow or deploy an app.')
  if (path === 'import preview') notes.push('Default output is canonical YAML. --output-format html requires --output and creates one offline conversion-report/graph review file; raw upload bytes are excluded, but labels and converted source remain private. No server, browser, retained project/origin or execution is started. Approximate/unsupported steps still require review and repair.')
  if (path === 'doctor') notes.push('Read-only diagnostic. Explicit endpoint permits authenticated health/capability reads; no storage ownership, migration, repair or execution. Options do not imply checked scope.')
  if (path === 'runs watch') notes.push('Read-only service observation emits redacted NDJSON. Deadline exits 8; interruption exits 130/143. It never opens workflow storage or replays a run.')
  if (path === 'releases message-id') notes.push('Offline UUIDv8 derivation from a strict bounded 4096-byte regular UTF-8 JSON file containing release {id, sha256, revision}, source and messageId. Pins are caller-reviewed, not looked up or authenticated. Exact sender namespace and stable message identity exclude input, delivery time, credentials and service instance. No database, listener, run, approval, provider, signature verification or acknowledgement. Preserve the same identity after uncertainty. See references/release-messages.md.')
  return notes
}

export function helpReport(path: string[], variants?: { profile: string; grammar: HelpGrammar }[]) {
  const command = path.join(' ')
  const children = CLI_HELP_PATHS.filter(x => !command || x.startsWith(command + ' '))
  if (!variants && command && !children.length) throw new CliHelpInputError('Unknown command group. Run jevable help.')
  const contracts = command === 'releases message-id' ? [['release-message-identity', releaseMessageIdentitySchema]] as const
    : command === 'runtime submit' ? [['async-run-start', asyncRunRequestSchema], ['async-release-pin', asyncReleasePinSchema]] as const
    : command === 'runtime observe' ? [['async-release-pin', asyncReleasePinSchema]] as const
      : variants?.some(v => v.grammar.strings.includes('async-concurrency')) ? [['async-run-policy', asyncRunPolicySchema], ['http-rate-limits', httpRateLimitsSchema]] as const : undefined
  return {
    schemaVersion: 4, version: CORE_VERSION, kind: variants ? 'command' : 'index', command: command || null,
    execution: 'not-dispatched',
    output: { encoding: 'utf8', ...CLI_OUTPUT_LIMITS, stdoutUnit: 'complete-response-or-ndjson-record', stderrUnit: 'complete-write',
      failureExitCode: 5, signalExitCodesTakePrecedence: true, truncation: 'never', replay: 'never',
      limits: 'Encoded writes/pending delivery only, not serialization heap, aggregate stream length or consumer parsing/storage.' },
    ...(contracts ? { inputContracts: contracts.map(([id, validator]) => {
      const schema = z.toJSONSchema(validator, { io: 'input', target: 'draft-2020-12', unrepresentable: 'throw' })
      return { id, schema, sha256: createHash('sha256').update(JSON.stringify(schema)).digest('hex'),
        validation: 'structural-input-projection-only', references: [id === 'release-message-identity' ? 'references/release-messages.md' : id === 'http-rate-limits' ? 'references/rate-limits.md' : 'references/async-runs.md'],
        limits: 'Same structural validator as HTTP/CLI admission; file budgets, source compilation, input values, reviewed pins, authority and active-owner guards still apply.' }
    }) } : {}),
    ...(variants?.some(v => v.grammar.strings.includes('webhooks-file')) ? { startupContracts: (() => {
      const schema = z.toJSONSchema(releaseWebhookConfigSchema, { io: 'input', target: 'draft-2020-12', unrepresentable: 'throw' })
      return [{ id: 'release-webhooks', flag: 'webhooks-file', schema, sha256: createHash('sha256').update(JSON.stringify(schema)).digest('hex'),
        validation: 'structural-input-projection-only', references: ['references/webhooks.md'],
        limits: 'Private startup file only; key decoding/uniqueness, file permissions, exact API release and shared async capacity are enforced separately. No values are read by help.' }]
    })() } : {}),
    ...(command === 'preview' ? { attachmentContracts: (() => {
      const schema = z.toJSONSchema(previewProjectPinSchema, { io: 'input', target: 'draft-2020-12', unrepresentable: 'throw' })
      return [{ id: 'preview-project-pin', flag: 'project-pin-file', checksumFlag: 'project-pin-sha256', schema,
        sha256: createHash('sha256').update(JSON.stringify(schema)).digest('hex'), validation: 'structural-input-projection-only',
        references: ['references/live-preview.md'], limits: 'Exact bounded regular-file checksum and source revision are checked before target credentials/storage. Active current owner project identity is checked read-only at startup; no create or execution fallback.' }]
    })() } : {}),
    ...(variants ? { variants: variants.map(({ profile, grammar }) => {
      const options: Record<string, 'string' | 'boolean'> = Object.fromEntries([...new Set([...grammar.strings, ...(grammar.strings.includes('data-dir') ? ['telemetry-file'] : [])])].map(key => [key, 'string'])
        .concat([...new Set(['json', ...grammar.booleans])].map(key => [key, 'boolean'])))
      return {
        profile, positionalCount: grammar.positionals,
        positionalArguments: Array.from({ length: grammar.positionals }, (_, i) => i === 0 ? argumentLabel(command) : `argument-${i + 1}`),
        options, requirements: { ...cliFlagRequirements(command, options, profile), positionals: cliPositionalRequirements(command, grammar.positionals) },
      }
    }) } : { commands: children }),
    notes: variants ? notesFor(command, variants) : baseNotes,
    references: (references[command] ?? references[path[0] ?? 'capabilities'] ?? []).map(x => `references/${x}`),
    referenceLocation: 'Relative to the npm/skill distribution; extracted management ZIPs provide inline help without these guide files.',
    exitCodes: { '0': 'completed/read/submission success', '1': 'operation failure', '2': 'invalid input', '3': 'waiting/paused',
      '4': 'workflow failed', '5': 'uncertain dispatch or incomplete output; never automatically replayed', '6': 'test expectation failed',
      '7': 'cancelled execution', '8': 'Docker unready/draining or watch deadline', '130': 'interrupted (SIGINT)', '143': 'interrupted (SIGTERM)' },
  }
}

function renderCondition(condition: CliFlagCondition): string {
  return 'any' in condition ? condition.any.map(renderCondition).join(' or ')
    : condition.present ? `--${condition.flag} is supplied` : `--${condition.flag}=${String(condition.equals)}`
}

export function renderHelp(report: ReturnType<typeof helpReport>) {
  const title = `Jevable ${report.version} — ${report.command ?? 'command index'}`
  const body = 'variants' in report ? report.variants.map(v => `${v.profile}: jevable ${report.command}${v.positionalArguments.map(x => ` <${x}>`).join('')}\n`
    + Object.entries(v.options).map(([key, type]) => `  --${key}${type === 'string' ? ' <value>' : ''}`).join('\n')
    + '\nRequirements (before I/O):\n' + (v.requirements.rules.length ? v.requirements.rules.map(rule => {
      if (rule.kind === 'fixed') return `  --${rule.flag} must be ${rule.value}`
      if (rule.kind === 'choices') return `  --${rule.flag}: ${rule.values.join(' | ')} (if supplied)`
      if (rule.kind === 'integer') return `  --${rule.flag}: decimal integer ${rule.minimum}..${rule.maximum}${rule.defaultValue === undefined ? '' : `; default ${rule.defaultValue}`} (if supplied)`
      if (rule.kind === 'format') return `  --${rule.flag}: ${cliArgumentFormatDescription(rule.format)} (if supplied)`
      return `  ${rule.kind}: ${rule.flags.map(flag => `--${flag}`).join(', ')}${rule.when ? ` when ${renderCondition(rule.when)}` : ''}`
    }).join('\n') : '  No additional flag-presence requirement.')
    + v.requirements.positionals.map(rule => `\n  <${v.positionalArguments[rule.index]}>: ${cliArgumentFormatDescription(rule.format)}`).join('')).join('\n\n')
    : report.commands.map(x => `  jevable ${x}`).join('\n')
  return `${title}\n\n${body}\n\n${report.notes.join('\n')}\n\nDetailed guides: ${report.references.join(', ')}\n${report.referenceLocation}\n\nExit codes: ${Object.entries(report.exitCodes).map(([key, value]) => `${key} ${value}`).join('; ')}.\n\nUse jevable help <complete command path> [--json]. Do not include positional values or execution options.\n`
}

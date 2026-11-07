import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { zipEpoch } from "./zip-time.js";
import { readBoundedBytes } from "../files.js";
import { CORE_VERSION } from "../capabilities.js";
import { inspectRelease, releaseRequirements } from "../releases/snapshot.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { fileURLToPath } from 'node:url';
import { prepareEvidenceAttachment } from "../evidence/attachment.js";
import { releaseCommandReference } from "../releases/commands.js";
import { z } from 'zod';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const coordinatedProfile = z.strictObject({ storage: z.literal('sqlite'), rateCoordinator: z.literal('postgres') });
async function loadBuiltReleaseRuntime(storage, readBytes, rateCoordinator) {
    if (storage !== 'sqlite' && storage !== 'postgres')
        throw new WorkflowRuntimeError('invalid-command');
    const stem = rateCoordinator === 'postgres' ? 'release-sqlite-coordinated' : storage === 'sqlite' ? 'release' : 'release-postgres';
    const bytes = await readBytes(fileURLToPath(new URL(`../${stem}-runtime.mjs`, import.meta.url)), 32_000_000);
    const metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBytes(fileURLToPath(new URL(`../${stem}-runtime.json`, import.meta.url)), 1_000_000)));
    if (metadata.sha256 !== digest(bytes) || metadata.bytes !== bytes.length || metadata.external !== 'node-builtins-only'
        || metadata.storage !== storage || metadata.rateCoordinator !== rateCoordinator)
        throw new WorkflowRuntimeError('corrupt');
    const notices = await readBytes(fileURLToPath(new URL(`../${stem}-NOTICES.txt`, import.meta.url)), 2_000_000);
    return { bytes, notices, storage, ...(rateCoordinator ? { rateCoordinator } : {}), identity: { version: CORE_VERSION, sha256: digest(bytes) } };
}
/** Default profiles preserve SQLite's no-PostgreSQL-driver bundle. */
export async function loadReleaseRuntime(storage = 'sqlite', readBytes = readBoundedBytes) {
    return loadBuiltReleaseRuntime(storage, readBytes);
}
/** Explicit optional SQLite workflow bundle with PostgreSQL HTTP quotas, never workflow storage. */
export async function loadReleaseRuntimeProfile(profile, readBytes = readBoundedBytes) {
    const parsed = coordinatedProfile.safeParse(profile);
    if (!parsed.success)
        throw new WorkflowRuntimeError('invalid-command');
    return loadBuiltReleaseRuntime(parsed.data.storage, readBytes, parsed.data.rateCoordinator);
}
/** Select the exact saved runtime identity; exporting never rewrites a release to another backend. */
export async function loadReleaseRuntimeForIdentity(identity) {
    if (identity.version !== CORE_VERSION)
        throw new WorkflowRuntimeError('conflict');
    for (const storage of ['sqlite', 'postgres']) {
        const artifact = await loadReleaseRuntime(storage);
        if (artifact.identity.sha256 === identity.sha256)
            return artifact;
    }
    const coordinated = await loadReleaseRuntimeProfile({ storage: 'sqlite', rateCoordinator: 'postgres' });
    if (coordinated.identity.sha256 === identity.sha256)
        return coordinated;
    throw new WorkflowRuntimeError('conflict');
}
const bootstrap = (attached = false) => `import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const names = ['release.json','workflow.yaml','runtime.mjs','NOTICES.txt','README.txt','Dockerfile','compose.yaml','.env.example','.dockerignore','configuration.json'${attached ? ",'evidence.zip'" : ''}];
const root = new URL('.', import.meta.url);
async function read(name, max = 32000000) {
  const handle = await open(new URL(name, root), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max) throw Error('Invalid release file');
    const bytes = Buffer.alloc(Math.min(max + 1, stat.size + 1)); let size = 0;
    while (size < bytes.length) { const chunk = await handle.read(bytes, size, bytes.length-size, null); if (!chunk.bytesRead) break; size += chunk.bytesRead; }
    if (size !== stat.size || size > max) throw Error('Changed release file'); return bytes.subarray(0,size);
  } finally { await handle.close(); }
}
try {
  const [major,minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19)) throw Error('Node 22.19 or newer is required');
  const manifest = JSON.parse(await read('manifest.json',100000));
  if (manifest.format !== 'jevable.ai/release-zip' || manifest.version !== ${attached ? 2 : 1} || !Array.isArray(manifest.files)
    || manifest.files.length !== names.length + 1 || new Set(manifest.files.map(f=>f.path)).size !== names.length+1) throw Error('Invalid release manifest');
  const files = new Map();
  for (const entry of manifest.files) {
    if (![...names,'app.mjs'].includes(entry.path) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw Error('Invalid file record');
    const bytes = await read(entry.path);
    if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw Error('Release checksum mismatch');
    files.set(entry.path,bytes);
  }
  const release = JSON.parse(files.get('release.json'));
  if (release.snapshot.id !== manifest.releaseId || release.sha256 !== manifest.releaseSha256
    || createHash('sha256').update(JSON.stringify(release.snapshot)).digest('hex') !== release.sha256
    || release.snapshot.workflow.yaml !== files.get('workflow.yaml').toString('utf8')
    || release.snapshot.runtime.sha256 !== createHash('sha256').update(files.get('runtime.mjs')).digest('hex')) throw Error('Release identity mismatch');
${attached ? `  const evidence = manifest.evidence;
  if (!evidence || evidence.format !== 'jevable.ai/evidence-attachment' || evidence.path !== 'evidence.zip'
    || evidence.revision !== release.snapshot.workflow.revision || manifest.revision !== evidence.revision
    || evidence.bytes !== files.get('evidence.zip').length || evidence.bytes > 16000000
    || evidence.sha256 !== createHash('sha256').update(files.get('evidence.zip')).digest('hex')
    || !/^[a-f0-9]{64}$/.test(evidence.selectionSha256) || !Number.isSafeInteger(evidence.runs) || evidence.runs < 1
    || !['metadata-only','private-execution-data'].includes(evidence.declaredPrivacy)
    || evidence.relationship !== 'workflow-revision-only' || evidence.authenticity !== 'not-verified'
    || evidence.restoration !== 'unsupported' || manifest.tests !== 'review-attachment-only') throw Error('Invalid review attachment');
` : ''}  const runtime = await import('./runtime.mjs');
  process.exitCode = await runtime.releaseMain(release.snapshot, process.argv.slice(2), fileURLToPath(root));
} catch { process.stderr.write(JSON.stringify({status:'error',code:'release-integrity-or-startup',message:'Verify release checksums and Node >=22.19. Inspect retained state before retrying any operation.'})+'\\n'); process.exitCode=1; }
`;
const guide = `Jevable runnable workflow release

Requires Node.js >=22.19. No npm install, skill, Jarness/harness, source checkout, desktop or Docker is needed for local execution.
This development distribution has not been qualified on all supported Node/platform combinations. Distribution terms are not yet published.
Verify the ZIP SHA-256 from the trusted export receipt before unpacking. Checksums detect corruption, not publisher authenticity.
The launcher verifies the allowlisted packaged files before importing the runtime. Only run a release from a trusted source; it contains executable code.

node app.mjs info
node app.mjs check
node app.mjs run --input /path/to/input.json --id <fresh-run-uuid>
node app.mjs show <run-uuid>
node app.mjs events <run-uuid>
node app.mjs usage <run-uuid>
node app.mjs approvals --page
node app.mjs export <run-uuid> --output evidence.json
node app.mjs review <waiting-run-uuid>
node app.mjs decide <waiting-run-uuid> --attempt <reviewed-attempt-uuid> --action approve
node app.mjs cancel <run-uuid> --request-id <retained-cancellation-uuid>

For a one-shot local event job, prepare an owner-only regular JSON file (POSIX mode 0600) in a trusted private directory:
{"format":"jevable.ai/local-release-event","version":1,"release":{"id":"<releaseId from info>","sha256":"<releaseSha256 from info>","revision":"<revision from info>"},"source":"local/orders","messageId":"<stable source event ID>","input":<reviewed workflow input>}
The workflow Trigger must explicitly admit api. Review the file and its release pin, then retain the reported byte hash and run UUID:
node app.mjs event-id /private/path/event.json
node app.mjs event /private/path/event.json --event-sha256 <reviewed eventSha256> --data-dir /private/path/workflow-state
event-id opens no storage or listener and prints no event source, message ID or input. event uses this exact release/source/message ID to derive one stable run UUID, selects api, executes at most the original run and closes its owner. A settled identical redelivery only observes saved state; changed input conflicts. Waiting/paused/uncertain status never authorizes automatic continuation or approval. The file is local operator execution authority, not proof of a remote sender or signature. Final symlinks, pipes, public POSIX permissions, malformed UTF-8, oversized input, wrong release and wrong byte hashes refuse before owner startup. File ancestors must be trusted; Windows ACL and other platforms are not qualified by POSIX checks.
An existing local scheduler can invoke this bounded job, without an always-on Jevable service. It must retain the original file/hash/identity after response loss, protect state and credentials, inspect exit codes, and not create a new message ID to retry uncertain work. A recurring schedule needs a distinct retained event ID for each intended occurrence. Never race a direct event job against an active service owning the same SQLite state.
SQLite crash ownership: if a process owning SQLite state dies abruptly, a retained runtime lock makes every later owner fail closed (never a second owner over the same state). Recovery is context-bound by design (same Linux boot and process namespace via the SDK lock tooling); it cannot be taken over from a different container or machine. For persistent on-cluster deployment use the PostgreSQL storage profile, whose supported replacement path (503 ownership-lost, then an explicit owner replacement) is qualified separately. Never delete a retained lock file to force startup without inspecting it first.
This app also ships an operator-owned durable inbox plus a drain-once scheduler as explicit local infrastructure (never a required Jevable service):
node app.mjs event-inbox /private/path/event.json --inbox /private/path/inbox
node app.mjs scheduler --inbox /private/path/inbox --data-dir /private/path/workflow-state
event-inbox validates exactly like event-id and stores the pinned bytes in a private owner-only inbox; re-queuing identical bytes is idempotent. scheduler takes a cooperative single-process lock, delivers each non-terminal entry by spawning the exact event command in a separate bounded child process (--event-timeout-ms, default 120000), and exits after the pass: scale to zero between work. waiting/executing entries are only re-observed on later passes until terminal; a crash or lost child response keeps the entry replayable under its original identity and run UUID; conflict and invalid entries stop retrying for operator inspection. The scheduler process itself never opens workflow storage, resumes a run or decides an approval, and an interval loop (--interval-seconds) is an explicitly started local polling process, not ingress. External HTTP wakeups still need a separately operated listener.

To run this app as an explicit local HTTP service:
node app.mjs token --output /private/path/service-token
node app.mjs serve --token-file /private/path/service-token --data-dir /private/path/workflow-state
In another terminal, using the URL from the readiness receipt:
node app.mjs status --endpoint http://127.0.0.1:<reported-port> --token-file /private/path/service-token
node app.mjs request /private/path/operation.json --endpoint http://127.0.0.1:<reported-port> --token-file /private/path/service-token
An operation file for a new explicit run: {"operation":"runs.start","id":"<retained-run-uuid>","input":<reviewed-input>}
The app client supplies its exact release SHA-256. Never put bearer values in JSON, URLs, command arguments or chat. Token creation is owner-only and refuses overwrite. Startup, health and reads never execute. Request success is HTTP success: inspect result.status for waiting, paused, failed, uncertain or cancelled workflow outcomes.

Usage optionally takes paired --from and --before UTC timestamps with exactly three fractional digits, for example --from 2026-10-01T00:00:00.000Z --before 2026-10-02T00:00:00.000Z. Both are required together; from must precede before. The original model intent is allocated to [from, before), counting the entire successful-response usage once, not per try or prorated. Scoped output records outsideWindow/unlocatedModelIntents; missing timestamps or histories prevent complete/known-zero claims. Invalid windows fail before storage opens. The usage.report API takes the same optional window object inside its explicit run/revision selection; foreign-release runs remain refused. Omit the window for unchanged unscoped reports. This reads retained evidence only, never discovers runs, contacts providers or estimates a bill.

Usage --group-by provider|provider-model separately opts into revealing verified requested-provider/model identities. The usage.report selection uses groupBy with the same values; it can compose with window. Groups are bounded to 1000 and contain exact decimal totals/coverage, with null identity for missing/unrecorded history, never an invented provider. Model means the requested model, not a provider-reported response version or billing SKU. Unlocated calls remain unallocated to windows and suppress completeness for their known/unknown bucket. Group coverage refers only to assigned observed records; an unknown bucket cannot establish provider/account completeness. Prompts, responses, actors, endpoints, connection/credential references and provider response IDs remain excluded; ordinary evidence/ungrouped reports never include these opted-in identities. The explicit identity-bearing source checksum differs from ordinary evidence. This is retained workflow accounting, not an account balance or price estimate. Review provider/model identifiers before sharing.
The default HTTP API binds only 127.0.0.1 and provides exact-release info/check, runs.start/list/show/inspect/events/export/advance/cancel and approvals.show/decide. It rejects source replacement, authoring, provider/credential mutation, another release's runs and missing/wrong release guards. The inert operator page is at the reported URL's root; it shows a left-to-right graph, Run, paginated Log, Approvals and Guide after explicit owner-token entry. Opening the page does not execute a run or expose release/private data. The Guide loads authenticated OpenAPI 3.1 plus examples on request; direct callers can read GET /v1/openapi.json with the owner bearer token. Every direct POST /v1/operations must include releaseSha256; clients use X-Jevable-Protocol: jevable/v1alpha1. The token grants all exposed release operations, including private inspection and approval: it is a single-owner token, not multi-user roles. Approval still requires actual decision authority. Embedded-browser, broader accessibility/browser-matrix and deployed-container qualification remain separate.
For explicitly authorized direct HTTPS, add all of these serve flags: --port <nonzero-port> --public-origin <https://hostname:public-port> --bind-address <ip> --tls-cert-file <chain.pem> --tls-key-file <private.pem>. The canonical public origin has no path/trailing slash/query/credentials and pins Host/Origin; its port may differ from the listening port for explicit mapping. The readiness receipt reports both. A non-loopback bind exposes a network listener and must be deliberate. No certificate/DNS/firewall provisioning or deployment is performed.
Certificates must be valid, cover the public hostname/IP via SAN and match the key. PEM files must be bounded regular non-symlink files; POSIX private keys must be owned by the runtime user with no group/other permissions. TLS 1.2 is the minimum. Clients verify chain and hostname; status/request accept --ca-file <ca.pem> for explicit trust replacing default Node CA trust. There is no insecure verification bypass or plaintext fallback. Tokens/keys/CA settings are never included automatically in this archive. Certificate/token rotation requires restart. Forwarded/X-Forwarded-*/X-Real-IP headers are rejected; trusted-proxy authentication, mTLS and user roles are not implemented.
Direct local jobs retain the first Ctrl-C/SIGTERM through startup, admitted work and telemetry/storage cleanup. They stop further dispatch, emit a draining diagnostic to stderr and return 130/143 only after cleanup. Repeated signals never force-kill, cancel, replay or clear locks. Retain the original run UUID and inspect its result; interruption can still leave a completed run. This is not a rollback or provider-delivery guarantee.

Configure providers/credentials before serving; the service exclusively owns its state directory. Use request operations while it is running, not a competing direct command. Ctrl-C/SIGTERM drains admitted requests before releasing storage. A client timeout or disconnected request does not cancel work; inspect/retry its original UUID. The service has no automatic startup execution, approval, recovery or cleanup.

For explicitly authorized approval notifications, add --notifications-file /private/path/notifications.json to serve. It contains {"endpoints":[{"id":"review","url":"https://your-reviewed-receiver.example/events","credentialRef":"notifications/review","timeoutMs":5000}]}; provision that signing credential separately with credentials-set before serving. The file must be bounded, regular, non-symlink and owner-only; URLs and keys are never accepted in send requests or included in this archive. Startup does not send.
Use request for the running service, or node app.mjs notify operation.json --notifications-file /private/path/notifications.json for an explicitly authorized direct job. The operation file is one of notifications.destinations, notifications.prepare with pin {runId,revision,attemptId} and endpointId, notifications.send with request, notifications.show with requestId, or notifications.list with page {after?,limit?}. The app supplies releaseSha256. Prepare is read-only: omit its event/delivery fields and retain a requestId before authorizing send. Requests include reviewed runId/revision/attemptId/endpointId/endpointSha256/eventSha256, and optional redeliverOf for an explicitly authorized new delivery. Never retry uncertain work with a new ID automatically.
All runs, receipts, reused IDs, predecessors and history cursors are restricted to this exact release. History uses live UUID keysets, not chronology or a snapshot; sparse release pages may scan the bounded owner history internally. Reads and identical sends do not redeliver and need no destination configuration. Direct notify send exits 0 for HTTP acceptance, 5 for pending/uncertain, and 4 for rejected HTTP. HTTP acceptance is not human delivery or approval. The release token grants this explicit-send authority; scoped preview, multi-user assignment and deployed-notification qualification are separate.
For recorded lifecycle events, add optional eventKind requested|decided|expired|cancelled to the prepare pin and copy it into the reviewed send request. Omission preserves requested-event behavior. Decided requires a committed action decision; it exposes neither that action nor its actor. Expired requires a committed expired decision, not merely an elapsed clock deadline. Cancelled requires cancellation of this exact waiting approval, not a later node. Lifecycle event time/ID come from retained history; expiresAt is the original approval deadline, not a historical-event delivery deadline. Legacy journals without a recorded deadline cannot prepare new lifecycle events. Each event/endpoint has a separate predecessor chain. No decision, cancellation, startup, restart or read automatically sends. Older binaries that only understand requested events refuse new lifecycle records; do not downgrade an owner with that history.
To stop only an active notification delivery, send notifications.abort with its retained requestId to this running release service through request. The receipt must belong to this exact release. The result status abort-requested acknowledges a process-local signal, not final settlement or effect retraction; inspect the original receipt. Already observed acceptance can still settle accepted; interrupted transport normally settles uncertain/aborted. Status not-active never settles inactive pending evidence, including after restart. A direct notify abort can inspect inactive history but cannot stop a competing owner. Repeated abort does not send, cancel the workflow, rewrite settled outcomes or reconstruct delivery telemetry. No actor/destination/key override or implicit service discovery is supported.

For step-by-step real execution, add --paused to run, then use:
node app.mjs step <run-uuid> --request-id <retained-control-uuid> --checkpoint-sha256 <reviewed-checkpoint-hash>
node app.mjs continue <run-uuid> --request-id <another-control-uuid> --checkpoint-sha256 <new-reviewed-checkpoint-hash>
Step admits at most one evaluator transition; loop bookkeeping may add several recorded results. Continue stops at breakpoints, actual approval waits, completion or failure/limits. Retain a control UUID before submission. Identical retry observes current state without another dispatch; stale guards or changed request reuse conflict. A committed request can remain paused after a pre-dispatch failure; inspect before authorizing a fresh request. Uncertain executing attempts cannot be advanced. Add --pause-after to an authorized decide to stop before downstream continuation. Loop wall-clock deadlines and cumulative transition limits do not reset during pauses.
Step/Continue accept --breakpoints-file <node-ids.json>: an array of up to 128 unique existing node IDs. Omit to retain configuration; [] clears it. Breakpoints stop before dispatch, survive restart and re-arm on later loop iterations. A fresh Step/Continue passes a recorded hit once; retry does not execute.
Use pause <run-id> --request-id <control-uuid> --checkpoint-sha256 <reviewed-hash> for cooperative Pause, without a breakpoint file. For a running service, send runs.advance with mode pause and the same guards through its request client instead of opening its data directory. The already-dispatched node may settle; pause stops before the next node, does not abort or roll back effects, and cannot turn an uncertain intent into a safe checkpoint. A terminal outcome or cancellation wins. An approval still needs an explicit decision, after which downstream execution remains paused. Inspect the pause receipt; at-safe-checkpoint is different from requested. Resume only with a fresh guarded Step/Continue. Reads, restart and identical retries never resume it.

Recover an already saved model response (explicit settlement, not retry):
node app.mjs show <run-uuid>
node app.mjs recover <run-uuid> --request-id <retained-recovery-uuid> --checkpoint-sha256 <reviewed-checkpoint-hash>
Use this only after explicit authorization and inspection of an idle executing LLM/Decision attempt whose original store contains a committed, verified model response. Recovery settles that one node with its original attempt, trace and reported usage. It never calls the provider, dispatches downstream nodes, accepts an approval or requires today's model credentials. Usually it returns paused (exit 3); separately authorize a new guarded Step/Continue to advance. Missing/pending/failed/corrupt responses, cancelled or non-model attempts are refused. An executing receipt by itself does not prove a recoverable response exists.
Retain the recovery request UUID and checkpoint hash before dispatch. Identical retry only reads current state, even after restart; it does not repeat settlement or reconstruct model telemetry. If admission committed but settlement did not, the same ID can still report executing. Inspect and explicitly authorize another settlement request only if intended; never generate new IDs in an automatic loop. Recovery does not repair a stale lock, reconnect a lost database owner or resolve an unknown external outcome. Preserve state/journals and establish that the prior owner has stopped before opening a direct job; never remove a lock based only on a timeout or PID guess.
For a running service, use request with {"operation":"runs.advance","id":"<run-uuid>","requestId":"<retained-recovery-uuid>","expectedCheckpointSha256":"<reviewed-checkpoint-hash>","mode":"recover"}. The app adds its release guard; never open competing direct state or put releaseSha256/actor in the operation file. HTTP success is not proof of node settlement: inspect the returned retained run and its status.

Select --data-dir explicitly for independent installations; default is .jevable beside app.mjs. Its SQLite journal persists after exit.
Retain the original UUID before dispatch; retry that same source/input/UUID after a lost response. Never invent a new UUID to retry uncertain work.
Approval waits survive process restart. Only decide with explicit authority for that review. Show/events never execute.
Export writes a read-only JSON evidence snapshot for this release, with source/input/output and actors excluded by default. Use --include-private only when authorized to include the full retained run/journal; inline secrets may be present. Credential tables and separate model/test records are not included. Files are owner-only and refuse overwrite unless --overwrite is explicit. Snapshot/file SHA-256 receipts detect changes, not authenticity or external outcomes. Export never resumes execution and is not a runnable app, database backup or replay artifact.
Cancellation retains the last checkpoint and unsettled attempt; it never undoes external effects or proves a provider stopped. Inspect cancellation.status: requested is not stopped. Use the original request UUID for retry. A competing process cannot cancel through a data directory owned by a running process; use that owner's API if available. Cancelled runs cannot resume or accept approval decisions.
Exit codes: 0 completed/read or pause/cancellation-submission success; 1 operational error; 2 invalid command/readiness; 3 waiting/paused; 4 workflow failed; 5 uncertain dispatch; 7 cancelled execution/retry. Pause request success is not proof that the current node has stopped.

Model workflows require separately configured provider connections and credentials. configuration.json lists exact routes/models/timeouts and the input schema. No credentials or originating runtime state are exported.
node app.mjs providers-list
node app.mjs providers-set --file /path/to/connection.json --expected-generation 0
node app.mjs credentials-status provider/key
node app.mjs credentials-set provider/key --file /path/to/private-key-file --expected-generation 0
Use an owner-only key file. A connection JSON has these fields (replace the example route/model/endpoint with your selected provider):
{"id":"configured-route","provider":"selected-provider","protocol":"openai-compatible","endpoint":"https://api.example.com/v1","allowedModels":["selected-model"],"authentication":{"kind":"bearer","credentialRef":"provider/key"},"tokenParameter":"max_tokens","maxRequestBytes":1000000,"maxResponseBytes":1000000,"maxStreamEvents":10000,"maxTimeoutSeconds":60}
The id/provider/model must match configuration.json; maxTimeoutSeconds must admit the workflow timeout. Use authentication.kind none only for an explicitly unauthenticated endpoint. HTTPS is required except for loopback fixture HTTP. The runtime never infers a route or falls back to another provider.
Readiness checks do not contact a provider. Authored secrets in the workflow are not automatically redacted: inspect source before sharing.

Use --telemetry-file /private/path/otel.json on an explicit execution/notify job or serve to enable OTLP traces, metrics and logs; export is disabled by default. HTTP/protobuf is the default protocol; gRPC is explicitly supported by this bundled runtime. Replace the example destinations below with an independently reviewed, authorized Collector before creating the private JSON file. No example URL authorizes export. Omit any endpoint to disable that signal; at least one is required and no destination is inferred. Authentication kind none is only for an explicitly unauthenticated Collector. For bearer authentication use {"kind":"bearer","credentialRef":"otel/key"} and provision that secret separately with credentials-set before serving; never place it in the configuration, workflow, image or archive.
OTLP HTTP/protobuf configuration:
{"protocol":"http/protobuf","endpoint":"https://collector.example/v1/traces","metricsEndpoint":"https://collector.example/v1/metrics","logsEndpoint":"https://collector.example/v1/logs","authentication":{"kind":"none"}}
OTLP/gRPC configuration (origin-only URLs, not /v1 paths):
{"protocol":"grpc","endpoint":"https://collector.example:4317","metricsEndpoint":"https://collector.example:4317","logsEndpoint":"https://collector.example:4317","authentication":{"kind":"none"}}
Remote Collector connections require verified TLS. Explicit loopback HTTP is for local Collectors/fixtures only. For a separately reviewed private CA, provision NODE_EXTRA_CA_CERTS=<reviewed-CA-bundle> before starting the process. This extends process-wide outbound trust; it does not select a destination or authorize export. Review recipient and Collector CAs independently when both need additional trust. The status/request client's --ca-file configures only trust of the API server, not outbound notification or Collector connections. Never disable certificate/hostname verification.
Optional sampleRatio:0 suppresses trace export while retaining unsampled trace identities and independently enabled correlated logs/metrics. Optional httpRequests:true enables bounded API request observations. Independently optional httpConnections:true observes owned TCP lifetime and parser/client/TLS/connection-limit events with fixed labels and independent root contexts, never peer addresses, certificates or raw errors. Socket close is not request/workflow success; failure events are not unique clients or durable audit records. Neither option grants execution or notification authority. Notification intents retain their actual trace identity and verified workflow/predecessor links before transport. The signed event is unchanged and carries no trace headers or private review data. Collector certificate refusal/rejection does not change accepted delivery or allow another send; later trusted same-ID reads do not reconstruct missing telemetry. A separately authorized new predecessor-linked delivery may reference an earlier identity whose span never reached the Collector.
Trace/log metadata includes workflow/run/node IDs and timing, not prompts, input/output payloads, actors or raw errors. Structured logs cover ended execution/model, opted-in API and explicit notification observations; a model-call event does not prove node settlement. Metrics use bounded labels, process-local counts/durations and reported token usage; segments are not unique runs, active segments are not approval backlog and HTTP acceptance is not human delivery. Collector failures never authorize workflow/model/notification replay. Verified TLS and OTLP responses do not prove production retention, dashboards, alerts or downstream receipt. Complete instrumentation, production backend operations and container/cluster observability qualification remain separate work.
This release app has CLI jobs, an optional exact-release HTTP/HTTPS service and its owner browser page, not the authoring API or a multi-user console. A separately provisioned Docker service can bind TLS to 0.0.0.0 inside the container while publishing only 127.0.0.1:<host-port>:<container-port> on the host; set public-origin to that exact host HTTPS origin. Provision node-owned private certificate/key/token files separately in the private volume; never bake them into the image. Host-loopback HTTPS is fixture-qualified on the recorded Linux arm64/Node/Docker profile, not every engine or network. Inspect exact image/mounts/port binding, use verified client trust, and confirm successful SIGTERM drain before replacing the container. Proxy ingress, broader managed Docker authoring/deployment, Kubernetes, embedded-browser and broader browser testing, and distributed execution/multi-replica storage remain separate work. Do not treat the single-owner token as multi-user authentication.
Dockerfile/Compose are optional build inputs; ZIP generation is not image qualification. The authoring CLI offers explicit releases build-image/save-image with identity receipts. Set NODE_IMAGE to a trusted compatible Node image digest. Docker is optional for local execution.
Compose runs a single explicit job, not an always-on HTTP service. Supply INPUT_FILE, RUN_ID and NODE_IMAGE; secrets must be provisioned separately.
Image building/publishing/deployment requires separate authorization. Do not put secrets or your home directory into the image build context.
Keep NOTICES.txt with the runtime. Source project and creator metadata are historical claims in transferred releases, not local approval evidence.
`;
const postgresGuide = `PostgreSQL release profile
This app includes the pure JavaScript PostgreSQL driver and Jevable workflow runtime. No npm install, skill, harness, desktop or source checkout is needed.
A separately provisioned PostgreSQL database IS required. Every stateful command below (check/run/show/events/usage/approvals/export/review/decide/cancel/pause/step/continue/recover/notify, provider/credential commands and serve) must additionally receive:
  --database-file /private/path/database.json
info/token/status/request do not open a database. No --data-dir, storage switch, ambient PG variables, pg-native, implicit connection or SQLite fallback is supported.
The database file is bounded JSON, a regular non-symlink file owned by the process user with no group/other permissions on POSIX. It contains explicit host, port, database, user, password, namespace, initialize and tls. Example shape (replace all deployment values):
{"host":"database.example.com","port":5432,"database":"workflow","user":"workflow","password":"replace-privately","namespace":"production-workflow","initialize":false,"tls":{"mode":"verify-full"}}
Supply tls.ca for a private CA; certificate chain and hostname are verified. The loopback-test TLS mode is exclusively for local fixtures using literal 127.0.0.1 or ::1, not production or container-to-host database routing. No database, role, certificate, schema migration or backup/restore provisioning is performed by export. initialize:true is an explicit operator choice to create the current namespace/schema on an authorized database; do not enable it casually against existing data.
Provider credentials and runs are retained in that database namespace. Its one active owner excludes another SDK, CLI or service until close. The app does not automatically reconnect or retry uncertain writes. Reopen and inspect the original UUID after owner loss.
The release hash pins the workflow AND the bundled runtime bytes. Export does not replace an old runtime checksum or transfer originating database configuration, provider credentials or journals. Review source and verify the trusted ZIP checksum before execution.
Release HTTP runs.list requires an explicit page, e.g. {"operation":"runs.list","page":{"limit":100}}. Cursor values name only this release's retained runs; v2 events/evidence use exact decimal sequence/version strings.
Dockerfile and Compose export/build inputs are supported. PostgreSQL container qualification is scoped to the recorded Linux arm64 cached-base profile: explicit verified database TLS, separate private non-root configuration and host-loopback HTTPS. Test model/collector endpoints share a loopback network namespace. This does not qualify production database roles/provisioning/migrations/restore, external provider networking, forced termination or Kubernetes. Check the distribution's PostgreSQL image qualification receipt; export/build success alone is not deployment qualification.

` + guide
    .replace('Select --data-dir explicitly for independent installations; default is .jevable beside app.mjs. Its SQLite journal persists after exit.', 'Select --database-file explicitly for every stateful invocation. Its independently provisioned PostgreSQL journal persists after app exit; no local .jevable state is created.')
    .replace('--data-dir /private/path/workflow-state', '--database-file /private/path/database.json')
    .replace('the service exclusively owns its state directory', 'the service exclusively owns its database namespace')
    .replace('a data directory owned by a running process', 'a database namespace owned by a running process')
    .replace('Host-loopback HTTPS is fixture-qualified on the recorded Linux arm64/Node/Docker profile, not every engine or network.', 'SQLite and PostgreSQL release images have separate exact-artifact host-loopback HTTPS qualification records; neither qualifies every engine or network.')
    .replace('Supply INPUT_FILE, RUN_ID and NODE_IMAGE;', 'Supply INPUT_FILE, RUN_ID, NODE_IMAGE and DATABASE_FILE;');
/** Fixed allowlist assembled from a saved release plus this distribution's exact prebuilt runtime. */
export function createReleaseFiles(value, artifact) {
    const release = inspectRelease(value.snapshot);
    if (artifact.storage !== 'sqlite' && artifact.storage !== 'postgres')
        throw new WorkflowRuntimeError('invalid-command');
    if (artifact.rateCoordinator !== undefined && (artifact.rateCoordinator !== 'postgres' || artifact.storage !== 'sqlite'))
        throw new WorkflowRuntimeError('invalid-command');
    if (release.sha256 !== value.sha256 || release.snapshot.runtime.sha256 !== digest(artifact.bytes)
        || release.snapshot.runtime.version !== artifact.identity.version || artifact.identity.sha256 !== digest(artifact.bytes))
        throw new WorkflowRuntimeError('conflict');
    const contents = {
        'release.json': JSON.stringify(release, null, 2) + '\n', 'workflow.yaml': release.snapshot.workflow.yaml,
        'runtime.mjs': artifact.bytes, 'app.mjs': bootstrap(), 'NOTICES.txt': artifact.notices,
        'README.txt': (artifact.storage === 'postgres' ? postgresGuide : guide) + '\n' + releaseCommandReference(artifact.storage, artifact.rateCoordinator),
        'configuration.json': JSON.stringify({ ...releaseRequirements(release.snapshot), storage: artifact.storage,
            ...(artifact.rateCoordinator ? { rateCoordinator: artifact.rateCoordinator } : {}) }, null, 2) + '\n',
        'Dockerfile': 'ARG NODE_IMAGE\nFROM ${NODE_IMAGE}\nWORKDIR /app\nCOPY --chown=node:node app.mjs runtime.mjs release.json workflow.yaml configuration.json manifest.json NOTICES.txt README.txt Dockerfile compose.yaml .env.example .dockerignore ./\nRUN mkdir -p /data && chown node:node /data && chmod 700 /data\nUSER node\nENTRYPOINT ["node", "app.mjs"]\nCMD ["info"]\n',
        '.dockerignore': '*\n!app.mjs\n!runtime.mjs\n!release.json\n!workflow.yaml\n!configuration.json\n!manifest.json\n!NOTICES.txt\n!README.txt\n!Dockerfile\n!compose.yaml\n!.env.example\n!.dockerignore\n',
        'compose.yaml': 'services:\n  workflow:\n    build:\n      context: .\n      args:\n        NODE_IMAGE: "${NODE_IMAGE:?Set an explicit compatible Node image digest}"\n    command: ["run", "--input", "/input/input.json", "--id", "${RUN_ID:?Set the retained run UUID}", "--data-dir", "/data"]\n    volumes:\n      - workflow-data:/data\n      - type: bind\n        source: "${INPUT_FILE:?Set the absolute input JSON path}"\n        target: /input/input.json\n        read_only: true\nvolumes:\n  workflow-data:\n',
        '.env.example': '# Optional Compose configuration; local execution does not load this file.\n# NODE_IMAGE must be a compatible Node >=22.19 image pinned with @sha256:<digest>.\n# Set INPUT_FILE to the absolute input JSON path and RUN_ID to a retained UUID.\n# Never put provider credentials in this file or the build context.\n',
    };
    if (artifact.storage === 'postgres') {
        contents['compose.yaml'] = 'services:\n  workflow:\n    build:\n      context: .\n      args:\n        NODE_IMAGE: "${NODE_IMAGE:?Set an explicit compatible Node image digest}"\n    command: ["run", "--input", "/input/input.json", "--id", "${RUN_ID:?Set the retained run UUID}", "--database-file", "/config/database.json"]\n    volumes:\n      - type: bind\n        source: "${INPUT_FILE:?Set the absolute input JSON path}"\n        target: /input/input.json\n        read_only: true\n      - type: bind\n        source: "${DATABASE_FILE:?Set the absolute private database JSON path}"\n        target: /config/database.json\n        read_only: true\n';
        contents['.env.example'] += '# PostgreSQL only: set DATABASE_FILE to an owner-only JSON file readable by container uid 1000. Database credentials stay outside this archive and image context.\n# Provision a reachable PostgreSQL endpoint with verified TLS separately. Container loopback is not host loopback.\n';
    }
    const files = Object.fromEntries(Object.entries(contents).map(([name, bytes]) => [name, Buffer.from(bytes)]));
    const manifest = { format: 'jevable.ai/release-zip', version: 1, releaseId: release.snapshot.id, releaseSha256: release.sha256,
        revision: release.snapshot.workflow.revision, runtime: release.snapshot.runtime, storage: artifact.storage, tests: 'not-included',
        ...(artifact.rateCoordinator ? { rateCoordinator: artifact.rateCoordinator } : {}),
        files: Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.byteLength, sha256: digest(bytes) })) };
    files['manifest.json'] = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    if (Object.values(files).some(bytes => bytes.byteLength > 32_000_000) || Object.values(files).reduce((sum, bytes) => sum + bytes.byteLength, 0) > 48_000_000)
        throw new WorkflowRuntimeError('limit');
    return files;
}
export function createReleaseZip(value, artifact) {
    return Buffer.from(zipSync(createReleaseFiles(value, artifact), { level: 6, mtime: zipEpoch() }));
}
/** Explicit review material; never a runtime database, approval grant, or release execution attestation. */
export async function createReleaseZipWithEvidence(value, artifact, input) {
    // Copy the entire admitted executable release before yielding to nested ZIP inspection.
    const files = createReleaseFiles(value, artifact);
    const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString('utf8'));
    const evidence = await prepareEvidenceAttachment(input, manifest.revision);
    files['evidence.zip'] = evidence.bytes;
    files['app.mjs'] = Buffer.from(bootstrap(true));
    files['README.txt'] = Buffer.concat([Buffer.from(Buffer.from(files['README.txt']).toString('utf8').replace('No credentials or originating runtime state are exported.', 'Provider credential tables and executable storage are not exported. The explicitly attached review evidence may contain retained inputs, outputs, inline secrets and test data; see its warning below.')), Buffer.from(`
Review-only execution evidence

evidence.zip is an explicitly selected, checksum-pinned review attachment. It may contain private inputs, outputs, prompts and test expectations. Protect this entire ZIP and any image built from it accordingly. Attachment privacy is declared, not independently attested.
Only matching workflow revisions are checked; evidence does not prove execution of this release, ownership of its project, successful tests, publisher authenticity or approval authority. Inspect it with the standalone Jevable evidence inspector using its reviewed SHA-256 before relying on it.
The launcher verifies the attachment bytes but never unpacks, imports or restores them. New execution uses independently configured state. Missing or changed evidence refuses startup; export a new evidence-free ZIP instead of editing the manifest to remove it.
WARNING: Building the included Dockerfile/Compose configuration includes evidence.zip, including any private payloads, in the image. Do not publish it without reviewing that disclosure. Normal releases build-image exports are evidence-free; this attachment option does not build or publish an image.
`)]);
    files['Dockerfile'] = Buffer.from(Buffer.from(files['Dockerfile']).toString('utf8').replace(' .env.example .dockerignore ./', ' .env.example .dockerignore evidence.zip ./'));
    files['.dockerignore'] = Buffer.concat([Buffer.from(files['.dockerignore']), Buffer.from('!evidence.zip\n')]);
    delete files['manifest.json'];
    files['manifest.json'] = Buffer.from(JSON.stringify({ ...manifest, version: 2, tests: 'review-attachment-only', evidence: evidence.descriptor,
        files: Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.byteLength, sha256: digest(bytes) })) }, null, 2) + '\n');
    if (Object.values(files).some(bytes => bytes.byteLength > 32_000_000) || Object.values(files).reduce((sum, bytes) => sum + bytes.byteLength, 0) > 48_000_000)
        throw new WorkflowRuntimeError('limit');
    return { bytes: Buffer.from(zipSync(files, { level: 6, mtime: zipEpoch() })), evidence: evidence.descriptor, inspection: evidence.inspection };
}

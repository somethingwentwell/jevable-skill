import { parseArgs, isDeepStrictEqual } from 'node:util';
import { capabilities, CORE_VERSION } from "./capabilities.js";
import { DEFAULT_COMPILER_LIMITS } from "./limits.js";
import { validateSource } from "./validation.js";
import { WorkflowImportError, compileWorkflow } from "./workflow/index.js";
import { listTemplates, renderTemplate } from "./templates/index.js";
import { readBoundedFile, readBoundedBytes, readBoundedRegularBytes, writeArtifact } from "./files.js";
import { releaseNotesSchema, RELEASE_NOTES_MAX_BYTES } from "./releases/snapshot.js";
import { releaseMessageRunId } from "./releases/messages.js";
import { readBreakpointFile } from "./runtime/control-file.js";
import { triggerMetadata } from "./runtime/trigger.js";
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { activityReportSchema } from "./runtime/activity.js";
import { collectorProbeReportSchema } from "./telemetry/probe-report.js";
import { createCollectorGatewayBundle, COLLECTOR_GATEWAY_OPTIONS_MAX_BYTES } from "./telemetry/gateway.js";
import { z } from 'zod';
import { createProjectZip, createProjectZipWithEvidence, readProjectZip, ProjectPackageError, PROJECT_PACKAGE_LIMITS } from "./packages/project-zip.js";
import { createVendorOriginZip, inspectVendorOriginZip, VendorOriginPackageError, VENDOR_ORIGIN_LIMITS } from "./packages/vendor-origin.js";
import { EVIDENCE_ATTACHMENT_LIMIT } from "./evidence/attachment.js";
import { resolve, dirname } from 'node:path';
import { userInfo } from 'node:os';
import { WorkflowRuntimeError } from "./runtime/errors.js";
import { notificationProjectScopeSchema, inspectProjectNotificationPage } from "./notifications/project-history.js";
import { automaticDiagnosticSchema, automaticDiagnosticStatusSchema, inspectAutomaticDiagnosticPage } from "./notifications/automatic-diagnostics.js";
import { ProviderError, reference } from "./providers/config.js";
import { readSecretFile, readSecretStdin } from "./providers/secret-input.js";
import { renderPreview, renderVendorImportPreview } from "./preview/index.js";
import { RuntimeClient, RuntimeHttpError } from "./http/client.js";
import { serveFromCli, RuntimeStartupError, RuntimeServiceUsageError } from "./http/cli-service.js";
import { readTlsPemFile } from "./http/tls.js";
import { ImageError } from "./images/docker.js";
import { parseTest, testDefinitionSchema } from "./testing/schema.js";
import { testErasurePreparationSchema } from "./testing/erasure.js";
import { testErasureCommandSchema, testErasureReceiptSchema } from "./testing/erasure-write.js";
import { storageSelection, CliStorageUsageError } from "./cli/runtime.js";
import { JournalError } from "./storage/errors.js";
import { recordPageSchema, auditPageSchema } from "./http/pagination.js";
import { doctor, doctorSelection } from "./cli/doctor.js";
import { watchFromCli } from "./cli/watch.js";
import { RunWatchError } from "./http/watch.js";
import { suiteFromCli, suiteSelection } from "./cli/suite.js";
import { suiteTelemetryFlags } from "./cli/suite-telemetry.js";
import { dockerFlags, dockerFromCli } from "./cli/docker.js";
import { DockerLifecycleError } from "./docker/owner.js";
import { startPreviewFromCli, previewSelection, portablePreviewSelection } from "./cli/preview.js";
import { runServiceProcess } from "./http/process.js";
import { readTraceViewerFile } from "./cli/trace-viewer.js";
import { prepareTraceNavigation } from "./preview/trace-navigation.js";
import { createEvidenceZip, inspectEvidenceSelection, inspectEvidenceZip, EVIDENCE_PACKAGE_LIMITS } from "./evidence/index.js";
import { inspectUsageSelection } from "./evidence/usage.js";
import { operationFlags, operationSelection, operationResult, operationRelease, importedOperationTests, runResultSchema, testResultSchema, resultExit } from "./cli/operations.js";
import { CliJobLifetime, CliJobInterruptedError, openJobOperations } from "./cli/job-lifetime.js";
import { approvalNotificationPinSchema, notificationRequestSchema, notificationReceiptSchema, notificationAbortResultSchema } from "./notifications/schema.js";
import { inspectNotificationPage, notificationPageRequestSchema } from "./notifications/history.js";
import { parseHelpRequest, commandHelp, CliCommandHelp, CliHelpInputError, helpReport, renderHelp, CLI_HELP_PATHS } from "./cli/help.js";
import { validateCliFlagRequirements, CliFlagRequirementsError } from "./cli/requirements.js";
import { listSchemas, showSchema, SchemaDiscoveryError } from "./contracts.js";
import { previewVendorImport, vendorImportCommandSchema, vendorImportViewSchema } from "./projects/vendor-import.js";
import { prepareGrantToken, grantIssueSchema, grantMetadataSchema, grantPageResultSchema, GRANT_LIMITS } from "./access/grants.js";
import { reviewerFromCli, reviewerSelection } from "./cli/reviewer.js";
import { callerFromCli, callerSelection, callerStreamFromCli } from "./cli/caller.js";
import { readCliTraceContext } from "./cli/trace-context.js";
import { AccountError, AccountSessionError } from "./account/index.js";
import { ACCOUNT_ACTIONS, accountStrings, accountBooleans, accountSelection, accountFromCli, AccountCliInputError } from "./cli/account.js";
import { createCliOutput, encodeCliJson, CliOutputError } from "./process/cli-output.js";
const serveFlags = ['token-file', 'port', 'data-dir', 'storage', 'database-file', 'drain-wait-ms', 'release-file', 'release-sha256', 'public-origin', 'bind-address', 'tls-cert-file', 'tls-key-file', 'notifications-file', 'async-concurrency', 'rate-limits-file', 'rate-coordinator-file', 'webhooks-file'];
function cliTriggerMode(value) {
    if (value !== undefined && value !== 'api')
        throw new UsageError('Only --trigger-mode api is supported; omit it for the existing local manual/chat entry contract.');
    return value;
}
const HELP = `Jevable ${CORE_VERSION} — standalone workflow core

Available commands:
  jevable account prepare --issuer <reviewed-https-origin> --session-dir <fresh-private-path> --name <key-label>
  jevable account inspect|link --issuer <same-origin> --session-dir <retained-private-path>
  jevable account exchange --issuer <same-origin> --session-dir <path> --session-id <uuid>
      --authorization-sha256 <reviewed-hash> --code-file <protected-code-file> --confirm-exchange
      Or --code-stdin instead of --code-file; never put a code or key in arguments.
  jevable account status|revoke --issuer <same-origin> --session-dir <path> --session-id <uuid>
      --authorization-sha256 <hash> --key-id <uuid> --grant-sha256 <hash>
      Revoke requires --confirm-revoke <same-key-id>. Status reveals details only with --include-private.
      Network calls accept --ca-file and --timeout-ms <1-60000>; local fixtures require --allow-loopback-http.
      Optional independent website account; no browser opens, workflow authority, discovery or retry.
  jevable schemas list [--json]
  jevable schemas show <schema-id> [--json]
      Offline input JSON Schema discovery; does not replace core validation, readiness or authority.
  jevable help [<complete command path>] [--json]
  jevable <complete command path> --help [--json]
      Read-only parser flag/count discovery. Omit positional values and execution options.
  jevable runtime start [--runtime local] <runtime serve options>
      Local is the default; runs in the foreground, with no Docker dependency.
  jevable runtime start --runtime docker --image-receipt <management-image.json>
      --receipt-sha256 <reviewed-file-hash> --owner-file <new-private-owner.json> --port <1024-65535>
      --token-file <private-token> --tls-cert-file <certificate> --tls-key-file <private-key>
      [--telemetry-file <private-otlp-config.json>] [--telemetry-credential-file <private-bearer-secret>]
      [--telemetry-ca-file <private-ca.pem>] (adds process-wide Node TLS trust, not collector-only)
      [--notifications-file <private-config.json>] [--notifications-ca-file <private-ca.pem>]
      [--rate-limits-file <private-policy.json>] [--async-concurrency <1-64>]
      Notification CA also adds process-wide trust; keys use protected credential commands. Startup never sends.
      [--network <existing-bridge-name> --network-id <reviewed-full-network-id>]
      [--storage sqlite | --storage postgres --database-file <private-verified-tls-config.json>]
      [--ca-file <ca.pem>] [--memory-mb <128-65536>] [--cpus <1-64>] [--wait-ms <0-60000>]
  jevable runtime inspect --runtime docker --owner-file <owner.json> --owner-sha256 <reviewed-hash>
      [--token-file <private-token> --ca-file <ca.pem>]
  jevable runtime stop|restart --runtime docker --owner-file <owner.json> --owner-sha256 <reviewed-hash>
      --container-id <full-reviewed-id> [--wait-ms <0-60000>]
      Restart also requires --token-file <private-token> [--ca-file <ca.pem>].
      Stop sends SIGTERM only; volumes are retained. Unready/draining exits 8; no automatic replay.
  jevable runtime build-image --runtime-sha256 <reviewed-management-bundle-sha256>
      --base-image <cached-node-image@sha256:digest> --platform linux/arm64|linux/amd64
      --docker-context <local-context> --tag <unused-tag> --output <management-image.json>
  jevable runtime save-image <management-image.json> --receipt-sha256 <reviewed-file-sha256>
      --output <management-image.tar> [--overwrite]
  jevable runtime export --output <management.zip> [--runtime-rate-coordinator postgres] [--overwrite]
  jevable runtime lock inspect --state-dir <private-state>
  jevable runtime lock inspect-recovery --state-dir <private-state>
  jevable runtime lock recover --state-dir <private-state> --request-id <uuid>
      --owner <reviewed-lock-owner-uuid> --lock-sha256 <reviewed-lock-bytes-hash> --confirm-recover
      Explicit supported Linux same-boot lock recovery; preserves evidence, never opens/resumes workflows.
  jevable runtime lock complete-recovery --state-dir <private-state> --request-id <retained-uuid>
      --owner <reviewed-lock-owner-uuid> --lock-sha256 <reviewed-lock-bytes-hash> --confirm-recover
      Finish only a proof-bearing interrupted recovery whose original owner and recoverer have exited.
  jevable skill export --output <jevable-skill.zip> [--runtime-rate-coordinator postgres] [--overwrite]
  jevable skill inspect <jevable-skill.zip> [--sha256 <trusted-artifact-hash>] [--json]
      Standalone management CLI/API, not a workflow release; exports no state or credentials.
  jevable tests suite create <selection.json> --output <suite.json> [--overwrite]
  jevable tests suite inspect <suite.json>
  jevable tests suite run <suite.json> --suite-sha256 <reviewed-manifest-hash>
  jevable tests suite result <suite.json>
  jevable tests suite coverage <suite.json> --file <matching-workflow.yaml>
      Suite run/result accept direct storage flags or --endpoint <url> --token-file <private-file>
      [--ca-file <ca.pem>] [--timeout-ms <1-3600000>]. Suites never auto-approve or resume.
  jevable runs watch <run-id> --endpoint <url> --token-file <private-token-file>
      [--ca-file <ca.pem>] [--release-sha256 <reviewed-release-hash>]
      [--interval-ms <100-60000>] [--duration-ms <1-3600000>] [--follow] [--json]
      Emits redacted NDJSON; read-only. Watch exits 8 on deadline, 130/143 on interruption.
  jevable runs export <run-id> --output <evidence.json> [--include-private] [--overwrite] [--data-dir <directory>]
  jevable runs export-bundle <selection.json> --output <evidence.zip> [--include-private] [--overwrite] [--data-dir <directory>]
  jevable runs inspect-bundle <evidence.zip> [--sha256 <trusted-artifact-hash>] [--json]
      Package selected retained runs and historical test assessments; no execution or restoration.
  jevable usage report <selection.json> [--data-dir <directory>] [--json]
      Summarize reported tokens for selected run IDs/revisions; missing usage is not zero or a bill.
  jevable activity report [--data-dir <directory>] [--json]
  jevable telemetry probe [--data-dir <directory>] [--telemetry-file <config.json>] [--json]
  jevable telemetry export-gateway --options-file <gateway.json> --options-sha256 <reviewed-hash>
      --output <gateway.zip> [--overwrite] [--json]
      Offline Collector configuration only; no installation, startup, signal export or deployment.
      Observe retained project/proposal/import/run counts; not account, billing or lifetime totals.
  jevable approvals list --page [--after <run-id>] [--limit <1-200>] [--data-dir <directory>]
      List waiting tasks from one live run page; follow nextCursor even on an empty task page. No decisions or expiry settlement.
  jevable approvals notify destinations [--notifications-file <private-config.json>] [--data-dir <directory>]
  jevable approvals notify prepare <run-id> --revision <hash> --attempt <id> --destination <id>
      [--notifications-file <private-config.json>] [--data-dir <directory>]
  jevable approvals notify send <reviewed-request.json> [--notifications-file <private-config.json>] [--data-dir <directory>]
  jevable approvals notify show <retained-request-id> [--data-dir <directory>]
  jevable approvals notify abort <retained-request-id> [--data-dir <directory>]
  jevable approvals notify list --page [--after <request-id>] [--limit <1-200>] [--data-dir <directory>]
    [--project-id <uuid> --generation <historical-generation> --revision <hash>]
    [--outcome pending|accepted|rejected|uncertain] [--event-kind requested|decided|expired|cancelled]
    [--created-from <UTC-ISO-milliseconds>] [--created-before <UTC-ISO-milliseconds>]
      Prepare accepts --event-kind requested|decided|expired|cancelled (requested by default); lifecycle events require retained records.
      Notification commands also accept selected-owner options; configuration stays on the service host.
      SQLite/PostgreSQL management. Retain requestId before sending; redelivery needs a new ID and redeliverOf.
      Abort signals only this owner's active delivery; inspect its final outcome. No effect retraction or workflow cancellation.
      Send exit 0 means HTTP acceptance, not human delivery/approval; rejected=1, pending/uncertain=5.
  jevable runs traces <run-id> [--trace-viewer-file <viewer.json>] [--data-dir <directory>]
      Read retained trace references and prepare links; never contact or open the viewer.
  jevable runs step|continue <run-id> --request-id <retained-control-uuid>
      --checkpoint-sha256 <reviewed-checkpoint-hash> [--breakpoints-file <node-ids.json>] [--data-dir <directory>]
  jevable runs pause <run-id> --request-id <retained-control-uuid>
      --checkpoint-sha256 <reviewed-checkpoint-hash> [--data-dir <directory>]
      Persist cooperative pause; do not abort/replay the current node. Receipt success is not proof of stopping.
  jevable doctor [--storage sqlite --data-dir <directory> | --storage postgres --database-file <private-file>]
      [--telemetry-file <config.json>] [--json]
  jevable doctor --endpoint <url> --token-file <private-token-file> [--ca-file <ca.pem>] [--timeout-ms <1-30000>]
  jevable capabilities [--json]
  jevable runtime token --output <private-token-file> [--json]
  jevable grants token --id <retained-grant-uuid> --output <new-private-token-file>
  jevable grants issue <reviewed-command.json> [--data-dir <directory>]
  jevable grants show <grant-id> [--data-dir <directory>]
  jevable grants list --page [--after <grant-id>] [--limit <1-200>] [--data-dir <directory>]
  jevable grants revoke <grant-id> --request-id <retained-uuid> --expected-generation 1 [--data-dir <directory>]
      Owner-only ledger administration; reviewer transport is a separate explicit service opt-in.
  jevable reviewer decide <retained-decision.json> --endpoint <reviewed-origin>
      --instance-id <reviewed-owner-uuid> --token-file <private-reviewer-token> [--ca-file <ca.pem>] [--timeout-ms <n>]
  jevable caller start <retained-start.json> | caller read <run-uuid>
      --endpoint <reviewed-origin> --instance-id <reviewed-owner-uuid> --release-pin-file <reviewed-pin.json>
      --token-file <private-caller-token> [--ca-file <ca.pem>] [--timeout-ms <n>]
  jevable caller stream <run-uuid> --endpoint <reviewed-origin> --instance-id <uuid>
      --release-pin-file <reviewed-pin.json> --token-file <private-caller-token> [--ca-file <ca.pem>]
      [--interval-ms <100-60000>] [--duration-ms <1-60000>] [--timeout-ms <n>] [--follow]
      Read-only metadata NDJSON via one bounded SSE connection; no completed output, reconnect or execution.
  jevable caller cancel <run-uuid> --request-file <retained-cancellation.json>
      --endpoint <reviewed-origin> --instance-id <reviewed-owner-uuid> --release-pin-file <reviewed-pin.json>
      --token-file <private-caller-token> [--ca-file <ca.pem>] [--timeout-ms <n>]
      Own-run explicit cancel permission; metadata receipt only. Retry observes, never aborts again or settles.
  jevable caller checkpoint <run-uuid> | caller control <run-uuid> --request-file <retained-control.json>
      --endpoint <reviewed-origin> --instance-id <reviewed-owner-uuid> --release-pin-file <reviewed-pin.json>
      --token-file <private-caller-token> [--ca-file <ca.pem>] [--timeout-ms <n>]
      Own-run explicit control permission; opaque checkpoint and metadata only. Identical retry only observes.
      Retained mode step|continue|pause|recover; recovery settles a saved response only, never downstream work.
      Metadata-only grant-derived decision. No owner credentials, service discovery, retries or local fallback.
      Token preparation is offline, never overwrites and prints only the digest, not the bearer.
  jevable preview <workflow.yaml> --serve --token-file <private-token-file> [--port <port>] [--data-dir <directory>] [--runtime local]
      Direct local alternative: --token-env <variable-name> instead of --token-file.
      Optional --auto-connect avoids browser key entry; trusts local processes, never auto-runs.
  jevable preview <workflow.yaml> --serve --storage postgres --database-file <private-database.json>
      --token-file <private-token-file> --project-id <retained-fresh-uuid> [--port <loopback-port>]
      [--trace-viewer-file <viewer.json>] configures links only; never probes or opens the viewer.
  jevable preview <workflow.yaml> --serve --runtime docker --owner-file <owner.json>
      --owner-sha256 <reviewed-hash> --container-id <full-reviewed-id> --token-file <owner-token>
      --preview-token-file <distinct-preview-token> --project-id <retained-fresh-uuid> [--ca-file <ca.pem>]
      [--port <loopback-preview-port>] [--timeout-ms <1-3600000>]
      To reopen a reviewed existing project, replace --project-id with
      --project-pin-file <pin.json> --project-pin-sha256 <reviewed-file-hash>.
      Pin: {id, generation, revision}. Startup only reads; no create or execution fallback.
  jevable runtime serve --token-file <private-token-file> [--port <0-65535>] [--reviewer-decisions] [--caller-operations] [--async-concurrency <1-64>]
      [--storage sqlite --data-dir <directory> | --storage postgres --database-file <private-database.json>]
      [--telemetry-file <explicit-otlp-config.json>] [--drain-wait-ms <1-60000>] [--json]
      [--notifications-file <private-config.json>] (management or exact release; never sends on startup)
      [--release-file <reviewed-snapshot.json> --release-sha256 <reviewed-hash>]
      [--public-origin <https://host:port> --bind-address <ip> --tls-cert-file <chain.pem> --tls-key-file <private.pem>]
  jevable runtime status --endpoint <url> --token-file <private-token-file> [--ca-file <ca.pem>]
  jevable runtime export-kubernetes --image-receipt <management-image.json> --receipt-sha256 <reviewed-hash>
      --options-file <management-kubernetes.json> --options-sha256 <reviewed-hash> --output <deployment.zip>
  jevable runtime request <operation.json> --endpoint <url>
      --token-file <private-token-file> [--ca-file <ca.pem>] [--timeout-ms <n>] [--json]
  jevable runtime submit <retained-start.json> --endpoint <url> --token-file <private-token-file> --instance-id <reviewed-uuid>
    [--release-pin-file <reviewed-release.json>] [--ca-file <ca.pem>] [--timeout-ms <1-3600000>] [--trace-context-file <private-file>]
  jevable runtime observe <run-id> --endpoint <url> --token-file <private-token-file> --instance-id <reviewed-uuid>
    [--release-pin-file <reviewed-release.json>] [--ca-file <ca.pem>] [--timeout-ms <1-3600000>]
  jevable validate <workflow.yaml> [--json]
  jevable preview <workflow.yaml> --output <workflow.html> [--overwrite] [--json]
  jevable check <workflow.yaml> [--data-dir <directory>] [--json]
  jevable tests list [--data-dir <directory>]
  jevable tests show <test-id> [--generation <n>] [--data-dir <directory>]
  jevable tests history <test-id> [--data-dir <directory>]
  jevable tests erasure-review <test-id> [--data-dir <directory>]
  jevable tests erase <retained-erasure-request.json> --confirm-delete <test-id> [--data-dir <directory>]
  jevable tests erasure <retained-request-id> [--data-dir <directory>]
  jevable tests create <definition.json> [--id <test-uuid>] [--data-dir <directory>]
  jevable tests generate <project-id> --expected-generation <n> --revision <accepted-hash>
      --id <generation-uuid> [--limit <1-32>] [--data-dir <directory>]
  jevable tests generations|generation [<generation-uuid>] [--data-dir <directory>]
  jevable tests edit <test-id> --file <definition.json> --expected-generation <n>
  jevable tests accept <test-id> --expected-generation <n> --sha256 <reviewed-definition-hash>
  jevable tests archive <test-id> --expected-generation <n> --sha256 <reviewed-definition-hash>
  jevable tests unarchive <test-id> --expected-generation <n> --sha256 <reviewed-definition-hash>
  jevable tests run <test-id> --expected-generation <n> --sha256 <reviewed-definition-hash> --id <run-uuid>
  jevable tests result <run-id> [--inspect] [--data-dir <directory>]
  jevable projects list|show [<project-id>] [--data-dir <directory>]
  jevable projects create <workflow.yaml> --title <title> [--id <project-uuid>]
  jevable projects propose <project-id> --file <workflow.yaml> --expected-generation <n>
      [--proposal-id <uuid>]
  jevable projects accept|reject <project-id> --proposal-id <uuid>
      --revision <reviewed-hash> --expected-generation <n>
      accept additionally supports --ack-approvals <json-array>; reject does not.
  jevable projects diff <project-id> --from <revision> --to <revision>
  jevable projects rename <project-id> --title <title> --expected-generation <n>
  jevable projects archive|unarchive <project-id> --expected-generation <n>
  jevable projects duplicate <project-id> --revision <accepted-hash> --title <title>
      --expected-generation <n> [--new-id <uuid>]
  jevable projects delete <project-id> --expected-generation <n> --confirm-delete <project-id>
  jevable projects deletions
  jevable projects export <project-id> --revision <accepted-hash> --expected-generation <n> [--tests]
      --output <file> [--format json|zip] [--history] [--overwrite]
      [--evidence-file <evidence.zip> --evidence-sha256 <reviewed-hash> [--include-private-evidence]]
  jevable projects restore <project-id> --revision <accepted-hash>
      --expected-generation <n> [--ack-approvals <json-array>]
  jevable projects run <project-id> --revision <accepted-hash> --expected-generation <n>
      --input <input.json> [--id <retry-uuid>] [--paused]
  jevable releases list|show [<release-id>] [--data-dir <directory>]
  jevable releases message-id <release-message-identity.json> [--json]
      Derive a stable run UUID offline; does not authenticate, execute or acknowledge a message.
  jevable releases create <project-id> --revision <accepted-hash> --expected-generation <n>
      --version <x.y.z> [--id <release-uuid>] [--notes-file <utf8.txt>] [--data-dir <directory>]
  jevable releases export <release-id> --release-sha256 <reviewed-hash> --format zip
      --output <release.zip> [--overwrite] [--data-dir <directory>]
      [--evidence-file <evidence.zip> --evidence-sha256 <reviewed-hash> [--include-private-evidence]]
  jevable releases build-image <release-id> --release-sha256 <reviewed-hash>
      --base-image <trusted-node-image@sha256:digest> --platform <linux/arm64|linux/amd64>
      --tag <repository:tag> --docker-context <local-context> --output <image-receipt.json>
      [--data-dir <directory>]
  jevable releases save-image <image-receipt.json> --receipt-sha256 <reviewed-file-hash>
      --output <image.tar> [--overwrite]
  jevable releases export-kubernetes <release-id> --release-sha256 <reviewed-hash>
      --image-receipt <image-receipt.json> --receipt-sha256 <reviewed-file-hash>
      --options-file <deployment.json> --options-sha256 <reviewed-file-hash>
      --output <deployment.zip> [--overwrite] [--data-dir <directory>]
  jevable kubernetes capacity <workload.yaml> --nodes-file <nodes.json> --pods-file <pods.json>
      Offline additional CPU/memory/pod-request diagnosis only; never applies, reserves, deletes or restarts.
  All projects commands accept --data-dir <directory> and --json.
  Commands with --data-dir also accept --telemetry-file <explicit-otlp-config.json>.
  jevable providers list|audit [--data-dir <directory>] [--json]
  jevable providers discover <connection-id> [--data-dir <directory>] [--json]
  jevable providers set <connection.json> --expected-generation <n>
      [--data-dir <directory>] [--json]
  jevable credentials status <ref> [--data-dir <directory>] [--json]
  jevable credentials clear <ref> --expected-generation <positive-n> [--data-dir <directory>] [--json]
  jevable credentials set <ref> --expected-generation <n> (--file <private-file> | --stdin)
      [--data-dir <directory>] [--json]
  jevable templates list [--language en|zh] [--json]
  jevable templates show <id> [--language en|zh] [--json]
  jevable templates render <id> --output <file.yaml>
      [--name <name>] [--language en|zh] [--provider <id> --model <id>]
      [--overwrite] [--json]
  jevable import preview <vendor-file> [--output <file>] [--output-format yaml|html] [--overwrite] [--json]
  jevable import vendor <vendor-file> --file <reviewed.yaml> --title <title> --id <UUID>
    --reviewed-source-sha256 <hash> --reviewed-conversion-sha256 <hash> --reviewed-revision <hash>
    [--data-dir <directory>] [--json]
  jevable import show <project-id> [--inspect] [--data-dir <directory>] [--json]
  jevable import export-origin <project-id> --reviewed-origin-sha256 <origin-hash>
      --include-private --output <origin.zip> [--overwrite] [--data-dir <directory>] [--json]
  jevable import inspect-origin <origin.zip> [--reviewed-sha256 <archive-hash>] [--json]
  jevable import inspect <project.json|project.zip> [--data-dir <directory>] [--json]
  jevable import project <project.json|project.zip> --reviewed-sha256 <file-hash>
      [--id <new-project-uuid>] [--data-dir <directory>] [--json]
  jevable run <workflow.yaml> --input <input.json> [--id <retry-uuid>] [--paused]
      [--trigger-mode api] [--data-dir <directory>] [--runtime local] [--json]
  jevable runs list|show|events|resume [<run-id>] [--data-dir <directory>] [--json]
  jevable runs cancel <run-id> --request-id <retained-cancellation-uuid> [--data-dir <directory>]
  jevable runs recover <run-id> --request-id <retained-control-uuid>
      --checkpoint-sha256 <reviewed-hash> [--data-dir <directory>]
  jevable approvals show <run-id> [--data-dir <directory>] [--json]
  jevable approvals decide <run-id> --attempt <id> --action <action>
      [--pause-after] [--data-dir <directory>] [--json]

Compilation is offline. It does not check runtime readiness or execute nodes.
API-only entry requires --trigger-mode api on check, run, projects run and tests generate.
Saved tests retain their reviewed triggerMode. Omission preserves manual/chat entry;
no webhook, public ingress, schedule or anonymous service is inferred.
Local execution supports configured OpenAI-compatible LLM/Decision steps, rules,
loops, outputs and outer Human Approval. Portable preview is inspection-only.
Local Docker image build/save is explicit; no push, workflow execution or deployment is implicit.
Projects, runs, approvals, tests/suites, check, providers, credentials, activity report,
import inspect/project and releases list/show/create/export/build-image/export-kubernetes accept
--runtime docker --owner-file <owner.json> --owner-sha256 <reviewed-hash>
--container-id <full-id> --token-file <private-token> [--ca-file <ca.pem>] [--timeout-ms <n>].
Alternatively select --endpoint <https-origin> --token-file <private-token>
[--ca-file <ca.pem>] [--instance-id <reviewed-runtime-uuid>] [--timeout-ms <n>].
Do not combine endpoint selection with --runtime or local/Docker ownership/storage options.
Use an already-running explicit owner; run/projects run, import project and
releases create require a retained --id. Import files and package outputs stay on the host.
Release creation verifies matching host/owner runtime bytes; packaging never substitutes them.
Remote execution never starts/restarts a container or opens local storage.
Local, Docker-backed and endpoint-backed live preview are experimental and browser-unqualified.
Selected-owner preview uses a separate loopback gateway/token and never owns remote storage.
Managed Kubernetes deployment remains unfinished. Release and PostgreSQL management
Kubernetes bundle export is offline; it neither applies manifests nor verifies a cluster.
State defaults to .jevable in the current directory, never desktop/harness data.
Per-operation commands optionally accept --trace-context-file <private-context.json>.
Only traceparent/baggage are admitted; runtime/provider baggage key approval is still required.
No inline values, ambient context, persisted carrier, preview startup or SSE propagation.
Direct jobs also accept --storage postgres --database-file <private-database.json>.
Paginated lists (runs, tests, test generations, deletions, provider audit, releases)
require --page for PostgreSQL; use --after <cursor> and --limit <1-200> to continue.
SQLite retains legacy unpaged output; --page explicitly selects a v2 page.
Exact-release serving supports both backends with a reviewed snapshot and hash.
Release creation accepts --runtime-storage sqlite|postgres (defaults to authoring storage).
Explicit --runtime-storage sqlite --runtime-rate-coordinator postgres selects a separate SQLite app with optional shared HTTP quotas; no workflow storage conversion.
Export/build-image select the exact saved runtime checksum; they never switch backend.
PostgreSQL apps require --database-file. Management preview is explicit loopback-only;
release apps have no preview, and cluster deployment remains unqualified.
Database configuration and passwords come from an owner-only file, never command arguments.
Exit codes: 0 completed; 1 operation failure; 2 invalid input; 3 waiting/paused;
            4 workflow failed; 5 uncertain dispatch or incomplete output (never automatically retried); 6 test expectation failed.
            7 cancelled execution; 8 Docker unready/draining or watch deadline; 130/143 interruption.
`;
class UsageError extends Error {
}
/** Parse each command separately so unknown, misplaced and misspelled options fail closed. */
function parseCommandArgs(argv, positionalCount, strings = [], booleans = []) {
    const options = { json: { type: 'boolean' } };
    for (const key of strings)
        options[key] = { type: 'string' };
    if (strings.includes('data-dir'))
        options['telemetry-file'] = { type: 'string' };
    for (const key of booleans)
        options[key] = { type: 'boolean' };
    let parsed;
    try {
        parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options });
    }
    catch {
        throw new UsageError('Invalid options. Run jevable --help.');
    }
    if (parsed.positionals.length !== positionalCount)
        throw new UsageError('Unexpected or missing arguments. Run jevable --help.');
    return parsed;
}
function language(value) {
    if (value === undefined || value === 'en')
        return 'en';
    if (value === 'zh')
        return 'zh';
    throw new UsageError('Language must be en or zh.');
}
function parseJobArgs(argv, count, strings, booleans = [], pagination, args = parseCommandArgs) {
    const parsed = args(argv, count, [...strings, 'storage', 'database-file', ...(pagination ? ['after', 'limit'] : [])], [...booleans, ...(pagination ? ['page'] : [])]);
    const selectedOwner = strings.includes('owner-file') && operationSelection(parsed.values) !== 'local';
    const storage = selectedOwner ? undefined : storageSelection(parsed.values);
    if (pagination && storage === 'postgres' && !parsed.values.page)
        throw new CliStorageUsageError('PostgreSQL list commands require --page; follow the returned cursor instead of treating one page as a complete list.');
    if (!parsed.values.page && (parsed.values.after !== undefined || (pagination && parsed.values.limit !== undefined))) {
        throw new CliStorageUsageError('--after and --limit require --page.');
    }
    let page;
    if (parsed.values.page) {
        const schema = pagination === 'audit' ? auditPageSchema : recordPageSchema;
        const result = schema.safeParse({ ...(parsed.values.after === undefined ? {} : { after: parsed.values.after }),
            ...(parsed.values.limit === undefined ? {} : { limit: typeof parsed.values.limit === 'string' && /^(0|[1-9][0-9]*)$/u.test(parsed.values.limit) ? Number(parsed.values.limit) : NaN }) });
        if (!result.success)
            throw new CliStorageUsageError('Invalid page cursor or limit (1–200).');
        page = result.data;
    }
    return { ...parsed, page };
}
function generation(value) {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(value) || !Number.isSafeInteger(Number(value)))
        throw new UsageError('Provide a nonnegative --expected-generation (0 for a new record).');
    return Number(value);
}
/** CLI entry is reusable in tests; importing the SDK never launches a process or a server. */
export async function main(argv, io) {
    const output = createCliOutput(io);
    const lifetime = new CliJobLifetime(receipt => {
        try {
            output.io.err(encodeCliJson(receipt, 'stderr', false));
        }
        catch (error) {
            if (error instanceof CliOutputError)
                output.record(error);
            else
                throw error;
        }
    });
    let result;
    try {
        try {
            result = await dispatchCli(argv, output.io, lifetime);
        }
        catch (error) {
            if (!(error instanceof CliOutputError))
                throw error;
            output.record(error);
            result = 5;
        }
    }
    finally {
        lifetime.dispose();
        await output.finish();
    }
    return lifetime.exitCode ?? (output.error ? 5 : result);
}
async function dispatchCli(argv, io, lifetime) {
    const openCliOperations = (values) => openJobOperations(values, lifetime);
    const emit = (value) => io.out(encodeCliJson(value));
    let help;
    let commandPath = '';
    // Per-invocation interception avoids global help state and uses the real dispatcher grammar.
    const args = (tail, count, strings = [], booleans = []) => {
        if (help)
            commandHelp(tail, count, strings, booleans);
        const parsed = parseCommandArgs(tail, count, strings, booleans);
        const options = Object.fromEntries(strings.map(key => [key, 'string']));
        if (strings.includes('data-dir'))
            options['telemetry-file'] = 'string';
        for (const key of booleans)
            options[key] = 'boolean';
        validateCliFlagRequirements(commandPath, parsed.values, options, parsed.positionals);
        // Reuse the consuming mode's pure selector before any source/manifest/config reads.
        if (commandPath === 'preview') {
            if (parsed.values.serve)
                previewSelection(parsed.values);
            else
                portablePreviewSelection(parsed.values);
        }
        else if (commandPath === 'doctor')
            doctorSelection(parsed.values);
        else if (commandPath === 'reviewer decide')
            reviewerSelection(parsed.values);
        else if (commandPath.startsWith('caller '))
            callerSelection(parsed.values);
        else if (commandPath === 'tests suite run' || commandPath === 'tests suite result' || commandPath === 'tests suite coverage')
            suiteSelection(parsed.values);
        else if (options['owner-file'] && options.endpoint)
            operationSelection(parsed.values);
        else if (options.storage && options['database-file'])
            storageSelection(parsed.values);
        return parsed;
    };
    const jobArgs = (tail, count, strings, booleans = [], pagination) => parseJobArgs(tail, count, strings, booleans, pagination, args);
    try {
        if (!argv.length || (argv.length === 1 && ['--help', '-h'].includes(argv[0]))) {
            io.out(HELP);
            return 0;
        }
        if (argv.length === 1 && argv[0] === '--version') {
            io.out(`${CORE_VERSION}\n`);
            return 0;
        }
        help = parseHelpRequest(argv);
        if (help) {
            const path = help.path.join(' ');
            if (!path || CLI_HELP_PATHS.some(x => x.startsWith(path + ' '))) {
                const report = helpReport(help.path);
                help.json ? emit(report) : io.out(renderHelp(report));
                return 0;
            }
            argv = help.path;
        }
        commandPath = CLI_HELP_PATHS.find(path => argv.slice(0, path.split(' ').length).join(' ') === path) ?? '';
        const [command, ...rest] = argv;
        if (command === 'kubernetes') {
            if (rest[0] !== 'capacity')
                throw new UsageError('Use kubernetes capacity <workload.yaml> --nodes-file <nodes.json> --pods-file <pods.json>.');
            const parsed = args(rest.slice(1), 1, ['nodes-file', 'pods-file']);
            const { inspectKubernetesCapacity } = await import("./deployment/capacity.js");
            let report;
            try {
                const paths = [parsed.positionals[0], parsed.values['nodes-file'], parsed.values['pods-file']];
                const bytes = await Promise.all(paths.map(path => readBoundedRegularBytes(path, 8_000_000)));
                const text = bytes.map(value => new TextDecoder('utf-8', { fatal: true }).decode(value));
                report = { ...inspectKubernetesCapacity({ workloadYaml: text[0], nodes: JSON.parse(text[1]), pods: JSON.parse(text[2]) }),
                    inputs: bytes.map((value, index) => ({ kind: ['workload', 'nodes', 'pods'][index], bytes: value.length,
                        sha256: createHash('sha256').update(value).digest('hex') })) };
            }
            catch {
                throw new UsageError('Capacity diagnosis requires complete bounded regular node/pod JSON files and supported workload YAML. Input details are withheld.');
            }
            emit(report);
            return report.status === 'insufficient-capacity' ? 1 : 0;
        }
        if (command === 'account') {
            const action = rest[0];
            if (!ACCOUNT_ACTIONS.includes(action))
                throw new UsageError('Use account prepare|inspect|link|exchange|status|revoke.');
            const parsed = args(rest.slice(1), 0, accountStrings(action), accountBooleans(action));
            accountSelection(action, parsed.values);
            emit(await accountFromCli(action, parsed.values, async (work) => {
                const release = lifetime.hold();
                try {
                    lifetime.assertAdmission();
                    return await work();
                }
                finally {
                    release();
                }
            }));
            return 0;
        }
        if (command === 'schemas') {
            const [action, ...tail] = rest;
            if (action !== 'list' && action !== 'show')
                throw new UsageError('Use schemas list or schemas show <schema-id>.');
            const parsed = args(tail, action === 'list' ? 0 : 1, []);
            try {
                emit(action === 'list' ? listSchemas() : showSchema(parsed.positionals[0]));
                return 0;
            }
            catch (error) {
                if (error instanceof SchemaDiscoveryError)
                    throw new UsageError(error.message);
                throw error;
            }
        }
        if (command === 'runs' && rest[0] === 'watch') {
            const parsed = args(rest.slice(1), 1, ['endpoint', 'token-file', 'ca-file', 'release-sha256', 'interval-ms', 'duration-ms'], ['follow']);
            return await watchFromCli(parsed.positionals[0], parsed.values, io.out);
        }
        if (command === 'skill') {
            if (rest[0] === 'inspect') {
                const parsed = args(rest.slice(1), 1, ['sha256'], ['json']);
                const { inspectAgentSkillZip, AGENT_SKILL_INSPECTION_LIMITS } = await import("./management/skill-inspection.js");
                emit(await inspectAgentSkillZip(await readBoundedRegularBytes(parsed.positionals[0], AGENT_SKILL_INSPECTION_LIMITS.archiveBytes), parsed.values.sha256));
                return 0;
            }
            if (rest[0] !== 'export')
                throw new UsageError('Use skill export --output <jevable-skill.zip>.');
            const parsed = args(rest.slice(1), 0, ['output', 'runtime-rate-coordinator'], ['overwrite']);
            if (typeof parsed.values.output !== 'string' || !parsed.values.output)
                throw new UsageError('Provide --output <jevable-skill.zip>.');
            const { createAgentSkillZip } = await import("./management/skill-package.js");
            const rateCoordinator = parsed.values['runtime-rate-coordinator'];
            if (rateCoordinator !== undefined && rateCoordinator !== 'postgres')
                throw new UsageError('Use --runtime-rate-coordinator postgres.');
            const archive = await createAgentSkillZip(undefined, rateCoordinator ? { rateCoordinator } : {});
            const artifact = await writeArtifact(parsed.values.output, archive.bytes, parsed.values.overwrite === true);
            emit({ schemaVersion: archive.manifest.schemaVersion, ...('rateCoordinator' in archive.manifest ? { rateCoordinator: archive.manifest.rateCoordinator } : {}), status: 'written', format: archive.manifest.format, version: CORE_VERSION, artifact,
                root: archive.manifest.root, files: archive.manifest.files.length, runtimes: archive.manifest.runtimes,
                state: 'excluded', credentials: 'excluded', installation: 'not-performed', execution: 'not-started-by-export' });
            return 0;
        }
        if (command === 'runtime') {
            const [action, ...tail] = rest;
            if (action === 'lock') {
                const [operation, ...flags] = tail;
                if (!['inspect', 'recover', 'inspect-recovery', 'complete-recovery'].includes(operation ?? ''))
                    throw new UsageError('Choose runtime lock inspect, recover, inspect-recovery or complete-recovery.');
                const inspecting = operation === 'inspect' || operation === 'inspect-recovery';
                const parsed = args(flags, 0, inspecting ? ['state-dir'] : ['state-dir', 'request-id', 'owner', 'lock-sha256'], inspecting ? [] : ['confirm-recover']);
                const { inspectRuntimeLock, recoverRuntimeLock, inspectRuntimeLockRecovery, completeRuntimeLockRecovery } = await import("./runtime/owner-lock.js");
                const path = parsed.values['state-dir'];
                const request = { requestId: parsed.values['request-id'], owner: parsed.values.owner,
                    lockSha256: parsed.values['lock-sha256'], confirm: parsed.values['confirm-recover'] };
                emit(operation === 'inspect' ? await inspectRuntimeLock(path) : operation === 'inspect-recovery' ? await inspectRuntimeLockRecovery(path)
                    : operation === 'complete-recovery' ? await completeRuntimeLockRecovery(path, request) : await recoverRuntimeLock(path, request));
                return 0;
            }
            if (action === 'submit' || action === 'observe') {
                const parsed = args(tail, 1, ['endpoint', 'token-file', 'instance-id', 'ca-file', 'timeout-ms', 'release-pin-file',
                    ...(action === 'submit' ? ['trace-context-file'] : [])]);
                const { asyncRunFromCli } = await import("./cli/async.js");
                emit(await asyncRunFromCli(action, parsed.positionals[0], parsed.values));
                return 0;
            }
            if (action === 'start' || action === 'inspect' || action === 'stop' || action === 'restart') {
                if (action === 'start' && help) {
                    if (tail.length)
                        throw new CliHelpInputError('Help accepts only the complete command path.');
                    throw new CliCommandHelp([
                        { profile: 'local (default)', grammar: { positionals: 0, strings: ['runtime', ...serveFlags], booleans: ['reviewer-decisions', 'caller-operations'] } },
                        { profile: 'docker (explicit --runtime docker)', grammar: { positionals: 0, strings: dockerFlags.start, booleans: [] } },
                    ]);
                }
                // Select the grammar before any I/O. Local start is the existing foreground service, not an implicit daemon.
                const selection = args(tail, 0, [...new Set([...dockerFlags[action], ...(action === 'start' ? ['data-dir', 'storage', 'database-file', 'drain-wait-ms',
                            'release-file', 'release-sha256', 'public-origin', 'bind-address', 'notifications-file', 'async-concurrency', 'rate-limits-file', 'rate-coordinator-file', 'webhooks-file'] : [])])], action === 'start' ? ['reviewer-decisions', 'caller-operations'] : []);
                if (action === 'start' && (selection.values.runtime === undefined || selection.values.runtime === 'local')) {
                    const parsed = args(tail, 0, ['runtime', ...serveFlags], ['reviewer-decisions', 'caller-operations']);
                    if (typeof parsed.values['token-file'] !== 'string')
                        throw new UsageError('Provide --token-file.');
                    return await serveFromCli(parsed.values, await readSecretFile(parsed.values['token-file']), emit);
                }
                const parsed = args(tail, 0, dockerFlags[action]);
                const result = await dockerFromCli(action, parsed.values);
                emit(result);
                return action === 'inspect' || result.status === 'ready' || result.status === 'stopped' ? 0 : 8;
            }
            if (action === 'build-image' || action === 'save-image' || action === 'export-kubernetes') {
                const parsed = args(tail, action === 'save-image' ? 1 : 0, action === 'build-image'
                    ? ['runtime-sha256', 'base-image', 'platform', 'tag', 'docker-context', 'output'] : action === 'export-kubernetes'
                    ? ['image-receipt', 'receipt-sha256', 'options-file', 'options-sha256', 'output'] : ['receipt-sha256', 'output'], action === 'save-image' || action === 'export-kubernetes' ? ['overwrite'] : []);
                const { managementImageFromCli } = await import("./cli/management-images.js");
                emit(await managementImageFromCli(action, parsed.values, parsed.positionals[0]));
                return 0;
            }
            if (action === 'export') {
                const parsed = args(tail, 0, ['output', 'runtime-rate-coordinator'], ['overwrite']);
                if (typeof parsed.values.output !== 'string' || !parsed.values.output)
                    throw new UsageError('Provide --output <management.zip>.');
                const { createManagementZip } = await import("./management/package.js");
                const rateCoordinator = parsed.values['runtime-rate-coordinator'];
                if (rateCoordinator !== undefined && rateCoordinator !== 'postgres')
                    throw new UsageError('Use --runtime-rate-coordinator postgres.');
                const archive = await createManagementZip(undefined, rateCoordinator ? { rateCoordinator } : {});
                const artifact = await writeArtifact(parsed.values.output, archive.bytes, parsed.values.overwrite === true);
                emit({ schemaVersion: archive.manifest.schemaVersion, ...('rateCoordinator' in archive.manifest ? { rateCoordinator: archive.manifest.rateCoordinator } : {}), status: 'written', format: archive.manifest.format, version: CORE_VERSION, artifact,
                    runtimes: archive.manifest.runtimes, state: 'excluded', credentials: 'excluded', execution: 'not-started-by-export' });
                return 0;
            }
            if (!action || !['token', 'serve', 'status', 'request'].includes(action))
                throw new UsageError('Unknown runtime operation. Run jevable --help.');
            const parsed = args(tail, action === 'request' ? 1 : 0, action === 'token' ? ['output'] : action === 'serve'
                ? serveFlags
                : ['token-file', 'endpoint', 'ca-file', ...(action === 'request' ? ['timeout-ms', 'trace-context-file'] : [])], action === 'serve' ? ['reviewer-decisions', 'caller-operations'] : []);
            const required = (name) => {
                const value = parsed.values[name];
                if (typeof value !== 'string' || !value)
                    throw new UsageError(`Provide --${name}.`);
                return value;
            };
            if (action === 'token') {
                const artifact = await writeArtifact(required('output'), randomBytes(32).toString('hex') + '\n');
                emit({ schemaVersion: 1, status: 'created', path: artifact.path, secret: 'not-displayed', permissions: 'owner-only; never share or place in workflow source' });
                return 0;
            }
            const traceContext = action === 'request' ? await readCliTraceContext(parsed.values['trace-context-file']) : undefined;
            const token = await readSecretFile(required('token-file'));
            if (action === 'serve') {
                return await serveFromCli(parsed.values, token, emit);
            }
            const timeout = parsed.values['timeout-ms'] === undefined ? 30_000 : generation(parsed.values['timeout-ms']);
            const ca = parsed.values['ca-file'] === undefined ? undefined : await readTlsPemFile(required('ca-file'));
            const client = new RuntimeClient(required('endpoint'), token, timeout, 20_000_000, ca === undefined ? {} : { ca });
            if (action === 'status') {
                emit(await client.health());
                return 0;
            }
            let operation;
            try {
                operation = JSON.parse(await readBoundedFile(parsed.positionals[0], 4_000_000));
            }
            catch {
                throw new UsageError('Operation file must contain bounded JSON.');
            }
            emit(await client.operation(operation, traceContext));
            return 0;
        }
        if (command === 'doctor') {
            const parsed = args(rest, 0, ['storage', 'data-dir', 'database-file', 'endpoint', 'token-file', 'ca-file', 'timeout-ms']);
            const report = await doctor(parsed.values);
            emit(report);
            return report.status === 'failed' ? 1 : 0;
        }
        if (command === 'capabilities') {
            args(rest, 0);
            emit(capabilities());
            return 0;
        }
        if (command === 'validate') {
            const parsed = args(rest, 1);
            const result = validateSource(await readBoundedFile(parsed.positionals[0], DEFAULT_COMPILER_LIMITS.source.maxSourceBytes));
            emit(result);
            return result.status === 'valid' ? 0 : 2;
        }
        if (command === 'preview') {
            const parsed = args(rest, 1, ['output', 'port', 'data-dir', 'storage', 'database-file', 'preview-token-file', 'project-id', 'project-pin-file', 'project-pin-sha256', 'trace-viewer-file', 'token-env', ...operationFlags.filter(flag => flag !== 'trace-context-file')], ['overwrite', 'serve', 'auto-connect']);
            const source = await readBoundedFile(parsed.positionals[0], DEFAULT_COMPILER_LIMITS.source.maxSourceBytes);
            if (parsed.values.serve) {
                if (parsed.values.output || parsed.values.overwrite)
                    throw new UsageError('Choose --serve or portable --output, not both.');
                const selectedOwner = parsed.values.runtime === 'docker' || parsed.values.endpoint !== undefined;
                const storage = selectedOwner ? 'selected-owner' : storageSelection(parsed.values);
                return await runServiceProcess(() => startPreviewFromCli(source, parsed.values), storage, emit, 5000, process, service => ({ schemaVersion: 1, status: 'ready', url: service.url, instanceId: service.instanceId, protocol: service.protocol,
                    servesHtml: true, preview: service.preview, execution: 'not-run',
                    runtime: parsed.values.endpoint !== undefined ? 'remote' : parsed.values.runtime ?? 'local',
                    storage,
                    auth: parsed.values['auto-connect'] === true
                        ? 'automatic project-scoped login; trusts local processes; management API still requires its token'
                        : selectedOwner
                            ? 'paste only the distinct preview token into the local page; never the management token'
                            : 'choose or paste the designated owner token into the local page; never a URL parameter', visualReview: 'not-performed' }));
            }
            if (typeof parsed.values.output !== 'string')
                throw new UsageError('Provide --output <workflow.html> or --serve with --token-file.');
            const { data, html } = renderPreview(source);
            const artifact = await writeArtifact(parsed.values.output, html, parsed.values.overwrite === true);
            emit({ schemaVersion: 1, status: 'written', artifact, format: data.format, revision: data.revision,
                sourceSha256: data.sourceSha256, validation: data.validation, execution: data.execution, runtimeReadiness: data.runtimeReadiness,
                privacy: data.privacy, visualReview: 'not-performed' });
            return data.validation.status === 'valid' ? 0 : 2;
        }
        if (command === 'tests') {
            if (rest[0] === 'suite') {
                const [_, action, ...tail] = rest;
                if (action !== 'create' && action !== 'inspect' && action !== 'run' && action !== 'result' && action !== 'coverage')
                    throw new UsageError('Unknown test suite operation.');
                const parsed = args(tail, 1, action === 'create' ? ['output'] : action === 'inspect' ? []
                    : ['data-dir', 'storage', 'database-file', 'endpoint', ...operationFlags, ...(action === 'coverage' ? ['file'] : suiteTelemetryFlags), ...(action === 'run' ? ['suite-sha256'] : [])], action === 'create' ? ['overwrite'] : []);
                return await suiteFromCli(action, parsed.positionals[0], parsed.values, emit);
            }
            const [action, ...tail] = rest;
            const fields = { list: [], show: ['generation'], history: [], create: ['id'],
                'erasure-review': [], erase: ['confirm-delete'], erasure: [],
                generate: ['id', 'expected-generation', 'revision', 'limit', 'trigger-mode'], generations: [], generation: [],
                edit: ['file', 'expected-generation'], accept: ['expected-generation', 'sha256'],
                archive: ['expected-generation', 'sha256'], unarchive: ['expected-generation', 'sha256'],
                run: ['expected-generation', 'sha256', 'id'], result: [] };
            if (!action || !Object.hasOwn(fields, action))
                throw new UsageError('Unknown test operation.');
            const parsed = jobArgs(tail, ['list', 'generations'].includes(action) ? 0 : 1, ['data-dir', ...operationFlags, ...fields[action]], action === 'result' ? ['inspect'] : [], ['list', 'generations'].includes(action) ? 'record' : undefined);
            const required = (name) => { const value = parsed.values[name]; if (typeof value !== 'string' || !value)
                throw new UsageError(`Provide --${name}.`); return value; };
            // Validate the bounded retained request and explicit exact-case confirmation before owner/credential I/O.
            const erasure = action === 'erase'
                ? parseTest(testErasureCommandSchema, JSON.parse(await readBoundedFile(parsed.positionals[0], 4096)), 4096) : undefined;
            if (erasure && required('confirm-delete') !== erasure.test.id)
                throw new WorkflowRuntimeError('invalid-command');
            const host = await openCliOperations(parsed.values);
            try {
                const id = parsed.positionals[0];
                if (action === 'list')
                    emit(await host.call({ operation: 'tests.list', ...(parsed.page ? { page: parsed.page } : {}) }));
                else if (action === 'generations')
                    emit(await host.call({ operation: 'tests.generations', ...(parsed.page ? { page: parsed.page } : {}) }));
                else if (action === 'generation')
                    emit(await host.call({ operation: 'tests.generation', id }));
                else if (action === 'generate')
                    emit(await host.call({ operation: 'tests.generate', id: required('id'),
                        project: { id, generation: generation(required('expected-generation')), revision: required('revision') },
                        ...triggerMetadata({ triggerMode: cliTriggerMode(parsed.values['trigger-mode']) }),
                        ...(parsed.values.limit === undefined ? {} : { limit: generation(required('limit')) }) }));
                else if (action === 'show')
                    emit(await host.call({ operation: 'tests.show', id, ...(parsed.values.generation === undefined ? {} : { generation: generation(required('generation')) }) }));
                else if (action === 'history')
                    emit(await host.call({ operation: 'tests.history', id }));
                else if (action === 'erasure-review') {
                    const result = await host.call({ operation: 'tests.erasure-review', id });
                    if (operationResult(testErasurePreparationSchema, result).test.id !== id)
                        throw new RuntimeHttpError('invalid-response');
                    emit(result);
                }
                else if (action === 'erase') {
                    const result = await host.call({ operation: 'tests.erase', request: { ...erasure, confirmId: required('confirm-delete') } });
                    const receipt = operationResult(testErasureReceiptSchema, result);
                    if (receipt.requestId !== erasure.requestId || !isDeepStrictEqual(receipt.test, erasure.test)
                        || receipt.historySha256 !== erasure.reviewedHistorySha256)
                        throw new RuntimeHttpError('invalid-response');
                    emit(result);
                }
                else if (action === 'erasure') {
                    const result = await host.call({ operation: 'tests.erasure', requestId: id });
                    if (operationResult(testErasureReceiptSchema, result).requestId !== id.toLowerCase())
                        throw new RuntimeHttpError('invalid-response');
                    emit(result);
                }
                else if (action === 'result')
                    emit(await host.call({ operation: 'tests.result', runId: id, inspect: parsed.values.inspect === true }));
                else if (action === 'run') {
                    const result = await host.call({ operation: 'tests.run', test: { id, generation: generation(required('expected-generation')), sha256: required('sha256') }, runId: required('id') });
                    const status = operationResult(testResultSchema, result);
                    if (status.run.id !== parsed.values.id)
                        throw new RuntimeHttpError('invalid-response');
                    emit(result);
                    return status.assessment === 'uncertain' ? 5 : !status.terminal ? 3 : status.assessment === 'passed' ? 0 : 6;
                }
                else if (action === 'archive' || action === 'unarchive')
                    emit(await host.call({ operation: 'tests.command', command: { operation: 'archive', id,
                            expectedGeneration: generation(required('expected-generation')), reviewedSha256: required('sha256'), archived: action === 'archive' } }));
                else if (action === 'accept')
                    emit(await host.call({ operation: 'tests.command', command: { operation: 'accept', id,
                            expectedGeneration: generation(required('expected-generation')), reviewedSha256: required('sha256') } }));
                else {
                    const definition = parseTest(testDefinitionSchema, JSON.parse(await readBoundedFile(action === 'create' ? id : required('file'), 250000)));
                    emit(await host.call({ operation: 'tests.command', command: action === 'create' ? { operation: 'create', definition,
                            ...(typeof parsed.values.id === 'string' ? { id: parsed.values.id } : {}) }
                            : { operation: 'edit', id, definition, expectedGeneration: generation(required('expected-generation')) } }));
                }
                return 0;
            }
            finally {
                await host.close();
            }
        }
        if (command === 'releases') {
            const [action, ...tail] = rest;
            if (action === 'message-id') {
                const parsed = args(tail, 1, [], []);
                let value;
                try {
                    const bytes = await readBoundedRegularBytes(parsed.positionals[0], 4096);
                    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
                }
                catch {
                    throw new UsageError('Provide a bounded regular UTF-8 release-message identity JSON file.');
                }
                const runId = releaseMessageRunId(value);
                emit({ schemaVersion: 1, format: 'jevable.ai/release-message-id', runId, execution: 'not-run', authentication: 'not-verified' });
                return 0;
            }
            if (action === 'save-image') {
                const parsed = args(tail, 1, ['receipt-sha256', 'output'], ['overwrite']);
                if (typeof parsed.values['receipt-sha256'] !== 'string' || typeof parsed.values.output !== 'string')
                    throw new UsageError('Provide --receipt-sha256 and --output.');
                const bytes = await readBoundedBytes(parsed.positionals[0], 64000);
                if (createHash('sha256').update(bytes).digest('hex') !== parsed.values['receipt-sha256'])
                    throw new WorkflowRuntimeError('conflict');
                const { inspectImageReceipt, saveReleaseImage } = await import("./images/index.js");
                const image = inspectImageReceipt(JSON.parse(bytes.toString('utf8')));
                emit(await saveReleaseImage(image, parsed.values.output, parsed.values.overwrite === true));
                return 0;
            }
            if (!action || !['list', 'show', 'create', 'export', 'build-image', 'export-kubernetes'].includes(action))
                throw new UsageError('Unknown release operation.');
            const parsed = jobArgs(tail, action === 'list' ? 0 : 1, ['data-dir', ...operationFlags, ...(action === 'create' ? ['revision', 'expected-generation', 'version', 'id', 'runtime-storage', 'runtime-rate-coordinator', 'notes-file']
                    : action === 'export' ? ['release-sha256', 'format', 'output', 'evidence-file', 'evidence-sha256'] : action === 'build-image'
                        ? ['release-sha256', 'base-image', 'platform', 'tag', 'docker-context', 'output'] : action === 'export-kubernetes'
                        ? ['release-sha256', 'image-receipt', 'receipt-sha256', 'options-file', 'options-sha256', 'output'] : [])], action === 'export' ? ['overwrite', 'include-private-evidence'] : action === 'export-kubernetes' ? ['overwrite'] : [], action === 'list' ? 'record' : undefined);
            const required = (name) => { const value = parsed.values[name]; if (typeof value !== 'string' || !value)
                throw new UsageError(`Provide --${name}.`); return value; };
            const runtimeStorage = parsed.values['runtime-storage'] ?? parsed.values.storage;
            if (runtimeStorage !== undefined && runtimeStorage !== 'sqlite' && runtimeStorage !== 'postgres')
                throw new UsageError('Use --runtime-storage sqlite|postgres.');
            const runtimeRateCoordinator = parsed.values['runtime-rate-coordinator'];
            if (runtimeRateCoordinator !== undefined && (runtimeRateCoordinator !== 'postgres' || parsed.values['runtime-storage'] !== 'sqlite'))
                throw new UsageError('Optional shared quotas require --runtime-storage sqlite --runtime-rate-coordinator postgres.');
            if (action === 'create' && operationSelection(parsed.values) !== 'local' && typeof parsed.values.id !== 'string')
                throw new UsageError('Selected-owner release creation requires a retained --id UUID; inspect that ID after a lost response.');
            let notes;
            if (action === 'create' && parsed.values['notes-file'] !== undefined) {
                // Refuse invalid text before owner/database/service I/O; never echo its content.
                try {
                    notes = releaseNotesSchema.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
                        .decode(await readBoundedBytes(required('notes-file'), RELEASE_NOTES_MAX_BYTES)));
                }
                catch {
                    throw new UsageError('Release notes require nonblank UTF-8 text of at most 16384 bytes, without control characters except tab, CR and LF.');
                }
            }
            let evidenceInput;
            if (action === 'export') {
                required('release-sha256');
                required('output');
                if (required('format') !== 'zip')
                    throw new UsageError('Use --format zip, or releases build-image/save-image for container images.');
                if (['evidence-file', 'evidence-sha256', 'include-private-evidence'].some(key => parsed.values[key] !== undefined)) {
                    const file = required('evidence-file'), sha256 = required('evidence-sha256');
                    if (!/^[a-f0-9]{64}$/u.test(sha256))
                        throw new UsageError('Provide the reviewed evidence archive SHA-256.');
                    const bytes = await readBoundedBytes(file, EVIDENCE_ATTACHMENT_LIMIT);
                    if (createHash('sha256').update(bytes).digest('hex') !== sha256)
                        throw new WorkflowRuntimeError('conflict');
                    evidenceInput = { bytes, sha256, includePrivate: parsed.values['include-private-evidence'] === true };
                }
            }
            if (action === 'build-image')
                for (const flag of ['release-sha256', 'base-image', 'platform', 'tag', 'docker-context', 'output'])
                    required(flag);
            let deploymentInput;
            if (action === 'export-kubernetes') {
                for (const flag of ['release-sha256', 'image-receipt', 'receipt-sha256', 'options-file', 'options-sha256', 'output'])
                    required(flag);
                const receipt = await readBoundedBytes(required('image-receipt'), 64000), options = await readBoundedBytes(required('options-file'), 64000);
                if (createHash('sha256').update(receipt).digest('hex') !== required('receipt-sha256')
                    || createHash('sha256').update(options).digest('hex') !== required('options-sha256'))
                    throw new WorkflowRuntimeError('conflict');
                const { kubernetesOptionsSchema } = await import("./deployment/index.js");
                const { inspectImageReceipt } = await import("./images/index.js");
                deploymentInput = { receipt: inspectImageReceipt(JSON.parse(receipt.toString('utf8'))), options: kubernetesOptionsSchema.parse(JSON.parse(options.toString('utf8'))) };
            }
            const host = await openCliOperations(parsed.values);
            try {
                if (action === 'list') {
                    emit(await host.call({ operation: 'releases.list', ...(parsed.page ? { page: parsed.page } : {}) }));
                    return 0;
                }
                const id = parsed.positionals[0];
                if (action === 'show') {
                    emit(operationRelease(await host.call({ operation: 'releases.show', id }), id));
                    return 0;
                }
                const { loadReleaseRuntime, loadReleaseRuntimeProfile, loadReleaseRuntimeForIdentity, createReleaseZip, createReleaseZipWithEvidence } = await import("./packages/release-zip.js");
                if (action === 'create') {
                    const selectedStorage = runtimeStorage ?? host.storage;
                    const artifact = runtimeRateCoordinator ? await loadReleaseRuntimeProfile({ storage: 'sqlite', rateCoordinator: runtimeRateCoordinator })
                        : await loadReleaseRuntime(selectedStorage);
                    const releaseId = typeof parsed.values.id === 'string' ? parsed.values.id : randomUUID();
                    const release = operationRelease(await host.call({ operation: 'releases.create', projectId: id, revision: required('revision'), expectedGeneration: generation(required('expected-generation')),
                        version: required('version'), id: releaseId, runtime: artifact.identity, runtimeStorage: selectedStorage,
                        ...(runtimeRateCoordinator ? { runtimeRateCoordinator } : {}),
                        ...(notes === undefined ? {} : { notes }) }), releaseId);
                    if (release.snapshot.project.id !== id || release.snapshot.project.generation !== generation(required('expected-generation')) || release.snapshot.workflow.revision !== required('revision')
                        || release.snapshot.version !== required('version') || release.snapshot.runtime.sha256 !== artifact.identity.sha256
                        || release.snapshot.notes !== notes)
                        throw new RuntimeHttpError('invalid-response');
                    emit(release);
                    return 0;
                }
                const release = operationRelease(await host.call({ operation: 'releases.show', id }), id);
                if (required('release-sha256') !== release.sha256)
                    throw new WorkflowRuntimeError('conflict');
                const artifact = await loadReleaseRuntimeForIdentity(release.snapshot.runtime);
                if (action === 'export-kubernetes') {
                    const { createKubernetesBundle } = await import("./deployment/index.js");
                    const bundle = createKubernetesBundle(release, artifact, deploymentInput.receipt, deploymentInput.options);
                    const output = await writeArtifact(required('output'), bundle.bytes, parsed.values.overwrite === true);
                    emit({ status: 'written', ...bundle.manifest, artifact: output });
                    return 0;
                }
                if (action === 'build-image') {
                    const output = resolve(required('output')), { lstat, stat, access, constants } = await import('node:fs/promises');
                    try {
                        await lstat(output);
                        throw new ImageError('image-conflict');
                    }
                    catch (error) {
                        if (error.code !== 'ENOENT')
                            throw error;
                    }
                    if (!(await stat(dirname(output))).isDirectory())
                        throw new ImageError('invalid-image-options');
                    await access(dirname(output), constants.W_OK);
                    const { buildReleaseImage } = await import("./images/index.js");
                    const image = await buildReleaseImage(release, artifact, { context: required('docker-context'), platform: required('platform'),
                        baseImage: required('base-image'), tag: required('tag') });
                    let receipt;
                    try {
                        receipt = await writeArtifact(output, JSON.stringify(image, null, 2) + '\n');
                    }
                    catch {
                        throw new ImageError('image-receipt-write-failed');
                    }
                    emit({ status: 'built', image, receipt });
                    return 0;
                }
                const attached = evidenceInput ? await createReleaseZipWithEvidence(release, artifact, evidenceInput) : undefined;
                const output = await writeArtifact(required('output'), attached?.bytes ?? createReleaseZip(release, artifact), parsed.values.overwrite === true);
                emit({ status: 'written', format: 'jevable.ai/release-zip', releaseId: id, releaseSha256: release.sha256,
                    project: release.snapshot.project, revision: release.snapshot.workflow.revision, version: release.snapshot.version,
                    runtime: release.snapshot.runtime, artifact: output, execution: 'not-run', containerQualification: 'not-performed',
                    ...(attached ? { evidence: { ...attached.evidence, importStatus: 'not-restored',
                            containerBuild: 'included-if-built-from-this-zip', privacyAttestation: 'not-performed' } } : {}) });
                return 0;
            }
            finally {
                await host.close();
            }
        }
        if (command === 'projects') {
            const [action, ...tail] = rest;
            const choices = { list: [], show: [], deletions: [], create: ['title', 'id'],
                propose: ['file', 'proposal-id', 'expected-generation'],
                accept: ['proposal-id', 'revision', 'expected-generation', 'ack-approvals'],
                reject: ['proposal-id', 'revision', 'expected-generation'], diff: ['from', 'to'],
                rename: ['title', 'expected-generation'], archive: ['expected-generation'], unarchive: ['expected-generation'],
                duplicate: ['revision', 'title', 'expected-generation', 'new-id'], delete: ['expected-generation', 'confirm-delete'],
                export: ['revision', 'expected-generation', 'output', 'format', 'evidence-file', 'evidence-sha256'],
                restore: ['revision', 'expected-generation', 'ack-approvals'], run: ['revision', 'expected-generation', 'input', 'id', 'trigger-mode'] };
            if (!action || !Object.hasOwn(choices, action))
                throw new UsageError('Unknown projects operation. Run jevable --help.');
            const parsed = jobArgs(tail, ['list', 'deletions'].includes(action) ? 0 : 1, ['data-dir', ...operationFlags, ...choices[action]], action === 'export' ? ['history', 'tests', 'overwrite', 'include-private-evidence'] : action === 'run' ? ['paused'] : [], action === 'deletions' ? 'record' : undefined);
            const triggerMode = cliTriggerMode(parsed.values['trigger-mode']);
            const required = (name) => {
                const value = parsed.values[name];
                if (typeof value !== 'string' || !value)
                    throw new UsageError(`Provide --${name}.`);
                return value;
            };
            const id = parsed.positionals[0];
            const actor = `local:${userInfo().username}`;
            let evidenceInput;
            if (action === 'export' && ['evidence-file', 'evidence-sha256', 'include-private-evidence'].some(key => parsed.values[key] !== undefined)) {
                if (parsed.values.format !== 'zip')
                    throw new UsageError('Evidence attachments require --format zip.');
                const file = required('evidence-file'), sha256 = required('evidence-sha256');
                if (!/^[a-f0-9]{64}$/u.test(sha256))
                    throw new UsageError('Provide the reviewed evidence archive SHA-256.');
                const bytes = await readBoundedBytes(file, EVIDENCE_ATTACHMENT_LIMIT);
                if (createHash('sha256').update(bytes).digest('hex') !== sha256)
                    throw new WorkflowRuntimeError('conflict');
                evidenceInput = { bytes, sha256, includePrivate: parsed.values['include-private-evidence'] === true };
            }
            if (action === 'run' && operationSelection(parsed.values) !== 'local' && typeof parsed.values.id !== 'string')
                throw new UsageError('Selected-owner execution requires a retained --id UUID before submission.');
            const host = await openCliOperations(parsed.values);
            try {
                if (action === 'list') {
                    emit(await host.call({ operation: 'projects.list' }));
                    return 0;
                }
                if (action === 'deletions') {
                    emit(await host.call({ operation: 'projects.deletions', ...(parsed.page ? { page: parsed.page } : {}) }));
                    return 0;
                }
                if (action === 'show') {
                    emit(await host.call({ operation: 'projects.show', id }));
                    return 0;
                }
                if (action === 'diff') {
                    emit({ schemaVersion: 1, ...operationResult(z.record(z.string(), z.unknown()), await host.call({ operation: 'projects.diff', id, from: required('from'), to: required('to') })) });
                    return 0;
                }
                let change;
                if (action === 'create') {
                    change = { operation: 'create', title: required('title'), actor,
                        yaml: await readBoundedFile(id, DEFAULT_COMPILER_LIMITS.source.maxSourceBytes),
                        ...(typeof parsed.values.id === 'string' ? { id: parsed.values.id } : {}) };
                }
                else {
                    const expectedGeneration = generation(parsed.values['expected-generation']);
                    const guard = { id, expectedGeneration, actor };
                    if (action === 'export') {
                        const format = parsed.values.format ?? 'json';
                        if (format !== 'json' && format !== 'zip')
                            throw new UsageError('Project export format must be json or zip; release images use releases build-image/save-image.');
                        const output = required('output');
                        const exported = await host.call({ operation: 'projects.export', id, expectedGeneration, revision: required('revision'), history: parsed.values.history === true, tests: parsed.values.tests === true });
                        const { ProjectLedger } = await import("./projects/ledger.js");
                        const bundle = new ProjectLedger(DEFAULT_COMPILER_LIMITS.source, PROJECT_PACKAGE_LIMITS.entryBytes).inspectImport(JSON.stringify(exported)).bundle;
                        if (bundle.source.id !== id || bundle.source.generation !== expectedGeneration || bundle.accepted.revision !== required('revision'))
                            throw new RuntimeHttpError('invalid-response');
                        const packaged = evidenceInput ? await createProjectZipWithEvidence(bundle, evidenceInput) : undefined;
                        const content = packaged?.bytes ?? (format === 'zip' ? createProjectZip(bundle) : JSON.stringify(bundle));
                        const artifact = await writeArtifact(output, content, parsed.values.overwrite === true);
                        emit({ schemaVersion: 1, status: 'written', format, artifact, projectId: id, generation: expectedGeneration,
                            revision: bundle.accepted.revision, historyIncluded: Boolean(bundle.history), execution: 'not-run',
                            tests: bundle.version === 2 ? { included: bundle.tests.cases.length, excludedOtherRevisions: bundle.tests.excludedOtherRevisions,
                                importStatus: 'draft-review-required' } : { included: false },
                            ...(packaged ? { evidence: { ...packaged.evidence, importStatus: 'not-restored', privatePayloads: 'not-displayed' } } : {}),
                            privacy: packaged ? 'authored source and attached evidence may contain private data; credential stores and sessions excluded; evidence is not restored by import'
                                : 'authored source and explicitly included test inputs/expectations are private; credential stores, run evidence and sessions excluded',
                            runnableRelease: false });
                        return 0;
                    }
                    if (action === 'delete') {
                        if (required('confirm-delete') !== id)
                            throw new UsageError('--confirm-delete must match the exact archived project ID.');
                        emit({ ...operationResult(z.record(z.string(), z.unknown()), await host.call({ operation: 'projects.delete', id, expectedGeneration, confirmId: id })), removed: 'project source, proposals and authoring journal',
                            retained: 'deletion receipt; no runs or credentials removed', recovery: 'restore from a prior backup; no undo command' });
                        return 0;
                    }
                    let approvalChanges = [];
                    if (typeof parsed.values['ack-approvals'] === 'string') {
                        let value;
                        try {
                            value = JSON.parse(parsed.values['ack-approvals']);
                        }
                        catch {
                            throw new UsageError('--ack-approvals must be a JSON array of reviewed gate names.');
                        }
                        if (!Array.isArray(value) || value.some(item => typeof item !== 'string'))
                            throw new UsageError('--ack-approvals must be a JSON array of reviewed gate names.');
                        approvalChanges = value;
                    }
                    if (action === 'run') {
                        let input;
                        const raw = await readBoundedFile(required('input'), DEFAULT_COMPILER_LIMITS.binding.data.maxBytes);
                        try {
                            input = JSON.parse(raw);
                        }
                        catch {
                            throw new UsageError('Input file must contain valid JSON.');
                        }
                        const runId = typeof parsed.values.id === 'string' ? parsed.values.id : randomUUID();
                        const run = await host.call({ operation: 'projects.run', id, expectedGeneration, revision: required('revision'), input: input,
                            runId, paused: parsed.values.paused === true, ...triggerMetadata({ triggerMode }) });
                        const status = operationResult(runResultSchema, run);
                        if (status.id !== runId)
                            throw new RuntimeHttpError('invalid-response');
                        emit(run);
                        return resultExit(status);
                    }
                    if (action === 'duplicate')
                        change = { ...guard, operation: 'duplicate', title: required('title'), revision: required('revision'),
                            ...(typeof parsed.values['new-id'] === 'string' ? { newId: parsed.values['new-id'] } : {}) };
                    else if (action === 'propose')
                        change = { ...guard, operation: 'propose',
                            yaml: await readBoundedFile(required('file'), DEFAULT_COMPILER_LIMITS.source.maxSourceBytes),
                            ...(typeof parsed.values['proposal-id'] === 'string' ? { proposalId: parsed.values['proposal-id'] } : {}) };
                    else if (action === 'accept')
                        change = { ...guard, operation: 'accept', proposalId: required('proposal-id'), reviewedRevision: required('revision'), approvalChanges };
                    else if (action === 'reject')
                        change = { ...guard, operation: 'reject', proposalId: required('proposal-id'), reviewedRevision: required('revision') };
                    else if (action === 'restore')
                        change = { ...guard, operation: 'restore', revision: required('revision'), approvalChanges };
                    else if (action === 'rename')
                        change = { ...guard, operation: 'rename', title: required('title') };
                    else
                        change = { ...guard, operation: 'archive', archived: action === 'archive' };
                }
                const { actor: _actor, ...command } = change;
                emit(await host.call({ operation: 'projects.command', command }));
                return 0;
            }
            finally {
                await host.close();
            }
        }
        if (command === 'check' || command === 'providers' || command === 'credentials') {
            const action = command === 'check' ? 'check' : rest[0], tail = command === 'check' ? rest : rest.slice(1);
            if (!action || !(command === 'check' ? ['check'] : command === 'providers' ? ['list', 'set', 'audit', 'discover'] : ['status', 'set', 'clear']).includes(action))
                throw new UsageError('Unknown configuration operation. Run jevable --help.');
            const parsed = jobArgs(tail, ['list', 'audit'].includes(action) ? 0 : 1, ['data-dir', ...operationFlags, ...(['set', 'clear'].includes(action) ? ['expected-generation', ...(command === 'credentials' && action === 'set' ? ['file'] : [])] : action === 'check' ? ['trigger-mode'] : [])], command === 'credentials' && action === 'set' ? ['stdin'] : [], action === 'audit' ? 'audit' : undefined);
            const triggerMode = cliTriggerMode(parsed.values['trigger-mode']);
            const expected = ['set', 'clear'].includes(action) ? generation(parsed.values['expected-generation']) : undefined;
            if (action === 'clear' && (!expected || !reference.safeParse(parsed.positionals[0]).success))
                throw new UsageError('Clearing requires a valid credential reference and positive reviewed generation.');
            if (command === 'providers' && action === 'discover' && !reference.safeParse(parsed.positionals[0]).success)
                throw new UsageError('Provide a valid configured connection ID.');
            let secret;
            if (command === 'credentials' && action === 'set') {
                if (Boolean(parsed.values.file) === Boolean(parsed.values.stdin))
                    throw new UsageError('Choose exactly one of --file <private-file> or --stdin. Secret values are not accepted as arguments.');
                secret = typeof parsed.values.file === 'string' ? await readSecretFile(parsed.values.file) : await readSecretStdin();
            }
            const host = await openCliOperations(parsed.values);
            try {
                if (action === 'list') {
                    emit(await host.call({ operation: 'providers.list' }));
                    return 0;
                }
                if (action === 'audit') {
                    emit(await host.call({ operation: 'providers.audit', ...(parsed.page ? { page: parsed.page } : {}) }));
                    return 0;
                }
                const target = parsed.positionals[0];
                if (command === 'providers' && action === 'discover') {
                    emit(await host.call({ operation: 'providers.discover', id: target }));
                    return 0;
                }
                if (action === 'check') {
                    const result = await host.call({ operation: 'check', yaml: await readBoundedFile(target, DEFAULT_COMPILER_LIMITS.source.maxSourceBytes), ...triggerMetadata({ triggerMode }) });
                    const status = operationResult(z.object({ status: z.string(), runtimeReadiness: z.string() }), result);
                    emit(result);
                    return status.status === 'valid' && status.runtimeReadiness === 'ready' ? 0 : 2;
                }
                if (command === 'credentials') {
                    const result = await host.call(action === 'status' ? { operation: 'credentials.status', ref: target }
                        : action === 'clear' ? { operation: 'credentials.clear', ref: target, expectedGeneration: expected }
                            : { operation: 'credentials.set', ref: target, value: secret, expectedGeneration: expected });
                    emit({ schemaVersion: 1, ...operationResult(z.record(z.string(), z.unknown()), result) });
                }
                else {
                    let config;
                    try {
                        config = JSON.parse(await readBoundedFile(target, 1_000_000));
                    }
                    catch {
                        throw new UsageError('Connection file must be bounded JSON without credential values.');
                    }
                    emit({ schemaVersion: 1, ...operationResult(z.record(z.string(), z.unknown()), await host.call({ operation: 'providers.set', connection: config, expectedGeneration: expected })) });
                }
                return 0;
            }
            finally {
                await host.close();
            }
        }
        if (command === 'templates') {
            const [action, ...tail] = rest;
            if (action === 'list' || action === 'show') {
                const parsed = args(tail, action === 'list' ? 0 : 1, ['language']);
                const templates = listTemplates(language(parsed.values.language));
                if (action === 'list')
                    emit({ schemaVersion: 1, templates });
                else {
                    const template = templates.find(entry => entry.id === parsed.positionals[0]);
                    if (!template)
                        throw new UsageError('Unknown template. Use templates list.');
                    emit({ schemaVersion: 1, template });
                }
                return 0;
            }
            if (action === 'render') {
                const parsed = args(tail, 1, ['output', 'language', 'name', 'provider', 'model'], ['overwrite']);
                const { output, provider, model, name } = parsed.values;
                if (typeof output !== 'string')
                    throw new UsageError('Provide --output for the generated workflow.');
                if (Boolean(provider) !== Boolean(model))
                    throw new UsageError('Provide --provider and --model together.');
                let document;
                try {
                    document = renderTemplate(parsed.positionals[0], { language: language(parsed.values.language),
                        ...(typeof name === 'string' ? { name } : {}),
                        ...(typeof provider === 'string' && typeof model === 'string' ? { model: { provider, model } } : {}),
                    });
                }
                catch (error) {
                    throw new UsageError(error.message);
                }
                const compiled = compileWorkflow(document, DEFAULT_COMPILER_LIMITS);
                const artifact = await writeArtifact(output, compiled.source.yaml, parsed.values.overwrite === true);
                emit({ schemaVersion: 1, status: 'written', revision: compiled.source.revision, artifact,
                    runtimeReadiness: 'not-checked', execution: 'not-run' });
                return 0;
            }
            throw new UsageError('Unknown templates action. Run jevable --help.');
        }
        if (command === 'import' && rest[0] === 'preview') {
            const parsed = args(rest.slice(1), 1, ['output', 'output-format'], ['overwrite']);
            if (parsed.values.overwrite && !parsed.values.output)
                throw new UsageError('--overwrite requires --output.');
            const format = parsed.values['output-format'] ?? 'yaml';
            const source = await readBoundedFile(parsed.positionals[0], DEFAULT_COMPILER_LIMITS.source.maxSourceBytes);
            const review = format === 'html' ? renderVendorImportPreview(source) : undefined;
            const imported = review?.conversion ?? previewVendorImport(source, DEFAULT_COMPILER_LIMITS.source);
            const validation = review?.data.validation ?? validateSource(imported.yaml);
            const artifact = typeof parsed.values.output === 'string'
                ? await writeArtifact(parsed.values.output, review?.html ?? imported.yaml, parsed.values.overwrite === true) : undefined;
            emit({ schemaVersion: 1, status: 'review-required', format: imported.format, version: imported.version,
                sourceSha256: imported.sourceSha256, conversionSha256: imported.conversionSha256, conversionRevision: imported.conversionRevision,
                converter: imported.converter, mappings: imported.mappings, validation, ...(artifact ? { artifact } : {}),
                ...(parsed.values['output-format'] !== undefined ? { outputFormat: format } : {}), execution: 'not-run' });
            return 0;
        }
        if (command === 'import' && rest[0] === 'vendor') {
            const parsed = jobArgs(rest.slice(1), 1, ['data-dir', ...operationFlags, 'file', 'title', 'id',
                'reviewed-source-sha256', 'reviewed-conversion-sha256', 'reviewed-revision']);
            // Validate target and retained identities before reading the upload, draft or credentials.
            operationSelection(parsed.values);
            const input = vendorImportCommandSchema.omit({ actor: true }).parse({ id: parsed.values.id, title: parsed.values.title,
                source: await readBoundedFile(parsed.positionals[0], DEFAULT_COMPILER_LIMITS.source.maxSourceBytes),
                yaml: await readBoundedFile(parsed.values.file, DEFAULT_COMPILER_LIMITS.source.maxSourceBytes),
                reviewedSourceSha256: parsed.values['reviewed-source-sha256'], reviewedConversionSha256: parsed.values['reviewed-conversion-sha256'],
                reviewedRevision: parsed.values['reviewed-revision'] });
            const host = await openCliOperations(parsed.values);
            try {
                const project = operationResult(z.object({ id: z.literal(input.id), generation: z.literal(1), acceptedRevision: z.literal(input.reviewedRevision) }), await host.call({ operation: 'projects.import.vendor', command: input }));
                emit({ schemaVersion: 1, status: 'imported', id: project.id, generation: project.generation, revision: project.acceptedRevision,
                    sourceSha256: input.reviewedSourceSha256, conversionSha256: input.reviewedConversionSha256,
                    privateOrigin: 'retained; explicit import show --inspect only', transfer: 'origin-excluded-from-project-bundles', execution: 'not-run' });
                return 0;
            }
            finally {
                await host.close();
            }
        }
        if (command === 'import' && rest[0] === 'show') {
            const parsed = jobArgs(rest.slice(1), 1, ['data-dir', ...operationFlags], ['inspect']);
            const host = await openCliOperations(parsed.values);
            try {
                const result = operationResult(vendorImportViewSchema.nullable(), await host.call({ operation: 'projects.import.vendor.show', id: parsed.positionals[0], inspect: parsed.values.inspect === true }));
                // The API projection is explicit; no source read or workflow execution is used to populate this view.
                if (result !== null)
                    operationResult(z.object({ projectId: z.literal(parsed.positionals[0].toLowerCase()),
                        privatePayloads: z.literal(parsed.values.inspect === true ? 'included' : 'excluded'), execution: z.literal('not-run') }), result);
                emit(result);
                return 0;
            }
            finally {
                await host.close();
            }
        }
        if (command === 'import' && rest[0] === 'export-origin') {
            const parsed = jobArgs(rest.slice(1), 1, ['data-dir', ...operationFlags, 'output', 'reviewed-origin-sha256'], ['include-private', 'overwrite']);
            const id = parsed.positionals[0].toLowerCase(), reviewed = parsed.values['reviewed-origin-sha256'];
            const host = await openCliOperations(parsed.values);
            try {
                const meta = operationResult(vendorImportViewSchema.nullable(), await host.call({ operation: 'projects.import.vendor.show', id }));
                if (meta === null)
                    throw new WorkflowRuntimeError('not-found');
                if (meta.projectId !== id || meta.privatePayloads !== 'excluded')
                    throw new RuntimeHttpError('invalid-response');
                if (meta.sha256 !== reviewed)
                    throw new WorkflowRuntimeError('conflict');
                const view = await host.call({ operation: 'projects.import.vendor.show', id, inspect: true });
                const bundle = createVendorOriginZip(view, { projectId: id, reviewedOriginSha256: reviewed, includePrivate: true });
                const artifact = await writeArtifact(parsed.values.output, bundle.bytes, parsed.values.overwrite === true);
                emit({ schemaVersion: 1, status: 'written', format: bundle.manifest.format, projectId: id, revision: bundle.manifest.revision,
                    originSha256: reviewed, privatePayloads: 'included', restoration: 'not-supported', execution: 'not-run', artifact });
                return 0;
            }
            finally {
                await host.close();
            }
        }
        if (command === 'import' && rest[0] === 'inspect-origin') {
            const parsed = args(rest.slice(1), 1, ['reviewed-sha256']);
            emit(await inspectVendorOriginZip(await readBoundedBytes(parsed.positionals[0], VENDOR_ORIGIN_LIMITS.archiveBytes), parsed.values['reviewed-sha256']));
            return 0;
        }
        if (command === 'import' && (rest[0] === 'inspect' || rest[0] === 'project')) {
            const inspect = rest[0] === 'inspect';
            const parsed = jobArgs(rest.slice(1), 1, ['data-dir', ...operationFlags, ...inspect ? [] : ['reviewed-sha256', 'id']]);
            if (!inspect && (typeof parsed.values['reviewed-sha256'] !== 'string' || !/^[a-f0-9]{64}$/u.test(parsed.values['reviewed-sha256'])))
                throw new UsageError('Inspect the bundle, then supply its exact --reviewed-sha256.');
            if (!inspect && operationSelection(parsed.values) !== 'local' && typeof parsed.values.id !== 'string')
                throw new UsageError('Selected-owner project import requires a retained --id UUID; inspect that project after a lost response.');
            const bytes = await readBoundedBytes(parsed.positionals[0], PROJECT_PACKAGE_LIMITS.archiveBytes);
            const sha256 = createHash('sha256').update(bytes).digest('hex');
            if (!inspect && sha256 !== parsed.values['reviewed-sha256'])
                throw new WorkflowRuntimeError('conflict');
            const zipped = bytes[0] === 0x50 && bytes[1] === 0x4b;
            const archive = zipped ? await readProjectZip(bytes) : undefined;
            const json = archive ? archive.json : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            const host = await openCliOperations(parsed.values);
            try {
                const review = operationResult(z.object({ sha256: z.string(), bundle: z.unknown(), readiness: z.unknown() }), await host.call({ operation: 'projects.import.inspect', json }));
                const { ProjectLedger } = await import("./projects/ledger.js");
                const localReview = new ProjectLedger(DEFAULT_COMPILER_LIMITS.source, PROJECT_PACKAGE_LIMITS.entryBytes).inspectImport(json), bundle = localReview.bundle;
                if (review.sha256 !== localReview.sha256 || JSON.stringify(review.bundle) !== JSON.stringify(bundle))
                    throw new RuntimeHttpError('invalid-response');
                if (inspect) {
                    emit({ schemaVersion: 1, status: 'review-required', artifactSha256: sha256, format: zipped ? 'zip' : 'json',
                        source: bundle.source, title: bundle.title, revision: bundle.accepted.revision, historyIncluded: Boolean(bundle.history),
                        historyChanges: bundle.history?.changes.length ?? 0, externalHistory: 'unauthenticated historical claims',
                        ...(archive?.evidence ? { evidence: archive.evidence } : {}),
                        validation: review.readiness, review: { yaml: bundle.accepted.yaml, ...(bundle.version === 2 ? { tests: bundle.tests } : {}) }, execution: 'not-run',
                        warnings: ['Authored source, optional history and test definitions may contain sensitive content.', 'Import creates a new project and included tests as local drafts; it does not restore credentials, runs or conversations.'] });
                }
                else {
                    const project = operationResult(z.object({ id: z.uuid(), generation: z.number().int().positive(), acceptedRevision: z.string(), archived: z.boolean() }), await host.call({ operation: 'projects.import', json, reviewedSha256: review.sha256, ...(typeof parsed.values.id === 'string' ? { newId: parsed.values.id } : {}) }));
                    if ((parsed.values.id !== undefined && project.id !== parsed.values.id) || project.acceptedRevision !== bundle.accepted.revision)
                        throw new RuntimeHttpError('invalid-response');
                    emit({ schemaVersion: 1, status: 'imported', id: project.id, generation: project.generation, revision: project.acceptedRevision,
                        artifactSha256: sha256, source: bundle.source, historyIncluded: Boolean(bundle.history), archived: project.archived, execution: 'not-run',
                        ...(archive?.evidence ? { evidence: { ...archive.evidence.attachment, importStatus: 'not-restored' } } : {}),
                        importedTests: bundle.version === 2 ? await importedOperationTests(host, project.id) : [] });
                }
                return 0;
            }
            finally {
                await host.close();
            }
        }
        if (command === 'caller') {
            const action = rest[0];
            if (action === 'stream') {
                const parsed = args(rest.slice(1), 1, ['endpoint', 'instance-id', 'release-pin-file', 'token-file', 'ca-file', 'timeout-ms', 'interval-ms', 'duration-ms'], ['follow']);
                return await callerStreamFromCli(parsed.positionals[0], parsed.values, io.out);
            }
            if (action !== 'start' && action !== 'read' && action !== 'cancel' && action !== 'checkpoint' && action !== 'control')
                throw new UsageError('Use caller start <retained-start.json>, caller read|checkpoint <run-uuid>, caller cancel <run-uuid> --request-file <retained-cancellation.json> or caller control <run-uuid> --request-file <retained-control.json>.');
            const parsed = args(rest.slice(1), 1, ['endpoint', 'instance-id', 'release-pin-file', 'token-file', 'ca-file', 'timeout-ms', 'trace-context-file', ...(action === 'cancel' || action === 'control' ? ['request-file'] : [])]);
            emit(await callerFromCli(action, parsed.positionals[0], parsed.values));
            return 0;
        }
        if (command === 'reviewer') {
            if (rest[0] !== 'decide')
                throw new UsageError('Use reviewer decide <retained-decision.json>.');
            const parsed = args(rest.slice(1), 1, ['endpoint', 'instance-id', 'token-file', 'ca-file', 'timeout-ms', 'trace-context-file']);
            emit(await reviewerFromCli(parsed.positionals[0], parsed.values));
            return 0;
        }
        if (command === 'grants') {
            const [action, ...tail] = rest;
            if (!action || !['token', 'issue', 'show', 'list', 'revoke'].includes(action))
                throw new UsageError('Unknown grant operation. Run jevable help grants.');
            if (action === 'token') {
                const parsed = args(tail, 0, ['id', 'output']);
                const prepared = prepareGrantToken(parsed.values.id);
                const artifact = await writeArtifact(parsed.values.output, prepared.token + '\n');
                emit({ schemaVersion: 1, status: 'prepared-not-issued', id: prepared.id, tokenSha256: prepared.tokenSha256,
                    path: artifact.path, secret: 'not-displayed', delegatedExecution: 'sdk-start-read-reviewer; opt-in-management-reviewer-transport' });
                return 0;
            }
            const parsed = jobArgs(tail, action === 'list' ? 0 : 1, ['data-dir', ...operationFlags,
                ...(action === 'revoke' ? ['request-id', 'expected-generation'] : [])], [], action === 'list' ? 'record' : undefined);
            let issue;
            if (action === 'issue') {
                let value;
                try {
                    value = JSON.parse(await readBoundedFile(parsed.positionals[0], GRANT_LIMITS.bytes));
                }
                catch {
                    throw new UsageError('Grant command must contain bounded JSON.');
                }
                const result = grantIssueSchema.omit({ actor: true }).safeParse(value);
                if (!result.success)
                    throw new UsageError('Grant command must contain the retained ID/digest, exact scope and expiry, without bearer or actor.');
                issue = result.data;
            }
            const host = await openCliOperations(parsed.values);
            try {
                if (action === 'list')
                    emit(operationResult(grantPageResultSchema, await host.call({ operation: 'grants.list', page: parsed.page })));
                else
                    emit(operationResult(grantMetadataSchema, await host.call(action === 'issue'
                        ? { operation: 'grants.issue', command: issue }
                        : action === 'revoke' ? { operation: 'grants.revoke', command: { id: parsed.positionals[0], requestId: parsed.values['request-id'],
                                expectedGeneration: generation(parsed.values['expected-generation']) } }
                            : { operation: 'grants.show', id: parsed.positionals[0] })));
                return 0;
            }
            finally {
                await host.close();
            }
        }
        if (command === 'telemetry') {
            if (rest[0] === 'export-gateway') {
                const parsed = args(rest.slice(1), 0, ['options-file', 'options-sha256', 'output'], ['overwrite']);
                const bytes = await readBoundedBytes(parsed.values['options-file'], COLLECTOR_GATEWAY_OPTIONS_MAX_BYTES);
                if (createHash('sha256').update(bytes).digest('hex') !== parsed.values['options-sha256'])
                    throw new WorkflowRuntimeError('conflict');
                let value;
                try {
                    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
                }
                catch {
                    throw new WorkflowRuntimeError('invalid-command');
                }
                const bundle = createCollectorGatewayBundle(value);
                emit({ ...bundle.manifest, reviewedOptionsSha256: parsed.values['options-sha256'],
                    artifact: await writeArtifact(parsed.values.output, bundle.bytes, parsed.values.overwrite === true) });
                return 0;
            }
            if (rest[0] !== 'probe')
                throw new UsageError('Use jevable telemetry probe or telemetry export-gateway.');
            const parsed = jobArgs(rest.slice(1), 0, ['data-dir', ...operationFlags]);
            const host = await openCliOperations(parsed.values);
            try {
                const report = operationResult(collectorProbeReportSchema, await host.call({ operation: 'telemetry.probe' }));
                emit(report);
                return ['acknowledged', 'warning'].includes(report.status) ? 0 : 1;
            }
            finally {
                await host.close();
            }
        }
        if (command === 'activity') {
            if (rest[0] !== 'report')
                throw new UsageError('Use jevable activity report.');
            const parsed = jobArgs(rest.slice(1), 0, ['data-dir', ...operationFlags]);
            const host = await openCliOperations(parsed.values);
            try {
                emit(operationResult(activityReportSchema, await host.call({ operation: 'activity.report' })));
                return 0;
            }
            finally {
                await host.close();
            }
        }
        if (command === 'usage') {
            if (rest[0] !== 'report')
                throw new UsageError('Use jevable usage report <selection.json>.');
            const parsed = jobArgs(rest.slice(1), 1, ['data-dir', ...operationFlags]);
            let value;
            try {
                value = JSON.parse(await readBoundedFile(parsed.positionals[0], EVIDENCE_PACKAGE_LIMITS.selectionBytes));
            }
            catch {
                throw new UsageError('Usage selection must be a bounded JSON file with run IDs and revisions.');
            }
            let selection;
            try {
                selection = inspectUsageSelection(value).selection;
            }
            catch (error) {
                if (error instanceof WorkflowRuntimeError && error.code === 'invalid-command')
                    throw new UsageError('Usage selection requires unique run IDs/revisions, an optional ordered UTC-millisecond window and optional groupBy provider|provider-model.');
                throw error;
            }
            const host = await openCliOperations(parsed.values);
            try {
                emit(await host.call({ operation: 'usage.report', selection }));
                return 0;
            }
            finally {
                await host.close();
            }
        }
        if (command === 'runs' && rest[0] === 'inspect-bundle') {
            const parsed = args(rest.slice(1), 1, ['sha256']);
            emit(await inspectEvidenceZip(await readBoundedBytes(parsed.positionals[0], EVIDENCE_PACKAGE_LIMITS.archiveBytes), typeof parsed.values.sha256 === 'string' ? parsed.values.sha256 : undefined));
            return 0;
        }
        if (command === 'runs' && rest[0] === 'export-bundle') {
            const parsed = jobArgs(rest.slice(1), 1, ['data-dir', ...operationFlags, 'output'], ['include-private', 'overwrite']);
            if (typeof parsed.values.output !== 'string')
                throw new UsageError('Provide --output <evidence.zip>. Private execution data requires --include-private.');
            const raw = await readBoundedFile(parsed.positionals[0], EVIDENCE_PACKAGE_LIMITS.selectionBytes);
            let value;
            try {
                value = JSON.parse(raw);
            }
            catch {
                throw new UsageError('Selection file must contain valid JSON.');
            }
            const { selection } = inspectEvidenceSelection(value), host = await openCliOperations(parsed.values);
            try {
                const result = await createEvidenceZip({
                    exportRun: (id, includePrivate) => host.call({ operation: 'runs.export', id, includePrivate }),
                    testResult: (runId, inspect) => host.call({ operation: 'tests.result', runId, inspect }),
                }, selection, parsed.values['include-private'] === true);
                const artifact = await writeArtifact(parsed.values.output, result.bytes, parsed.values.overwrite === true);
                emit({ schemaVersion: 1, status: 'written', artifact, selectionSha256: result.manifest.selectionSha256,
                    privacy: result.manifest.privacy, runs: result.manifest.runs.length,
                    testAssessments: result.manifest.runs.filter(run => run.testPath).length,
                    consistency: result.manifest.consistency, execution: result.manifest.execution, restoration: result.manifest.restoration });
                return 0;
            }
            finally {
                await host.close();
            }
        }
        if (command === 'approvals' && rest[0] === 'notify') {
            const action = rest[1];
            if (!action || !['destinations', 'prepare', 'send', 'show', 'list', 'abort', 'automatic-status', 'automatic-show', 'automatic-list'].includes(action))
                throw new UsageError('Use approvals notify destinations|prepare|send|show|list|abort|automatic-status|automatic-show|automatic-list.');
            const diagnostic = action.startsWith('automatic-');
            const parsed = jobArgs(rest.slice(2), ['destinations', 'list', 'automatic-status', 'automatic-list'].includes(action) ? 0 : 1, ['data-dir', ...(diagnostic ? [] : ['notifications-file']), ...operationFlags, ...(action === 'prepare' ? ['revision', 'attempt', 'destination', 'event-kind']
                    : action === 'list' ? ['project-id', 'generation', 'revision', 'outcome', 'event-kind', 'created-from', 'created-before'] : [])], [], ['list', 'automatic-list'].includes(action) ? 'record' : undefined);
            let operation;
            if (action === 'destinations')
                operation = { operation: 'notifications.destinations' };
            else if (action === 'automatic-status')
                operation = { operation: 'notifications.automatic-status' };
            else if (action === 'automatic-list') {
                if (!parsed.page)
                    throw new UsageError('Automatic admission history requires --page; reads never resend reservations.');
                operation = { operation: 'notifications.automatic-list', page: parsed.page };
            }
            else if (action === 'automatic-show') {
                if (!z.uuid().safeParse(parsed.positionals[0]).success)
                    throw new UsageError('Provide the retained automatic admission request UUID.');
                operation = { operation: 'notifications.automatic-show', requestId: parsed.positionals[0] };
            }
            else if (action === 'list') {
                if (!parsed.page)
                    throw new UsageError('Notification history requires --page; follow nextCursor, not an assumed complete list.');
                const fields = [['outcome', 'outcome'], ['event-kind', 'eventKind'], ['created-from', 'createdFrom'], ['created-before', 'createdBefore']];
                const filter = Object.fromEntries(fields.filter(([flag]) => parsed.values[flag] !== undefined).map(([flag, key]) => [key, parsed.values[flag]]));
                const selected = notificationPageRequestSchema.safeParse({ ...parsed.page, ...(Object.keys(filter).length ? { filter } : {}) });
                if (!selected.success)
                    throw new UsageError('Use a supported notification outcome/event kind and UTC ISO creation bounds with milliseconds; from must precede before.');
                if (parsed.values['project-id'] === undefined)
                    operation = { operation: 'notifications.list', page: selected.data };
                else {
                    const project = notificationProjectScopeSchema.safeParse({ id: parsed.values['project-id'],
                        generation: Number(parsed.values.generation), revision: parsed.values.revision });
                    if (!project.success)
                        throw new UsageError('Provide the exact historical project ID, generation and revision.');
                    operation = { operation: 'notifications.project-list', project: project.data, page: selected.data };
                }
            }
            else if (action === 'prepare') {
                const pin = approvalNotificationPinSchema.safeParse({ runId: parsed.positionals[0], revision: parsed.values.revision, attemptId: parsed.values.attempt,
                    ...(parsed.values['event-kind'] === undefined ? {} : { eventKind: parsed.values['event-kind'] }) });
                if (!pin.success || typeof parsed.values.destination !== 'string' || !parsed.values.destination)
                    throw new UsageError('Provide the reviewed run ID, --revision, --attempt and --destination.');
                operation = { operation: 'notifications.prepare', pin: pin.data, endpointId: parsed.values.destination };
            }
            else if (action === 'show' || action === 'abort') {
                if (!z.uuid().safeParse(parsed.positionals[0]).success)
                    throw new UsageError('Provide the retained notification request UUID.');
                operation = { operation: action === 'show' ? 'notifications.show' : 'notifications.abort', requestId: parsed.positionals[0] };
            }
            else {
                let value;
                try {
                    value = JSON.parse(await readBoundedFile(parsed.positionals[0], 65536));
                }
                catch {
                    throw new UsageError('Provide a bounded reviewed notification request JSON file, including its retained requestId.');
                }
                const request = notificationRequestSchema.safeParse(value);
                if (!request.success)
                    throw new UsageError('Invalid notification request. Include reviewed pins and requestId; omit event, delivery, actor, URL and signing keys.');
                operation = { operation: 'notifications.send', request: request.data };
            }
            const host = await openCliOperations(parsed.values);
            try {
                const result = await host.call(operation);
                if (operation.operation === 'notifications.automatic-status') {
                    emit(operationResult(automaticDiagnosticStatusSchema, result));
                    return 0;
                }
                if (operation.operation === 'notifications.automatic-show') {
                    const record = operationResult(automaticDiagnosticSchema, result);
                    if (record.request.requestId !== operation.requestId)
                        throw new RuntimeHttpError('invalid-response');
                    emit(record);
                    return 0;
                }
                if (operation.operation === 'notifications.automatic-list') {
                    let page;
                    try {
                        page = inspectAutomaticDiagnosticPage(result, operation.page);
                    }
                    catch {
                        throw new RuntimeHttpError('invalid-response');
                    }
                    emit(page);
                    return 0;
                }
                if (operation.operation === 'notifications.abort') {
                    const aborted = operationResult(notificationAbortResultSchema, result);
                    if (aborted.requestId !== operation.requestId)
                        throw new RuntimeHttpError('invalid-response');
                    emit(aborted);
                    return 0;
                }
                if (operation.operation === 'notifications.list' || operation.operation === 'notifications.project-list') {
                    let page;
                    try {
                        page = operation.operation === 'notifications.project-list'
                            ? inspectProjectNotificationPage(result, operation.project, operation.page)
                            : inspectNotificationPage(result, operation.page);
                    }
                    catch {
                        throw new RuntimeHttpError('invalid-response');
                    }
                    emit(page);
                    return 0;
                }
                if (operation.operation === 'notifications.send' || operation.operation === 'notifications.show') {
                    const receipt = operationResult(notificationReceiptSchema, result);
                    if (operation.operation === 'notifications.send' ? !isDeepStrictEqual(receipt.request, operation.request)
                        : receipt.request.requestId !== operation.requestId)
                        throw new RuntimeHttpError('invalid-response');
                    emit(receipt);
                    return operation.operation === 'notifications.show' ? 0 : receipt.outcome.status === 'pending' || receipt.outcome.result.status === 'uncertain'
                        ? 5 : receipt.outcome.result.status === 'accepted' ? 0 : 1;
                }
                emit(result);
                return 0;
            }
            finally {
                await host.close();
            }
        }
        if (command === 'run' || command === 'runs' || command === 'approvals') {
            const action = command === 'run' ? 'start' : rest[0];
            const tail = command === 'run' ? rest : rest.slice(1);
            const allowed = command === 'run' ? ['start'] : command === 'runs' ? ['list', 'show', 'events', 'export', 'traces', 'resume', 'cancel', 'step', 'continue', 'pause', 'recover'] : ['list', 'show', 'decide'];
            if (!action || !allowed.includes(action))
                throw new UsageError('Unknown runtime operation. Run jevable --help.');
            const parsed = jobArgs(tail, action === 'list' ? 0 : 1, ['data-dir', ...operationFlags,
                ...(command === 'run' ? ['input', 'id', 'trigger-mode'] : action === 'decide' ? ['attempt', 'action'] : ['pause', 'recover'].includes(action) ? ['request-id', 'checkpoint-sha256'] : ['step', 'continue'].includes(action) ? ['request-id', 'checkpoint-sha256', 'breakpoints-file'] : action === 'cancel' ? ['request-id'] : action === 'export' ? ['output'] : action === 'traces' ? ['trace-viewer-file'] : [])], action === 'export' ? ['include-private', 'overwrite'] : command === 'run' ? ['paused'] : action === 'decide' ? ['pause-after'] : [], action === 'list' ? 'record' : undefined);
            const triggerMode = cliTriggerMode(parsed.values['trigger-mode']);
            if (command === 'run' && operationSelection(parsed.values) !== 'local' && typeof parsed.values.id !== 'string')
                throw new UsageError('Selected-owner execution requires a retained --id UUID before submission; never invent another after an uncertain response.');
            if (command === 'run' && typeof parsed.values.input !== 'string')
                throw new UsageError('Provide --input <input.json>.');
            if (action === 'decide' && (typeof parsed.values.attempt !== 'string' || typeof parsed.values.action !== 'string'))
                throw new UsageError('Provide --attempt and --action from the reviewed approval task.');
            if (action === 'export' && typeof parsed.values.output !== 'string')
                throw new UsageError('Provide --output <evidence.json>. Payloads are excluded unless --include-private is explicit.');
            if (command === 'approvals' && action === 'list' && !parsed.page)
                throw new UsageError('Approval inbox requires --page; follow nextCursor even when tasks is empty.');
            const traceViewer = action === 'traces' ? await readTraceViewerFile(parsed.values['trace-viewer-file']) : undefined;
            const breakpoints = await readBreakpointFile(parsed.values['breakpoints-file']);
            const host = await openCliOperations(parsed.values);
            try {
                if (action === 'list') {
                    emit(await host.call(command === 'approvals' ? { operation: 'approvals.list', page: parsed.page }
                        : { operation: 'runs.list', ...(parsed.page ? { page: parsed.page } : {}) }));
                    return 0;
                }
                const target = parsed.positionals[0];
                if (action === 'traces') {
                    const evidence = await host.call({ operation: 'runs.export', id: target });
                    const summary = operationResult(z.object({ snapshot: z.object({ run: z.object({ id: z.literal(target), revision: z.string() }) }) }), evidence);
                    emit(await prepareTraceNavigation({ runId: target, revision: summary.snapshot.run.revision }, evidence, traceViewer));
                    return 0;
                }
                if (action === 'export') {
                    const evidence = await host.call({ operation: 'runs.export', id: target, includePrivate: parsed.values['include-private'] === true });
                    const summary = operationResult(z.object({ snapshot: z.object({ run: z.object({ id: z.literal(target), revision: z.string(), status: z.string() }), privacy: z.unknown() }),
                        checksum: z.object({ algorithm: z.literal('sha256'), encoding: z.literal('JSON.stringify(snapshot)'), value: z.string().regex(/^[a-f0-9]{64}$/u) }) }), evidence);
                    if (createHash('sha256').update(JSON.stringify(evidence.snapshot)).digest('hex') !== summary.checksum.value)
                        throw new RuntimeHttpError('invalid-response');
                    const artifact = await writeArtifact(parsed.values.output, JSON.stringify(evidence), parsed.values.overwrite === true);
                    emit({ schemaVersion: 1, status: 'written', artifact, runId: target, revision: summary.snapshot.run.revision,
                        workflowStatus: summary.snapshot.run.status, snapshotSha256: summary.checksum.value, privacy: summary.snapshot.privacy,
                        execution: 'not-started-or-resumed-by-export' });
                    return 0;
                }
                if (action === 'events') {
                    emit(await host.call({ operation: 'runs.events', id: target }));
                    return 0;
                }
                if (command === 'approvals' && action === 'show') {
                    emit(await host.call({ operation: 'approvals.show', id: target }));
                    return 0;
                }
                let run, expectedId = target;
                if (command === 'run') {
                    const source = await readBoundedFile(target, DEFAULT_COMPILER_LIMITS.source.maxSourceBytes);
                    const raw = await readBoundedFile(parsed.values.input, DEFAULT_COMPILER_LIMITS.binding.data.maxBytes);
                    let input;
                    try {
                        input = JSON.parse(raw);
                    }
                    catch {
                        throw new UsageError('Input file must contain valid JSON.');
                    }
                    expectedId = typeof parsed.values.id === 'string' ? parsed.values.id : randomUUID();
                    run = await host.call({ operation: 'runs.start', id: expectedId, yaml: source, input: input, paused: parsed.values.paused === true, ...triggerMetadata({ triggerMode }) });
                }
                else if (action === 'cancel')
                    run = await host.call({ operation: 'runs.cancel', id: target, requestId: parsed.values['request-id'] });
                else if (action === 'step' || action === 'continue' || action === 'pause' || action === 'recover')
                    run = await host.call({ operation: 'runs.advance', id: target, requestId: parsed.values['request-id'],
                        expectedCheckpointSha256: parsed.values['checkpoint-sha256'], mode: action, ...(breakpoints === undefined ? {} : { breakpoints }) });
                else if (action === 'resume')
                    run = await host.call({ operation: 'runs.resume', id: target });
                else if (action === 'decide')
                    run = await host.call({ operation: 'approvals.decide', id: target, attemptId: parsed.values.attempt, action: parsed.values.action, pauseAfter: parsed.values['pause-after'] === true });
                else
                    run = await host.call({ operation: 'runs.show', id: target });
                const status = operationResult(runResultSchema, run);
                if (status.id !== expectedId)
                    throw new RuntimeHttpError('invalid-response');
                emit(run);
                return action === 'show' || action === 'cancel' || action === 'pause' ? 0 : resultExit(status);
            }
            finally {
                await host.close();
            }
        }
        throw new UsageError('Unknown or not-yet-implemented command. Run jevable --help for available operations.');
    }
    catch (error) {
        if (error instanceof CliOutputError)
            throw error;
        if (error instanceof CliJobInterruptedError)
            return lifetime.exitCode ?? 1;
        if (error instanceof CliCommandHelp && help) {
            const report = helpReport(help.path, error.variants);
            help.json ? emit(report) : io.out(renderHelp(report));
            return 0;
        }
        const account = error instanceof AccountError || error instanceof AccountSessionError;
        const accountInput = account && ['invalid-config', 'invalid-authorization', 'invalid-grant', 'invalid-code', 'invalid-pin'].includes(error.code);
        const usage = accountInput || error instanceof AccountCliInputError || error instanceof UsageError || error instanceof CliHelpInputError || error instanceof CliFlagRequirementsError || error instanceof WorkflowImportError || error instanceof RuntimeServiceUsageError || error instanceof CliStorageUsageError;
        const provider = error instanceof ProviderError;
        const runtime = error instanceof WorkflowRuntimeError;
        const archive = error instanceof ProjectPackageError || error instanceof VendorOriginPackageError;
        const http = error instanceof RuntimeHttpError || error instanceof RunWatchError;
        const image = error instanceof ImageError || error instanceof DockerLifecycleError;
        const startup = error instanceof RuntimeStartupError || error instanceof JournalError;
        const code = error.code;
        const knownIO = { ENOENT: 'File or parent directory not found.', EEXIST: 'Output exists; choose a different path or explicitly use --overwrite.',
            EACCES: 'File permission denied.', EPERM: 'File operation is not permitted.' };
        const message = usage || account || runtime || provider || archive || http || image || startup ? error.message : code && knownIO[code] ? knownIO[code]
            : error instanceof Error && ['Expected a regular input file.', 'Input file exceeds the configured byte limit.'].includes(error.message)
                ? error.message : 'Operation failed. Inspect retained run state before retrying an execution request.';
        io.err(`${JSON.stringify({ schemaVersion: 1, status: 'error', code: usage ? 'invalid-input' : account || runtime || provider || archive || http || image || startup ? error.code : 'operation-failed', message,
            ...(error instanceof ImageError && error.build ? { build: error.build } : {}),
            ...(error instanceof DockerLifecycleError && error.owner ? { owner: error.owner } : {}) })}\n`);
        return usage ? 2 : account && error.code === 'outcome-unknown' ? 5 : account && ['attempt-recorded', 'not-active'].includes(error.code) ? 3 : 1;
    }
}

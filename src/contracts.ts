/** Offline input-shape discovery generated from the same schemas used by core admission. */
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { CORE_VERSION } from './capabilities.ts'
import { workflowSchema } from './workflow/schema.ts'
import { triggerConfig, decisionConfig, llmConfig, ruleConfig, outputConfig, approvalConfig, loopConfig, customConfig } from './workflow/node-config.ts'
import { testDefinitionSchema, testIdentitySchema, testCommandSchema } from './testing/schema.ts'
import { generateTestsSchema } from './testing/generation-schema.ts'
import { testErasureCommandSchema } from './testing/erasure-write.ts'
import { testSuiteSelectionSchema, testSuiteSchema } from './testing/suite.ts'
import { connectionSchema } from './providers/config.ts'
import { telemetryConfigSchema } from './telemetry/config.ts'
import { collectorGatewayOptionsSchema } from './telemetry/gateway.ts'
import { traceViewerConfigSchema } from './telemetry/navigation-schema.ts'
import { notificationConfigSchema } from './notifications/config.ts'
import { approvalNotificationPinSchema, notificationRequestSchema } from './notifications/schema.ts'
import { evidenceSelectionSchema } from './evidence/package.ts'
import { usageSelectionSchema } from './evidence/usage.ts'
import { postgresConfigSchema } from './storage/postgres-config.ts'
import { runtimeOperationSchema } from './http/operations.ts'
import { executionControlSchema, breakpointListSchema } from './runtime/control.ts'
import { callerControlRequestSchema } from './access/caller-control.ts'
import { callerStreamRequestSchema } from './http/caller-stream.ts'
import { projectCommandSchema, projectBundleSchema } from './projects/ledger.ts'
import { releaseSnapshotSchema } from './releases/snapshot.ts'
import { buildSchema } from './images/local.ts'
import { kubernetesOptionsSchema } from './deployment/kubernetes.ts'
import { managementKubernetesOptionsSchema } from './deployment/management-kubernetes.ts'
import { previewProjectPinSchema } from './preview/project-pin.ts'

interface Contract { schema: z.ZodType; summary: string; references: readonly string[]; limits: string }
const contract = (schema: z.ZodType, summary: string, references: string[], limits: string): Contract => ({ schema, summary, references, limits })
const nodeLimits = 'Node configuration shape only. Compiler bindings/graph/value schemas, supported runtime settings and provider admission still apply.'
const entries: Record<string, Contract> = {
  'preview-project-pin': contract(previewProjectPinSchema, 'Reviewed existing-project HTML preview selection', ['live-preview.md'], 'Exact id, current project generation and accepted revision. CLI requires the pin file SHA-256 and the same workflow source revision. Startup only reads the selected project; archived/stale/missing projects refuse with no create, restore, retarget or execution fallback. Authentication and runtime instance selection remain independent guards.'),
  'caller-stream': contract(callerStreamRequestSchema, 'Bounded read-only caller SSE request', ['grants.md'], 'Consumed by POST /v1/caller/stream on an explicitly enabled management host. Requires the creating grant with fresh read permission, retained own-run identity, reviewed release and instance pins. Metadata only; no completed output, cursor, Last-Event-ID, automatic reconnect, execution/control or approval authority. SDK accepts the interval/duration/follow subset plus an in-process AbortSignal. This is not browser or deployment qualification.'),
  'trace-viewer': contract(traceViewerConfigSchema, 'Explicit credential-free trace navigation destination', ['trace-navigation.md'], 'Consumed by CLI viewer files; SDK/preview use the same semantic parser. Origin/TLS/loopback, path, UID, exact profile/range ordering and unknown-field refinements remain core checks. Links never probe, authenticate, open a browser, send telemetry or authorize backend access. Grafana URL structure is not browser/backend qualification.'),
  workflow: contract(workflowSchema, 'Parsed YAML workflow envelope', ['authoring.md'], 'Nodes keep arbitrary config objects in the envelope. Inspect node-* schemas, then validate the YAML with the compiler; this is not workflow validation or execution readiness.'),
  'node-trigger': contract(triggerConfig, 'Trigger configuration', ['authoring.md'], nodeLimits),
  'node-decision': contract(decisionConfig, 'Typed Decision (Jev/Laya/LLM) configuration', ['authoring.md', 'systemone.md'], nodeLimits + ' Provider/LLM and native answer-format cross-field constraints require core validation.'),
  'node-llm': contract(llmConfig, 'LLM configuration', ['authoring.md', 'providers.md'], nodeLimits),
  'node-rule': contract(ruleConfig, 'Deterministic Rule configuration', ['authoring.md'], nodeLimits),
  'node-output': contract(outputConfig, 'Output configuration', ['authoring.md'], nodeLimits),
  'node-approval': contract(approvalConfig, 'Human Approval configuration', ['authoring.md', 'control.md'], nodeLimits + ' Duration conversion/safe-integer and action constraints remain core checks.'),
  'node-loop': contract(loopConfig, 'Loop configuration', ['authoring.md'], nodeLimits + ' Loop body configs are compiled separately; an allowed node kind does not imply supported execution.'),
  'node-custom': contract(customConfig, 'Custom-node source configuration', ['authoring.md'], 'Source discovery only. Custom execution is unsupported by the current runtime; this schema does not enable it.'),
  'test-definition': contract(testDefinitionSchema, 'Saved test definition input', ['testing.md'], 'Core enforces exactly one status expectation and compatible output/failure expectations, project pins, size and review. A passing waiting assertion is not workflow completion.'),
  'test-identity': contract(testIdentitySchema, 'Retained test version identity', ['testing.md', 'suites.md'], 'A formatted identity does not establish existence, acceptance, ownership or checksum equality.'),
  'test-command': contract(testCommandSchema, 'SDK test mutation command', ['testing.md'], 'SDK commands include actor. HTTP tests.command fixes actor on the host and rejects it in the submitted nested body. Generations, review and authority remain core checks.'),
  'test-generation': contract(generateTestsSchema, 'SDK schema-derived test generation request', ['testing.md'], 'SDK actor differs from the HTTP body. Generation creates drafts only; project pins and limits remain core checks. No model call or test execution is implied.'),
  'test-erasure-request': contract(testErasureCommandSchema, 'Retained owner CLI/HTTP draft logical-removal request', ['testing.md'], 'Actor is host-fixed and forbidden in this input. CLI additionally requires --confirm-delete; HTTP adds confirmId to this nested request. Exact full-history/case pins, explicit authority and complete live-reference checks remain required. Identical retained UUID retries only observe; no physical erasure, preview, delegated or exact-release authority.'),
  'suite-selection': contract(testSuiteSelectionSchema, 'Offline suite creation selection', ['suites.md'], 'Creation allocates run identities, not execution. Retain and review the resulting manifest before running; size and exact test identity checks remain required.'),
  'suite-manifest': contract(testSuiteSchema, 'Saved bounded test suite manifest', ['suites.md'], 'Run IDs must be unique. Optional concurrency (1–8) is included in the reviewed manifest; omission remains serial. Accepted test/project pins, owner guards and settled admitted work remain required; no automatic approval or replay.'),
  'provider-connection': contract(connectionSchema, 'Operator-configured provider connection', ['providers.md', 'systemone.md'], 'Endpoint trust, allowed-model uniqueness, string normalization and configuration guards remain core checks. Includes credential references, never secret values. Does not validate remote credentials or call a provider.'),
  'telemetry-config': contract(telemetryConfigSchema, 'Startup OpenTelemetry configuration', ['observability.md'], 'Core additionally checks endpoint safety, gRPC origins, signal/metric dependencies and batch/queue relationships. Secret bearer credentials are separate; discovery does not contact a collector or qualify observability.'),
  'collector-gateway-options': contract(collectorGatewayOptionsSchema, 'Offline optional Collector gateway packaging', ['collector-gateway.md'], 'Core checks canonical HTTPS destinations, gRPC origins, enabled signals, bounded options, memory relationships and distinct optional loopback-only self-metrics ports. Absent selfMetrics explicitly disables the default Collector metrics listener. Secret values/files, Collector installation/validation, cluster mutation and workflow execution are not inputs or implied authority.'),
  'notification-config': contract(notificationConfigSchema, 'Startup notification destinations, bounds and optional reviewed automatic policy', ['notifications.md'], 'Core additionally checks unique safe destinations, canonical reviewed policy checksum, current destination fingerprints, bounded automatic work/audits and exact stored project-generation or immutable-release scopes. Omission disables automatic delivery. Startup/discovery never scans or sends historical events; a reviewed automatic policy selects future new acknowledged commits only. Credential references are not secrets, and discovery alone grants no delivery, approval, resume or recovery authority.'),
  'notification-pin': contract(approvalNotificationPinSchema, 'Retained approval event pin', ['notifications.md'], 'Event existence, recorded timestamps, release membership and approval identity remain core checks. Discovery does not settle expiry, decide approval or prepare delivery.'),
  'notification-request': contract(notificationRequestSchema, 'Reviewed explicit notification send request', ['notifications.md'], 'Core verifies prepared request identity and exact hashes. A schema-valid request grants no authority and never permits replay of an uncertain delivery.'),
  'evidence-selection': contract(evidenceSelectionSchema, 'Selected run/revision evidence ZIP input', ['evidence-packages.md'], 'Run IDs must be unique; size, owner/revision pins and separately authorized private payloads remain core checks. Not a usage-window/grouping selection or restore/replay instruction.'),
  'usage-selection': contract(usageSelectionSchema, 'Selected run/revision usage report with optional window and grouping', ['usage.md'], 'Core checks case-insensitive run uniqueness, canonical ordered millisecond window, byte limits and retained revision/evidence/identity coverage. Not an evidence ZIP selection, provider dispatch, billing estimate or permission to read private payloads.'),
  'postgres-config': contract(postgresConfigSchema, 'Explicit PostgreSQL journal startup configuration', ['postgres.md', 'docker-owner.md'], 'Contains a password field: discovery returns only its type, never values or user files. Core additionally checks host syntax, literal-loopback test mode, PEM CA validity and protected-file admission. Defaults do not initialize a database; discovery neither imports the PostgreSQL driver nor connects, validates credentials or acquires ownership.'),
  'runtime-operation': contract(runtimeOperationSchema, 'Single-owner management JSON operation envelope', ['http.md'], 'Some nested fields deliberately remain unknown or records here: projects.command, tests.command, providers.set and usage.report require their consuming validators. Actor is host-fixed; PostgreSQL page requirements, runtime/owner/release guards and authorization remain core checks. Not the exact-release API.'),
  'execution-control': contract(executionControlSchema, 'Guarded SDK advance/control input', ['control.md'], 'Retained checkpoint, request identity, owner and legal transition checks remain required. Discovery never steps, pauses, recovers or resumes a run.'),
  'caller-control': contract(callerControlRequestSchema, 'Guarded caller control request input', ['grants.md'], 'Consumed by direct SDK advanceWithGrant and the nested request of opt-in management caller HTTP/CLI control. Not an owner operation or complete HTTP envelope. Fresh creating-grant control permission, opaque checkpoint and legal phase remain required. Pause/recover refuse breakpoint changes. Identical retained requests only observe; recovery settles an already retained response without provider or downstream dispatch. No output/read/approval/owner authority is implied.'),
  breakpoints: contract(breakpointListSchema, 'Explicit node-ID breakpoint list', ['control.md'], 'Core verifies node identity, uniqueness and retained control pins. No breakpoint or execution mutation is performed.'),
  'project-command': contract(projectCommandSchema, 'SDK authoring mutation command', ['projects.md'], 'SDK commands include actor. HTTP projects.command fixes actor on the host and rejects it in the submitted nested body. Compiler/revision/generation, review acknowledgments and authority remain core checks.'),
  'project-bundle': contract(projectBundleSchema, 'Editable project JSON transfer envelope', ['transfer.md'], 'Core checks exact revisions/history/test identities, file limits and reviewed import hashes. ZIP framing/attachments use separate validators. Imported history does not restore authenticated execution or approval authority.'),
  'release-snapshot': contract(releaseSnapshotSchema, 'Immutable workflow release snapshot', ['releases.md'], 'Core checks exact compiled workflow and installed compatible runtime hashes. Snapshot discovery is not an app ZIP, image receipt, provider readiness or permission to execute.'),
  'image-build': contract(buildSchema, 'Explicit local image build options', ['images.md', 'management-images.md'], 'Core checks actual local engine, cached base digest, unused tag and reviewed role-specific runtime/release identity. No Docker inspection, build, load, push or start occurs during discovery.'),
  'kubernetes-options': contract(kubernetesOptionsSchema, 'Offline exact-release Kubernetes packaging options', ['kubernetes.md'], 'Core checks DNS/CIDR/labels, resource and telemetry cross-field relationships, exact release/image pins and operator assertions. No registry inspection, cluster apply, deployment qualification or permission is implied.'),
  'management-kubernetes-options': contract(managementKubernetesOptionsSchema, 'Offline PostgreSQL management Kubernetes packaging options', ['management-images.md'], 'Distinct management receipt and installed program hashes are required. Full management token authority, one owner, verified database/service TLS and reviewed network/resource limits apply. No registry attestation, cluster apply, HTML preview, notification delivery or execution is implied.'),
}

export class SchemaDiscoveryError extends Error {
  constructor() { super('Unknown schema. Use schemas list.'); this.name = 'SchemaDiscoveryError' }
}
const notes = [
  'Offline structural input discovery only: no files, storage, credentials, providers, services, Docker or cluster access.',
  'Generated from the consuming Zod input schemas, not a second handwritten validator. JSON Schema cannot express all core refinements, normalization, size limits, compiler rules, ownership, review or authority.',
  'A schema match is not runtime admission, readiness, test success, authenticated evidence or deployment qualification. Use the actual compiler/operation validators and routed guides.',
  'Defaults describe schema parsing, not permission to supply configuration, start an owner, send a notification or execute a workflow. Discovery never fills inputs or mutates callers.',
  'This catalogue is not exhaustive: protected-file admission, secret files, vendor imports, archives and exact-release API contracts have separate consuming validators and guides.',
]
const describe = (id: string, entry: Contract) => ({ id, summary: entry.summary, references: entry.references.map(x => `references/${x}`), limits: entry.limits })
export function listSchemas() {
  return { schemaVersion: 1, version: CORE_VERSION, kind: 'schema-index' as const, execution: 'not-dispatched' as const,
    schemas: Object.entries(entries).map(([id, entry]) => describe(id, entry)), notes: [...notes],
    referenceLocation: 'Relative to the npm/skill distribution; extracted management ZIPs do not include these guide files.' }
}
/** Input projection throws for unrepresentable types; never weaken one to an empty schema. */
export function showSchema(id: string) {
  if (typeof id !== 'string' || !Object.hasOwn(entries, id)) throw new SchemaDiscoveryError()
  const entry = entries[id]!
  const schema = z.toJSONSchema(entry.schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'throw' })
  return { schemaVersion: 1, version: CORE_VERSION, kind: 'schema' as const, execution: 'not-dispatched' as const,
    ...describe(id, entry), validation: 'structural-input-projection-only' as const, dialect: 'https://json-schema.org/draft/2020-12/schema',
    sha256: createHash('sha256').update(JSON.stringify(schema)).digest('hex'), schema, notes: [...notes],
    referenceLocation: 'Relative to the npm/skill distribution; extracted management ZIPs do not include these guide files.' }
}

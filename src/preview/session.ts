import { randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import type { RuntimeOperation } from '../http/operations.ts'
import { renderPreview } from './index.ts'
import { compileWorkflowYaml, type WorkflowCompilerLimits } from '../workflow/index.ts'
import { DEFAULT_COMPILER_LIMITS } from '../limits.ts'
import { generateInputs } from '../testing/generate.ts'
import { testDefinitionSchema, testIdentitySchema, testRecordSchema, type TestIdentity } from '../testing/schema.ts'
import { executionControlSchema } from '../runtime/control.ts'
import { findNode } from '../runtime/run-evaluator.ts'
import { loopScope } from '../runtime/run-types.ts'
import { traceNavigationTools, type TraceViewerConfig } from '../telemetry/navigation.ts'
import { createEvidenceZip, inspectEvidenceSelection } from '../evidence/package.ts'
import { releaseSnapshotSchema } from '../releases/snapshot.ts'
import { createReleaseZip, createReleaseZipWithEvidence } from '../packages/release-zip.ts'
import { createPreviewRelease, readPreviewRelease, previewReleaseZipEnvelope, listPreviewReleasePage } from './release.ts'
import { previewProjectZip } from './project.ts'
import { apiTriggerModeSchema, triggerMetadata } from '../runtime/trigger.ts'
import { projectPreviewNodeInspection, previewNodeInspectionRequestSchema } from './node-inspection.ts'
import { notificationPageRequestSchema } from '../notifications/history.ts'
import { inspectProjectNotificationPage } from '../notifications/project-history.ts'
import { usageSelectionSchema, inspectUsageSelection } from '../evidence/usage.ts'
import { projectPreviewUsage } from './usage.ts'
import { testSuiteCoverage } from '../testing/coverage.ts'
import { admitPreviewProjectPin } from './project-pin.ts'

const id = z.uuid()
const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const pinSchema = z.object({ id, generation, revision: hash })
const runSchema = z.looseObject({ id, revision: hash, project: z.object({ id, generation }).optional(), test: testIdentitySchema.optional() })
const caseSchema = z.looseObject({ id, generation, definition: z.looseObject({ project: pinSchema }) })
/** The owner fixes actor identity and retains all state; the preview never owns a second database. */
export interface PreviewOperations { call(command: RuntimeOperation): Promise<unknown> }
function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new WorkflowRuntimeError('corrupt')
  return parsed.data
}
const draftFields = { title: testDefinitionSchema.shape.title, input: z.json(), expectations: testDefinitionSchema.shape.expectations,
  triggerMode: apiTriggerModeSchema.optional() }
const commandSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('view'), triggerMode: apiTriggerModeSchema.optional() }),
  z.strictObject({ operation: z.literal('runs') }),
  z.strictObject({ operation: z.literal('notifications.list'), page: notificationPageRequestSchema }),
  z.strictObject({ operation: z.literal('usage'), id, window: usageSelectionSchema.shape.window, groupBy: usageSelectionSchema.shape.groupBy }),
  z.strictObject({ operation: z.literal('run'), id, input: z.json(), paused: z.boolean().optional(), triggerMode: apiTriggerModeSchema.optional() }),
  executionControlSchema.extend({ operation: z.literal('advance'), id }),
  z.strictObject({ operation: z.literal('show'), id }),
  z.strictObject({ operation: z.literal('inspect'), id }),
  previewNodeInspectionRequestSchema.extend({ operation: z.literal('node.inspect') }),
  z.strictObject({ operation: z.literal('evidence'), id, includePrivate: z.boolean().optional() }),
  z.strictObject({ operation: z.literal('evidence.bundle'), selection: z.unknown(), includePrivate: z.boolean().optional() }),
  z.strictObject({ operation: z.literal('release.create'), id, version: releaseSnapshotSchema.shape.version, storage: z.enum(['sqlite', 'postgres']),
    notes: releaseSnapshotSchema.shape.notes }),
  z.strictObject({ operation: z.literal('release.show'), id }),
  z.strictObject({ operation: z.literal('release.list'), cursor: z.string().regex(/^[a-f0-9]{64}$/u).optional() }),
  z.strictObject({ operation: z.literal('release.export'), id, releaseSha256: hash,
    evidence: z.strictObject({ selection: z.unknown(), sha256: hash, includePrivate: z.boolean().optional() }).optional() }),
  z.strictObject({ operation: z.literal('project.export'), history: z.boolean().optional(), tests: z.boolean().optional(),
    evidence: z.strictObject({ selection: z.unknown(), sha256: hash, includePrivate: z.boolean().optional() }).optional() }),
  z.strictObject({ operation: z.literal('cancel'), id, requestId: id }),
  z.strictObject({ operation: z.literal('approval'), id }),
  z.strictObject({ operation: z.literal('decide'), id, attemptId: id, action: z.string().min(1).max(128), pauseAfter: z.boolean().optional(), expireOnly: z.boolean().optional() }),
  z.strictObject({ operation: z.literal('tests.list') }),
  z.strictObject({ operation: z.literal('tests.show'), id, generation: generation.optional() }),
  z.strictObject({ operation: z.literal('tests.history'), id }),
  z.strictObject({ operation: z.literal('tests.create'), id, ...draftFields }),
  z.strictObject({ operation: z.literal('tests.edit'), id, expectedGeneration: generation, ...draftFields }),
  z.strictObject({ operation: z.literal('tests.accept'), id, expectedGeneration: generation, reviewedSha256: testIdentitySchema.shape.sha256 }),
  z.strictObject({ operation: z.literal('tests.archive'), id, expectedGeneration: generation,
    reviewedSha256: testIdentitySchema.shape.sha256, archived: z.boolean() }),
  z.strictObject({ operation: z.literal('tests.generate'), id, limit: z.number().int().min(1).max(32).optional(), triggerMode: apiTriggerModeSchema.optional() }),
  z.strictObject({ operation: z.literal('tests.generation'), id }),
  z.strictObject({ operation: z.literal('tests.run'), test: testIdentitySchema, runId: id }),
  z.strictObject({ operation: z.literal('tests.result'), runId: id, inspect: z.boolean().optional() }),
  z.strictObject({ operation: z.literal('tests.coverage-runs') }),
  z.strictObject({ operation: z.literal('tests.coverage'), runIds: z.array(id).min(1).max(100)
    .refine(ids => new Set(ids).size === ids.length) }),
])

/** One explicitly admitted preview project, never an adapter to a desktop/harness session. */
export class PreviewSession {
  private readonly tokens = new Map<string, number>()
  private readonly releaseCursors = new Map<string, { after: string; examined: number; expiresAt: number }>()
  private projectPin!: z.infer<typeof pinSchema>
  get pin() { return { ...this.projectPin } }
  private readonly rendered
  private readonly graph
  private readonly traceViewer: TraceViewerConfig | undefined
  private constructor(private readonly owner: PreviewOperations, source: string,
    private readonly limits: WorkflowCompilerLimits = DEFAULT_COMPILER_LIMITS, traceViewer?: TraceViewerConfig) {
    try { this.traceViewer = traceViewer === undefined ? undefined : traceNavigationTools().config(traceViewer) }
    catch { throw new WorkflowRuntimeError('invalid-command') }
    this.rendered = renderPreview(source, limits)
    if (this.rendered.data.validation.status !== 'valid') throw new WorkflowRuntimeError('invalid-command')
    this.graph = compileWorkflowYaml(source, limits)
  }
  static async create(owner: PreviewOperations, source: string, projectId?: string, limits?: WorkflowCompilerLimits, traceViewer?: TraceViewerConfig) {
    if (projectId !== undefined && !id.safeParse(projectId).success) throw new WorkflowRuntimeError('invalid-command')
    const session = new PreviewSession(owner, source, limits, traceViewer)
    const project = checked(z.object({ id, generation: z.literal(1), acceptedRevision: z.literal(checked(hash, session.rendered.data.revision)) }),
      await owner.call({ operation: 'projects.command', command: { operation: 'create', yaml: source,
        title: `Preview: ${session.rendered.data.name}`.slice(0, 256), ...(projectId ? { id: projectId } : {}) } }))
    if (projectId && project.id !== projectId) throw new WorkflowRuntimeError('corrupt')
    session.projectPin = { id: project.id, generation: project.generation, revision: project.acceptedRevision }
    return session
  }
  /** Read-only startup for exactly a reviewed active accepted project. No create fallback. */
  static async attach(owner: PreviewOperations, source: string, value: unknown, limits?: WorkflowCompilerLimits, traceViewer?: TraceViewerConfig) {
    const pin = admitPreviewProjectPin(source, value, limits)
    const session = new PreviewSession(owner, source, limits, traceViewer)
    const project = checked(z.object({ id, generation, acceptedRevision: hash, archived: z.boolean() }),
      await owner.call({ operation: 'projects.show', id: pin.id }))
    if (project.id !== pin.id) throw new WorkflowRuntimeError('corrupt')
    if (project.generation !== pin.generation || project.acceptedRevision !== pin.revision || project.archived) {
      throw new WorkflowRuntimeError('conflict')
    }
    session.projectPin = pin
    return session
  }
  bootstrap() {
    for (const [token, until] of this.tokens) if (until <= Date.now()) this.tokens.delete(token)
    if (this.tokens.size >= 8) throw new WorkflowRuntimeError('limit')
    const token = randomBytes(32).toString('hex'), expiresAt = Date.now() + 60 * 60 * 1000
    this.tokens.set(token, expiresAt)
    return { token, expiresAt: new Date(expiresAt).toISOString(), project: this.pin,
      scope: 'this-preview-project-only', retention: 'project-and-runs-retained-after-session' }
  }
  authenticate(header: string | undefined): string | undefined {
    if (!header || !/^Bearer [a-f0-9]{64}$/u.test(header)) return undefined
    const supplied = Buffer.from(header.slice(7))
    for (const [token, until] of this.tokens) {
      if (until <= Date.now()) { this.tokens.delete(token); continue }
      if (timingSafeEqual(supplied, Buffer.from(token))) return token
    }
    return undefined
  }
  revoke(token: string) { this.tokens.delete(token) }
  private matches(pin: { id: string; generation: number; revision: string }) {
    return pin.id === this.pin.id && pin.generation === this.pin.generation && pin.revision === this.pin.revision
  }
  private async scopedCase(id: string, generation?: number) {
    const item = checked(caseSchema, await this.owner.call({ operation: 'tests.show', id,
      ...(generation === undefined ? {} : { generation }) }))
    if (item.id !== id || (generation !== undefined && item.generation !== generation)) throw new WorkflowRuntimeError('corrupt')
    if (!this.matches(item.definition.project)) throw new WorkflowRuntimeError('not-found')
    return item
  }
  private async scopedRun(id: string) {
    const run = checked(runSchema, await this.owner.call({ operation: 'runs.show', id }))
    if (run.id !== id) throw new WorkflowRuntimeError('corrupt')
    if (!run.project || !this.matches({ ...run.project, revision: run.revision })) throw new WorkflowRuntimeError('not-found')
    return run
  }
  private async list(kind: 'runs' | 'tests') {
    const rowSchema = kind === 'runs' ? runSchema : z.looseObject({ id, project: pinSchema })
    const pageSchema = z.object({ schemaVersion: z.literal(2), nextCursor: id.nullable(),
      [kind]: z.array(rowSchema).max(200) })
    const rows = []; let after: string | undefined, examined = 0
    do {
      const raw = await this.owner.call({ operation: kind === 'runs' ? 'runs.list' : 'tests.list',
        page: { limit: 200, ...(after ? { after } : {}) } })
      // Keep the cursor schema explicit: computed-key inference otherwise widens every property.
      checked(pageSchema, raw)
      const page = checked(z.object({ nextCursor: id.nullable() }), raw)
      const items = checked(z.array(rowSchema).max(200), Reflect.get(raw as object, kind))
      for (const row of items) {
        if (after && row.id <= after) throw new WorkflowRuntimeError('corrupt')
        after = row.id
        const pin = kind === 'runs' ? (row.project ? { ...row.project, revision: row.revision } : undefined) : row.project
        if (pin && pinSchema.safeParse(pin).success && this.matches(pinSchema.parse(pin))) rows.push(row)
      }
      examined += items.length
      if (examined > 10000) throw new WorkflowRuntimeError('limit')
      if (page.nextCursor === null) return rows
      if (!items.length || page.nextCursor !== after) throw new WorkflowRuntimeError('corrupt')
    } while (true)
  }
  private async packEvidence(value: unknown, includePrivate: boolean) {
    const { selection } = inspectEvidenceSelection(value)
    if (selection.runs.some(run => run.revision !== this.pin.revision)) throw new WorkflowRuntimeError('not-found')
    for (const run of selection.runs) await this.scopedRun(run.id)
    const packed = await createEvidenceZip({
      exportRun: async (id, privateData) => { await this.scopedRun(id); return this.owner.call({ operation: 'runs.export', id, includePrivate: privateData }) },
      testResult: async (runId, inspect) => { await this.scopedRun(runId); return this.owner.call({ operation: 'tests.result', runId, inspect }) },
    }, selection, includePrivate)
    return { selection, packed }
  }
  async operation(value: unknown) {
    const parsed = commandSchema.safeParse(value)
    if (!parsed.success) throw new WorkflowRuntimeError('invalid-command')
    const command = parsed.data
    if (command.operation === 'notifications.list') {
      const project = this.pin
      return inspectProjectNotificationPage(await this.owner.call({ operation: 'notifications.project-list', project, page: command.page }),
        project, command.page)
    }
    if (command.operation === 'project.export') {
      const options = { history: command.history === true, tests: command.tests === true }
      if (!command.evidence) return previewProjectZip(this.owner, this.pin, this.limits.source, options)
      const { packed } = await this.packEvidence(command.evidence.selection, command.evidence.includePrivate === true)
      if (packed.sha256 !== command.evidence.sha256) throw new WorkflowRuntimeError('conflict')
      return previewProjectZip(this.owner, this.pin, this.limits.source, options, { bytes: packed.bytes,
        sha256: command.evidence.sha256, includePrivate: command.evidence.includePrivate === true })
    }
    if (command.operation === 'release.list') {
      const now = Date.now()
      for (const [key, value] of this.releaseCursors) if (value.expiresAt <= now) this.releaseCursors.delete(key)
      const previous = command.cursor === undefined ? undefined : this.releaseCursors.get(command.cursor)
      if (command.cursor !== undefined && !previous) throw new WorkflowRuntimeError('invalid-command')
      if (this.releaseCursors.size >= 1024) throw new WorkflowRuntimeError('limit')
      const page = await listPreviewReleasePage(this.owner, this.pin, previous?.after, previous?.examined ?? 0)
      let nextCursor: string | null = null
      if (page.after !== null) {
        if (this.releaseCursors.size >= 1024) throw new WorkflowRuntimeError('limit')
        do { nextCursor = randomBytes(32).toString('hex') } while (this.releaseCursors.has(nextCursor))
        this.releaseCursors.set(nextCursor, { after: page.after, examined: page.examined, expiresAt: Date.now() + 15 * 60 * 1000 })
      }
      return { schemaVersion: 1, format: 'jevable.ai/preview-release-page', project: this.pin,
        releases: page.releases, nextCursor, execution: 'not-run' }
    }
    if (command.operation === 'release.create') return createPreviewRelease(this.owner, this.pin, command)
    if (command.operation === 'release.show') return (await readPreviewRelease(this.owner, this.pin, command.id)).receipt
    if (command.operation === 'release.export') {
      // Detach selection before yielding; SDK callers cannot retarget a pending export.
      const selected = command.evidence ? inspectEvidenceSelection(command.evidence.selection).selection : undefined
      const { release, artifact, receipt } = await readPreviewRelease(this.owner, this.pin, command.id)
      if (receipt.releaseSha256 !== command.releaseSha256) throw new WorkflowRuntimeError('conflict')
      if (!command.evidence) return previewReleaseZipEnvelope(receipt, createReleaseZip(release, artifact))
      const { packed } = await this.packEvidence(selected, command.evidence.includePrivate === true)
      if (packed.sha256 !== command.evidence.sha256) throw new WorkflowRuntimeError('conflict')
      const attached = await createReleaseZipWithEvidence(release, artifact, { bytes: packed.bytes,
        sha256: command.evidence.sha256, includePrivate: command.evidence.includePrivate === true })
      return previewReleaseZipEnvelope(receipt, attached.bytes, attached.evidence)
    }
    if (command.operation === 'evidence.bundle') {
      // Admit the complete selection before reading any private payload. Recheck scope on each capture.
      const { selection, packed } = await this.packEvidence(command.selection, command.includePrivate === true)
      // Base64 plus metadata must fit the browser's 20 MB response ceiling. Larger bundles use the CLI.
      if (packed.bytes.length > 12_000_000) throw new WorkflowRuntimeError('limit')
      return { schemaVersion: 1, format: 'jevable.ai/preview-evidence-zip', selection, selectionSha256: packed.manifest.selectionSha256,
        privacy: packed.manifest.privacy, bytes: packed.bytes.length, sha256: packed.sha256, base64: packed.bytes.toString('base64'),
        runs: packed.manifest.runs, execution: packed.manifest.execution, restoration: packed.manifest.restoration }
    }
    if (command.operation === 'tests.list') return { tests: await this.list('tests') }
    if (command.operation === 'tests.coverage-runs') {
      const rows = (await this.list('runs')).filter(row => row.test !== undefined).map(row => checked(z.object({
        id, test: testIdentitySchema, status: z.enum(['executing', 'paused', 'waiting', 'completed', 'failed', 'cancelled']),
        updatedAt: z.iso.datetime(),
      }), row))
      rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
      // Metadata only; never expose inputs, outputs, titles or another project's runs.
      return { project: this.pin, runs: rows.slice(0, 100), totalRuns: rows.length, execution: 'not-requested' }
    }
    if (command.operation === 'tests.coverage') {
      // Admit the entire detached selection before reading any test result. Historical
      // test pins come from admitted runs, never from the latest case or browser input.
      const entries: { runId: string; test: TestIdentity }[] = []
      for (const runId of command.runIds) {
        const run = await this.scopedRun(runId)
        if (run.test === undefined) throw new WorkflowRuntimeError('not-found')
        entries.push({ runId, test: checked(testIdentitySchema, run.test) })
      }
      const report = await testSuiteCoverage({ testResult: async runId => {
        const run = await this.scopedRun(runId), expected = entries.find(entry => entry.runId === runId)!.test
        const actual = checked(testIdentitySchema, run.test)
        if (actual.id !== expected.id || actual.generation !== expected.generation || actual.sha256 !== expected.sha256)
          throw new WorkflowRuntimeError('conflict')
        return this.owner.call({ operation: 'tests.result', runId, inspect: false })
      } }, { schemaVersion: 1, kind: 'JevableTestSuite', title: 'Selected retained preview tests',
        failurePolicy: 'continue', entries }, this.rendered.data.source, { limits: this.limits })
      return { ...report, project: this.pin }
    }
    if (command.operation === 'tests.show') return this.scopedCase(command.id, command.generation)
    if (command.operation === 'tests.history') {
      const current = await this.scopedCase(command.id)
      const record = checked(testRecordSchema, await this.owner.call({ operation: 'tests.history', id: command.id }))
      const latest = record.versions.at(-1)!
      if (record.id !== current.id || latest.generation !== current.generation || latest.sha256 !== current.sha256
        || !this.matches(latest.definition.project)) throw new WorkflowRuntimeError('corrupt')
      // History may contain older project pins. Only metadata for this exact admitted pin leaves the owner.
      // Private definitions remain separate explicit, generation-scoped tests.show reads.
      return { project: this.pin, test: { id: current.id, generation: current.generation, sha256: current.sha256 },
        versions: record.versions.filter(version => this.matches(version.definition.project)).map(version => ({
          generation: version.generation, operation: version.operation, status: version.status,
          archived: version.archived === true, sha256: version.sha256, at: version.at })), execution: 'not-run' }
    }
    if (command.operation === 'tests.generate') return this.owner.call({ operation: 'tests.generate', id: command.id, project: this.pin,
      ...triggerMetadata(command), ...(command.limit === undefined ? {} : { limit: command.limit }) })
    if (command.operation === 'tests.generation') {
      const batch = checked(z.looseObject({ snapshot: z.looseObject({ request: z.looseObject({ project: pinSchema }) }) }),
        await this.owner.call({ operation: 'tests.generation', id: command.id }))
      if (!this.matches(batch.snapshot.request.project)) throw new WorkflowRuntimeError('not-found')
      return batch
    }
    if (command.operation === 'tests.create' || command.operation === 'tests.edit') {
      if (command.operation === 'tests.edit') await this.scopedCase(command.id)
      const definition = { title: command.title, input: command.input, expectations: command.expectations, project: this.pin, ...triggerMetadata(command) }
      return this.owner.call({ operation: 'tests.command', command: command.operation === 'tests.create'
        ? { operation: 'create', id: command.id, definition }
        : { operation: 'edit', id: command.id, expectedGeneration: command.expectedGeneration, definition } })
    }
    if (command.operation === 'tests.accept' || command.operation === 'tests.archive') {
      await this.scopedCase(command.id)
      return this.owner.call({ operation: 'tests.command', command: { ...command,
        operation: command.operation === 'tests.accept' ? 'accept' : 'archive' } })
    }
    if (command.operation === 'tests.run') {
      await this.scopedCase(command.test.id, command.test.generation)
      return this.owner.call(command)
    }
    if (command.operation === 'tests.result') {
      await this.scopedRun(command.runId)
      return this.owner.call(command)
    }
    if (command.operation === 'view') {
      const trigger = this.graph.nodes[0]!.plan
      return { project: this.pin, preview: this.rendered.data,
      entry: { local: trigger.kind === 'trigger' && trigger.modes.some(mode => mode === 'manual' || mode === 'chat'),
        api: trigger.kind === 'trigger' && trigger.modes.includes('api') },
      ...(this.traceViewer ? { traceViewer: traceNavigationTools().config(this.traceViewer) } : {}),
      inputSchema: this.graph.input.definition,
      sample: generateInputs(this.graph.input, this.limits.binding.data, 1).candidates[0]?.input,
      readiness: await this.owner.call({ operation: 'check', yaml: this.rendered.data.source, ...triggerMetadata(command) }), execution: 'not-run',
      retention: 'project-and-runs-retained-after-session', visualReview: 'not-performed' }
    }
    if (command.operation === 'runs') return { runs: await this.list('runs') }
    if (command.operation === 'run') return this.owner.call({ operation: 'projects.run', id: this.pin.id,
      expectedGeneration: this.pin.generation, revision: this.pin.revision, input: command.input,
      runId: command.id, paused: command.paused ?? false, ...triggerMetadata(command) })
    const run = await this.scopedRun(command.id)
    if (command.operation === 'evidence') return this.owner.call({ ...command, operation: 'runs.export' })
    if (command.operation === 'show') return run
    if (command.operation === 'usage') {
      const query = { runId: run.id, revision: run.revision, ...(command.window ? { window: command.window } : {}), ...(command.groupBy ? { groupBy: command.groupBy } : {}) }
      const { selection } = inspectUsageSelection({ schemaVersion: 1, runs: [{ id: run.id, revision: run.revision }],
        ...(command.window ? { window: command.window } : {}), ...(command.groupBy ? { groupBy: command.groupBy } : {}) })
      const report = await this.owner.call({ operation: 'usage.report', selection })
      try { return await projectPreviewUsage(query, report) }
      catch { throw new WorkflowRuntimeError('corrupt') }
    }
    if (command.operation === 'inspect') return this.owner.call({ ...command, operation: 'runs.inspect' })
    if (command.operation === 'node.inspect') {
      if (run.checkpointSha256 !== command.expectedCheckpointSha256) throw new WorkflowRuntimeError('conflict')
      const envelope = checked(z.object({ schemaVersion: z.literal(1), privateInspection: z.literal(true), run: runSchema }),
        await this.owner.call({ operation: 'runs.inspect', id: command.id }))
      // Scope the actual private capture, not just the preceding metadata read.
      if (!envelope.run.project || !this.matches({ ...envelope.run.project, revision: envelope.run.revision }))
        throw new WorkflowRuntimeError('not-found')
      const { operation: _operation, ...request } = command
      return projectPreviewNodeInspection(this.rendered.data, envelope.run, request, this.limits.source)
    }
    if (command.operation === 'cancel') return this.owner.call({ ...command, operation: 'runs.cancel' })
    if (command.operation === 'advance') return this.owner.call({ ...command, operation: 'runs.advance' })
    if (command.operation === 'decide') return this.owner.call({ ...command, operation: 'approvals.decide' })
    if (run.status !== 'waiting') throw new WorkflowRuntimeError('conflict')
    const next = run.nodeId
    const scope = run.scope === undefined ? undefined : checked(loopScope, run.scope)
    const node = typeof next === 'string' ? findNode(this.graph, next as Parameters<typeof findNode>[1], scope) : undefined
    if (node?.plan.kind !== 'humanApproval') throw new WorkflowRuntimeError('corrupt')
    const review = checked(runSchema, await this.owner.call({ operation: 'approvals.show', id: command.id }))
    if (review.id !== run.id || review.attemptId !== run.attemptId) throw new WorkflowRuntimeError('conflict')
    if (review.status !== 'waiting') throw new WorkflowRuntimeError('conflict')
    checked(z.iso.datetime(), review.expiresAt)
    const deadlineStatus = checked(z.enum(['expired-at-observation', 'open-at-observation']), review.deadlineStatus)
    return { ...review, actions: node.plan.actions, timeoutOutcome: node.plan.onTimeout, deadlineStatus }
  }
}

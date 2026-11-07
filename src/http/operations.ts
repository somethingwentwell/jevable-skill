import { z } from 'zod'
import { projectCommandSchema } from '../projects/store.ts'
import type { RuntimeOperationTarget } from './operation-host.ts'
import { auditPage, auditPageSchema, recordPage, recordPageSchema } from './pagination.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { runReceipt } from '../runtime/receipts.ts'
import { validateSource } from '../validation.ts'
import { listTemplates, renderTemplate } from '../templates/index.ts'
import { compileWorkflow } from '../workflow/index.ts'
import { DEFAULT_COMPILER_LIMITS } from '../limits.ts'
import { testCommandSchema, testIdentitySchema } from '../testing/schema.ts'
import { generateTestsSchema } from '../testing/generation-schema.ts'
import { prepareTestErasureReview } from '../testing/erasure.ts'
import { testErasureCommandSchema } from '../testing/erasure-write.ts'
import { executionControlSchema } from '../runtime/control.ts'
import { releaseSnapshotSchema } from '../releases/snapshot.ts'
import { createUsageReport } from '../evidence/usage.ts'
import { createApprovalInbox } from '../runtime/approval-inbox.ts'
import { approvalNotificationPinSchema, notificationRequestSchema, notificationReceipt } from '../notifications/schema.ts'
import { reference } from '../providers/config.ts'
import { notificationPageRequestSchema } from '../notifications/history.ts'
import { notificationProjectScopeSchema } from '../notifications/project-history.ts'
import { automaticAdmissionPage } from '../notifications/automatic-admission.ts'
import { automaticDiagnostic, automaticDiagnosticPage } from '../notifications/automatic-diagnostics.ts'
import { apiTriggerModeSchema, triggerMetadata } from '../runtime/trigger.ts'
import { previewVendorImport, vendorImportCommandSchema } from '../projects/vendor-import.ts'
import { grantIssueSchema, grantRevokeSchema, grantPageSchema, grantIdSchema } from '../access/grants.ts'

const id = z.uuid(), generation = z.number().int().positive(), revision = z.string().regex(/^[a-f0-9]{64}$/u)
const projectIdentity = { id, expectedGeneration: generation, revision }
const schema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('grants.issue'), command: grantIssueSchema.omit({ actor: true }) }),
  z.strictObject({ operation: z.literal('grants.show'), id: grantIdSchema }),
  z.strictObject({ operation: z.literal('grants.list'), page: grantPageSchema }),
  z.strictObject({ operation: z.literal('grants.revoke'), command: grantRevokeSchema.omit({ actor: true }) }),
  z.strictObject({ operation: z.literal('validate'), yaml: z.string() }),
  z.strictObject({ operation: z.literal('check'), yaml: z.string(), triggerMode: apiTriggerModeSchema.optional() }),
  z.strictObject({ operation: z.literal('templates.list'), language: z.enum(['en', 'zh']).optional() }),
  z.strictObject({ operation: z.literal('templates.render'), id: z.string(), language: z.enum(['en', 'zh']).optional(),
    name: z.string().optional(), model: z.strictObject({ provider: z.string(), model: z.string() }).optional() }),
  z.strictObject({ operation: z.literal('import.preview'), source: z.string() }),
  z.strictObject({ operation: z.literal('projects.list') }),
  z.strictObject({ operation: z.literal('projects.show'), id }),
  z.strictObject({ operation: z.literal('projects.command'), command: z.record(z.string(), z.unknown()) }),
  z.strictObject({ operation: z.literal('projects.diff'), id, from: revision, to: revision }),
  z.strictObject({ operation: z.literal('projects.delete'), id, expectedGeneration: generation, confirmId: id }),
  z.strictObject({ operation: z.literal('projects.deletions'), page: recordPageSchema.optional() }),
  z.strictObject({ operation: z.literal('projects.export'), ...projectIdentity, history: z.boolean().optional(), tests: z.boolean().optional() }),
  z.strictObject({ operation: z.literal('projects.import.inspect'), json: z.string() }),
  z.strictObject({ operation: z.literal('projects.import'), json: z.string(), reviewedSha256: revision, newId: id.optional() }),
  z.strictObject({ operation: z.literal('projects.import.vendor'), command: vendorImportCommandSchema.omit({ actor: true }) }),
  z.strictObject({ operation: z.literal('projects.import.vendor.show'), id, inspect: z.boolean().optional() }),
  z.strictObject({ operation: z.literal('releases.list'), page: recordPageSchema.optional() }),
  z.strictObject({ operation: z.literal('releases.show'), id }),
  z.strictObject({ operation: z.literal('releases.create'), id, projectId: id, expectedGeneration: generation, revision,
    version: releaseSnapshotSchema.shape.version, runtimeStorage: z.enum(['sqlite', 'postgres']), runtime: releaseSnapshotSchema.shape.runtime,
    runtimeRateCoordinator: z.literal('postgres').optional(), notes: releaseSnapshotSchema.shape.notes }),
  z.strictObject({ operation: z.literal('runs.start'), id, yaml: z.string(), input: z.json(), paused: z.boolean().optional(), triggerMode: apiTriggerModeSchema.optional() }),
  z.strictObject({ operation: z.literal('projects.run'), ...projectIdentity, runId: id, input: z.json(), paused: z.boolean().optional(), triggerMode: apiTriggerModeSchema.optional() }),
  z.strictObject({ operation: z.literal('tests.list'), page: recordPageSchema.optional() }),
  generateTestsSchema.omit({ actor: true }).extend({ operation: z.literal('tests.generate'), limit: z.number().int().min(1).max(32).optional() }),
  z.strictObject({ operation: z.literal('tests.generations'), page: recordPageSchema.optional() }),
  z.strictObject({ operation: z.literal('tests.generation'), id }),
  z.strictObject({ operation: z.literal('tests.show'), id, generation: generation.optional() }),
  z.strictObject({ operation: z.literal('tests.history'), id }),
  z.strictObject({ operation: z.literal('tests.erasure-review'), id }),
  z.strictObject({ operation: z.literal('tests.erase'), request: testErasureCommandSchema.extend({ confirmId: id }) }),
  z.strictObject({ operation: z.literal('tests.erasure'), requestId: id }),
  z.strictObject({ operation: z.literal('tests.command'), command: z.record(z.string(), z.unknown()) }),
  z.strictObject({ operation: z.literal('tests.run'), test: testIdentitySchema, runId: id }),
  z.strictObject({ operation: z.literal('tests.result'), runId: id, inspect: z.boolean().optional() }),
  z.strictObject({ operation: z.literal('runs.list'), page: recordPageSchema.optional() }),
  z.strictObject({ operation: z.literal('runs.show'), id }),
  z.strictObject({ operation: z.literal('runs.inspect'), id }),
  z.strictObject({ operation: z.literal('runs.events'), id }),
  z.strictObject({ operation: z.literal('runs.export'), id, includePrivate: z.boolean().optional() }),
  z.strictObject({ operation: z.literal('usage.report'), selection: z.unknown() }),
  z.strictObject({ operation: z.literal('activity.report') }),
  z.strictObject({ operation: z.literal('runs.resume'), id }),
  executionControlSchema.extend({ operation: z.literal('runs.advance'), id }),
  z.strictObject({ operation: z.literal('runs.cancel'), id, requestId: id }),
  z.strictObject({ operation: z.literal('approvals.show'), id }),
  z.strictObject({ operation: z.literal('approvals.list'), page: recordPageSchema }),
  z.strictObject({ operation: z.literal('approvals.decide'), id, attemptId: id, action: z.string().min(1).max(128), pauseAfter: z.boolean().optional(), expireOnly: z.boolean().optional() }),
  z.strictObject({ operation: z.literal('notifications.destinations') }),
  z.strictObject({ operation: z.literal('notifications.automatic-status') }),
  z.strictObject({ operation: z.literal('notifications.automatic-show'), requestId: id }),
  z.strictObject({ operation: z.literal('notifications.automatic-list'), page: automaticAdmissionPage }),
  z.strictObject({ operation: z.literal('notifications.prepare'), pin: approvalNotificationPinSchema, endpointId: reference }),
  z.strictObject({ operation: z.literal('notifications.send'), request: notificationRequestSchema }),
  z.strictObject({ operation: z.literal('notifications.show'), requestId: id }),
  z.strictObject({ operation: z.literal('notifications.abort'), requestId: id }),
  z.strictObject({ operation: z.literal('notifications.list'), page: notificationPageRequestSchema }),
  z.strictObject({ operation: z.literal('notifications.project-list'), project: notificationProjectScopeSchema, page: notificationPageRequestSchema }),
  z.strictObject({ operation: z.literal('providers.list') }),
  z.strictObject({ operation: z.literal('providers.discover'), id: reference }),
  z.strictObject({ operation: z.literal('providers.audit'), page: auditPageSchema.optional() }),
  z.strictObject({ operation: z.literal('telemetry.status') }),
  z.strictObject({ operation: z.literal('telemetry.flush') }),
  z.strictObject({ operation: z.literal('telemetry.probe') }),
  z.strictObject({ operation: z.literal('providers.set'), connection: z.unknown(), expectedGeneration: z.number().int().nonnegative() }),
  z.strictObject({ operation: z.literal('credentials.status'), ref: z.string() }),
  z.strictObject({ operation: z.literal('credentials.set'), ref: z.string(), value: z.string(), expectedGeneration: z.number().int().nonnegative() }),
  z.strictObject({ operation: z.literal('credentials.clear'), ref: reference, expectedGeneration: z.number().int().positive() }),
])
export type RuntimeOperation = z.input<typeof schema>
export { schema as runtimeOperationSchema }

/** Single-owner adapter: actor is fixed by the host, not accepted from request bodies. */
export async function dispatchOperation(target: RuntimeOperationTarget, value: unknown, actor: string): Promise<unknown> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new WorkflowRuntimeError('invalid-command')
  const command = parsed.data
  const runtime = target.runtime
  // PostgreSQL SDK lists are bounded pages, never legacy complete arrays. Fail closed for old clients.
  if (target.storage === 'postgres' && ['runs.list', 'tests.list', 'tests.generations', 'projects.deletions', 'providers.audit', 'releases.list'].includes(command.operation)
    && (!('page' in command) || !command.page)) throw new WorkflowRuntimeError('invalid-command')
  switch (command.operation) {
    case 'grants.issue': return runtime.issueGrant({ ...command.command, actor })
    case 'grants.show': return runtime.grant(command.id)
    case 'grants.list': return runtime.grants(command.page)
    case 'grants.revoke': return runtime.revokeGrant({ ...command.command, actor })
    case 'validate': return validateSource(command.yaml)
    case 'check': return runtime.check(command.yaml, command.triggerMode)
    case 'templates.list': return { schemaVersion: 1, templates: listTemplates(command.language) }
    case 'templates.render': {
      const template = listTemplates(command.language).find(entry => entry.id === command.id)
      if (!template || (template.requiresModel && (!command.model?.provider || !command.model.model))) throw new WorkflowRuntimeError('invalid-command')
      const document = renderTemplate(command.id, { ...(command.language ? { language: command.language } : {}),
        ...(command.name === undefined ? {} : { name: command.name }), ...(command.model ? { model: command.model } : {}) })
      const compiled = compileWorkflow(document, DEFAULT_COMPILER_LIMITS)
      return { schemaVersion: 1, yaml: compiled.source.yaml, revision: compiled.source.revision, execution: 'not-run' }
    }
    case 'import.preview': return { ...previewVendorImport(command.source, DEFAULT_COMPILER_LIMITS.source), execution: 'not-run' }
    case 'projects.import.vendor': return runtime.createVendorImport({ ...command.command, actor })
    case 'projects.import.vendor.show': return runtime.vendorImport(command.id, command.inspect)
    case 'projects.list': return { schemaVersion: 1, projects: await runtime.projects() }
    case 'projects.show': return runtime.project(command.id)
    case 'projects.command': {
      if (Object.hasOwn(command.command, 'actor')) throw new WorkflowRuntimeError('invalid-command')
      const projectCommand = projectCommandSchema.safeParse({ ...command.command, actor })
      if (!projectCommand.success) throw new WorkflowRuntimeError('invalid-command')
      return runtime.editProject(projectCommand.data)
    }
    case 'projects.diff': return runtime.diffProject(command.id, command.from, command.to)
    case 'projects.delete': {
      if (command.confirmId !== command.id) throw new WorkflowRuntimeError('invalid-command')
      return runtime.deleteProject(command.id, command.expectedGeneration, actor)
    }
    case 'projects.deletions': {
      if (target.storage === 'postgres') return { schemaVersion: 2, ...await target.runtime.projectDeletions(command.page!.after, command.page!.limit) }
      const rows = await target.runtime.projectDeletions()
      if (!command.page) return { schemaVersion: 1, deletions: rows }
      const page = recordPage(rows, command.page.after, command.page.limit)
      return { schemaVersion: 2, deletions: page.items, nextCursor: page.nextCursor }
    }
    case 'projects.export': return runtime.exportProject(command.id, command.expectedGeneration, command.revision, command.history, command.tests)
    case 'projects.import.inspect': {
      const { bundle, sha256 } = await runtime.inspectProjectImport(command.json)
      return { schemaVersion: 1, status: 'review-required', sha256, bundle, readiness: await runtime.check(bundle.accepted.yaml), execution: 'not-run' }
    }
    case 'projects.import': return runtime.importProject(command.json, command.reviewedSha256, actor, command.newId)
    case 'releases.list': {
      if (target.storage === 'postgres') {
        const page = await target.runtime.releases(command.page!.after, command.page!.limit)
        return { schemaVersion: 2, releases: page.releases.map(({ snapshot: { workflow: _workflow, ...snapshot }, sha256 }) => ({ ...snapshot, sha256 })), nextCursor: page.nextCursor }
      }
      const releases = (await target.runtime.releases()).map(({ snapshot: { workflow: _workflow, ...snapshot }, sha256 }) => ({ ...snapshot, sha256 }))
      if (!command.page) return { releases }
      const page = recordPage(releases, command.page.after, command.page.limit)
      return { schemaVersion: 2, releases: page.items, nextCursor: page.nextCursor }
    }
    case 'releases.show': return runtime.release(command.id)
    case 'releases.create': {
      // Resolve installed, verified program bytes before mutation; client-supplied paths/code are never accepted.
      if (command.runtimeRateCoordinator && command.runtimeStorage !== 'sqlite') throw new WorkflowRuntimeError('invalid-command')
      const { loadReleaseRuntime, loadReleaseRuntimeProfile } = await import('../packages/release-zip.ts')
      const artifact = command.runtimeRateCoordinator ? await loadReleaseRuntimeProfile({ storage: 'sqlite', rateCoordinator: command.runtimeRateCoordinator })
        : await loadReleaseRuntime(command.runtimeStorage)
      if (artifact.identity.version !== command.runtime.version || artifact.identity.sha256 !== command.runtime.sha256) throw new WorkflowRuntimeError('conflict')
      return runtime.createRelease({ id: command.id, projectId: command.projectId, expectedGeneration: command.expectedGeneration,
        revision: command.revision, version: command.version, runtime: artifact.identity, actor,
        ...(command.notes === undefined ? {} : { notes: command.notes }) })
    }
    case 'runs.start': return runReceipt(await runtime.run(command.yaml, command.input, { id: command.id, paused: command.paused ?? false, ...triggerMetadata(command) }))
    case 'projects.run': return runReceipt(await runtime.runProject(command.id, command.expectedGeneration, command.revision, command.input, { id: command.runId, paused: command.paused ?? false, ...triggerMetadata(command) }))
    case 'tests.list': {
      if (target.storage === 'postgres') return { schemaVersion: 2, ...await target.runtime.testCases(command.page!.after, command.page!.limit) }
      const rows = await target.runtime.testCases()
      if (!command.page) return { schemaVersion: 1, tests: rows }
      const page = recordPage(rows, command.page.after, command.page.limit)
      return { schemaVersion: 2, tests: page.items, nextCursor: page.nextCursor }
    }
    case 'tests.generate': return runtime.generateTests({ id: command.id, project: command.project, actor,
      ...triggerMetadata(command), ...(command.limit === undefined ? {} : { limit: command.limit }) })
    case 'tests.generations': {
      if (target.storage === 'postgres') return { schemaVersion: 2, ...await target.runtime.testGenerations(command.page!.after, command.page!.limit) }
      const rows = await target.runtime.testGenerations()
      if (!command.page) return { schemaVersion: 1, generations: rows }
      const page = recordPage(rows, command.page.after, command.page.limit)
      return { schemaVersion: 2, generations: page.items, nextCursor: page.nextCursor }
    }
    case 'tests.generation': return runtime.testGeneration(command.id)
    case 'tests.show': return runtime.testCase(command.id, command.generation)
    case 'tests.history': return runtime.testHistory(command.id)
    case 'tests.erasure-review': return prepareTestErasureReview(await runtime.testHistory(command.id))
    case 'tests.erase': {
      const { confirmId, ...request } = command.request
      if (confirmId !== request.test.id) throw new WorkflowRuntimeError('invalid-command')
      return runtime.eraseTest({ ...request, actor })
    }
    case 'tests.erasure': return runtime.testErasure(command.requestId)
    case 'tests.command': {
      if (Object.hasOwn(command.command, 'actor')) throw new WorkflowRuntimeError('invalid-command')
      const change = testCommandSchema.safeParse({ ...command.command, actor })
      if (!change.success) throw new WorkflowRuntimeError('invalid-command')
      return runtime.editTest(change.data)
    }
    case 'tests.run': return runtime.runTest(command.test, command.runId)
    case 'tests.result': return runtime.testResult(command.runId, command.inspect)
    case 'runs.list': {
      if (target.storage === 'postgres') return { schemaVersion: 2, ...await target.runtime.list(command.page!.after, command.page!.limit) }
      if (!command.page) return { schemaVersion: 1, runs: await target.runtime.list() }
      return { schemaVersion: 2, ...await target.runtime.listPage(command.page.after, command.page.limit) }
    }
    case 'runs.show': return runReceipt(await runtime.show(command.id))
    case 'runs.inspect': return { schemaVersion: 1, privateInspection: true, run: await runtime.show(command.id) }
    case 'runs.export': return runtime.exportRun(command.id, command.includePrivate)
    case 'usage.report': return createUsageReport(runtime, command.selection)
    case 'activity.report': return runtime.activityReport()
    case 'runs.events': return target.storage === 'postgres'
      ? { schemaVersion: 2, runId: command.id, privatePayloads: 'excluded', sequenceEncoding: 'decimal-int64',
        events: (await target.runtime.events(command.id)).map(({ sequence, version, kind, at }) => ({ sequence, version, kind, at })) }
      : { schemaVersion: 1, runId: command.id, privatePayloads: 'excluded',
        events: (await target.runtime.events(command.id)).map(({ sequence, kind, at }) => ({ sequence, kind, at })) }
    case 'runs.resume': return runReceipt(await runtime.resume(command.id))
    case 'runs.advance': return runReceipt(await runtime.advance(command.id, { requestId: command.requestId,
      expectedCheckpointSha256: command.expectedCheckpointSha256, mode: command.mode,
      ...(command.breakpoints === undefined ? {} : { breakpoints: command.breakpoints }) }, actor))
    case 'runs.cancel': return runReceipt(await runtime.cancel(command.id, command.requestId, actor))
    case 'approvals.list': return createApprovalInbox({
      listRuns: async page => {
        if (target.storage === 'postgres') return target.runtime.list(page.after, page.limit)
        return target.runtime.listPage(page.after, page.limit)
      },
      showRun: id => runtime.show(id),
    }, command.page)
    case 'approvals.show': {
      const run = await runtime.show(command.id)
      if (run.state.status !== 'waiting') throw new WorkflowRuntimeError('conflict')
      return { ...runReceipt(run), review: run.state.attempt.prepared,
        deadlineStatus: Date.now() >= Date.parse(run.state.expiresAt) ? 'expired-at-observation' : 'open-at-observation' }
    }
    case 'approvals.decide': return runReceipt(await runtime.decide(command.id, command.attemptId, command.action, actor,
      { pauseAfter: command.pauseAfter ?? false, expireOnly: command.expireOnly ?? false }))
    case 'notifications.destinations':
      return { schemaVersion: 1, destinations: await target.runtime.notificationDestinations() }
    case 'notifications.automatic-status': return target.runtime.automaticApprovalNotificationStatus()
    case 'notifications.automatic-show': return automaticDiagnostic(await target.runtime.automaticApprovalAdmission(command.requestId))
    case 'notifications.automatic-list': return automaticDiagnosticPage({
      get: id => target.runtime.automaticApprovalAdmission(id), page: page => target.runtime.automaticApprovalAdmissions(page),
    }, command.page)
    case 'notifications.prepare':
      return target.runtime.prepareApprovalNotification(command.pin, command.endpointId)
    case 'notifications.send':
      return notificationReceipt(await target.runtime.sendApprovalNotification(command.request, actor))
    case 'notifications.show':
      return target.runtime.inspectApprovalNotification(command.requestId)
    case 'notifications.abort':
      return target.runtime.abortApprovalNotification(command.requestId)
    case 'notifications.list':
      return target.runtime.listApprovalNotifications(command.page)
    case 'notifications.project-list':
      return target.runtime.listProjectApprovalNotifications(command.project, command.page)
    case 'providers.list': return { schemaVersion: 1, connections: await runtime.connections() }
    case 'providers.discover': return runtime.discoverModels(command.id)
    case 'providers.audit': {
      if (target.storage === 'postgres') return { schemaVersion: 2, sequenceEncoding: 'decimal-int64',
        ...await target.runtime.providerAudit(command.page!.after, command.page!.limit) }
      const rows = await target.runtime.providerAudit()
      if (!command.page) return { schemaVersion: 1, events: rows }
      return { schemaVersion: 2, sequenceEncoding: 'safe-integer', ...auditPage(rows, command.page.after, command.page.limit) }
    }
    case 'telemetry.status': return runtime.telemetryStatus()
    case 'telemetry.flush': return runtime.telemetryFlush()
    case 'telemetry.probe': return runtime.telemetryProbe()
    case 'providers.set': return runtime.configureConnection(command.connection, command.expectedGeneration, actor)
    case 'credentials.status': return runtime.credentialStatus(command.ref)
    case 'credentials.set': return runtime.setCredential(command.ref, command.value, command.expectedGeneration, actor)
    case 'credentials.clear': return runtime.clearCredential(command.ref, command.expectedGeneration, actor)
  }
}

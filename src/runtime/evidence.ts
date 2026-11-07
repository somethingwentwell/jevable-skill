import { createHash } from 'node:crypto'
import { z } from 'zod'
import { runTrace, loopScope, type LocalRun, type JevableNodeInspection } from './run-types.ts'
import { WorkflowRuntimeError } from './errors.ts'
import { executionControlSchema } from './control.ts'
import type { ModelCallEvidence } from './model-evidence.ts'
import { recordedRoutesSchema } from './run-routes.ts'
import { breakpointHitSchema } from './control.ts'
import { breakpointMetadata } from './breakpoints.ts'
import { pauseMetadata } from './pause.ts'
import { USAGE_IDENTITY_FORMAT } from '../evidence/usage-identity.ts'
import { apiTriggerModeSchema, triggerMetadata } from './trigger.ts'
import { runTraceSegment } from './run-trace.ts'

export const RUN_EVIDENCE_LIMITS = Object.freeze({ events: 50000, journalBytes: 64_000_000, artifactBytes: 16_000_000, snapshotAttempts: 3 })
type Event = { sequence: number; kind: string; at: string; data: unknown }
const eventHeader = z.object({ sequence: z.number().int().positive(), at: z.iso.datetime(),
  kind: z.enum(['run-created', 'execution-segment', 'node-intent', 'node-trace', 'node-result', 'approval-requested',
    'approval-decided', 'loop-timeout', 'cancellation-requested', 'run-cancelled', 'execution-requested', 'breakpoint-hit']) })
const nodeId = z.string().min(1), uuid = z.uuid()
const correlations = z.object({ nodeId: nodeId.optional(), attemptId: uuid.nullable().optional(), scope: loopScope.nullable().optional(),
  trace: runTrace.optional(), status: z.enum(['paused', 'waiting', 'executing', 'completed', 'failed']).optional() })
const inspectionMetadata = (inspection?: JevableNodeInspection) => ({
  ...(inspection?.attemptId ? { attemptId: inspection.attemptId } : {}),
  ...(inspection?.trace ? { trace: inspection.trace } : {}),
  ...(inspection?.startedAt ? { startedAt: inspection.startedAt } : {}),
  ...(inspection?.durationMs === undefined ? {} : { durationMs: inspection.durationMs }),
  ...(inspection?.modelUsage ? { modelUsage: inspection.modelUsage } : {}),
})
function journalMetadata(event: Event) {
  const header = eventHeader.parse(event), ordinary = correlations.parse(event.data)
  if (event.kind === 'run-created') return { ...header, ...ordinary,
    ...triggerMetadata(z.object({ triggerMode: apiTriggerModeSchema.optional() }).parse(event.data)) }
  if (event.kind === 'breakpoint-hit') return { ...header, ...breakpointHitSchema.parse(event.data) }
  if (event.kind === 'execution-requested') {
    const data = executionControlSchema.strip().parse(event.data)
    return { ...header, ...data }
  }
  if (event.kind === 'node-intent') {
    const data = z.object({ attempt: z.object({ id: uuid, nodeId, trace: runTrace.optional() }), scope: loopScope.nullable().optional() }).parse(event.data)
    return { ...header, nodeId: data.attempt.nodeId, attemptId: data.attempt.id, scope: data.scope, trace: data.attempt.trace }
  }
  if (event.kind === 'approval-decided') {
    const data = z.object({ decision: z.object({ kind: z.enum(['action', 'expired']), at: z.iso.datetime() }), routes: recordedRoutesSchema.optional(),
      segment: runTraceSegment.optional() }).parse(event.data)
    const segment = data.segment
    return { ...header, ...ordinary, decision: data.decision, ...(data.routes === undefined ? {} : { routes: data.routes }),
      ...(segment ? { operation: segment.operation, trace: segment.trace, ...(segment.previous ? { previous: segment.previous } : {}),
        ...(segment.parent ? { parent: segment.parent } : {}) } : {}) } // No actor or review payload; trace context is execution metadata.
  }
  if (event.kind === 'node-result') {
    const data = z.object({ routes: recordedRoutesSchema.optional() }).parse(event.data)
    return { ...header, ...ordinary, ...(data.routes === undefined ? {} : { routes: data.routes }) }
  }
  if (event.kind === 'cancellation-requested') {
    const data = z.object({ id: uuid, traceParent: runTrace.optional() }).parse(event.data)
    return { ...header, requestId: data.id, ...(data.traceParent ? { traceParent: data.traceParent } : {}) }
  }
  if (event.kind === 'run-cancelled') {
    const data = z.object({ requestId: uuid, previousStatus: z.enum(['paused', 'waiting', 'executing']), next: nodeId,
      attemptId: uuid.nullable(), checkpointSha256: z.string().regex(/^[a-f0-9]{64}$/u) }).parse(event.data)
    return { ...header, ...data }
  }
  if (event.kind === 'execution-segment') {
    const { at: _at, ...data } = runTraceSegment.parse(event.data)
    return { ...header, ...data }
  }
  return { ...header, ...ordinary }
}

/** Stable scoped ordinals from committed intents; provider tries are a separate sequence. */
function nodeAttemptMetadata(journal: ReturnType<typeof journalMetadata>[]) {
  const counts = new Map<string, number>(), ids = new Set<string>()
  const entries = journal.filter(event => event.kind === 'node-intent').map(event => {
    const intent = z.object({ nodeId, attemptId: uuid, scope: loopScope.nullable().optional() }).parse(event)
    const identity = intent.attemptId.toLowerCase()
    if (ids.has(identity)) throw new WorkflowRuntimeError('corrupt')
    ids.add(identity)
    const scope = intent.scope ?? undefined
    const key = JSON.stringify([intent.nodeId, scope?.loop ?? null, scope?.index ?? null])
    const number = (counts.get(key) ?? 0) + 1
    counts.set(key, number)
    return { attemptId: intent.attemptId, nodeId: intent.nodeId, ...(scope ? { scope } : {}), number }
  })
  return { format: 'jevable.node-attempts/v1' as const, source: 'retained-intents' as const,
    numbering: 'per-node-and-loop-scope' as const, entries }
}

/** Export a checked immutable observation, never execute/replay it or infer collector delivery. */
export function createRunEvidence(run: LocalRun, events: Event[], includePrivate: boolean, modelCalls?: ModelCallEvidence[], usageIdentities = false) {
  if (events.length > RUN_EVIDENCE_LIMITS.events) throw new WorkflowRuntimeError('limit')
  let journal: ReturnType<typeof journalMetadata>[]
  try {
    journal = events.map(journalMetadata)
    if (journal.some((entry, index) => index > 0 && entry.sequence <= journal[index - 1]!.sequence)) throw Error('unordered')
  } catch { throw new WorkflowRuntimeError('corrupt') }
  const state = run.state
  const snapshot = {
    schemaVersion: 1, format: 'jevable.ai/run-evidence' as const,
    run: { id: run.id, revision: run.revision, status: state.status, createdAt: run.createdAt, updatedAt: run.updatedAt, ...triggerMetadata(run),
      ...breakpointMetadata(run),
      ...pauseMetadata(run),
      ...(run.startedPaused ? { startedPaused: true } : {}),
      ...(run.project ? { project: run.project } : {}), ...(run.release ? { release: run.release } : {}), ...(run.test ? { test: run.test } : {}),
      ...('next' in state ? { next: state.next } : {}), ...('scope' in state && state.scope ? { scope: state.scope } : {}),
      ...(state.status === 'failed' ? { nodeId: state.nodeId, code: state.code, failedAttempt: inspectionMetadata(state.inspection) } : {}),
      ...(state.status === 'cancelled' ? { previousStatus: state.previousStatus, externalEffects: 'not-reverted; unsettled attempts may have unknown outcomes' } : {}),
      ...('attempt' in state ? { attempt: { id: state.attempt.id, nodeId: state.attempt.nodeId,
        ...(state.attempt.trace ? { trace: state.attempt.trace } : {}) } } : {}),
      ...('expiresAt' in state ? { expiresAt: state.expiresAt } : {}),
      ...(run.cancellation ? { cancellation: { id: run.cancellation.id, at: run.cancellation.at,
        ...(run.cancellation.traceParent ? { traceParent: run.cancellation.traceParent } : {}) } } : {}),
      ...(run.traceSegments ? { traceSegments: run.traceSegments, telemetryDelivery: 'not-guaranteed' } : {}) },
    steps: state.steps.map((step, index) => ({ index, nodeId: step.nodeId, ...(step.port === undefined ? {} : { port: step.port }),
      ...(step.scope ? { scope: step.scope } : {}), ...inspectionMetadata(step.inspection) })),
    journal,
    nodeAttempts: nodeAttemptMetadata(journal),
    ...(modelCalls ? { models: { format: 'jevable.model-history/v1' as const, source: 'configured-model-store' as const,
      ...(usageIdentities ? { usageIdentities: USAGE_IDENTITY_FORMAT } : {}),
      calls: modelCalls, semantics: 'intent-is-not-dispatch; settlement-is-not-workflow-completion; missing-is-not-proof-of-no-call' as const } } : {}),
    boundary: { eventCount: journal.length, firstSequence: journal[0]?.sequence ?? null, lastSequence: journal.at(-1)?.sequence ?? null,
      consistency: 'same-retained-run-snapshot', terminal: ['completed', 'failed', 'cancelled'].includes(state.status) },
    verification: { checkpoint: 'validated-against-workflow', settledModels: 'checked-by-configured-adapter',
      authenticity: 'local-retained-evidence; not-signed-or-independent-proof', execution: 'not-started-or-resumed-by-export' },
    privacy: { payloads: includePrivate ? 'included' : 'excluded', actors: includePrivate ? 'included' : 'excluded',
      ...(usageIdentities ? { modelIdentities: 'included-by-explicit-usage-request' as const } : {}),
      credentialStore: 'excluded', identifiers: 'retained; review-before-sharing' },
    ...(includePrivate ? { private: { run, journal: events } } : {}),
  }
  const encoded = JSON.stringify(snapshot)
  if (Buffer.byteLength(encoded) > RUN_EVIDENCE_LIMITS.artifactBytes - 1024) throw new WorkflowRuntimeError('limit')
  return { schemaVersion: 1, snapshot, checksum: { algorithm: 'sha256', encoding: 'JSON.stringify(snapshot)',
    value: createHash('sha256').update(encoded).digest('hex') } }
}
export type RunEvidence = ReturnType<typeof createRunEvidence>

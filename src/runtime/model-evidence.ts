import { z } from 'zod'
import type { CompiledWorkflow } from '../workflow/index.ts'
import { modelEvidenceSchema, type ModelEvidence } from '../providers/records.ts'
import { verifyEvidenceRequest } from '../providers/evidence-request.ts'
import { nodeAttempt, loopScope, runTrace, type JevableRunTrace } from './run-types.ts'
import { findNode } from './run-evaluator.ts'
import { modelInput, modelRequestPlan } from './model-plan.ts'
import { usageIdentitySchema } from '../evidence/usage-identity.ts'
import { WorkflowRuntimeError } from './errors.ts'

const intent = z.object({ attempt: nodeAttempt, scope: loopScope.nullable().optional() })
/** Select only this run's model intents in journal order, including loop iterations and unsettled attempts. */
export function modelEvidenceTargets(graph: CompiledWorkflow, events: readonly { kind: string; data: unknown }[]) {
  const ids = new Set<string>()
  const nodeTraces = new Map<string, JevableRunTrace>()
  for (const event of events) {
    if (event.kind !== 'node-trace') continue
    const parsed = z.object({ attemptId: z.uuid(), trace: runTrace }).safeParse(event.data)
    if (!parsed.success || nodeTraces.has(parsed.data.attemptId)) throw new WorkflowRuntimeError('corrupt')
    nodeTraces.set(parsed.data.attemptId, parsed.data.trace)
  }
  return events.filter(event => event.kind === 'node-intent').flatMap(event => {
    const parsed = intent.safeParse(event.data)
    if (!parsed.success) throw new WorkflowRuntimeError('corrupt')
    const { attempt, scope } = parsed.data, node = findNode(graph, attempt.nodeId, scope ?? undefined)
    if (!node) throw new WorkflowRuntimeError('corrupt')
    if (node.plan.kind !== 'llm' && node.plan.kind !== 'decision') return []
    if (ids.has(attempt.id)) throw new WorkflowRuntimeError('corrupt')
    ids.add(attempt.id)
    const nodeTrace = nodeTraces.get(attempt.id) ?? attempt.trace
    if (attempt.trace && nodeTrace && (attempt.trace.traceId !== nodeTrace.traceId || attempt.trace.spanId !== nodeTrace.spanId
      || attempt.trace.traceFlags !== nodeTrace.traceFlags)) throw new WorkflowRuntimeError('corrupt')
    return [{ attempt, ...(scope ? { scope } : {}), plan: node.plan, ...(nodeTrace ? { nodeTrace } : {}) }]
  })
}
type Target = ReturnType<typeof modelEvidenceTargets>[number]

/** Separate model-record read budget; never retain private records in the public projection. */
export class ModelEvidenceProjection {
  private bytes = 0
  readonly calls: ModelCallEvidence[] = []
  constructor(private readonly byteLimit = 64_000_000, private readonly usageIdentities = false) {}
  add(target: Target, record: ModelEvidence | undefined) {
    if (record) {
      this.bytes += Buffer.byteLength(JSON.stringify(record))
      if (this.bytes > this.byteLimit) throw new WorkflowRuntimeError('limit')
    }
    this.calls.push(projectModelEvidence(target, record, this.usageIdentities))
  }
}

function projectModelEvidence(target: Target, value: ModelEvidence | undefined, usageIdentities: boolean) {
  const identity = { nodeId: target.attempt.nodeId, attemptId: target.attempt.id, ...(target.scope ? { scope: target.scope } : {}) }
  if (!value) return { ...identity, evidence: 'not-recorded' as const }
  const parsed = modelEvidenceSchema.safeParse(value)
  if (!parsed.success || parsed.data.attemptId !== target.attempt.id || target.attempt.prepared.status !== 'ready') throw new WorkflowRuntimeError('corrupt')
  const record = parsed.data
  if (record.trace && target.nodeTrace && (record.trace.traceId !== target.nodeTrace.traceId
    || record.trace.traceFlags !== target.nodeTrace.traceFlags || record.trace.spanId === target.nodeTrace.spanId)) throw new WorkflowRuntimeError('corrupt')
  try { verifyEvidenceRequest(target.plan, modelInput(target.plan, target.attempt.prepared.input), record) }
  catch { throw new WorkflowRuntimeError('corrupt') }
  const result = record.result
  const plan = usageIdentities ? modelRequestPlan(target.plan) : undefined
  // Fields are selected explicitly. Only the usage opt-in exposes requested provider/model identities;
  // request bodies, credential/endpoint routes, outputs and provider response IDs never escape.
  return { ...identity, evidence: 'recorded' as const, evidenceSchemaVersion: record.schemaVersion, intentAt: record.at,
    ...(record.trace ? { trace: record.trace } : {}),
    ...(plan ? { usageIdentity: usageIdentitySchema.parse({ provider: record.route.connection.provider, model: plan.model }) } : {}),
    status: result.status, ...(result.status === 'pending' ? {} : { settledAt: result.at }),
    ...(result.status === 'failed' ? { code: result.code } : {}),
    ...(result.status === 'completed' ? { usage: result.usage } : {}),
    ...(record.schemaVersion === 2 ? { policy: record.policy, tries: record.tries.map(attempt => ({
      id: attempt.id, number: attempt.number, intentAt: attempt.at, status: attempt.result.status,
      ...(attempt.trace ? { trace: attempt.trace } : {}),
      ...(attempt.result.status === 'pending' ? {} : { settledAt: attempt.result.at }),
      ...(attempt.result.status === 'failed' ? { code: attempt.result.code,
        ...(attempt.result.httpStatus === undefined ? {} : { httpStatus: attempt.result.httpStatus }),
        ...(attempt.result.retryDelayMs === undefined ? {} : { scheduledDelayMs: attempt.result.retryDelayMs }) } : {}),
    })) } : {}),
  }
}
export type ModelCallEvidence = ReturnType<typeof projectModelEvidence>

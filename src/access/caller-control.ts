import { z } from 'zod'
import { isDeepStrictEqual as same } from 'node:util'
import { grantIdSchema, grantMetadataSchema, type GrantMetadata } from './grants.ts'
import type { GrantActionAdmission, GrantActionTarget } from './actions.ts'
import { callerControlBindingSchema } from './caller-control-binding.ts'
import { callerRunReceipt, callerRunReceiptSchema } from './caller.ts'
import { executionControlSchema } from '../runtime/control.ts'
import { executionCheckpointHash, type LocalRun } from '../runtime/run-types.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'

import { callerControlRequestSchema, type CallerControlRequest } from './caller-control-request.ts'
export { callerControlRequestSchema, type CallerControlRequest } from './caller-control-request.ts'
export const callerControlEvidenceSchema = callerControlRequestSchema.extend({
  actor: z.string().min(1).max(256), at: z.iso.datetime(), delegation: callerControlBindingSchema,
}).refine(value => value.actor === `grant:${value.delegation.grantId}`
  && Date.parse(value.at) < Date.parse(value.delegation.deadline))
export type CallerControlEvidence = z.infer<typeof callerControlEvidenceSchema>
export const callerControlCheckpointSchema = callerRunReceiptSchema.safeExtend({
  checkpointSha256: executionControlSchema.shape.expectedCheckpointSha256,
})
export type CallerControlCheckpoint = z.infer<typeof callerControlCheckpointSchema>
export const callerControlReceiptSchema = callerControlCheckpointSchema.safeExtend({ requestId: grantIdSchema,
  mode: executionControlSchema.shape.mode, requestedAt: z.iso.datetime(),
}).refine(value => Date.parse(value.requestedAt) >= Date.parse(value.createdAt)
  && Date.parse(value.requestedAt) <= Date.parse(value.updatedAt))
export type CallerControlReceipt = z.infer<typeof callerControlReceiptSchema>
const corrupt = () => new WorkflowRuntimeError('corrupt')
const conflict = () => new WorkflowRuntimeError('conflict')

/** Verified retained target. Caller requests cannot supply ownership or release pins. */
export function callerControlTarget(record: LocalRun): GrantActionTarget {
  if (!record.caller || !record.release) throw new WorkflowRuntimeError('not-found')
  return { kind: 'run', runId: record.id, revision: record.revision,
    release: { ...record.release, revision: record.revision }, callerGrantId: record.caller.grantId,
    cancelled: record.cancellation !== undefined || record.state.status === 'cancelled' }
}

/** Exact checkpoint admission only. Recovery still requires verified retained model evidence before writing. */
export function assertCallerControlCheckpoint(record: LocalRun, request: CallerControlRequest) {
  if (['pause', 'recover'].includes(request.mode) && request.breakpoints !== undefined)
    throw new WorkflowRuntimeError('invalid-command')
  const legal = request.mode === 'pause' ? ['paused', 'executing'].includes(record.state.status)
    : request.mode === 'recover' ? record.state.status === 'executing' : record.state.status === 'paused'
  if (!legal || record.cancellation || executionCheckpointHash(record) !== request.expectedCheckpointSha256) throw conflict()
  if ((record.controlRequests?.length ?? 0) >= 10000) throw new WorkflowRuntimeError('limit')
}

/** Run only after fresh writer authorization; this pure projection grants no future execution permission. */
export function prepareCallerControl(record: LocalRun, value: CallerControlRequest, admission: GrantActionAdmission) {
  const parsed = callerControlRequestSchema.safeParse(value)
  if (!parsed.success) throw new WorkflowRuntimeError('invalid-command')
  const request = parsed.data
  if (admission.action.kind !== 'control' || admission.action.runId !== record.id || admission.scope.kind !== 'caller'
    || admission.grantId !== record.caller?.grantId || !same(admission.scope, record.caller.scope)) throw corrupt()
  if (record.controlRequests?.some(item => item.requestId === request.requestId)) throw conflict()
  assertCallerControlCheckpoint(record, request)
  if (Date.parse(admission.admittedAt) < Math.max(Date.parse(record.createdAt), Date.parse(record.updatedAt))) throw conflict()
  const control = callerControlEvidenceSchema.parse({ ...request, actor: admission.actor, at: admission.admittedAt,
    delegation: { grantId: admission.grantId, scope: admission.scope, deadline: admission.expiresAt } })
  return { record: { ...record, updatedAt: control.at, controlRequests: [...record.controlRequests ?? [], control] } as LocalRun, control }
}

/** Metadata only. Control permission does not disclose output, source, input, steps, scope or actors. */
export function callerControlCheckpoint(record: LocalRun): CallerControlCheckpoint {
  return { ...callerRunReceipt(record), checkpointSha256: executionCheckpointHash(record) }
}
export function callerControlReceipt(record: LocalRun, requestId: string): CallerControlReceipt {
  const control = callerControlEvidenceSchema.safeParse(record.controlRequests?.find(item => item.requestId === requestId))
  if (!control.success || control.data.delegation.grantId !== record.caller?.grantId
    || !same(control.data.delegation.scope, record.caller.scope)) throw corrupt()
  return { ...callerControlCheckpoint(record), requestId: control.data.requestId, mode: control.data.mode, requestedAt: control.data.at }
}
/** Fresh scoped authentication must precede observation; never resume, recover, pause or replay here. */
export function callerControlRetry(record: LocalRun, value: CallerControlRequest) {
  const parsed = callerControlRequestSchema.safeParse(value)
  if (!parsed.success) throw new WorkflowRuntimeError('invalid-command')
  const saved = record.controlRequests?.find(item => item.requestId === parsed.data.requestId)
  if (!saved) return undefined
  const evidence = callerControlEvidenceSchema.safeParse(saved)
  if (!evidence.success) throw conflict() // An owner request cannot be adopted by a caller.
  const { actor: _actor, at: _at, delegation: _delegation, ...command } = evidence.data
  if (!same(command, parsed.data)) throw conflict()
  return callerControlReceipt(record, parsed.data.requestId)
}

type Event = { kind: string; data: unknown }
function delegated(event: Event) {
  if (event.kind !== 'execution-requested' || event.data === null || typeof event.data !== 'object'
    || !Object.hasOwn(event.data, 'delegation')) return undefined
  const parsed = callerControlEvidenceSchema.safeParse(event.data)
  if (!parsed.success) throw corrupt()
  return parsed.data
}
/** Exact action UUID must bind the PostgreSQL atomic admission batch on both write and replay. */
export function verifyCallerControlBatchIdentity(kind: string, data: unknown, batchId: string) {
  const control = delegated({ kind, data })
  if (control && control.requestId !== grantIdSchema.safeParse(batchId).data) throw corrupt()
  return control
}
/** Historical consistency only, not current authority or approval to replay admitted work. */
export function verifyCallerControls(record: LocalRun, events: readonly Event[], metadata?: GrantMetadata) {
  const controls = events.flatMap(event => { const value = delegated(event); return value ? [value] : [] })
  const retained = (record.controlRequests ?? []).flatMap(data => { const value = delegated({ kind: 'execution-requested', data }); return value ? [value] : [] })
  if (!same(controls, retained)) throw corrupt()
  if (!controls.length) return
  const grant = grantMetadataSchema.safeParse(metadata)
  if (!grant.success) throw corrupt()
  for (const control of controls) {
    const binding = control.delegation, at = Date.parse(control.at)
    if (binding.grantId !== record.caller?.grantId || binding.grantId !== grant.data.id
      || !same(binding.scope, record.caller.scope) || !same(binding.scope, grant.data.scope)
      || binding.deadline !== grant.data.expiresAt || at < Date.parse(record.createdAt) || at > Date.parse(record.updatedAt)
      || at < Date.parse(grant.data.issuedAt) || at >= Date.parse(grant.data.expiresAt)
      || grant.data.revocation && at > Date.parse(grant.data.revocation.at)) throw corrupt()
  }
}

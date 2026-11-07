import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { reference } from '../providers/config.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { approvalDecision, localRunSchema, runTrace, loopScope, type LocalRun } from '../runtime/run-types.ts'

const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const approvalIdentity = z.strictObject({ runId: z.uuid(), revision: hash, attemptId: z.uuid() })
export const approvalNotificationKind = z.enum(['requested', 'decided', 'expired', 'cancelled'])
export const approvalNotificationPinSchema = approvalIdentity.extend({ eventKind: approvalNotificationKind.optional() })
export type ApprovalNotificationPin = z.infer<typeof approvalNotificationPinSchema>
export const notificationEndpointSchema = z.strictObject({ id: reference,
  url: z.string().max(2048).refine(value => {
    try {
      const u = new URL(value)
      return !u.username && !u.password && !u.search && !u.hash && !/[\s\\]/u.test(value)
        && (u.protocol === 'https:' || u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
    } catch { return false }
  }), credentialRef: reference, timeoutMs: z.number().int().min(100).max(30000) })
export type NotificationEndpoint = z.infer<typeof notificationEndpointSchema>
export const approvalNotificationEventSchema = z.strictObject({ specversion: z.literal('1.0'),
  id: hash, source: z.literal('urn:jevable:workflow-runtime'), type: z.enum(['ai.jevable.approval.requested',
    'ai.jevable.approval.decided', 'ai.jevable.approval.expired', 'ai.jevable.approval.cancelled']),
  time: z.iso.datetime(), datacontenttype: z.literal('application/json'),
  data: approvalIdentity.extend({ nodeId: z.string().min(1).max(4096), expiresAt: z.iso.datetime(),
    scope: loopScope.optional(), loopExpiresAt: z.iso.datetime().optional(),
    release: z.strictObject({ id: z.uuid(), sha256: hash }).optional(),
    project: z.strictObject({ id: z.uuid(), generation: z.number().int().positive() }).optional() })
    .refine(data => (data.scope === undefined) === (data.loopExpiresAt === undefined)),
})
export type ApprovalNotificationEvent = z.infer<typeof approvalNotificationEventSchema>
export const notificationRequestSchema = approvalNotificationPinSchema.extend({ requestId: z.uuid(), endpointId: reference,
  endpointSha256: hash, eventSha256: hash, redeliverOf: z.uuid().optional() })
export type NotificationRequest = z.infer<typeof notificationRequestSchema>
export function notificationRequestPin({ runId, revision, attemptId, eventKind }: ApprovalNotificationPin): ApprovalNotificationPin {
  return { runId, revision, attemptId, ...(eventKind === undefined ? {} : { eventKind }) }
}
export const notificationResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('accepted'), httpStatus: z.number().int().min(200).max(299) }),
  z.strictObject({ status: z.literal('rejected'), httpStatus: z.number().int().min(300).max(599) }),
  z.strictObject({ status: z.literal('uncertain'), reason: z.enum(['transport', 'timeout', 'aborted', 'invalid-response']) }),
])
export type NotificationResult = z.infer<typeof notificationResultSchema>
export const notificationTelemetrySchema = z.strictObject({ trace: runTrace, workflow: runTrace.optional(), previous: runTrace.optional(), parent: runTrace.optional() })
export type NotificationTelemetry = z.infer<typeof notificationTelemetrySchema>
export const notificationRecordSchema = z.strictObject({ schemaVersion: z.literal(1), request: notificationRequestSchema,
  event: approvalNotificationEventSchema, actor: z.string().min(1).max(256), createdAt: z.iso.datetime(),
  credentialGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), telemetry: notificationTelemetrySchema.optional(),
  outcome: z.discriminatedUnion('status', [z.strictObject({ status: z.literal('pending') }),
    z.strictObject({ status: z.literal('settled'), at: z.iso.datetime(), result: notificationResultSchema })]),
})
export type NotificationRecord = z.infer<typeof notificationRecordSchema>
export const notificationSemantics = 'pending-is-not-proof-of-dispatch; HTTP-acceptance-is-not-human-delivery-or-approval' as const
export const notificationReceiptSchema = notificationRecordSchema.omit({ actor: true }).extend({ semantics: z.literal(notificationSemantics) })
export function notificationReceipt(value: NotificationRecord) {
  const { actor: _actor, ...metadata } = inspectNotificationRecord(value)
  return { ...metadata, semantics: notificationSemantics }
}
export const notificationAbortSemantics = 'process-local-signal; inspect-retained-send-outcome; no-effect-retraction' as const
export const notificationAbortResultSchema = z.strictObject({ schemaVersion: z.literal(1), requestId: z.uuid(),
  status: z.enum(['abort-requested', 'not-active']), receipt: notificationReceiptSchema,
  semantics: z.literal(notificationAbortSemantics) }).refine(value => value.requestId === value.receipt.request.requestId)
export type NotificationAbortResult = z.infer<typeof notificationAbortResultSchema>
export const notificationSha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** The host must supply a verified core read and its journal; this projection never exposes review payloads. */
export function requestedApprovalNotification(value: LocalRun, events: readonly { kind: string; at: string; data: unknown }[], pinValue: ApprovalNotificationPin) {
  const pin = approvalNotificationPinSchema.safeParse(pinValue), parsed = localRunSchema.safeParse(value)
  if (!pin.success) throw new WorkflowRuntimeError('invalid-command')
  if (pin.data.eventKind !== undefined && pin.data.eventKind !== 'requested') throw new WorkflowRuntimeError('invalid-command')
  if (!parsed.success) throw new WorkflowRuntimeError('corrupt')
  const run = parsed.data, state = run.state
  if (run.id !== pin.data.runId || run.revision !== pin.data.revision || state.status !== 'waiting'
    || state.attempt.id !== pin.data.attemptId || run.cancellation) throw new WorkflowRuntimeError('conflict')
  const matches = events.filter(event => event.kind === 'approval-requested'
    && typeof event.data === 'object' && event.data !== null && 'attemptId' in event.data && event.data.attemptId === state.attempt.id)
  if (matches.length !== 1 || !z.iso.datetime().safeParse(matches[0]!.at).success) throw new WorkflowRuntimeError('corrupt')
  const requested = matches[0]!, fields = requested.data as { nodeId?: unknown; status?: unknown; expiresAt?: unknown; scope?: unknown }
  if (fields.nodeId !== state.next || fields.status !== 'waiting' || state.attempt.nodeId !== state.next
    || fields.expiresAt !== undefined && fields.expiresAt !== state.expiresAt
    || !isDeepStrictEqual(fields.scope ?? undefined, state.scope)
    || Date.parse(requested.at) > Date.parse(run.updatedAt) || Date.parse(requested.at) >= Date.parse(state.expiresAt)) throw new WorkflowRuntimeError('corrupt')
  const data = { runId: pin.data.runId, revision: pin.data.revision, attemptId: pin.data.attemptId, nodeId: state.next, expiresAt: state.expiresAt,
    ...scopedApprovalMetadata(run, state.scope),
    ...(run.release ? { release: run.release } : {}), ...(run.project ? { project: run.project } : {}) }
  const identity = { source: 'urn:jevable:workflow-runtime' as const, type: 'ai.jevable.approval.requested' as const,
    time: matches[0]!.at, data }
  return approvalNotificationEventSchema.parse({ specversion: '1.0', id: notificationSha256(identity),
    ...identity, datacontenttype: 'application/json' })
}

type ApprovalJournal = readonly { kind: string; at: string; data: unknown }[]
const fields = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {}

function scopedApprovalMetadata(run: LocalRun, scopeValue: unknown) {
  if (scopeValue == null) return {}
  const parsed = loopScope.safeParse(scopeValue)
  if (!parsed.success) throw new WorkflowRuntimeError('corrupt')
  const deadline = run.loopDeadlines[parsed.data.loop]
  if (!Number.isSafeInteger(deadline) || deadline! < 0 || deadline! > 8.64e15) throw new WorkflowRuntimeError('corrupt')
  return { scope: parsed.data, loopExpiresAt: new Date(deadline!).toISOString() }
}

/** Recorded lifecycle only: no clock-driven expiry, approval decision, cancellation or workflow continuation. */
export function approvalLifecycleNotification(value: LocalRun, events: ApprovalJournal, pinValue: ApprovalNotificationPin): ApprovalNotificationEvent {
  const pin = approvalNotificationPinSchema.safeParse(pinValue), parsed = localRunSchema.safeParse(value)
  if (!pin.success) throw new WorkflowRuntimeError('invalid-command')
  if (!parsed.success) throw new WorkflowRuntimeError('corrupt')
  const kind = pin.data.eventKind ?? 'requested'
  if (kind === 'requested') return requestedApprovalNotification(parsed.data, events, pin.data)
  const run = parsed.data, { runId, revision, attemptId } = pin.data
  if (run.id !== runId || run.revision !== revision) throw new WorkflowRuntimeError('conflict')
  const waits = events.filter(event => event.kind === 'approval-requested' && fields(event.data).attemptId === attemptId)
  if (!waits.length) throw new WorkflowRuntimeError('conflict')
  if (waits.length !== 1) throw new WorkflowRuntimeError('corrupt')
  const wait = waits[0]!, requested = fields(wait.data)
  // Old journals remain readable. Their missing historical deadline cannot be invented for a newly prepared lifecycle event.
  if (requested.expiresAt === undefined) throw new WorkflowRuntimeError('invalid-command')
  const expiresAt = z.iso.datetime().safeParse(requested.expiresAt), nodeId = z.string().min(1).max(4096).safeParse(requested.nodeId)
  if (!expiresAt.success || !nodeId.success || requested.status !== 'waiting' || !z.iso.datetime().safeParse(wait.at).success
    || Date.parse(wait.at) >= Date.parse(expiresAt.data) || Date.parse(wait.at) > Date.parse(run.updatedAt)) throw new WorkflowRuntimeError('corrupt')
  const intents = events.filter(event => event.kind === 'node-intent' && fields(fields(event.data).attempt).id === attemptId)
  if (intents.length !== 1 || fields(fields(intents[0]!.data).attempt).nodeId !== nodeId.data
    || !isDeepStrictEqual(fields(intents[0]!.data).scope ?? undefined, requested.scope ?? undefined)
    || !z.iso.datetime().safeParse(intents[0]!.at).success || Date.parse(intents[0]!.at) > Date.parse(wait.at)) throw new WorkflowRuntimeError('corrupt')
  const decisions = events.filter(event => event.kind === 'approval-decided' && fields(event.data).attemptId === attemptId)
  let time: string
  if (kind === 'cancelled') {
    if (decisions.length) throw new WorkflowRuntimeError('conflict')
    if (run.state.status !== 'cancelled' || run.state.previousStatus !== 'waiting' || run.state.attempt.id !== attemptId
      || run.state.next !== nodeId.data || run.state.expiresAt !== expiresAt.data || !run.cancellation) throw new WorkflowRuntimeError('conflict')
    if (!isDeepStrictEqual(run.state.scope, requested.scope ?? undefined)) throw new WorkflowRuntimeError('corrupt')
    const stopped = events.filter(event => event.kind === 'run-cancelled' && fields(event.data).attemptId === attemptId)
    if (stopped.length !== 1 || fields(stopped[0]!.data).previousStatus !== 'waiting'
      || fields(stopped[0]!.data).next !== nodeId.data || fields(stopped[0]!.data).requestId !== run.cancellation.id)
      throw new WorkflowRuntimeError('corrupt')
    time = stopped[0]!.at
    if (Date.parse(run.cancellation.at) > Date.parse(time)) throw new WorkflowRuntimeError('corrupt')
  } else {
    if (!decisions.length) throw new WorkflowRuntimeError('conflict')
    if (decisions.length !== 1) throw new WorkflowRuntimeError('corrupt')
    const event = decisions[0]!, data = fields(event.data), decision = approvalDecision.safeParse(data.decision)
    if (!decision.success || data.nodeId !== nodeId.data || decision.data.at !== event.at
      || !isDeepStrictEqual(data.scope ?? undefined, requested.scope ?? undefined)) throw new WorkflowRuntimeError('corrupt')
    if (decision.data.kind !== (kind === 'expired' ? 'expired' : 'action')) throw new WorkflowRuntimeError('conflict')
    time = event.at
    if (kind === 'expired' ? Date.parse(time) < Date.parse(expiresAt.data) : Date.parse(time) >= Date.parse(expiresAt.data))
      throw new WorkflowRuntimeError('corrupt')
    if (run.state.status === 'waiting' && run.state.attempt.id === attemptId) throw new WorkflowRuntimeError('corrupt')
  }
  if (!z.iso.datetime().safeParse(time).success || Date.parse(time) < Date.parse(wait.at) || Date.parse(time) > Date.parse(run.updatedAt))
    throw new WorkflowRuntimeError('corrupt')
  const data = { runId, revision, attemptId, nodeId: nodeId.data, expiresAt: expiresAt.data,
    ...scopedApprovalMetadata(run, requested.scope),
    ...(run.release ? { release: run.release } : {}), ...(run.project ? { project: run.project } : {}) }
  const identity = { source: 'urn:jevable:workflow-runtime' as const, type: `ai.jevable.approval.${kind}` as const, time, data }
  return approvalNotificationEventSchema.parse({ specversion: '1.0', id: notificationSha256(identity), ...identity, datacontenttype: 'application/json' })
}

/** Only a requested event is a live-wait delivery; settled lifecycle events have no send-time approval deadline. */
export function notificationRequiresLiveWait(event: ApprovalNotificationEvent) { return event.type === 'ai.jevable.approval.requested' }
/** A loop wait cannot admit a new notification after either persisted deadline, even before settlement. */
export function notificationWaitExpired(event: ApprovalNotificationEvent, at = Date.now()) {
  return at >= Math.min(Date.parse(event.data.expiresAt), event.data.loopExpiresAt === undefined ? Infinity : Date.parse(event.data.loopExpiresAt))
}

/** Associate retained delivery evidence with verified historical run evidence, even after a wait has settled.
 * Legacy journals lack expiresAt: their receipt retains the observed deadline, not an independent historical proof of it.
 */
export function verifyNotificationHistory(record: NotificationRecord, run: LocalRun,
  events: readonly { kind: string; at: string; data: unknown }[]) {
  if (record.telemetry?.workflow && !run.traceSegments?.some(segment => isDeepStrictEqual(segment.trace, record.telemetry!.workflow)))
    throw new WorkflowRuntimeError('corrupt')
  verifyApprovalEventHistory(record.event, record.createdAt, run, events, notificationRequestPin(record.request))
}

/** Thin retained lifecycle evidence, shared by delivery receipts and automatic admission. Never expires or sends. */
export function verifyApprovalEventHistory(notification: ApprovalNotificationEvent, createdAt: string, run: LocalRun,
  events: readonly { kind: string; at: string; data: unknown }[],
  pin: ApprovalNotificationPin = { runId: notification.data.runId, revision: notification.data.revision,
    attemptId: notification.data.attemptId, eventKind: approvalNotificationKind.parse(notification.type.slice('ai.jevable.approval.'.length)) }) {
  const { data, time } = notification
  if (run.id !== data.runId || run.revision !== data.revision
    || !isDeepStrictEqual(run.project, data.project) || !isDeepStrictEqual(run.release, data.release))
    throw new WorkflowRuntimeError('corrupt')
  if (!notificationRequiresLiveWait(notification)) {
    try {
      const expected = approvalLifecycleNotification(run, events, pin)
      if (!isDeepStrictEqual(expected, notification) || Date.parse(time) > Date.parse(createdAt)) throw new WorkflowRuntimeError('corrupt')
    } catch { throw new WorkflowRuntimeError('corrupt') }
    return
  }
  const matches = events.filter(event => event.kind === 'approval-requested' && event.data !== null && typeof event.data === 'object'
    && 'attemptId' in event.data && event.data.attemptId === data.attemptId)
  const event = matches[0], fields = event?.data as { nodeId?: unknown; status?: unknown; expiresAt?: unknown; scope?: unknown } | undefined
  if (matches.length !== 1 || event?.at !== time || fields?.nodeId !== data.nodeId || fields.status !== 'waiting'
    || fields.expiresAt !== undefined && fields.expiresAt !== data.expiresAt
    || !isDeepStrictEqual(scopedApprovalMetadata(run, fields.scope), { ...(data.scope ? { scope: data.scope, loopExpiresAt: data.loopExpiresAt } : {}) })
    || Date.parse(time) > Date.parse(createdAt) || notificationWaitExpired(notification, Date.parse(createdAt)))
    throw new WorkflowRuntimeError('corrupt')
  const intents = events.filter(event => event.kind === 'node-intent' && event.data !== null && typeof event.data === 'object'
    && 'attempt' in event.data && event.data.attempt !== null && typeof event.data.attempt === 'object'
    && 'id' in event.data.attempt && event.data.attempt.id === data.attemptId)
  const attempt = (intents[0]?.data as { attempt?: { nodeId?: unknown } } | undefined)?.attempt
  if (intents.length !== 1 || attempt?.nodeId !== data.nodeId || !z.iso.datetime().safeParse(intents[0]!.at).success
    || !isDeepStrictEqual((intents[0]!.data as { scope?: unknown }).scope ?? undefined, data.scope)
    || Date.parse(intents[0]!.at) > Date.parse(time))
    throw new WorkflowRuntimeError('corrupt')
  if (run.state.status === 'waiting' && run.state.attempt.id === data.attemptId && run.state.expiresAt !== data.expiresAt)
    throw new WorkflowRuntimeError('corrupt')
}

/** Validate stored bytes and all cross-field pins before inspecting or reusing a delivery receipt. */
export function inspectNotificationRecord(value: unknown): NotificationRecord {
  let encoded: string
  try { encoded = JSON.stringify(value) } catch { throw new WorkflowRuntimeError('corrupt') }
  if (!encoded || Buffer.byteLength(encoded) > 65536) throw new WorkflowRuntimeError('corrupt')
  const parsed = notificationRecordSchema.safeParse(JSON.parse(encoded))
  if (!parsed.success) throw new WorkflowRuntimeError('corrupt')
  const record = parsed.data, { event, request } = record
  const { source, type, time, data } = event
  if (event.id !== notificationSha256({ source, type, time, data }) || notificationSha256(event) !== request.eventSha256
    || data.runId !== request.runId || data.revision !== request.revision || data.attemptId !== request.attemptId
    || type !== `ai.jevable.approval.${request.eventKind ?? 'requested'}` || Date.parse(time) > Date.parse(record.createdAt)
    || request.redeliverOf === request.requestId
    || record.outcome.status === 'settled' && Date.parse(record.outcome.at) < Date.parse(record.createdAt)) throw new WorkflowRuntimeError('corrupt')
  return record
}

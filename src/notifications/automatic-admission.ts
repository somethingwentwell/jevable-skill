import { isDeepStrictEqual as same } from 'node:util'
import { z } from 'zod'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { reference } from '../providers/config.ts'
import { approvalNotificationEventSchema, inspectNotificationRecord, notificationRequestSchema,
  notificationSha256, type ApprovalNotificationEvent, type NotificationRequest, type NotificationRecord } from './schema.ts'
import { parseAutomaticApprovalPolicy, planAutomaticApprovalNotifications, type AutomaticApprovalPolicy } from './automatic-policy.ts'

const hash = z.string().regex(/^[a-f0-9]{64}$/u)
export const automaticAdmissionLimits = z.strictObject({
  maxAdmissions: z.number().int().min(1).max(100000), maxEvents: z.number().int().min(2).max(200000),
})
export type AutomaticAdmissionLimits = z.infer<typeof automaticAdmissionLimits>
export const automaticAdmissionPage = z.strictObject({ after: z.uuid().optional(), limit: z.number().int().min(1).max(200).default(100) })
export type AutomaticAdmissionPage = z.input<typeof automaticAdmissionPage>
export const automaticFailureCode = z.enum(['busy', 'conflict', 'closed', 'invalid-command', 'not-found', 'limit', 'corrupt', 'uncertain'])
export type AutomaticFailureCode = z.infer<typeof automaticFailureCode>
const destinations = z.array(z.strictObject({ id: reference, endpointSha256: hash })).max(32)
  .refine(values => new Set(values.map(value => value.id)).size === values.length)
const outcome = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('reserved') }),
  z.strictObject({ status: z.literal('failed'), at: z.iso.datetime(), code: automaticFailureCode }),
  z.strictObject({ status: z.literal('delivery-recorded'), at: z.iso.datetime(), deliverySha256: hash,
    deliveryStatus: z.enum(['pending', 'settled']) }),
])
const admission = z.strictObject({ format: z.literal('jevable.ai/automatic-approval-admission/v1'),
  policy: z.unknown(), policySha256: hash, destinations,
  request: notificationRequestSchema, event: approvalNotificationEventSchema, createdAt: z.iso.datetime(), outcome })
export type AutomaticAdmissionRecord = Omit<z.infer<typeof admission>, 'policy'> & { policy: AutomaticApprovalPolicy }
export const automaticAdmissionSemantics = 'reservation-is-not-dispatch-authority; failures-may-follow-external-effects; never-replay-on-read-or-restart' as const
const corrupt = () => new WorkflowRuntimeError('corrupt')

/** Validate serialized, private-value-free provenance and the exact deterministic request. No delivery or credentials. */
export function inspectAutomaticAdmission(value: unknown): AutomaticAdmissionRecord {
  let encoded: string | undefined
  try { encoded = JSON.stringify(value) } catch { throw corrupt() }
  if (!encoded || Buffer.byteLength(encoded) > 65536) throw corrupt()
  const parsed = admission.safeParse(JSON.parse(encoded))
  if (!parsed.success) throw corrupt()
  const record = parsed.data
  try {
    const policy = parseAutomaticApprovalPolicy(record.policy)
    if (!same(policy, record.policy) || notificationSha256(policy) !== record.policySha256
      || record.request.eventKind === undefined || record.request.redeliverOf !== undefined
      || Date.parse(record.createdAt) < Date.parse(record.event.time)
      || record.outcome.status !== 'reserved' && Date.parse(record.outcome.at) < Date.parse(record.createdAt)) throw corrupt()
    const plan = planAutomaticApprovalNotifications(policy, record.event, record.destinations)
    if (!plan.requests.some(request => same(request, record.request))) throw corrupt()
    return { ...record, policy }
  } catch { throw corrupt() }
}

/** Source-only producer. A reservation is not permission to send; the owner must separately validate journal history. */
export function prepareAutomaticAdmission(policyValue: unknown, event: ApprovalNotificationEvent, destinationsValue: unknown,
  request: NotificationRequest, createdAt: string, failure?: AutomaticFailureCode): AutomaticAdmissionRecord {
  const policy = parseAutomaticApprovalPolicy(policyValue)
  return inspectAutomaticAdmission({ format: 'jevable.ai/automatic-approval-admission/v1', policy,
    policySha256: notificationSha256(policy), destinations: destinationsValue, request, event, createdAt,
    outcome: failure === undefined ? { status: 'reserved' } : { status: 'failed', at: createdAt, code: failure } })
}

export function sameAutomaticAdmissionIdentity(a: AutomaticAdmissionRecord, b: AutomaticAdmissionRecord) {
  const { outcome: _left, ...left } = a, { outcome: _right, ...right } = b
  return same(left, right)
}
export function validateAutomaticAdmissionCreation(value: unknown, previousValue?: unknown) {
  const record = inspectAutomaticAdmission(value)
  if (record.outcome.status === 'delivery-recorded') throw new WorkflowRuntimeError('conflict')
  if (previousValue === undefined) return { record, changed: true }
  const previous = inspectAutomaticAdmission(previousValue)
  if (!sameAutomaticAdmissionIdentity(previous, record)) throw new WorkflowRuntimeError('conflict')
  return { record: previous, changed: false }
}
export function validateAutomaticAdmissionSettlement(previousValue: unknown, value: unknown) {
  const previous = inspectAutomaticAdmission(previousValue), record = inspectAutomaticAdmission(value)
  if (!sameAutomaticAdmissionIdentity(previous, record) || record.outcome.status === 'reserved'
    || previous.outcome.status !== 'reserved' && !same(previous.outcome, record.outcome)) throw new WorkflowRuntimeError('conflict')
  return { record, changed: previous.outcome.status === 'reserved' }
}

/** Join actual retained dispatcher evidence; HTTP success is not human delivery or approval. */
export function verifyAutomaticAdmissionDelivery(record: AutomaticAdmissionRecord, value: unknown) {
  if (record.outcome.status !== 'delivery-recorded') return
  const delivery = inspectNotificationRecord(value)
  if (!same(delivery.request, record.request) || !same(delivery.event, record.event)
    || delivery.actor !== `automatic:${record.policySha256}` || notificationSha256(delivery) !== record.outcome.deliverySha256
    || delivery.outcome.status !== record.outcome.deliveryStatus || Date.parse(delivery.createdAt) < Date.parse(record.createdAt)
    || Date.parse(record.outcome.at) < Date.parse(delivery.createdAt)
    || delivery.outcome.status === 'settled' && Date.parse(record.outcome.at) < Date.parse(delivery.outcome.at)) throw corrupt()
}
export function automaticDeliveryRecorded(recordValue: unknown, deliveryValue: NotificationRecord, at: string) {
  const record = inspectAutomaticAdmission(recordValue), delivery = inspectNotificationRecord(deliveryValue)
  const next = inspectAutomaticAdmission({ ...record, outcome: { status: 'delivery-recorded', at,
    deliveryStatus: delivery.outcome.status, deliverySha256: notificationSha256(delivery) } })
  verifyAutomaticAdmissionDelivery(next, delivery)
  return validateAutomaticAdmissionSettlement(record, next).record
}
export function automaticAdmissionFailed(recordValue: unknown, code: AutomaticFailureCode, at: string) {
  const record = inspectAutomaticAdmission(recordValue)
  return validateAutomaticAdmissionSettlement(record, { ...record, outcome: { status: 'failed', at, code } }).record
}
export function parseAutomaticAdmissionPage(value: AutomaticAdmissionPage) {
  const parsed = automaticAdmissionPage.safeParse(value)
  if (!parsed.success) throw new WorkflowRuntimeError('invalid-command')
  return parsed.data
}

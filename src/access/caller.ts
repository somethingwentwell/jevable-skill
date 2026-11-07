import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import type { LocalRun } from '../runtime/run-types.ts'
import { grantIdSchema, grantMetadataSchema, grantScopeSchema, type GrantMetadata } from './grants.ts'
import type { GrantActionAdmission } from './actions.ts'
import { callerControlRequestSchema } from './caller-control-request.ts'

const callerScope = grantScopeSchema.options[0]
/** Private immutable creation evidence. Never accepted from a caller's start options. */
export const callerBindingSchema = z.strictObject({ grantId: grantIdSchema, actor: z.string(), at: z.iso.datetime(), scope: callerScope })
  .refine(value => value.actor === `grant:${value.grantId}` && value.scope.permissions.includes('start'))
export type CallerBinding = z.infer<typeof callerBindingSchema>
export const callerStartOptionsSchema = z.strictObject({ id: grantIdSchema, paused: z.boolean().optional(), triggerMode: z.literal('api').optional() })
export type CallerStartOptions = z.input<typeof callerStartOptionsSchema>
export const callerReleasePinSchema = callerScope.shape.release
export type CallerReleasePin = z.infer<typeof callerReleasePinSchema>
export const callerStartRequestSchema = z.strictObject({ input: z.json(), options: callerStartOptionsSchema })
export type CallerStartRequest = z.input<typeof callerStartRequestSchema>
export const callerCancellationRequestSchema = z.strictObject({ requestId: grantIdSchema })
export type CallerCancellationRequest = z.input<typeof callerCancellationRequestSchema>
export const callerOperationSchema = z.discriminatedUnion('operation', [
  callerStartRequestSchema.extend({ operation: z.literal('start'), release: callerReleasePinSchema }),
  z.strictObject({ operation: z.literal('read'), release: callerReleasePinSchema, id: grantIdSchema }),
  z.strictObject({ operation: z.literal('cancel'), release: callerReleasePinSchema, id: grantIdSchema, request: callerCancellationRequestSchema }),
  z.strictObject({ operation: z.literal('checkpoint'), release: callerReleasePinSchema, id: grantIdSchema }),
  z.strictObject({ operation: z.literal('control'), release: callerReleasePinSchema, id: grantIdSchema, request: callerControlRequestSchema }),
])
export type CallerOperation = z.infer<typeof callerOperationSchema>
/** Trusted host hook, after exact permission/ownership authentication, never HTTP input or authority. */
export type CallerContext<Result> = (release: CallerReleasePin, operation: () => Promise<Result>) => Promise<Result>
export const callerRunReceiptSchema = z.strictObject({ schemaVersion: z.literal(1), id: grantIdSchema,
  revision: callerReleasePinSchema.shape.revision,
  release: z.strictObject({ id: grantIdSchema, sha256: callerReleasePinSchema.shape.sha256 }),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  status: z.enum(['paused', 'waiting', 'executing', 'completed', 'failed', 'cancelled']),
}).refine(value => Date.parse(value.updatedAt) >= Date.parse(value.createdAt))
export const callerRunResultSchema = callerRunReceiptSchema.safeExtend({ output: z.json().optional() })
  .refine(value => (value.status === 'completed') === Object.hasOwn(value, 'output'))

export function callerBinding(admission: GrantActionAdmission): CallerBinding {
  if (admission.action.kind !== 'start' || admission.scope.kind !== 'caller') throw new WorkflowRuntimeError('corrupt')
  return callerBindingSchema.parse({ grantId: admission.grantId, actor: admission.actor, at: admission.admittedAt, scope: admission.scope })
}

/** Historical consistency, not current authorization. Revocation/expiry never erase admitted provenance. */
export function verifyCallerBinding(run: LocalRun, metadata?: GrantMetadata) {
  if (!run.caller) return
  const parsed = callerBindingSchema.safeParse(run.caller), grant = grantMetadataSchema.safeParse(metadata)
  if (!parsed.success || !grant.success) throw new WorkflowRuntimeError('corrupt')
  const binding = parsed.data, record = grant.data, pin = binding.scope.release, at = Date.parse(binding.at)
  if (record.id !== binding.grantId || !isDeepStrictEqual(record.scope, binding.scope)
    || run.createdAt !== binding.at || run.project || run.test || run.revision !== pin.revision
    || run.release?.id !== pin.id || run.release.sha256 !== pin.sha256
    || at < Date.parse(record.issuedAt) || at >= Date.parse(record.expiresAt)
    || record.revocation && at > Date.parse(record.revocation.at)) throw new WorkflowRuntimeError('corrupt')
}

export interface CallerRunReceipt {
  schemaVersion: 1
  id: string
  revision: string
  release: { id: string; sha256: string }
  createdAt: string
  updatedAt: string
  status: LocalRun['state']['status']
}
export type CallerRunResult = CallerRunReceipt & { output?: Extract<LocalRun['state'], { status: 'completed' }>['output'] }
/** Explicit projection: no YAML, input, steps, actors, history, provider details or authority. */
export function callerRunReceipt(run: LocalRun): CallerRunReceipt {
  if (!run.caller || !run.release) throw new WorkflowRuntimeError('corrupt')
  return { schemaVersion: 1, id: run.id, revision: run.revision, release: { ...run.release },
    createdAt: run.createdAt, updatedAt: run.updatedAt, status: run.state.status }
}
export function callerRunResult(run: LocalRun): CallerRunResult {
  return { ...callerRunReceipt(run), ...(run.state.status === 'completed' ? { output: structuredClone(run.state.output) } : {}) }
}

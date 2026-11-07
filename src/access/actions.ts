import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { grantIdSchema, grantPrincipal, type GrantRecord, type GrantScope } from './grants.ts'
import { observeGrantPolicy, type GrantPolicyObserver } from './policy-observation.ts'
import { approvalActionSchema } from '../workflow/approval-action.ts'

const sha = z.string().regex(/^(?!0{64}$)[a-f0-9]{64}$/u)
const release = z.strictObject({ id: grantIdSchema, sha256: sha, revision: sha })
/** Only exact delegated actions. Never accept an owner operation, arbitrary source, or a client actor. */
export const grantActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('start'), release }),
  z.strictObject({ kind: z.literal('read'), runId: grantIdSchema }),
  z.strictObject({ kind: z.literal('control'), runId: grantIdSchema }),
  z.strictObject({ kind: z.literal('cancel'), runId: grantIdSchema }),
  z.strictObject({ kind: z.literal('decision'), runId: grantIdSchema, attemptId: grantIdSchema, decision: approvalActionSchema }),
])
export type GrantAction = z.infer<typeof grantActionSchema>

/** Internal projection of a VERIFIED retained target, never request-supplied ownership or state. */
export const grantActionTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('release'), release }),
  z.strictObject({ kind: z.literal('run'), runId: grantIdSchema, revision: sha, release: release.optional(),
    callerGrantId: grantIdSchema.optional(), cancelled: z.boolean(),
    wait: z.strictObject({ attemptId: grantIdSchema, expiresAt: z.iso.datetime(), loopExpiresAt: z.iso.datetime().optional() }).optional() }),
])
export type GrantActionTarget = z.infer<typeof grantActionTargetSchema>
export interface GrantActionAdmission {
  grantId: string
  actor: string
  action: GrantAction
  scope: GrantScope
  issuedAt: string
  admittedAt: string
  expiresAt: string
}
const deny = () => new WorkflowRuntimeError('not-found')
export function parseGrantAction(value: unknown): GrantAction {
  const parsed = grantActionSchema.safeParse(value)
  if (!parsed.success) throw new WorkflowRuntimeError('invalid-command')
  return parsed.data
}

/** A pure policy decision, not permission to execute later. Reapply at the storage admission point. */
export function admitGrantAction(record: GrantRecord, proof: { id: string; tokenSha256: string }, action: GrantAction,
  targetValue: GrantActionTarget, at = new Date().toISOString(), observer?: GrantPolicyObserver): GrantActionAdmission {
  return observeGrantPolicy(action, observer, () => evaluateGrantAction(record, proof, action, targetValue, at))
}

function evaluateGrantAction(record: GrantRecord, proof: { id: string; tokenSha256: string }, action: GrantAction,
  targetValue: GrantActionTarget, at: string): GrantActionAdmission {
  const principal = grantPrincipal(record, proof, at)
  if (!principal) throw deny()
  const parsed = grantActionTargetSchema.safeParse(targetValue)
  if (!parsed.success) throw new WorkflowRuntimeError('corrupt')
  const target = parsed.data, scope = principal.scope
  if (scope.kind === 'caller') {
    if (action.kind === 'decision' || !scope.permissions.includes(action.kind)) throw deny()
    if (action.kind === 'start') {
      if (target.kind !== 'release' || !isDeepStrictEqual(action.release, scope.release)
        || !isDeepStrictEqual(target.release, scope.release)) throw deny()
    } else if (target.kind !== 'run' || target.runId !== action.runId || target.revision !== scope.release.revision
      || !isDeepStrictEqual(target.release, scope.release) || target.callerGrantId !== principal.grantId) throw deny()
  } else {
    if (action.kind !== 'decision' || target.kind !== 'run' || target.cancelled
      || action.runId !== scope.runId || target.runId !== scope.runId || target.revision !== scope.revision
      || action.attemptId !== scope.attemptId || target.wait?.attemptId !== scope.attemptId
      || !scope.decisions.includes(action.decision) || Date.parse(at) >= Date.parse(target.wait.expiresAt)
      || target.wait.loopExpiresAt !== undefined && Date.parse(at) >= Date.parse(target.wait.loopExpiresAt)) throw deny()
  }
  const wait = action.kind === 'decision' && target.kind === 'run' ? target.wait : undefined
  const expiresAt = [record.expiresAt, ...(wait ? [wait.expiresAt, ...(wait.loopExpiresAt ? [wait.loopExpiresAt] : [])] : [])]
    .reduce((a, b) => Date.parse(a) < Date.parse(b) ? a : b)
  return structuredClone({ grantId: principal.grantId, actor: principal.actor, action, scope,
    issuedAt: record.issuedAt, admittedAt: at, expiresAt })
}

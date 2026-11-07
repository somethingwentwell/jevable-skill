import { z } from 'zod'
import type { NodeId } from '../workflow/index.ts'
import { callerControlBindingSchema } from '../access/caller-control-binding.ts'

export const breakpointListSchema = z.array(z.string().min(1).max(128)).max(128)
  .refine(nodes => new Set(nodes).size === nodes.length)
const nodeId = z.string().min(1).max(128).transform(value => value as NodeId)
export const breakpointHitSchema = z.strictObject({ configurationRequestId: z.uuid(),
  checkpointSha256: z.string().regex(/^[a-f0-9]{64}$/u), nodeId,
  scope: z.strictObject({ loop: nodeId, index: z.number().int().nonnegative() }).optional(),
  stepCount: z.number().int().nonnegative(), at: z.iso.datetime() })

export const executionControlSchema = z.strictObject({
  requestId: z.uuid(), expectedCheckpointSha256: z.string().regex(/^[a-f0-9]{64}$/u), mode: z.enum(['step', 'continue', 'pause', 'recover']),
  breakpoints: breakpointListSchema.optional(),
})
export const savedExecutionControlSchema = executionControlSchema.extend({
  actor: z.string().trim().min(1).max(256), at: z.iso.datetime(), delegation: callerControlBindingSchema.optional(),
}).refine(value => value.delegation === undefined || value.actor === `grant:${value.delegation.grantId}`
  && Date.parse(value.at) < Date.parse(value.delegation.deadline))
export type ExecutionControl = z.infer<typeof executionControlSchema>
export interface RunStartOptions { id?: string; paused?: boolean; triggerMode?: 'api' }

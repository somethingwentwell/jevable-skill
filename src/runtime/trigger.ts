import { z } from 'zod'
import { WorkflowRuntimeError } from './errors.ts'

/** Omission retains the historical manual/chat entry contract. API is always explicit. */
export const apiTriggerModeSchema = z.literal('api')
export type ApiTriggerMode = z.infer<typeof apiTriggerModeSchema>
export function parseTriggerMode(value: unknown): ApiTriggerMode | undefined {
  if (value === undefined) return undefined
  const parsed = apiTriggerModeSchema.safeParse(value)
  if (!parsed.success) throw new WorkflowRuntimeError('invalid-command')
  return parsed.data
}
export function triggerMetadata(value: { triggerMode?: ApiTriggerMode | undefined }): { triggerMode?: ApiTriggerMode } {
  return value.triggerMode === undefined ? {} : { triggerMode: value.triggerMode }
}

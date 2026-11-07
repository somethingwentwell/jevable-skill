import { z } from 'zod'
import type { RunStep } from './run-evaluator.ts'

export const recordedRouteSchema = z.strictObject({
  stepIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  nodeId: z.string().min(1).max(128),
  port: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/u).max(128),
  scope: z.strictObject({ loop: z.string().min(1).max(128), index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).optional(),
})
export const recordedRoutesSchema = z.array(recordedRouteSchema).max(50000)

/** Port choices settled in this transition, including synthesized loop completion but not iteration-result bookkeeping. */
export function recordedRoutes(steps: readonly RunStep[], start = 0) {
  return steps.flatMap((step, stepIndex) => stepIndex < start || step.port === undefined ? [] : [{ stepIndex, nodeId: step.nodeId, port: step.port,
    ...(step.scope ? { scope: { ...step.scope } } : {}) }])
}

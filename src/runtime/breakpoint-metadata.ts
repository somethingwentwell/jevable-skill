/** Read-only receipt projection; no evaluator or checkpoint replay dependency. */
import { isDeepStrictEqual as same } from 'node:util'
import type { LocalRun } from './run-types.ts'

/** Omitted means retain the last explicit configuration; [] explicitly clears it. */
export function breakpointConfiguration(run: Pick<LocalRun, 'controlRequests'>) {
  return run.controlRequests?.findLast(request => request.breakpoints !== undefined)
}
/** A durable hit at this exact paused position, not merely membership in the breakpoint list. */
export function breakpointAt(run: LocalRun) {
  const last = run.breakpointHits?.at(-1), state = run.state
  return last && state.status === 'paused' && state.next === last.nodeId && state.steps.length === last.stepCount
    && same(state.scope, last.scope) ? last : undefined
}
export function breakpointMetadata(run: LocalRun) {
  const configuration = breakpointConfiguration(run), hit = breakpointAt(run)
  return configuration ? { breakpoints: configuration.breakpoints!, breakpointConfigurationRequestId: configuration.requestId,
    ...(hit ? { breakpoint: hit } : {}) } : {}
}

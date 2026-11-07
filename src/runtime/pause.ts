import { isDeepStrictEqual } from 'node:util'
import { executionCheckpointHash, type LocalRun } from './run-types.ts'
import { WorkflowRuntimeError } from './errors.ts'

type SavedControl = NonNullable<LocalRun['controlRequests']>[number]

/** Pure admission. A pause is durable control intent, never cancellation or settlement. */
export function admitPause(record: LocalRun, request: SavedControl): { record: LocalRun; admitted: boolean } {
  if (request.mode !== 'pause' || request.breakpoints !== undefined) throw new WorkflowRuntimeError('invalid-command')
  const previous = record.controlRequests?.find(item => item.requestId === request.requestId)
  if (previous) {
    if (!isDeepStrictEqual({ ...previous, at: request.at }, request)) throw new WorkflowRuntimeError('conflict')
    return { record, admitted: false }
  }
  if (record.cancellation || !['paused', 'executing'].includes(record.state.status)
    || executionCheckpointHash(record) !== request.expectedCheckpointSha256) throw new WorkflowRuntimeError('conflict')
  if ((record.controlRequests?.length ?? 0) >= 10000) throw new WorkflowRuntimeError('limit')
  return { record: { ...record, updatedAt: request.at, controlRequests: [...record.controlRequests ?? [], request] }, admitted: true }
}

export function requestedPause(record: Pick<LocalRun, 'controlRequests'>) {
  const last = record.controlRequests?.at(-1)
  return last?.mode === 'pause' ? last : undefined
}

/** A paused checkpoint is safe; an executing intent is not proof that a worker is alive. */
export function pauseMetadata(record: LocalRun) {
  const request = requestedPause(record)
  if (!request) return {}
  return { pause: { requestId: request.requestId, at: request.at,
    status: record.cancellation ? 'superseded-by-cancellation' : record.state.status === 'paused' ? 'at-safe-checkpoint'
      : record.state.status === 'executing' ? 'requested; current attempt may be active or uncertain'
        : record.state.status === 'waiting' ? 'approval-wait; downstream execution remains paused' : 'terminal-before-next-checkpoint',
    execution: 'no-abort-or-rollback; resume-safe-checkpoint-with-new-step-or-continue' } }
}

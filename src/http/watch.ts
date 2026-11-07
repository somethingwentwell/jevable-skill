import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'

export class RunWatchError extends Error {
  constructor(readonly code: 'invalid-watch-options' | 'invalid-watch-response' | 'watch-identity-changed' | 'watch-read-failed') {
    super(`Jevable run watch stopped: ${code}. No execution or recovery was requested.`)
  }
}
const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const receipt = z.object({ schemaVersion: z.literal(1), id: z.uuid(), revision: hash, checkpointSha256: hash,
  status: z.enum(['paused', 'executing', 'waiting', 'completed', 'failed', 'cancelled']),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), steps: z.array(z.unknown()).max(100000) })
const envelope = z.object({ schemaVersion: z.literal(1), instanceId: z.uuid(), result: receipt })
const optionsSchema = z.strictObject({ intervalMs: z.number().int().min(100).max(60000).default(1000),
  durationMs: z.number().int().min(1).max(3600000).default(60000), follow: z.boolean().default(false) })
export interface RunWatchOptions { intervalMs?: number; durationMs?: number; follow?: boolean; signal?: AbortSignal }
export interface RunWatchClient { operation(command: { operation: 'runs.show'; id: string }): Promise<unknown> }
export interface RunObservation {
  id: string; revision: string; checkpointSha256: string; instanceId: string;
  status: z.infer<typeof receipt>['status']; createdAt: string; updatedAt: string; recordedSteps: number
}
export type RunWatchReason = 'completed' | 'failed' | 'cancelled' | 'attention' | 'deadline' | 'interrupted'
export type RunWatchEvent = { schemaVersion: 1; type: 'snapshot'; observation: RunObservation }
  | { schemaVersion: 1; type: 'stopped'; reason: RunWatchReason; polls: number; last: RunObservation | null; execution: 'not-requested' }

/** Poll only runs.show. A client must bound each read; interruption never cancels the workflow. */
export async function* watchRun(client: RunWatchClient, id: string, options: RunWatchOptions = {}): AsyncGenerator<RunWatchEvent> {
  const { signal, ...settings } = options, parsed = optionsSchema.safeParse(settings)
  if (!z.uuid().safeParse(id).success || !parsed.success || (signal !== undefined && !(signal instanceof AbortSignal))) throw new RunWatchError('invalid-watch-options')
  const { intervalMs, durationMs, follow } = parsed.data, started = performance.now()
  let last: RunObservation | null = null, polls = 0
  const stop = (reason: RunWatchReason): RunWatchEvent => ({ schemaVersion: 1, type: 'stopped', reason, polls, last, execution: 'not-requested' })
  while (true) {
    if (signal?.aborted) { yield stop('interrupted'); return }
    if (performance.now() - started >= durationMs) { yield stop('deadline'); return }
    let value: unknown
    try { polls++; value = await client.operation({ operation: 'runs.show', id }) }
    catch {
      if (signal?.aborted) { yield stop('interrupted'); return }
      if (performance.now() - started >= durationMs) { yield stop('deadline'); return }
      throw new RunWatchError('watch-read-failed')
    }
    // A stopped observer must not publish a late response as fresh progress.
    if (signal?.aborted) { yield stop('interrupted'); return }
    if (performance.now() - started >= durationMs) { yield stop('deadline'); return }
    const response = envelope.safeParse(value)
    if (!response.success) throw new RunWatchError('invalid-watch-response')
    const { instanceId, result } = response.data
    if (result.id !== id || (last && (last.revision !== result.revision || last.instanceId !== instanceId || last.createdAt !== result.createdAt))) {
      throw new RunWatchError('watch-identity-changed')
    }
    const observation: RunObservation = { id, revision: result.revision, checkpointSha256: result.checkpointSha256, instanceId,
      status: result.status, createdAt: result.createdAt, updatedAt: result.updatedAt, recordedSteps: result.steps.length }
    if (!last || JSON.stringify(last) !== JSON.stringify(observation)) { last = observation; yield { schemaVersion: 1, type: 'snapshot', observation: { ...observation } } }
    if (['completed', 'failed', 'cancelled'].includes(observation.status)) { yield stop(observation.status as 'completed' | 'failed' | 'cancelled'); return }
    if (!follow && (observation.status === 'waiting' || observation.status === 'paused')) { yield stop('attention'); return }
    const nextReadAt = Math.min(started + durationMs, performance.now() + intervalMs)
    // Timers may wake early (fractional milliseconds are truncated). Recheck the
    // monotonic target so an early wake never turns into an extra poll or burst.
    while (!signal?.aborted && performance.now() < nextReadAt) {
      try { await delay(Math.max(1, Math.ceil(nextReadAt - performance.now())), undefined, { signal }) }
      catch { if (!signal?.aborted) throw new RunWatchError('watch-read-failed') }
    }
  }
}

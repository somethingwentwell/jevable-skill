import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { callerReleasePinSchema, callerRunReceiptSchema, callerRunResultSchema, type CallerReleasePin } from '../access/caller.ts'
import { grantIdSchema } from '../access/grants.ts'

export const callerStreamOptionsSchema = z.strictObject({
  intervalMs: z.number().int().min(100).max(60000).default(1000),
  durationMs: z.number().int().min(1).max(60000).default(15000),
  follow: z.boolean().default(false),
})
/** Connection-local observation, not a durable cursor, execution request or output read. */
export const callerStreamRequestSchema = callerStreamOptionsSchema.extend({ id: grantIdSchema, release: callerReleasePinSchema })
export type CallerStreamRequest = z.infer<typeof callerStreamRequestSchema>
export type CallerStreamOptions = z.input<typeof callerStreamOptionsSchema> & { signal?: AbortSignal }
const sequence = z.number().int().min(1).max(1000)
export const callerStreamEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ schemaVersion: z.literal(1), type: z.literal('snapshot'), sequence, instanceId: z.uuid(), result: callerRunReceiptSchema }),
  z.strictObject({ schemaVersion: z.literal(1), type: z.literal('stopped'), sequence, instanceId: z.uuid(),
    reason: z.enum(['completed', 'failed', 'cancelled', 'attention', 'deadline', 'interrupted', 'draining', 'read-refused']),
    execution: z.literal('not-requested') }),
])
export type CallerStreamEvent = z.infer<typeof callerStreamEventSchema>

export class CallerStreamError extends Error {
  constructor() { super('Invalid caller stream metadata or identity. No execution was requested.') }
}

/** Read admission is delegated to the existing SDK on EVERY poll, including unchanged state.
 * Never retain the private completed output, adopt caller trace context or invoke a mutation.
 */
export async function* observeCallerRun(read: () => Promise<unknown>, instanceId: string, request: CallerStreamRequest,
  signal: AbortSignal): AsyncGenerator<CallerStreamEvent | null> {
  const parsed = callerStreamRequestSchema.safeParse(request)
  if (!parsed.success || !z.uuid().safeParse(instanceId).success || !(signal instanceof AbortSignal)) throw new CallerStreamError()
  const pin = parsed.data, began = performance.now()
  let last: z.infer<typeof callerRunReceiptSchema> | undefined, count = 0
  const stop = (reason: Extract<CallerStreamEvent, { type: 'stopped' }>['reason']): CallerStreamEvent =>
    ({ schemaVersion: 1, type: 'stopped', sequence: ++count, instanceId, reason, execution: 'not-requested' })
  while (true) {
    if (signal.aborted) { yield stop(signal.reason === 'draining' ? 'draining' : 'interrupted'); return }
    if (last && performance.now() - began >= pin.durationMs) { yield stop('deadline'); return }
    let result: z.infer<typeof callerRunReceiptSchema>
    try {
      const received = callerRunResultSchema.safeParse(await read())
      if (!received.success) throw new CallerStreamError()
      const { output: _privateOutput, ...metadata } = received.data
      result = callerRunReceiptSchema.parse(metadata)
      if (result.id !== pin.id || result.revision !== pin.release.revision || result.release.id !== pin.release.id
        || result.release.sha256 !== pin.release.sha256 || last && result.createdAt !== last.createdAt) throw new CallerStreamError()
    } catch (error) {
      if (!last) throw error // Initial authentication/refusal must remain an HTTP error, not a successful stream.
      yield stop('read-refused'); return
    }
    // An asynchronous read finishing after shutdown/deadline is not fresh progress.
    if (signal.aborted) { yield stop(signal.reason === 'draining' ? 'draining' : 'interrupted'); return }
    if (performance.now() - began >= pin.durationMs) { yield stop('deadline'); return }
    if (!last || JSON.stringify(last) !== JSON.stringify(result)) {
      last = result
      yield { schemaVersion: 1, type: 'snapshot', sequence: ++count, instanceId, result: structuredClone(result) }
    } else yield null // An authenticated metadata read permits only a fixed heartbeat, not duplicate snapshots.
    if (['completed', 'failed', 'cancelled'].includes(result.status)) {
      yield stop(result.status as 'completed' | 'failed' | 'cancelled'); return
    }
    if (!pin.follow && (result.status === 'waiting' || result.status === 'paused')) { yield stop('attention'); return }
    const next = Math.min(began + pin.durationMs, performance.now() + pin.intervalMs)
    while (!signal.aborted && performance.now() < next) {
      try { await delay(Math.max(1, Math.ceil(next - performance.now())), undefined, { signal }) }
      catch { if (!signal.aborted) throw new CallerStreamError() }
    }
  }
}

export function encodeCallerStreamEvent(event: CallerStreamEvent | null): string {
  return event === null ? ': keepalive\n\n' : `event: ${event.type}\ndata: ${JSON.stringify(callerStreamEventSchema.parse(event))}\n\n`
}

/** Validate an untrusted stream before yielding it. No metadata widening or silent sequence gaps. */
export function admitCallerStreamEvent(raw: unknown, instanceId: string, id: string, release: CallerReleasePin,
  previous?: CallerStreamEvent): CallerStreamEvent {
  const parsed = callerStreamEventSchema.safeParse(raw)
  if (!parsed.success || parsed.data.instanceId !== instanceId || parsed.data.sequence !== (previous?.sequence ?? 0) + 1
    || previous?.type === 'stopped') throw new CallerStreamError()
  const event = parsed.data
  if (event.type === 'snapshot' && (event.result.id !== id || event.result.revision !== release.revision
    || event.result.release.id !== release.id || event.result.release.sha256 !== release.sha256
    || previous?.type === 'snapshot' && event.result.createdAt !== previous.result.createdAt)) throw new CallerStreamError()
  if (event.type === 'stopped' && ['completed', 'failed', 'cancelled', 'attention'].includes(event.reason)
    && (previous?.type !== 'snapshot' || (event.reason === 'attention'
      ? !['waiting', 'paused'].includes(previous.result.status) : previous.result.status !== event.reason))) throw new CallerStreamError()
  return event
}

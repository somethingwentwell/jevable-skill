import { z } from 'zod'
import type { Branded } from '../shared/brand.ts'

export type JevableTraceId = Branded<'JevableTraceId'>
export type JevableSpanId = Branded<'JevableSpanId'>
export const runTrace = z.strictObject({
  traceId: z.string().regex(/^(?!0{32}$)[a-f0-9]{32}$/u).transform(value => value as JevableTraceId),
  spanId: z.string().regex(/^(?!0{16}$)[a-f0-9]{16}$/u).transform(value => value as JevableSpanId),
  traceFlags: z.union([z.literal(0), z.literal(1)]),
})
export const cancellationTraceCauseSchema = z.strictObject({ kind: z.literal('cancellation'), requestId: z.uuid(), parent: runTrace })
export const runTraceSegment = z.strictObject({ operation: z.enum(['run', 'resume', 'approval', 'cancel']), at: z.iso.datetime(), trace: runTrace,
  previous: runTrace.optional(), parent: runTrace.optional(), cause: cancellationTraceCauseSchema.optional() })
  .refine(value => value.cause === undefined || value.operation === 'cancel')

/** Derived from committed admission, never from the context of a later retry or worker. */
export function cancellationTraceCause(record: { cancellation?: { id: string; traceParent?: z.infer<typeof runTrace> | undefined } | undefined }) {
  return record.cancellation?.traceParent ? cancellationTraceCauseSchema.parse({ kind: 'cancellation',
    requestId: record.cancellation.id, parent: record.cancellation.traceParent }) : undefined
}

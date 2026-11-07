import { z } from 'zod';
export const runTrace = z.strictObject({
    traceId: z.string().regex(/^(?!0{32}$)[a-f0-9]{32}$/u).transform(value => value),
    spanId: z.string().regex(/^(?!0{16}$)[a-f0-9]{16}$/u).transform(value => value),
    traceFlags: z.union([z.literal(0), z.literal(1)]),
});
export const cancellationTraceCauseSchema = z.strictObject({ kind: z.literal('cancellation'), requestId: z.uuid(), parent: runTrace });
export const runTraceSegment = z.strictObject({ operation: z.enum(['run', 'resume', 'approval', 'cancel']), at: z.iso.datetime(), trace: runTrace,
    previous: runTrace.optional(), parent: runTrace.optional(), cause: cancellationTraceCauseSchema.optional() })
    .refine(value => value.cause === undefined || value.operation === 'cancel');
/** Derived from committed admission, never from the context of a later retry or worker. */
export function cancellationTraceCause(record) {
    return record.cancellation?.traceParent ? cancellationTraceCauseSchema.parse({ kind: 'cancellation',
        requestId: record.cancellation.id, parent: record.cancellation.traceParent }) : undefined;
}

import { z } from 'zod';
import type { Branded } from '../shared/brand.ts';
export type JevableTraceId = Branded<'JevableTraceId'>;
export type JevableSpanId = Branded<'JevableSpanId'>;
export declare const runTrace: z.ZodObject<{
    traceId: z.ZodPipe<z.ZodString, z.ZodTransform<JevableTraceId, string>>;
    spanId: z.ZodPipe<z.ZodString, z.ZodTransform<JevableSpanId, string>>;
    traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
}, z.core.$strict>;
export declare const cancellationTraceCauseSchema: z.ZodObject<{
    kind: z.ZodLiteral<"cancellation">;
    requestId: z.ZodUUID;
    parent: z.ZodObject<{
        traceId: z.ZodPipe<z.ZodString, z.ZodTransform<JevableTraceId, string>>;
        spanId: z.ZodPipe<z.ZodString, z.ZodTransform<JevableSpanId, string>>;
        traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
    }, z.core.$strict>;
}, z.core.$strict>;
export declare const runTraceSegment: z.ZodObject<{
    operation: z.ZodEnum<{
        cancel: "cancel";
        approval: "approval";
        run: "run";
        resume: "resume";
    }>;
    at: z.ZodISODateTime;
    trace: z.ZodObject<{
        traceId: z.ZodPipe<z.ZodString, z.ZodTransform<JevableTraceId, string>>;
        spanId: z.ZodPipe<z.ZodString, z.ZodTransform<JevableSpanId, string>>;
        traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
    }, z.core.$strict>;
    previous: z.ZodOptional<z.ZodObject<{
        traceId: z.ZodPipe<z.ZodString, z.ZodTransform<JevableTraceId, string>>;
        spanId: z.ZodPipe<z.ZodString, z.ZodTransform<JevableSpanId, string>>;
        traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
    }, z.core.$strict>>;
    parent: z.ZodOptional<z.ZodObject<{
        traceId: z.ZodPipe<z.ZodString, z.ZodTransform<JevableTraceId, string>>;
        spanId: z.ZodPipe<z.ZodString, z.ZodTransform<JevableSpanId, string>>;
        traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
    }, z.core.$strict>>;
    cause: z.ZodOptional<z.ZodObject<{
        kind: z.ZodLiteral<"cancellation">;
        requestId: z.ZodUUID;
        parent: z.ZodObject<{
            traceId: z.ZodPipe<z.ZodString, z.ZodTransform<JevableTraceId, string>>;
            spanId: z.ZodPipe<z.ZodString, z.ZodTransform<JevableSpanId, string>>;
            traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
        }, z.core.$strict>;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** Derived from committed admission, never from the context of a later retry or worker. */
export declare function cancellationTraceCause(record: {
    cancellation?: {
        id: string;
        traceParent?: z.infer<typeof runTrace> | undefined;
    } | undefined;
}): {
    kind: "cancellation";
    requestId: string;
    parent: {
        traceId: JevableTraceId;
        spanId: JevableSpanId;
        traceFlags: 0 | 1;
    };
} | undefined;

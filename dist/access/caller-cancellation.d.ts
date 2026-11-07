import { z } from 'zod';
import { type GrantMetadata } from './grants.ts';
import type { GrantActionAdmission, GrantActionTarget } from './actions.ts';
import { type CallerRunReceipt, type CallerCancellationRequest } from './caller.ts';
export { callerCancellationRequestSchema, type CallerCancellationRequest } from './caller.ts';
import type { LocalRun } from '../runtime/run-types.ts';
import { runTrace } from '../runtime/run-trace.ts';
/** Private writer-derived attribution. Never accepted in a caller request. */
export declare const callerCancellationBindingSchema: z.ZodObject<{
    grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    scope: z.ZodObject<{
        kind: z.ZodLiteral<"caller">;
        release: z.ZodObject<{
            id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
            sha256: z.ZodString;
            revision: z.ZodString;
        }, z.core.$strict>;
        permissions: z.ZodPipe<z.ZodArray<z.ZodEnum<{
            start: "start";
            read: "read";
            control: "control";
            cancel: "cancel";
        }>>, z.ZodTransform<("start" | "read" | "control" | "cancel")[], ("start" | "read" | "control" | "cancel")[]>>;
    }, z.core.$strict>;
    deadline: z.ZodISODateTime;
}, z.core.$strict>;
export declare const callerCancellationEvidenceSchema: z.ZodObject<{
    id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    actor: z.ZodString;
    at: z.ZodISODateTime;
    traceParent: z.ZodOptional<z.ZodObject<{
        traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableTraceId, string>>;
        spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableSpanId, string>>;
        traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
    }, z.core.$strict>>;
    delegation: z.ZodObject<{
        grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        scope: z.ZodObject<{
            kind: z.ZodLiteral<"caller">;
            release: z.ZodObject<{
                id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                sha256: z.ZodString;
                revision: z.ZodString;
            }, z.core.$strict>;
            permissions: z.ZodPipe<z.ZodArray<z.ZodEnum<{
                start: "start";
                read: "read";
                control: "control";
                cancel: "cancel";
            }>>, z.ZodTransform<("start" | "read" | "control" | "cancel")[], ("start" | "read" | "control" | "cancel")[]>>;
        }, z.core.$strict>;
        deadline: z.ZodISODateTime;
    }, z.core.$strict>;
}, z.core.$strict>;
export type CallerCancellationEvidence = z.infer<typeof callerCancellationEvidenceSchema>;
declare const externalEffects: "not-reverted; unsettled attempts may have unknown outcomes";
export declare const callerCancellationReceiptSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    revision: z.ZodString;
    release: z.ZodObject<{
        id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        sha256: z.ZodString;
    }, z.core.$strict>;
    createdAt: z.ZodISODateTime;
    updatedAt: z.ZodISODateTime;
    status: z.ZodEnum<{
        cancelled: "cancelled";
        completed: "completed";
        paused: "paused";
        failed: "failed";
        waiting: "waiting";
        executing: "executing";
    }>;
    requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    requestedAt: z.ZodISODateTime;
    externalEffects: z.ZodLiteral<"not-reverted; unsettled attempts may have unknown outcomes">;
}, z.core.$strict>;
export type CallerCancellationReceipt = CallerRunReceipt & {
    requestId: string;
    requestedAt: string;
    externalEffects: typeof externalEffects;
};
/** Actual retained target; a request cannot choose a grant, release, actor or scope. */
export declare function callerCancellationTarget(record: LocalRun): GrantActionTarget;
export declare function prepareCallerCancellation(record: LocalRun, request: CallerCancellationRequest, admission: GrantActionAdmission, parent?: z.infer<typeof runTrace>): {
    record: LocalRun;
    cancellation: {
        id: string;
        actor: string;
        at: string;
        delegation: {
            grantId: string;
            scope: {
                kind: "caller";
                release: {
                    id: string;
                    sha256: string;
                    revision: string;
                };
                permissions: ("start" | "read" | "control" | "cancel")[];
            };
            deadline: string;
        };
        traceParent?: {
            traceId: import("../runtime/run-trace.ts").JevableTraceId;
            spanId: import("../runtime/run-trace.ts").JevableSpanId;
            traceFlags: 0 | 1;
        } | undefined;
    };
};
/** Fresh scoped authentication precedes this observation. No abort, settlement, execution or new evidence. */
export declare function callerCancellationRetry(record: LocalRun, request: CallerCancellationRequest): CallerCancellationReceipt | undefined;
export declare function callerCancellationReceipt(record: LocalRun): CallerCancellationReceipt;
type Event = {
    kind: string;
    data: unknown;
};
/** PostgreSQL binds the action UUID to the exact atomic run-event batch on write AND replay. */
export declare function verifyCallerCancellationBatchIdentity(kind: string, data: unknown, batchId: string): {
    id: string;
    actor: string;
    at: string;
    delegation: {
        grantId: string;
        scope: {
            kind: "caller";
            release: {
                id: string;
                sha256: string;
                revision: string;
            };
            permissions: ("start" | "read" | "control" | "cancel")[];
        };
        deadline: string;
    };
    traceParent?: {
        traceId: import("../runtime/run-trace.ts").JevableTraceId;
        spanId: import("../runtime/run-trace.ts").JevableSpanId;
        traceFlags: 0 | 1;
    } | undefined;
} | undefined;
/** Historical consistency, never live authority. Shared replay also checks snapshot/event correspondence. */
export declare function verifyCallerCancellation(record: LocalRun, events: readonly Event[], metadata?: GrantMetadata): void;

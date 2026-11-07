import { z } from 'zod';
import { type GrantMetadata } from './grants.ts';
import type { GrantActionAdmission, GrantActionTarget } from './actions.ts';
import { type LocalRun } from '../runtime/run-types.ts';
import { type CallerControlRequest } from './caller-control-request.ts';
export { callerControlRequestSchema, type CallerControlRequest } from './caller-control-request.ts';
export declare const callerControlEvidenceSchema: z.ZodObject<{
    expectedCheckpointSha256: z.ZodString;
    mode: z.ZodEnum<{
        continue: "continue";
        step: "step";
        pause: "pause";
        recover: "recover";
    }>;
    breakpoints: z.ZodOptional<z.ZodArray<z.ZodString>>;
    requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    actor: z.ZodString;
    at: z.ZodISODateTime;
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
export type CallerControlEvidence = z.infer<typeof callerControlEvidenceSchema>;
export declare const callerControlCheckpointSchema: z.ZodObject<{
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
    checkpointSha256: z.ZodString;
}, z.core.$strict>;
export type CallerControlCheckpoint = z.infer<typeof callerControlCheckpointSchema>;
export declare const callerControlReceiptSchema: z.ZodObject<{
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
    checkpointSha256: z.ZodString;
    requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    mode: z.ZodEnum<{
        continue: "continue";
        step: "step";
        pause: "pause";
        recover: "recover";
    }>;
    requestedAt: z.ZodISODateTime;
}, z.core.$strict>;
export type CallerControlReceipt = z.infer<typeof callerControlReceiptSchema>;
/** Verified retained target. Caller requests cannot supply ownership or release pins. */
export declare function callerControlTarget(record: LocalRun): GrantActionTarget;
/** Exact checkpoint admission only. Recovery still requires verified retained model evidence before writing. */
export declare function assertCallerControlCheckpoint(record: LocalRun, request: CallerControlRequest): void;
/** Run only after fresh writer authorization; this pure projection grants no future execution permission. */
export declare function prepareCallerControl(record: LocalRun, value: CallerControlRequest, admission: GrantActionAdmission): {
    record: LocalRun;
    control: {
        expectedCheckpointSha256: string;
        mode: "continue" | "step" | "pause" | "recover";
        requestId: string;
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
        breakpoints?: string[] | undefined;
    };
};
/** Metadata only. Control permission does not disclose output, source, input, steps, scope or actors. */
export declare function callerControlCheckpoint(record: LocalRun): CallerControlCheckpoint;
export declare function callerControlReceipt(record: LocalRun, requestId: string): CallerControlReceipt;
/** Fresh scoped authentication must precede observation; never resume, recover, pause or replay here. */
export declare function callerControlRetry(record: LocalRun, value: CallerControlRequest): {
    schemaVersion: 1;
    id: string;
    revision: string;
    release: {
        id: string;
        sha256: string;
    };
    createdAt: string;
    updatedAt: string;
    status: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
    checkpointSha256: string;
    requestId: string;
    mode: "continue" | "step" | "pause" | "recover";
    requestedAt: string;
} | undefined;
type Event = {
    kind: string;
    data: unknown;
};
/** Exact action UUID must bind the PostgreSQL atomic admission batch on both write and replay. */
export declare function verifyCallerControlBatchIdentity(kind: string, data: unknown, batchId: string): {
    expectedCheckpointSha256: string;
    mode: "continue" | "step" | "pause" | "recover";
    requestId: string;
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
    breakpoints?: string[] | undefined;
} | undefined;
/** Historical consistency only, not current authority or approval to replay admitted work. */
export declare function verifyCallerControls(record: LocalRun, events: readonly Event[], metadata?: GrantMetadata): void;

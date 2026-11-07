import { z } from 'zod';
declare const requestSchema: z.ZodObject<{
    requestId: z.ZodUUID;
    owner: z.ZodUUID;
    lockSha256: z.ZodString;
    confirm: z.ZodLiteral<true>;
}, z.core.$strict>;
declare const receiptSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    kind: z.ZodLiteral<"JevableRuntimeLockRecovery">;
    status: z.ZodLiteral<"released">;
    request: z.ZodObject<{
        requestId: z.ZodUUID;
        owner: z.ZodUUID;
        lockSha256: z.ZodString;
        confirm: z.ZodLiteral<true>;
    }, z.core.$strict>;
    lock: z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        kind: z.ZodLiteral<"JevableRuntimeLock">;
        pid: z.ZodNumber;
        owner: z.ZodUUID;
        startedAt: z.ZodISODateTime;
        recoveryContext: z.ZodNullable<z.ZodObject<{
            platform: z.ZodLiteral<"linux">;
            bootId: z.ZodUUID;
            pidNamespace: z.ZodObject<{
                dev: z.ZodString;
                ino: z.ZodString;
            }, z.core.$strict>;
            filesystemType: z.ZodString;
            directory: z.ZodObject<{
                dev: z.ZodString;
                ino: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    lockBytes: z.ZodNumber;
    completedAt: z.ZodISODateTime;
    database: z.ZodLiteral<"not-opened">;
    execution: z.ZodLiteral<"not-started">;
}, z.core.$strict>;
export type RuntimeLockRecoveryRequest = z.infer<typeof requestSchema>;
export type RuntimeLockRecoveryReceipt = z.infer<typeof receiptSchema>;
/** Read-only; no directory creation, SQLite, owner acquisition, signal or workflow work. */
export declare function inspectRuntimeLock(dataDirectory: string): Promise<{
    schemaVersion: 1;
    kind: "JevableRuntimeLockInspection";
    lockSha256: string;
    owner: string;
    pid: number;
    recoveryEligible: boolean;
    reason: "legacy-lock" | "unsupported-context" | "context-mismatch" | "owner-exited" | "owner-not-proven-exited";
    process: "unknown" | "present" | "absent" | "not-probed";
    database: "not-opened";
    execution: "not-started";
}>;
/** Explicit same-boot recovery only. Once the barrier exists, any failure retains it.
 * A crash during recovery therefore blocks startup, rather than guessing transaction outcome.
 * This is cooperative locking in a trusted private directory, not protection from a
 * malicious same-UID/root process mutating paths between an identity check and unlink.
 */
export declare function recoverRuntimeLock(dataDirectory: string, input: RuntimeLockRecoveryRequest): Promise<RuntimeLockRecoveryReceipt>;
/** Inspect an existing interrupted transaction, without acquiring any owner. */
export declare function inspectRuntimeLockRecovery(dataDirectory: string): Promise<{
    schemaVersion: 1;
    kind: "JevableRuntimeLockRecoveryInspection";
    request: {
        requestId: string;
        owner: string;
        lockSha256: string;
        confirm: true;
    };
    ownerPid: number;
    recoveryPid: number | null;
    stage: "archived-before-barrier-release" | "receipt-retained" | "lock-retained" | "intent-only" | "released-before-receipt";
    completionEligible: boolean;
    reason: "unsupported-context" | "context-mismatch" | "legacy-intent" | "completion-claimed" | "process-not-proven-exited" | "eligible";
    ownerProcess: "unknown" | "present" | "absent" | "not-probed";
    recoveryProcess: "unknown" | "present" | "absent" | "not-probed";
    database: "not-opened";
    execution: "not-started";
}>;
/** Explicitly finish a proved-exited v2 recovery. The exclusive completion claim
 * is retained inside the original barrier/archive. Failure after claiming stays
 * blocked; recursive takeover of an interrupted completion is not implemented.
 * This is trusted-directory cooperative exclusion, not hostile same-UID fencing. */
export declare function completeRuntimeLockRecovery(dataDirectory: string, input: RuntimeLockRecoveryRequest): Promise<RuntimeLockRecoveryReceipt>;
/** Shared by every new SQLite owner. Check recovery exclusion both sides of wx creation. */
export declare class RuntimeOwnerLock {
    private readonly file;
    private readonly path;
    private readonly info;
    private constructor();
    static acquire(path: string): Promise<RuntimeOwnerLock>;
    release(): Promise<void>;
}
export {};

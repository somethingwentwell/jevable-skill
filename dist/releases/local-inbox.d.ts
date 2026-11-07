import { z } from 'zod';
/** Durable local event inbox records. `pending` retries on every scheduler pass,
 * `observed` holds a non-terminal run state (waiting/paused/executing) and is
 * re-observed after the wait settles, and the three terminal states stop retrying.
 * Nothing here resumes, retries execution, decides an approval or invents an identity. */
declare const recordSchema: z.ZodObject<{
    format: z.ZodLiteral<"jevable.ai/local-release-inbox">;
    version: z.ZodLiteral<1>;
    eventSha256: z.ZodString;
    runId: z.ZodUUID;
    release: z.ZodObject<{
        id: z.ZodUUID;
        sha256: z.ZodString;
        revision: z.ZodString;
    }, z.core.$strict>;
    source: z.ZodString;
    messageId: z.ZodString;
    state: z.ZodEnum<{
        conflict: "conflict";
        pending: "pending";
        invalid: "invalid";
        observed: "observed";
        acked: "acked";
    }>;
    attempts: z.ZodNumber;
    lastStatus: z.ZodOptional<z.ZodString>;
    lastCode: z.ZodOptional<z.ZodString>;
    lastObservedAt: z.ZodOptional<z.ZodISODateTime>;
    createdAt: z.ZodISODateTime;
    updatedAt: z.ZodISODateTime;
}, z.core.$strict>;
export type ReleaseLocalInboxRecord = z.infer<typeof recordSchema>;
export type ReleaseLocalInboxState = ReleaseLocalInboxRecord['state'];
export interface QueuedReleaseLocalEvent {
    eventSha256: string;
    runId: string;
    release: {
        id: string;
        sha256: string;
        revision: string;
    };
    source: string;
    messageId: string;
    input: unknown;
}
/** Queue one admitted event as exact pinned bytes plus a pending record. Re-queueing
 * the same bytes is idempotent; the inbox never opens workflow storage. */
export declare function queueReleaseLocalEvent(directory: string, event: QueuedReleaseLocalEvent, bytes: Uint8Array): Promise<{
    record: {
        format: "jevable.ai/local-release-inbox";
        version: 1;
        eventSha256: string;
        runId: string;
        release: {
            id: string;
            sha256: string;
            revision: string;
        };
        source: string;
        messageId: string;
        state: "conflict" | "pending" | "invalid" | "observed" | "acked";
        attempts: number;
        createdAt: string;
        updatedAt: string;
        lastStatus?: string | undefined;
        lastCode?: string | undefined;
        lastObservedAt?: string | undefined;
    };
    created: boolean;
}>;
export interface LoadedReleaseLocalInboxEntry {
    record: ReleaseLocalInboxRecord;
    recordPath: string;
    eventPath: string;
    eventBytes: Buffer;
}
/** Load and fully re-verify every inbox entry before any delivery attempt. */
export declare function loadReleaseLocalInbox(directory: string): Promise<{
    path: string;
    entries: LoadedReleaseLocalInboxEntry[];
}>;
/** Persist one delivery observation. Terminal states stop retrying; uncertain outcomes
 * keep the entry replayable under its original identity. */
export declare function updateReleaseLocalInboxEntry(entry: LoadedReleaseLocalInboxEntry, observation: {
    state: ReleaseLocalInboxState;
    status?: string;
    code?: string;
}): Promise<{
    format: "jevable.ai/local-release-inbox";
    version: 1;
    eventSha256: string;
    runId: string;
    release: {
        id: string;
        sha256: string;
        revision: string;
    };
    source: string;
    messageId: string;
    state: "conflict" | "pending" | "invalid" | "observed" | "acked";
    attempts: number;
    createdAt: string;
    updatedAt: string;
    lastStatus?: string | undefined;
    lastCode?: string | undefined;
    lastObservedAt?: string | undefined;
}>;
/** Cooperative single-scheduler exclusion in a trusted private directory: a live owner
 * refuses with `busy`; a provably exited owner is replaced. Not hostile-process fencing. */
export declare function acquireReleaseLocalInboxLock(directory: string): Promise<() => Promise<void>>;
export {};

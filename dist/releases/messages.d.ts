import { z } from 'zod';
import type { AsyncRun } from '../runtime/async-run.ts';
import type { LocalRuntime } from '../runtime/local.ts';
import type { PostgresRuntime } from '../runtime/postgres.ts';
export declare const releaseMessageIdentitySchema: z.ZodObject<{
    release: z.ZodObject<{
        id: z.ZodUUID;
        sha256: z.ZodString;
        revision: z.ZodString;
    }, z.core.$strict>;
    source: z.ZodString;
    messageId: z.ZodString;
}, z.core.$strict>;
export type ReleaseMessageIdentity = z.infer<typeof releaseMessageIdentitySchema>;
export interface ReleaseMessageRequest {
    messageId: string;
    input: unknown;
}
export interface ReleaseMessageRun extends AsyncRun {
    /** Detached caller metadata; not a signed receipt or a separate durable message journal. */
    message: {
        source: string;
        id: string;
    };
}
type Methods = 'runReleaseAsync' | 'show';
export type ReleaseMessageRuntime = Pick<LocalRuntime, Methods> | Pick<PostgresRuntime, Methods>;
/** Offline message-entry admission, shared with signed service startup before storage ownership. */
export declare function inspectMessageRelease(snapshot: unknown): import("./snapshot.ts").Release;
/** Deterministic UUIDv8: an exact release, reviewed sender namespace and stable message ID.
 * Input, delivery time, attempts, credentials and service instance are deliberately excluded.
 * This is identity derivation, never sender authentication or an exactly-once-effect guarantee.
 */
export declare function releaseMessageRunId(value: ReleaseMessageIdentity): string;
/** Trusted owned SDK adapter for a separately authenticated message consumer.
 * Does not open storage, start a listener, accept signatures, acknowledge a queue, retry,
 * approve, resume, close the owner or turn an uncertain start into success.
 */
export declare class ReleaseMessageSession {
    private readonly runtime;
    private readonly artifact;
    private readonly source;
    constructor(runtime: ReleaseMessageRuntime, snapshot: unknown, source: string);
    get release(): ReleaseMessageIdentity['release'];
    runId(messageId: string): string;
    start(value: ReleaseMessageRequest): Promise<ReleaseMessageRun>;
    show(messageId: string): Promise<import("../runtime/run-types.ts").LocalRun>;
}
export {};

/** Admit exact captured event bytes against this release: strict versioned envelope,
 * exact release pin, optional reviewed byte hash and bounded input admission.
 * Shared by the one-shot file command and the durable local inbox; never opens storage. */
export declare function admitReleaseLocalEventBytes(bytes: Uint8Array, snapshot: unknown, expectedSha256?: string): {
    sha256: string;
    input: import("../index.ts").ReadonlyJsonValue;
    runId: string;
    source: string;
    messageId: string;
};
/** A local operator-owned event is execution authority, not a public webhook.
 * Capture and pin all bytes before opening any runtime or telemetry configuration.
 */
export declare function readReleaseLocalEvent(path: string, snapshot: unknown, expectedSha256?: string): Promise<{
    bytes: Buffer<ArrayBufferLike>;
    sha256: string;
    input: import("../index.ts").ReadonlyJsonValue;
    runId: string;
    source: string;
    messageId: string;
}>;

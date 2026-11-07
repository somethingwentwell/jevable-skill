export interface ImageBuildRecovery {
    directory: string;
    phase: 'prepare-context' | 'build' | 'verify-image' | 'publish-tag' | 'verify-tag' | 'cleanup';
    outcome: 'unconfirmed';
    automaticRetry: 'disabled';
    contextFiles: 'retained' | 'removed-after-build';
}
export declare class ImageError extends Error {
    readonly code: 'invalid-image-options' | 'docker-unavailable' | 'docker-command-failed' | 'docker-timeout' | 'docker-output-limit' | 'unsupported-docker-context' | 'unsupported-builder' | 'base-unavailable' | 'image-conflict' | 'image-mismatch' | 'image-receipt-write-failed' | 'image-build-failed';
    readonly build?: ImageBuildRecovery | undefined;
    constructor(code: 'invalid-image-options' | 'docker-unavailable' | 'docker-command-failed' | 'docker-timeout' | 'docker-output-limit' | 'unsupported-docker-context' | 'unsupported-builder' | 'base-unavailable' | 'image-conflict' | 'image-mismatch' | 'image-receipt-write-failed' | 'image-build-failed', build?: ImageBuildRecovery | undefined);
}
export interface DockerCommandOptions {
    timeoutMs?: number;
    consumeStdout?: (bytes: Buffer) => Promise<void>;
    /** Bounded private stdin for explicit provisioning; never placed in argv or environment. */
    input?: Uint8Array;
}
export type DockerCommand = (args: string[], options?: DockerCommandOptions) => Promise<string>;
/** No shell or implicit remote builder. The caller supplies an explicitly checked --context. */
export declare const dockerCommand: DockerCommand;

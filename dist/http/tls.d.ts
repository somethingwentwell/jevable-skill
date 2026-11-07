export interface RuntimeTlsOptions {
    publicOrigin: string;
    bindAddress: string;
    certificateFile: string;
    privateKeyFile: string;
}
/** Reject symlinks/special files and bound reads, including files that grow after stat. */
export declare function readTlsPemFile(path: string, privateKey?: boolean): Promise<string>;
/** Only PEM certificate bundles; no silent system-CA fallback for an invalid explicit CA. */
export declare function validateCa(ca: unknown): string;
export declare function loadRuntimeTls(value: RuntimeTlsOptions): Promise<{
    cert: string;
    key: string;
    publicOrigin: string;
    authority: string;
    bindAddress: string;
    certificateSha256: string;
}>;
/** TLS is opt-in as a complete profile. A bind-address flag alone cannot expose plaintext HTTP. */
export declare function tlsOptionsFromFlags(values: Record<string, string | boolean | undefined>): RuntimeTlsOptions | undefined;

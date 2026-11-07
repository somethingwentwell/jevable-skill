export declare class BoundedZipError extends Error {
    readonly code: 'invalid-package' | 'package-limit' | 'checksum-mismatch';
    constructor(code: 'invalid-package' | 'package-limit' | 'checksum-mismatch');
}
export type ZipReadLimits = {
    archiveBytes: number;
    entryBytes: number;
    totalBytes: number;
    entries: number;
};
/** Read an owned copy into bounded memory. Never extract paths, follow links or execute entries. */
export declare function readBoundedZip(input: Uint8Array, limits: ZipReadLimits, allow: (path: string) => boolean): Promise<Map<string, Buffer>>;

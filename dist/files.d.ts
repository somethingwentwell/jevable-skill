/** Read a bounded regular file, including protection against growth after stat. */
export declare function readBoundedFile(path: string, maxBytes: number): Promise<string>;
export declare function readBoundedBytes(path: string, maxBytes: number): Promise<Buffer>;
/** Inspection inputs must not wait for a pipe writer. POSIX also refuses a final symlink atomically.
 * Keep ordinary caller-selected workflow/file reads on their existing, separate path.
 */
export declare function readBoundedRegularBytes(path: string, maxBytes: number): Promise<Buffer>;
/** Same-directory atomic publication; default mode refuses existing files, including symlinks. */
export declare function writeArtifact(path: string, content: string | Uint8Array, overwrite?: boolean): Promise<{
    path: string;
    bytes: number;
    sha256: string;
}>;

/** Shared sanitized error identity; importing it never initializes a database driver. */
export declare class JournalError extends Error {
    readonly code: 'invalid-config' | 'invalid-command' | 'busy' | 'uninitialized' | 'version-mismatch' | 'conflict' | 'limit' | 'corrupt' | 'unavailable' | 'ownership-lost' | 'commit-uncertain' | 'closed';
    constructor(code: 'invalid-config' | 'invalid-command' | 'busy' | 'uninitialized' | 'version-mismatch' | 'conflict' | 'limit' | 'corrupt' | 'unavailable' | 'ownership-lost' | 'commit-uncertain' | 'closed');
}

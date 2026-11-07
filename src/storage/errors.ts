/** Shared sanitized error identity; importing it never initializes a database driver. */
export class JournalError extends Error {
  constructor(readonly code: 'invalid-config' | 'invalid-command' | 'busy' | 'uninitialized' | 'version-mismatch'
    | 'conflict' | 'limit' | 'corrupt' | 'unavailable' | 'ownership-lost' | 'commit-uncertain' | 'closed') {
    super(`Jevable PostgreSQL journal: ${code}. Inspect the original batch identity before retrying a write.`)
    this.name = 'JournalError'
  }
}

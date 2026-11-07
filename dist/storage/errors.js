/** Shared sanitized error identity; importing it never initializes a database driver. */
export class JournalError extends Error {
    code;
    constructor(code) {
        super(`Jevable PostgreSQL journal: ${code}. Inspect the original batch identity before retrying a write.`);
        this.code = code;
        this.name = 'JournalError';
    }
}

/** Shared error identity without loading the HTTP transport, clients or wire schemas. */
export class RuntimeHttpError extends Error {
    code;
    status;
    retryAfterSeconds;
    constructor(code, status, retryAfterSeconds) {
        super(`Jevable HTTP operation failed: ${code}. Inspect retained state before retrying a mutation; reuse the original run or request UUID.`);
        this.code = code;
        this.status = status;
        this.retryAfterSeconds = retryAfterSeconds;
        this.name = 'RuntimeHttpError';
    }
}

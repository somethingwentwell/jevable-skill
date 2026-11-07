/** Shared error identity without loading the HTTP transport, clients or wire schemas. */
export declare class RuntimeHttpError extends Error {
    readonly code: string;
    readonly status?: number | undefined;
    readonly retryAfterSeconds?: number | undefined;
    constructor(code: string, status?: number | undefined, retryAfterSeconds?: number | undefined);
}

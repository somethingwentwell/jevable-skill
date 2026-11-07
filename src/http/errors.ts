/** Shared error identity without loading the HTTP transport, clients or wire schemas. */
export class RuntimeHttpError extends Error {
  constructor(readonly code: string, readonly status?: number, readonly retryAfterSeconds?: number) {
    super(`Jevable HTTP operation failed: ${code}. Inspect retained state before retrying a mutation; reuse the original run or request UUID.`)
    this.name = 'RuntimeHttpError'
  }
}

/** PostgreSQL release entry. Explicit database file on every stateful invocation; no SQLite fallback. */
export declare const releaseMain: (value: unknown, argv: string[], directory: string) => Promise<number>;

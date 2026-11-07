/** Readable schema problems for source and node-configuration errors; not part of the package API. */
/**
 * Name where a value breaks a schema, so an author (or the workflow assistant) can fix it. Paths are
 * source keys and messages are zod's value-free descriptions; no source values are repeated.
 * @param issues - Schema issues from a failed parse.
 * @returns up to five `path: reason` entries joined by `; `, with a count of the rest.
 */
export declare function schemaIssues(issues: readonly {
    path: readonly PropertyKey[];
    message: string;
}[]): string;

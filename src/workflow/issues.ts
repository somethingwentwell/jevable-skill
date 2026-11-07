/** Readable schema problems for source and node-configuration errors; not part of the package API. */

/** At most this many schema problems are named in one error; the rest are counted. */
const MAX_REPORTED_ISSUES = 5

/**
 * Name where a value breaks a schema, so an author (or the workflow assistant) can fix it. Paths are
 * source keys and messages are zod's value-free descriptions; no source values are repeated.
 * @param issues - Schema issues from a failed parse.
 * @returns up to five `path: reason` entries joined by `; `, with a count of the rest.
 */
export function schemaIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  const named = issues.slice(0, MAX_REPORTED_ISSUES).map(issue =>
    `${issue.path.length ? issue.path.map(String).join('.') : '(document)'}: ${issue.message}`)
  const more = issues.length - named.length
  return `${named.join('; ')}${more > 0 ? `; and ${String(more)} more` : ''}.`
}

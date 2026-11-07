/** Recognizable credential field names and embedded credential formats; matching is heuristic, never proof of absence. */
/** Field names whose string values are treated as credentials. */
export declare const secretKey: RegExp;
/** Embedded credential formats: private keys, common API tokens, bearer tokens, URL credentials and quoted assignments. */
export declare const embeddedSecrets: RegExp[];
/**
 * Whether JSON-like data carries a recognizable credential: a non-empty string under a credential field name, an embedded
 * credential format in any string, or a Dify secret environment variable with a value.
 * @param value - Parsed uploaded data.
 * @returns true when a credential is recognized; false does not prove there is none.
 */
export declare function hasCredentials(value: unknown): boolean;

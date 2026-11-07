/** Recognizable credential field names and embedded credential formats; matching is heuristic, never proof of absence. */

/** Field names whose string values are treated as credentials. */
export const secretKey =
  /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secrets?|authorization|cookie|private[_-]?key)$/iu
/** Embedded credential formats: private keys, common API tokens, bearer tokens, URL credentials and quoted assignments. */
export const embeddedSecrets = [
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u,
  /\b(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|AKIA[a-z0-9]{16})\b/iu,
  /\bBearer\s+[a-z0-9._~+/-]{8,}/iu,
  /https?:\/\/[^\s/]+:[^\s/]+@/iu,
  /(?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*["'][^"'\r\n]+["']/iu,
]

/**
 * Whether JSON-like data carries a recognizable credential: a non-empty string under a credential field name, an embedded
 * credential format in any string, or a Dify secret environment variable with a value.
 * @param value - Parsed uploaded data.
 * @returns true when a credential is recognized; false does not prove there is none.
 */
export function hasCredentials(value: unknown): boolean {
  if (typeof value === 'string') return embeddedSecrets.some(pattern => pattern.test(value))
  if (Array.isArray(value)) return value.some(hasCredentials)
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (record.value_type === 'secret' && typeof record.value === 'string' && record.value !== '') return true
  return Object.entries(record).some(([key, item]) => (secretKey.test(key) && typeof item === 'string' && item !== '') || hasCredentials(item))
}

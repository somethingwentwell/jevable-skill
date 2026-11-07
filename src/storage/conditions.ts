import { createHash } from 'node:crypto'
import { z } from 'zod'
import { JournalError } from './errors.ts'

const collection = z.enum(['runs', 'releases', 'access-grants'])
const condition = z.strictObject({ collection, key: z.uuid().transform(value => value.toLowerCase()),
  version: z.string().regex(/^[1-9][0-9]{0,18}$/u).refine(value => BigInt(value) <= 9223372036854775806n),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u) })
export const journalConditionsSchema = z.strictObject({ records: z.array(condition).min(1).max(3),
  notBefore: z.iso.datetime(), expiresAt: z.iso.datetime() })
  .refine(value => Date.parse(value.expiresAt) > Date.parse(value.notBefore)
    && new Set(value.records.map(record => JSON.stringify([record.collection, record.key]))).size === value.records.length)
export type JournalConditions = z.infer<typeof journalConditionsSchema>
function canonical(value: unknown): string {
  return Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(Reflect.get(value, key))).join(',') + '}'
      : JSON.stringify(value)
}
/** Snapshot pin, not a signature or substitute for domain-history validation. */
export const journalConditionHash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
export function parseJournalConditions(value: unknown): JournalConditions {
  const parsed = journalConditionsSchema.safeParse(value)
  if (!parsed.success) throw new JournalError('invalid-command')
  return parsed.data
}
/** A synchronous final time check after queued snapshot reads and before the first write. */
export function checkJournalConditionTime(conditions: JournalConditions, at = new Date().toISOString()) {
  if (!z.iso.datetime().safeParse(at).success || Date.parse(at) < Date.parse(conditions.notBefore)
    || Date.parse(at) >= Date.parse(conditions.expiresAt)) throw new JournalError('conflict')
}

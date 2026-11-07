import { z } from 'zod'
import { WorkflowRuntimeError } from '../runtime/errors.ts'

const limit = z.number().int().min(1).max(200).default(100)
export const recordPageSchema = z.strictObject({ after: z.uuid().optional(), limit })
export const auditPageSchema = z.strictObject({
  after: z.string().refine(value => /^(0|[1-9][0-9]{0,18})$/u.test(value)
    && BigInt(value) <= 9223372036854775806n).optional(), limit,
})

/** Legacy SQLite lists keep their existing order. Explicit pages use immutable identity keysets. */
export function recordPage<T extends { id: string }>(rows: T[], after: string | undefined, limit: number) {
  const sorted = rows.filter(row => after === undefined || row.id > after)
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const items = sorted.slice(0, limit)
  return { items, nextCursor: sorted.length > limit ? items.at(-1)!.id : null }
}

export function auditPage(rows: unknown[], after: string | undefined, limit: number) {
  const checked = rows.map(row => {
    if (!row || typeof row !== 'object' || !('sequence' in row)
      || typeof row.sequence !== 'number' || !Number.isSafeInteger(row.sequence) || row.sequence < 1) {
      throw new WorkflowRuntimeError('corrupt')
    }
    return { row, sequence: row.sequence }
  })
  const items = checked.filter(item => BigInt(item.sequence) > BigInt(after ?? '0'))
    .sort((a, b) => a.sequence - b.sequence).slice(0, limit)
  return { events: items.map(item => item.row), cursor: String(items.at(-1)?.sequence ?? after ?? '0') }
}

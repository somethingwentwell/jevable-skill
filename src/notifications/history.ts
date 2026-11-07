import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { approvalNotificationKind, notificationRecordSchema, inspectNotificationRecord, notificationSemantics, type NotificationRecord } from './schema.ts'

export const notificationFilterSchema = z.strictObject({
  outcome: z.enum(['pending', 'accepted', 'rejected', 'uncertain']).optional(),
  eventKind: approvalNotificationKind.optional(),
  createdFrom: z.iso.datetime({ precision: 3 }).optional(),
  createdBefore: z.iso.datetime({ precision: 3 }).optional(),
}).refine(value => Object.values(value).some(v => v !== undefined)
  && (value.createdFrom === undefined || value.createdBefore === undefined || Date.parse(value.createdFrom) < Date.parse(value.createdBefore)))
  .transform(value => {
    const filter = { ...value }
    for (const key of ['outcome', 'eventKind', 'createdFrom', 'createdBefore'] as const) if (filter[key] === undefined) delete filter[key]
    return filter
  })
export type NotificationFilter = z.input<typeof notificationFilterSchema>
export const notificationKeysetPageRequestSchema = z.strictObject({ after: z.uuid().optional(), limit: z.number().int().min(1).max(200).default(100) })
export const notificationPageRequestSchema = notificationKeysetPageRequestSchema.extend({ filter: notificationFilterSchema.optional() })
export type NotificationPageRequest = z.input<typeof notificationPageRequestSchema>
export const notificationSummarySchema = notificationRecordSchema.pick({ request: true, createdAt: true, outcome: true }).extend({
  trace: notificationRecordSchema.shape.telemetry.unwrap().shape.trace.optional(),
})
export type NotificationSummary = z.infer<typeof notificationSummarySchema>
export const notificationPageSchema = z.strictObject({ schemaVersion: z.literal(1),
  deliveries: z.array(notificationSummarySchema).max(200), nextCursor: z.uuid().nullable(),
  order: z.literal('request-id-ascending'), consistency: z.literal('live-keyset; not-a-snapshot'),
  semantics: z.literal(notificationSemantics),
  filter: notificationFilterSchema.optional(),
})
export type NotificationPage = z.infer<typeof notificationPageSchema>

export function parseNotificationPage(value: NotificationPageRequest) {
  const parsed = notificationPageRequestSchema.safeParse(value)
  if (!parsed.success) throw new WorkflowRuntimeError('invalid-command')
  return parsed.data
}

/** Metadata only: no event body, actor, credential generation, signing material or private review data. */
export function notificationSummary(value: NotificationRecord): NotificationSummary {
  const record = inspectNotificationRecord(value)
  return { request: record.request, createdAt: record.createdAt, outcome: record.outcome,
    ...(record.telemetry ? { trace: record.telemetry.trace } : {}) }
}

/** Used on storage results and untrusted remote CLI replies. UUID order is identity order, never time order. */
export function inspectNotificationPage(value: unknown, request: NotificationPageRequest): NotificationPage {
  const options = parseNotificationPage(request), parsed = notificationPageSchema.safeParse(value)
  if (!parsed.success) throw new WorkflowRuntimeError('corrupt')
  const page = parsed.data
  if (!isDeepStrictEqual(page.filter, options.filter)) throw new WorkflowRuntimeError('corrupt')
  if (page.deliveries.length > options.limit) throw new WorkflowRuntimeError('corrupt')
  let previous = options.after
  for (const row of page.deliveries) {
    if (previous !== undefined && row.request.requestId <= previous
      || row.request.redeliverOf === row.request.requestId
      || !notificationMatchesFilter(row, options.filter)
      || row.outcome.status === 'settled' && Date.parse(row.outcome.at) < Date.parse(row.createdAt)) throw new WorkflowRuntimeError('corrupt')
    previous = row.request.requestId
  }
  if (page.nextCursor !== null && (page.deliveries.length !== options.limit || page.nextCursor !== previous))
    throw new WorkflowRuntimeError('corrupt')
  return page
}

export function notificationPage(records: NotificationRecord[], nextCursor: string | null, options: NotificationPageRequest): NotificationPage {
  return inspectNotificationPage({ schemaVersion: 1, deliveries: records.map(notificationSummary), nextCursor,
    ...(options.filter === undefined ? {} : { filter: options.filter }),
    order: 'request-id-ascending', consistency: 'live-keyset; not-a-snapshot', semantics: notificationSemantics }, options)
}

/** Thin retained metadata only. Creation time is admission time, not lifecycle time or delivery proof. */
export function notificationMatchesFilter(row: Pick<NotificationRecord, 'request' | 'createdAt' | 'outcome'>,
  filter: NotificationFilter | undefined) {
  if (!filter) return true
  const outcome = row.outcome.status === 'pending' ? 'pending' : row.outcome.result.status
  const created = Date.parse(row.createdAt)
  return (filter.outcome === undefined || filter.outcome === outcome)
    && (filter.eventKind === undefined || filter.eventKind === (row.request.eventKind ?? 'requested'))
    && (filter.createdFrom === undefined || created >= Date.parse(filter.createdFrom))
    && (filter.createdBefore === undefined || created < Date.parse(filter.createdBefore))
}

export interface NotificationPageReader {
  get(id: string): NotificationRecord | undefined | Promise<NotificationRecord | undefined>
  page(options: NotificationPageRequest): { records: NotificationRecord[]; nextCursor: string | null }
    | Promise<{ records: NotificationRecord[]; nextCursor: string | null }>
}

/** Bounded filtered live traversal. Cursors must still match the current query and optional scope. */
export async function filteredNotificationRecords(reader: NotificationPageReader, pageValue: NotificationPageRequest,
  scopeMatches: (record: NotificationRecord) => boolean = () => true) {
  const options = parseNotificationPage(pageValue)
  const matches = (value: NotificationRecord) => {
    const record = inspectNotificationRecord(value)
    return scopeMatches(record) && notificationMatchesFilter(record, options.filter)
  }
  if (options.after !== undefined) {
    const cursor = await reader.get(options.after)
    if (cursor && cursor.request.requestId !== options.after) throw new WorkflowRuntimeError('corrupt')
    if (!cursor || !matches(cursor)) throw new WorkflowRuntimeError('not-found')
  }
  const records: NotificationRecord[] = []
  let after = options.after, scanned = 0
  while (true) {
    const request = { ...(after === undefined ? {} : { after }), limit: 200 }
    const page = await reader.page(request)
    notificationPage(page.records, page.nextCursor, request)
    if ((scanned += page.records.length) > 100000) throw new WorkflowRuntimeError('limit')
    for (const record of page.records) {
      if (!matches(record)) continue
      if (records.length === options.limit) return { records, nextCursor: records.at(-1)!.request.requestId }
      records.push(record)
    }
    if (page.nextCursor === null) return { records, nextCursor: null }
    after = page.nextCursor
  }
}

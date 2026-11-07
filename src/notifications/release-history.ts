import { z } from 'zod'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { inspectNotificationRecord, type NotificationRecord } from './schema.ts'
import { filteredNotificationRecords, parseNotificationPage, type NotificationPageRequest } from './history.ts'

const hash = z.string().regex(/^[a-f0-9]{64}$/u)
export const notificationReleaseScopeSchema = z.strictObject({ id: z.uuid(), sha256: hash, revision: hash })
export type NotificationReleaseScope = z.infer<typeof notificationReleaseScopeSchema>

/** Scan bounded keyset batches, retaining only one result page. Never expose foreign IDs as cursors.
 * This is a live filtered traversal, not an indexed release query or a cross-batch snapshot.
 */
export async function releaseNotificationPage(reader: {
  get(id: string): NotificationRecord | undefined | Promise<NotificationRecord | undefined>
  page(options: NotificationPageRequest): { records: NotificationRecord[]; nextCursor: string | null }
    | Promise<{ records: NotificationRecord[]; nextCursor: string | null }>
}, scopeValue: NotificationReleaseScope, pageValue: NotificationPageRequest) {
  const parsed = notificationReleaseScopeSchema.safeParse(scopeValue), options = parseNotificationPage(pageValue)
  if (!parsed.success) throw new WorkflowRuntimeError('invalid-command')
  const scope = parsed.data
  const matches = (value: NotificationRecord) => {
    const record = inspectNotificationRecord(value), release = record.event.data.release
    return release?.id === scope.id && release.sha256 === scope.sha256 && record.request.revision === scope.revision
  }
  return filteredNotificationRecords(reader, options, matches)
}

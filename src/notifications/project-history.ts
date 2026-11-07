import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { inspectNotificationRecord, type NotificationRecord } from './schema.ts'
import { filteredNotificationRecords, notificationPageSchema, parseNotificationPage, inspectNotificationPage,
  type NotificationPageRequest } from './history.ts'

export const notificationProjectScopeSchema = z.strictObject({ id: z.uuid(),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), revision: z.string().regex(/^[a-f0-9]{64}$/u) })
export type NotificationProjectScope = z.infer<typeof notificationProjectScopeSchema>
export const projectNotificationPageSchema = notificationPageSchema.extend({ project: notificationProjectScopeSchema })
export type ProjectNotificationPage = z.infer<typeof projectNotificationPageSchema>

export function parseNotificationProjectScope(value: NotificationProjectScope): NotificationProjectScope {
  const parsed = notificationProjectScopeSchema.safeParse(value)
  if (!parsed.success) throw new WorkflowRuntimeError('invalid-command')
  return parsed.data
}

/** Validate remote metadata and its explicit historical project pin, not today's project generation. */
export function inspectProjectNotificationPage(value: unknown, project: NotificationProjectScope,
  options: NotificationPageRequest): ProjectNotificationPage {
  const scope = parseNotificationProjectScope(project), parsed = projectNotificationPageSchema.safeParse(value)
  if (!parsed.success || !isDeepStrictEqual(parsed.data.project, scope)) throw new WorkflowRuntimeError('corrupt')
  if (parsed.data.deliveries.some(row => row.request.revision !== scope.revision)) throw new WorkflowRuntimeError('corrupt')
  const { project: _project, ...page } = parsed.data
  return { ...inspectNotificationPage(page, options), project: scope }
}

/** Bounded live keyset traversal; foreign identities are never returned as pagination cursors.
 * Event/run provenance is validated by the owner, not inferred from a current project lookup.
 */
export async function projectNotificationRecords(reader: {
  get(id: string): NotificationRecord | undefined | Promise<NotificationRecord | undefined>
  page(options: NotificationPageRequest): { records: NotificationRecord[]; nextCursor: string | null }
    | Promise<{ records: NotificationRecord[]; nextCursor: string | null }>
}, scopeValue: NotificationProjectScope, pageValue: NotificationPageRequest) {
  const scope = parseNotificationProjectScope(scopeValue), options = parseNotificationPage(pageValue)
  const matches = (value: NotificationRecord) => {
    const record = inspectNotificationRecord(value), project = record.event.data.project
    return project?.id === scope.id && project.generation === scope.generation && record.request.revision === scope.revision
  }
  return filteredNotificationRecords(reader, options, matches)
}

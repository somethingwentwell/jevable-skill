import type { NotificationPageRequest } from '../notifications/history.ts';
import type { NotificationProjectScope, ProjectNotificationPage } from '../notifications/project-history.ts';
/** Serialized, import-free metadata admission. Never owner-wide history, private events or dispatch. */
export declare function projectPreviewNotificationHistory(scope: NotificationProjectScope, page: NotificationPageRequest, value: unknown): ProjectNotificationPage;

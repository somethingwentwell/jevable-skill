import { type NotificationEndpoint, type ApprovalNotificationEvent, type NotificationResult } from './schema.ts';
/** Standard Webhooks v1 HMAC key encoding; never retain this key or the signature in a delivery record. */
export declare function notificationSigningKey(value: string): Buffer;
/** Exactly one POST. No redirects, automatic retries, response-body retention or ambient proxy configuration. */
export declare function postApprovalNotification(endpointValue: NotificationEndpoint, eventValue: ApprovalNotificationEvent, secret: string, signal?: AbortSignal): Promise<NotificationResult>;

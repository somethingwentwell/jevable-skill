import { type ReleaseWebhookConfig } from '../releases/webhooks.ts';
export declare function readReleaseWebhookFile(file: unknown): Promise<ReleaseWebhookConfig | undefined>;

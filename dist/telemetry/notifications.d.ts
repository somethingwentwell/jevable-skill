import { type Attributes, type SpanContext, type Tracer } from '@opentelemetry/api';
import { type NotificationRecord } from '../notifications/schema.ts';
import type { NotificationObservation } from '../notifications/observation.ts';
import type { LocalRun } from '../runtime/run-types.ts';
export declare const NOTIFICATION_METRIC_LABELS: string[];
/** Fixed diagnostics only. No endpoint names/URLs, credential references, actor, body, headers or raw errors. */
export declare function observeNotification(tracer: Tracer, record: NotificationRecord, run: LocalRun, previous: NotificationRecord | undefined, parent: SpanContext | undefined, settled: (attributes: Attributes, seconds: number, context: SpanContext, failed: boolean) => void): NotificationObservation;

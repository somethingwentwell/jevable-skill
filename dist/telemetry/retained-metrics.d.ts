import type { Meter } from '@opentelemetry/api';
import { type RetainedMetricSnapshot } from '../runtime/retained-metrics.ts';
import { type ResourceMetrics } from '@opentelemetry/sdk-metrics';
export type RetainedMetricSource = () => RetainedMetricSnapshot;
export declare const RETAINED_METRIC_LABELS: string[];
/** Cumulative SDK storage keeps unobserved gauges. Never serialize those stale values as current state. */
export declare function omitUnavailableRetainedMetrics(resource: ResourceMetrics): void;
export declare function installRetainedMetrics(meter: Meter, read: RetainedMetricSource): void;

import type { Meter } from '@opentelemetry/api';
import { type ResourceMetrics } from '@opentelemetry/sdk-metrics';
type Occupancy = {
    waiting: number;
    active: number;
};
export type StorageQueueMetricSnapshot = {
    available: false;
} | {
    available: true;
    domain: Occupancy;
    journal: Occupancy;
};
export type StorageQueueMetricSource = () => StorageQueueMetricSnapshot;
export declare const STORAGE_QUEUE_LABELS: string[];
/** The cumulative SDK may retain unobserved gauges; unknown occupancy must not reuse stale counts. */
export declare function omitUnavailableStorageQueueMetrics(resource: ResourceMetrics): void;
export declare function installStorageQueueMetrics(meter: Meter, read: StorageQueueMetricSource): void;
export {};

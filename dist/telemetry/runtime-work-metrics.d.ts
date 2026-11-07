import type { Meter } from '@opentelemetry/api';
import { type ResourceMetrics } from '@opentelemetry/sdk-metrics';
export type RuntimeWorkMetricSnapshot = {
    available: false;
} | {
    available: true;
    operations: number;
    runReservations: number;
};
export type RuntimeWorkMetricSource = () => RuntimeWorkMetricSnapshot;
/** The SDK can retain old observable gauges; unknown ownership must not export stale work. */
export declare function omitUnavailableRuntimeWorkMetrics(resource: ResourceMetrics): void;
/** Samples existing owner counters only. No dispatch, storage access, identity labels or reconstruction. */
export declare function installRuntimeWorkMetrics(meter: Meter, read: RuntimeWorkMetricSource): void;

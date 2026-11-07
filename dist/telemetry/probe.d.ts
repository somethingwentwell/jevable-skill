import { type Resource } from '@opentelemetry/resources';
import { type OtlpCredential } from './otlp.ts';
import type { TelemetryPolicy } from './config.ts';
import { type CollectorProbeReport } from './probe-report.ts';
export { collectorProbeReportSchema, disabledCollectorProbe } from './probe-report.ts';
export type { CollectorProbeReport } from './probe-report.ts';
/** Exactly one independent synthetic record per configured signal, never workflow queues or global providers. */
export declare function probeCollector(policy: TelemetryPolicy, credential: OtlpCredential, resource: Resource, controller: AbortController): Promise<CollectorProbeReport>;

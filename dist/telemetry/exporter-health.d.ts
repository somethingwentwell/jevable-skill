import type { Meter } from '@opentelemetry/api';
export interface ExporterHealthSnapshot {
    accepted: number;
    exported: number;
    rejected: number;
    dropped: number;
    failedBatches: number;
    successfulBatches: number;
    queued: number;
    inFlight: number;
    lastSuccessAt: string | null;
    lastFailure: string | null;
}
export type ExporterHealthSource = () => Partial<Record<'traces' | 'metrics' | 'logs', ExporterHealthSnapshot>>;
export declare const EXPORTER_HEALTH_LABELS: string[];
/** Private provider only. Fixed vocabularies; no destinations, IDs, credentials or error messages. */
export declare function installExporterHealthMetrics(meter: Meter, read: ExporterHealthSource): void;

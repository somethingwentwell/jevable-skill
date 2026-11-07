import { type Meter } from '@opentelemetry/api';
import { type ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { type SQLiteStatementSnapshot } from '../storage/sqlite-statistics.ts';
export type SQLiteStatementMetricSource = () => SQLiteStatementSnapshot;
export declare const SQLITE_STATEMENT_LABELS: string[];
export declare function omitUnavailableSQLiteStatementMetrics(resource: ResourceMetrics): void;
export declare function installSQLiteStatementMetrics(meter: Meter, read: SQLiteStatementMetricSource): (resource: ResourceMetrics) => void;

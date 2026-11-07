import { type Meter } from '@opentelemetry/api';
import { type ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { type TransactionMetricSnapshot } from '../storage/transaction-statistics.ts';
export type StorageTransactionMetricSource = () => TransactionMetricSnapshot;
export declare const STORAGE_TRANSACTION_LABELS: string[];
export declare function omitUnavailableStorageTransactionMetrics(resource: ResourceMetrics): void;
export declare function installStorageTransactionMetrics(meter: Meter, read: StorageTransactionMetricSource): (resource: ResourceMetrics) => void;

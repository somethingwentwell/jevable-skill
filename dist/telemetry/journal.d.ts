import { type Attributes, type SpanContext, type Tracer } from '@opentelemetry/api';
import { type TransactionKind } from '../storage/transaction-statistics.ts';
import type { JournalTransactionObservation } from '../storage/transaction-observation.ts';
/** Active local journal paths only; no admission wait, SQL metadata, receipts or historical reconstruction. */
export declare function observeJournalTransaction(tracer: Tracer, kind: TransactionKind, parent: SpanContext | undefined, settled: (attributes: Attributes, seconds: number, context: SpanContext, failed: boolean) => void): JournalTransactionObservation;

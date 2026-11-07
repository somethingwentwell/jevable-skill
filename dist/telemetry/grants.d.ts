import { type Attributes, type SpanContext, type Tracer } from '@opentelemetry/api';
export type GrantOperation = 'get' | 'page' | 'issue' | 'revoke';
export type GrantOperationOutcome = 'returned' | 'threw';
export declare const GRANT_OPERATIONS: Set<GrantOperation>;
export declare const GRANT_METRIC_LABELS: string[];
export interface GrantOperationObservation {
    end(outcome: GrantOperationOutcome): void;
}
/** Counts owned administrative API calls, never permission decisions or unique grant mutations. */
export declare function observeGrantOperation(tracer: Tracer, operation: GrantOperation, parent: SpanContext | undefined, settled: (attributes: Attributes, seconds: number, context: SpanContext, failed: boolean) => void): GrantOperationObservation;
/** Preserve synchronous reads and original values/errors; await only owned native Promise results. */
export declare function observeGrantCall<T>(begin: () => GrantOperationObservation | undefined, work: () => T): T;

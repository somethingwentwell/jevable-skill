import type { AsyncLocalStorage } from 'node:async_hooks';
import { type Attributes, type SpanContext, type Tracer } from '@opentelemetry/api';
export declare const HTTP_METRIC_LABELS: string[];
export interface HttpRequestObservation {
    run<T>(parent: string | undefined, operation: () => T): T;
    /** One owned quota observation, linked without starting/adopting an inbound parent. */
    linkRateAdmission?(context: SpanContext | undefined): void;
    /** Optional response-only correlation, never an inbound parent or permission. */
    responseTraceparent?(): string | undefined;
    end(status: number | undefined, finished: boolean): void;
}
/** Owned request instrumentation, not ambient auto-instrumentation. Never retain raw request data. */
export declare function observeHttpRequest(tracer: Tracer, parents: AsyncLocalStorage<SpanContext | undefined>, method: string | undefined, path: string | undefined, settled: (attributes: Attributes, seconds: number, context: SpanContext, failed: boolean) => void, responseContext?: boolean): HttpRequestObservation;

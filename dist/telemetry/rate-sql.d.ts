import { type Attributes, type SpanContext, type Tracer } from '@opentelemetry/api';
import { type HttpRateSqlOperation, type HttpRateSqlObservation } from '../http/rate-sql-observation.ts';
export declare const HTTP_RATE_SQL_METRIC_LABELS: string[];
/** Child of the explicitly owned quota predicate, never ambient/inbound context or baggage. */
export declare function observeHttpRateSql(tracer: Tracer, operation: HttpRateSqlOperation, parent: SpanContext | undefined, settled: (attributes: Attributes, seconds: number, context: SpanContext, failed: boolean) => void): HttpRateSqlObservation | undefined;

import { type Attributes, type SpanContext, type Tracer } from '@opentelemetry/api';
import type { HttpAccessStage, HttpAccessObservation } from '../http/access-observation.ts';
export declare const HTTP_ACCESS_METRIC_LABELS: string[];
/** Pre-authentication roots never adopt request headers, ambient context or baggage. */
export declare function observeHttpAccess(tracer: Tracer, stage: HttpAccessStage, settled: (attributes: Attributes, seconds: number, context: SpanContext, failed: boolean) => void): HttpAccessObservation;

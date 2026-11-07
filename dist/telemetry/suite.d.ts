import { type Attributes, type SpanContext, type Tracer } from '@opentelemetry/api';
import { type SuiteObservationIdentity, type SuiteObservation, type SuiteCaseSnapshot } from '../testing/suite-observation.ts';
export declare const SUITE_METRIC_LABELS: string[];
export declare const SUITE_CASE_METRIC_LABELS: string[];
/** Real invocation scope; suite titles, case/input/expectation payloads and actors are excluded. */
export declare function observeTestSuite(tracer: Tracer, identity: SuiteObservationIdentity, parent: SpanContext | undefined, scope: (parent: SpanContext, work: () => Promise<unknown>) => unknown, settled: (attributes: Attributes, seconds: number, context: SpanContext, failed: boolean) => void, cases?: (policy: 'stop' | 'continue', before: SuiteCaseSnapshot, after: SuiteCaseSnapshot) => void): SuiteObservation | undefined;

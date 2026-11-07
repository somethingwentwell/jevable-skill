import { type Attributes, type SpanContext, type Tracer } from '@opentelemetry/api';
import type { GrantPolicyAction, GrantPolicyObservation } from '../access/policy-observation.ts';
export declare const GRANT_POLICY_METRIC_LABELS: string[];
/** Policy evaluation is not a mutation receipt, lookup audit or permission to execute later. */
export declare function observeGrantPolicyDecision(tracer: Tracer, action: GrantPolicyAction, parent: SpanContext | undefined, settled: (attributes: Attributes, seconds: number, context: SpanContext, failed: boolean) => void): GrantPolicyObservation;

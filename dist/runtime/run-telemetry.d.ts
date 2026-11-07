/** Span lifecycle helpers; the runtime owner supplies the provider and exporter. */
import { type Span } from '@opentelemetry/api';
import type { JevableRunTrace } from './run-types.ts';
export declare function endRunSpan(span: Span | undefined, outcome: 'completed' | 'paused' | 'stopped' | 'invalid-node-value' | 'commit-or-execution-failed'): void;
/**
 * Retain only the context of an actual span, without payloads or ambient trace state.
 * @param span - Live private-provider span, or undefined when no attempt span exists.
 * @returns standard trace/span identifiers; these do not guarantee collector delivery.
 */
export declare function savedRunTrace(span: Span | undefined): JevableRunTrace | undefined;
/** Call only after result persistence acknowledges; route metadata never authorizes work. */
export declare function observeCommittedRuleRoute(span: Span | undefined, port: string | undefined): void;

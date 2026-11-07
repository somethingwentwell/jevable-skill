import type { SpanContext } from '@opentelemetry/api';
/** Fixed transport predicates, not durable authorization or operation outcomes. */
export declare const HTTP_ACCESS_STAGES: readonly ["headers", "owner-key", "preview-session", "local-bootstrap", "grant-token-syntax", "instance", "protocol", "release-pin", "signed-webhook", "local-rate-requests", "local-rate-controls", "coordinated-rate-requests", "coordinated-rate-controls"];
export type HttpAccessStage = typeof HTTP_ACCESS_STAGES[number];
export type HttpAccessOutcome = 'admitted' | 'refused' | 'failed';
export interface HttpAccessObservation {
    /** Diagnostic identity only; no inbound context or admission authority. */
    traceContext?(): SpanContext | undefined;
    end(outcome: HttpAccessOutcome): void;
}
/** Invoke the predicate exactly once. Diagnostic adapters cannot replace its result/error. */
export declare function httpAccessGuard<T>(observe: (() => HttpAccessObservation | undefined) | undefined, work: () => T, refused: (error: unknown) => boolean): T;
/** Explicit async boundary; await only the original operation, never a diagnostic callback. */
export declare function httpAccessGuardAsync<T>(observe: (() => HttpAccessObservation | undefined) | undefined, work: () => Promise<T>, refused: (error: unknown) => boolean): Promise<T>;

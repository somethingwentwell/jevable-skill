import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { TRANSACTION_OUTCOMES } from "../storage/transaction-statistics.js";
/** Active local journal paths only; no admission wait, SQL metadata, receipts or historical reconstruction. */
export function observeJournalTransaction(tracer, kind, parent, settled) {
    const attributes = { 'jevable.storage.transaction.kind': kind }, started = performance.now();
    const span = tracer.startSpan('jevable.storage.journal.transaction', { kind: SpanKind.INTERNAL, attributes }, parent ? trace.setSpanContext(ROOT_CONTEXT, parent) : ROOT_CONTEXT);
    let ended = false;
    return { end(outcome) {
            if (ended)
                return;
            ended = true;
            try {
                const seconds = (performance.now() - started) / 1000;
                if (!TRANSACTION_OUTCOMES.includes(outcome) || !Number.isFinite(seconds) || seconds < 0) {
                    span.end();
                    return;
                }
                const failed = outcome !== 'acknowledged', data = { ...attributes, 'jevable.storage.transaction.outcome': outcome,
                    ...(failed ? { 'error.type': outcome === 'commit-uncertain' ? 'journal_commit_uncertain' : 'journal_failed_before_commit' } : {}) };
                span.setAttributes(data);
                span.setStatus({ code: failed ? SpanStatusCode.ERROR : SpanStatusCode.OK });
                span.end();
                settled(data, seconds, span.spanContext(), failed);
            }
            catch { /* Diagnostics never change transaction results/errors, ownership, durability or retry authority. */ }
        } };
}

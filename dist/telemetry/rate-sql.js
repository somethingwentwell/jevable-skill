import { ROOT_CONTEXT, trace, isSpanContextValid, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { HTTP_RATE_SQL_OPERATIONS } from "../http/rate-sql-observation.js";
export const HTTP_RATE_SQL_METRIC_LABELS = ['jevable.http.rate.sql.operation', 'jevable.http.rate.sql.outcome'];
const names = { begin: 'BEGIN', lock: 'SELECT', debit: 'UPDATE', commit: 'COMMIT', rollback: 'ROLLBACK' };
/** Child of the explicitly owned quota predicate, never ambient/inbound context or baggage. */
export function observeHttpRateSql(tracer, operation, parent, settled) {
    if (!HTTP_RATE_SQL_OPERATIONS.includes(operation) || !parent || !isSpanContextValid(parent))
        return undefined;
    const attributes = { 'db.system.name': 'postgresql', 'db.operation.name': names[operation], 'jevable.http.rate.sql.operation': operation };
    const started = performance.now(), span = tracer.startSpan('jevable.http.rate.sql', { kind: SpanKind.CLIENT, attributes }, trace.setSpanContext(ROOT_CONTEXT, { traceId: parent.traceId, spanId: parent.spanId, traceFlags: parent.traceFlags }));
    let ended = false;
    return { end(outcome) {
            if (ended)
                return;
            ended = true;
            try {
                const seconds = Math.max(0, performance.now() - started) / 1000;
                if (!['acknowledged', 'failed', 'uncertain'].includes(outcome) || !Number.isFinite(seconds)) {
                    span.end();
                    return;
                }
                const failed = outcome !== 'acknowledged', data = { ...attributes, 'jevable.http.rate.sql.outcome': outcome,
                    ...(failed ? { 'error.type': outcome === 'uncertain' ? 'http_rate_commit_uncertain' : 'http_rate_sql_failed' } : {}) };
                span.setAttributes(data);
                if (failed)
                    span.setStatus({ code: SpanStatusCode.ERROR });
                span.end();
                settled(data, seconds, span.spanContext(), failed);
            }
            catch { /* Diagnostics cannot alter admission or SQL ownership. */ }
        } };
}

import { ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import { notificationTelemetrySchema } from "../notifications/schema.js";
export const NOTIFICATION_METRIC_LABELS = ['jevable.notification.outcome', 'jevable.notification.intent_acknowledged',
    'jevable.notification.transport_attempted', 'jevable.notification.settlement_acknowledged'];
const OUTCOMES = new Set(['intent-not-acknowledged', 'settlement-not-acknowledged', 'receipt-only', 'accepted', 'rejected', 'uncertain']);
const REASONS = new Set(['transport', 'timeout', 'aborted', 'invalid-response']);
/** Fixed diagnostics only. No endpoint names/URLs, credential references, actor, body, headers or raw errors. */
export function observeNotification(tracer, record, run, previous, parent, settled) {
    const workflow = run.traceSegments?.at(-1)?.trace, predecessor = previous?.telemetry?.trace;
    const attributes = { 'jevable.run.id': record.request.runId, 'jevable.workflow.revision': record.request.revision,
        'jevable.attempt.id': record.request.attemptId, 'jevable.notification.request_id': record.request.requestId,
        'jevable.notification.event_id': record.event.id, 'jevable.notification.endpoint_sha256': record.request.endpointSha256,
        'jevable.notification.event_kind': record.request.eventKind ?? 'requested',
        ...(record.request.redeliverOf ? { 'jevable.notification.redeliver_of': record.request.redeliverOf } : {}) };
    for (const [name, context] of [['workflow', workflow], ['previous', predecessor]])
        if (context) {
            attributes[`jevable.notification.${name}.trace_id`] = context.traceId;
            attributes[`jevable.notification.${name}.span_id`] = context.spanId;
        }
    const links = [workflow, predecessor].filter((context) => Boolean(context));
    const span = tracer.startSpan('jevable.notification.delivery', { attributes, links: links.map(context => ({ context })) }, parent ? trace.setSpanContext(ROOT_CONTEXT, parent) : ROOT_CONTEXT);
    const context = span.spanContext(), telemetry = notificationTelemetrySchema.parse({ trace: {
            traceId: context.traceId, spanId: context.spanId, traceFlags: context.traceFlags & 1
        },
        ...(workflow ? { workflow } : {}), ...(predecessor ? { previous: predecessor } : {}),
        ...(parent ? { parent: { traceId: parent.traceId, spanId: parent.spanId, traceFlags: parent.traceFlags & 1 } } : {}) });
    const started = performance.now();
    let ended = false;
    return { telemetry, finish(result) {
            if (ended)
                return;
            ended = true;
            const data = { ...attributes, 'jevable.notification.outcome': OUTCOMES.has(result.outcome) ? result.outcome : 'other',
                'jevable.notification.intent_acknowledged': result.intentAcknowledged === true,
                'jevable.notification.transport_attempted': result.transportAttempted === true,
                'jevable.notification.settlement_acknowledged': result.settlementAcknowledged === true,
                ...(Number.isInteger(result.httpStatus) && result.httpStatus >= 200 && result.httpStatus <= 599 ? { 'http.response.status_code': result.httpStatus } : {}),
                ...(result.reason !== undefined && REASONS.has(result.reason) ? { 'jevable.notification.uncertainty': result.reason } : {}) };
            const failed = result.outcome !== 'accepted' && result.outcome !== 'receipt-only';
            span.setAttributes(data);
            span.setStatus({ code: failed ? SpanStatusCode.ERROR : SpanStatusCode.OK });
            span.end();
            settled(data, Math.max(0, performance.now() - started) / 1000, context, failed);
        } };
}

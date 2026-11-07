/** Span lifecycle helpers; the runtime owner supplies the provider and exporter. */
import { SpanStatusCode } from '@opentelemetry/api';
export function endRunSpan(span, outcome) {
    span?.setAttribute('jevable.outcome', outcome);
    span?.setStatus({ code: ['completed', 'paused', 'stopped'].includes(outcome) ? SpanStatusCode.OK : SpanStatusCode.ERROR });
    span?.end();
}
/**
 * Retain only the context of an actual span, without payloads or ambient trace state.
 * @param span - Live private-provider span, or undefined when no attempt span exists.
 * @returns standard trace/span identifiers; these do not guarantee collector delivery.
 */
export function savedRunTrace(span) {
    if (!span)
        return undefined;
    const { traceId, spanId, traceFlags } = span.spanContext();
    return { traceId: traceId, spanId: spanId, traceFlags: traceFlags & 1 ? 1 : 0 };
}
/** Call only after result persistence acknowledges; route metadata never authorizes work. */
export function observeCommittedRuleRoute(span, port) {
    if (!port || port.length > 128 || !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(port))
        return;
    try {
        span?.setAttributes({ 'jevable.rule.port': port, 'jevable.rule.settled': true });
    }
    catch { /* Diagnostics cannot replace the committed result or trigger another write. */ }
}

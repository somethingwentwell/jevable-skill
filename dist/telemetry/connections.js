import { ROOT_CONTEXT, SpanKind, SpanStatusCode } from '@opentelemetry/api';
export const HTTP_TRANSPORTS = new Set(['loopback-http', 'direct-https']);
export const HTTP_TRANSPORT_FAILURES = new Set(['http-parser', 'http-client', 'tls-handshake', 'connection-limit']);
export const CONNECTION_METRIC_LABELS = ['jevable.http.transport', 'jevable.http.connection.outcome', 'jevable.http.transport.failure'];
/** Socket diagnostics are independent roots: neither peers nor inbound propagation are admitted. */
export function observeHttpConnection(tracer, transport, opened, settled) {
    const attributes = { 'jevable.http.transport': transport }, started = performance.now();
    const span = tracer.startSpan('jevable.http.connection', { kind: SpanKind.SERVER, attributes }, ROOT_CONTEXT);
    try {
        opened(attributes);
    }
    catch { /* Signal failure must not affect socket admission. */ }
    let ended = false;
    return { end(hadError) {
            if (ended)
                return;
            ended = true;
            const failed = hadError === true, data = { ...attributes, 'jevable.http.connection.outcome': failed ? 'socket-error' : 'closed' };
            try {
                span.setAttributes(data);
                if (failed)
                    span.setStatus({ code: SpanStatusCode.ERROR });
                span.end();
            }
            catch { /* Independent signals still get a settlement attempt. */ }
            try {
                settled(data, Math.max(0, performance.now() - started) / 1000, span.spanContext(), failed);
            }
            catch { /* Best effort. */ }
        } };
}
/** One observation per emitted failure; not unique failed peers, rejected requests or audit evidence. */
export function observeHttpTransportFailure(tracer, transport, failure, settled) {
    const attributes = { 'jevable.http.transport': transport, 'jevable.http.transport.failure': failure, 'error.type': failure };
    const span = tracer.startSpan('jevable.http.transport.failure', { kind: SpanKind.SERVER, attributes }, ROOT_CONTEXT);
    try {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
    }
    catch { /* Diagnostics only. */ }
    try {
        settled(attributes, 0, span.spanContext(), true);
    }
    catch { /* Best effort. */ }
}

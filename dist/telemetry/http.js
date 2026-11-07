import { ROOT_CONTEXT, SpanKind, SpanStatusCode, TraceFlags, isSpanContextValid, trace } from '@opentelemetry/api';
import { parseTraceParent } from "./config.js";
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH']);
const ROUTES = new Set(['/', '/v1/openapi.json', '/v1/capabilities', '/v1/health', '/v1/operations', '/v1/preview/bootstrap', '/v1/preview/operations', '/v1/preview/logout', '/v1/reviewer/decisions', '/v1/caller/operations', '/v1/caller/stream', '/v1/async-runs', '/v1/webhooks']);
export const HTTP_METRIC_LABELS = ['http.request.method', 'http.route', 'jevable.http.status_class', 'jevable.http.outcome'];
/** Owned request instrumentation, not ambient auto-instrumentation. Never retain raw request data. */
export function observeHttpRequest(tracer, parents, method, path, settled, responseContext = false) {
    const route = path && ROUTES.has(path) ? path
        : path && /^\/v1\/async-runs\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(path) ? '/v1/async-runs/{id}' : undefined;
    const attributes = { 'http.request.method': method && METHODS.has(method) ? method : '_OTHER',
        ...(route ? { 'http.route': route } : {}) };
    const startTime = Date.now(), started = performance.now();
    let span, ended = false, rateContext;
    // Defer construction until authenticated propagation is admitted, or create a root on rejection.
    // Its timestamp still covers header admission/body reading, not just operation dispatch.
    const start = (parent) => span ??= tracer.startSpan('jevable.http.request', {
        kind: SpanKind.SERVER, startTime, attributes,
        ...(rateContext ? { links: [{ context: rateContext }] } : {}),
    }, parent ? trace.setSpanContext(ROOT_CONTEXT, parent) : ROOT_CONTEXT);
    return {
        linkRateAdmission(context) {
            // Fixed one-link bound; never retain traceState, baggage, custom getters or the source object.
            if (ended || span || rateContext || !context)
                return;
            try {
                const { traceId, spanId, traceFlags } = context;
                if (typeof traceId !== 'string' || typeof spanId !== 'string'
                    || !/^(?!0{32}$)[a-f0-9]{32}$/u.test(traceId) || !/^(?!0{16}$)[a-f0-9]{16}$/u.test(spanId)
                    || (traceFlags !== 0 && traceFlags !== 1))
                    return;
                rateContext = { traceId, spanId, traceFlags };
            }
            catch { /* Best-effort correlation cannot affect admission. */ }
        },
        responseTraceparent() {
            if (!responseContext)
                return undefined;
            try {
                // Called only when emitting headers. Admitted operations already started their
                // span; reads/refusals create an independent root, never adopt a request header.
                const context = start().spanContext();
                if (!isSpanContextValid(context))
                    return undefined;
                return `00-${context.traceId}-${context.spanId}-${context.traceFlags & TraceFlags.SAMPLED ? '01' : '00'}`;
            }
            catch {
                return undefined;
            } // No diagnostic failure changes response or execution.
        },
        run(parent, operation) {
            const admitted = parseTraceParent(parent);
            let context = admitted;
            try {
                if (!ended)
                    context = start(admitted).spanContext();
            }
            catch { /* Diagnostic failure cannot authorize a retry. */ }
            return parents.run(context, operation);
        },
        end(status, finished) {
            if (ended)
                return;
            ended = true;
            try {
                const code = Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
                const failed = !finished || (code !== undefined && code >= 500);
                const data = { ...attributes, ...(code === undefined ? {} : { 'http.response.status_code': code }),
                    ...(rateContext ? { 'jevable.http.rate.trace_id': rateContext.traceId,
                        'jevable.http.rate.span_id': rateContext.spanId, 'jevable.http.rate.sampled': Boolean(rateContext.traceFlags & TraceFlags.SAMPLED) } : {}),
                    'jevable.http.status_class': code === undefined ? 'none' : `${Math.floor(code / 100)}xx`,
                    'jevable.http.outcome': finished ? 'response-finished' : 'disconnected',
                    ...(!finished ? { 'error.type': 'client_disconnected' } : code !== undefined && code >= 500 ? { 'error.type': String(code) } : {}) };
                const active = start();
                active.setAttributes(data);
                if (failed)
                    active.setStatus({ code: SpanStatusCode.ERROR });
                active.end();
                settled(data, Math.max(0, performance.now() - started) / 1000, active.spanContext(), failed);
            }
            catch { /* Best-effort signals never change the HTTP response or durable execution. */ }
        },
    };
}

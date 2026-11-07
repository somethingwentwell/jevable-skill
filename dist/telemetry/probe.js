import { randomUUID } from 'node:crypto';
import { ROOT_CONTEXT, trace, SpanStatusCode } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { TracerProvider, AlwaysOnSampler } from '@opentelemetry/sdk-trace';
import { LoggerProvider } from '@opentelemetry/sdk-logs';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ProtobufTraceSerializer, ProtobufMetricsSerializer, ProtobufLogsSerializer } from '@opentelemetry/otlp-transformer';
import { CORE_VERSION } from "../capabilities.js";
import { ExportFailure, postOtlp } from "./otlp.js";
import { collectorProbeReportSchema } from "./probe-report.js";
// Preserve internal/source consumers while public report exports stay SDK-free.
export { collectorProbeReportSchema, disabledCollectorProbe } from "./probe-report.js";
class ProbeCollectionFailure extends Error {
}
/** No timers, background collection or automatic export in the synthetic metric provider. */
class ProbeMetricReader extends MetricReader {
    // The SDK reserves an overflow slot: two admits our one ordinary, unlabelled point.
    constructor() { super({ cardinalitySelector: () => 2 }); }
    async onForceFlush() { }
    async onShutdown() { }
}
/** Exactly one independent synthetic record per configured signal, never workflow queues or global providers. */
export async function probeCollector(policy, credential, resource, controller) {
    const id = randomUUID(), startedAt = new Date().toISOString();
    const probeResource = resource.merge(resourceFromAttributes({ 'jevable.probe.id': id, 'jevable.synthetic': true }));
    const attributes = { 'jevable.probe.id': id, 'jevable.synthetic': true };
    const spans = [], logs = [];
    const traceProvider = new TracerProvider({ resource: probeResource, sampler: new AlwaysOnSampler(), spanProcessors: [{
                onStart() { }, onEnd(span) { spans.push(span); }, async forceFlush() { }, async shutdown() { },
            }] });
    const span = traceProvider.getTracer('jevable.telemetry.probe', CORE_VERSION).startSpan('jevable.telemetry.probe', { attributes }, ROOT_CONTEXT);
    const context = span.spanContext();
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    const reader = new ProbeMetricReader();
    const meter = new MeterProvider({ resource: probeResource, readers: [reader], sdkMetricsEnabled: false });
    const logger = new LoggerProvider({ resource: probeResource, processors: [{
                onEmit(record) { logs.push(record); }, async forceFlush() { }, async shutdown() { },
            }], loggerConfigurator: () => ({ disabled: false, minimumSeverity: SeverityNumber.INFO, traceBased: false }) });
    const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
    try {
        // The UUID is resource metadata for explicit probe correlation, never an ordinary runtime metric label.
        if (policy.metricsEndpoint)
            meter.getMeter('jevable.telemetry.probe', CORE_VERSION).createCounter('jevable.telemetry.probe', { unit: '{probe}' }).add(1);
        if (policy.logsEndpoint)
            logger.getLogger('jevable.telemetry.probe', CORE_VERSION).emit({
                eventName: 'jevable.telemetry.probe', body: 'jevable.telemetry.probe', severityNumber: SeverityNumber.INFO,
                severityText: 'INFO', attributes, context: trace.setSpanContext(ROOT_CONTEXT, context)
            });
        const send = async (signal, endpoint) => {
            let attempted = false;
            try {
                if (controller.signal.aborted)
                    return { signal, outcome: 'not-sent', records: 1, attempted: false, rejected: null, failure: 'aborted' };
                let bytes;
                try {
                    if (signal === 'traces')
                        bytes = ProtobufTraceSerializer.serializeRequest(spans);
                    else if (signal === 'logs')
                        bytes = ProtobufLogsSerializer.serializeRequest(logs);
                    else {
                        const collection = await reader.collect({ timeoutMillis: policy.timeoutMs }).catch(() => { throw new ProbeCollectionFailure(); });
                        if (collection.errors.length)
                            throw new ProbeCollectionFailure();
                        bytes = ProtobufMetricsSerializer.serializeRequest(collection.resourceMetrics);
                    }
                }
                catch (error) {
                    throw error instanceof ExportFailure || error instanceof ProbeCollectionFailure ? error : new ExportFailure('serialization');
                }
                if (!bytes?.byteLength)
                    throw new ExportFailure('serialization');
                controller.signal.throwIfAborted();
                attempted = true;
                const response = await postOtlp(endpoint, bytes, policy, credential, controller, signal);
                let partial;
                try {
                    partial = signal === 'traces' ? ProtobufTraceSerializer.deserializeResponse(response).partialSuccess
                        : signal === 'metrics' ? ProtobufMetricsSerializer.deserializeResponse(response).partialSuccess
                            : ProtobufLogsSerializer.deserializeResponse(response).partialSuccess;
                }
                catch {
                    throw new ExportFailure('response');
                }
                const rejected = partial?.rejectedSpans ?? partial?.rejectedDataPoints ?? partial?.rejectedLogRecords ?? 0;
                if (!Number.isSafeInteger(rejected) || rejected < 0 || rejected > 1)
                    throw new ExportFailure('response');
                return { signal, outcome: rejected ? 'rejected' : partial ? 'warning' : 'acknowledged', records: 1, attempted,
                    rejected, failure: rejected ? 'partial-rejection' : null };
            }
            catch (error) {
                const aborted = controller.signal.aborted;
                return { signal, outcome: aborted ? 'aborted' : attempted ? 'failed' : 'not-sent', records: 1, attempted, rejected: null,
                    failure: aborted ? 'aborted' : error instanceof ProbeCollectionFailure ? 'collection' : error instanceof ExportFailure ? error.category : 'transport' };
            }
        };
        const signals = await Promise.all([
            ['traces', policy.endpoint], ['metrics', policy.metricsEndpoint], ['logs', policy.logsEndpoint],
        ].flatMap(([signal, endpoint]) => endpoint ? [send(signal, endpoint)] : []));
        const status = signals.some(s => s.outcome === 'aborted' || s.failure === 'aborted') ? 'aborted'
            : signals.some(s => ['failed', 'rejected', 'not-sent'].includes(s.outcome)) ? 'failed'
                : signals.some(s => s.outcome === 'warning') ? 'warning' : 'acknowledged';
        return collectorProbeReportSchema.parse({ schemaVersion: 1, id, startedAt, finishedAt: new Date().toISOString(), status,
            protocol: policy.protocol, signals, trace: { traceId: context.traceId, spanId: context.spanId, traceFlags: 1 },
            execution: 'not-run', retries: false, sampling: 'explicit-synthetic; independent-of-workflow-sampling',
            deliveryGuarantee: 'collector-response-only; not-backend-storage-or-dashboard' });
    }
    finally {
        clearTimeout(timer);
        await Promise.allSettled([traceProvider.shutdown(), meter.shutdown(), logger.shutdown()]);
    }
}

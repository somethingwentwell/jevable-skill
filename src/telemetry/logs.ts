import { ROOT_CONTEXT, trace, SpanStatusCode, type Attributes, type Span, type SpanContext } from '@opentelemetry/api'
import { SeverityNumber, type LogAttributes } from '@opentelemetry/api-logs'
import { LoggerProvider, type LogRecordProcessor, type ReadableLogRecord } from '@opentelemetry/sdk-logs'
import type { Resource } from '@opentelemetry/resources'
import { ProtobufLogsSerializer } from '@opentelemetry/otlp-transformer'
import { CORE_VERSION } from '../capabilities.ts'
import type { TelemetryPolicy } from './config.ts'
import { BoundedOtlpQueue } from './queue.ts'
import { ObservedExecutionSpan } from './span.ts'
import type { OtlpCredential } from './otlp.ts'

class LogQueue extends BoundedOtlpQueue<ReadableLogRecord> implements LogRecordProcessor {
  constructor(policy: TelemetryPolicy, credential: OtlpCredential, canExport: () => boolean) {
    super(policy, policy.logsEndpoint!, credential, records => ProtobufLogsSerializer.serializeRequest(records),
      response => ProtobufLogsSerializer.deserializeResponse(response).partialSuccess?.rejectedLogRecords ?? 0, canExport, 'logs')
  }
  onEmit(record: ReadableLogRecord) { this.enqueue(record) }
}

const OUTCOMES = new Set(['completed', 'paused', 'waiting', 'stopped', 'cancelled', 'failed', 'invalid-node-value',
  'commit-or-execution-failed', 'failed-or-uncertain', 'timeout'])
const KINDS = new Set(['trigger', 'output', 'ifElse', 'switch', 'decision', 'llm', 'humanApproval', 'loop', 'custom'])
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu
const HASH = /^[a-f0-9]{64}$/u
/** Diagnostic IDs are intentionally shared; payloads, names, actors and raw errors are never admitted. */
function metadata(attributes: Attributes): LogAttributes {
  const output: LogAttributes = {}
  for (const key of ['jevable.run.id', 'jevable.attempt.id', 'jevable.project.id', 'jevable.release.id', 'jevable.test.id', 'jevable.model.try.id',
    'jevable.cancellation.request_id']) {
    const value = attributes[key]; if (typeof value === 'string' && UUID.test(value)) output[key] = value
  }
  for (const key of ['jevable.workflow.revision', 'jevable.release.sha256', 'jevable.test.sha256']) {
    const value = attributes[key]; if (typeof value === 'string' && HASH.test(value)) output[key] = value
  }
  const causeTrace = attributes['jevable.cancellation.trace_id'], causeSpan = attributes['jevable.cancellation.span_id']
  if (output['jevable.cancellation.request_id'] && typeof causeTrace === 'string' && /^(?!0{32}$)[a-f0-9]{32}$/u.test(causeTrace)
    && typeof causeSpan === 'string' && /^(?!0{16}$)[a-f0-9]{16}$/u.test(causeSpan)) {
    output['jevable.cancellation.trace_id'] = causeTrace; output['jevable.cancellation.span_id'] = causeSpan
  }
  for (const key of ['jevable.node.id', 'jevable.loop.id']) {
    const value = attributes[key]
    if (typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value)) output[key] = value
  }
  for (const key of ['jevable.attempt.number', 'jevable.project.generation', 'jevable.loop.index', 'jevable.test.generation']) {
    const value = attributes[key]; if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) output[key] = value
  }
  const kind = attributes['jevable.node.kind']
  const number = attributes['jevable.model.try.number']
  if (typeof number === 'number' && Number.isInteger(number) && number >= 1 && number <= 10) output['jevable.model.try.number'] = number
  const delay = attributes['jevable.model.backoff.delay_ms']
  if (typeof delay === 'number' && Number.isInteger(delay) && delay >= 100 && delay <= 3_600_000) output['jevable.model.backoff.delay_ms'] = delay
  if (kind !== undefined) output['jevable.node.kind'] = typeof kind === 'string' && KINDS.has(kind) ? kind : 'other'
  if (attributes['jevable.runtime.mode'] === 'local') output['jevable.runtime.mode'] = 'local'
  if (attributes['jevable.trigger.mode'] === 'api') output['jevable.trigger.mode'] = 'api'
  return output
}

export class RuntimeLogs {
  private readonly provider: LoggerProvider
  private readonly processor: LogQueue
  private readonly logger
  private closing: Promise<void> | undefined
  constructor(policy: TelemetryPolicy, credential: OtlpCredential, resource: Resource, canExport: () => boolean = () => true) {
    this.processor = new LogQueue(policy, credential, canExport)
    this.provider = new LoggerProvider({ resource, processors: [this.processor],
      logRecordLimits: { attributeCountLimit: 32, attributeValueLengthLimit: 128 },
      loggerConfigurator: () => ({ disabled: false, minimumSeverity: SeverityNumber.INFO, traceBased: false }) })
    this.logger = this.provider.getLogger('jevable.workflow', CORE_VERSION)
  }
  observe(span: Span, name: string, attributes: Attributes, previous?: SpanContext): Span {
    const operation = name.startsWith('jevable.') ? name.slice('jevable.'.length) : ''
    const event = ['run', 'resume', 'approval', 'cancel'].includes(operation) ? 'jevable.execution.segment.ended'
      : operation === 'node' ? 'jevable.node.attempt.ended' : operation === 'model' ? 'jevable.model.call.ended' : operation === 'model.try' ? 'jevable.model.try.ended' : operation === 'model.backoff' ? 'jevable.model.backoff.ended' : undefined
    if (!event || this.closing) return span
    const safe = metadata(attributes), started = performance.now()
    if (event === 'jevable.execution.segment.ended') safe['jevable.operation'] = operation
    if (previous && /^(?!0{32}$)[a-f0-9]{32}$/u.test(previous.traceId) && /^(?!0{16}$)[a-f0-9]{16}$/u.test(previous.spanId)) {
      safe['jevable.previous.trace_id'] = previous.traceId; safe['jevable.previous.span_id'] = previous.spanId
    }
    return new ObservedExecutionSpan(span, ({ outcome, usage, statusCode, modelTry, recovery, rule }) => {
      const data: LogAttributes = { ...safe, 'jevable.outcome': OUTCOMES.has(outcome) ? outcome : 'other',
        'jevable.duration.seconds': Math.max(0, performance.now() - started) / 1000 }
      if (operation === 'node' && ['ifElse', 'switch'].includes(String(safe['jevable.node.kind']))) {
        const validPort = typeof rule.port === 'string' && rule.port.length <= 128 && /^[A-Za-z][A-Za-z0-9_-]*$/u.test(rule.port)
        data['jevable.rule.settled'] = rule.settled === true && validPort
        if (data['jevable.rule.settled']) data['jevable.rule.port'] = rule.port!
      }
      if (operation === 'resume' && recovery.mode === 'recover') {
        data['jevable.control.mode'] = 'recover'
        data['jevable.recovery.settled'] = recovery.settled === true
        if (recovery.requestId && UUID.test(recovery.requestId)) data['jevable.control.request_id'] = recovery.requestId
      }
      if (operation === 'model.try') {
        data['jevable.model.try.dispatched'] = modelTry.dispatched === true
        data['jevable.model.try.settled'] = modelTry.settled === true
      }
      if (operation === 'model') for (const [field, key] of [['input', 'gen_ai.usage.input_tokens'], ['output', 'gen_ai.usage.output_tokens'], ['tries', 'jevable.model.tries']] as const) {
        const value = usage[field]; if (value !== undefined && Number.isSafeInteger(value) && value >= 0) data[key] = value
      }
      const failed = statusCode === SpanStatusCode.ERROR || ['failed', 'invalid-node-value', 'commit-or-execution-failed', 'failed-or-uncertain'].includes(outcome)
      this.logger.emit({ eventName: event, body: event, severityNumber: failed ? SeverityNumber.ERROR : SeverityNumber.INFO,
        severityText: failed ? 'ERROR' : 'INFO', attributes: data,
        context: trace.setSpanContext(ROOT_CONTEXT, span.spanContext()) })
    })
  }
  status() { return { ...this.processor.status(), unit: 'log-records' } }
  suite(attributes: Attributes, seconds: number, context: SpanContext, failed: boolean) {
    if (this.closing) return
    this.logger.emit({ eventName: 'jevable.test.suite.ended', body: 'jevable.test.suite.ended',
      severityNumber: failed ? SeverityNumber.ERROR : SeverityNumber.INFO, severityText: failed ? 'ERROR' : 'INFO',
      attributes: { ...attributes, 'jevable.duration.seconds': seconds }, context: trace.setSpanContext(ROOT_CONTEXT, context) })
  }
  notification(attributes: Attributes, seconds: number, context: SpanContext, failed: boolean) {
    if (this.closing) return
    this.logger.emit({ eventName: 'jevable.notification.delivery.ended', body: 'jevable.notification.delivery.ended',
      severityNumber: failed ? SeverityNumber.ERROR : SeverityNumber.INFO, severityText: failed ? 'ERROR' : 'INFO',
      attributes: { ...attributes, 'jevable.duration.seconds': seconds }, context: trace.setSpanContext(ROOT_CONTEXT, context) })
  }
  httpRequest(attributes: Attributes, seconds: number, context: SpanContext, failed: boolean) {
    if (this.closing) return
    this.logger.emit({ eventName: 'jevable.http.request.ended', body: 'jevable.http.request.ended',
      severityNumber: failed ? SeverityNumber.ERROR : SeverityNumber.INFO, severityText: failed ? 'ERROR' : 'INFO',
      attributes: { ...attributes, 'jevable.duration.seconds': seconds }, context: trace.setSpanContext(ROOT_CONTEXT, context) })
  }
  httpAccess(attributes: Attributes, seconds: number, context: SpanContext, failed: boolean) {
    if (this.closing) return
    this.logger.emit({ eventName: 'jevable.http.access.ended', body: 'jevable.http.access.ended',
      severityNumber: failed ? SeverityNumber.ERROR : SeverityNumber.INFO, severityText: failed ? 'ERROR' : 'INFO',
      attributes: { ...attributes, 'jevable.duration.seconds': seconds }, context: trace.setSpanContext(ROOT_CONTEXT, context) })
  }
  httpRateSql(attributes: Attributes, seconds: number, context: SpanContext, failed: boolean) {
    if (this.closing) return
    this.logger.emit({ eventName: 'jevable.http.rate.sql.ended', body: 'jevable.http.rate.sql.ended',
      severityNumber: failed ? SeverityNumber.ERROR : SeverityNumber.INFO, severityText: failed ? 'ERROR' : 'INFO',
      attributes: { ...attributes, 'jevable.duration.seconds': seconds }, context: trace.setSpanContext(ROOT_CONTEXT, context) })
  }
  grantOperation(attributes: Attributes, seconds: number, context: SpanContext, failed: boolean) {
    if (this.closing) return
    this.logger.emit({ eventName: 'jevable.access.grant.ended', body: 'jevable.access.grant.ended',
      severityNumber: failed ? SeverityNumber.ERROR : SeverityNumber.INFO, severityText: failed ? 'ERROR' : 'INFO',
      attributes: { ...attributes, 'jevable.duration.seconds': seconds }, context: trace.setSpanContext(ROOT_CONTEXT, context) })
  }
  grantPolicy(attributes: Attributes, seconds: number, context: SpanContext, failed: boolean) {
    if (this.closing) return
    this.logger.emit({ eventName: 'jevable.access.policy.ended', body: 'jevable.access.policy.ended',
      severityNumber: failed ? SeverityNumber.ERROR : SeverityNumber.INFO, severityText: failed ? 'ERROR' : 'INFO',
      attributes: { ...attributes, 'jevable.duration.seconds': seconds }, context: trace.setSpanContext(ROOT_CONTEXT, context) })
  }
  journalTransaction(attributes: Attributes, seconds: number, context: SpanContext, failed: boolean) {
    if (this.closing) return
    this.logger.emit({ eventName: 'jevable.storage.journal.transaction.ended', body: 'jevable.storage.journal.transaction.ended',
      severityNumber: failed ? SeverityNumber.ERROR : SeverityNumber.INFO, severityText: failed ? 'ERROR' : 'INFO',
      attributes: { ...attributes, 'jevable.duration.seconds': seconds }, context: trace.setSpanContext(ROOT_CONTEXT, context) })
  }
  httpConnection(attributes: Attributes, seconds: number, context: SpanContext, failed: boolean) {
    if (this.closing) return
    this.logger.emit({ eventName: 'jevable.http.connection.ended', body: 'jevable.http.connection.ended',
      severityNumber: failed ? SeverityNumber.ERROR : SeverityNumber.INFO, severityText: failed ? 'ERROR' : 'INFO',
      attributes: { ...attributes, 'jevable.duration.seconds': seconds }, context: trace.setSpanContext(ROOT_CONTEXT, context) })
  }
  httpTransportFailure(attributes: Attributes, context: SpanContext) {
    if (this.closing) return
    this.logger.emit({ eventName: 'jevable.http.transport.failure', body: 'jevable.http.transport.failure',
      severityNumber: SeverityNumber.ERROR, severityText: 'ERROR', attributes,
      context: trace.setSpanContext(ROOT_CONTEXT, context) })
  }
  busy() { return this.processor.busy() }
  // The queue owns the configured deadline; do not add the SDK's unrelated 30-second default.
  async flush() { if (!this.closing) await this.processor.forceFlush() }
  close() { return this.closing ??= this.provider.shutdown() }
}

import { SpanStatusCode, type Attributes, type Span, type SpanAttributeValue, type SpanStatus, type TimeInput,
  type Link, type Exception } from '@opentelemetry/api'

export interface ExecutionObservation {
  outcome: string
  statusCode: SpanStatusCode
  usage: { input?: number; output?: number; tries?: number }
  modelTry: { dispatched?: boolean; settled?: boolean }
  recovery: { mode?: string; requestId?: string; settled?: boolean }
  rule: { port?: string; settled?: boolean }
}

/** Observe even unsampled spans; settle once at the same end boundary as durable tracing. */
export class ObservedExecutionSpan implements Span {
  private ended = false
  private observation: ExecutionObservation = { outcome: 'other', statusCode: SpanStatusCode.UNSET, usage: {}, modelTry: {}, recovery: {}, rule: {} }
  constructor(private readonly inner: Span, private readonly settled: (observation: ExecutionObservation) => void) {}
  spanContext() { return this.inner.spanContext() }
  isRecording() { return this.inner.isRecording() }
  setAttribute(key: string, value: SpanAttributeValue): this {
    if (!this.ended) {
      if (key === 'jevable.outcome' && typeof value === 'string') this.observation.outcome = value
      if (key === 'gen_ai.usage.input_tokens' && typeof value === 'number') this.observation.usage.input = value
      if (key === 'gen_ai.usage.output_tokens' && typeof value === 'number') this.observation.usage.output = value
      if (key === 'jevable.model.tries' && typeof value === 'number') this.observation.usage.tries = value
      if (key === 'jevable.model.try.dispatched' && typeof value === 'boolean') this.observation.modelTry.dispatched = value
      if (key === 'jevable.model.try.settled' && typeof value === 'boolean') this.observation.modelTry.settled = value
      if (key === 'jevable.control.mode' && typeof value === 'string') this.observation.recovery.mode = value
      if (key === 'jevable.control.request_id' && typeof value === 'string') this.observation.recovery.requestId = value
      if (key === 'jevable.recovery.settled' && typeof value === 'boolean') this.observation.recovery.settled = value
      if (key === 'jevable.rule.port' && typeof value === 'string') this.observation.rule.port = value
      if (key === 'jevable.rule.settled' && typeof value === 'boolean') this.observation.rule.settled = value
    }
    this.inner.setAttribute(key, value); return this
  }
  setAttributes(attributes: Attributes): this { for (const [key, value] of Object.entries(attributes)) if (value !== undefined) this.setAttribute(key, value); return this }
  setStatus(status: SpanStatus): this { if (!this.ended) this.observation.statusCode = status.code; this.inner.setStatus(status); return this }
  updateName(name: string): this { this.inner.updateName(name); return this }
  addEvent(name: string, attributesOrStartTime?: Attributes | TimeInput, startTime?: TimeInput): this { this.inner.addEvent(name, attributesOrStartTime, startTime); return this }
  addLink(link: Link): this { this.inner.addLink(link); return this }
  addLinks(links: Link[]): this { this.inner.addLinks(links); return this }
  recordException(exception: Exception, time?: TimeInput) { this.inner.recordException(exception, time) }
  end(time?: TimeInput) { if (this.ended) return; this.ended = true; this.inner.end(time); this.settled(this.observation) }
}

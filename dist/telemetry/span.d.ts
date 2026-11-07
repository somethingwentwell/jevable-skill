import { SpanStatusCode, type Attributes, type Span, type SpanAttributeValue, type SpanStatus, type TimeInput, type Link, type Exception } from '@opentelemetry/api';
export interface ExecutionObservation {
    outcome: string;
    statusCode: SpanStatusCode;
    usage: {
        input?: number;
        output?: number;
        tries?: number;
    };
    modelTry: {
        dispatched?: boolean;
        settled?: boolean;
    };
    recovery: {
        mode?: string;
        requestId?: string;
        settled?: boolean;
    };
    rule: {
        port?: string;
        settled?: boolean;
    };
}
/** Observe even unsampled spans; settle once at the same end boundary as durable tracing. */
export declare class ObservedExecutionSpan implements Span {
    private readonly inner;
    private readonly settled;
    private ended;
    private observation;
    constructor(inner: Span, settled: (observation: ExecutionObservation) => void);
    spanContext(): import("@opentelemetry/api").SpanContext;
    isRecording(): boolean;
    setAttribute(key: string, value: SpanAttributeValue): this;
    setAttributes(attributes: Attributes): this;
    setStatus(status: SpanStatus): this;
    updateName(name: string): this;
    addEvent(name: string, attributesOrStartTime?: Attributes | TimeInput, startTime?: TimeInput): this;
    addLink(link: Link): this;
    addLinks(links: Link[]): this;
    recordException(exception: Exception, time?: TimeInput): void;
    end(time?: TimeInput): void;
}

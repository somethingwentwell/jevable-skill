import { type Attributes, type SpanContext, type Tracer } from '@opentelemetry/api';
export type HttpTransport = 'loopback-http' | 'direct-https';
export type HttpTransportFailure = 'http-parser' | 'http-client' | 'tls-handshake' | 'connection-limit';
export declare const HTTP_TRANSPORTS: Set<HttpTransport>;
export declare const HTTP_TRANSPORT_FAILURES: Set<HttpTransportFailure>;
export declare const CONNECTION_METRIC_LABELS: string[];
export interface HttpConnectionObservation {
    end(hadError: boolean): void;
}
type Settled = (attributes: Attributes, seconds: number, context: SpanContext, failed: boolean) => void;
/** Socket diagnostics are independent roots: neither peers nor inbound propagation are admitted. */
export declare function observeHttpConnection(tracer: Tracer, transport: HttpTransport, opened: (attributes: Attributes) => void, settled: Settled): HttpConnectionObservation;
/** One observation per emitted failure; not unique failed peers, rejected requests or audit evidence. */
export declare function observeHttpTransportFailure(tracer: Tracer, transport: HttpTransport, failure: HttpTransportFailure, settled: Settled): void;
export {};

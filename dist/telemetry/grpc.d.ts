export type OtlpSignal = 'traces' | 'metrics' | 'logs';
/** One bounded unary OTLP call per connection. No retries, discovery, compression or shared channel. */
export declare function postGrpc(endpoint: string, bytes: Uint8Array, signal: OtlpSignal, key: string | undefined, abortSignal: AbortSignal, remainingMs: number): Promise<Buffer>;

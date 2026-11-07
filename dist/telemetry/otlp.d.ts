import type { TelemetryPolicy } from './config.ts';
import { type OtlpSignal } from './grpc.ts';
export { ExportFailure } from './failure.ts';
export type OtlpCredential = () => string | undefined | Promise<string | undefined>;
/** One explicit, non-retrying request. Never expose credentials or collector error text. */
export declare function postOtlp(endpoint: string, bytes: Uint8Array | undefined, policy: TelemetryPolicy, credential: OtlpCredential, controller: AbortController, signal?: OtlpSignal): Promise<Buffer>;
export declare function boundedFlush(work: Promise<void>, timeoutMs: number): Promise<void>;

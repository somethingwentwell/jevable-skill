import { type TraceRequestContext } from '../telemetry/baggage.ts';
/** One private snapshot per invocation. Never an ambient carrier, credential or persisted input. */
export declare function readCliTraceContext(value: string | boolean | undefined): Promise<Readonly<TraceRequestContext> | undefined>;

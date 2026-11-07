import { z } from 'zod';
export declare const baggageKeysSchema: z.ZodArray<z.ZodString>;
/** Explicit private carrier, not execution input, identity, authority or durable state. */
export interface TraceRequestContext {
    traceparent?: string | undefined;
    baggage?: string | undefined;
}
export declare function parseTraceRequestContext(value: unknown): TraceRequestContext;
/** W3C wire-format filtering, not an unrestricted baggage platform. No decoding or attribute promotion.
 * Explicit empty policy disables admission. Undefined policy validates/canonicalizes all (client only).
 * Retain whole members/properties and duplicate order; never truncate a value or forward unknown keys.
 */
export declare function selectBaggage(header: string | undefined, allowedKeys?: readonly string[]): string | undefined;

/** Schema samples only: no graph execution, provider calls or inferred business expectations. */
import { type CompiledValueSchema, type WorkflowDataLimits } from '../workflow/index.ts';
import type { JsonValue } from '../workflow/index.ts';
export declare const GENERATOR_VERSION: "schema-boundary/v1";
export declare const GENERATION_LIMITS: Readonly<{
    candidates: 32;
    attempts: 256;
    inputBytes: 100000;
    totalInputBytes: 1000000;
    values: 10000;
    depth: 32;
    stringLength: 16384;
    arrayItems: 256;
}>;
export type SampleReason = 'sample' | 'required-only' | 'enum' | 'boolean' | 'minimum' | 'maximum' | 'empty' | 'optional-omitted' | 'array-length';
/** Generate bounded, unique, fully validated inputs in stable order. This does not establish branch coverage. */
export declare function generateInputs(compiled: CompiledValueSchema, limits: WorkflowDataLimits, requested?: number): {
    candidates: {
        input: JsonValue;
        reason: SampleReason;
        path: string;
    }[];
    diagnostics: {
        attempted: number;
        invalid: number;
        skippedBounds: number;
        totalInputBytes: number;
        limitReached: boolean;
        noSeed: boolean;
    };
};

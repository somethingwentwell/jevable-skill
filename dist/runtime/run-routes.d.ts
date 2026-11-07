import { z } from 'zod';
import type { RunStep } from './run-evaluator.ts';
export declare const recordedRouteSchema: z.ZodObject<{
    stepIndex: z.ZodNumber;
    nodeId: z.ZodString;
    port: z.ZodString;
    scope: z.ZodOptional<z.ZodObject<{
        loop: z.ZodString;
        index: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const recordedRoutesSchema: z.ZodArray<z.ZodObject<{
    stepIndex: z.ZodNumber;
    nodeId: z.ZodString;
    port: z.ZodString;
    scope: z.ZodOptional<z.ZodObject<{
        loop: z.ZodString;
        index: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strict>>;
/** Port choices settled in this transition, including synthesized loop completion but not iteration-result bookkeeping. */
export declare function recordedRoutes(steps: readonly RunStep[], start?: number): {
    scope?: {
        loop: import("../index.ts").NodeId;
        index: number;
    };
    stepIndex: number;
    nodeId: import("../index.ts").NodeId;
    port: string;
}[];

/** Pure native Jev/Laya System One wire codec. No HTTP dispatch, credentials or runtime admission. */
import { z } from 'zod';
export { SYSTEMONE_ROUNDING_TOLERANCE } from '../workflow/systemone-answers.ts';
declare const limitsSchema: z.ZodObject<{
    maxRequestBytes: z.ZodNumber;
    maxResponseBytes: z.ZodNumber;
    maxDepth: z.ZodNumber;
    maxValues: z.ZodNumber;
}, z.core.$strict>;
export type SystemOneLimits = z.infer<typeof limitsSchema>;
declare const requestSchema: z.ZodObject<{
    model: z.ZodString;
    state: z.ZodUnion<readonly [z.ZodString, z.ZodRecord<z.ZodString, z.ZodJSONSchema>, z.ZodArray<z.ZodJSONSchema>]>;
    questions: z.ZodRecord<z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"choice">;
        instructions: z.ZodString;
        criteria: z.ZodRecord<z.ZodString, z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"score">;
        instructions: z.ZodString;
        criteria: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"noul">;
        instructions: z.ZodString;
    }, z.core.$strict>], "type">>;
}, z.core.$strict>;
export type SystemOneRequest = z.infer<typeof requestSchema>;
declare const replySchema: z.ZodObject<{
    model: z.ZodString;
    answers: z.ZodRecord<z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"choice">;
        choice: z.ZodString;
        confidence: z.ZodNumber;
        probabilities: z.ZodRecord<z.ZodString, z.ZodNumber>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"score">;
        score: z.ZodNumber;
        confidence: z.ZodNumber;
        legend: z.ZodRecord<z.ZodString, z.ZodString>;
        probabilities: z.ZodRecord<z.ZodString, z.ZodNumber>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"noul">;
        noul: z.ZodNumber;
    }, z.core.$strict>], "type">>;
    usage: z.ZodObject<{
        input_tokens: z.ZodNumber;
        output_tokens: z.ZodNumber;
    }, z.core.$strict>;
}, z.core.$strict>;
export type SystemOneReply = z.infer<typeof replySchema>;
export interface SystemOneResult {
    raw: string;
    reply: SystemOneReply;
}
/** Admit the workflow-supported question subset, preserving state, rubric order and exact model selection. */
export declare function createSystemOneRequest(value: unknown, limits: SystemOneLimits): SystemOneRequest;
/** Parse exact wire evidence without converting it to the legacy workflow Decision output contract. */
export declare function parseSystemOneReply(raw: string, request: SystemOneRequest, limits: SystemOneLimits): SystemOneResult;
/** Read one already-authorized JSON response with decompressed-byte/UTF-8 limits. This function never sends a request. */
export declare function readSystemOneReply(response: Response, request: SystemOneRequest, limits: SystemOneLimits): Promise<SystemOneResult>;

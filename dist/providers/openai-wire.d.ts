import { type ChatProviderConnection } from './config.ts';
import type { ChatModelRequestPlan, PreparedModelInput } from '../runtime/model-plan.ts';
export declare const RESULT_TOOL = "jevable_return_result";
/** Pure request construction is also used to verify historical execution without network calls. */
export declare function requestBody(plan: ChatModelRequestPlan, input: PreparedModelInput, tokenParameter: ChatProviderConnection['tokenParameter']): {
    tools?: {
        type: string;
        function: {
            name: string;
            description: string;
            parameters: {
                type: string;
                required: string[];
                additionalProperties: boolean;
                properties: {
                    value: import("../index.ts").WorkflowValueSchemaDefinition;
                };
            };
        };
    }[];
    tool_choice?: {
        type: string;
        function: {
            name: string;
        };
    };
    parallel_tool_calls?: boolean;
    top_p?: number;
    temperature?: number;
    stream_options?: {
        include_usage: boolean;
    };
    model: string;
    messages: {
        role: string;
        content: string;
    }[];
    stream: boolean;
};
export interface WireResult {
    output: string;
    usage: {
        tries: 1;
        inputTokens?: number;
        outputTokens?: number;
    };
    responseId?: string;
    providerModel?: string;
}
export declare function parseReply(value: unknown, mode: ChatModelRequestPlan['responseFormat']): WireResult;
/** Read JSON or SSE according to the requested mode; never accept an HTML page or an unfinished stream. */
export declare function readCompletion(response: Response, plan: ChatModelRequestPlan, policy: Pick<ChatProviderConnection, 'maxResponseBytes' | 'maxStreamEvents'>): Promise<WireResult>;

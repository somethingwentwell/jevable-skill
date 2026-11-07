/** Explicit wire selection shared by live transport and offline retained-request verification. */
import type { ModelRequestPlan, PreparedModelInput } from '../runtime/model-plan.ts';
import { type ProviderConnection } from './config.ts';
import { type WireResult } from './openai-wire.ts';
export declare const nativeDataLimits: {
    readonly maxDepth: 64;
    readonly maxValues: 100000;
};
export declare function prepareModelWire(plan: ModelRequestPlan, input: PreparedModelInput, connection: ProviderConnection): {
    request: {
        model: string;
        state: string | Record<string, import("zod").JSONType> | import("zod").JSONType[];
        questions: Record<string, {
            type: "choice";
            instructions: string;
            criteria: Record<string, string>;
        } | {
            type: "score";
            instructions: string;
            criteria: string[];
        } | {
            type: "noul";
            instructions: string;
        }>;
    };
    path: string;
    accept: string;
    read: (response: Response) => Promise<WireResult>;
    decode: (raw: string) => WireResult;
} | {
    request: {
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
    path: string;
    accept: string;
    read: (response: Response) => Promise<WireResult>;
    decode?: never;
};

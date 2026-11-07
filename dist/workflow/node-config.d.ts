/** Strict first-slice node configuration, with no credential resolution or network effects. */
import { z } from 'zod';
import type { WorkflowConnectionId, WorkflowCredentialRef } from './compiler-types.ts';
/** Typed Decision questions require explicit routing and execution settings; no adapter is selected by compilation. */
export declare const decisionConfig: z.ZodObject<{
    description: z.ZodOptional<z.ZodString>;
    provider: z.ZodString;
    model: z.ZodString;
    answerFormat: z.ZodOptional<z.ZodLiteral<"systemone-v1">>;
    connection: z.ZodDiscriminatedUnion<[z.ZodObject<{
        mode: z.ZodLiteral<"workspace">;
        id: z.ZodPipe<z.ZodString, z.ZodTransform<WorkflowConnectionId, string>>;
    }, z.core.$strict>, z.ZodObject<{
        mode: z.ZodLiteral<"custom">;
        protocol: z.ZodString;
        endpoint: z.ZodString;
        credentialRef: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<WorkflowCredentialRef, string>>>;
    }, z.core.$strict>], "mode">;
    state: z.ZodJSONSchema;
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
    llm: z.ZodOptional<z.ZodObject<{
        provider: z.ZodString;
        generation: z.ZodObject<{
            maxTokens: z.ZodNumber;
            temperature: z.ZodOptional<z.ZodNumber>;
            topP: z.ZodOptional<z.ZodNumber>;
            stream: z.ZodBoolean;
        }, z.core.$strict>;
    }, z.core.$strict>>;
    execution: z.ZodObject<{
        timeoutSeconds: z.ZodNumber;
        maxAttempts: z.ZodNumber;
    }, z.core.$strict>;
}, z.core.$strict>;
/** Trigger modes must be explicitly declared and unique. */
export declare const triggerConfig: z.ZodObject<{
    modes: z.ZodArray<z.ZodEnum<{
        manual: "manual";
        chat: "chat";
        api: "api";
        webhook: "webhook";
    }>>;
}, z.core.$strict>;
/** LLM requests are explicit; unsupported settings cannot disappear during parsing. */
export declare const llmConfig: z.ZodObject<{
    description: z.ZodOptional<z.ZodString>;
    provider: z.ZodString;
    model: z.ZodString;
    connection: z.ZodDiscriminatedUnion<[z.ZodObject<{
        mode: z.ZodLiteral<"workspace">;
        id: z.ZodPipe<z.ZodString, z.ZodTransform<WorkflowConnectionId, string>>;
    }, z.core.$strict>, z.ZodObject<{
        mode: z.ZodLiteral<"custom">;
        protocol: z.ZodLiteral<"openai-compatible">;
        endpoint: z.ZodString;
        credentialRef: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<WorkflowCredentialRef, string>>>;
    }, z.core.$strict>], "mode">;
    prompt: z.ZodString;
    systemPrompt: z.ZodOptional<z.ZodString>;
    input: z.ZodOptional<z.ZodJSONSchema>;
    inputSchema: z.ZodOptional<z.ZodJSONSchema>;
    outputSchema: z.ZodOptional<z.ZodJSONSchema>;
    responseFormat: z.ZodEnum<{
        text: "text";
        "json-schema": "json-schema";
    }>;
    generation: z.ZodObject<{
        maxTokens: z.ZodNumber;
        temperature: z.ZodOptional<z.ZodNumber>;
        topP: z.ZodOptional<z.ZodNumber>;
        stream: z.ZodBoolean;
    }, z.core.$strict>;
    execution: z.ZodObject<{
        timeoutSeconds: z.ZodNumber;
        maxAttempts: z.ZodNumber;
    }, z.core.$strict>;
    historyScope: z.ZodEnum<{
        none: "none";
        "current-run": "current-run";
        "admitted-project": "admitted-project";
    }>;
    historyLimits: z.ZodOptional<z.ZodObject<{
        maxMessages: z.ZodNumber;
        maxBytes: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** Rule conditions remain visible, typed nodes instead of arbitrary edge scripts. */
export declare const ruleConfig: z.ZodDiscriminatedUnion<[z.ZodObject<{
    mode: z.ZodLiteral<"ifElse">;
    condition: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    mode: z.ZodLiteral<"switch">;
    value: z.ZodJSONSchema;
    cases: z.ZodArray<z.ZodObject<{
        port: z.ZodString;
        value: z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]>;
    }, z.core.$strict>>;
}, z.core.$strict>], "mode">;
/** Output bindings may optionally declare an additional runtime result schema. */
export declare const outputConfig: z.ZodObject<{
    value: z.ZodJSONSchema;
    outputSchema: z.ZodOptional<z.ZodJSONSchema>;
}, z.core.$strict>;
/** Approval expiry is an exact positive duration; terminal rejection/expiry never authorizes continuation. */
export declare const approvalConfig: z.ZodObject<{
    title: z.ZodString;
    input: z.ZodJSONSchema;
    inputSchema: z.ZodJSONSchema;
    actions: z.ZodArray<z.ZodString>;
    expiresAfter: z.ZodPipe<z.ZodString, z.ZodTransform<number, string>>;
    onReject: z.ZodEnum<{
        cancelled: "cancelled";
        branch: "branch";
    }>;
    onTimeout: z.ZodEnum<{
        branch: "branch";
        expired: "expired";
    }>;
}, z.core.$strict>;
/** Sequential, bounded iteration; the body runs once per item or until its condition holds. */
export declare const loopConfig: z.ZodDiscriminatedUnion<[z.ZodObject<{
    body: z.ZodObject<{
        entry: z.ZodString;
        nodes: z.ZodRecord<z.ZodString, z.ZodObject<{
            type: z.ZodEnum<{
                custom: "custom";
                llm: "llm";
                decision: "decision";
                rule: "rule";
                humanApproval: "humanApproval";
            }>;
            title: z.ZodOptional<z.ZodString>;
            description: z.ZodOptional<z.ZodString>;
            config: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
            extensions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodJSONSchema>>;
        }, z.core.$strict>>;
        edges: z.ZodArray<z.ZodObject<{
            from: z.ZodString;
            to: z.ZodString;
            port: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        exits: z.ZodArray<z.ZodObject<{
            from: z.ZodString;
            port: z.ZodOptional<z.ZodString>;
            result: z.ZodJSONSchema;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    maxIterations: z.ZodNumber;
    timeoutSeconds: z.ZodNumber;
    mode: z.ZodLiteral<"forEach">;
    description: z.ZodOptional<z.ZodString>;
    items: z.ZodJSONSchema;
}, z.core.$strict>, z.ZodObject<{
    onLimit: z.ZodEnum<{
        branch: "branch";
        fail: "fail";
    }>;
    body: z.ZodObject<{
        entry: z.ZodString;
        nodes: z.ZodRecord<z.ZodString, z.ZodObject<{
            type: z.ZodEnum<{
                custom: "custom";
                llm: "llm";
                decision: "decision";
                rule: "rule";
                humanApproval: "humanApproval";
            }>;
            title: z.ZodOptional<z.ZodString>;
            description: z.ZodOptional<z.ZodString>;
            config: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
            extensions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodJSONSchema>>;
        }, z.core.$strict>>;
        edges: z.ZodArray<z.ZodObject<{
            from: z.ZodString;
            to: z.ZodString;
            port: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        exits: z.ZodArray<z.ZodObject<{
            from: z.ZodString;
            port: z.ZodOptional<z.ZodString>;
            result: z.ZodJSONSchema;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    maxIterations: z.ZodNumber;
    timeoutSeconds: z.ZodNumber;
    mode: z.ZodLiteral<"repeatUntil">;
    description: z.ZodOptional<z.ZodString>;
    input: z.ZodJSONSchema;
    until: z.ZodString;
}, z.core.$strict>], "mode">;
/** Code-first Custom node; compilation grants no execution, dependency or capability permission. */
export declare const customConfig: z.ZodObject<{
    language: z.ZodLiteral<"javascript">;
    code: z.ZodString;
    input: z.ZodJSONSchema;
    inputSchema: z.ZodOptional<z.ZodJSONSchema>;
    outputSchema: z.ZodJSONSchema;
    execution: z.ZodOptional<z.ZodObject<{
        timeoutSeconds: z.ZodNumber;
        maxAttempts: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strict>;

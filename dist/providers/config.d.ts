import { z } from 'zod';
export declare const reference: z.ZodString;
export declare const connectionSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    protocol: z.ZodLiteral<"openai-compatible">;
    tokenParameter: z.ZodEnum<{
        max_tokens: "max_tokens";
        max_completion_tokens: "max_completion_tokens";
    }>;
    maxStreamEvents: z.ZodNumber;
    id: z.ZodString;
    provider: z.ZodString;
    endpoint: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
    allowedModels: z.ZodArray<z.ZodString>;
    authentication: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"bearer">;
        credentialRef: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"none">;
    }, z.core.$strict>], "kind">;
    tracePropagation: z.ZodOptional<z.ZodEnum<{
        none: "none";
        w3c: "w3c";
    }>>;
    baggageKeys: z.ZodOptional<z.ZodArray<z.ZodString>>;
    maxResponseBytes: z.ZodNumber;
    maxRequestBytes: z.ZodNumber;
    maxTimeoutSeconds: z.ZodNumber;
}, z.core.$strict>, z.ZodObject<{
    protocol: z.ZodLiteral<"systemone">;
    provider: z.ZodEnum<{
        jev: "jev";
        laya: "laya";
    }>;
    id: z.ZodString;
    endpoint: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
    allowedModels: z.ZodArray<z.ZodString>;
    authentication: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"bearer">;
        credentialRef: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"none">;
    }, z.core.$strict>], "kind">;
    tracePropagation: z.ZodOptional<z.ZodEnum<{
        none: "none";
        w3c: "w3c";
    }>>;
    baggageKeys: z.ZodOptional<z.ZodArray<z.ZodString>>;
    maxResponseBytes: z.ZodNumber;
    maxRequestBytes: z.ZodNumber;
    maxTimeoutSeconds: z.ZodNumber;
}, z.core.$strict>], "protocol">;
export type ProviderConnection = z.infer<typeof connectionSchema>;
export type ChatProviderConnection = Extract<ProviderConnection, {
    protocol: 'openai-compatible';
}>;
export declare const connectionRecordSchema: z.ZodObject<{
    generation: z.ZodNumber;
    updatedAt: z.ZodISODateTime;
    connection: z.ZodDiscriminatedUnion<[z.ZodObject<{
        protocol: z.ZodLiteral<"openai-compatible">;
        tokenParameter: z.ZodEnum<{
            max_tokens: "max_tokens";
            max_completion_tokens: "max_completion_tokens";
        }>;
        maxStreamEvents: z.ZodNumber;
        id: z.ZodString;
        provider: z.ZodString;
        endpoint: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
        allowedModels: z.ZodArray<z.ZodString>;
        authentication: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"bearer">;
            credentialRef: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"none">;
        }, z.core.$strict>], "kind">;
        tracePropagation: z.ZodOptional<z.ZodEnum<{
            none: "none";
            w3c: "w3c";
        }>>;
        baggageKeys: z.ZodOptional<z.ZodArray<z.ZodString>>;
        maxResponseBytes: z.ZodNumber;
        maxRequestBytes: z.ZodNumber;
        maxTimeoutSeconds: z.ZodNumber;
    }, z.core.$strict>, z.ZodObject<{
        protocol: z.ZodLiteral<"systemone">;
        provider: z.ZodEnum<{
            jev: "jev";
            laya: "laya";
        }>;
        id: z.ZodString;
        endpoint: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
        allowedModels: z.ZodArray<z.ZodString>;
        authentication: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"bearer">;
            credentialRef: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"none">;
        }, z.core.$strict>], "kind">;
        tracePropagation: z.ZodOptional<z.ZodEnum<{
            none: "none";
            w3c: "w3c";
        }>>;
        baggageKeys: z.ZodOptional<z.ZodArray<z.ZodString>>;
        maxResponseBytes: z.ZodNumber;
        maxRequestBytes: z.ZodNumber;
        maxTimeoutSeconds: z.ZodNumber;
    }, z.core.$strict>], "protocol">;
}, z.core.$strict>;
export type ProviderConnectionRecord = z.infer<typeof connectionRecordSchema>;
/** Diagnostics use fixed categories and never include a provider response, request or credential. */
export declare class ProviderError extends Error {
    readonly code: 'invalid-config' | 'missing-connection' | 'model-not-allowed' | 'missing-credential' | 'unsupported-settings' | 'request-too-large' | 'response-too-large' | 'invalid-response' | 'http-error' | 'transport-error' | 'timeout' | 'cancelled' | 'uncertain-attempt' | 'corrupt-evidence' | 'conflict';
    constructor(code: 'invalid-config' | 'missing-connection' | 'model-not-allowed' | 'missing-credential' | 'unsupported-settings' | 'request-too-large' | 'response-too-large' | 'invalid-response' | 'http-error' | 'transport-error' | 'timeout' | 'cancelled' | 'uncertain-attempt' | 'corrupt-evidence' | 'conflict');
}

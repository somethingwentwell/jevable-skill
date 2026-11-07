import { z } from 'zod';
export declare const MAX_MODEL_ATTEMPTS = 10;
export declare const RETRYABLE_HTTP_STATUSES: readonly [408, 429, 500, 502, 503, 504];
export declare const modelEvidenceSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    result: z.ZodDiscriminatedUnion<[z.ZodObject<{
        status: z.ZodLiteral<"pending">;
    }, z.core.$strict>, z.ZodObject<{
        status: z.ZodLiteral<"failed">;
        code: z.ZodEnum<{
            "request-too-large": "request-too-large";
            "response-too-large": "response-too-large";
            "invalid-response": "invalid-response";
            "http-error": "http-error";
            "transport-error": "transport-error";
            timeout: "timeout";
            cancelled: "cancelled";
        }>;
        at: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        status: z.ZodLiteral<"completed">;
        output: z.ZodString;
        usage: z.ZodObject<{
            tries: z.ZodLiteral<1>;
            inputTokens: z.ZodOptional<z.ZodNumber>;
            outputTokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>;
        at: z.ZodISODateTime;
        providerModel: z.ZodOptional<z.ZodString>;
        responseId: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>], "status">;
    attemptId: z.ZodUUID;
    at: z.ZodISODateTime;
    route: z.ZodObject<{
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
    request: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    trace: z.ZodOptional<z.ZodObject<{
        traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableTraceId, string>>;
        spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableSpanId, string>>;
        traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
    }, z.core.$strict>>;
    traceparent: z.ZodOptional<z.ZodString>;
    schemaVersion: z.ZodLiteral<1>;
}, z.core.$strict>, z.ZodObject<{
    policy: z.ZodObject<{
        kind: z.ZodLiteral<"transient-http-v1">;
        maxAttempts: z.ZodNumber;
        timeoutSeconds: z.ZodNumber;
    }, z.core.$strict>;
    tries: z.ZodArray<z.ZodObject<{
        id: z.ZodUUID;
        number: z.ZodNumber;
        at: z.ZodISODateTime;
        trace: z.ZodOptional<z.ZodObject<{
            traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableTraceId, string>>;
            spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableSpanId, string>>;
            traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
        }, z.core.$strict>>;
        result: z.ZodDiscriminatedUnion<[z.ZodObject<{
            status: z.ZodLiteral<"pending">;
        }, z.core.$strict>, z.ZodObject<{
            status: z.ZodLiteral<"failed">;
            code: z.ZodEnum<{
                "request-too-large": "request-too-large";
                "response-too-large": "response-too-large";
                "invalid-response": "invalid-response";
                "http-error": "http-error";
                "transport-error": "transport-error";
                timeout: "timeout";
                cancelled: "cancelled";
            }>;
            at: z.ZodISODateTime;
            httpStatus: z.ZodOptional<z.ZodNumber>;
            retryDelayMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>, z.ZodObject<{
            status: z.ZodLiteral<"completed">;
            at: z.ZodISODateTime;
        }, z.core.$strict>], "status">;
    }, z.core.$strict>>;
    result: z.ZodDiscriminatedUnion<[z.ZodObject<{
        status: z.ZodLiteral<"pending">;
    }, z.core.$strict>, z.ZodObject<{
        status: z.ZodLiteral<"failed">;
        code: z.ZodEnum<{
            "request-too-large": "request-too-large";
            "response-too-large": "response-too-large";
            "invalid-response": "invalid-response";
            "http-error": "http-error";
            "transport-error": "transport-error";
            timeout: "timeout";
            cancelled: "cancelled";
        }>;
        at: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        status: z.ZodLiteral<"completed">;
        output: z.ZodString;
        at: z.ZodISODateTime;
        usage: z.ZodObject<{
            inputTokens: z.ZodOptional<z.ZodNumber>;
            outputTokens: z.ZodOptional<z.ZodNumber>;
            tries: z.ZodNumber;
        }, z.core.$strict>;
        providerModel: z.ZodOptional<z.ZodString>;
        responseId: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>], "status">;
    attemptId: z.ZodUUID;
    at: z.ZodISODateTime;
    route: z.ZodObject<{
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
    request: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    trace: z.ZodOptional<z.ZodObject<{
        traceId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableTraceId, string>>;
        spanId: z.ZodPipe<z.ZodString, z.ZodTransform<import("../runtime/run-trace.ts").JevableSpanId, string>>;
        traceFlags: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
    }, z.core.$strict>>;
    traceparent: z.ZodOptional<z.ZodString>;
    schemaVersion: z.ZodLiteral<2>;
}, z.core.$strict>], "schemaVersion">;
export type ModelEvidence = z.infer<typeof modelEvidenceSchema>;
export type RetryModelEvidence = Extract<ModelEvidence, {
    schemaVersion: 2;
}>;
export declare const credentialSchema: z.ZodObject<{
    ref: z.ZodString;
    generation: z.ZodNumber;
    updatedAt: z.ZodISODateTime;
    value: z.ZodString;
}, z.core.$strict>;
/** Secret-free retained generation prevents stale writes after logical credential clearing. */
export declare const clearedCredentialSchema: z.ZodObject<{
    ref: z.ZodString;
    generation: z.ZodNumber;
    updatedAt: z.ZodISODateTime;
    cleared: z.ZodLiteral<true>;
}, z.core.$strict>;
export declare const credentialRecordSchema: z.ZodUnion<readonly [z.ZodObject<{
    ref: z.ZodString;
    generation: z.ZodNumber;
    updatedAt: z.ZodISODateTime;
    value: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    ref: z.ZodString;
    generation: z.ZodNumber;
    updatedAt: z.ZodISODateTime;
    cleared: z.ZodLiteral<true>;
}, z.core.$strict>]>;

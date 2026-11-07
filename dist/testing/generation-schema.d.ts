import { z } from 'zod';
export declare const generateTestsSchema: z.ZodObject<{
    id: z.ZodUUID;
    project: z.ZodObject<{
        id: z.ZodUUID;
        generation: z.ZodNumber;
        revision: z.ZodString;
    }, z.core.$strict>;
    limit: z.ZodDefault<z.ZodNumber>;
    actor: z.ZodString;
    triggerMode: z.ZodOptional<z.ZodLiteral<"api">>;
}, z.core.$strict>;
export type GenerateTestsRequest = z.input<typeof generateTestsSchema>;
export declare const generationSnapshotSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    format: z.ZodLiteral<"jevable.ai/test-generation">;
    id: z.ZodUUID;
    generator: z.ZodLiteral<"schema-boundary/v1">;
    createdAt: z.ZodISODateTime;
    actor: z.ZodString;
    request: z.ZodObject<{
        limit: z.ZodDefault<z.ZodNumber>;
        triggerMode: z.ZodOptional<z.ZodLiteral<"api">>;
        project: z.ZodObject<{
            id: z.ZodUUID;
            generation: z.ZodNumber;
            revision: z.ZodString;
        }, z.core.$strict>;
    }, z.core.$strict>;
    status: z.ZodEnum<{
        "review-required": "review-required";
        "no-candidates": "no-candidates";
    }>;
    execution: z.ZodLiteral<"not-run">;
    expectations: z.ZodLiteral<"completion-suggestion-only; review-before-acceptance">;
    coverage: z.ZodLiteral<"schema-samples-not-branch-proof">;
    diagnostics: z.ZodObject<{
        attempted: z.ZodNumber;
        invalid: z.ZodNumber;
        skippedBounds: z.ZodNumber;
        totalInputBytes: z.ZodNumber;
        limitReached: z.ZodBoolean;
        noSeed: z.ZodBoolean;
    }, z.core.$strict>;
    cases: z.ZodArray<z.ZodObject<{
        id: z.ZodUUID;
        generation: z.ZodLiteral<1>;
        sha256: z.ZodString;
        definition: z.ZodObject<{
            title: z.ZodString;
            project: z.ZodObject<{
                id: z.ZodUUID;
                generation: z.ZodNumber;
                revision: z.ZodString;
            }, z.core.$strict>;
            input: z.ZodJSONSchema;
            expectations: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"status">;
                value: z.ZodEnum<{
                    cancelled: "cancelled";
                    completed: "completed";
                    failed: "failed";
                    waiting: "waiting";
                }>;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"output-equals">;
                value: z.ZodJSONSchema;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"failure-code">;
                value: z.ZodEnum<{
                    "invalid-node-value": "invalid-node-value";
                    "loop-limit": "loop-limit";
                    "loop-timeout": "loop-timeout";
                    "approval-rejected": "approval-rejected";
                    "approval-expired": "approval-expired";
                    "ai-budget": "ai-budget";
                }>;
            }, z.core.$strict>, z.ZodObject<{
                nodeId: z.ZodString;
                scope: z.ZodOptional<z.ZodObject<{
                    loop: z.ZodString;
                    index: z.ZodNumber;
                }, z.core.$strict>>;
                kind: z.ZodLiteral<"node-visited">;
            }, z.core.$strict>, z.ZodObject<{
                value: z.ZodJSONSchema;
                nodeId: z.ZodString;
                scope: z.ZodOptional<z.ZodObject<{
                    loop: z.ZodString;
                    index: z.ZodNumber;
                }, z.core.$strict>>;
                kind: z.ZodLiteral<"node-output-equals">;
            }, z.core.$strict>, z.ZodObject<{
                value: z.ZodString;
                nodeId: z.ZodString;
                scope: z.ZodOptional<z.ZodObject<{
                    loop: z.ZodString;
                    index: z.ZodNumber;
                }, z.core.$strict>>;
                kind: z.ZodLiteral<"node-port-equals">;
            }, z.core.$strict>], "kind">>;
            triggerMode: z.ZodOptional<z.ZodLiteral<"api">>;
        }, z.core.$strict>;
        reason: z.ZodEnum<{
            boolean: "boolean";
            minimum: "minimum";
            maximum: "maximum";
            enum: "enum";
            empty: "empty";
            sample: "sample";
            "required-only": "required-only";
            "optional-omitted": "optional-omitted";
            "array-length": "array-length";
        }>;
        path: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type TestGenerationSnapshot = z.infer<typeof generationSnapshotSchema>;
export type TestGeneration = {
    snapshot: TestGenerationSnapshot;
    sha256: string;
};
export declare const generationHash: (snapshot: TestGenerationSnapshot) => string;

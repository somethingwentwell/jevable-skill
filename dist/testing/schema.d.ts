import { z } from 'zod';
export declare const expectationSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
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
}, z.core.$strict>], "kind">;
export declare const testDefinitionSchema: z.ZodObject<{
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
export declare const testIdentitySchema: z.ZodObject<{
    id: z.ZodUUID;
    generation: z.ZodNumber;
    sha256: z.ZodString;
}, z.core.$strict>;
export declare const importedTestSchema: z.ZodObject<{
    bundleSha256: z.ZodString;
    source: z.ZodObject<{
        id: z.ZodUUID;
        generation: z.ZodNumber;
        sha256: z.ZodString;
    }, z.core.$strict>;
    project: z.ZodObject<{
        id: z.ZodUUID;
        generation: z.ZodNumber;
        revision: z.ZodString;
    }, z.core.$strict>;
    status: z.ZodEnum<{
        draft: "draft";
        accepted: "accepted";
    }>;
}, z.core.$strict>;
export declare const transferredTestsSchema: z.ZodObject<{
    scope: z.ZodLiteral<"accepted-revision-latest-definitions">;
    excludedOtherRevisions: z.ZodNumber;
    excludedArchived: z.ZodOptional<z.ZodNumber>;
    cases: z.ZodArray<z.ZodObject<{
        source: z.ZodObject<{
            id: z.ZodUUID;
            generation: z.ZodNumber;
            sha256: z.ZodString;
        }, z.core.$strict>;
        status: z.ZodEnum<{
            draft: "draft";
            accepted: "accepted";
        }>;
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
    }, z.core.$strict>>;
}, z.core.$strict>;
export type TransferredTests = z.infer<typeof transferredTestsSchema>;
export type ImportedTest = z.infer<typeof importedTestSchema>;
export declare const testCommandSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    operation: z.ZodLiteral<"create">;
    id: z.ZodOptional<z.ZodUUID>;
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
    actor: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
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
    id: z.ZodUUID;
    expectedGeneration: z.ZodNumber;
    actor: z.ZodString;
    operation: z.ZodLiteral<"edit">;
}, z.core.$strict>, z.ZodObject<{
    reviewedSha256: z.ZodString;
    id: z.ZodUUID;
    expectedGeneration: z.ZodNumber;
    actor: z.ZodString;
    operation: z.ZodLiteral<"accept">;
}, z.core.$strict>, z.ZodObject<{
    reviewedSha256: z.ZodString;
    archived: z.ZodBoolean;
    id: z.ZodUUID;
    expectedGeneration: z.ZodNumber;
    actor: z.ZodString;
    operation: z.ZodLiteral<"archive">;
}, z.core.$strict>], "operation">;
export declare const testVersionSchema: z.ZodObject<{
    generation: z.ZodNumber;
    operation: z.ZodEnum<{
        create: "create";
        edit: "edit";
        accept: "accept";
        archive: "archive";
    }>;
    status: z.ZodEnum<{
        draft: "draft";
        accepted: "accepted";
    }>;
    archived: z.ZodOptional<z.ZodBoolean>;
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
    sha256: z.ZodString;
    actor: z.ZodString;
    at: z.ZodISODateTime;
}, z.core.$strict>;
export declare const testRecordSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    id: z.ZodUUID;
    versions: z.ZodArray<z.ZodObject<{
        generation: z.ZodNumber;
        operation: z.ZodEnum<{
            create: "create";
            edit: "edit";
            accept: "accept";
            archive: "archive";
        }>;
        status: z.ZodEnum<{
            draft: "draft";
            accepted: "accepted";
        }>;
        archived: z.ZodOptional<z.ZodBoolean>;
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
        sha256: z.ZodString;
        actor: z.ZodString;
        at: z.ZodISODateTime;
    }, z.core.$strict>>;
    importedFrom: z.ZodOptional<z.ZodObject<{
        bundleSha256: z.ZodString;
        source: z.ZodObject<{
            id: z.ZodUUID;
            generation: z.ZodNumber;
            sha256: z.ZodString;
        }, z.core.$strict>;
        project: z.ZodObject<{
            id: z.ZodUUID;
            generation: z.ZodNumber;
            revision: z.ZodString;
        }, z.core.$strict>;
        status: z.ZodEnum<{
            draft: "draft";
            accepted: "accepted";
        }>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type TestDefinition = z.infer<typeof testDefinitionSchema>;
export type TestCommand = z.infer<typeof testCommandSchema>;
export type TestIdentity = z.infer<typeof testIdentitySchema>;
export type TestVersion = z.infer<typeof testVersionSchema>;
export type TestCase = TestVersion & {
    schemaVersion: 1;
    id: string;
    importedFrom?: ImportedTest;
};
export declare const testHash: (definition: TestDefinition) => string;
/** Bound SDK inputs as well as JSON transport before recursive schema parsing. */
export declare function parseTest<T>(schema: z.ZodType<T>, value: unknown, maxBytes?: number): T;

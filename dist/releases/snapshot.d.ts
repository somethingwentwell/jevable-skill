import { z } from 'zod';
export declare const RELEASE_NOTES_MAX_BYTES = 16384;
/** Immutable plain text, not executable configuration or evidence of authorization. */
export declare const releaseNotesSchema: z.ZodString;
export declare const releaseSnapshotSchema: z.ZodObject<{
    format: z.ZodLiteral<"jevable.ai/release">;
    schemaVersion: z.ZodLiteral<1>;
    id: z.ZodUUID;
    version: z.ZodString;
    createdAt: z.ZodISODateTime;
    createdBy: z.ZodString;
    project: z.ZodObject<{
        id: z.ZodUUID;
        generation: z.ZodNumber;
    }, z.core.$strict>;
    workflow: z.ZodObject<{
        revision: z.ZodString;
        yaml: z.ZodString;
    }, z.core.$strict>;
    runtime: z.ZodObject<{
        version: z.ZodString;
        sha256: z.ZodString;
    }, z.core.$strict>;
    notes: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type ReleaseSnapshot = z.infer<typeof releaseSnapshotSchema>;
export type Release = {
    snapshot: ReleaseSnapshot;
    sha256: string;
};
export declare const releaseCreateCommandSchema: z.ZodObject<{
    id: z.ZodOptional<z.ZodUUID>;
    projectId: z.ZodUUID;
    expectedGeneration: z.ZodNumber;
    revision: z.ZodString;
    version: z.ZodString;
    runtime: z.ZodObject<{
        version: z.ZodString;
        sha256: z.ZodString;
    }, z.core.$strict>;
    actor: z.ZodString;
    notes: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type ReleaseCreateCommand = z.infer<typeof releaseCreateCommandSchema>;
/** Validate executable graph support, but never invent configured providers or execute a node. */
export declare function inspectRelease(value: unknown): Release;
export declare function releaseRequirements(snapshot: ReleaseSnapshot): {
    credentials: string;
    inputSchema: {
        readonly [key: string]: import("../workflow/types.ts").ReadonlyJsonValue;
    };
    runtimeReadiness: string;
    apiTrigger?: {
        selection: string;
        defaultLocal: string;
        ingress: string;
        authorization: string;
    };
    schemaVersion: number;
    node: string;
    protocol: string;
    models: {
        node: string;
        connectionId: string;
        provider: string;
        model: string;
        timeoutSeconds: number;
        maxAttempts: number;
        protocol?: "systemone";
        answerFormat?: "systemone-v1";
    }[];
};
/** Presentation fields for an authenticated exact-release viewer.
 * Exclude node config, bindings, source YAML and credentials. A loop remains
 * one top-level card until internal-step inspection is separately scoped.
 */
export declare function releaseGraph(snapshot: ReleaseSnapshot): {
    order: import("../workflow/types.ts").NodeId[];
    nodes: {
        actions?: string[];
        description?: string;
        title?: string;
        id: import("../workflow/types.ts").NodeId;
        kind: "custom" | "output" | "trigger" | "llm" | "decision" | "loop" | "humanApproval" | "ifElse" | "switch";
    }[];
    edges: {
        port?: string;
        from: import("../workflow/types.ts").NodeId;
        to: import("../workflow/types.ts").NodeId;
    }[];
    description?: string;
    schemaVersion: 1;
    name: string;
};

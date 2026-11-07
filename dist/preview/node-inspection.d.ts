import { z } from 'zod';
import { type WorkflowCompilerLimits } from '../workflow/index.ts';
import type { WorkflowPreview } from './model.ts';
export declare const previewNodeSelectionSchema: z.ZodObject<{
    graphScope: z.ZodString;
    nodeId: z.ZodString;
    record: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"step">;
        index: z.ZodNumber;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"checkpoint">;
    }, z.core.$strict>], "kind">;
}, z.core.$strict>;
export declare const previewNodeInspectionRequestSchema: z.ZodObject<{
    id: z.ZodUUID;
    expectedCheckpointSha256: z.ZodString;
    selection: z.ZodObject<{
        graphScope: z.ZodString;
        nodeId: z.ZodString;
        record: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"step">;
            index: z.ZodNumber;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"checkpoint">;
        }, z.core.$strict>], "kind">;
    }, z.core.$strict>;
}, z.core.$strict>;
export type PreviewNodeSelection = z.infer<typeof previewNodeSelectionSchema>;
export type PreviewNodeInspectionRequest = z.infer<typeof previewNodeInspectionRequestSchema>;
/** Private, detached projection of one exact retained record. Never binds, executes or reconstructs values. */
export declare function projectPreviewNodeInspection(preview: WorkflowPreview, value: unknown, request: unknown, sourceLimits?: WorkflowCompilerLimits['source']): {
    previousStatus?: "paused" | "waiting" | "executing";
    code?: import("../runtime/run-evaluator.ts").RunFailureCode;
    port?: string;
    attemptId?: import("../runtime/run-types.ts").JevableAttemptId;
    scope?: import("../runtime/run-evaluator.ts").LoopScope;
    schemaVersion: 1;
    format: "jevable.preview-node-inspection/v1";
    privateInspection: true;
    runId: string;
    revision: string;
    checkpointSha256: string;
    selection: {
        graphScope: string;
        nodeId: string;
        record: {
            kind: "step";
            index: number;
        } | {
            kind: "checkpoint";
        };
    };
    kind: "checkpoint" | "node-result" | "loop-iteration-result" | "loop-aggregate";
    status: string;
    input: {
        status: "unavailable";
        value?: never;
    } | {
        status: "recorded";
        value: import("../workflow/types.ts").ReadonlyJsonValue;
    };
    output: {
        status: "recorded";
        value: import("../workflow/types.ts").ReadonlyJsonValue;
    } | {
        status: "unavailable" | "unsettled";
    };
};
export type PreviewNodeInspection = ReturnType<typeof projectPreviewNodeInspection>;

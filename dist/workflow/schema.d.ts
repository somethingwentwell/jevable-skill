/** Strict source envelope; node-specific configuration belongs to runtime admission. */
import { z } from 'zod';
import type { NodeId, WorkflowId } from './types.ts';
/** Source schema rejects unknown envelope fields without discarding configuration data. */
export declare const workflowSchema: z.ZodObject<{
    apiVersion: z.ZodLiteral<"jevable.ai/v1alpha1">;
    kind: z.ZodLiteral<"Workflow">;
    metadata: z.ZodObject<{
        id: z.ZodPipe<z.ZodString, z.ZodTransform<WorkflowId, string>>;
        name: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    spec: z.ZodObject<{
        inputSchema: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
        nodes: z.ZodRecord<z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>, z.ZodObject<{
            type: z.ZodEnum<{
                custom: "custom";
                output: "output";
                trigger: "trigger";
                llm: "llm";
                decision: "decision";
                rule: "rule";
                loop: "loop";
                humanApproval: "humanApproval";
            }>;
            title: z.ZodOptional<z.ZodString>;
            description: z.ZodOptional<z.ZodString>;
            config: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
            extensions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodJSONSchema>>;
        }, z.core.$strict>>;
        edges: z.ZodArray<z.ZodObject<{
            from: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            to: z.ZodPipe<z.ZodString, z.ZodTransform<NodeId, string>>;
            port: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        presentation: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodJSONSchema>>;
        extensions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodJSONSchema>>;
    }, z.core.$strict>;
    extensions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodJSONSchema>>;
}, z.core.$strict>;

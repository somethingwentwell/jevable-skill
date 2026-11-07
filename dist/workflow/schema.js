/** Strict source envelope; node-specific configuration belongs to runtime admission. */
import { z } from 'zod';
const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/u).max(128)
    .refine(value => !['__proto__', 'constructor', 'prototype'].includes(value));
const nodeId = identifier.transform(value => value);
const object = z.record(z.string(), z.json());
const extensions = z.record(z.string().regex(/^[a-z][a-z0-9.-]*\/[A-Za-z0-9_.-]+$/u), z.json());
const node = z.strictObject({
    type: z.enum(['trigger', 'llm', 'decision', 'rule', 'loop', 'humanApproval', 'custom', 'output']),
    title: z.string().optional(),
    description: z.string().optional(),
    config: object,
    extensions: extensions.optional(),
});
/** Source schema rejects unknown envelope fields without discarding configuration data. */
export const workflowSchema = z.strictObject({
    apiVersion: z.literal('jevable.ai/v1alpha1'),
    kind: z.literal('Workflow'),
    metadata: z.strictObject({
        id: identifier.transform(value => value),
        name: z.string().trim().min(1).max(256),
        description: z.string().optional(),
    }),
    spec: z.strictObject({
        inputSchema: object,
        nodes: z.record(nodeId, node),
        edges: z.array(z.strictObject({ from: nodeId, to: nodeId, port: identifier.optional() })),
        presentation: object.optional(),
        extensions: extensions.optional(),
    }),
    extensions: extensions.optional(),
});

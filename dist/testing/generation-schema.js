import { z } from 'zod';
import { createHash } from 'node:crypto';
import { testDefinitionSchema } from "./schema.js";
import { GENERATION_LIMITS, GENERATOR_VERSION } from "./generate.js";
export const generateTestsSchema = z.strictObject({ id: z.uuid(), project: testDefinitionSchema.shape.project,
    limit: z.number().int().min(1).max(GENERATION_LIMITS.candidates).default(12), actor: z.string().trim().min(1).max(256),
    triggerMode: testDefinitionSchema.shape.triggerMode });
export const generationSnapshotSchema = z.strictObject({ schemaVersion: z.literal(1), format: z.literal('jevable.ai/test-generation'),
    id: z.uuid(), generator: z.literal(GENERATOR_VERSION), createdAt: z.iso.datetime(), actor: z.string().trim().min(1).max(256),
    request: generateTestsSchema.omit({ id: true, actor: true }),
    status: z.enum(['review-required', 'no-candidates']), execution: z.literal('not-run'),
    expectations: z.literal('completion-suggestion-only; review-before-acceptance'), coverage: z.literal('schema-samples-not-branch-proof'),
    diagnostics: z.strictObject({ attempted: z.number().int().min(0).max(GENERATION_LIMITS.attempts),
        invalid: z.number().int().nonnegative(), skippedBounds: z.number().int().nonnegative(),
        totalInputBytes: z.number().int().min(0).max(GENERATION_LIMITS.totalInputBytes), limitReached: z.boolean(), noSeed: z.boolean() }),
    cases: z.array(z.strictObject({ id: z.uuid(), generation: z.literal(1), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        definition: testDefinitionSchema, reason: z.enum(['sample', 'required-only', 'enum', 'boolean', 'minimum', 'maximum', 'empty', 'optional-omitted', 'array-length']),
        path: z.string().max(4096) })).max(GENERATION_LIMITS.candidates),
});
export const generationHash = (snapshot) => createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');

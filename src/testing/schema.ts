import { z } from 'zod'
import { createHash } from 'node:crypto'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { apiTriggerModeSchema } from '../runtime/trigger.ts'

const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const node = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/u).max(128)
const selector = { nodeId: node, scope: z.strictObject({ loop: node, index: z.number().int().nonnegative().max(1000000) }).optional() }
export const expectationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('status'), value: z.enum(['completed', 'failed', 'waiting', 'cancelled']) }),
  z.strictObject({ kind: z.literal('output-equals'), value: z.json() }),
  z.strictObject({ kind: z.literal('failure-code'), value: z.enum(['invalid-node-value', 'loop-limit', 'loop-timeout', 'approval-rejected', 'approval-expired', 'ai-budget']) }),
  z.strictObject({ kind: z.literal('node-visited'), ...selector }),
  z.strictObject({ kind: z.literal('node-output-equals'), ...selector, value: z.json() }),
  z.strictObject({ kind: z.literal('node-port-equals'), ...selector, value: node }),
])
export const testDefinitionSchema = z.strictObject({
  title: z.string().trim().min(1).max(256),
  project: z.strictObject({ id: z.uuid(), generation, revision: hash }),
  input: z.json(), expectations: z.array(expectationSchema).min(1).max(64), triggerMode: apiTriggerModeSchema.optional(),
}).superRefine((value, ctx) => {
  const statuses = value.expectations.filter(item => item.kind === 'status')
  if (statuses.length !== 1 || (value.expectations.some(item => item.kind === 'output-equals') && statuses[0]?.value !== 'completed'))
    ctx.addIssue({ code: 'custom', message: 'Require one status expectation; final output requires completed status.' })
  if (value.expectations.some(item => item.kind === 'failure-code') && statuses[0]?.value !== 'failed')
    ctx.addIssue({ code: 'custom', message: 'Failure-code requires failed status.' })
})
export const testIdentitySchema = z.strictObject({ id: z.uuid(), generation, sha256: hash })
export const importedTestSchema = z.strictObject({ bundleSha256: hash, source: testIdentitySchema,
  project: testDefinitionSchema.shape.project, status: z.enum(['draft', 'accepted']) })
export const transferredTestsSchema = z.strictObject({ scope: z.literal('accepted-revision-latest-definitions'),
  excludedOtherRevisions: z.number().int().nonnegative().max(10000),
  excludedArchived: z.number().int().positive().max(10000).optional(),
  cases: z.array(z.strictObject({ source: testIdentitySchema, status: z.enum(['draft', 'accepted']), definition: testDefinitionSchema })).max(1000) })
export type TransferredTests = z.infer<typeof transferredTestsSchema>
export type ImportedTest = z.infer<typeof importedTestSchema>
const actor = z.string().trim().min(1).max(256)
const guard = { id: z.uuid(), expectedGeneration: generation, actor }
export const testCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('create'), id: z.uuid().optional(), definition: testDefinitionSchema, actor }),
  z.strictObject({ operation: z.literal('edit'), ...guard, definition: testDefinitionSchema }),
  z.strictObject({ operation: z.literal('accept'), ...guard, reviewedSha256: hash }),
  z.strictObject({ operation: z.literal('archive'), ...guard, reviewedSha256: hash, archived: z.boolean() }),
])
export const testVersionSchema = z.strictObject({ generation, operation: z.enum(['create', 'edit', 'accept', 'archive']),
  status: z.enum(['draft', 'accepted']), archived: z.boolean().optional(), definition: testDefinitionSchema, sha256: hash, actor, at: z.iso.datetime() })
export const testRecordSchema = z.strictObject({ schemaVersion: z.literal(1), id: z.uuid(), versions: z.array(testVersionSchema).min(1).max(100),
  importedFrom: importedTestSchema.optional() })
export type TestDefinition = z.infer<typeof testDefinitionSchema>
export type TestCommand = z.infer<typeof testCommandSchema>
export type TestIdentity = z.infer<typeof testIdentitySchema>
export type TestVersion = z.infer<typeof testVersionSchema>
export type TestCase = TestVersion & { schemaVersion: 1; id: string; importedFrom?: ImportedTest }
export const testHash = (definition: TestDefinition) => createHash('sha256').update(JSON.stringify(definition)).digest('hex')

/** Bound SDK inputs as well as JSON transport before recursive schema parsing. */
export function parseTest<T>(schema: z.ZodType<T>, value: unknown, maxBytes = 250000): T {
  try {
    const encoded = JSON.stringify(value)
    if (!encoded || Buffer.byteLength(encoded) > maxBytes) throw new Error()
    return schema.parse(value)
  } catch { throw new WorkflowRuntimeError('invalid-command') }
}

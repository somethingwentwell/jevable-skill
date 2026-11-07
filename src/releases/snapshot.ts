import { createHash } from 'node:crypto'
import { z } from 'zod'
import { CORE_VERSION } from '../capabilities.ts'
import { DEFAULT_COMPILER_LIMITS } from '../limits.ts'
import { compileRuntimeWorkflow, executionModelPlans } from '../runtime/admission.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { modelRequestPlan } from '../runtime/model-plan.ts'
import type { CompiledWorkflowNode } from '../workflow/index.ts'
import { MAX_MODEL_ATTEMPTS } from '../providers/records.ts'

const hash = z.string().regex(/^[a-f0-9]{64}$/u)
export const RELEASE_NOTES_MAX_BYTES = 16_384
/** Immutable plain text, not executable configuration or evidence of authorization. */
export const releaseNotesSchema = z.string().min(1).max(RELEASE_NOTES_MAX_BYTES)
  .refine(value => value.isWellFormed() && value.trim().length > 0
    && Buffer.byteLength(value, 'utf8') <= RELEASE_NOTES_MAX_BYTES
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))
export const releaseSnapshotSchema = z.strictObject({ format: z.literal('jevable.ai/release'), schemaVersion: z.literal(1),
  id: z.uuid(), version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u).max(128),
  createdAt: z.iso.datetime(), createdBy: z.string().trim().min(1).max(256),
  project: z.strictObject({ id: z.uuid(), generation: z.number().int().positive() }),
  workflow: z.strictObject({ revision: hash, yaml: z.string().max(1_000_000) }),
  runtime: z.strictObject({ version: z.string().min(1).max(128), sha256: hash }),
  notes: releaseNotesSchema.optional(),
})
export type ReleaseSnapshot = z.infer<typeof releaseSnapshotSchema>
export type Release = { snapshot: ReleaseSnapshot; sha256: string }
export const releaseCreateCommandSchema = z.strictObject({ id: z.uuid().optional(), projectId: z.uuid(),
  expectedGeneration: z.number().int().positive(), revision: releaseSnapshotSchema.shape.workflow.shape.revision,
  version: releaseSnapshotSchema.shape.version, runtime: releaseSnapshotSchema.shape.runtime,
  actor: releaseSnapshotSchema.shape.createdBy, notes: releaseNotesSchema.optional() })
export type ReleaseCreateCommand = z.infer<typeof releaseCreateCommandSchema>

/** Validate executable graph support, but never invent configured providers or execute a node. */
export function inspectRelease(value: unknown): Release {
  const parsed = releaseSnapshotSchema.safeParse(value)
  if (!parsed.success) throw new WorkflowRuntimeError('invalid-command')
  const snapshot = parsed.data
  if (snapshot.runtime.version !== CORE_VERSION) throw new WorkflowRuntimeError('conflict')
  const graph = compileRuntimeWorkflow(snapshot.workflow.yaml, DEFAULT_COMPILER_LIMITS)
  if (graph.source.revision !== snapshot.workflow.revision || graph.source.yaml !== snapshot.workflow.yaml) throw new WorkflowRuntimeError('conflict')
  for (const node of executionModelPlans(graph)) {
    const plan = modelRequestPlan(node)
    if (plan.connection.mode !== 'workspace' || plan.execution.maxAttempts > MAX_MODEL_ATTEMPTS || plan.execution.timeoutSeconds > 3600) throw new WorkflowRuntimeError('invalid-command')
  }
  return { snapshot, sha256: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') }
}

export function releaseRequirements(snapshot: ReleaseSnapshot) {
  const graph = compileRuntimeWorkflow(snapshot.workflow.yaml, DEFAULT_COMPILER_LIMITS)
  const models: { node: string; connectionId: string; provider: string; model: string; timeoutSeconds: number; maxAttempts: number; protocol?: 'systemone'; answerFormat?: 'systemone-v1' }[] = []
  const visit = (nodes: readonly CompiledWorkflowNode[], prefix = '') => {
    for (const node of nodes) {
      if (node.plan.kind === 'loop') visit(node.plan.body.nodes, `${prefix}${node.id}/`)
      if (node.plan.kind !== 'llm' && node.plan.kind !== 'decision') continue
      const plan = modelRequestPlan(node.plan)
      if (plan.connection.mode !== 'workspace') throw new WorkflowRuntimeError('invalid-command')
      models.push({ node: prefix + node.id, connectionId: plan.connection.id, provider: plan.provider, model: plan.model,
        timeoutSeconds: plan.execution.timeoutSeconds, maxAttempts: plan.execution.maxAttempts,
        ...(plan.responseFormat === 'systemone-v1' ? { protocol: 'systemone', answerFormat: 'systemone-v1' } as const : {}) })
    }
  }
  visit(graph.nodes)
  const trigger = graph.nodes[0]!.plan
  const api = trigger.kind === 'trigger' && trigger.modes.includes('api')
  return { schemaVersion: 1, node: '>=22.19', protocol: models.some(model => model.protocol === 'systemone')
    ? models.every(model => model.protocol === 'systemone') ? 'systemone' : 'mixed' : 'openai-compatible', models,
    ...(api ? { apiTrigger: { selection: 'explicit-triggerMode-api',
      defaultLocal: trigger.modes.some(mode => mode === 'manual' || mode === 'chat') ? 'available' : 'unavailable',
      ingress: 'not-provisioned', authorization: 'caller-and-host-policy-required' } } : {}),
    credentials: 'Provision independently; no originating connection configuration or credential material is exported.',
    inputSchema: graph.source.document.spec.inputSchema, runtimeReadiness: 'not-checked-in-target-environment' }
}

/** Presentation fields for an authenticated exact-release viewer.
 * Exclude node config, bindings, source YAML and credentials. A loop remains
 * one top-level card until internal-step inspection is separately scoped.
 */
export function releaseGraph(snapshot: ReleaseSnapshot) {
  const graph = compileRuntimeWorkflow(snapshot.workflow.yaml, DEFAULT_COMPILER_LIMITS)
  const document = graph.source.document
  return {
    schemaVersion: 1 as const,
    name: document.metadata.name,
    ...(document.metadata.description === undefined ? {} : { description: document.metadata.description }),
    order: [...graph.source.order],
    nodes: graph.nodes.map(node => {
      const source = document.spec.nodes[node.id]
      if (!source) throw new WorkflowRuntimeError('corrupt')
      return { id: node.id, kind: node.plan.kind,
        ...(source.title === undefined ? {} : { title: source.title }),
        ...(source.description === undefined ? {} : { description: source.description }),
        ...(node.plan.kind === 'humanApproval' ? { actions: [...node.plan.actions] } : {}) }
    }),
    edges: document.spec.edges.map(edge => ({ from: edge.from, to: edge.to,
      ...(edge.port === undefined ? {} : { port: edge.port }) })),
  }
}

import { createHash } from 'node:crypto'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import { DEFAULT_COMPILER_LIMITS } from '../limits.ts'
import { parseWorkflow, admitWorkflowData, WorkflowSourceError, type WorkflowCompilerLimits, type WorkflowNode } from '../workflow/index.ts'
import { workflowSchema } from '../workflow/schema.ts'
import { validateSource } from '../validation.ts'
import { deepFreeze } from '../shared/values.ts'

const nodeSchema = workflowSchema.shape.spec.shape.nodes.valueType
const bodySchema = z.object({ entry: z.string(), nodes: z.record(z.string(), nodeSchema),
  edges: z.array(z.object({ from: z.string(), to: z.string(), port: z.string().optional() })),
  exits: z.array(z.object({ from: z.string(), port: z.string().optional(), result: z.json() })) })
export interface PreviewNode {
  id: string; node: WorkflowNode; bodyScope?: string
}
export interface PreviewGraph {
  scope: string; label: string; entry: string | null; nodes: PreviewNode[];
  edges: { from: string; to: string; port?: string | undefined }[];
  exits: { from: string; port?: string | undefined; result: unknown }[];
  diagnostics: string[]
}
export interface WorkflowPreview {
  format: 'jevable.preview/v1'; sourceSha256: string; revision: string | null;
  name: string; workflowId: string; source: string; validation: ReturnType<typeof validateSource>;
  graphs: PreviewGraph[]; execution: 'not-run'; runtimeReadiness: 'not-checked';
  privacy: 'workflow-source-included; runtime-data-excluded'
}

/** Admit preview data independently of executable compilation. Never invent a revision for invalid structure. */
export function createPreview(source: string, limits: WorkflowCompilerLimits = DEFAULT_COMPILER_LIMITS): WorkflowPreview {
  if (Buffer.byteLength(source) > limits.source.maxSourceBytes) throw new WorkflowSourceError('Preview source exceeds the byte budget.')
  const validation = validateSource(source, limits)
  let document: z.infer<typeof workflowSchema>, revision: string | null = null
  try {
    const snapshot = parseWorkflow(source, limits.source)
    document = structuredClone(snapshot.document) as z.infer<typeof workflowSchema>
    revision = snapshot.revision
  } catch (error) {
    if (!(error instanceof WorkflowSourceError)) throw error
    // Readable but structurally invalid graphs remain inspectable, with no canonical revision claim.
    let value: unknown
    try {
      const yaml = parseDocument(source, { schema: 'core', uniqueKeys: true, strict: true })
      if (yaml.errors.length || yaml.warnings.length) throw new Error()
      value = yaml.toJS({ maxAliasCount: 0 })
    } catch { throw new WorkflowSourceError('Preview requires one readable workflow document without aliases or custom tags.') }
    const admitted = admitWorkflowData(value, { maxBytes: limits.source.maxSourceBytes, maxDepth: limits.source.maxDepth, maxValues: limits.source.maxValues })
    const parsed = workflowSchema.safeParse(admitted)
    if (!parsed.success) throw new WorkflowSourceError('Preview requires the workflow document envelope and known node families.')
    document = parsed.data
  }
  const graphs: PreviewGraph[] = []
  let nodeCount = 0, edgeCount = 0
  const append = (graph: PreviewGraph) => {
    nodeCount += graph.nodes.length; edgeCount += graph.edges.length + graph.exits.length
    if (nodeCount > 2000 || edgeCount > 4000 || graph.nodes.length > limits.source.maxNodes || graph.edges.length > limits.source.maxEdges) {
      throw new WorkflowSourceError('Preview exceeds the graph budget (2,000 total nodes / 4,000 connections).')
    }
    const ids = new Set(graph.nodes.map(item => item.id))
    if (graph.entry && !ids.has(graph.entry)) graph.diagnostics.push('Entry refers to a missing node.')
    if (graph.edges.some(edge => !ids.has(edge.from) || !ids.has(edge.to)) || graph.exits.some(exit => !ids.has(exit.from))) {
      graph.diagnostics.push('Connections refer to missing nodes; inspect the connection list. No placeholder nodes were invented.')
    }
    graphs.push(graph)
  }
  const outer: PreviewGraph = { scope: 'workflow', label: document.metadata.name,
    entry: Object.entries(document.spec.nodes).find(([, node]) => node.type === 'trigger')?.[0] ?? null,
    nodes: Object.entries(document.spec.nodes).map(([id, node]) => ({ id, node })),
    edges: [...document.spec.edges], exits: [], diagnostics: [] }
  append(outer)
  for (const item of outer.nodes) {
    if (item.node.type !== 'loop') continue
    const body = bodySchema.safeParse(item.node.config.body)
    if (!body.success) { outer.diagnostics.push(`Loop ${item.id} has an unreadable body; inspect its configuration.`); continue }
    const scope = `workflow/${item.id}`
    item.bodyScope = scope
    append({ scope, label: `${item.node.title ?? item.id} — loop body`, entry: body.data.entry,
      nodes: Object.entries(body.data.nodes).map(([id, node]) => ({ id, node })),
      edges: body.data.edges, exits: body.data.exits, diagnostics: body.data.nodes && Object.values(body.data.nodes).some(node => node.type === 'loop')
        ? ['Nested loops are unsupported; inspect their configuration without assuming execution support.'] : [] })
  }
  return deepFreeze({ format: 'jevable.preview/v1', sourceSha256: createHash('sha256').update(source).digest('hex'),
    revision, name: document.metadata.name, workflowId: document.metadata.id, source, validation, graphs,
    execution: 'not-run', runtimeReadiness: 'not-checked', privacy: 'workflow-source-included; runtime-data-excluded' }) as WorkflowPreview
}

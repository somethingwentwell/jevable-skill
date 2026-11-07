/** Bounded YAML admission, structural graph validation and content-addressed source snapshots. */
import { createHash } from 'node:crypto'
import { deepFreeze } from '../shared/values.ts'
import { parseDocument, stringify } from 'yaml'
import { workflowSchema } from './schema.ts'
import { assertJsonTree } from './json-data.ts'
import { schemaIssues } from './issues.ts'
import { WorkflowSourceError } from './errors.ts'
import type { NodeId, RevisionHash, WorkflowDiff, WorkflowDocument, WorkflowLimits, WorkflowSnapshot } from './types.ts'


function assertLimits(limits: WorkflowLimits): void {
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1) || limits.maxDepth > 128) {
    throw new WorkflowSourceError('Workflow budgets must be positive safe integers; maxDepth cannot exceed 128.')
  }
}


function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function graphOrder(document: WorkflowDocument, limits: WorkflowLimits): NodeId[] {
  interface Vertex { id: NodeId; type: string; incoming: number; outgoing: Vertex[] }
  const vertices: Vertex[] = Object.entries(document.spec.nodes)
    .map(([id, node]) => ({ id: id as NodeId, type: node.type, incoming: 0, outgoing: [] }))
    .sort((a, b) => a.id < b.id ? -1 : 1)
  if (vertices.length > limits.maxNodes || document.spec.edges.length > limits.maxEdges) {
    throw new WorkflowSourceError('Workflow exceeds the configured node or edge budget.')
  }
  const triggers = vertices.filter(node => node.type === 'trigger')
  const trigger = triggers[0]
  if (!trigger || triggers.length !== 1) throw new WorkflowSourceError('Workflow requires exactly one Trigger.')
  if (!vertices.some(node => node.type === 'output')) {
    throw new WorkflowSourceError('Workflow requires at least one Output.')
  }
  const lookup = new Map(vertices.map(node => [node.id, node]))
  const connections = new Set<string>()
  for (const edge of document.spec.edges) {
    const from = lookup.get(edge.from), to = lookup.get(edge.to)
    if (!from || !to) {
      throw new WorkflowSourceError('Workflow edge references a missing node.')
    }
    const key = JSON.stringify([edge.from, edge.port ?? ''])
    if (connections.has(key)) throw new WorkflowSourceError('A node output port cannot have multiple outgoing edges.')
    connections.add(key)
    to.incoming++
    from.outgoing.push(to)
  }
  if (trigger.incoming !== 0) throw new WorkflowSourceError('Trigger cannot have incoming edges.')
  for (const node of vertices) {
    const terminal = node.type === 'output'
    if (terminal && node.outgoing.length) throw new WorkflowSourceError('Output cannot have outgoing edges.')
    if (!terminal && !node.outgoing.length) throw new WorkflowSourceError('Every non-Output node requires a continuation.')
  }
  const reachable = new Set<Vertex>()
  const pending = [trigger]
  for (let node = pending.pop(); node; node = pending.pop()) {
    if (reachable.has(node)) continue
    reachable.add(node)
    pending.push(...node.outgoing)
  }
  if (reachable.size !== vertices.length) throw new WorkflowSourceError('Workflow contains unreachable nodes.')
  const ready = vertices.filter(node => node.incoming === 0)
  const order: NodeId[] = []
  for (let node = ready.shift(); node; node = ready.shift()) {
    order.push(node.id)
    for (const next of node.outgoing) {
      next.incoming--
      if (next.incoming === 0) ready.push(next)
    }
    ready.sort((a, b) => a.id < b.id ? -1 : 1)
  }
  if (order.length !== vertices.length) throw new WorkflowSourceError('Outer workflow graph cannot contain cycles; use a bounded Loop.')
  return order
}

/**
 * Admit wire/file data and return a detached immutable, canonical source snapshot.
 * Node configuration, typed references, loop bodies and runtime capabilities need further validation before execution.
 * @param value - unknown JSON-compatible source data.
 * @param limits - explicit admission budgets from the consuming service configuration.
 * @returns frozen source, canonical YAML, SHA-256 revision and deterministic outer topological order.
 * @throws WorkflowSourceError for malformed, oversized or structurally invalid sources.
 */
export function snapshotWorkflow(value: unknown, limits: WorkflowLimits): WorkflowSnapshot {
  assertLimits(limits)
  assertJsonTree(value, limits)
  const parsed = workflowSchema.safeParse(value)
  if (!parsed.success) throw new WorkflowSourceError(`Workflow source does not match the v1alpha1 document schema: ${schemaIssues(parsed.error.issues)}`)
  const document = parsed.data
  const order = graphOrder(document, limits)
  // Edges are an unordered graph set; preserve array order everywhere else (e.g. Switch cases).
  document.spec.edges.sort((a, b) => canonical(a) < canonical(b) ? -1 : 1)
  const json = canonical(document)
  if (Buffer.byteLength(json, 'utf8') > limits.maxSourceBytes) {
    throw new WorkflowSourceError('Canonical workflow exceeds the configured source byte budget.')
  }
  const normalized = JSON.parse(json) as WorkflowDocument
  const yaml = stringify(normalized, { lineWidth: 0, aliasDuplicateObjects: false })
  if (Buffer.byteLength(yaml, 'utf8') > limits.maxSourceBytes) {
    throw new WorkflowSourceError('Canonical YAML exceeds the configured source byte budget.')
  }
  return deepFreeze({
    document: normalized,
    revision: createHash('sha256').update(json).digest('hex') as RevisionHash,
    yaml,
    order,
  })
}

/**
 * Parse exactly one YAML document, without custom tags, aliases, duplicate keys or executable constructors.
 * @param source - UTF-8 workflow YAML text.
 * @param limits - explicit parsing and graph budgets.
 * @returns the same immutable source snapshot produced by snapshotWorkflow.
 * @throws WorkflowSourceError without reflecting YAML source excerpts.
 */
export function parseWorkflow(source: string, limits: WorkflowLimits): WorkflowSnapshot {
  assertLimits(limits)
  if (Buffer.byteLength(source, 'utf8') > limits.maxSourceBytes) {
    throw new WorkflowSourceError('Workflow YAML exceeds the configured source byte budget.')
  }
  let value: unknown
  try {
    const parsed = parseDocument(source, { schema: 'core', uniqueKeys: true, strict: true })
    if (parsed.errors.length || parsed.warnings.length) throw new Error('Invalid YAML')
    value = parsed.toJS({ maxAliasCount: 0 })
  } catch (_error) {
    throw new WorkflowSourceError('Workflow must be one valid YAML document without aliases, duplicate keys or custom tags.')
  }
  return snapshotWorkflow(value, limits)
}

/**
 * Compare admitted revisions without embedding configuration values in the change record.
 * @param before - previous admitted source snapshot.
 * @param after - proposed admitted source snapshot.
 * @returns immutable node and document-section change metadata.
 */
export function diffWorkflows(before: WorkflowSnapshot, after: WorkflowSnapshot): WorkflowDiff {
  const oldNodes = before.document.spec.nodes
  const newNodes = after.document.spec.nodes
  const oldIds = Object.keys(oldNodes).sort() as NodeId[]
  const newIds = Object.keys(newNodes).sort() as NodeId[]
  return deepFreeze({
    from: before.revision,
    to: after.revision,
    addedNodes: newIds.filter(id => !Object.hasOwn(oldNodes, id)),
    removedNodes: oldIds.filter(id => !Object.hasOwn(newNodes, id)),
    changedNodes: newIds.filter(id => Object.hasOwn(oldNodes, id) && canonical(oldNodes[id]) !== canonical(newNodes[id])),
    edgesChanged: canonical(before.document.spec.edges) !== canonical(after.document.spec.edges),
    inputSchemaChanged: canonical(before.document.spec.inputSchema) !== canonical(after.document.spec.inputSchema),
    metadataChanged: canonical(before.document.metadata) !== canonical(after.document.metadata),
    presentationChanged: canonical(before.document.spec.presentation ?? null) !== canonical(after.document.spec.presentation ?? null),
    extensionsChanged: canonical([before.document.extensions ?? null, before.document.spec.extensions ?? null])
      !== canonical([after.document.extensions ?? null, after.document.spec.extensions ?? null]),
  })
}

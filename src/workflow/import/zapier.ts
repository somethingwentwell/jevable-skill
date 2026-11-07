/** Zapier "Export Zaps" JSON to a reviewable Jevable draft for the first Zap and a documented step subset. */
import { DraftBuilder, workflowId, type DraftNode } from './import-draft.ts'
import type { ImportMappingKind, ImportMappingReason, ImportResult } from './import-types.ts'
import { VendorSteps, aiStep, blocked } from './vendor-steps.ts'

type Criterion = { key?: unknown; match?: unknown; value?: unknown }
interface ZapNode {
  id: number
  parent_id?: number | null
  type_of?: string
  selected_api?: string
  action?: string
  title?: string | null
  params?: Record<string, unknown>
}
type Zap = { id?: number; title?: string; nodes: Record<string, ZapNode> }
type ZapExport = { metadata?: { version?: unknown }; zaps: Zap[] }

/** Export `metadata.version` values this converter understands. */
export const ZAPIER_EXPORT_VERSIONS = /^1\.\d+\.\d+$/u
const aiApis = [[/^ChatGPT|^OpenAI/u, 'openai'], [/^Anthropic|^Claude/u, 'anthropic'], [/^Gemini|^GoogleAI/u, 'gemini']] as const
const matches: Readonly<Record<string, '==' | '!=' | '>' | '<'>> = { exact: '==', text_exact: '==', not_exact: '!=', text_not_exact: '!=',
  num_gt: '>', num_lt: '<' }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Whether a parsed JSON value looks like a Zapier Zap export.
 * @param value - Parsed file content.
 * @returns true for an object with a `zaps` list whose first entry has a node map.
 */
export function isZapierExport(value: unknown): value is ZapExport {
  return object(value) && Array.isArray(value.zaps) && value.zaps.length > 0 && object(value.zaps[0]) && object(value.zaps[0].nodes)
    && Object.values(value.zaps[0].nodes).every(node => object(node) && typeof node.id === 'number')
}

/**
 * The export format version.
 * @param exported - Detected export.
 * @returns the version when this converter supports it, otherwise undefined.
 */
export function zapierVersion(exported: ZapExport): string | undefined {
  const version = exported.metadata?.version
  return typeof version === 'string' && ZAPIER_EXPORT_VERSIONS.test(version) ? version : undefined
}

/**
 * Convert the first Zap of an export. The trigger becomes a manual Start, a Filter step one If/Else Rule when it is one
 * comparison of a trigger field, and AI steps LLM steps; each step follows its first child, and Paths and other apps become
 * placeholders that keep the draft from running.
 * @param exported - Parsed export with a supported version.
 * @param version - Supported export version.
 * @returns the draft and its mapping report.
 */
export function convertZapier(exported: ZapExport, version: string): ImportResult {
  // oxlint-disable-next-line typescript/no-non-null-assertion -- detection requires at least one Zap
  const zap = exported.zaps[0]!, draft = new DraftBuilder(), title = zap.title?.trim() || 'Imported Zap'
  const steps = new VendorSteps(draft, (body) => {
    const [, step, path] = /^(\d+)__([A-Za-z0-9_]+(?:__[A-Za-z0-9_]+)*)$/u.exec(body) ?? []
    return step && path ? { step, path: path.split('__') } : undefined
  })
  const nodes = Object.values(zap.nodes).sort((a, b) => a.id - b.id)
  const children = (id: number) => nodes.filter(node => node.parent_id === id)
  const label = (node: ZapNode) => node.title?.trim() || `${node.selected_api ?? 'Step'} ${String(node.id)}`
  const add = (node: ZapNode, converted: { node: DraftNode; kind: ImportMappingKind; reason: ImportMappingReason }) =>
    draft.add(String(node.id), label(node), node.selected_api ?? node.type_of ?? 'unknown', converted.node, converted.kind, converted.reason)
  const root = nodes.find(node => node.parent_id === null || node.parent_id === undefined)
  if (root) {
    const start = add(root, { node: { type: 'trigger', config: { modes: ['manual'] } }, kind: 'approximate', reason: 'trigger-mode' })
    steps.remember(String(root.id), start, 'trigger')
    let previous = start, port: string | undefined, current = children(root.id)
    while (current.length) {
      const [node, ...others] = current as [ZapNode, ...ZapNode[]]
      for (const other of others) draft.note(label(other), other.selected_api ?? 'unknown', 'unsupported', 'unreachable')
      const api = node.selected_api ?? '', params = node.params ?? {}
      let id: string
      if (api.startsWith('FilterAPI')) {
        const [[only, ...more] = [], ...groups] = (Array.isArray(params.filter_criteria) ? params.filter_criteria : []) as Criterion[][]
        const operator = typeof only?.match === 'string' ? matches[only.match] : undefined
        const condition = only && !more.length && !groups.length && operator && typeof only.key === 'string'
          ? steps.condition(only.key, operator, only.value) : undefined
        id = add(node, condition ? { node: { type: 'rule', config: { mode: 'ifElse', condition } }, kind: 'exact', reason: 'mapped' } : blocked('operator'))
        draft.connect(previous, id, port)
        previous = id; port = condition ? 'true' : undefined
      } else {
        const provider = aiApis.find(([pattern]) => pattern.test(api))?.[1]
        const prompt = [params.user_message, params.prompt, params.message].find(value => typeof value === 'string')
        const converted = provider ? aiStep(steps.template(typeof prompt === 'string' ? prompt : ''), params.model, provider)
          : api.startsWith('CodeAPI') ? blocked('code') : blocked('node-type')
        id = add(node, converted)
        steps.remember(String(node.id), id, provider ? 'ai' : 'other')
        draft.connect(previous, id, port)
        previous = id; port = undefined
      }
      current = children(node.id)
    }
  }
  const document = draft.document(draft.inferredInputSchema(), { id: workflowId(title), name: title },
    // A Zapier trigger always becomes a manual Start, so no conversion is exact.
    { format: 'zapier', version, fidelity: 'approximate' })
  return { format: 'zapier', version, title, document, mappings: draft.mappings }
}

/**
 * Coze (扣子) workflows to a reviewable Jevable draft for a documented node subset. Two export forms are read: the canvas JSON
 * of Coze Studio (the editor's export file, copied nodes, or the saved `schema_json`) and one workflow YAML file from a coze.cn
 * export ZIP (`schema_version` 1.0.x).
 */
import { DraftBuilder, llmConfig, placeholder, workflowId, type DraftNode } from './import-draft.ts'
import type { ImportMappingKind, ImportMappingReason, ImportResult } from './import-types.ts'

/** coze.cn workflow YAML schema versions this converter was written against. */
export const COZE_DSL_VERSIONS = /^1\.0\.\d+$/u

type Value = Record<string, unknown>
/** One Coze step with the fields both export forms share. */
type CozeStep = { id: string; kind: string; title: string; params: Value; outputs: unknown }
/** A Coze workflow read from either export form. */
export interface CozeGraph {
  /** `studio-export`, `clipboard` or `canvas` for canvas JSON; the `schema_version` for coze.cn YAML. */
  readonly version: string
  readonly form: 'canvas' | 'dsl'
  readonly title?: string
  readonly steps: readonly CozeStep[]
  readonly edges: readonly { from: string; to: string; port?: string }[]
}

const object = (value: unknown): value is Value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
/** A node id, node type or path as written; numbers are read as their text. */
const key = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value) : '')
/** Canvas node type ids (Coze Studio `StandardNodeType`) mapped to the node names the coze.cn YAML uses. */
const CANVAS_KINDS: Readonly<Record<string, string>> = { 1: 'start', 2: 'end', 3: 'llm', 4: 'plugin', 5: 'code', 6: 'knowledge',
  8: 'condition', 9: 'subflow', 13: 'output', 15: 'text', 18: 'question', 21: 'loop', 22: 'intent', 28: 'batch', 31: 'comment',
  32: 'variable_merge', 45: 'http' }

function canvas(json: Value, version: string): CozeGraph | undefined {
  if (!Array.isArray(json.nodes) || !Array.isArray(json.edges)) return undefined
  const steps = json.nodes.filter(object).filter(node => object(node.data) && (typeof node.type === 'string' || typeof node.type === 'number'))
    .map((node): CozeStep => {
      const data = node.data as Value, kind = key(node.type)
      return { id: key(node.id), kind: CANVAS_KINDS[kind] ?? `type-${kind}`,
        title: text(object(data.nodeMeta) ? data.nodeMeta.title : undefined) ?? key(node.id),
        params: object(data.inputs) ? data.inputs : {}, outputs: data.outputs }
    })
  const edges = json.edges.filter(object).map(edge => ({ from: key(edge.sourceNodeID), to: key(edge.targetNodeID),
    ...typeof edge.sourcePortID === 'string' && edge.sourcePortID ? { port: edge.sourcePortID } : {} }))
  return { version, form: 'canvas', steps, edges }
}

/**
 * Read a parsed upload as a Coze workflow.
 * @param value - Parsed file content.
 * @returns the workflow for a Coze Studio export, copied nodes, a saved canvas or a coze.cn workflow YAML; otherwise undefined.
 */
export function cozeGraph(value: unknown): CozeGraph | undefined {
  if (!object(value)) return undefined
  if ((value.type === 'coze-workflow-export-data' || value.type === 'coze-workflow-clipboard-data') && object(value.json)) {
    return canvas(value.json, value.type === 'coze-workflow-export-data' ? 'studio-export' : 'clipboard')
  }
  if (typeof value.schema_version === 'string' && Array.isArray(value.nodes) && Array.isArray(value.edges)) {
    const steps = value.nodes.filter(object).filter(node => typeof node.type === 'string').map((node): CozeStep => {
      const parameters = object(node.parameters) ? node.parameters : {}
      return { id: key(node.id), kind: key(node.type), title: text(node.title) ?? key(node.id), params: parameters,
        outputs: parameters.node_outputs }
    })
    const edges = value.edges.filter(object).map(edge => ({ from: key(edge.source_node), to: key(edge.target_node),
      ...typeof edge.source_port === 'string' && edge.source_port ? { port: edge.source_port } : {} }))
    const title = typeof value.name === 'string' && value.name ? { title: value.name } : {}
    return { version: value.schema_version, form: 'dsl', ...title, steps, edges }
  }
  // A saved canvas has no marker of its own; its entry node always has the fixed id 100001.
  const nodes = value.nodes
  if (Array.isArray(nodes) && Array.isArray(value.edges) && nodes.some(node => object(node) && node.id === '100001' && object(node.data))) {
    return canvas(value, 'canvas')
  }
  return undefined
}

/** A step input: a reference to another step's output field, or a literal. */
type Input = { kind: 'ref'; node: string; path: string[] } | { kind: 'literal'; value: unknown; type?: string }

/** Read a canvas BlockInput (`{type, value: {type, content}}`) or a YAML input (`{type, value}` or `{value: {ref_node, path}}`). */
function readInput(input: unknown): Input | undefined {
  if (!object(input)) return undefined
  const value = input.value, type = text(input.type)
  if (object(value) && value.type === 'ref' && object(value.content)) {
    const content = value.content
    if (content.source !== 'block-output' || typeof content.blockID !== 'string' || typeof content.name !== 'string') return undefined
    return { kind: 'ref', node: content.blockID, path: content.name.split('.') }
  }
  if (object(value) && value.type === 'literal') return { kind: 'literal', value: value.content, ...type ? { type } : {} }
  if (object(value) && typeof value.ref_node === 'string') {
    return { kind: 'ref', node: value.ref_node, path: key(value.path).split('.') }
  }
  return object(value) ? undefined : { kind: 'literal', value, ...type ? { type } : {} }
}

/** Named inputs of a step: canvas `inputParameters` or YAML `node_inputs`. */
function namedInputs(step: CozeStep): { name: string; input: unknown }[] {
  const list = Array.isArray(step.params.inputParameters) ? step.params.inputParameters
    : Array.isArray(step.params.node_inputs) ? step.params.node_inputs : []
  return list.filter(object).filter(item => typeof item.name === 'string').map(item => ({ name: item.name as string, input: item.input }))
}

/** LLM settings as literal values, from the list form (`[{name, input}]`) or the map form. */
function llmParams(step: CozeStep): Value {
  const raw = step.params.llmParam
  if (Array.isArray(raw)) {
    return Object.fromEntries(raw.filter(object).flatMap((item) => {
      const input = readInput(item.input)
      return typeof item.name === 'string' && input?.kind === 'literal' ? [[item.name, input.value]] : []
    }))
  }
  if (!object(raw)) return {}
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => {
    const input = object(value) ? readInput(value) : undefined
    return [key, input?.kind === 'literal' ? input.value : value]
  }))
}

/** JSON Schema for one Coze variable type; files, images, times and other media become text the user reviews. */
function schemaOf(type: unknown, detail: unknown): { schema: Value; exact: boolean } {
  switch (type) {
    case 'string': return { schema: { type: 'string' }, exact: true }
    case 'integer': return { schema: { type: 'integer' }, exact: true }
    case 'float': case 'number': return { schema: { type: 'number' }, exact: true }
    case 'boolean': return { schema: { type: 'boolean' }, exact: true }
    case 'object': return { schema: { type: 'object' }, exact: true }
    case 'list': case 'array': {
      const item = object(detail) ? schemaOf(detail.type, detail.schema ?? detail.items) : { schema: {}, exact: false }
      return { schema: { type: 'array', items: item.schema }, exact: item.exact }
    }
    default: return { schema: { type: 'string' }, exact: false }
  }
}

/**
 * Convert a Coze workflow; unsupported nodes become placeholders that keep the draft from running.
 * @param graph - Workflow read by `cozeGraph`, with a supported version.
 * @returns the draft and its mapping report.
 */
export function convertCoze(graph: CozeGraph): ImportResult {
  const draft = new DraftBuilder(), steps = graph.steps.filter(step => step.kind !== 'comment')
  const title = graph.title?.trim() || 'Imported Coze workflow'
  const byId = new Map(steps.map(step => [step.id, step]))
  // Coze titles are often Chinese; identifiers need ASCII letters, so such steps are named after their kind.
  const idOf = (step: CozeStep) => draft.id(step.id, /[A-Za-z]/u.test(step.title) ? step.title : step.kind)
  const path = (node: string, fields: readonly string[]): string | undefined => {
    const source = byId.get(node)
    if (!source || !fields.length || !fields.every(field => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(field))) return undefined
    if (source.kind === 'start') return `inputs.${fields.join('.')}`
    if (source.kind === 'llm' && fields.length === 1 && fields[0] === 'output') return `nodes.${idOf(source)}.output`
    return `nodes.${idOf(source)}.output.${fields.join('.')}`
  }
  const binding = (input: Input | undefined): { value: unknown; exact: boolean } => {
    if (input?.kind === 'ref') {
      const reference = path(input.node, input.path)
      return reference ? { value: `\${{ ${reference} }}`, exact: true } : { value: '', exact: false }
    }
    return input ? { value: input.value, exact: true } : { value: '', exact: false }
  }
  /** Translate `{{name.field}}` placeholders, whose root names one of the step's named inputs. */
  const template = (source: string, step: CozeStep): { text: string; exact: boolean } => {
    const inputs = namedInputs(step)
    let exact = true
    const translated = source.replace(/\{\{\s*([^{}]+?)\s*\}\}/gu, (whole: string, inner: string) => {
      const [root, ...rest] = inner.split('.')
      const input = readInput(inputs.find(item => item.name === root)?.input)
      if (input?.kind === 'ref') {
        const reference = path(input.node, [...input.path, ...rest])
        if (reference) return `\${{ ${reference} }}`
      } else if (input && !rest.length && (typeof input.value === 'string' || typeof input.value === 'number' || typeof input.value === 'boolean')) {
        return String(input.value)
      }
      exact = false
      return whole
    })
    return { text: translated, exact }
  }
  const templateOf = (value: unknown, step: CozeStep) => {
    const input = object(value) ? readInput(value) : { kind: 'literal' as const, value }
    return input?.kind === 'literal' && typeof input.value === 'string' ? template(input.value, step) : { text: '', exact: false }
  }
  /** Translate one condition; operators that measure length or test containment have no Jevable expression. */
  const comparison = (item: unknown): string | undefined => {
    if (!object(item)) return undefined
    const left = readInput(object(item.left) ? item.left.input : undefined)
    const target = left?.kind === 'ref' ? path(left.node, left.path) : undefined
    if (!target) return undefined
    const operator = Number(item.operator)
    if (operator === 9 || operator === 10) return `${operator === 9 ? '!' : ''}exists(${target})`
    if (operator === 11 || operator === 12) return `${target} == ${operator === 11}`
    const symbols: Record<number, string> = { 1: '==', 2: '!=', 13: '>', 14: '>=', 15: '<', 16: '<=' }
    const symbol = symbols[operator], right = readInput(object(item.right) ? item.right.input : undefined)
    if (!symbol || !right) return undefined
    if (right.kind === 'ref') {
      const other = path(right.node, right.path)
      return other ? `${target} ${symbol} ${other}` : undefined
    }
    const numeric = operator >= 13 || ['integer', 'float', 'number'].includes(right.type ?? '')
    const value = numeric ? Number(right.value) : right.value
    if (numeric && !Number.isFinite(value)) return undefined
    return `${target} ${symbol} ${JSON.stringify(value)}`
  }
  const branchCondition = (branch: unknown): string | undefined => {
    const condition = object(branch) && object(branch.condition) ? branch.condition : undefined
    if (!condition || !Array.isArray(condition.conditions) || !condition.conditions.length) return undefined
    const parts = condition.conditions.map(comparison)
    if (parts.some(part => part === undefined)) return undefined
    return `\${{ ${parts.join(Number(condition.logic) === 1 ? ' || ' : ' && ')} }}`
  }

  /** Where a Coze source port continues in the draft; undefined drops the edge (error branches, unknown ports). */
  const ports = new Map<string, (port: string | undefined) => { node: string; port?: string } | undefined>()
  const plain = (id: string) => (port: string | undefined) => (port === undefined || port === 'default' ? { node: id } : undefined)
  const properties: Record<string, unknown> = {}, required: string[] = []
  const hasOutgoing = (step: CozeStep) => graph.edges.some(edge => edge.from === step.id)

  for (const step of steps) {
    const params = step.params
    const add = (node: DraftNode, kind: ImportMappingKind, reason: ImportMappingReason) => {
      idOf(step)
      const id = draft.add(step.id, step.title, step.kind, node, kind, reason)
      ports.set(step.id, plain(id))
      return id
    }
    switch (step.kind) {
      case 'start': {
        let exact = true
        const variables = Array.isArray(step.outputs)
          ? step.outputs.filter(object).map(item => ({ name: item.name, type: item.type, required: item.required, detail: item.schema }))
          : object(step.outputs) ? Object.entries(step.outputs).filter(([, item]) => object(item)).map(([name, item]) => {
            const detail = item as Value
            return { name, type: detail.type, required: detail.required, detail: detail.items }
          }) : []
        for (const variable of variables) {
          if (typeof variable.name !== 'string') continue
          const converted = schemaOf(variable.type, variable.detail)
          exact &&= converted.exact
          properties[variable.name] = converted.schema
          if (variable.required === true) required.push(variable.name)
        }
        add({ type: 'trigger', config: { modes: ['manual'] } }, exact ? 'exact' : 'approximate', exact ? 'mapped' : 'node-type')
        break
      }
      case 'end': {
        if (params.terminatePlan === 'useAnswerContent') {
          const content = templateOf(params.content, step)
          add({ type: 'output', config: { value: content.text } }, content.exact ? 'exact' : 'approximate', content.exact ? 'mapped' : 'expression')
          break
        }
        const value: Record<string, unknown> = {}
        let exact = true
        for (const item of namedInputs(step)) {
          const converted = binding(readInput(item.input))
          exact &&= converted.exact
          value[item.name] = converted.value
        }
        add({ type: 'output', config: { value } }, exact ? 'exact' : 'approximate', exact ? 'mapped' : 'expression')
        break
      }
      case 'output': {
        // A message that ends its path becomes that path's result; a message in the middle of a path has no Jevable step.
        if (hasOutgoing(step)) {
          add(placeholder('Imported from a Coze message node in the middle of a path; rebuild it by hand.'), 'unsupported', 'node-type')
          break
        }
        const content = templateOf(params.content, step)
        add({ type: 'output', config: { value: content.text } }, 'approximate', content.exact ? 'node-type' : 'expression')
        break
      }
      case 'llm': {
        const settings = llmParams(step)
        const prompt = template(text(settings.prompt) ?? '', step), system = template(text(settings.systemPrompt) ?? '', step)
        add({ type: 'llm', config: llmConfig(prompt.text, text(settings.modelName) ?? text(settings.modleName), undefined, system.text) },
          'approximate', prompt.exact && system.exact ? 'model-route' : 'expression')
        break
      }
      case 'condition': {
        const branches = Array.isArray(params.branches) ? params.branches : []
        const conditions = branches.map(branchCondition)
        if (!conditions.length || conditions.some(condition => condition === undefined)) {
          add(placeholder('The original condition uses operators that have no Jevable rule equivalent.'), 'unsupported', 'operator')
          break
        }
        // Coze checks the branches in order; each extra branch becomes one more If/Else on the previous one's false path.
        const first = add({ type: 'rule', config: { mode: 'ifElse', condition: conditions[0] } }, 'exact', 'mapped')
        const rules = [first, ...conditions.slice(1).map((condition, index) => {
          const id = draft.id(`${step.id}#${index + 1}`, `${first}_${index + 2}`)
          draft.nodes[id] = { type: 'rule', title: `${step.title} (${index + 2})`, config: { mode: 'ifElse', condition } }
          return id
        })]
        for (const [index, id] of rules.slice(1).entries()) draft.connect(rules[index] as string, id, 'false')
        ports.set(step.id, (port) => {
          if (port === 'true') return { node: first, port: 'true' }
          if (port === 'false') return { node: rules.at(-1) as string, port: 'false' }
          const match = /^true_(\d+)$/u.exec(port ?? '')
          const rule = match ? rules[Number(match[1])] : undefined
          return rule ? { node: rule, port: 'true' } : undefined
        })
        break
      }
      case 'intent': {
        const listed = Array.isArray(params.intents) ? params.intents.filter(object).map(item => text(item.name)) : []
        const intents = listed.filter((name): name is string => name !== undefined && name.trim() !== '')
        const query = readInput(namedInputs(step).find(item => item.name === 'query')?.input)
        const state = query?.kind === 'ref' ? path(query.node, query.path) : undefined
        if (!state || !intents.length || intents.length !== listed.length) {
          add(placeholder('The intent step has no readable query or intent list.'), 'unsupported', 'node-type')
          break
        }
        const settings = llmParams(step)
        const criteria = Object.fromEntries<string>([...intents.map((name, index): [string, string] => [`branch_${index}`, name]),
          ['default', 'None of the intents above']])
        const id = add({ type: 'decision', config: { provider: 'llm', model: text(settings.modelName) ?? 'choose-model',
          llm: { provider: 'choose-provider', generation: { maxTokens: 400, stream: true } },
          connection: { mode: 'workspace', id: 'choose-an-allowed-model' }, state: `\${{ ${state} }}`,
          execution: { timeoutSeconds: 60, maxAttempts: 1 },
          questions: { intent: { type: 'choice', instructions: 'Which of these intents does the input express?', criteria } } } },
        'approximate', 'model-route')
        // The Decision picks an intent; a Switch on its choice continues along the matching Coze branch.
        const route = draft.id(`${step.id}#route`, `${id}_route`)
        draft.nodes[route] = { type: 'rule', title: `${step.title} →`, config: { mode: 'switch', value: `\${{ nodes.${id}.output.intent.choice }}`,
          cases: intents.map((_name, index) => ({ value: `branch_${index}`, port: `branch_${index}` })) } }
        draft.connect(id, route)
        ports.set(step.id, port => (port === 'default' ? { node: route, port: 'default' }
          : port !== undefined && /^branch_\d+$/u.test(port) && Number(port.slice(7)) < intents.length ? { node: route, port } : undefined))
        break
      }
      case 'code': {
        if (params.language !== 5 && params.language !== 'javascript' && params.language !== 'typescript') {
          add(placeholder('Imported from Coze Python code; rewrite it as a reviewed JavaScript Custom step.'), 'unsupported', 'language')
          break
        }
        const input = Object.fromEntries(namedInputs(step).flatMap((item) => {
          const converted = binding(readInput(item.input))
          return converted.exact ? [[item.name, converted.value]] : []
        }))
        add({ type: 'custom', config: { language: 'javascript', code: text(params.code) ?? '', input, outputSchema: { type: 'object' } } },
          'approximate', 'code')
        break
      }
      case 'loop': case 'batch':
        add(placeholder(`Imported from a Coze ${step.kind} node; rebuild it as a Loop step.`), 'unsupported', 'loop')
        break
      default:
        add(placeholder(`Imported from Coze node type ${step.kind}; convert it by hand.`), 'unsupported', 'node-type')
    }
  }
  for (const edge of graph.edges) {
    const from = ports.get(edge.from)?.(edge.port), to = byId.get(edge.to)
    if (from && to) draft.connect(from.node, idOf(to), from.port)
  }
  const kinds = draft.mappings.map(item => item.kind)
  const fidelity: ImportMappingKind = kinds.includes('unsupported') ? 'unsupported' : kinds.includes('approximate') ? 'approximate' : 'exact'
  const document = draft.document({ type: 'object', properties, ...required.length ? { required } : {} }, { id: workflowId(title), name: title },
    { format: 'coze', version: graph.version, fidelity })
  return { format: 'coze', version: graph.version, title, document, mappings: draft.mappings }
}

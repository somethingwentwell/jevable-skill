import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { compileWorkflowYaml, importWorkflow, WorkflowCompileError, WorkflowImportError } from '../../src/workflow/index.ts'
import type { ImportMapping } from '../../src/workflow/index.ts'

const limits = { maxSourceBytes: 100_000, maxDepth: 64, maxValues: 10_000, maxNodes: 100, maxEdges: 100 }
const compile = { source: limits, schema: { maxBytes: 10_000, maxDepth: 24, maxValues: 1000 },
  binding: { data: { maxBytes: 10_000, maxDepth: 24, maxValues: 1000 }, maxExpressions: 20,
    expression: { maxSourceBytes: 1024, maxNodes: 100, maxDepth: 24, maxResultBytes: 10_000 } } }
const fixture = (name: string) => readFile(new URL(`./fixtures/import/${name}`, import.meta.url), 'utf8')
const summary = (mappings: readonly ImportMapping[]) => mappings.map(item => `${item.source} → ${item.target ?? '-'}: ${item.kind}/${item.reason}`)
type Spec = { inputSchema: unknown; nodes: Record<string, { type: string; config: Record<string, unknown> }>; edges: unknown[] }
const spec = (result: { yaml: string }) => (parse(result.yaml) as { spec: Spec }).spec
const reason = (run: () => unknown) => {
  try { run(); return 'none' } catch (error) { return error instanceof WorkflowImportError ? error.code : 'other' }
}

// Canvas building blocks, written the way the Coze Studio editor saves them.
const literal = (type: string, content: unknown) => ({ type, value: { type: 'literal', content } })
const ref = (type: string, blockID: string, name: string) => ({ type, value: { type: 'ref', content: { source: 'block-output', blockID, name } } })
const node = (id: string, type: string, title: string | undefined, inputs?: Record<string, unknown>, outputs?: unknown) =>
  ({ id, type, meta: { position: { x: 0, y: 0 } }, data: { ...title === undefined ? {} : { nodeMeta: { title } },
    ...inputs ? { inputs } : {},
    ...outputs ? { outputs } : {} } })
const edge = (sourceNodeID: string, targetNodeID: string, sourcePortID?: string) =>
  ({ sourceNodeID, targetNodeID, ...sourcePortID === undefined ? {} : { sourcePortID } })
const start = (outputs: unknown[] = [{ name: 'budget', type: 'integer', required: true }, { name: 'note', type: 'string' }]) =>
  node('100001', '1', 'Start', undefined, outputs)
const exported = (nodes: unknown[], edges: unknown[], type = 'coze-workflow-export-data') =>
  JSON.stringify({ type, source: { workflowId: '1', flowMode: 0, spaceId: '2', host: 'www.coze.cn', isDouyin: false }, json: { nodes, edges } })
const condition = (id: string, branches: unknown[]) => node(id, '8', 'Check', { branches })
const branch = (logic: number, ...conditions: unknown[]) => ({ condition: { logic, conditions } })
const test = (operator: number, left: unknown, right?: unknown) =>
  ({ operator, left: { input: left }, ...right === undefined ? {} : { right: { input: right } } })
const message = (id: string, title: string, content: string, inputs: unknown[] = []) =>
  node(id, '13', title, { content: literal('string', content), streamingOutput: false, inputParameters: inputs })

describe('Coze workflow import', () => {
  it('converts a Coze Studio export: start variables, an LLM with its prompt, and a condition it cannot translate', async () => {
    const result = importWorkflow(await fixture('coze-answer.flow'), limits)
    expect(result).toMatchObject({ format: 'coze', version: 'studio-export', title: 'Imported Coze workflow' })
    expect(summary(result.mappings)).toEqual(['Start → Start: exact/mapped', 'Answer → Answer: approximate/model-route',
      'Is empty? → Is_empty: unsupported/operator', 'Format → -: unsupported/unreachable', 'End → -: unsupported/unreachable'])
    await expect(result.yaml).toMatchFileSnapshot('./expected/import-coze-answer.yaml')
    expect(() => compileWorkflowYaml(result.yaml, compile)).toThrow(WorkflowCompileError)
  })

  it('converts a saved canvas: an intent step becomes a Decision and a Switch; loops and mid-path messages stay placeholders', async () => {
    const result = importWorkflow(await fixture('coze-intent.json'), limits)
    expect(result).toMatchObject({ format: 'coze', version: 'canvas' })
    expect(summary(result.mappings)).toEqual(['Start → Start: exact/mapped', 'Route → Route: approximate/model-route',
      'For each item → For_each_item: unsupported/loop', 'Chat reply → Chat_reply: unsupported/node-type', 'End → End: exact/mapped'])
    await expect(result.yaml).toMatchFileSnapshot('./expected/import-coze-intent.yaml')
    const nodes = spec(result).nodes
    expect(nodes.Route!.config.questions).toEqual({ intent: { type: 'choice', instructions: 'Which of these intents does the input express?',
      criteria: { branch_0: 'Process the list', branch_1: 'Small talk', default: 'None of the intents above' } } })
    expect(nodes.Route_route!.config).toMatchObject({ mode: 'switch', value: '${{ nodes.Route.output.intent.choice }}' })
  })

  it('converts a coze.cn workflow YAML and refuses other schema versions', async () => {
    const source = await fixture('coze-draft.yaml')
    const result = importWorkflow(source, limits)
    expect(result).toMatchObject({ format: 'coze', version: '1.0.0', title: 'Topic writer' })
    expect(summary(result.mappings)).toEqual(['开始 → start: exact/mapped', 'Draft → Draft: approximate/model-route',
      '发送 → http: unsupported/node-type', 'End → End: exact/mapped'])
    await expect(result.yaml).toMatchFileSnapshot('./expected/import-coze-draft.yaml')
    expect(reason(() => importWorkflow(source.replace('schema_version: 1.0.0', 'schema_version: 2.0.0'), limits))).toBe('unsupported-version')
  })

  it('turns several condition branches into If/Else rules checked in order, and runs the converted workflow', () => {
    const budget = ref('integer', '100001', 'budget'), note = ref('string', '100001', 'note')
    const result = importWorkflow(exported([start(), condition('200', [branch(2, test(14, budget, literal('integer', '5000'))),
      branch(1, test(9, note), test(12, ref('boolean', '100001', 'vip')), test(2, note, note))]),
    message('301', 'Big', 'Big budget'), message('302', 'Noted', 'Has a note: {{n}}', [{ name: 'n', input: note }]),
    message('303', 'Small', 'Small budget')], [edge('100001', '200'), edge('200', '301', 'true'), edge('200', '302', 'true_1'),
      edge('200', '303', 'false'), edge('200', '303', 'true_9')]), limits)
    const { nodes, edges } = spec(result)
    expect(nodes.Check!.config.condition).toBe('${{ inputs.budget >= 5000 }}')
    expect(nodes.Check_2!.config.condition).toBe('${{ !exists(inputs.note) || inputs.vip == false || inputs.note != inputs.note }}')
    expect(edges).toEqual([{ from: 'Check', to: 'Check_2', port: 'false' }, { from: 'Start', to: 'Check' },
      { from: 'Check', to: 'Big', port: 'true' }, { from: 'Check_2', to: 'Noted', port: 'true' }, { from: 'Check_2', to: 'Small', port: 'false' }])
    expect(nodes.Noted!.config.value).toBe('Has a note: ${{ inputs.note }}')
  })

  it('reads copied nodes, answer-content ends, JavaScript code and map-form model settings', () => {
    const result = importWorkflow(exported([
      node('400', '5', 'Tag', { language: 5, code: 'async function main({ params }) { return { tag: params.x } }',
        inputParameters: [{ name: 'x', input: ref('string', '100001', 'note') }, { name: 'missing', input: ref('string', '999', 'y') }] }),
      node('401', '3', 'Write', { llmParam: { modelName: 'm', prompt: literal('string', 'Use {{t.tag}} and {{k}} and {{list}} and {{k.x}} and {{gone}}'),
        systemPrompt: 'plain' }, inputParameters: [{ name: 't', input: ref('object', '400', 'tag') }, { name: 'k', input: literal('string', 'fixed') },
        { name: 'list', input: literal('list', ['a']) }] }),
      node('900001', '2', 'End', { terminatePlan: 'useAnswerContent', content: literal('string', 'Answer: {{w}}'),
        inputParameters: [{ name: 'w', input: ref('string', '401', 'output') }] }),
    ], [edge('400', '401', 'default'), edge('401', '900001'), edge('401', '400', 'branch_error')], 'coze-workflow-clipboard-data'), limits)
    expect(result.version).toBe('clipboard')
    expect(summary(result.mappings)).toEqual(['Tag → Tag: approximate/code', 'Write → Write: approximate/expression', 'End → End: exact/mapped',
      'Start → Start: approximate/trigger-mode'])
    const nodes = spec(result).nodes
    // Copied nodes leave the start out, so references to its variables cannot be translated.
    expect(nodes.Tag!.config.input).toEqual({})
    expect(nodes.Write!.config).toMatchObject({ model: 'm', prompt: 'Use ${{ nodes.Tag.output.tag.tag }} and fixed and {{list}} and {{k.x}} and {{gone}}' })
    expect(nodes.Write!.config.systemPrompt).toBe('plain')
    expect(nodes.End!.config.value).toBe('Answer: ${{ nodes.Write.output }}')
  })

  it('keeps unsupported steps visible and reads irregular inputs without guessing', () => {
    const result = importWorkflow(exported([start([{ name: 'when', type: 'time', required: true }, { name: 'rows', type: 'list' },
      { name: 'score', type: 'float' }, { name: 'ok', type: 'boolean' }, { name: 'meta', type: 'object' },
      { name: 'tags', type: 'list', schema: { type: 'string' } }, { type: 'string' }, 'broken']),
    node('500', '5', 'Py', { language: 3, code: 'def main(): pass' }),
    node('501', '28', 'Batch'), node('502', '45', undefined), node('503', '31', 'Note'), { id: '504', type: '999', data: {} },
    node('505', '22', 'Intent', { intents: [], inputParameters: [] }),
    condition('506', [branch(2, test(7, ref('string', '100001', 'rows'), literal('string', 'x')))]),
    condition('507', [branch(2, test(13, ref('float', '100001', 'score'), literal('float', 'many')))]),
    condition('508', [branch(2, test(1, literal('string', 'a'), literal('string', 'a')))]),
    condition('509', []), condition('510', [branch(2)]), condition('511', ['broken']),
    condition('512', [branch(2, test(1, ref('string', '100001', 'ok'), ref('string', '999', 'z')))]),
    condition('513', [branch(2, test(1, ref('string', '100001', 'ok')))]),
    condition('514', [branch(2, 'broken')]),
    node('515', '2', 'Out', { terminatePlan: 'returnVariables', inputParameters: [{ name: 'a', input: { type: 'string', value: { type: 'ref',
      content: { source: 'global_variable_user', path: ['v'] } } } }, { name: 'b', input: { type: 'string', value: { type: 'other' } } },
    { name: 'c', input: 'plain' }, { name: 'd', input: ref('string', '100001', 'rows.0') }, { noName: true }] }),
    ], [edge('100001', '500'), edge('500', '501'), edge('501', '502'), edge('502', '504'), edge('504', '505'), edge('505', '506'),
      edge('506', '507'), edge('507', '508'), edge('508', '509'), edge('509', '510'), edge('510', '511'),
      edge('511', '512'), edge('512', '513'), edge('513', '514'), edge('514', '515'), edge('100001', '999')]), limits)
    expect(result.mappings.filter(item => item.kind === 'unsupported').map(item => item.reason)).toEqual(['language', 'loop', 'node-type',
      'node-type', 'node-type', 'operator', 'operator', 'operator', 'operator', 'operator', 'operator', 'operator', 'operator', 'operator'])
    expect(summary(result.mappings)[0]).toBe('Start → Start: approximate/node-type')
    expect(spec(result).inputSchema).toEqual({ type: 'object', required: ['when'], properties: { when: { type: 'string' },
      rows: { type: 'array', items: {} }, score: { type: 'number' }, ok: { type: 'boolean' }, meta: { type: 'object' },
      tags: { type: 'array', items: { type: 'string' } } } })
    expect(spec(result).nodes.Out!.config.value).toEqual({ a: '', b: '', c: '', d: '' })
    expect(Object.keys(spec(result).nodes)).toContain('type_999')
  })

  it('reads intent steps with a query, YAML starts and ports that lead nowhere', () => {
    const intent = importWorkflow(exported([start(), node('600', '22', '意图', { intents: [{ name: 'Buy' }, { name: ' ' }],
      inputParameters: [{ name: 'query', input: ref('string', '100001', 'note') }] }),
    node('601', '22', 'Pick', { intents: [{ name: 'Buy' }], llmParam: [{ name: 'modelName', input: literal('string', 'm') }],
      inputParameters: [{ name: 'query', input: ref('string', '100001', 'note') }] }), message('602', 'Yes', 'yes'), message('603', 'No', 'no')],
    [edge('100001', '601'), edge('601', '602', 'branch_0'), edge('601', '603', 'default'), edge('601', '600', 'branch_5'), edge('601', '600', 'x')]), limits)
    expect(summary(intent.mappings)).toEqual(['Start → Start: exact/mapped', '意图 → -: unsupported/unreachable',
      'Pick → Pick: approximate/model-route', 'Yes → Yes: approximate/node-type', 'No → No: approximate/node-type'])
    expect(spec(intent).nodes.Pick!.config).toMatchObject({ model: 'm' })
    const yaml = importWorkflow(['schema_version: 1.0.1', 'nodes:', '  - { id: "1", type: start, parameters: { node_outputs: { a: { type: string },',
      '      b: 5, c: { type: list, items: { type: integer } } } } }', '  - { id: "2", type: end }', '  - { id: "3", type: code, title: Js,',
      '      parameters: { language: javascript, node_inputs: [{ name: v, input: { value: { ref_node: "1", path: a } } }] } }',
      '  - { id: "4" }', '  - { type: comment }', 'edges:', '  - { source_node: "1", target_node: "3", source_port: "" }', '  - { source_node: "3", target_node: "2" }', ''].join('\n'), limits)
    expect(yaml.title).toBe('Imported Coze workflow')
    expect(spec(yaml).inputSchema).toEqual({ type: 'object', properties: { a: { type: 'string' }, c: { type: 'array', items: { type: 'integer' } } } })
    expect(summary(yaml.mappings)).toEqual(['1 → start: exact/mapped', '2 → end: exact/mapped', 'Js → Js: approximate/code'])
    expect(spec(yaml).nodes.Js!.config).toMatchObject({ code: '', input: { v: '${{ inputs.a }}' } })
  })

  it('covers the less common shapes of inputs, conditions, messages and intents', () => {
    const plainRef = (blockID: string, name: string) => ({ value: { type: 'ref', content: { source: 'block-output', blockID, name } } })
    const result = importWorkflow(exported([
      { ...start(), type: 1 },
      node('700', '3', 'Bare', { llmParam: [{ name: 'prompt', input: ref('string', '100001', 'note') }, { input: literal('string', 'x') }] }),
      condition('701', [branch(2, test(10, plainRef('100001', 'note')), test(1, ref('integer', '100001', 'budget'), { value: { type: 'literal', content: 7 } }),
        test(1, ref('string', '100001', 'note'), literal('integer', '3')), test(1, ref('string', '100001', 'note'), literal('string', 'x')))]),
      node('702', '22', 'Ask', { intents: [{ name: 'Buy' }], inputParameters: [{ name: 'query', input: ref('string', '100001', 'note') }] }),
      node('703', '8', 'No inputs'),
      condition('704', [branch(2, { operator: 1 })]),
      node('705', '22', 'Nameless', { intents: [{}], inputParameters: [{ name: 'query', input: ref('string', '100001', 'note') }] }),
      node('706', '22', 'Literal', { intents: [{ name: 'A' }], inputParameters: [{ name: 'query', input: literal('string', 'hi') }] }),
      node('707', '22', 'Empty', { inputParameters: [{ name: 'query', input: ref('string', '100001', 'note') }] }),
      message('708', 'Unknown', 'Hi {{z}}', [{ name: 'z', input: ref('string', '999', 'x') }]),
      node('900001', '2', 'End', { terminatePlan: 'useAnswerContent', content: literal('integer', 5) }),
    ], [edge('100001', '700'), edge('700', '701'), edge('701', '702', 'true'), edge('701', '703', 'false'), edge('701', '703'), edge('701', '703', 'x'), edge('702', '704'),
      edge('703', '705'), edge('705', '706'), edge('706', '707'), edge('707', '708'), edge('704', '900001')]), limits)
    const nodes = spec(result).nodes
    expect(nodes.Bare!.config).toMatchObject({ model: 'choose-model', prompt: 'Describe the task.' })
    expect(nodes.Check!.config.condition)
      .toBe('${{ exists(inputs.note) && inputs.budget == 7 && inputs.note == 3 && inputs.note == "x" }}')
    expect(nodes.Ask!.config.model).toBe('choose-model')
    expect(summary(result.mappings).filter(line => line.includes('unsupported'))).toEqual(['No inputs → No_inputs: unsupported/operator',
      'Check → -: unsupported/unreachable', 'Nameless → Nameless: unsupported/node-type', 'Literal → Literal: unsupported/node-type',
      'Empty → Empty: unsupported/node-type', 'End → -: unsupported/unreachable'])
    const yaml = importWorkflow(['schema_version: 1.0.0', 'name: Greeter', 'nodes:',
      '  - { id: "1", type: start, parameters: { node_outputs: { name: { type: string } } } }',
      '  - { id: "2", type: end, parameters: { terminatePlan: useAnswerContent, content: "Hi {{n}} {{m}} {{k}}",',
      '      node_inputs: [{ name: n, input: { value: { ref_node: "1", path: name } } }, { name: k, input: { value: 5 } }] } }',
      '  - { id: "3", type: output, title: Say, parameters: { content: { type: string, value: "Bye {{q}}" } } }',
      'edges:', '  - { source_node: "1", target_node: "2", source_port: default }', ''].join('\n'), limits)
    expect(spec(yaml).nodes.end!.config.value).toBe('Hi ${{ inputs.name }} {{m}} 5')
    expect(summary(yaml.mappings)).toContain('2 → end: approximate/expression')
    expect(reason(() => importWorkflow('[1]', limits))).toBe('unknown-format')
    const said = importWorkflow(exported([start(), message('709', 'Say', 'Bye {{q}}')], [edge('100001', '709')]), limits)
    expect(summary(said.mappings)).toContain('Say → Say: approximate/expression')
  })

  it('leaves other documents with nodes and edges to the other importers', () => {
    expect(reason(() => importWorkflow('{"nodes": [{"id": "1", "data": {}}], "edges": []}', limits))).toBe('unknown-format')
    expect(reason(() => importWorkflow('{"type": "coze-workflow-export-data", "json": {"nodes": {}}}', limits))).toBe('unknown-format')
    expect(reason(() => importWorkflow('{"nodes": [{"id": "100001", "type": "1", "data": {}}], "edges": []}', limits))).toBe('none')
  })
})

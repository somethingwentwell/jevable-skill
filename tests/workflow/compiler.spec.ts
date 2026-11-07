import { describe, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'
import { compileWorkflow, compileWorkflowYaml, evaluateBinding, evaluateRule, evaluateResolvedRule, validateWorkflowValue,
  WorkflowCompileError } from '../../src/workflow/index.ts'
import type { WorkflowCompilerLimits, CompiledRulePlan, JsonValue, NodeId } from '../../src/workflow/index.ts'

const limits: WorkflowCompilerLimits = {
  source: { maxSourceBytes: 100_000, maxDepth: 32, maxValues: 10_000, maxNodes: 100, maxEdges: 200 },
  schema: { maxBytes: 10_000, maxDepth: 24, maxValues: 1000 },
  binding: { data: { maxBytes: 10_000, maxDepth: 24, maxValues: 1000 },
    expression: { maxSourceBytes: 1024, maxNodes: 100, maxDepth: 24, maxResultBytes: 10_000 }, maxExpressions: 20 },
}
function sample() {
  return {
    apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'support', name: 'Support' },
    spec: {
      inputSchema: { type: 'object', required: ['message'], additionalProperties: false, properties: { message: { type: 'string' } } },
      nodes: {
        start: { type: 'trigger', config: { modes: ['manual', 'chat'] } },
        draft: { type: 'llm', config: {
          provider: 'deepseek', model: 'configured-model', connection: { mode: 'workspace', id: 'team-model' },
          prompt: 'Reply to ${{ nodes.start.output.message }}', responseFormat: 'json-schema',
          outputSchema: { type: 'object', required: ['reply'], additionalProperties: false, properties: { reply: { type: 'string' } } },
          generation: { maxTokens: 1000, stream: false }, execution: { timeoutSeconds: 60, maxAttempts: 1 }, historyScope: 'none',
        } },
        result: { type: 'output', config: { value: '${{ nodes.draft.output.reply }}' } },
      } as Record<string, { type: string; config: Record<string, JsonValue> }>,
      edges: [{ from: 'start', to: 'draft' }, { from: 'draft', to: 'result' }] as { from: string; to: string; port?: string }[],
    },
  }
}
function ruleSample(mode: 'ifElse' | 'switch' = 'ifElse') {
  const source = sample()
  source.spec.nodes.check = { type: 'rule', config: mode === 'ifElse'
    ? { mode, condition: '${{ inputs.message == "yes" }}' }
    : { mode, value: '${{ inputs.message }}', cases: [{ port: 'yes', value: 'yes' }, { port: 'alsoYes', value: 'yes' }] } }
  source.spec.nodes.skip = { type: 'output', config: { value: 'skipped' } }
  source.spec.edges = [{ from: 'start', to: 'check' },
    ...(mode === 'ifElse' ? [{ from: 'check', port: 'true', to: 'draft' }, { from: 'check', port: 'false', to: 'skip' }]
      : [{ from: 'check', port: 'yes', to: 'draft' }, { from: 'check', port: 'alsoYes', to: 'skip' },
        { from: 'check', port: 'default', to: 'skip' }]),
    { from: 'draft', to: 'result' }]
  return source
}

describe('executable workflow compilation', () => {
  it('names the step and the settings a node configuration gets wrong, without repeating values', () => {
    const source = ruleSample()
    source.spec.nodes.check = { type: 'rule', config: { mode: 'ifElse', condition: '${{ inputs.message == "yes" }}', extra: 'secret-ish' } }
    expect(() => compileWorkflow(source, limits)).toThrow(
      /^Step check: Node configuration is missing required settings or contains unsupported fields: .*extra/u)
    source.spec.nodes.check = { type: 'rule', config: { mode: 'ifElse' } }
    expect(() => compileWorkflow(source, limits)).toThrow(/^Step check: .*condition: /u)
    let message = ''
    try { compileWorkflow(source, limits) } catch (error) { message = (error as Error).message }
    expect(message).not.toContain('secret-ish')
  })

  it('pins a detached plan to YAML and composes typed ingress, prompts, provider output and final result', () => {
    const source = sample()
    const plan = compileWorkflow(source, limits)
    expect(compileWorkflowYaml(stringify(source), limits)).toEqual(plan)
    expect(plan.compilerVersion).toBe('jevable-compiler/v1alpha1')
    expect(plan.nodes.map(node => node.id)).toEqual(['start', 'draft', 'result'])
    expect(plan.nodes[0]!.destinations).toEqual({ next: 'draft' })
    const draft = plan.nodes[1]!.plan
    if (draft.kind !== 'llm') throw new Error('fixture must contain LLM')
    const inputs = validateWorkflowValue(plan.input, { message: 'Help' }, limits.binding.data)
    const nodes = { ['start' as NodeId]: { output: inputs } }
    expect(evaluateBinding(draft.prompt, { inputs, nodes })).toBe('Reply to Help')
    expect(evaluateBinding(draft.systemPrompt, { inputs, nodes })).toBe('')
    const output = validateWorkflowValue(draft.output, { reply: 'Response' }, limits.binding.data)
    expect(() => validateWorkflowValue(draft.output, { reply: 10 }, limits.binding.data)).toThrow(/declared schema/u)
    const result = plan.nodes[2]!.plan
    if (result.kind !== 'output') throw new Error('fixture must contain Output')
    expect(evaluateBinding(result.value, { inputs, nodes: { ...nodes, ['draft' as NodeId]: { output } } })).toBe('Response')
    source.spec.nodes.draft!.config.prompt = 'mutated'
    expect(plan.source.yaml).not.toContain('mutated')
    expect(Object.isFrozen(draft.generation) && Object.isFrozen(plan.nodes[0]!.destinations)).toBe(true)
  })

  it('compiles explicit custom endpoints, mapped inputs, text output and bounded history', () => {
    const source = sample(), config = source.spec.nodes.draft!.config
    config.connection = { mode: 'custom', protocol: 'openai-compatible', endpoint: 'https://provider.example/v1',
      credentialRef: 'team/provider' }
    config.input = '${{ inputs }}'; config.inputSchema = structuredClone(source.spec.inputSchema)
    config.responseFormat = 'text'; delete config.outputSchema
    config.generation = { maxTokens: 20, stream: true, temperature: 0.2, topP: 0.9 }
    config.historyScope = 'current-run'; config.historyLimits = { maxMessages: 10, maxBytes: 1000 }
    source.spec.nodes.result!.config.value = '${{ nodes.draft.output }}'
    const plan = compileWorkflow(source, limits).nodes[1]!.plan
    expect(plan.kind).toBe('llm')
    if (plan.kind !== 'llm') return
    expect(plan.output.definition).toEqual({ type: 'string' })
    expect(plan.history).toEqual({ scope: 'current-run', maxMessages: 10, maxBytes: 1000 })
    expect(plan.connection).toEqual(config.connection)
    expect(plan.input?.binding.resultType.kind).toBe('object')
    config.historyScope = 'admitted-project'
    expect(compileWorkflow(source, limits).nodes[1]!.plan.kind).toBe('llm')
  })

  it('compiles code-first Custom instructions without granting execution', () => {
    const source = sample()
    source.spec.nodes.draft = { type: 'custom', config: { language: 'javascript', code: 'export default ({ message }) => ({ reply: message })',
      input: { message: '${{ nodes.start.output.message }}' },
      inputSchema: { type: 'object', required: ['message'], properties: { message: { type: 'string' } } },
      outputSchema: { type: 'object', required: ['reply'], additionalProperties: false, properties: { reply: { type: 'string' } } },
      execution: { timeoutSeconds: 5, maxAttempts: 1 } } }
    const plan = compileWorkflow(source, limits).nodes[1]!.plan
    expect(plan).toMatchObject({ kind: 'custom', language: 'javascript', execution: { timeoutSeconds: 5, maxAttempts: 1 },
      output: { definition: { type: 'object' } } })
    const minimal = sample()
    minimal.spec.nodes.draft = { type: 'custom', config: { language: 'javascript', code: 'x', input: {},
      outputSchema: { type: 'object', required: ['reply'], properties: { reply: { type: 'string' } } } } }
    expect(compileWorkflow(minimal, limits).nodes[1]!.plan).not.toHaveProperty('execution')
    expect(compileWorkflow(minimal, limits).nodes[1]!.plan).toMatchObject({ input: { schema: undefined } })
  })

  it.each([
    [{ language: 'javascript', code: '  ', input: {}, outputSchema: { type: 'object' } }, /empty/u],
    [{ mode: 'api', url: 'https://example.com' }, /reviewed conversion/u],
    [{ language: 'python', code: 'x', input: {}, outputSchema: { type: 'object' } }, /unsupported fields/u],
    [{ language: 'javascript', code: 'x', input: '${{ inputs.message }}', inputSchema: { type: 'object' }, outputSchema: { type: 'string' } },
      /does not match/u],
  ])('refuses invalid Custom settings: %j', (settings, message) => {
    const source = sample()
    source.spec.nodes.draft = { type: 'custom', config: settings }
    expect(() => compileWorkflow(source, limits)).toThrow(message)
  })

  it.each([
    { apiKey: 'secret-must-not-appear' }, { model: '' }, { connection: { mode: 'workspace' } },
    { execution: { timeoutSeconds: 0, maxAttempts: 1 } }, { generation: { maxTokens: 0, stream: false } },
    { connection: { mode: 'custom', protocol: 'unknown', endpoint: 'https://example.com' } },
    ...['ftp://example.com', 'https://user:secret@example.com', 'https://example.com?key=secret',
      'https://example.com#fragment', 'not-a-url', 'https://example.com/${{inputs.host}}']
      .map(endpoint => ({ connection: { mode: 'custom', protocol: 'openai-compatible', endpoint } })),
    { responseFormat: 'text', outputSchema: { type: 'object' } },
    { input: '${{ inputs }}' }, { inputSchema: { type: 'object' } },
    { input: '${{ inputs.message }}', inputSchema: { type: 'number' } },
    { historyScope: 'current-run' }, { historyLimits: { maxMessages: 1, maxBytes: 100 } },
    { prompt: '${{ inputs }}' }, { systemPrompt: '${{ 1 }}' }, { outputSchema: { type: 'string', pattern: 'unsafe' } },
  ])('rejects incomplete or incompatible LLM settings: %j', (patch) => {
    const source = sample()
    Object.assign(source.spec.nodes.draft!.config, patch)
    expect(() => compileWorkflow(source, limits)).toThrow()
    try { compileWorkflow(source, limits) } catch (error) { expect(String(error)).not.toContain('secret-must-not-appear') }
  })

  it('requires a structured-output schema and strict unique Trigger modes', () => {
    const source = sample(); delete source.spec.nodes.draft!.config.outputSchema
    expect(() => compileWorkflow(source, limits)).toThrow(/requires an output schema/u)
    for (const modes of [[], ['manual', 'manual'], ['schedule']]) {
      const source = sample(); source.spec.nodes.start!.config.modes = modes
      expect(() => compileWorkflow(source, limits)).toThrow(WorkflowCompileError)
    }
  })

  it('rejects an Output binding whose value type conflicts with the output schema', () => {
    const source = sample(), output = source.spec.nodes.result!.config
    output.value = '${{ nodes.draft.output.reply }}'
    output.outputSchema = { type: 'integer' }
    expect(() => compileWorkflow(source, limits)).toThrow(WorkflowCompileError)
    output.outputSchema = { type: 'string' }
    expect(compileWorkflow(source, limits).nodes[2]!.outputType.kind).toBe('string')
  })

  it.each([
    [{ type: 'object', required: ['message'], properties: { message: { type: 'string' } } }, true],
    [{ type: 'object', required: ['message'], properties: { message: { type: 'string' }, topic: { type: 'string' } } }, true],
    [{ type: 'string' }, true],
    [{ type: 'object', required: ['message', 'topic'], properties: { message: { type: 'string' }, topic: { type: 'string' } } }, false],
    [{ type: 'object', required: ['message'], properties: { message: { type: 'number' } } }, false],
    [{ type: 'object', required: ['text'], properties: { text: { type: 'string' } } }, false],
    [{ type: 'object', properties: { message: { type: 'string' } } }, false],
    [{ type: 'number' }, false],
  ] as const)('accepts a chat trigger only for message-text input: %j', (inputSchema, accepted) => {
    const source = sample()
    source.spec.inputSchema = inputSchema as never
    source.spec.nodes.draft!.config.prompt = 'Reply'
    if (accepted) expect(compileWorkflow(source, limits).nodes[0]!.plan).toMatchObject({ kind: 'trigger', modes: ['manual', 'chat'] })
    else expect(() => compileWorkflow(source, limits)).toThrow(/chat trigger/u)
    source.spec.nodes.start!.config.modes = ['manual']
    expect(compileWorkflow(source, limits).nodes[0]!.plan).toMatchObject({ modes: ['manual'] })
  })

  it('validates nested mapped result types, required fields and additional properties', () => {
    const source = sample()
    const output = source.spec.nodes.result!.config
    const resultSchema = { type: 'object', required: ['reply'], additionalProperties: false, properties: { reply: { type: 'string' } } }
    output.outputSchema = resultSchema
    output.value = { reply: '${{ nodes.draft.output.reply }}' }
    expect(compileWorkflow(source, limits).nodes[2]!.plan.kind).toBe('output')
    output.value = { reply: 5 }
    expect(() => compileWorkflow(source, limits)).toThrow(/schema type/u)
    output.value = {}
    expect(() => compileWorkflow(source, limits)).toThrow(/required schema property/u)
    output.value = { reply: 'ok', extra: true }
    expect(() => compileWorkflow(source, limits)).toThrow(/undeclared schema property/u)
    output.outputSchema = { type: 'array', items: { type: 'number' } }; output.value = ['text']
    expect(() => compileWorkflow(source, limits)).toThrow(/schema type/u)
    output.value = [1, 2]
    expect(compileWorkflow(source, limits).nodes[2]!.outputType.kind).toBe('array')
    output.value = []
    expect(compileWorkflow(source, limits).nodes[2]!.outputType.kind).toBe('array')
    output.value = 3; output.outputSchema = { type: 'integer' }
    expect(compileWorkflow(source, limits).nodes[2]!.outputType.kind).toBe('number')
    output.value = { any: true }; output.outputSchema = { type: 'object' }
    expect(compileWorkflow(source, limits).nodes[2]!.outputType.kind).toBe('object')
  })
})

describe('typed Rule branches and graph availability', () => {
  it.each(['ifElse', 'switch'] as const)('routes a prepared %s input without resolving its binding again', (mode) => {
    const rule = compileWorkflow(ruleSample(mode), limits).nodes.find(node => node.id === 'check')!.plan as CompiledRulePlan
    expect(evaluateResolvedRule(rule, mode === 'ifElse' ? true : 'yes').port).toBe(mode === 'ifElse' ? 'true' : 'yes')
    expect(evaluateResolvedRule(rule, mode === 'ifElse' ? false : 'missing').port).toBe(mode === 'ifElse' ? 'false' : 'default')
    expect(() => evaluateRule(rule, { inputs: {}, nodes: {} })).toThrow()
  })

  it.each(['ifElse', 'switch'] as const)('inspects the resolved %s value once without leaking evaluation context', (mode) => {
    const rule = compileWorkflow(ruleSample(mode), limits).nodes.find(node => node.id === 'check')!.plan as CompiledRulePlan
    const inspect = vi.fn(), values = { inputs: { message: 'yes' }, nodes: {} }
    expect(evaluateRule(rule, values, inspect)).toEqual(evaluateRule(rule, values))
    expect(inspect.mock.calls).toEqual([[mode === 'ifElse' ? true : 'yes']])
    const unavailable = vi.fn()
    expect(() => evaluateRule(rule, { inputs: {}, nodes: {} }, unavailable)).toThrow()
    expect(unavailable).not.toHaveBeenCalled()
  })

  it('selects null Switch cases without confusing them with missing values', () => {
    const source = ruleSample('switch')
    source.spec.nodes.check!.config.value = null
    source.spec.nodes.check!.config.cases = [{ port: 'yes', value: null }, { port: 'alsoYes', value: null }]
    const rule = compileWorkflow(source, limits).nodes.find(node => node.id === 'check')!.plan as CompiledRulePlan
    expect(evaluateRule(rule, { inputs: { message: 'ignored' }, nodes: {} }).port).toBe('yes')
  })

  it('selects If/Else and first matching Switch cases with explicit default outputs', () => {
    for (const mode of ['ifElse', 'switch'] as const) {
      const source = ruleSample(mode), graph = compileWorkflow(source, limits)
      const node = graph.nodes.find(node => node.id === 'check')!
      const rule = node.plan as CompiledRulePlan
      expect(evaluateRule(rule, { inputs: { message: 'yes' }, nodes: {} }))
        .toEqual({ port: mode === 'ifElse' ? 'true' : 'yes', output: { selectedPort: mode === 'ifElse' ? 'true' : 'yes' } })
      expect(evaluateRule(rule, { inputs: { message: 'other' }, nodes: {} }).port).toBe(mode === 'ifElse' ? 'false' : 'default')
      expect(Object.keys(node.destinations)).toEqual(mode === 'ifElse' ? ['false', 'true'] : ['alsoYes', 'default', 'yes'])
    }
  })

  it('requires all ports, rejects unknown ports and refuses ambiguous next aliases', () => {
    const missing = ruleSample(); missing.spec.edges = missing.spec.edges.filter(edge => edge.port !== 'false')
    delete missing.spec.nodes.skip
    expect(() => compileWorkflow(missing, limits)).toThrow(/requires a destination/u)
    const unsupported = ruleSample(); unsupported.spec.edges.find(edge => edge.port === 'true')!.port = 'unsupported'
    expect(() => compileWorkflow(unsupported, limits)).toThrow(/unsupported or duplicated/u)
    const duplicate = sample(); duplicate.spec.edges.push({ from: 'start', to: 'result', port: 'next' })
    expect(() => compileWorkflow(duplicate, limits)).toThrow(/duplicated/u)
    const switchMissing = ruleSample('switch'); switchMissing.spec.edges = switchMissing.spec.edges.filter(edge => edge.port !== 'default')
    expect(() => compileWorkflow(switchMissing, limits)).toThrow(/including Rule defaults/u)
    const explicit = sample(); explicit.spec.edges[0]!.port = 'next'
    expect(compileWorkflow(explicit, limits).nodes[0]!.destinations).toEqual({ next: 'draft' })
  })

  it.each([
    { mode: 'ifElse', condition: '${{ inputs.message }}' },
    { mode: 'switch', value: '${{ inputs }}', cases: [{ port: 'a', value: 'yes' }] },
    { mode: 'switch', value: '${{ inputs.message }}', cases: [{ port: 'a', value: 3 }] },
    { mode: 'switch', value: '${{ inputs.message }}', cases: [{ port: 'a', value: 'one' }, { port: 'a', value: 'two' }] },
    { mode: 'switch', value: '${{ inputs.message }}', cases: [{ port: 'default', value: 'one' }] },
    { mode: 'switch', value: '${{ inputs.message == "yes" }}', cases: [{ port: 'a', value: 'yes' }] },
  ])('rejects incorrectly typed or ambiguous rules: %j', (config) => {
    const source = ruleSample(); source.spec.nodes.check!.config = config
    expect(() => compileWorkflow(source, limits)).toThrow(WorkflowCompileError)
  })

  it('allows only outputs guaranteed on every incoming path, independent of serialized node order', () => {
    const source = ruleSample()
    source.spec.nodes.skip = { type: 'llm', config: structuredClone(source.spec.nodes.draft!.config) }
    source.spec.edges.push({ from: 'skip', to: 'result' })
    expect(() => compileWorkflow(source, limits)).toThrow(/unavailable/u)
    source.spec.nodes.result!.config.value = '${{ nodes.start.output.message }}'
    expect(compileWorkflow(source, limits).nodes.at(-1)!.id).toBe('result')
    source.spec.nodes = Object.fromEntries(Object.entries(source.spec.nodes).reverse())
    expect(compileWorkflow(source, limits).nodes.at(-1)!.id).toBe('result')
    source.spec.nodes.draft!.config.prompt = '${{ nodes.skip.output.reply }}'
    expect(() => compileWorkflow(source, limits)).toThrow(/unavailable/u)
    source.spec.nodes.draft!.config.prompt = '${{ nodes.draft.output.reply }}'
    expect(() => compileWorkflow(source, limits)).toThrow(/unavailable/u)
  })
})

function loopSample(overrides: Record<string, JsonValue> = {}) {
  const source = sample()
  source.spec.inputSchema = { type: 'object', required: ['messages'], additionalProperties: false,
    properties: { messages: { type: 'array', items: { type: 'string' } } } } as never
  source.spec.nodes = {
    start: { type: 'trigger', config: { modes: ['manual'] } },
    batch: { type: 'loop', config: { mode: 'forEach', items: '${{ inputs.messages }}', maxIterations: 10, timeoutSeconds: 60,
      body: { entry: 'check', nodes: {
        check: { type: 'rule', config: { mode: 'ifElse', condition: '${{ loop.item == "skip" }}' } },
        write: { type: 'llm', config: { provider: 'deepseek', model: 'configured-model', connection: { mode: 'workspace', id: 'team-model' },
          prompt: 'Reply to ${{ loop.item }} (${{ loop.index }})', responseFormat: 'text', generation: { maxTokens: 100, stream: true },
          execution: { timeoutSeconds: 30, maxAttempts: 1 }, historyScope: 'none' } },
      }, edges: [{ from: 'check', port: 'false', to: 'write' }], exits: [
        { from: 'check', port: 'true', result: { reply: 'skipped' } },
        { from: 'write', result: { reply: '${{ nodes.write.output }}' } },
      ] }, ...overrides } },
    result: { type: 'output', config: { value: '${{ nodes.batch.output.results }}' } },
  }
  source.spec.edges = [{ from: 'start', to: 'batch' }, { from: 'batch', port: 'done', to: 'result' }]
  return source
}

describe('Loop compilation', () => {
  it('compiles a sequential For Each body with typed item, index, exits and collected results', () => {
    const workflow = compileWorkflow(loopSample(), limits)
    const loop = workflow.nodes.find(node => node.id === 'batch')!
    expect(loop.destinations).toEqual({ done: 'result' })
    expect(loop.outputType).toEqual({ kind: 'object', required: ['results', 'count'], properties: {
      results: { kind: 'array', items: { kind: 'object', required: ['reply'], properties: { reply: { kind: 'string' } } } },
      count: { kind: 'number' } } })
    if (loop.plan.kind !== 'loop') throw new Error('Expected a Loop plan')
    expect(loop.plan).toMatchObject({ mode: 'forEach', maxIterations: 10, timeoutSeconds: 60, body: { entry: 'check' } })
    expect(loop.plan).not.toHaveProperty('onLimit')
    expect(loop.plan.body.nodes.map(node => [node.id, node.destinations])).toEqual([['check', { false: 'write' }], ['write', {}]])
    expect(loop.plan.body.exits.map(exit => [exit.from, exit.port])).toEqual([['check', 'true'], ['write', 'next']])
    expect(workflow.nodes.find(node => node.id === 'result')!.outputType).toMatchObject({ kind: 'array' })
  })

  it('compiles Repeat Until with a boolean condition over each result and an optional limit branch', () => {
    const source = loopSample()
    const loop = source.spec.nodes.batch!
    loop.config = { mode: 'repeatUntil', input: '${{ inputs.messages }}', until: '${{ loop.item.reply == "done" }}',
      maxIterations: 3, timeoutSeconds: 60, onLimit: 'branch', body: { entry: 'write', nodes: { write: {
        type: 'llm', config: { provider: 'deepseek', model: 'configured-model', connection: { mode: 'workspace', id: 'team-model' },
          prompt: 'Attempt ${{ loop.index }}', responseFormat: 'text', generation: { maxTokens: 100, stream: true },
          execution: { timeoutSeconds: 30, maxAttempts: 1 }, historyScope: 'none' } } },
      edges: [], exits: [{ from: 'write', result: { reply: '${{ nodes.write.output }}' } }] } }
    source.spec.nodes.gaveUp = { type: 'output', config: { value: 'limit reached' } }
    source.spec.edges.push({ from: 'batch', port: 'limit', to: 'gaveUp' })
    const plan = compileWorkflow(source, limits).nodes.find(node => node.id === 'batch')!
    expect(plan.destinations).toEqual({ done: 'result', limit: 'gaveUp' })
    expect(plan.plan).toMatchObject({ kind: 'loop', mode: 'repeatUntil', onLimit: 'branch', maxIterations: 3 })
    loop.config.onLimit = 'fail'
    source.spec.nodes.gaveUp = { type: 'output', config: { value: 'unused' } }
    source.spec.edges = source.spec.edges.filter(edge => edge.port !== 'limit')
    delete source.spec.nodes.gaveUp
    expect(compileWorkflow(source, limits).nodes.find(node => node.id === 'batch')!.destinations).toEqual({ done: 'result' })
    loop.config.until = '${{ loop.item.reply }}'
    expect(() => compileWorkflow(source, limits)).toThrow(/boolean/u)
  })

  type Body = Record<string, JsonValue> & { nodes: Record<string, JsonValue>; edges: JsonValue[]; exits: JsonValue[] }
  const body = (change: (value: Body) => void) => {
    const source = loopSample()
    change(source.spec.nodes.batch!.config.body as never)
    return source
  }
  it.each([
    ['non-array items', () => loopSample({ items: 'plain text' }), /typed, non-literal-empty array/u],
    ['empty literal items', () => loopSample({ items: [] }), /typed, non-literal-empty array/u],
    ['colliding IDs', () => body((value) => { value.nodes.result = structuredClone(value.nodes.write!); value.exits.push({ from: 'result', result: { reply: 'x' } }) }),
      /differ from outer/u],
    ['missing entry', () => body((value) => { value.entry = 'absent' }), /entry must name/u],
    ['edge into entry', () => body((value) => { value.edges.push({ from: 'write', to: 'check' }); value.exits.pop() }), /other than the entry/u],
    ['missing edge target', () => body((value) => { value.edges.push({ from: 'write', to: 'absent' }); value.exits.pop() }), /other than the entry/u],
    ['duplicate port use', () => body((value) => { value.exits.push({ from: 'write', result: { reply: 'again' } }) }), /exactly once/u],
    ['unknown exit node', () => body((value) => { value.exits.push({ from: 'absent', result: { reply: 'x' } }) }), /exactly once/u],
    ['unreachable node', () => body((value) => { value.nodes.orphan = structuredClone(value.nodes.write!); value.exits.push({ from: 'orphan', result: { reply: 'x' } }) }),
      /acyclic and reachable/u],
    ['uncovered port', () => body((value) => { value.exits.splice(0, 1) }), /continuation or exit/u],
    ['unknown port', () => body((value) => { value.exits.push({ from: 'write', port: 'other', result: { reply: 'x' } }) }), /continuation or exit/u],
    ['different result types', () => body((value) => { value.exits[0] = { from: 'check', port: 'true', result: 'skipped' } }), /same result type/u],
    ['nested loop', () => body((value) => { value.nodes.inner = { type: 'loop', config: {} } }), /unsupported fields/u],
  ] as const)('refuses an invalid Loop: %s', (_name, build, message) => {
    expect(() => compileWorkflow(build(), limits)).toThrow(message)
  })

  it('joins body branches, keeps only values guaranteed on every path and compares array result types', () => {
    const llm = (prompt: string) => ({ type: 'llm', config: { provider: 'deepseek', model: 'configured-model',
      connection: { mode: 'workspace', id: 'team-model' }, prompt, responseFormat: 'text', generation: { maxTokens: 100, stream: true },
      execution: { timeoutSeconds: 30, maxAttempts: 1 }, historyScope: 'none' } })
    const source = body((value) => {
      value.nodes = { check: value.nodes.check!, left: llm('Left ${{ loop.item }}'), right: llm('Right ${{ loop.item }}'),
        join: llm('Joined') }
      value.edges = [{ from: 'check', port: 'true', to: 'left' }, { from: 'check', port: 'false', to: 'right' },
        { from: 'left', to: 'join' }, { from: 'right', to: 'join' }]
      value.exits = [{ from: 'join', result: { tags: ['${{ nodes.join.output }}'], reply: '${{ nodes.join.output }}' } }]
    })
    const loop = compileWorkflow(source, limits).nodes.find(node => node.id === 'batch')!.plan
    if (loop.kind !== 'loop') throw new Error('Expected a Loop plan')
    expect(loop.body.nodes.map(node => node.id)).toEqual(['check', 'left', 'right', 'join'])
    const guaranteed = body((value) => {
      value.nodes = { check: value.nodes.check!, left: llm('Left'), right: llm('Right'), join: llm('${{ nodes.left.output }}') }
      value.edges = [{ from: 'check', port: 'true', to: 'left' }, { from: 'check', port: 'false', to: 'right' },
        { from: 'left', to: 'join' }, { from: 'right', to: 'join' }]
      value.exits = [{ from: 'join', result: 'done' }]
    })
    expect(() => compileWorkflow(guaranteed, limits)).toThrow(/missing, unavailable/u)
    const arrays = body((value) => {
      value.exits = [{ from: 'check', port: 'true', result: { tags: ['a'] } }, { from: 'write', result: { tags: ['${{ nodes.write.output }}'] } }]
    })
    expect(compileWorkflow(arrays, limits).nodes.find(node => node.id === 'batch')!.outputType).toMatchObject({ properties: {
      results: { items: { properties: { tags: { kind: 'array', items: { kind: 'string' } } } } } } })
    for (const exits of [[{ tags: ['a'] }, { tags: [1] }], [{ tags: ['a'] }, { tags: 'a' }], [{ tags: 'a', more: 'b' }, { tags: 'a' }],
      [{ tags: 'a' }, { other: 'a' }]]) {
      const mismatched = body((value) => {
        value.exits = [{ from: 'check', port: 'true', result: exits[0]! }, { from: 'write', result: exits[1]! }]
      })
      expect(() => compileWorkflow(mismatched, limits)).toThrow(/same result type/u)
    }
  })

  it('bounds body size and keeps loop values out of the outer graph', () => {
    const tight = { ...limits, source: { ...limits.source, maxNodes: 1 } }
    expect(() => compileWorkflow(loopSample(), tight)).toThrow()
    const source = loopSample()
    source.spec.nodes.result!.config.value = '${{ loop.item }}'
    expect(() => compileWorkflow(source, limits)).toThrow(/missing, unavailable/u)
    const edges = { ...limits, source: { ...limits.source, maxEdges: 2 } }
    expect(() => compileWorkflow(loopSample(), edges)).toThrow(/budget/u)
  })
})

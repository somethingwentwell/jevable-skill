import { describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { diffWorkflows, parseWorkflow, snapshotWorkflow, WorkflowSourceError } from '../../src/workflow/index.ts'
import type { JsonValue, WorkflowLimits } from '../../src/workflow/types.ts'

const limits: WorkflowLimits = { maxSourceBytes: 100_000, maxDepth: 32, maxValues: 10_000, maxNodes: 100, maxEdges: 200 }
function sample() {
  return {
    apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'support', name: 'Support' },
    spec: {
      inputSchema: { type: 'object' },
      nodes: {
        start: { type: 'trigger', config: { modes: ['manual'] } },
        reply: { type: 'llm', config: { prompt: 'Reply to ${{ inputs.message }}', model: 'configured-model' } },
        end: { type: 'output', config: { value: '${{ nodes.reply.output }}' } },
      } as Record<string, { type: string; config: Record<string, JsonValue> }>,
      edges: [{ from: 'start', to: 'reply' }, { from: 'reply', to: 'end' }] as { from: string; to: string; port?: string }[],
    },
  }
}

describe('workflow source admission', () => {
  it('round-trips YAML and returns a detached recursively immutable revision', () => {
    const input = sample()
    input.spec.nodes.reply!.config.temperature = 0.3
    const result = parseWorkflow(stringify(input), limits)
    expect(result.order).toEqual(['start', 'reply', 'end'])
    expect(result.revision).toMatch(/^[a-f0-9]{64}$/u)
    expect(parseWorkflow(result.yaml, limits)).toEqual(result)
    input.spec.nodes.reply!.config.prompt = 'changed'
    expect(result.yaml).not.toContain('changed')
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.document.spec.nodes)).toBe(true)
    expect(Object.isFrozen(result.document.spec.edges[0])).toBe(true)
    expect(Object.isFrozen(result.order)).toBe(true)
  })

  it('normalizes mapping and edge order but preserves configuration array order', () => {
    const left = sample(), right = sample()
    right.spec.nodes = Object.fromEntries(Object.entries(right.spec.nodes).reverse())
    right.spec.edges.reverse()
    expect(snapshotWorkflow(left, limits).revision).toBe(snapshotWorkflow(right, limits).revision)
    left.spec.nodes.reply!.config.examples = ['first', 'second']
    right.spec.nodes.reply!.config.examples = ['second', 'first']
    expect(snapshotWorkflow(left, limits).revision).not.toBe(snapshotWorkflow(right, limits).revision)
  })

  it.each([
    '', '[]', 'null', 'apiVersion: unknown',
    'apiVersion: x\napiVersion: y',
    'value: !unsupported secret-value',
    'value: &ref [1]\nother: *ref',
    '---\na: 1\n---\nb: 2',
    'value: !!js/function function() {}',
    '__proto__: {polluted: true}',
    'value: .inf',
  ])('rejects invalid YAML without reflecting its values: %s', (source) => {
    expect(() => parseWorkflow(source, limits)).toThrow(WorkflowSourceError)
    try {parseWorkflow(source, limits)} catch (error) {
      expect(String(error)).not.toContain('secret-value')
    }
    expect(Object.hasOwn({}, 'polluted')).toBe(false)
  })

  it('rejects aliases even when they form a valid workflow', () => {
    const yaml = stringify(sample()).replace('inputSchema:', 'inputSchema: &schema')
    expect(() => parseWorkflow(`${yaml}extensions:\n  test/value: *schema\n`, limits)).toThrow(/without aliases/u)
  })

  it('rejects unknown envelope fields, node families and non-namespaced extensions', () => {
    expect(() => snapshotWorkflow({ ...sample(), conversation: [] }, limits)).toThrow(/schema/u)
    expect(() => snapshotWorkflow({ ...sample(), extensions: { unscoped: true } }, limits)).toThrow(/schema/u)
    const input = sample()
    input.spec.nodes.reply!.type = 'unknown'
    expect(() => snapshotWorkflow(input, limits)).toThrow(/schema/u)
    const extended = snapshotWorkflow({ ...sample(), extensions: { 'example.test/flag': true } }, limits)
    expect(extended.document.extensions).toEqual({ 'example.test/flag': true })
  })

  it.each([['apiVersion', 'jevable.ai/v1alpha2'], ['apiVersion', 'jevable.ai/v1'], ['kind', 'Pipeline'], ['kind', 'workflow']])
  ('refuses an otherwise valid document with an unsupported %s %s', (field, value) => {
    const source = { ...sample(), [field]: value }
    expect(() => parseWorkflow(stringify(source), limits)).toThrow(WorkflowSourceError)
    expect(() => snapshotWorkflow(source, limits)).toThrow(WorkflowSourceError)
  })

  it('names where a document breaks the schema, up to five places, without repeating source values', () => {
    const source = sample() as unknown as { spec: Record<string, unknown> & { nodes: Record<string, { type: string }> } }
    source.spec.nodes['start']!.type = 'start'
    source.spec['edge'] = source.spec['edges']
    delete source.spec['edges']
    expect(() => snapshotWorkflow(source, limits))
      .toThrow(/^Workflow source does not match the v1alpha1 document schema: spec\.nodes\.start\.type: [^;]+; .+\.$/u)
    let message = ''
    try { snapshotWorkflow(source, limits) } catch (error) { message = (error as Error).message }
    expect(message).toContain('spec.edges')
    expect(message).not.toContain('"start"')
    const many = { ...sample(), apiVersion: 1, kind: 2, metadata: 3, spec: 4, extensions: 5, extra: true }
    expect(() => snapshotWorkflow(many, limits)).toThrow(/; and \d+ more\.$/u)
    expect(() => snapshotWorkflow([], limits)).toThrow(/schema: \(document\): /u)
  })

  it('refuses YAML text nested beyond the depth budget even when it fits the byte budget', () => {
    const source = sample()
    let nested: JsonValue = 'leaf'
    for (let level = 0; level < 40; level++) nested = [nested]
    source.spec.nodes.reply!.config.examples = nested
    const text = stringify(source)
    expect(Buffer.byteLength(text)).toBeLessThan(limits.maxSourceBytes)
    expect(() => parseWorkflow(text, limits)).toThrow(WorkflowSourceError)
    expect(() => parseWorkflow(text, limits)).toThrow(/nesting budget|value or nesting/u)
  })

  it('enforces source bytes, JSON complexity and graph size independently', () => {
    expect(() => parseWorkflow(stringify(sample()), { ...limits, maxSourceBytes: 5 })).toThrow(/byte budget/u)
    expect(() => snapshotWorkflow(sample(), { ...limits, maxSourceBytes: 5 })).toThrow(/byte budget/u)
    expect(() => snapshotWorkflow(sample(), { ...limits, maxDepth: 2 })).toThrow(/nesting budget/u)
    expect(() => snapshotWorkflow(sample(), { ...limits, maxValues: 5 })).toThrow(/value or nesting/u)
    expect(() => snapshotWorkflow(sample(), { ...limits, maxNodes: 2 })).toThrow(/node or edge/u)
    expect(() => snapshotWorkflow(sample(), { ...limits, maxEdges: 1 })).toThrow(/node or edge/u)
    expect(() => snapshotWorkflow(sample(), { ...limits, maxDepth: 129 })).toThrow(/budgets/u)
    expect(() => snapshotWorkflow(sample(), { ...limits, maxNodes: -1 })).toThrow(/budgets/u)
    const unicode = stringify(sample()).replace('Support', '支援')
    expect(() => parseWorkflow(unicode, { ...limits, maxSourceBytes: unicode.length })).toThrow(/byte budget/u)
  })

  it('rejects non-JSON wire objects, repeated identities and nonfinite values', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    for (const value of [cyclic, new Date(), { value: undefined }, { value: NaN }, { value: BigInt(1) }, { value: () => 1 }]) {
      expect(() => snapshotWorkflow(value, limits)).toThrow(WorkflowSourceError)
    }
    const shared = { type: 'string' }
    expect(() => snapshotWorkflow({ a: shared, b: shared }, limits)).toThrow(/aliases or cycles/u)
    expect(() => snapshotWorkflow(JSON.parse('{"constructor":1}'), limits)).toThrow(/reserved/u)
    const nullPrototype: unknown = Object.assign(Object.create(null), sample())
    expect(snapshotWorkflow(nullPrototype, limits).revision).toBe(snapshotWorkflow(sample(), limits).revision)
  })

  it('rejects sparse, hidden and accessor data without invoking getters', () => {
    const sparse = new Array(10_000_000) as unknown[]
    const extra = Object.assign(new Array(1), { other: 1 })
    const misindexed = Object.assign(new Array(1), { 2: 1, other: 1, another: 1 })
    const hidden = Object.defineProperty({}, 'hidden', { value: true })
    const accessor = { get data(): string { throw new Error('getter must never run') } }
    for (const value of [sparse, extra, misindexed, hidden, accessor, { [Symbol('hidden')]: 1 }]) {
      expect(() => snapshotWorkflow(value, limits)).toThrow(WorkflowSourceError)
    }
  })

  it('bounds canonical YAML expansion and round-trips the exact accepted byte limit', () => {
    const input = sample()
    let nested: JsonValue = 'end'
    for (let i = 0; i < 20; i++) nested = { nested }
    input.spec.nodes.reply!.config.data = nested
    const result = snapshotWorkflow(input, limits)
    const bytes = Buffer.byteLength(result.yaml, 'utf8')
    expect(bytes).toBeGreaterThan(Buffer.byteLength(JSON.stringify(input), 'utf8'))
    expect(() => snapshotWorkflow(input, { ...limits, maxSourceBytes: bytes - 1 })).toThrow(/Canonical YAML/u)
    expect(parseWorkflow(result.yaml, { ...limits, maxSourceBytes: bytes })).toEqual(result)
  })

  it('requires one trigger and at least one output', () => {
    const input = sample(); delete input.spec.nodes.start
    expect(() => snapshotWorkflow(input, limits)).toThrow(/exactly one Trigger/u)
    input.spec.nodes = { ...sample().spec.nodes, second: { type: 'trigger', config: {} } }
    expect(() => snapshotWorkflow(input, limits)).toThrow(/exactly one Trigger/u)
    input.spec.nodes = { ...sample().spec.nodes }; delete input.spec.nodes.end
    expect(() => snapshotWorkflow(input, limits)).toThrow(/at least one Output/u)
  })

  it('rejects missing endpoints, ambiguous ports and backward terminal connections', () => {
    const input = sample()
    input.spec.edges.push({ from: 'reply', to: 'absent' })
    expect(() => snapshotWorkflow(input, limits)).toThrow(/missing node/u)
    input.spec.edges = [...sample().spec.edges, { from: 'start', to: 'end' }]
    expect(() => snapshotWorkflow(input, limits)).toThrow(/multiple outgoing/u)
    input.spec.edges = [...sample().spec.edges, { from: 'end', to: 'start' }]
    expect(() => snapshotWorkflow(input, limits)).toThrow(/Trigger cannot/u)
    input.spec.edges = [...sample().spec.edges, { from: 'end', to: 'reply' }]
    expect(() => snapshotWorkflow(input, limits)).toThrow(/Output cannot/u)
  })

  it('rejects dangling paths, unreachable nodes and cycles', () => {
    const input = sample()
    input.spec.edges.pop()
    expect(() => snapshotWorkflow(input, limits)).toThrow(/requires a continuation/u)
    input.spec.edges = [...sample().spec.edges]
    input.spec.nodes.orphan = { type: 'output', config: {} }
    expect(() => snapshotWorkflow(input, limits)).toThrow(/unreachable/u)
    delete input.spec.nodes.orphan
    input.spec.nodes.check = { type: 'rule', config: {} }
    input.spec.edges = [{ from: 'start', to: 'reply' }, { from: 'reply', to: 'check' },
      { from: 'check', to: 'reply', port: 'again' }, { from: 'check', to: 'end', port: 'done' }]
    expect(() => snapshotWorkflow(input, limits)).toThrow(/cannot contain cycles/u)
  })

  it('orders a branch/join graph deterministically', () => {
    const input = sample()
    input.spec.nodes.route = { type: 'rule', config: { mode: 'ifElse' } }
    input.spec.nodes.other = { type: 'llm', config: {} }
    input.spec.edges = [{ from: 'start', to: 'route' }, { from: 'route', to: 'reply', port: 'true' },
      { from: 'route', to: 'other', port: 'false' }, { from: 'reply', to: 'end' }, { from: 'other', to: 'end' }]
    expect(snapshotWorkflow(input, limits).order).toEqual(['start', 'route', 'other', 'reply', 'end'])
    input.spec.edges.reverse()
    expect(snapshotWorkflow(input, limits).order).toEqual(['start', 'route', 'other', 'reply', 'end'])
  })
})

describe('source change metadata', () => {
  it('reports node and section changes without exposing configuration values', () => {
    const before = snapshotWorkflow(sample(), limits)
    const input = sample()
    input.spec.nodes.newReply = input.spec.nodes.reply!; delete input.spec.nodes.reply
    input.spec.nodes.newReply.config.prompt = 'private-prompt'
    input.spec.nodes.end!.config.value = '${{ nodes.newReply.output }}'
    input.spec.edges = [{ from: 'start', to: 'newReply' }, { from: 'newReply', to: 'end' }]
    input.metadata.name = 'Renamed'; input.spec.inputSchema.type = 'string'
    const after = snapshotWorkflow({ ...input, extensions: { 'test/change': true },
      spec: { ...input.spec, presentation: { direction: 'left-to-right' } } }, limits)
    const diff = diffWorkflows(before, after)
    expect(diff.addedNodes).toEqual(['newReply']); expect(diff.removedNodes).toEqual(['reply'])
    expect(diff.changedNodes).toEqual(['end'])
    expect([diff.edgesChanged, diff.metadataChanged, diff.inputSchemaChanged, diff.presentationChanged, diff.extensionsChanged])
      .toEqual([true, true, true, true, true])
    expect(JSON.stringify(diff)).not.toContain('private-prompt')
    expect(Object.isFrozen(diff.changedNodes)).toBe(true)
    const unchanged = diffWorkflows(before, before)
    expect(unchanged.addedNodes).toEqual([]); expect(unchanged.changedNodes).toEqual([])
    expect([unchanged.edgesChanged, unchanged.metadataChanged, unchanged.inputSchemaChanged,
      unchanged.presentationChanged, unchanged.extensionsChanged]).toEqual([false, false, false, false, false])
  })
})

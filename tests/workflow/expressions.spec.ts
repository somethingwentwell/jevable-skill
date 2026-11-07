import { describe, expect, it } from 'vitest'
import { compileExpression, evaluateExpression, WorkflowExpressionError } from '../../src/workflow/index.ts'
import type { ExpressionEnvironment, ExpressionLimits, ExpressionValues, NodeId } from '../../src/workflow/index.ts'

const limits: ExpressionLimits = { maxSourceBytes: 4096, maxNodes: 100, maxDepth: 32, maxResultBytes: 4096 }
const classifyId = 'classify' as NodeId
const environment: ExpressionEnvironment = {
  inputs: { kind: 'object', required: [], properties: {
    message: { kind: 'string' }, count: { kind: 'number' }, active: { kind: 'boolean' }, absent: { kind: 'string' },
    empty: { kind: 'null' }, items: { kind: 'array', items: { kind: 'string' } },
  } },
  nodes: { [classifyId]: { kind: 'object', required: ['probability'], properties: { probability: { kind: 'number' } } } },
}
const values: ExpressionValues = {
  inputs: { message: '支援', count: 3, active: true, empty: null, items: ['one', 'two'] },
  nodes: { [classifyId]: { output: { probability: 0.8 } } },
}
const compile = (source: string) => compileExpression(source, environment, limits)
const run = (source: string) => evaluateExpression(compile(source), values)

describe('restricted typed expressions', () => {
  it.each([
    ['true', true], ['false', false], ['null', null], ['3', 3], ['"hello"', 'hello'],
    ['-3', -3], ['!false', true], ['inputs.message', '支援'], ['inputs["items"][0]', 'one'],
    ['nodes.classify.output.probability >= 0.65', true], ['inputs.count > 5', false],
    ['inputs.count < 5', true], ['inputs.count <= 3', true], ['inputs.count == 3', true],
    ['inputs.count === 4', false], ['inputs.message != "hello"', true], ['null !== null', false],
    ['inputs.active && (inputs.count > 2)', true], ['false || inputs.active', true],
    ['true || inputs.absent == "none"', true], ['false && inputs.absent == "none"', false],
    ['exists(inputs.absent)', false], ['exists(inputs.empty)', true],
    ['exists(inputs.absent) && inputs.absent == "x"', false],
    ['exists(inputs.items[4])', false], ['(inputs.count >= 3) && !(false)', true],
  ])('evaluates %s without JS execution', (source, expected) => {
    expect(run(source)).toEqual(expected)
  })

  it('retains exact typed references and does not freeze caller schema objects', () => {
    const result = compile('nodes.classify.output.probability >= 0.65 && inputs.active')
    expect(result.references).toEqual([['nodes', 'classify', 'output', 'probability'], ['inputs', 'active']])
    expect(result.resultType).toEqual({ kind: 'boolean' })
    expect(Object.isFrozen(result.instruction)).toBe(true)
    expect(Object.isFrozen(result.references[0])).toBe(true)
    expect(Object.isFrozen(environment.inputs)).toBe(false)
    const object = run('inputs')
    expect(object).toEqual(values.inputs)
    expect(object).not.toBe(values.inputs)
    expect(Object.isFrozen(object)).toBe(true)
    expect(run('inputs.items')).toEqual(['one', 'two'])
    expect(run('inputs.empty')).toBeNull()
  })

  it('admits loop-local references only in an explicit iteration environment', () => {
    const expression = compileExpression('loop.item == "two" && loop.index == 1',
      { ...environment, loop: { item: { kind: 'string' } } }, limits)
    expect(evaluateExpression(expression, { ...values, loop: { item: 'two', index: 1 } })).toBe(true)
    expect(() => compile('loop.item')).toThrow(/unavailable/u)
    expect(() => compile('loop')).toThrow(/loop references/u)
  })

  it.each([
    'globalThis', 'process.env', 'Math.random()', 'inputs.message.trim()', 'exists()', 'exists(inputs, inputs)',
    'exists?.(inputs)', 'exists(1)', 'exists(...inputs.items)', 'new Date()', '() => 1',
    'inputs.count = 10', 'inputs.count++', 'delete inputs.message', 'typeof inputs', 'inputs.count + 1',
    'inputs.count ?? 0', 'inputs.active ? 1 : 0', '[1,2]', '({a: 1})', '/secret-value/', '1n', '1e999', '"x".length',
    'inputs.constructor', 'inputs["__proto__"]', 'inputs.prototype', 'inputs[inputs.message]',
    'inputs[-1]', 'inputs[1.5]', 'inputs[true]', 'inputs[null]', 'inputs?.message',
    'inputs.missing', 'inputs.items["0"]', 'inputs.message.length', 'nodes.future.output',
    'nodes.classify', 'nodes.classify.input', 'nodes', 'loop.index',
    'inputs.count == "3"', 'inputs.items == inputs.items', 'inputs == inputs',
    'inputs.count && 1', '"a" < "b"', '!inputs.count', '-inputs.message',
    'true; false', '', '(((', '/* secret-value */true', 'true //comment', 'true, false',
  ])('rejects unsupported or incorrectly typed expression: %s', (source) => {
    expect(() => compile(source)).toThrow(WorkflowExpressionError)
    try {compile(source)} catch (error) {expect(String(error)).not.toContain('secret-value')}
  })

  it('applies byte, instruction, nesting and result limits', () => {
    expect(() => compileExpression('"支援"', environment, { ...limits, maxSourceBytes: 5 })).toThrow(/source byte/u)
    expect(() => compileExpression('inputs.count > 1', environment, { ...limits, maxNodes: 2 })).toThrow(/instruction/u)
    expect(() => compileExpression('inputs.count', environment, { ...limits, maxNodes: 1 })).toThrow(/instruction/u)
    expect(() => compileExpression('!!!true', environment, { ...limits, maxDepth: 1 })).toThrow(/nesting/u)
    expect(() => compileExpression('nodes.classify.output.probability', environment, { ...limits, maxDepth: 1 })).toThrow(/nesting/u)
    for (const patch of [{ maxDepth: 129 }, { maxNodes: 0 }, { maxSourceBytes: Infinity }, { maxResultBytes: 1.5 }]) {
      expect(() => compileExpression('true', environment, { ...limits, ...patch })).toThrow(/budgets/u)
    }
    const tooSmall = compileExpression('inputs.message', environment, { ...limits, maxResultBytes: 7 })
    expect(() => evaluateExpression(tooSmall, values)).toThrow(/result byte/u)
    const exact = compileExpression('inputs.message', environment, { ...limits, maxResultBytes: 8 })
    expect(evaluateExpression(exact, values)).toBe('支援')
  })

  it('fails on absent values and runtime type mismatches without coercing them', () => {
    expect(() => run('inputs.absent')).toThrow(/missing input/u)
    expect(() => evaluateExpression(compile('inputs.count'), { ...values, inputs: { count: '3' } })).toThrow(/declared type/u)
    expect(() => evaluateExpression(compile('inputs.count'), { ...values, inputs: { count: Infinity } })).toThrow(/declared type/u)
    expect(() => evaluateExpression(compile('inputs.items'), { ...values, inputs: { items: {} } })).toThrow(/declared type/u)
    expect(() => evaluateExpression(compile('inputs'), { ...values, inputs: [] })).toThrow(/declared type/u)
    expect(() => evaluateExpression(compile('inputs.empty'), { ...values, inputs: { empty: false } })).toThrow(/declared type/u)
    expect(() => evaluateExpression(compile('inputs.message'), { ...values, inputs: null })).toThrow(/missing input/u)
    expect(() => evaluateExpression(compile('inputs.message'), { ...values, inputs: 'not an object' })).toThrow(/missing input/u)
    expect(() => evaluateExpression(compile('nodes.classify.output.probability'), { ...values, nodes: {} })).toThrow(/missing input/u)
    expect(() => evaluateExpression(compile('exists(inputs.count)'), { ...values, inputs: { count: '3' } })).toThrow(/declared type/u)
    const inputs = { get count(): number {throw new Error('must not run getter')} }
    expect(() => evaluateExpression(compile('inputs.count'), { ...values, inputs })).toThrow(/not accessors/u)
  })

  it('does not permit prototype data or a node outside the guaranteed upstream environment', () => {
    const inherited = Object.create({ message: 'inherited' }) as Record<string, string>
    expect(evaluateExpression(compile('exists(inputs.message)'), { ...values, inputs: inherited })).toBe(false)
    const branchEnvironment = { ...environment, nodes: {} }
    expect(() => compileExpression('nodes.classify.output.probability', branchEnvironment, limits)).toThrow(/unavailable/u)
    expect(evaluateExpression(compile('exists(nodes.classify.output.probability)'),
      { ...values, nodes: { classify: { output: null } } as Record<NodeId, { output: null }> })).toBe(false)
  })
})

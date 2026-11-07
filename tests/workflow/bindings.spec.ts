import { describe, expect, it } from 'vitest'
import { compileBinding, evaluateBinding } from '../../src/workflow/index.ts'
import type { ExpressionEnvironment, ExpressionValues, WorkflowBindingLimits } from '../../src/workflow/index.ts'

const limits: WorkflowBindingLimits = {
  data: { maxBytes: 4096, maxDepth: 32, maxValues: 1000 },
  expression: { maxSourceBytes: 4096, maxDepth: 32, maxNodes: 100, maxResultBytes: 4096 }, maxExpressions: 20,
}
const environment: ExpressionEnvironment = { inputs: { kind: 'object', required: [], properties: {
  message: { kind: 'string' }, count: { kind: 'number' }, enabled: { kind: 'boolean' }, empty: { kind: 'null' },
  items: { kind: 'array', items: { kind: 'string' } },
} }, nodes: {} }
const values: ExpressionValues = { inputs: { message: '支援', count: 3, enabled: true, empty: null, items: ['a'] }, nodes: {} }
const run = (input: unknown) => evaluateBinding(compileBinding(input, environment, limits), values)

describe('typed JSON bindings', () => {
  it('preserves whole-expression types and recursively interpolates JSON without mutating values', () => {
    expect(run('${{ inputs.count }}')).toBe(3)
    expect(run('${{ inputs.items }}')).toEqual(['a'])
    expect(run({ text: 'Message: ${{ inputs.message }}; ${{ inputs.count }}', active: '${{ inputs.enabled }}',
      value: '${{ inputs.empty }}', list: ['${{ inputs.message }}', 'fixed'], empty: [], nested: { value: 3 }, flag: false, nil: null }))
      .toEqual({ text: 'Message: 支援; 3', active: true, value: null, list: ['支援', 'fixed'], empty: [],
        nested: { value: 3 }, flag: false, nil: null })
    expect(run('')).toBe('')
    expect(run('  ${{ inputs.count }}  ')).toBe('  3  ')
    expect(run('${{ inputs.enabled }}${{ inputs.empty }}')).toBe('truenull')
    const result = run('${{ inputs }}')
    expect(Object.isFrozen(result)).toBe(true)
    expect(result).not.toBe(values.inputs)
  })

  it('parses quoted delimiters and escapes without treating them as template boundaries', () => {
    expect(run('${{ "}}" }}')).toBe('}}')
    expect(run("${{ 'a\\\'b' }}")).toBe("a'b")
    expect(run('${{ "a\\\"b" }}')).toBe('a"b')
    expect(run('${{ "${{" }}')).toBe('${{')
  })

  it.each(['${{ inputs.message', '${{ "unterminated }}', 'Text ${{ inputs.items }}', 'Text ${{ inputs }}',
    '${{ process.exit() }}', '${{ inputs.missing }}'])('rejects invalid interpolation %s', (value) => {
    expect(() => compileBinding(value, environment, limits)).toThrow()
  })

  it('rejects heterogeneous inline arrays and applies an aggregate expression budget', () => {
    expect(() => compileBinding([1, 'two'], environment, limits)).toThrow(/one structural/u)
    expect(() => compileBinding('${{ inputs.count }}', environment, { ...limits, maxExpressions: 0 })).toThrow(/positive/u)
    expect(() => compileBinding({ a: '${{ inputs.count }}', b: '${{ inputs.message }}' }, environment,
      { ...limits, maxExpressions: 1 })).toThrow(/count budget/u)
  })

  it('charges complete JSON results, including object keys, punctuation, escapes and repeated references', () => {
    const small = { ...limits, data: { ...limits.data, maxBytes: 60 } }
    const value: ExpressionValues = { inputs: { ...values.inputs as object, message: 'x'.repeat(30) }, nodes: {} }
    const binding = compileBinding(['${{ inputs.message }}', '${{ inputs.message }}'], environment, small)
    expect(() => evaluateBinding(binding, value)).toThrow(/complete byte/u)
    const object = compileBinding({ data: '${{ inputs.message }}' }, environment, small)
    expect(() => evaluateBinding(object, { inputs: { message: 'x'.repeat(51) }, nodes: {} })).toThrow(/complete byte/u)
    const text = compileBinding('Hello ${{ inputs.message }}!', environment, small)
    expect(() => evaluateBinding(text, { inputs: { message: 'x'.repeat(60) }, nodes: {} })).toThrow(/text exceeds/u)
    const escaped = compileBinding('${{ inputs.message }}', environment, small)
    expect(() => evaluateBinding(escaped, { inputs: { message: '\n'.repeat(30) }, nodes: {} })).toThrow(/complete byte/u)
    expect(evaluateBinding(object, { inputs: { message: 'x'.repeat(49) }, nodes: {} })).toEqual({ data: 'x'.repeat(49) })
    const shallow = compileBinding('${{ inputs }}', environment, { ...limits, data: { ...limits.data, maxDepth: 1 } })
    expect(() => evaluateBinding(shallow, { inputs: { nested: { child: true } }, nodes: {} })).toThrow(/bounded/u)
  })
})

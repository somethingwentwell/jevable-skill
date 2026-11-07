import { expect, it } from 'vitest'
import { stringify } from 'yaml'
import { compileWorkflow, compileWorkflowYaml, evaluateBinding } from '../../src/workflow/index.ts'
import type { WorkflowCompilerLimits } from '../../src/workflow/index.ts'

const limits: WorkflowCompilerLimits = {
  source: { maxSourceBytes: 100_000, maxDepth: 32, maxValues: 10_000, maxNodes: 100, maxEdges: 200 },
  schema: { maxBytes: 10_000, maxDepth: 24, maxValues: 1000 },
  binding: { data: { maxBytes: 10_000, maxDepth: 24, maxValues: 1000 },
    expression: { maxSourceBytes: 1024, maxNodes: 100, maxDepth: 24, maxResultBytes: 10_000 }, maxExpressions: 20 },
}
function sample(patch: Record<string, unknown> = {}, ports = ['approve']) {
  return { apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'review', name: 'Review' }, spec: {
    inputSchema: { type: 'object', required: ['message'], properties: { message: { type: 'string' } } },
    nodes: {
      start: { type: 'trigger', config: { modes: ['manual'] } },
      review: { type: 'humanApproval', config: { title: 'Review: ${{ inputs.message }}', input: '${{ inputs.message }}',
        inputSchema: { type: 'string', maxLength: 500 }, actions: ['approve', 'reject'], expiresAfter: '24h',
        onReject: 'cancelled', onTimeout: 'expired', ...patch } },
      result: { type: 'output', config: { value: '${{ nodes.review.output.action }}' } },
    }, edges: [{ from: 'start', to: 'review' }, ...ports.map(port => ({ from: 'review', to: 'result', port }))],
  } }
}

it('compiles exact review data and explicit terminal outcomes without recording a decision', () => {
  const source = sample(), graph = compileWorkflowYaml(stringify(source), limits)
  const node = graph.nodes.find(node => node.id === 'review')!
  expect(node.destinations).toEqual({ approve: 'result' })
  expect(node.outputType).toEqual({ kind: 'object', required: ['action'], properties: { action: { kind: 'string' } } })
  const plan = node.plan
  if (plan.kind !== 'humanApproval') throw new Error('approval expected')
  expect(plan).toMatchObject({ expiresAfterMs: 86_400_000, onReject: 'cancelled', onTimeout: 'expired', actions: ['approve', 'reject'] })
  expect(evaluateBinding(plan.input.binding, { inputs: { message: 'Original message' }, nodes: {} })).toBe('Original message')
  expect(evaluateBinding(plan.title, { inputs: { message: 'Original message' }, nodes: {} })).toBe('Review: Original message')
  source.spec.nodes.review.config.actions.push('extra')
  expect(plan.actions).toEqual(['approve', 'reject'])
  expect(Object.isFrozen(plan.actions) && Object.isFrozen(plan.input.schema.definition)).toBe(true)
})

it('requires every declared action and timeout route when outcomes branch', () => {
  const patch = { actions: ['approve', 'reject', 'requestChanges'], onReject: 'branch', onTimeout: 'branch' }
  const ports = ['approve', 'reject', 'requestChanges', 'timeout']
  expect(compileWorkflow(sample(patch, ports), limits).nodes[1]!.destinations)
    .toEqual({ approve: 'result', reject: 'result', requestChanges: 'result', timeout: 'result' })
  for (const omitted of ports) {
    expect(() => compileWorkflow(sample(patch, ports.filter(port => port !== omitted)), limits)).toThrow(/requires a destination/u)
  }
})

it.each(['reject', 'timeout', 'next', 'unexpected'])('rejects an undeclared or terminal continuation: %s', (port) => {
  expect(() => compileWorkflow(sample({}, ['approve', port]), limits)).toThrow(/unsupported or duplicated/u)
})

it.each([
  { actions: [] }, { actions: ['approve', 'approve'] }, { actions: ['approve', 'timeout'] },
  { actions: ['approve', 'next'] }, { actions: ['approve', 'default'] }, { actions: ['approve', '__proto__'] },
  { actions: Array.from({ length: 201 }, (_, i) => `choice${i}`) },
  { actions: ['approve'], onReject: 'cancelled' }, { onReject: 'approve' }, { onTimeout: 'approve' },
  { input: '${{ inputs.message }}', inputSchema: { type: 'number' } },
  { input: '${{ nodes.result.output }}' }, { input: '${{ nodes.review.output }}' }, { title: '${{ inputs }}' },
  { title: '' }, { expiresAfter: '0s' }, { expiresAfter: '-1s' }, { expiresAfter: '1.5h' },
  { expiresAfter: 'Infinitys' }, { expiresAfter: '1w' }, { expiresAfter: '1h garbage' },
  { expiresAfter: '999999999999999999999d' }, { autoApprove: true }, { reviewers: ['unverified-user'] },
])('refuses incomplete, unsafe or ambiguous approval configuration: %j', (patch) => {
  expect(() => compileWorkflow(sample(patch), limits)).toThrow()
})

it.each([['1ms', 1], ['2s', 2000], ['3m', 180_000], ['4h', 14_400_000], ['5d', 432_000_000]])('compiles exact expiry %s', (duration, milliseconds) => {
  expect(compileWorkflow(sample({ expiresAfter: duration }), limits).nodes[1]!.plan).toMatchObject({ expiresAfterMs: milliseconds })
})

it('requires explicit context, action and outcome configuration instead of silently supplying defaults', () => {
  for (const field of ['input', 'inputSchema', 'title', 'actions', 'expiresAfter', 'onReject', 'onTimeout']) {
    const source = sample()
    Reflect.deleteProperty(source.spec.nodes.review.config, field)
    expect(() => compileWorkflow(source, limits)).toThrow()
  }
})

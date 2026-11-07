import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { stringify } from 'yaml'
import { compileWorkflow, compileWorkflowYaml, evaluateBinding, evaluateRule, validateDecisionAnswers } from '../../src/workflow/index.ts'
import type { CompiledDecisionPlan, JsonValue, NodeId, WorkflowCompilerLimits } from '../../src/workflow/index.ts'

const limits: WorkflowCompilerLimits = {
  source: { maxSourceBytes: 100_000, maxDepth: 32, maxValues: 10_000, maxNodes: 100, maxEdges: 200 },
  schema: { maxBytes: 20_000, maxDepth: 24, maxValues: 2000 },
  binding: { data: { maxBytes: 10_000, maxDepth: 24, maxValues: 1000 },
    expression: { maxSourceBytes: 1024, maxNodes: 100, maxDepth: 24, maxResultBytes: 10_000 }, maxExpressions: 20 },
}
function source() {
  return { apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'triage', name: 'Typed triage' },
    spec: { inputSchema: { type: 'string' }, nodes: {
      start: { type: 'trigger', config: { modes: ['manual'] } },
      judge: { type: 'decision', config: {
        provider: 'laya', model: 'registered-model', connection: { mode: 'workspace', id: 'local-decisions' },
        state: '${{ inputs }}', execution: { timeoutSeconds: 20, maxAttempts: 1 },
        questions: {
          route: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Payments', technical: 'Bugs' } },
          urgency: { type: 'score', instructions: 'How urgent?', criteria: ['Routine', 'Soon', 'Immediate'] },
          needsHuman: { type: 'noul', instructions: 'Does this need review?' },
        },
      } },
      choose: { type: 'rule', config: { mode: 'ifElse', condition: '${{ nodes.judge.output.needsHuman.probability >= 0.65 }}' } },
      review: { type: 'output', config: { value: '${{ nodes.judge.output.route.choice }}' } },
      normal: { type: 'output', config: { value: '${{ nodes.judge.output.urgency.score }}' } },
    } as Record<string, { type: string; config: Record<string, JsonValue> }>,
    edges: [{ from: 'start', to: 'judge' }, { from: 'judge', to: 'choose' },
      { from: 'choose', port: 'true', to: 'review' }, { from: 'choose', port: 'false', to: 'normal' }] },
  }
}
function plan(value = source()): CompiledDecisionPlan {
  const compiled = compileWorkflow(value, limits).nodes.find(node => node.id === 'judge')!.plan
  if (compiled.kind !== 'decision') throw new Error('Expected typed Decision fixture')
  return compiled
}
function answers(): Record<string, JsonValue> {
  return {
    route: { type: 'choice', choice: 'billing', probabilities: { billing: 0.75, technical: 0.25 }, confidence: 0.8 },
    urgency: { type: 'score', score: 1.6, probabilities: [0.1, 0.2, 0.7], confidence: 0.7 },
    needsHuman: { type: 'noul', probability: 0.9, confidence: 0.9, explanation: 'Sensitive request' },
  }
}

it('compiles all question types into immutable provider-neutral outputs and routes through an ordinary Rule', async () => {
  const input = source(), compiled = compileWorkflow(input, limits), decision = plan(input)
  expect(compileWorkflowYaml(await readFile(new URL('../../examples/decision.yaml', import.meta.url), 'utf8'), limits)).toEqual(compiled)
  expect(compileWorkflowYaml(stringify(input), limits)).toEqual(compiled)
  expect(evaluateBinding(decision.state, { inputs: 'Private state', nodes: {} })).toBe('Private state')
  const result = validateDecisionAnswers(decision, answers(), limits.schema)
  const rule = compiled.nodes.find(node => node.id === 'choose')!.plan
  if (rule.kind !== 'ifElse') throw new Error('Expected Rule fixture')
  expect(evaluateRule(rule, { inputs: 'Private state', nodes: { ['judge' as NodeId]: { output: result } } }))
    .toEqual({ port: 'true', output: { selectedPort: 'true' } })
  expect(compiled.nodes.find(node => node.id === 'judge')!.destinations).toEqual({ next: 'choose' })
  expect(Object.isFrozen(decision.questions.route)).toBe(true)
  input.spec.nodes.judge!.config.questions = {}
  expect(Object.keys(decision.questions)).toEqual(['needsHuman', 'route', 'urgency'])
  expect(JSON.stringify({ questions: decision.questions, output: decision.output.definition, answers: result }, null, 2) + '\n')
    .toBe(await readFile(new URL('./expected/decision.json', import.meta.url), 'utf8'))
})

it.each(['laya', 'jev', 'llm', 'auto'])('preserves the explicit %s route without claiming provider availability', (provider) => {
  const input = source()
  input.spec.nodes.judge!.config.provider = provider
  if (provider === 'llm') input.spec.nodes.judge!.config.llm = { provider: 'registered-llm', generation: { maxTokens: 500, stream: true } }
  input.spec.nodes.judge!.config.connection = { mode: 'custom', protocol: 'registered-decision-protocol',
    endpoint: 'https://decision.example/v1', credentialRef: 'team/decision' }
  const decision = plan(input)
  expect(decision.provider).toBe(provider)
  expect(decision.connection).toEqual(input.spec.nodes.judge!.config.connection)
  expect(validateDecisionAnswers(decision, answers(), limits.schema)).toEqual(answers())
})

it.each([
  { provider: '' }, { model: '' }, { connection: { mode: 'workspace', id: '' } },
  { connection: { mode: 'custom', protocol: '', endpoint: 'https://decision.example' } },
  { connection: { mode: 'custom', protocol: 'laya', endpoint: 'https://secret:password@decision.example' } },
  { connection: { mode: 'custom', protocol: 'laya', endpoint: 'file:///private/state' } },
  { execution: { timeoutSeconds: 0, maxAttempts: 1 } }, { execution: { timeoutSeconds: 10, maxAttempts: 0 } },
  { apiKey: 'private-token' }, { questions: {} },
  { provider: 'llm' }, { llm: { provider: 'unexpected', generation: { maxTokens: 500, stream: true } } },
  { provider: 'llm', llm: { provider: 'registered-llm', generation: { stream: true } } },
  { provider: 'llm', llm: { provider: '', generation: { maxTokens: 500, stream: true } } },
  { provider: 'llm', llm: { provider: 'registered-llm', generation: { maxTokens: 0, stream: true } } },
  { questions: { route: { type: 'choice', instructions: 'Pick', criteria: { only: 'Only' } } } },
  { questions: { route: { type: 'choice', instructions: 'Pick', criteria: { first: '', second: 'Second' } } } },
  { questions: { route: { type: 'choice', instructions: 'Pick', criteria: { ' ': 'Blank label', second: 'Second' } } } },
  { questions: { 'bad.key': { type: 'noul', instructions: 'Ask' } } },
  { questions: { score: { type: 'score', instructions: 'Rank', criteria: ['Same', 'Same'] } } },
  { questions: { score: { type: 'score', instructions: 'Rank', criteria: ['One'] } } },
  { questions: { yes: { type: 'noul', instructions: ' ', criteria: ['No', 'Yes'] } } },
  { questions: { yes: { type: 'unknown', instructions: 'Ask' } } },
])('refuses incomplete or unsupported Decision configuration: %j', (patch) => {
  const input = source()
  Object.assign(input.spec.nodes.judge!.config, patch)
  expect(() => plan(input)).toThrow()
})

it('retains explicit compatibility settings without defaulting or aliasing the source', () => {
  const input = source()
  Object.assign(input.spec.nodes.judge!.config, { provider: 'llm', llm: { provider: 'registered-llm',
    generation: { maxTokens: 500, stream: true, temperature: 0, topP: 0.8 } } })
  const decision = plan(input)
  expect(decision.llm).toEqual(input.spec.nodes.judge!.config.llm)
  expect(Object.isFrozen(decision.llm?.generation)).toBe(true)
  input.spec.nodes.judge!.config.llm = {}
  expect(decision.llm?.provider).toBe('registered-llm')
})

it.each(['state', 'questions', 'connection', 'execution', 'model', 'provider'])('requires explicit %s without a provider-dependent default', (field) => {
  const input = source()
  Reflect.deleteProperty(input.spec.nodes.judge!.config, field)
  expect(() => plan(input)).toThrow()
})

it.each(['${{ nodes.judge.output.missing }}', '${{ nodes.judge.output.route.probability }}',
  '${{ nodes.judge.output.needsHuman.noul }}'])('rejects references outside the normalized answer fields: %s', (value) => {
  const input = source(); input.spec.nodes.review!.config.value = value
  expect(() => plan(input)).toThrow()
})

it('requires a single next continuation and applies complete generated-schema budgets', () => {
  const input = source(); input.spec.edges[1]!.port = 'billing'
  expect(() => plan(input)).toThrow(/port/u)
  expect(() => compileWorkflow(source(), { ...limits, schema: { ...limits.schema, maxBytes: 150 } })).toThrow(/budget/u)
})

it('accepts tied maximal choices and boundary probabilities without inventing provider confidence', () => {
  const value = answers()
  value.route = { type: 'choice', choice: 'technical', probabilities: { billing: 0.5, technical: 0.5 }, confidence: 0.1 }
  value.urgency = { type: 'score', score: 2, probabilities: [0, 0, 1], confidence: 1 }
  value.needsHuman = { type: 'noul', probability: 0, confidence: 1 }
  const result = validateDecisionAnswers(plan(), value, limits.schema)
  expect(result).toEqual(value)
  expect(Object.isFrozen(result) && Object.isFrozen(result.route)).toBe(true)
  value.route = null
  expect(result.route!.type).toBe('choice')
})

it('preserves multilingual and spaced labels without renaming provider choices', () => {
  const input = source(), questions = input.spec.nodes.judge!.config.questions as Record<string, JsonValue>
  questions.route = { type: 'choice', instructions: '選擇部門', criteria: { '帳務支援': '付款問題', 'Technical support': 'Integration' } }
  const value = answers()
  value.route = { type: 'choice', choice: '帳務支援', probabilities: { '帳務支援': 0.6, 'Technical support': 0.4 }, confidence: 0.6 }
  expect(validateDecisionAnswers(plan(input), value, limits.schema)).toEqual(value)
})

it.each([
  { route: { type: 'choice', choice: 'unknown', probabilities: { billing: 0.5, technical: 0.5 }, confidence: 0.5 } },
  { route: { type: 'choice', choice: 'billing', probabilities: { billing: 0.3, technical: 0.7 }, confidence: 0.7 } },
  { route: { type: 'choice', choice: 'billing', probabilities: { billing: 0.7, technical: 0.4 }, confidence: 0.7 } },
  { route: { type: 'choice', choice: 'billing', probabilities: { billing: 1 }, confidence: 1 } },
  { route: { type: 'choice', choice: 'billing', probabilities: { billing: 1, technical: 0, unknown: 0 }, confidence: 1 } },
  { urgency: { type: 'score', score: 1, probabilities: [0.1, 0.2, 0.7], confidence: 0.7 } },
  { urgency: { type: 'score', score: 2.1, probabilities: [0, 0, 1], confidence: 1 } },
  { urgency: { type: 'score', score: 1, probabilities: [0, 1], confidence: 1 } },
  { needsHuman: { type: 'noul', probability: 1.1, confidence: 1 } },
  { needsHuman: { type: 'noul', probability: '0.9', confidence: 1 } },
  { needsHuman: { type: 'noul', probability: 0.9, confidence: -0.1 } },
  { needsHuman: { type: 'noul', probability: 0.9 } },
  { needsHuman: { type: 'noul', probability: 0.9, confidence: 1, extra: 'private-token' } },
  { additionalQuestion: { type: 'noul', probability: 0.9, confidence: 1 } },
])('rejects malformed or inconsistent normalized answers without leaking their content: %j', (patch) => {
  expect(() => validateDecisionAnswers(plan(), { ...answers(), ...patch }, limits.schema)).toThrow()
  try { validateDecisionAnswers(plan(), { ...answers(), ...patch }, limits.schema) }
  catch (error) { expect(String(error)).not.toContain('private-token') }
})

it('refuses raw provider envelopes, incomplete answers, non-finite numbers and oversized complete results', () => {
  const compiled = plan(), value = answers()
  expect(() => validateDecisionAnswers(compiled, { answers: value }, limits.schema)).toThrow()
  delete value.needsHuman
  expect(() => validateDecisionAnswers(compiled, value, limits.schema)).toThrow()
  value.needsHuman = { type: 'noul', probability: NaN, confidence: 1 }
  expect(() => validateDecisionAnswers(compiled, value, limits.schema)).toThrow()
  expect(() => validateDecisionAnswers(compiled, answers(), { ...limits.schema, maxBytes: 100 })).toThrow(/budget/u)
  expect(() => validateDecisionAnswers(structuredClone(compiled), answers(), limits.schema)).toThrow(/receipt/u)
})

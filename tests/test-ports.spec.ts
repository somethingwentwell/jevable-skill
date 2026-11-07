import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { parse } from 'yaml'
import { LocalRuntime, type TestDefinition, type ModelCalls } from '../src/runtime/index.ts'
import { testResult } from '../src/testing/results.ts'
import { testDefinitionSchema, testHash } from '../src/testing/schema.ts'
import { inspectTestSuite, createTestSuite, runTestSuite } from '../src/testing/suite.ts'
import { createEvidenceZip, inspectPackagedAssessment } from '../src/evidence/package.ts'
import { inspectEvidenceZip } from '../src/evidence/inspect.ts'
import { unzipSync } from 'fflate'

const owners: LocalRuntime[] = []
afterEach(async () => { vi.useRealTimers(); for (const owner of owners.splice(0)) await owner.close() })
const identity = ({ id, generation, sha256 }: { id: string; generation: number; sha256: string }) => ({ id, generation, sha256 })
const rule = (mode: 'ifElse' | 'switch') => JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'ports', name: 'Branch tests' },
  spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
    route: { type: 'rule', config: mode === 'ifElse' ? { mode, condition: '${{ inputs == "yes" }}' }
      : { mode, value: '${{ inputs }}', cases: [{ port: 'yes', value: 'yes' }] } },
    end: { type: 'output', config: { value: '${{ inputs }}' } } }, edges: [{ from: 'start', to: 'route' },
    ...(mode === 'ifElse' ? ['true', 'false'] : ['yes', 'default']).map(port => ({ from: 'route', port, to: 'end' }))] } })
const loop = (repeat = false, badReturn = false) => JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'body', name: 'Scoped port tests' },
  spec: { inputSchema: { type: 'array', items: { type: 'string' } }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
    each: { type: 'loop', config: { mode: repeat ? 'repeatUntil' : 'forEach', ...(repeat ? { input: '${{ inputs }}', until: '${{ false }}', onLimit: 'branch' } : { items: '${{ inputs }}' }),
      maxIterations: 2, timeoutSeconds: 60, body: { entry: 'check', nodes: { check: { type: 'rule', config: { mode: 'ifElse', condition: repeat ? '${{ true }}' : '${{ loop.item == "yes" }}' } } },
        edges: [], exits: ['true', 'false'].map(port => ({ from: 'check', port, result: badReturn ? '${{ inputs[99] }}' : true })) } } },
    end: { type: 'output', config: { value: '${{ nodes.each.output.count }}' } } }, edges: [{ from: 'start', to: 'each' },
    { from: 'each', port: 'done', to: 'end' }, ...(repeat ? [{ from: 'each', port: 'limit', to: 'end' }] : [])] } })
async function fixture(yaml: string, input: TestDefinition['input'], expectations: TestDefinition['expectations'], models?: ModelCalls) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-test-ports-'))
  const runtime = await LocalRuntime.open({ dataDirectory: directory, ...(models ? { models } : {}) }); owners.push(runtime)
  const project = runtime.editProject({ operation: 'create', yaml, title: 'PRIVATE_PROJECT', actor: 'fixture' })
  const definition = { title: 'PRIVATE_TEST', project: { id: project.id, generation: project.generation, revision: project.acceptedRevision }, input, expectations }
  const draft = runtime.editTest({ operation: 'create', definition, actor: 'fixture' })
  const test = runtime.editTest({ operation: 'accept', id: draft.id, expectedGeneration: 1, reviewedSha256: draft.sha256, actor: 'fixture' })
  return { runtime, directory, project, definition, test }
}

it.each([['ifElse', 'yes', 'true'], ['ifElse', 'no', 'false'], ['switch', 'yes', 'yes'], ['switch', 'no', 'default']] as const)
('asserts %s port %s/%s even when both routes reach the same final node', async (mode, input, port) => {
  const f = await fixture(rule(mode), input, [{ kind: 'status', value: 'completed' }, { kind: 'node-port-equals', nodeId: 'route', value: port }])
  const id = randomUUID(), result = await f.runtime.runTest(identity(f.test), id)
  expect(result.assessment).toBe('passed'); expect(result.checks[1]).toMatchObject({ available: true, matched: true })
  expect(result.checks[1]).not.toHaveProperty('expected'); expect(result.checks[1]).not.toHaveProperty('actual')
  expect((await f.runtime.testResult(id, true)).checks[1]).toMatchObject({ expected: port, actual: port })
  const events = await f.runtime.events(id); await f.runtime.close()
  const reopened = await LocalRuntime.open({ dataDirectory: f.directory }); owners.push(reopened)
  expect(await reopened.runTest(identity(f.test), id)).toEqual(result); expect(await reopened.events(id)).toEqual(events)
})

it('a different valid expected port fails the test, not the completed workflow', async () => {
  const f = await fixture(rule('ifElse'), 'yes', [{ kind: 'status', value: 'completed' }, { kind: 'node-port-equals', nodeId: 'route', value: 'false' }])
  const result = await f.runtime.runTest(identity(f.test), randomUUID())
  expect(result).toMatchObject({ workflowStatus: 'completed', assessment: 'failed', terminal: true })
  expect((await f.runtime.testResult(result.run.id, true)).checks[1]).toMatchObject({ available: true, matched: false, expected: 'false', actual: 'true' })
})

it.each([false, true])('packages and inspects retained port assessments with private=%s', async includePrivate => {
  const f = await fixture(rule('ifElse'), 'yes', [{ kind: 'status', value: 'completed' }, { kind: 'node-port-equals', nodeId: 'route', value: 'true' }])
  const runId = randomUUID(); await f.runtime.runTest(identity(f.test), runId)
  const before = await f.runtime.events(runId)
  const archive = await createEvidenceZip(f.runtime, { schemaVersion: 1, runs: [{ id: runId, revision: f.project.acceptedRevision }] }, includePrivate)
  const checked = await inspectEvidenceZip(archive.bytes)
  expect(checked).toBeDefined()
  const files = unzipSync(archive.bytes), assessment = JSON.parse(Buffer.from(files[`tests/${runId}.json`]!).toString())
  const evidence = JSON.parse(Buffer.from(files[`runs/${runId}.json`]!).toString())
  expect(assessment.checks[1]).toMatchObject({ kind: 'node-port-equals', nodeId: 'route', matched: true, available: true })
  expect(Object.hasOwn(assessment.checks[1], 'actual')).toBe(includePrivate)
  expect(inspectPackagedAssessment(assessment, evidence.snapshot.run, includePrivate)).toEqual(assessment)
  const forged = structuredClone(assessment); delete forged.checks[1].nodeId
  expect(() => inspectPackagedAssessment(forged, evidence.snapshot.run, includePrivate)).toThrow('corrupt')
  expect(await f.runtime.events(runId)).toEqual(before)
})

it('asserts body exit ports per exact iteration separately from loop completion', async () => {
  const f = await fixture(loop(), ['yes', 'no'], [{ kind: 'status', value: 'completed' },
    { kind: 'node-port-equals', nodeId: 'check', scope: { loop: 'each', index: 0 }, value: 'true' },
    { kind: 'node-port-equals', nodeId: 'check', scope: { loop: 'each', index: 1 }, value: 'false' },
    { kind: 'node-port-equals', nodeId: 'each', value: 'done' }])
  const result = await f.runtime.runTest(identity(f.test), randomUUID())
  expect(result.assessment).toBe('passed')
  expect((await f.runtime.testResult(result.run.id, true)).checks.map(c => c.actual)).toEqual(['completed', 'true', 'false', 'done'])
})

it('asserts Repeat Until limit selection without claiming the done route', async () => {
  const f = await fixture(loop(true), [], [{ kind: 'status', value: 'completed' }, { kind: 'node-port-equals', nodeId: 'each', value: 'limit' }])
  expect((await f.runtime.runTest(identity(f.test), randomUUID())).assessment).toBe('passed')
})

it('a selected body exit can match while its return binding fails', async () => {
  const f = await fixture(loop(false, true), ['yes'], [{ kind: 'status', value: 'failed' }, { kind: 'failure-code', value: 'invalid-node-value' },
    { kind: 'node-port-equals', nodeId: 'check', scope: { loop: 'each', index: 0 }, value: 'true' }, { kind: 'node-port-equals', nodeId: 'each', value: 'done' }])
  const result = await f.runtime.runTest(identity(f.test), randomUUID())
  expect(result).toMatchObject({ workflowStatus: 'failed', assessment: 'failed' })
  expect(result.checks[2]).toMatchObject({ matched: true, available: true }); expect(result.checks[3]).toMatchObject({ matched: false, available: false })
})

it.each(['approve', 'reject', 'timeout'] as const)('does not invent an approval port before retained %s selection', async port => {
  const workflow = parse(await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8'))
  workflow.spec.nodes.review.config.onReject = 'branch'; workflow.spec.nodes.review.config.onTimeout = 'branch'
  workflow.spec.edges = [{ from: 'start', to: 'review' }, ...['approve', 'reject', 'timeout'].map(port => ({ from: 'review', port, to: 'result' }))]
  const f = await fixture(JSON.stringify(workflow), { message: 'PRIVATE_REVIEW' }, [{ kind: 'status', value: 'completed' }, { kind: 'node-port-equals', nodeId: 'review', value: port }])
  const result = await f.runtime.runTest(identity(f.test), randomUUID()), waiting = await f.runtime.show(result.run.id)
  expect(result.assessment).toBe('pending'); expect(result.checks[1]).toMatchObject({ available: false, matched: false })
  if (waiting.state.status !== 'waiting') throw Error('Expected fixture approval')
  if (port === 'timeout') { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(waiting.state.expiresAt) + 1) }
  await f.runtime.decide(waiting.id, waiting.state.attempt.id, port === 'timeout' ? 'approve' : port, 'fixture')
  expect((await f.runtime.testResult(waiting.id, true)).checks[1]).toMatchObject({ available: true, matched: true, actual: port })
})

it.each([
  { nodeId: 'route', value: 'next' }, { nodeId: 'end', value: 'next' }, { nodeId: 'start', value: 'default' },
  { nodeId: 'missing', value: 'true' }, { nodeId: 'route', value: 'true', scope: { loop: 'start', index: 0 } },
])('refuses undeclared port/node/scope before saving a draft: %j', async expectation => {
  const f = await fixture(rule('ifElse'), 'yes', [{ kind: 'status', value: 'completed' }]), before = f.runtime.testCases()
  expect(() => f.runtime.editTest({ operation: 'create', actor: 'fixture', definition: { ...f.definition,
    expectations: [{ kind: 'status', value: 'completed' }, { kind: 'node-port-equals', ...expectation }] } })).toThrow('invalid-command')
  expect(f.runtime.testCases()).toEqual(before)
})

it('never infers missing legacy port evidence from a settled result or target', async () => {
  const f = await fixture(rule('ifElse'), 'yes', [{ kind: 'status', value: 'completed' }, { kind: 'node-port-equals', nodeId: 'route', value: 'true' }])
  const runId = randomUUID(); await f.runtime.runTest(identity(f.test), runId)
  const legacy = structuredClone(await f.runtime.show(runId)); delete legacy.state.steps.find(s => s.nodeId === 'route')!.port
  const result = testResult(f.test, legacy, true)
  expect(result.checks[1]).toMatchObject({ matched: false, available: false, expected: 'true' }); expect(result.checks[1]).not.toHaveProperty('actual')
  expect(legacy.state.steps.find(s => s.nodeId === 'route')).not.toHaveProperty('port')
})

it('includes ports in immutable case review hashes while preserving old definition shapes', async () => {
  const f = await fixture(rule('ifElse'), 'yes', [{ kind: 'status', value: 'completed' }])
  expect(testHash(testDefinitionSchema.parse(f.definition))).toBe(testHash(f.definition))
  const yes = { ...f.definition, expectations: [...f.definition.expectations, { kind: 'node-port-equals' as const, nodeId: 'route', value: 'true' }] }
  const no = { ...yes, expectations: [...f.definition.expectations, { kind: 'node-port-equals' as const, nodeId: 'route', value: 'false' }] }
  expect(testHash(yes)).not.toBe(testHash(no)); expect(testHash(yes)).not.toBe(f.test.sha256)
  const suite = createTestSuite({ title: 'Retained route suite', tests: [identity(f.test)], failurePolicy: 'stop', concurrency: 2 })
  expect(inspectTestSuite(suite.suite).sha256).toBe(suite.sha256)
  expect((await runTestSuite(f.runtime, suite.suite, suite.sha256)).status).toBe('passed')
})

it('Decision next and downstream confidence routing remain distinct assertions', async () => {
  const workflow = parse(await readFile(new URL('../examples/decision.yaml', import.meta.url), 'utf8'))
  workflow.spec.nodes.judge.config.provider = 'llm'; workflow.spec.nodes.judge.config.llm = { provider: 'fixture', generation: { maxTokens: 200, stream: false } }
  const execute = vi.fn(async () => ({ output: JSON.stringify({ value: {
    route: { type: 'choice', choice: 'billing', probabilities: { billing: 0.75, technical: 0.25 }, confidence: 0.8 },
    urgency: { type: 'score', score: 1.6, probabilities: [0.1, 0.2, 0.7], confidence: 0.7 },
    needsHuman: { type: 'noul', probability: 0.9, confidence: 0.9 } } }), usage: { tries: 1 as const } }))
  const route = Object.keys(workflow.spec.nodes).find(id => workflow.spec.nodes[id].type === 'rule')!
  const f = await fixture(JSON.stringify(workflow), 'PRIVATE_TICKET', [{ kind: 'status', value: 'completed' },
    { kind: 'node-port-equals', nodeId: 'judge', value: 'next' }, { kind: 'node-port-equals', nodeId: route, value: 'true' }], { admit() {}, execute, async verify() {} })
  const runId = randomUUID(); expect((await f.runtime.runTest(identity(f.test), runId)).assessment).toBe('passed')
  expect((await f.runtime.runTest(identity(f.test), runId)).assessment).toBe('passed'); expect(execute).toHaveBeenCalledTimes(1)
})

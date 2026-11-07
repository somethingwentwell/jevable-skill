import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import { LocalRuntime, WorkflowRuntimeError, type TestDefinition } from '../src/runtime/index.ts'
import { createTestSuite, runTestSuite } from '../src/testing/suite.ts'
import { testSuiteCoverage } from '../src/testing/index.ts'
import { createHttpTestSuiteHost } from '../src/testing/http.ts'
import { startRuntimeService, RuntimeClient } from '../src/http/index.ts'
import { main } from '../src/cli.ts'

const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const loop = await readFile(new URL('../examples/loop-approval.yaml', import.meta.url), 'utf8')
const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const close: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const done of close.splice(0).reverse()) await done() })
const pin = (value: { id: string; generation: number; sha256: string }) => ({ id: value.id, generation: value.generation, sha256: value.sha256 })
const branch = (sameTarget = false) => JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow',
  metadata: { id: 'coverage', name: 'PRIVATE_NAME' }, spec: { inputSchema: { type: 'boolean' }, nodes: {
    start: { type: 'trigger', config: { modes: ['manual'] } },
    choose: { type: 'rule', config: { mode: 'ifElse', condition: '${{ inputs }}' } },
    left: { type: 'output', config: { value: 'PRIVATE_LEFT' } },
    ...(!sameTarget ? { right: { type: 'output', config: { value: 'PRIVATE_RIGHT' } } } : {}),
  }, edges: [{ from: 'start', to: 'choose' }, { from: 'choose', port: 'true', to: 'left' },
    { from: 'choose', port: 'false', to: sameTarget ? 'left' : 'right' }] } })
async function fixture(source = branch(), inputs: unknown[] = [true, false], status: 'completed' | 'waiting' = 'completed') {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-coverage-')), runtime = await LocalRuntime.open({ dataDirectory: directory })
  close.push(() => runtime.close())
  const project = runtime.editProject({ operation: 'create', yaml: source, title: 'PRIVATE_TITLE', actor: 'PRIVATE_ACTOR' })
  const tests = inputs.map(input => {
    const draft = runtime.editTest({ operation: 'create', actor: 'PRIVATE_ACTOR', definition: { title: 'PRIVATE_CASE',
      project: { id: project.id, generation: project.generation, revision: project.acceptedRevision }, input: input as TestDefinition['input'],
      expectations: [{ kind: 'status', value: status }] } })
    return pin(runtime.editTest({ operation: 'accept', id: draft.id, expectedGeneration: draft.generation,
      reviewedSha256: draft.sha256, actor: 'PRIVATE_ACTOR' }))
  })
  const prepared = createTestSuite({ title: 'PRIVATE_SUITE', tests, failurePolicy: 'continue' })
  return { directory, runtime, project, tests, prepared, source }
}
const node = (report: Awaited<ReturnType<typeof testSuiteCoverage>>, nodeId: string, scope = 'workflow') =>
  report.nodes.find(value => value.nodeId === nodeId && value.scope === scope)!
const routes = (report: Awaited<ReturnType<typeof testSuiteCoverage>>, from: string) => report.routes.filter(value => value.from === from)
async function cli(args: string[]) { let out = '', err = ''; const code = await main(args, {
  out: value => { out += value }, err: value => { err += value } }); return { code, err, report: out ? JSON.parse(out) : undefined } }

it('reports untested routes before any run without admitting execution or private reads', async () => {
  const f = await fixture(), execute = vi.spyOn(f.runtime, 'runTest'), privateRead = vi.spyOn(f.runtime, 'testCase')
  const report = await testSuiteCoverage(f.runtime, f.prepared.suite, f.source)
  expect(report.observationStatus).toBe('partial')
  expect(report.summary).toMatchObject({ selectedRuns: 2, observedRuns: 0, nodesWithResults: 0, totalNodes: 4,
    routesWithSelections: 0, totalRoutes: 3 })
  expect(execute).not.toHaveBeenCalled(); expect(privateRead).not.toHaveBeenCalled(); expect(f.runtime.list()).toEqual([])
  expect(JSON.stringify(report)).not.toContain('PRIVATE_')
})
it('counts both recorded branches across distinct retained runs and preserves all journals on repeated reads', async () => {
  const f = await fixture(); await runTestSuite(f.runtime, f.prepared.suite, f.prepared.sha256)
  const events = await Promise.all(f.prepared.suite.entries.map(entry => f.runtime.events(entry.runId)))
  const records = await Promise.all(f.prepared.suite.entries.map(entry => f.runtime.show(entry.runId)))
  const execute = vi.spyOn(f.runtime, 'runTest'), accept = vi.spyOn(f.runtime, 'editTest')
  const report = await testSuiteCoverage(f.runtime, f.prepared.suite, f.source)
  expect(report.observationStatus).toBe('complete')
  expect(report.summary).toMatchObject({ observedRuns: 2, terminalRuns: 2, passedAssessments: 2,
    nodesWithResults: 4, totalNodes: 4, routesWithSelections: 3, totalRoutes: 3, resultsWithoutRecordedPort: 0 })
  expect(node(report, 'choose')).toMatchObject({ settledResults: 2, runs: 2 })
  expect(routes(report, 'choose').map(route => [route.port, route.selections, route.runs])).toEqual([['false', 1, 1], ['true', 1, 1]])
  expect(await testSuiteCoverage(f.runtime, f.prepared.suite, f.source)).toEqual(report)
  expect(execute).not.toHaveBeenCalled(); expect(accept).not.toHaveBeenCalled()
  expect(await Promise.all(f.prepared.suite.entries.map(entry => f.runtime.events(entry.runId)))).toEqual(events)
  expect(await Promise.all(f.prepared.suite.entries.map(entry => f.runtime.show(entry.runId)))).toEqual(records)
  expect(JSON.stringify(report)).not.toContain('PRIVATE_')
})
it('keeps a passing waiting assertion distinct from approval-node settlement and target execution', async () => {
  const f = await fixture(approval, [{ message: 'PRIVATE_REVIEW' }], 'waiting')
  await runTestSuite(f.runtime, f.prepared.suite, f.prepared.sha256)
  const decide = vi.spyOn(f.runtime, 'decide'), report = await testSuiteCoverage(f.runtime, f.prepared.suite, f.source)
  expect(report.summary).toMatchObject({ passedAssessments: 1, terminalRuns: 0, nodesWithResults: 1, routesWithSelections: 1 })
  expect(node(report, 'review').settledResults).toBe(0); expect(node(report, 'result').settledResults).toBe(0)
  expect(routes(report, 'review')[0]!.selections).toBe(0); expect(decide).not.toHaveBeenCalled()
})
it('does not mark a rejected approval as settled or invent a selected continuation', async () => {
  const f = await fixture(approval, [{ message: 'PRIVATE_REVIEW' }], 'waiting')
  await runTestSuite(f.runtime, f.prepared.suite, f.prepared.sha256)
  const run = await f.runtime.show(f.prepared.suite.entries[0]!.runId)
  if (run.state.status !== 'waiting') throw Error('Expected wait')
  await f.runtime.decide(run.id, run.state.attempt.id, 'reject', 'synthetic-reviewer')
  const report = await testSuiteCoverage(f.runtime, f.prepared.suite, f.source)
  expect(report.summary.passedAssessments).toBe(0); expect(report.entries[0]!.result?.workflowStatus).toBe('failed')
  expect(node(report, 'review').settledResults).toBe(0); expect(routes(report, 'review')[0]!.selections).toBe(0)
})
it('separates loop bookkeeping, body settlements and port selections across actual iterations', async () => {
  const f = await fixture(loop, [['PRIVATE_FIRST', 'PRIVATE_SECOND']], 'waiting')
  await runTestSuite(f.runtime, f.prepared.suite, f.prepared.sha256)
  const id = f.prepared.suite.entries[0]!.runId
  for (const action of ['approve', 'reject']) {
    const run = await f.runtime.show(id); if (run.state.status !== 'waiting') throw Error('Expected wait')
    await f.runtime.decide(id, run.state.attempt.id, action, 'synthetic-reviewer')
  }
  const report = await testSuiteCoverage(f.runtime, f.prepared.suite, f.source)
  expect(report.summary).toMatchObject({ nodesWithResults: 4, totalNodes: 4, routesWithSelections: 4,
    totalRoutes: 4, loopIterationReturns: 2, resultsWithoutRecordedPort: 0 })
  expect(node(report, 'each')).toMatchObject({ settledResults: 1, runs: 1 })
  expect(node(report, 'review', 'workflow/each')).toMatchObject({ settledResults: 2, runs: 1 })
  expect(routes(report, 'review').map(route => [route.kind, route.port, route.selections, route.runs]))
    .toEqual([['loop-return', 'approve', 1, 1], ['loop-return', 'reject', 1, 1]])
  expect(report.nodes.reduce((sum, item) => sum + item.settledResults, 0)).toBe(5)
  expect(JSON.stringify(report)).not.toContain('PRIVATE_')
})
it('counts an empty completed loop once without inventing a body result or return selection', async () => {
  const f = await fixture(loop, [[]]); await runTestSuite(f.runtime, f.prepared.suite, f.prepared.sha256)
  const report = await testSuiteCoverage(f.runtime, f.prepared.suite, f.source)
  expect(node(report, 'each').settledResults).toBe(1); expect(node(report, 'review', 'workflow/each').settledResults).toBe(0)
  expect(report.summary.loopIterationReturns).toBe(0); expect(routes(report, 'review').every(route => route.selections === 0)).toBe(true)
})
it('retains exact port distinctions when both branches lead to the same target', async () => {
  const f = await fixture(branch(true)); await runTestSuite(f.runtime, f.prepared.suite, f.prepared.sha256)
  const report = await testSuiteCoverage(f.runtime, f.prepared.suite, f.source)
  expect(routes(report, 'choose').map(route => [route.to, route.port, route.selections])).toEqual([['left', 'false', 1], ['left', 'true', 1]])
  const host = { testResult: async (id: string) => { const result = await f.runtime.testResult(id)
    return { ...result, run: { ...result.run, steps: result.run.steps.map(({ port: _port, ...step }) => step) } } } }
  const legacy = await testSuiteCoverage(host, f.prepared.suite, f.source)
  expect(legacy.summary.resultsWithoutRecordedPort).toBe(4); expect(legacy.summary.routesWithSelections).toBe(0)
  expect(legacy.summary.nodesWithResults).toBe(3)
})
it('does not infer completion of a selected route target at a paused or unsettled checkpoint', async () => {
  const f = await fixture(branch(), [true]); await runTestSuite(f.runtime, f.prepared.suite, f.prepared.sha256)
  const original = await f.runtime.testResult(f.prepared.suite.entries[0]!.runId)
  for (const status of ['paused', 'executing'] as const) {
    const raw = { ...original, assessment: status === 'paused' ? 'pending' : 'uncertain', terminal: false, workflowStatus: status,
      checks: original.checks.map(check => ({ ...check, matched: false })), run: { ...original.run,
        status, nodeId: 'left', steps: original.run.steps.slice(0, 2) } }
    const report = await testSuiteCoverage({ testResult: async () => raw }, f.prepared.suite, f.source)
    expect(routes(report, 'choose').find(route => route.port === 'true')!.selections).toBe(1)
    expect(node(report, 'left').settledResults).toBe(0); expect(report.summary.terminalRuns).toBe(0)
  }
})
it('rejects missing steps and out-of-range or duplicate loop returns instead of inflating coverage', async () => {
  const f = await fixture(loop, [[]]); await runTestSuite(f.runtime, f.prepared.suite, f.prepared.sha256)
  const original = await f.runtime.testResult(f.prepared.suite.entries[0]!.runId)
  for (const steps of [undefined, [{ nodeId: 'review', scope: { loop: 'each', index: 3 }, port: 'approve' }],
    [{ nodeId: 'each', scope: { loop: 'each', index: 0 } }, { nodeId: 'each', scope: { loop: 'each', index: 0 } }]]) {
    const raw = { ...original, run: { ...original.run, steps } }
    await expect(testSuiteCoverage({ testResult: async () => raw }, f.prepared.suite, f.source)).rejects.toBeInstanceOf(WorkflowRuntimeError)
  }
})
it.each(['revision', 'test-pin', 'run-pin', 'terminal', 'unknown-node', 'unknown-port', 'unknown-loop', 'duplicate-position', 'invalid-step-type'])
  ('refuses malformed or substituted %s evidence without dispatch', async mutation => {
    const f = await fixture(echo, ['PRIVATE_INPUT']); await runTestSuite(f.runtime, f.prepared.suite, f.prepared.sha256)
    const raw: any = structuredClone(await f.runtime.testResult(f.prepared.suite.entries[0]!.runId))
    if (mutation === 'revision') raw.run.revision = 'a'.repeat(64)
    if (mutation === 'test-pin') raw.test.sha256 = 'a'.repeat(64)
    if (mutation === 'run-pin') raw.run.id = randomUUID()
    if (mutation === 'terminal') raw.terminal = false
    if (mutation === 'unknown-node') raw.run.steps[0].nodeId = 'foreign'
    if (mutation === 'unknown-port') raw.run.steps[0].port = 'foreign'
    if (mutation === 'unknown-loop') raw.run.steps[0].scope = { loop: 'foreign', index: 0 }
    if (mutation === 'duplicate-position') raw.run.steps.push(raw.run.steps[0])
    if (mutation === 'invalid-step-type') raw.run.steps[0].nodeId = 1
    await expect(testSuiteCoverage({ testResult: async () => raw }, f.prepared.suite, f.source)).rejects.toBeInstanceOf(WorkflowRuntimeError)
  })
it('refuses revision-mixed suites instead of silently dropping foreign observations', async () => {
  const f = await fixture(); await runTestSuite(f.runtime, f.prepared.suite, f.prepared.sha256)
  const read = vi.spyOn(f.runtime, 'testResult')
  await expect(testSuiteCoverage(f.runtime, f.prepared.suite, echo)).rejects.toMatchObject({ code: 'conflict' })
  expect(read).toHaveBeenCalledTimes(1)
})
it('does not depend on current edited/archived authoring state to read historical evidence', async () => {
  const f = await fixture(); await runTestSuite(f.runtime, f.prepared.suite, f.prepared.sha256)
  f.runtime.editTest({ operation: 'archive', id: f.tests[0]!.id, expectedGeneration: f.tests[0]!.generation,
    reviewedSha256: f.tests[0]!.sha256, archived: true, actor: 'author' })
  f.runtime.editProject({ operation: 'archive', id: f.project.id, expectedGeneration: f.project.generation, archived: true, actor: 'author' })
  expect((await testSuiteCoverage(f.runtime, f.prepared.suite, f.source)).summary.observedRuns).toBe(2)
})
it('stops reads on a lost owner, reports partial observations and redacts unexpected errors', async () => {
  const f = await fixture(), read = vi.fn().mockRejectedValue(Error('PRIVATE_PROVIDER_FAILURE'))
  const report = await testSuiteCoverage({ testResult: read }, f.prepared.suite, f.source)
  expect(read).toHaveBeenCalledTimes(1); expect(report.observationStatus).toBe('partial')
  expect(report.entries[0]!.error).toEqual({ stage: 'read', code: 'operation-failed', execution: 'not-requested' })
  expect(report.entries).toHaveLength(2); expect(JSON.stringify(report)).not.toContain('PRIVATE_')
})
it('continues metadata reads past missing runs while keeping them visibly unobserved', async () => {
  const f = await fixture(); await f.runtime.runTest(f.tests[1]!, f.prepared.suite.entries[1]!.runId)
  const report = await testSuiteCoverage(f.runtime, f.prepared.suite, f.source)
  expect(report.observationStatus).toBe('partial'); expect(report.summary.observedRuns).toBe(1)
  expect(report.entries.map(entry => entry.observation)).toEqual(['not-observed', 'retained'])
})
it('interrupts between reads without abandoning an in-flight observation or admitting execution', async () => {
  const f = await fixture(), controller = new AbortController()
  const read = vi.fn(async () => { controller.abort(); throw new WorkflowRuntimeError('not-found') })
  const report = await testSuiteCoverage({ testResult: read }, f.prepared.suite, f.source, { signal: controller.signal })
  expect(report.observationStatus).toBe('interrupted'); expect(read).toHaveBeenCalledTimes(1)
  const other = vi.fn(); await testSuiteCoverage({ testResult: other }, f.prepared.suite, f.source, { signal: controller.signal })
  expect(other).not.toHaveBeenCalled()
})
it('rejects invalid graph/manifest/options before host I/O', async () => {
  const read = vi.fn(), f = await fixture()
  await expect(testSuiteCoverage({ testResult: read }, {}, f.source)).rejects.toThrow()
  await expect(testSuiteCoverage({ testResult: read }, f.prepared.suite, 'not a workflow')).rejects.toThrow()
  await expect(testSuiteCoverage({ testResult: read }, f.prepared.suite, f.source, { signal: {} as AbortSignal })).rejects.toMatchObject({ code: 'invalid-command' })
  expect(read).not.toHaveBeenCalled()
})
it('runs the real local CLI read-only after owner close/reopen and exposes complete JSON help', async () => {
  const f = await fixture(); await runTestSuite(f.runtime, f.prepared.suite, f.prepared.sha256)
  const events = await Promise.all(f.prepared.suite.entries.map(entry => f.runtime.events(entry.runId)))
  const suite = join(f.directory, 'suite.json'), source = join(f.directory, 'workflow.yaml')
  await writeFile(suite, JSON.stringify(f.prepared.suite)); await writeFile(source, f.source); await f.runtime.close()
  const result = await cli(['tests', 'suite', 'coverage', suite, '--file', source, '--data-dir', f.directory, '--json'])
  expect(result.code, result.err).toBe(0); expect(result.report.summary.routesWithSelections).toBe(3)
  expect(JSON.stringify(result.report)).not.toContain('PRIVATE_')
  const reopened = await LocalRuntime.open({ dataDirectory: f.directory }); close.push(() => reopened.close())
  expect(await Promise.all(f.prepared.suite.entries.map(entry => reopened.events(entry.runId)))).toEqual(events)
  const help = await cli(['help', 'tests', 'suite', 'coverage', '--json'])
  expect(help.code).toBe(0); expect(help.report.variants[0].options.file).toBe('string')
})
it('reads real HTTP owner assessments with immutable instance pins and no workflow replay', async () => {
  const f = await fixture(); await runTestSuite(f.runtime, f.prepared.suite, f.prepared.sha256)
  const events = await Promise.all(f.prepared.suite.entries.map(entry => f.runtime.events(entry.runId)))
  await f.runtime.close()
  const token = randomBytes(32).toString('hex'), service = await startRuntimeService({ token, actor: 'fixture-author', runtime: { dataDirectory: f.directory }, port: 0 })
  close.push(async () => { await service.close(); await service.closed })
  const client = new RuntimeClient(service.url, token), host = createHttpTestSuiteHost(client)
  const report = await testSuiteCoverage(host, f.prepared.suite, f.source)
  expect(report.summary.routesWithSelections).toBe(3); expect(report.summary.observedRuns).toBe(2)
  for (const [index, entry] of f.prepared.suite.entries.entries()) {
    const envelope: any = await client.operation({ operation: 'runs.events', id: entry.runId })
    expect(envelope.result.events).toEqual(events[index]!.map(({ data: _data, ...event }) => event))
  }
  await service.close(); await service.closed
  const reopened = await LocalRuntime.open({ dataDirectory: f.directory }); close.push(() => reopened.close())
  expect(await Promise.all(f.prepared.suite.entries.map(entry => reopened.events(entry.runId)))).toEqual(events)
})

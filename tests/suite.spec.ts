import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import { LocalRuntime, WorkflowRuntimeError, type TestDefinition, type ModelCalls } from '../src/runtime/index.ts'
import { createTestSuite, inspectTestSuite, runTestSuite, testSuiteResult, type TestSuiteHost, type TestSuite, type SuiteEntryResult } from '../src/testing/suite.ts'
import { createHttpTestSuiteHost } from '../src/testing/http.ts'
import { startRuntimeService, RuntimeClient } from '../src/http/index.ts'
import { main } from '../src/cli.ts'
import { PROTOCOL_VERSION } from '../src/capabilities.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
const pin = (t: { id: string; generation: number; sha256: string }) => ({ id: t.id, generation: t.generation, sha256: t.sha256 })
async function fixture(models?: ModelCalls) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-suite-')), runtime = await LocalRuntime.open({ dataDirectory: directory, ...(models ? { models } : {}) })
  cleanup.push(() => runtime.close())
  const project = runtime.editProject({ operation: 'create', yaml: echo, title: 'PRIVATE_PROJECT', actor: 'PRIVATE_ACTOR' })
  const test = (value = 'PRIVATE_INPUT', expectation = value, accepted = true, source = project, status: 'completed' | 'waiting' = 'completed') => {
    const definition: TestDefinition = { title: 'PRIVATE_TEST_TITLE', project: { id: source.id, generation: source.generation, revision: source.acceptedRevision },
      input: source.id === project.id ? value : { message: value }, expectations: status === 'completed'
        ? [{ kind: 'status', value: status }, { kind: 'output-equals', value: expectation }] : [{ kind: 'status', value: status }] }
    const draft = runtime.editTest({ operation: 'create', definition, actor: 'PRIVATE_ACTOR' })
    return accepted ? runtime.editTest({ operation: 'accept', id: draft.id, expectedGeneration: draft.generation, reviewedSha256: draft.sha256, actor: 'PRIVATE_ACTOR' }) : draft
  }
  return { directory, runtime, project, test }
}
const prepare = (tests: ReturnType<typeof pin>[], failurePolicy: 'stop' | 'continue' = 'stop') => createTestSuite({ title: 'Suite fixture', tests, failurePolicy })
async function cli(args: string[]) { let out = '', err = ''; const code = await main(args, { out: value => { out += value }, err: value => { err += value } }); return { code, out, err, value: out ? JSON.parse(out) : undefined } }

it('prepares stable manifests offline; enforces bounds, strict fields and distinct run IDs', () => {
  const p = { id: randomUUID(), generation: 2, sha256: 'a'.repeat(64) }, a = prepare([p, p])
  expect(a.suite.entries[0]!.runId).not.toBe(a.suite.entries[1]!.runId)
  expect(inspectTestSuite(JSON.parse(JSON.stringify(a.suite, null, 2)))).toEqual(a)
  expect(() => inspectTestSuite({ ...a.suite, entries: [a.suite.entries[0], a.suite.entries[0]] })).toThrow()
  expect(() => prepare([])).toThrow(); expect(() => prepare(Array(101).fill(p))).toThrow()
  expect(() => inspectTestSuite({ ...a.suite, input: 'not allowed' })).toThrow()
})
it('checks the reviewed hash before calling a host', async () => {
  const f = await fixture(), p = prepare([pin(f.test())]), read = vi.spyOn(f.runtime, 'testResult')
  await expect(runTestSuite(f.runtime, p.suite, '0'.repeat(64))).rejects.toMatchObject({ code: 'conflict' }); expect(read).not.toHaveBeenCalled()
  expect(f.runtime.list()).toEqual([])
})
it('runs serially, retains independent case/run pins and reconstructs private-free historical results without dispatch', async () => {
  const f = await fixture(), p = prepare([pin(f.test()), pin(f.test('SECOND_PRIVATE_INPUT'))])
  expect((await testSuiteResult(f.runtime, p.suite)).status).toBe('pending'); expect(f.runtime.list()).toEqual([])
  const result = await runTestSuite(f.runtime, p.suite, p.sha256)
  expect(result.status).toBe('passed'); expect(result.entries.map(e => e.observation)).toEqual(['submitted', 'submitted'])
  expect(JSON.stringify(result)).not.toContain('PRIVATE_'); expect(f.runtime.list()).toHaveLength(2)
  const events = await Promise.all(p.suite.entries.map(e => f.runtime.events(e.runId)))
  f.runtime.editProject({ operation: 'rename', id: f.project.id, expectedGeneration: 1, title: 'changed', actor: 'author' })
  const dispatch = vi.spyOn(f.runtime, 'runTest')
  expect((await runTestSuite(f.runtime, p.suite, p.sha256)).status).toBe('passed'); expect(dispatch).not.toHaveBeenCalled()
  expect((await testSuiteResult(f.runtime, p.suite)).entries.map(e => e.result)).toEqual(result.entries.map(e => e.result))
  expect(await Promise.all(p.suite.entries.map(e => f.runtime.events(e.runId)))).toEqual(events)
})
it.each(['draft', 'stale-project', 'wrong-generation', 'wrong-hash'])('refuses the whole batch before execution on later %s preflight failure', async kind => {
  const f = await fixture(), first = f.test(), second = f.test('input', 'input', kind !== 'draft'), p = prepare([pin(first), pin(second)])
  if (kind === 'stale-project') f.runtime.editProject({ operation: 'rename', id: f.project.id, expectedGeneration: 1, title: 'changed', actor: 'author' })
  if (kind === 'wrong-generation') p.suite.entries[1]!.test.generation++
  if (kind === 'wrong-hash') p.suite.entries[1]!.test.sha256 = '0'.repeat(64)
  const reviewed = inspectTestSuite(p.suite), result = await runTestSuite(f.runtime, reviewed.suite, reviewed.sha256)
  expect(result.status).toBe('blocked'); expect(result.entries[1]!.error?.stage).toBe('preflight'); expect(f.runtime.list()).toEqual([])
})
it.each(['stop', 'continue'] as const)('honors reviewed %s policy only for terminal assertion failures', async policy => {
  const f = await fixture(), p = prepare([pin(f.test('input', 'wrong')), pin(f.test())], policy)
  const result = await runTestSuite(f.runtime, p.suite, p.sha256)
  expect(result.status).toBe('failed'); expect(result.entries[0]!.result).toMatchObject({ assessment: 'failed', workflowStatus: 'completed', terminal: true })
  expect(f.runtime.list()).toHaveLength(policy === 'stop' ? 1 : 2)
})
it.each([undefined, 1, 2, 8])('preserves reviewed serial/parallel stop semantics after reopen with concurrency %s', async concurrency => {
  for (const failurePolicy of ['stop', 'continue'] as const) {
    const f = await fixture(), first = f.test('new'), failed = f.test('failed', 'wrong')
    const prepared = createTestSuite({ title: 'Retained failure', failurePolicy, tests: [pin(first), pin(failed)],
      ...(concurrency === undefined ? {} : { concurrency }) })
    const retained = prepared.suite.entries[1]!.runId
    await f.runtime.runTest(pin(failed), retained)
    const before = await f.runtime.events(retained)
    await f.runtime.close()
    const reopened = await LocalRuntime.open({ dataDirectory: f.directory }); cleanup.push(() => reopened.close())
    const dispatch = vi.spyOn(reopened, 'runTest')
    const report = await runTestSuite(reopened, prepared.suite, prepared.sha256)
    expect(report.status).toBe('failed')
    expect(report.entries[1]!.observation).toBe('retained')
    // Serial stop is ordered; parallel stop blocks all new work on a known failure.
    // Both policies skip the retained UUID, and continue admits the missing case.
    const admitted = failurePolicy === 'continue' || (concurrency ?? 1) === 1
    expect(report.entries[0]!.observation).toBe(admitted ? 'submitted' : 'not-observed')
    expect(dispatch).toHaveBeenCalledTimes(admitted ? 1 : 0)
    if (admitted) expect(dispatch.mock.calls[0]![1]).toBe(prepared.suite.entries[0]!.runId)
    expect(reopened.list()).toHaveLength(admitted ? 2 : 1)
    expect(await reopened.events(retained)).toEqual(before)
    dispatch.mockClear()
    expect((await runTestSuite(reopened, prepared.suite, prepared.sha256)).status).toBe('failed')
    expect(dispatch).not.toHaveBeenCalled()
    expect(await reopened.events(retained)).toEqual(before)
  }
})
it('serial CLI preserves ordered stop while observing a later retained failure without replay', async () => {
  const f = await fixture(), first = f.test('new'), failed = f.test('failed', 'wrong')
  const prepared = prepare([pin(first), pin(failed)]), retained = prepared.suite.entries[1]!.runId
  await f.runtime.runTest(pin(failed), retained)
  const before = await f.runtime.events(retained), file = join(f.directory, 'suite.json')
  await writeFile(file, JSON.stringify(prepared.suite)); await f.runtime.close()
  const result = await cli(['tests', 'suite', 'run', file, '--suite-sha256', prepared.sha256, '--data-dir', f.directory])
  expect(result.code).toBe(6); expect(result.value.status).toBe('failed')
  expect(result.value.entries.map((entry: SuiteEntryResult) => entry.observation)).toEqual(['submitted', 'retained'])
  const reopened = await LocalRuntime.open({ dataDirectory: f.directory }); cleanup.push(() => reopened.close())
  expect(reopened.list().map(run => run.id).sort()).toEqual(prepared.suite.entries.map(entry => entry.runId).sort())
  expect(await reopened.events(retained)).toEqual(before)
})
it('stops even at an expected approval wait and only progresses after a separately authorized decision', async () => {
  const f = await fixture(), project = f.runtime.editProject({ operation: 'create', yaml: approval, title: 'approval', actor: 'author' })
  const waiting = f.test('PRIVATE_APPROVAL', '', true, project, 'waiting'), p = prepare([pin(waiting), pin(f.test())], 'continue')
  let result = await runTestSuite(f.runtime, p.suite, p.sha256)
  expect(result.status).toBe('attention'); expect(result.entries[0]!.result).toMatchObject({ assessment: 'passed', workflowStatus: 'waiting', terminal: false })
  expect(f.runtime.list()).toHaveLength(1)
  expect((await runTestSuite(f.runtime, p.suite, p.sha256)).status).toBe('attention'); expect(f.runtime.list()).toHaveLength(1)
  const run = await f.runtime.show(p.suite.entries[0]!.runId); if (run.state.status !== 'waiting') throw Error()
  await f.runtime.decide(run.id, run.state.attempt.id, 'approve', 'explicit-reviewer')
  result = await runTestSuite(f.runtime, p.suite, p.sha256)
  expect(result.status).toBe('failed'); expect(result.entries[0]!.result?.assessment).toBe('failed') // historical expectation was waiting
  expect(result.entries[1]!.result?.assessment).toBe('passed'); expect(f.runtime.list()).toHaveLength(2)
})
it('recovers a lost successful submission response by reading the exact retained run, never resubmitting it', async () => {
  const f = await fixture(), p = prepare([pin(f.test()), pin(f.test())]), original = f.runtime.runTest.bind(f.runtime)
  vi.spyOn(f.runtime, 'runTest').mockImplementationOnce(async (test, id) => { await original(test, id); throw Error('PRIVATE_LOST_RESPONSE') })
  const failed = await runTestSuite(f.runtime, p.suite, p.sha256)
  expect(failed.status).toBe('blocked'); expect(failed.entries[0]!.error).toMatchObject({ stage: 'submission', execution: 'may-have-started; inspect-retained-run' })
  expect(JSON.stringify(failed)).not.toContain('PRIVATE_'); expect(f.runtime.list()).toHaveLength(1)
  vi.restoreAllMocks(); const dispatch = vi.spyOn(f.runtime, 'runTest')
  const retry = await runTestSuite(f.runtime, p.suite, p.sha256)
  expect(retry.status).toBe('passed'); expect(dispatch).toHaveBeenCalledTimes(1); expect(dispatch.mock.calls[0]![1]).toBe(p.suite.entries[1]!.runId)
})
it('rechecks authoring guards between submissions and preserves already completed work on a later conflict', async () => {
  const f = await fixture(), p = prepare([pin(f.test()), pin(f.test())]), original = f.runtime.runTest.bind(f.runtime)
  vi.spyOn(f.runtime, 'runTest').mockImplementationOnce(async (test, id) => {
    const result = await original(test, id); f.runtime.editProject({ operation: 'rename', id: f.project.id, expectedGeneration: 1, title: 'changed', actor: 'author' }); return result
  })
  const result = await runTestSuite(f.runtime, p.suite, p.sha256)
  expect(result.status).toBe('blocked'); expect(result.entries[0]!.result?.assessment).toBe('passed')
  expect(result.entries[1]!.error?.code).toBe('conflict'); expect(f.runtime.list()).toHaveLength(1)
})
it('does not reuse an existing run belonging to a different test', async () => {
  const f = await fixture(), one = f.test(), two = f.test(), p = prepare([pin(two)])
  await f.runtime.runTest(pin(one), p.suite.entries[0]!.runId)
  const dispatch = vi.spyOn(f.runtime, 'runTest'), report = await runTestSuite(f.runtime, p.suite, p.sha256)
  expect(report.status).toBe('blocked'); expect(report.entries[0]!.error?.code).toBe('conflict'); expect(dispatch).not.toHaveBeenCalled()
})
it('clones a reviewed manifest before asynchronous reads so later caller mutation cannot redirect execution', async () => {
  const f = await fixture(), p = prepare([pin(f.test())]), gate = Promise.withResolvers<void>(), original = f.runtime.testResult.bind(f.runtime)
  vi.spyOn(f.runtime, 'testResult').mockImplementationOnce(async id => { await gate.promise; return original(id) })
  const runId = p.suite.entries[0]!.runId, task = runTestSuite(f.runtime, p.suite, p.sha256)
  p.suite.entries[0]!.runId = randomUUID(); gate.resolve()
  expect((await task).entries[0]!.runId).toBe(runId); expect(f.runtime.list().map(r => r.id)).toEqual([runId])
})
it('interrupts between cases without cancelling or abandoning an admitted submission', async () => {
  const f = await fixture(), p = prepare([pin(f.test()), pin(f.test())]), controller = new AbortController(), original = f.runtime.runTest.bind(f.runtime)
  vi.spyOn(f.runtime, 'runTest').mockImplementationOnce(async (test, id) => { controller.abort(); return original(test, id) })
  const result = await runTestSuite(f.runtime, p.suite, p.sha256, { signal: controller.signal })
  expect(result.status).toBe('interrupted'); expect(result.entries[0]!.result?.assessment).toBe('passed'); expect(f.runtime.list()).toHaveLength(1)
})
it('creates and inspects a CLI manifest offline with no-overwrite publication, and rejects changed hashes before storage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jevable-suite-cli-')), selection = join(dir, 'selection.json'), file = join(dir, 'suite.json')
  await writeFile(selection, JSON.stringify({ title: 'Fixture', failurePolicy: 'stop', tests: [{ id: randomUUID(), generation: 2, sha256: 'a'.repeat(64) }] }))
  const created = await cli(['tests', 'suite', 'create', selection, '--output', file]); expect(created.code).toBe(0); expect(created.value.execution).toBe('not-requested')
  const original = await readFile(file, 'utf8')
  expect((await cli(['tests', 'suite', 'create', selection, '--output', file])).code).toBe(1); expect(await readFile(file, 'utf8')).toBe(original)
  expect((await cli(['tests', 'suite', 'inspect', file])).value.sha256).toBe(created.value.sha256)
  expect((await cli(['tests', 'suite', 'run', file, '--suite-sha256', '0'.repeat(64), '--data-dir', join(dir, 'not-created')])).code).toBe(2)
  expect((await readdir(dir)).sort()).toEqual(['selection.json', 'suite.json'])
})
it('executes suites against an explicitly selected service without a second owner and reconstructs results without mutations', async () => {
  const f = await fixture(), p = prepare([pin(f.test()), pin(f.test())]); await f.runtime.close()
  const token = randomBytes(32).toString('hex'), service = await startRuntimeService({ runtime: { dataDirectory: f.directory }, token, actor: 'owner' })
  cleanup.push(async () => { await service.close(); await service.closed })
  const client = new RuntimeClient(service.url, token), host = createHttpTestSuiteHost(client)
  expect((await runTestSuite(host, p.suite, p.sha256)).status).toBe('passed')
  const events = await client.operation({ operation: 'runs.events', id: p.suite.entries[0]!.runId })
  expect((await testSuiteResult(host, p.suite)).status).toBe('passed')
  expect(await client.operation({ operation: 'runs.events', id: p.suite.entries[0]!.runId })).toEqual(events)
})

it('blocks new earlier cases when any retained case still awaits approval', async () => {
  const f = await fixture(), project = f.runtime.editProject({ operation: 'create', yaml: approval, title: 'approval', actor: 'author' })
  const waiting = f.test('wait', '', true, project, 'waiting'), p = prepare([pin(f.test()), pin(waiting)], 'continue')
  await f.runtime.runTest(pin(waiting), p.suite.entries[1]!.runId)
  expect((await runTestSuite(f.runtime, p.suite, p.sha256)).status).toBe('attention')
  expect(f.runtime.list()).toHaveLength(1); expect(f.runtime.list()[0]!.id).toBe(p.suite.entries[1]!.runId)
})
it('rejects forged successful assessments and mismatched saved result identities without submission', async () => {
  const f = await fixture(), test = f.test(), p = prepare([pin(test)]), saved = await f.runtime.runTest(pin(test), p.suite.entries[0]!.runId)
  const dispatch = vi.spyOn(f.runtime, 'runTest')
  vi.spyOn(f.runtime, 'testResult').mockResolvedValueOnce({ ...saved, checks: saved.checks.map(c => ({ ...c, matched: false })) })
  expect((await runTestSuite(f.runtime, p.suite, p.sha256)).status).toBe('blocked'); expect(dispatch).not.toHaveBeenCalled()
})
it('reports uncertain retained intent without calling runTest or accepting a successful-looking assessment', async () => {
  const f = await fixture(), test = f.test(), p = prepare([pin(test), pin(f.test())]), saved = await f.runtime.runTest(pin(test), p.suite.entries[0]!.runId)
  const host: TestSuiteHost = { testCase: id => f.runtime.testCase(id), project: id => f.runtime.project(id), runTest: vi.fn(),
    testResult: async id => {
      if (id !== saved.run.id) throw new WorkflowRuntimeError('not-found')
      return { ...saved, assessment: 'uncertain', terminal: false, workflowStatus: 'executing', run: { ...saved.run, status: 'executing' } }
    } }
  const r = await runTestSuite(host, p.suite, p.sha256)
  expect(r.status).toBe('uncertain'); expect(host.runTest).not.toHaveBeenCalled()
})

it('retains a real unsettled model intent after failure and never redispatches it on suite retry', async () => {
  let calls = 0
  const f = await fixture({ admit() {}, async execute() { calls++; throw Error('PRIVATE_PROVIDER_FAILURE') }, async verify() {} })
  const yaml = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'suite-model', name: 'Suite model' },
    spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
      write: { type: 'llm', config: { provider: 'fixture', model: 'fixture', connection: { mode: 'workspace', id: 'fixture' },
        prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 20, stream: false },
        execution: { timeoutSeconds: 60, maxAttempts: 1 }, historyScope: 'none' } },
      end: { type: 'output', config: { value: '${{ nodes.write.output }}' } } },
      edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }] } })
  const project = f.runtime.editProject({ operation: 'create', title: 'Model case', yaml, actor: 'author' })
  const draft = f.runtime.editTest({ operation: 'create', actor: 'author', definition: { title: 'Uncertain',
    project: { id: project.id, generation: 1, revision: project.acceptedRevision }, input: 'PRIVATE_MODEL_INPUT', expectations: [{ kind: 'status', value: 'completed' }] } })
  const test = f.runtime.editTest({ operation: 'accept', id: draft.id, expectedGeneration: 1, reviewedSha256: draft.sha256, actor: 'author' })
  const p = prepare([pin(test), pin(f.test())], 'continue')
  expect((await runTestSuite(f.runtime, p.suite, p.sha256)).status).toBe('blocked')
  expect((await f.runtime.show(p.suite.entries[0]!.runId)).state.status).toBe('executing')
  const retry = await runTestSuite(f.runtime, p.suite, p.sha256)
  expect(retry.status).toBe('uncertain'); expect(retry.entries[0]!.result?.assessment).toBe('uncertain')
  expect(calls).toBe(1); expect(f.runtime.list()).toHaveLength(1); expect(JSON.stringify(retry)).not.toContain('PRIVATE_')
})

it('concurrent invocations share retained UUIDs and never create extra runs', async () => {
  const f = await fixture(), p = prepare([pin(f.test()), pin(f.test())])
  const results = await Promise.all([runTestSuite(f.runtime, p.suite, p.sha256), runTestSuite(f.runtime, p.suite, p.sha256)])
  expect(results.some(r => r.status === 'passed')).toBe(true)
  expect(f.runtime.list().map(r => r.id).sort()).toEqual(p.suite.entries.map(e => e.runId).sort())
  expect((await testSuiteResult(f.runtime, p.suite)).status).toBe('passed')
})

it('does no host work when interrupted before observation', async () => {
  const f = await fixture(), p = prepare([pin(f.test())]), controller = new AbortController(), read = vi.spyOn(f.runtime, 'testResult')
  controller.abort()
  expect((await runTestSuite(f.runtime, p.suite, p.sha256, { signal: controller.signal })).status).toBe('interrupted')
  expect(read).not.toHaveBeenCalled(); expect(f.runtime.list()).toEqual([])
})

it('refuses a changed HTTP owner during preflight before any test submission', async () => {
  const f = await fixture(), test = f.test(), p = prepare([pin(test)]), instanceId = randomUUID()
  const client = new RuntimeClient('http://127.0.0.1:1', 'a'.repeat(64))
  vi.spyOn(client, 'capabilities').mockResolvedValue({ instanceId, api: { protocol: PROTOCOL_VERSION } })
  const calls = vi.spyOn(client, 'operation').mockImplementation(async command => {
    if (command.operation === 'tests.result') throw new WorkflowRuntimeError('not-found')
    if (command.operation === 'tests.show') return { schemaVersion: 1, instanceId, result: test }
    if (command.operation === 'projects.show') return { schemaVersion: 1, instanceId: randomUUID(), result: f.project }
    throw Error('Unexpected submission')
  })
  const result = await runTestSuite(createHttpTestSuiteHost(client), p.suite, p.sha256)
  expect(result.status).toBe('blocked'); expect(result.entries[0]!.error).toMatchObject({ stage: 'preflight', code: 'conflict' })
  expect(calls.mock.calls.map(([command]) => command.operation)).toEqual(['tests.result', 'tests.show', 'projects.show'])
  expect(f.runtime.list()).toEqual([])
})

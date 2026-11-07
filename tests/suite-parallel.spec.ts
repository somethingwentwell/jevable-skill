import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LocalRuntime, type ModelCalls } from '../src/runtime/index.ts'
import { createTestSuite, inspectTestSuite, runTestSuite, testSuiteResult, type TestSuiteHost } from '../src/testing/suite.ts'
import { createHttpTestSuiteHost } from '../src/testing/http.ts'
import { startRuntimeService, RuntimeClient, RuntimeHttpError } from '../src/http/index.ts'
import { PROTOCOL_VERSION } from '../src/capabilities.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const model = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'parallel-suite', name: 'Suite model' },
  spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
    write: { type: 'llm', config: { provider: 'fixture', model: 'fixture', connection: { mode: 'workspace', id: 'fixture' },
      prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 20, stream: false },
      execution: { timeoutSeconds: 60, maxAttempts: 1 }, historyScope: 'none' } },
    end: { type: 'output', config: { value: '${{ nodes.write.output }}' } } },
    edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }] } })
const pin = (value: { id: string; generation: number; sha256: string }) => ({ id: value.id, generation: value.generation, sha256: value.sha256 })
async function fixture(source = echo, models?: ModelCalls) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-parallel-suite-'))
  const runtime = await LocalRuntime.open({ dataDirectory: directory, ...(models ? { models } : {}) }); cleanup.push(() => runtime.close())
  const project = runtime.editProject({ operation: 'create', yaml: source, title: 'PRIVATE_PROJECT', actor: 'PRIVATE_ACTOR' })
  const test = (input: any = 'PRIVATE_INPUT', expectation: any = input, waiting = false) => {
    const draft = runtime.editTest({ operation: 'create', actor: 'PRIVATE_ACTOR', definition: { title: 'PRIVATE_TEST',
      project: { id: project.id, generation: project.generation, revision: project.acceptedRevision }, input,
      expectations: waiting ? [{ kind: 'status', value: 'waiting' }] : [{ kind: 'status', value: 'completed' }, { kind: 'output-equals', value: expectation }] } })
    return pin(runtime.editTest({ operation: 'accept', id: draft.id, expectedGeneration: 1, reviewedSha256: draft.sha256, actor: 'PRIVATE_ACTOR' }))
  }
  return { runtime, directory, project, test }
}
const suite = (tests: ReturnType<typeof pin>[], concurrency?: number, failurePolicy: 'stop' | 'continue' = 'stop') =>
  createTestSuite({ title: 'Reviewed parallel batch', failurePolicy, tests, ...(concurrency === undefined ? {} : { concurrency }) })

it('preserves omitted-concurrency v1 manifest hashes and pins every explicit concurrency choice', () => {
  const test = { id: randomUUID(), generation: 2, sha256: 'a'.repeat(64) }, created = suite([test])
  expect(created.suite).not.toHaveProperty('concurrency')
  const legacy = { schemaVersion: 1, kind: 'JevableTestSuite', title: created.suite.title,
    failurePolicy: 'stop', entries: created.suite.entries }
  expect(inspectTestSuite(legacy)).toEqual(created)
  for (const concurrency of [1, 2, 8]) {
    const explicit = inspectTestSuite({ ...legacy, concurrency })
    expect(explicit.sha256).not.toBe(created.sha256); expect(explicit.suite.concurrency).toBe(concurrency)
  }
  for (const concurrency of [0, 9, -1, 1.5, '2', null, true]) expect(() => inspectTestSuite({ ...legacy, concurrency })).toThrow('invalid-command')
})

it.each([2, 8])('bounds genuinely concurrent model executions at %i and preserves manifest order on out-of-order completion', async concurrency => {
  const held = new Map<string, () => void>(), active: string[] = [], calls: string[] = []
  let maximum = 0, draining = false, pending: Promise<unknown> | undefined
  const f = await fixture(model, { admit() {}, async verify() {}, async execute(_node, input) {
    const prompt = input.prompt; active.push(prompt); calls.push(prompt); maximum = Math.max(maximum, active.length)
    if (!draining) await new Promise<void>(resolve => held.set(prompt, resolve)); held.delete(prompt); active.splice(active.indexOf(prompt), 1)
    return { output: prompt, usage: { tries: 1 } }
  } })
  cleanup.push(async () => { draining = true; for (const release of held.values()) release(); await pending })
  const count = concurrency + 2, prepared = suite(Array.from({ length: count }, (_, i) => f.test('PRIVATE_' + i)), concurrency)
  const task = runTestSuite(f.runtime, prepared.suite, prepared.sha256); pending = task
  await vi.waitFor(() => expect(held.size).toBe(concurrency))
  expect(calls).toHaveLength(concurrency)
  held.get('PRIVATE_1')!(); await vi.waitFor(() => expect(calls).toHaveLength(concurrency + 1))
  held.get('PRIVATE_0')!(); await vi.waitFor(() => expect(calls).toHaveLength(count))
  for (const release of held.values()) release()
  const result = await task
  expect(maximum).toBe(concurrency); expect(result.status).toBe('passed'); expect(result.concurrency).toBe(concurrency)
  expect(result.entries.map(e => e.runId)).toEqual(prepared.suite.entries.map(e => e.runId))
  expect(result.entries.every(e => e.result?.assessment === 'passed')).toBe(true)
  expect(JSON.stringify(result)).not.toContain('PRIVATE_')
  const before = await Promise.all(result.entries.map(e => f.runtime.events(e.runId)))
  expect((await runTestSuite(f.runtime, prepared.suite, prepared.sha256)).status).toBe('passed')
  expect(calls).toHaveLength(count)
  expect(await Promise.all(result.entries.map(e => f.runtime.events(e.runId)))).toEqual(before)
})

it.each(['stop', 'continue'] as const)('uses %s policy for parallel assertion failure without cancelling already admitted work', async policy => {
  const f = await fixture(), prepared = suite([f.test('bad', 'wrong'), f.test('second'), f.test('third')], 2, policy)
  const original = f.runtime.runTest.bind(f.runtime), gate = Promise.withResolvers<void>()
  let admitted = 0, returned = false
  vi.spyOn(f.runtime, 'runTest').mockImplementation(async (test, id) => {
    const order = ++admitted; if (order === 2) await gate.promise; return original(test, id)
  })
  cleanup.push(async () => { gate.resolve() })
  const task = runTestSuite(f.runtime, prepared.suite, prepared.sha256).then(result => { returned = true; return result })
  await vi.waitFor(() => expect(admitted).toBe(policy === 'stop' ? 2 : 3))
  expect(returned).toBe(false); gate.resolve()
  const result = await task; expect(result.status).toBe('failed')
  expect(result.entries[1]!.result?.assessment).toBe('passed')
  expect(result.entries[2]!.observation).toBe(policy === 'stop' ? 'not-observed' : 'submitted')
})

it('blocks all new parallel admissions when a historical terminal failure is already known', async () => {
  const f = await fixture(), tests = [f.test('new'), f.test('failed', 'wrong')], prepared = suite(tests, 2)
  await f.runtime.runTest(tests[1]!, prepared.suite.entries[1]!.runId)
  const dispatch = vi.spyOn(f.runtime, 'runTest')
  expect((await runTestSuite(f.runtime, prepared.suite, prepared.sha256)).status).toBe('failed'); expect(dispatch).not.toHaveBeenCalled()
})

it('stops parallel admission on a matching approval wait without approving, abandoning or replaying peers', async () => {
  const f = await fixture(approval), prepared = suite([f.test({ message: 'PRIVATE_FIRST' }, undefined, true),
    f.test({ message: 'PRIVATE_SECOND' }, undefined, true), f.test({ message: 'PRIVATE_THIRD' }, undefined, true)], 2, 'continue')
  const first = await runTestSuite(f.runtime, prepared.suite, prepared.sha256)
  expect(first.status).toBe('attention'); expect(first.entries.filter(e => e.observation === 'submitted')).toHaveLength(2)
  expect(first.entries[2]!.observation).toBe('not-observed')
  const dispatch = vi.spyOn(f.runtime, 'runTest')
  expect((await runTestSuite(f.runtime, prepared.suite, prepared.sha256)).status).toBe('attention'); expect(dispatch).not.toHaveBeenCalled()
  expect(f.runtime.list()).toHaveLength(2)
})

it('awaits peers after response loss and reconstructs committed work without resubmitting their UUIDs', async () => {
  const f = await fixture(), prepared = suite([f.test('one'), f.test('two'), f.test('three')], 2, 'continue')
  const original = f.runtime.runTest.bind(f.runtime), gate = Promise.withResolvers<void>()
  let admitted = 0
  vi.spyOn(f.runtime, 'runTest').mockImplementation(async (test, id) => {
    const order = ++admitted
    if (order === 2) await gate.promise
    const result = await original(test, id)
    if (order === 1) throw new RuntimeHttpError('transport-uncertain')
    return result
  })
  cleanup.push(async () => { gate.resolve() })
  const task = runTestSuite(f.runtime, prepared.suite, prepared.sha256)
  await vi.waitFor(() => expect(admitted).toBe(2)); gate.resolve()
  const blocked = await task; expect(blocked.status).toBe('blocked'); expect(blocked.entries[1]!.result?.assessment).toBe('passed')
  expect(blocked.entries[2]!.observation).toBe('not-observed'); expect(f.runtime.list()).toHaveLength(2)
  vi.restoreAllMocks(); const dispatch = vi.spyOn(f.runtime, 'runTest')
  expect((await runTestSuite(f.runtime, prepared.suite, prepared.sha256)).status).toBe('passed')
  expect(dispatch).toHaveBeenCalledTimes(1); expect(dispatch.mock.calls[0]![1]).toBe(prepared.suite.entries[2]!.runId)
})

it('interrupts parallel admission but still awaits every in-flight call without workflow cancellation', async () => {
  const f = await fixture(), prepared = suite([f.test(), f.test(), f.test()], 2), controller = new AbortController()
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()], original = f.runtime.runTest.bind(f.runtime)
  let admitted = 0, returned = false
  vi.spyOn(f.runtime, 'runTest').mockImplementation(async (test, id) => { const index = admitted++; await gates[index]!.promise; return original(test, id) })
  cleanup.push(async () => { gates.forEach(g => g.resolve()) })
  const task = runTestSuite(f.runtime, prepared.suite, prepared.sha256, { signal: controller.signal }).then(r => { returned = true; return r })
  await vi.waitFor(() => expect(admitted).toBe(2)); controller.abort(); gates[0]!.resolve()
  await vi.waitFor(() => expect(f.runtime.list()).toHaveLength(1)); expect(returned).toBe(false)
  gates[1]!.resolve(); const result = await task
  expect(result.status).toBe('interrupted'); expect(admitted).toBe(2); expect(f.runtime.list()).toHaveLength(2)
  expect(result.entries[2]!.observation).toBe('not-observed')
})

it('does no dispatch on any later parallel preflight error, and refuses concurrency changes under an old review hash', async () => {
  const f = await fixture(), test = f.test(), prepared = suite([test, { ...test, generation: test.generation + 1 }], 8)
  const dispatch = vi.spyOn(f.runtime, 'runTest')
  expect((await runTestSuite(f.runtime, prepared.suite, prepared.sha256)).status).toBe('blocked'); expect(dispatch).not.toHaveBeenCalled()
  await expect(runTestSuite(f.runtime, { ...prepared.suite, concurrency: 2 }, prepared.sha256)).rejects.toMatchObject({ code: 'conflict' })
})

it('pins HTTP owner before the first operation and refuses rebinding, including concurrent bootstrap', async () => {
  const client = new RuntimeClient('http://127.0.0.1:1', 'a'.repeat(64)), instanceId = randomUUID(), gate = Promise.withResolvers<void>()
  const cap = vi.spyOn(client, 'capabilities').mockImplementation(async () => { await gate.promise; return { instanceId, api: { protocol: PROTOCOL_VERSION } } })
  const pinned = vi.spyOn(client, 'pinInstance'), operation = vi.spyOn(client, 'operation').mockResolvedValue({ schemaVersion: 1, instanceId, result: {} })
  const host = createHttpTestSuiteHost(client), a = host.testResult(randomUUID()), b = host.testCase(randomUUID())
  expect(operation).not.toHaveBeenCalled(); gate.resolve(); await Promise.all([a, b])
  expect(cap).toHaveBeenCalledTimes(1); expect(pinned).toHaveBeenCalledWith(instanceId)
  expect(pinned.mock.invocationCallOrder[0]!).toBeLessThan(operation.mock.invocationCallOrder[0]!)
  expect(() => client.pinInstance(randomUUID())).toThrow('conflict')
  expect(() => client.pinInstance('PRIVATE_INVALID_OWNER')).toThrow('invalid-config')
})

it('fails a malformed bootstrap closed without operations or automatic retry', async () => {
  const client = new RuntimeClient('http://127.0.0.1:1', 'a'.repeat(64)), cap = vi.spyOn(client, 'capabilities').mockResolvedValue({ instanceId: randomUUID() })
  const operation = vi.spyOn(client, 'operation'), host = createHttpTestSuiteHost(client)
  await expect(host.testResult(randomUUID())).rejects.toMatchObject({ code: 'invalid-response' })
  await expect(host.testResult(randomUUID())).rejects.toMatchObject({ code: 'invalid-response' })
  expect(cap).toHaveBeenCalledTimes(1); expect(operation).not.toHaveBeenCalled()
})

it('refuses a real replacement owner before parallel test mutations, preserving a clean replacement namespace', async () => {
  const f = await fixture(), prepared = suite([f.test(), f.test()], 2); await f.runtime.close()
  const token = 'a'.repeat(64), first = await startRuntimeService({ token, actor: 'owner', runtime: { dataDirectory: f.directory } })
  cleanup.push(async () => { await first.close(); await first.closed })
  const host = createHttpTestSuiteHost(new RuntimeClient(first.url, token))
  expect((await testSuiteResult(host, prepared.suite)).status).toBe('pending')
  await first.close(); await first.closed
  const replacement = await startRuntimeService({ token, actor: 'owner', port: first.listener.port, runtime: { dataDirectory: f.directory } })
  cleanup.push(async () => { await replacement.close(); await replacement.closed })
  const result = await runTestSuite(host, prepared.suite, prepared.sha256)
  expect(result.status).toBe('blocked'); expect(result.entries[0]!.error?.code).toBe('instance-mismatch')
  await replacement.close(); await replacement.closed
  const retained = await LocalRuntime.open({ dataDirectory: f.directory }); cleanup.push(() => retained.close())
  expect(retained.list()).toEqual([])
})

it('refuses replacement after all parallel preflight reads before either new run can be created', async () => {
  const f = await fixture(), prepared = suite([f.test(), f.test()], 2); await f.runtime.close()
  const token = 'a'.repeat(64)
  let service = await startRuntimeService({ token, actor: 'owner', runtime: { dataDirectory: f.directory } })
  cleanup.push(async () => { await service.close(); await service.closed })
  const host = createHttpTestSuiteHost(new RuntimeClient(service.url, token)), project = host.project
  let reads = 0, replaced = false
  host.project = async id => {
    const value = await project(id)
    if (++reads === 2) {
      const port = service.listener.port; await service.close(); await service.closed
      service = await startRuntimeService({ token, actor: 'owner', port, runtime: { dataDirectory: f.directory } }); replaced = true
    }
    return value
  }
  const result = await runTestSuite(host, prepared.suite, prepared.sha256)
  expect(replaced).toBe(true); expect(result.status).toBe('blocked')
  expect(result.entries.every(e => e.error?.stage === 'submission' && e.error.code === 'instance-mismatch')).toBe(true)
  await service.close(); await service.closed
  const retained = await LocalRuntime.open({ dataDirectory: f.directory }); cleanup.push(() => retained.close())
  expect(retained.list()).toEqual([])
})

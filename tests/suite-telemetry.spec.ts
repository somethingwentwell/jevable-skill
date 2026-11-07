import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalRuntime, type TestDefinition, type ModelCalls } from '../src/runtime/index.ts'
import { capabilities } from '../src/capabilities.ts'
import { createTestSuite, runTestSuite, testSuiteResult } from '../src/testing/suite.ts'
import { main } from '../src/cli.ts'
import { fields, logRecords, metricSums } from '../scripts/check-telemetry-package.mjs'
import { traceRecords } from '../scripts/check-postgres-telemetry.mjs'

const parent = '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01'
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const labels = ['jevable.suite.failure_policy', 'jevable.suite.mode', 'jevable.suite.outcome']
const pin = (test: { id: string; generation: number; sha256: string }) => ({ id: test.id, generation: test.generation, sha256: test.sha256 })
function caseCounts(wire: Awaited<ReturnType<typeof receiver>>, waiting: number, running: number, settled: number, policy = 'continue') {
  const active = wire.sums().filter(m => m.name === 'jevable.test.suite.cases.active').at(-1)!
  expect(active.temporality).toBe(2)
  expect(active.points.toSorted((a, b) => String(a.labels['jevable.suite.case.phase']).localeCompare(String(b.labels['jevable.suite.case.phase'])))).toEqual([
    { value: running, labels: { 'jevable.suite.failure_policy': policy, 'jevable.suite.case.phase': 'running' } },
    { value: waiting, labels: { 'jevable.suite.failure_policy': policy, 'jevable.suite.case.phase': 'waiting' } },
  ])
  const finished = wire.sums().filter(m => m.name === 'jevable.test.suite.cases.settled').at(-1)
  if (settled === 0) expect(finished).toBeUndefined()
  else expect(finished!.points).toEqual([{ value: settled, labels: { 'jevable.suite.failure_policy': policy } }])
}
async function receiver(sampleRatio = 1, replyCode = 200) {
  const packets: { path: string; bytes: Buffer }[] = [], providerHeaders: { baggage: unknown; traceparent: unknown }[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk)
    if (request.url === '/v1/chat/completions') {
      providerHeaders.push({ baggage: request.headers.baggage, traceparent: request.headers.traceparent })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'PRIVATE_MODEL_OUTPUT' } }] }))
      return
    }
    expect(request.headers.baggage).toBeUndefined()
    expect(request.headers['content-type']).toBe('application/x-protobuf')
    packets.push({ path: request.url!, bytes: Buffer.concat(chunks) })
    response.writeHead(replyCode, { 'content-type': 'application/x-protobuf' }); response.end()
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No private listener')
  const base = `http://127.0.0.1:${address.port}`
  const config = { endpoint: base + '/v1/traces', metricsEndpoint: base + '/v1/metrics', logsEndpoint: base + '/v1/logs', sampleRatio,
    authentication: { kind: 'none' as const }, intervalMs: 60000, timeoutMs: 1000, flushTimeoutMs: 2000, baggageKeys: ['request.class'] }
  return { base, config, packets, providerHeaders,
    traces: () => packets.filter(p => p.path === '/v1/traces').flatMap(p => traceRecords(p.bytes)),
    logs: () => packets.filter(p => p.path === '/v1/logs').flatMap(p => logRecords(p.bytes)),
    sums: () => packets.filter(p => p.path === '/v1/metrics').flatMap(p => metricSums(p.bytes)),
  }
}
async function owner(telemetry?: Parameters<typeof LocalRuntime.open>[0]['telemetry'], models?: ModelCalls) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-suite-signals-'))
  const runtime = await LocalRuntime.open({ dataDirectory: directory, ...(telemetry ? { telemetry } : {}), ...(models ? { models } : {}) })
  cleanup.push(() => runtime.close())
  const create = (yaml: string, definition: Pick<TestDefinition, 'input' | 'expectations'>, accepted = true) => {
    const project = runtime.editProject({ operation: 'create', yaml, title: 'PRIVATE_PROJECT', actor: 'PRIVATE_ACTOR' })
    const draft = runtime.editTest({ operation: 'create', actor: 'PRIVATE_ACTOR', definition: { title: 'PRIVATE_CASE', ...definition,
      project: { id: project.id, generation: project.generation, revision: project.acceptedRevision } } })
    return accepted ? runtime.editTest({ operation: 'accept', id: draft.id, expectedGeneration: draft.generation, reviewedSha256: draft.sha256, actor: 'PRIVATE_ACTOR' }) : draft
  }
  const test = (expected = 'PRIVATE_INPUT', accepted = true) => create(echo, { input: 'PRIVATE_INPUT', expectations: [{ kind: 'status', value: 'completed' }, { kind: 'output-equals', value: expected }] }, accepted)
  return { directory, runtime, test, create }
}
// Fixture-only independent OTLP histogram reader; never imports the runtime serializer.
function durations(packets: { path: string; bytes: Buffer }[]) {
  return packets.filter(p => p.path === '/v1/metrics').flatMap(p => (fields(p.bytes).get(1) ?? []).flatMap(resource =>
    (fields(resource).get(2) ?? []).flatMap(scope => (fields(scope).get(2) ?? []).flatMap(bytes => {
      const metric = fields(bytes)
      if (metric.get(1)![0].toString() !== 'jevable.test.suite.duration') return []
      expect(metric.get(3)![0].toString()).toBe('s')
      const histogram = fields(metric.get(9)![0]); expect(histogram.get(2)).toEqual([2n])
      return (histogram.get(1) ?? []).map(bytes => {
        const point = fields(bytes), count = Number(point.get(4)![0].readBigUInt64LE()), sum = point.get(5)![0].readDoubleLE()
        const buckets = (point.get(6) ?? []).flatMap(buffer => Array.from({ length: buffer.length / 8 }, (_, i) => Number(buffer.readBigUInt64LE(i * 8))))
        const bounds = (point.get(7) ?? []).flatMap(buffer => Array.from({ length: buffer.length / 8 }, (_, i) => buffer.readDoubleLE(i * 8)))
        expect(bounds).toEqual([.001, .01, .1, .5, 1, 5, 10, 30, 60, 300, 3600])
        expect(buckets).toHaveLength(12); expect(buckets.reduce((a, b) => a + b, 0)).toBe(count)
        expect(Number.isFinite(sum) && sum >= 0).toBe(true); expect(point.has(8)).toBe(false)
        const attributes = Object.fromEntries((point.get(9) ?? []).map(bytes => { const kv = fields(bytes); return [kv.get(1)![0].toString(), fields(kv.get(2)![0]).get(1)![0].toString()] }))
        expect(Object.keys(attributes).sort()).toEqual(labels)
        return { count, sum, labels: attributes }
      })
    }))))
}
it.each([0, 1].flatMap(sampleRatio => [1, 2].map(concurrency => ({ sampleRatio, concurrency }))))('records serial/parallel invocation ancestry, unsampled signals, and no replay ($sampleRatio/$concurrency)', async ({ sampleRatio, concurrency }) => {
  const wire = await receiver(sampleRatio), f = await owner(wire.config)
  const suite = createTestSuite({ title: 'PRIVATE_SUITE_TITLE', failurePolicy: 'continue', concurrency, tests: [pin(f.test()), pin(f.test())] })
  expect((await testSuiteResult(f.runtime, suite.suite)).status).toBe('pending')
  const result = await f.runtime.withTraceContext({ traceparent: parent, baggage: 'request.class=PRIVATE_BAGGAGE' }, () => runTestSuite(f.runtime, suite.suite, suite.sha256))
  expect(result.status).toBe('passed'); await f.runtime.telemetryFlush()
  const firstLogs = wire.logs(), invocation = firstLogs.find(log => log.event === 'jevable.test.suite.ended' && log.attributes['jevable.suite.mode'] === 'run')!
  expect(invocation.attributes).toMatchObject({ 'jevable.suite.sha256': suite.sha256, 'jevable.suite.entries': 2, 'jevable.suite.concurrency': concurrency, 'jevable.suite.outcome': 'passed' })
  expect(invocation).toMatchObject({ traceId: '1'.repeat(32), severity: 9, body: 'jevable.test.suite.ended' })
  expect(invocation.spanId).toMatch(/^[a-f0-9]{16}$/u)
  const retained = await Promise.all(suite.suite.entries.map(entry => f.runtime.show(entry.runId)))
  const events = await Promise.all(suite.suite.entries.map(entry => f.runtime.events(entry.runId)))
  for (const run of retained) expect(run.traceSegments![0]).toMatchObject({ parent: { traceId: invocation.traceId, spanId: invocation.spanId }, trace: { traceFlags: sampleRatio } })
  if (sampleRatio) {
    const spans = wire.traces(), observed = spans.find(s => s.spanId === invocation.spanId)!
    expect(observed).toMatchObject({ name: 'jevable.test.suite', parent: '2'.repeat(16) })
    expect(spans.filter(s => s.name === 'jevable.run')).toHaveLength(2)
    for (const run of retained) expect(spans.find(s => s.spanId === run.traceSegments![0]!.trace.spanId)).toMatchObject({ parent: invocation.spanId })
  } else expect(wire.traces()).toEqual([])
  const executionLogCount = wire.logs().filter(l => l.event !== 'jevable.test.suite.ended').length
  const executionSpanCount = wire.traces().filter(s => s.name !== 'jevable.test.suite').length
  const dispatch = vi.spyOn(f.runtime, 'runTest')
  expect((await runTestSuite(f.runtime, suite.suite, suite.sha256)).entries.map(e => e.observation)).toEqual(['retained', 'retained'])
  expect((await testSuiteResult(f.runtime, suite.suite)).status).toBe('passed')
  await f.runtime.telemetryFlush()
  expect(dispatch).not.toHaveBeenCalled(); expect(f.runtime.list()).toHaveLength(2)
  expect(await Promise.all(suite.suite.entries.map(entry => f.runtime.events(entry.runId)))).toEqual(events)
  expect(await Promise.all(suite.suite.entries.map(entry => f.runtime.show(entry.runId)))).toEqual(retained)
  expect(wire.logs().filter(l => l.event !== 'jevable.test.suite.ended')).toHaveLength(executionLogCount)
  expect(wire.traces().filter(s => s.name !== 'jevable.test.suite')).toHaveLength(executionSpanCount)
  expect(wire.logs().filter(l => l.event === 'jevable.test.suite.ended')).toHaveLength(4)
  const counter = wire.sums().filter(m => m.name === 'jevable.test.suite.invocations').at(-1)!
  expect(counter.points.reduce((a, p) => a + p.value, 0)).toBe(4)
  for (const point of counter.points) expect(Object.keys(point.labels).sort()).toEqual(labels)
  const histograms = durations(wire.packets), latest = histograms.slice(-counter.points.length)
  expect(latest.reduce((a, p) => a + p.count, 0)).toBe(4)
  for (const packet of wire.packets) expect(packet.bytes.toString()).not.toContain('PRIVATE_')
})
it.each(['failed', 'attention', 'blocked', 'interrupted'] as const)('reports %s without confusing assertions with workflow completion', async expected => {
  const wire = await receiver(), f = await owner(wire.config)
  const test = expected === 'attention' ? f.create(approval, { input: { message: 'PRIVATE_APPROVAL' }, expectations: [{ kind: 'status', value: 'waiting' }] })
    : f.test(expected === 'failed' ? 'PRIVATE_WRONG_OUTPUT' : 'PRIVATE_INPUT', expected !== 'blocked')
  const suite = createTestSuite({ title: 'PRIVATE_SUITE', failurePolicy: 'stop', tests: [pin(test)] })
  const abort = new AbortController(); if (expected === 'interrupted') abort.abort()
  const result = await runTestSuite(f.runtime, suite.suite, suite.sha256, { signal: abort.signal }); expect(result.status).toBe(expected)
  if (expected === 'failed') expect(result.entries[0]!.result).toMatchObject({ workflowStatus: 'completed', assessment: 'failed', terminal: true })
  if (expected === 'attention') expect(result.entries[0]!.result).toMatchObject({ workflowStatus: 'waiting', assessment: 'passed', terminal: false })
  if (['blocked', 'interrupted'].includes(expected)) expect(f.runtime.list()).toEqual([])
  await f.runtime.telemetryFlush()
  if (['failed', 'attention'].includes(expected)) caseCounts(wire, 0, 0, 1, 'stop')
  else expect(wire.sums().filter(m => m.name.startsWith('jevable.test.suite.cases.'))).toEqual([])
  const log = wire.logs().find(l => l.event === 'jevable.test.suite.ended')!
  expect(log.attributes['jevable.suite.outcome']).toBe(expected); expect(log.severity).toBe(['failed', 'blocked'].includes(expected) ? 17 : 9)
  expect(wire.sums().filter(m => m.name === 'jevable.test.suite.invocations').at(-1)!.points).toEqual([{ value: 1, labels: { 'jevable.suite.mode': 'run', 'jevable.suite.failure_policy': 'stop', 'jevable.suite.outcome': expected } }])
  for (const packet of wire.packets) expect(packet.bytes.toString()).not.toContain('PRIVATE_')
})
it('keeps telemetry entirely optional and refuses observations on a closed owner', async () => {
  const f = await owner(), suite = createTestSuite({ title: 'No exporter', failurePolicy: 'stop', tests: [pin(f.test())] })
  expect(f.runtime.observeTestSuite({ sha256: suite.sha256, entries: 1, concurrency: 1, mode: 'run', failurePolicy: 'stop' })).toBeUndefined()
  expect((await runTestSuite(f.runtime, suite.suite, suite.sha256)).status).toBe('passed')
  expect((await f.runtime.show(suite.suite.entries[0]!.runId)).traceSegments).toBeUndefined()
  const wire = await receiver(), configured = await owner(wire.config); await configured.runtime.close()
  expect(configured.runtime.observeTestSuite({ sha256: suite.sha256, entries: 1, concurrency: 1, mode: 'run', failurePolicy: 'stop' })).toBeUndefined()
  expect(wire.packets).toEqual([])
})
it('export refusal does not alter reports, repeat submissions or retry telemetry packets', async () => {
  const wire = await receiver(1, 503), f = await owner(wire.config), suite = createTestSuite({ title: 'Fixture', failurePolicy: 'stop', tests: [pin(f.test())] })
  expect((await runTestSuite(f.runtime, suite.suite, suite.sha256)).status).toBe('passed'); await f.runtime.telemetryFlush()
  expect(wire.packets).toHaveLength(3); const old = wire.packets.map(p => p.bytes.toString('hex'))
  await f.runtime.telemetryFlush(); expect(wire.packets.map(p => p.bytes.toString('hex'))).toEqual(old)
  const dispatch = vi.spyOn(f.runtime, 'runTest')
  expect((await runTestSuite(f.runtime, suite.suite, suite.sha256)).status).toBe('passed'); expect(dispatch).not.toHaveBeenCalled()
  expect(f.runtime.list()).toHaveLength(1)
})
it('does not end an interrupted parallel invocation until every admitted peer settles', async () => {
  const wire = await receiver(), f = await owner(wire.config)
  const suite = createTestSuite({ title: 'PRIVATE_SUITE', failurePolicy: 'continue', concurrency: 2, tests: [pin(f.test()), pin(f.test()), pin(f.test())] })
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()], controller = new AbortController(), original = f.runtime.runTest.bind(f.runtime)
  const admitted: string[] = []
  vi.spyOn(f.runtime, 'runTest').mockImplementation(async (test, id) => {
    const index = admitted.length; admitted.push(id)
    await gates[index]!.promise; return original(test, id)
  })
  let returned = false
  const invocation = runTestSuite(f.runtime, suite.suite, suite.sha256, { signal: controller.signal }).then(result => { returned = true; return result })
  await vi.waitFor(() => expect(admitted).toHaveLength(2))
  await f.runtime.telemetryFlush(); caseCounts(wire, 1, 2, 0)
  controller.abort(); await f.runtime.telemetryFlush()
  caseCounts(wire, 0, 2, 0)
  expect(wire.logs().filter(l => l.event === 'jevable.test.suite.ended')).toEqual([])
  gates[0]!.resolve(); await vi.waitFor(() => expect(f.runtime.list()).toHaveLength(1))
  expect(returned).toBe(false); await f.runtime.telemetryFlush()
  caseCounts(wire, 0, 1, 1)
  expect(wire.logs().filter(l => l.event === 'jevable.test.suite.ended')).toEqual([])
  gates[1]!.resolve(); const report = await invocation
  expect(report.status).toBe('interrupted'); expect(admitted).toHaveLength(2); expect(f.runtime.list()).toHaveLength(2)
  expect(report.entries[2]!.observation).toBe('not-observed')
  await f.runtime.telemetryFlush()
  caseCounts(wire, 0, 0, 2)
  expect(wire.logs().filter(l => l.event === 'jevable.test.suite.ended')).toHaveLength(1)
  expect(wire.logs().find(l => l.event === 'jevable.test.suite.ended')!.attributes['jevable.suite.outcome']).toBe('interrupted')
  expect((await testSuiteResult(f.runtime, suite.suite)).status).toBe('pending')
  await f.runtime.telemetryFlush(); caseCounts(wire, 0, 0, 2)
  for (const packet of wire.packets) expect(packet.bytes.toString()).not.toContain('PRIVATE_')
})
it('records blocked submission then uncertain retained inspection without another model call', async () => {
  const wire = await receiver(), execute = vi.fn(async () => { throw Error('PRIVATE_MODEL_FAILURE') })
  const f = await owner(wire.config, { admit() {}, execute, async verify() {} })
  const yaml = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'uncertain-suite', name: 'Uncertain model' },
    spec: { inputSchema: { type: 'string' }, nodes: {
      start: { type: 'trigger', config: { modes: ['manual'] } },
      model: { type: 'llm', config: { provider: 'fixture', model: 'fixture-model', connection: { mode: 'workspace', id: 'fixture' },
        prompt: '${{ inputs }}', responseFormat: 'text', historyScope: 'none', generation: { maxTokens: 30, stream: false }, execution: { maxAttempts: 1, timeoutSeconds: 3 } } },
      end: { type: 'output', config: { value: '${{ nodes.model.output }}' } },
    }, edges: [{ from: 'start', to: 'model' }, { from: 'model', to: 'end' }] } })
  const test = f.create(yaml, { input: 'PRIVATE_INPUT', expectations: [{ kind: 'status', value: 'completed' }] })
  const suite = createTestSuite({ title: 'PRIVATE_SUITE', failurePolicy: 'continue', tests: [pin(test), pin(f.test())] })
  expect((await runTestSuite(f.runtime, suite.suite, suite.sha256)).status).toBe('blocked')
  const events = await f.runtime.events(suite.suite.entries[0]!.runId)
  expect((await testSuiteResult(f.runtime, suite.suite)).status).toBe('uncertain')
  expect((await runTestSuite(f.runtime, suite.suite, suite.sha256)).status).toBe('uncertain')
  expect(execute).toHaveBeenCalledTimes(1); expect(f.runtime.list()).toHaveLength(1)
  expect(await f.runtime.events(suite.suite.entries[0]!.runId)).toEqual(events)
  await f.runtime.telemetryFlush()
  expect(wire.logs().filter(l => l.event === 'jevable.test.suite.ended').map(l => [l.attributes['jevable.suite.outcome'], l.severity])).toEqual([['blocked', 17], ['uncertain', 17], ['uncertain', 17]])
  caseCounts(wire, 0, 0, 1)
  for (const packet of wire.packets) expect(packet.bytes.toString()).not.toContain('PRIVATE_')
})
it('aggregates overlapping suites without clearing another invocation and never counts retained cases again', async () => {
  const wire = await receiver(), f = await owner(wire.config)
  const suites = [0, 1].map(() => createTestSuite({ title: 'PRIVATE_SUITE', failurePolicy: 'continue', tests: [pin(f.test()), pin(f.test())] }))
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()], original = f.runtime.runTest.bind(f.runtime)
  const admitted: string[] = []
  vi.spyOn(f.runtime, 'runTest').mockImplementation(async (test, id) => {
    const index = admitted.length; admitted.push(id)
    if (index < 2) await gates[index]!.promise
    return original(test, id)
  })
  const tasks = suites.map(suite => runTestSuite(f.runtime, suite.suite, suite.sha256))
  cleanup.push(async () => { gates.forEach(g => g.resolve()); await Promise.allSettled(tasks) })
  await vi.waitFor(() => expect(admitted).toHaveLength(2))
  await f.runtime.telemetryFlush(); caseCounts(wire, 2, 2, 0)
  gates[0]!.resolve(); expect((await tasks[0]!).status).toBe('passed')
  await f.runtime.telemetryFlush(); caseCounts(wire, 1, 1, 2)
  gates[1]!.resolve(); expect((await tasks[1]!).status).toBe('passed')
  await f.runtime.telemetryFlush(); caseCounts(wire, 0, 0, 4)
  const dispatched = admitted.length
  for (const suite of suites) {
    expect((await runTestSuite(f.runtime, suite.suite, suite.sha256)).status).toBe('passed')
    expect((await testSuiteResult(f.runtime, suite.suite)).status).toBe('passed')
  }
  await f.runtime.telemetryFlush(); caseCounts(wire, 0, 0, 4)
  expect(admitted).toHaveLength(dispatched)
  for (const packet of wire.packets) expect(packet.bytes.toString()).not.toContain('PRIVATE_')
})
it('discovers the actual suite instruments and preserves the remote-client boundary', () => {
  const support = capabilities().workflowRuntime.savedTests.suiteTelemetry
  expect(support.hosts).toEqual(['owned-sdk', 'direct-local-cli', 'http-client', 'selected-owner-client']); expect(support.clientAdapters).toBe(true)
  expect(support.metrics).toEqual(['jevable.test.suite.invocations', 'jevable.test.suite.duration'])
  expect(support.metricLabels.toSorted()).toEqual(labels)
})
it.each([0, 1])('local CLI uses one suite scope and preserves explicitly admitted provider baggage (%s)', async sampleRatio => {
  const wire = await receiver(sampleRatio), f = await owner()
  f.runtime.configureConnection({ id: 'fixture', provider: 'fixture', protocol: 'openai-compatible', endpoint: wire.base + '/v1', allowedModels: ['fixture-model'],
    authentication: { kind: 'none' }, tokenParameter: 'max_tokens', maxResponseBytes: 10000, maxRequestBytes: 10000, maxStreamEvents: 100,
    maxTimeoutSeconds: 5, tracePropagation: 'w3c', baggageKeys: ['request.class'] }, 0, 'PRIVATE_ACTOR')
  const yaml = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'suite-model', name: 'Model fixture' },
    spec: { inputSchema: { type: 'string' }, nodes: {
      start: { type: 'trigger', config: { modes: ['manual'] } },
      model: { type: 'llm', config: { provider: 'fixture', model: 'fixture-model', connection: { mode: 'workspace', id: 'fixture' },
        prompt: '${{ inputs }}', responseFormat: 'text', historyScope: 'none', generation: { maxTokens: 30, stream: false }, execution: { maxAttempts: 1, timeoutSeconds: 3 } } },
      end: { type: 'output', config: { value: '${{ nodes.model.output }}' } },
    }, edges: [{ from: 'start', to: 'model' }, { from: 'model', to: 'end' }] } })
  const test = f.create(yaml, { input: 'PRIVATE_INPUT', expectations: [{ kind: 'status', value: 'completed' }, { kind: 'output-equals', value: 'PRIVATE_MODEL_OUTPUT' }] })
  const suite = createTestSuite({ title: 'PRIVATE_SUITE', failurePolicy: 'stop', tests: [pin(test)] })
  const manifest = join(f.directory, 'suite.json'), config = join(f.directory, 'telemetry.json'), context = join(f.directory, 'context.json')
  await writeFile(manifest, JSON.stringify(suite.suite)); await writeFile(config, JSON.stringify(wire.config), { mode: 0o600 })
  await writeFile(context, JSON.stringify({ traceparent: parent, baggage: 'request.class=PRIVATE_BAGGAGE,other=PRIVATE_DROP' }), { mode: 0o600 })
  await f.runtime.close()
  let out = '', err = ''
  const args = ['tests', 'suite', 'run', manifest, '--suite-sha256', suite.sha256, '--data-dir', f.directory, '--telemetry-file', config, '--trace-context-file', context]
  expect(await main(args, { out: value => { out += value }, err: value => { err += value } })).toBe(0)
  expect(JSON.parse(out).status).toBe('passed'); expect(out + err).not.toContain('PRIVATE_')
  expect(wire.providerHeaders).toHaveLength(1)
  expect(wire.providerHeaders[0]).toMatchObject({ baggage: 'request.class=PRIVATE_BAGGAGE', traceparent: expect.stringMatching(new RegExp('^00-1{32}-[a-f0-9]{16}-0' + sampleRatio + '$', 'u')) })
  const log = wire.logs().find(l => l.event === 'jevable.test.suite.ended')!, execution = wire.logs().find(l => l.event === 'jevable.execution.segment.ended')!
  expect(log.traceId).toBe('1'.repeat(32)); expect(execution.traceId).toBe(log.traceId); expect(execution.spanId).not.toBe(log.spanId)
  const reopened = await LocalRuntime.open({ dataDirectory: f.directory }); cleanup.push(() => reopened.close())
  const retained = await reopened.show(suite.suite.entries[0]!.runId)
  expect(retained.traceSegments![0]!.parent).toMatchObject({ traceId: log.traceId, spanId: log.spanId })
  expect(JSON.stringify(await reopened.events(retained.id))).not.toContain('PRIVATE_BAGGAGE')
  await reopened.close(); out = ''; err = ''
  expect(await main(args, { out: value => { out += value }, err: value => { err += value } })).toBe(0)
  expect(wire.providerHeaders).toHaveLength(1)
  if (!sampleRatio) expect(wire.traces()).toEqual([])
  for (const packet of wire.packets) expect(packet.bytes.toString()).not.toContain('PRIVATE_')
})

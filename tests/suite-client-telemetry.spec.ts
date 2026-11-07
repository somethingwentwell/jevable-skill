import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile, link, symlink, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { LocalRuntime } from '../src/runtime/local.ts'
import { startRuntimeService, RuntimeClient } from '../src/http/index.ts'
import { createTestSuite, runTestSuite, testSuiteResult } from '../src/testing/suite.ts'
import { createHttpTestSuiteHost } from '../src/testing/http.ts'
import { createOperationTestSuiteHost } from '../src/testing/operation-host.ts'
import { createTestSuiteTelemetry, parseSuiteTelemetryConfig, type TestSuiteTelemetry } from '../src/testing/telemetry.ts'
import { suiteSelection } from '../src/cli/suite.ts'
import { readSuiteTelemetryOptions } from '../src/cli/suite-telemetry.ts'
import { main } from '../src/cli.ts'
import { PROTOCOL_VERSION } from '../src/capabilities.ts'
import { fields, logRecords, metricSums, resourceAttributes } from '../scripts/check-telemetry-package.mjs'
import { traceRecords } from '../scripts/check-postgres-telemetry.mjs'
import { createTlsFixture, fixturePort } from '../scripts/tls-fixture.mjs'

const token = 'a'.repeat(64), parent = '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01'
const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const docker = vi.hoisted(() => ({ read: vi.fn(), inspect: vi.fn() }))
vi.mock('../src/docker/index.ts', async importOriginal => ({ ...await importOriginal<typeof import('../src/docker/index.ts')>(),
  readDockerOwner: docker.read, inspectDockerOwner: docker.inspect }))
const cleanup: (() => Promise<unknown>)[] = []
let tls: Awaited<ReturnType<typeof createTlsFixture>>
beforeAll(async () => { tls = await createTlsFixture(await mkdtemp(join(tmpdir(), 'jevable-suite-client-tls-'))) }, 20000)
afterEach(async () => { vi.restoreAllMocks(); vi.clearAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
const pin = (test: { id: string; generation: number; sha256: string }) => ({ id: test.id, generation: test.generation, sha256: test.sha256 })
async function fixture(sampleRatio = 1, https = false, httpRequests = true, collectorStatus = 200, concurrency = 2) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-suite-client-'))
  const packets: { path: string; bytes: Buffer; authorization: string | undefined }[] = []
  const receiver = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk)
    expect(request.headers.baggage).toBeUndefined()
    packets.push({ path: request.url!, bytes: Buffer.concat(chunks), authorization: request.headers.authorization })
    response.writeHead(collectorStatus, { 'content-type': 'application/x-protobuf' }); response.end()
  })
  await new Promise<void>((yes, no) => { receiver.once('error', no); receiver.listen(0, '127.0.0.1', yes) })
  cleanup.push(() => new Promise<void>(yes => { receiver.close(() => yes()); receiver.closeAllConnections() }))
  const base = `http://127.0.0.1:${(receiver.address() as { port: number }).port}`
  const telemetry = { endpoint: base + '/v1/traces', metricsEndpoint: base + '/v1/metrics', logsEndpoint: base + '/v1/logs',
    authentication: { kind: 'none' as const }, intervalMs: 60000, timeoutMs: 1000, flushTimeoutMs: 2000, sampleRatio, baggageKeys: ['request.class'] }
  const state = join(directory, 'state'), prepared = await LocalRuntime.open({ dataDirectory: state })
  const project = prepared.editProject({ operation: 'create', yaml: echo, title: 'PRIVATE_PROJECT', actor: 'PRIVATE_ACTOR' })
  const tests = Array.from({ length: 2 }, () => {
    const draft = prepared.editTest({ operation: 'create', actor: 'PRIVATE_ACTOR', definition: { title: 'PRIVATE_CASE',
      project: { id: project.id, generation: project.generation, revision: project.acceptedRevision }, input: 'PRIVATE_INPUT',
      expectations: [{ kind: 'status', value: 'completed' }, { kind: 'output-equals', value: 'PRIVATE_INPUT' }] } })
    return pin(prepared.editTest({ operation: 'accept', id: draft.id, expectedGeneration: draft.generation, reviewedSha256: draft.sha256, actor: 'PRIVATE_ACTOR' }))
  })
  await prepared.close()
  const port = https ? await fixturePort() : 0
  const service = await startRuntimeService({ token, actor: 'PRIVATE_ACTOR', runtime: { dataDirectory: state, telemetry: { ...telemetry, httpRequests } }, port,
    ...(https ? { tls: { publicOrigin: `https://127.0.0.1:${port}`, bindAddress: '127.0.0.1', certificateFile: tls.cert, privateKeyFile: tls.key } } : {}) })
  cleanup.push(async () => { await service.close(); await service.closed })
  const client = new RuntimeClient(service.url, token, 30000, 20_000_000, https ? { ca: tls.ca, expectedInstanceId: service.instanceId } : {})
  const observer = createTestSuiteTelemetry(telemetry); cleanup.push(() => observer.close())
  const traces = () => packets.filter(p => p.path === '/v1/traces').flatMap(p => traceRecords(p.bytes))
  const logs = () => packets.filter(p => p.path === '/v1/logs').flatMap(p => logRecords(p.bytes))
  const flush = async () => { await client.operation({ operation: 'telemetry.flush' }); await observer.flush() }
  const suite = createTestSuite({ title: 'PRIVATE_SUITE', failurePolicy: 'continue', concurrency, tests })
  return { directory, telemetry, packets, service, client, observer, traces, logs, flush, suite }
}
async function cli(args: string[]) { let out = '', err = ''; const code = await main(args, { out: value => { out += value }, err: value => { err += value } }); return { code, out, err, result: out ? JSON.parse(out) : undefined } }
const context = { traceparent: parent, baggage: 'request.class=PRIVATE_BAGGAGE,other=PRIVATE_DROP' }
function clientDispatchCounts(packets: { path: string; bytes: Buffer }[]) {
  const metrics = packets.filter(p => p.path === '/v1/metrics' && resourceAttributes(p.bytes).some(r => r['jevable.component'] === 'suite-client')).flatMap(p => metricSums(p.bytes))
  const active = metrics.filter(m => m.name === 'jevable.test.suite.cases.active').at(-1)!
  expect(active.points.toSorted((a, b) => String(a.labels['jevable.suite.case.phase']).localeCompare(String(b.labels['jevable.suite.case.phase'])))).toEqual([
    { value: 0, labels: { 'jevable.suite.failure_policy': 'continue', 'jevable.suite.case.phase': 'running' } },
    { value: 0, labels: { 'jevable.suite.failure_policy': 'continue', 'jevable.suite.case.phase': 'waiting' } },
  ])
  expect(metrics.filter(m => m.name === 'jevable.test.suite.cases.settled').at(-1)!.points).toEqual([
    { value: 2, labels: { 'jevable.suite.failure_policy': 'continue' } },
  ])
}
const resultEnvelope = z.object({ result: z.unknown() })
it.each([0, 1].flatMap(sampleRatio => [false, true].flatMap(https => [false, true].map(httpRequests => ({ sampleRatio, httpRequests, https })))))('SDK client parents guarded requests and retained executions ($sampleRatio/$httpRequests/$https)', async ({ sampleRatio, httpRequests, https }) => {
  const f = await fixture(sampleRatio, https, httpRequests), host = createHttpTestSuiteHost(f.client, context, f.observer)
  const first = await runTestSuite(host, f.suite.suite, f.suite.sha256); expect(first.status).toBe('passed')
  await f.flush()
  const logs = f.logs(), suiteLog = logs.find(l => l.event === 'jevable.test.suite.ended')!
  expect(suiteLog.traceId).toBe('1'.repeat(32)); expect(suiteLog.attributes['jevable.suite.sha256']).toBe(f.suite.sha256)
  const requests = logs.filter(l => l.event === 'jevable.http.request.ended' && l.traceId === suiteLog.traceId)
  const execution = logs.filter(l => l.event === 'jevable.execution.segment.ended')
  expect(execution).toHaveLength(2); expect(execution.every(l => l.traceId === suiteLog.traceId)).toBe(true)
  const events = await Promise.all(f.suite.suite.entries.map(async entry => resultEnvelope.parse(await f.client.operation({ operation: 'runs.events', id: entry.runId })).result))
  const runs = await Promise.all(f.suite.suite.entries.map(async entry => resultEnvelope.parse(await f.client.operation({ operation: 'runs.show', id: entry.runId })).result))
  if (sampleRatio) {
    const spans = f.traces(), suiteSpan = spans.find(s => s.spanId === suiteLog.spanId)!
    expect(suiteSpan).toMatchObject({ name: 'jevable.test.suite', parent: '2'.repeat(16) })
    expect(requests.length).toBe(httpRequests ? 8 : 0)
    for (const log of requests) expect(spans.find(s => s.spanId === log.spanId)!.parent).toBe(suiteLog.spanId)
    for (const log of execution) {
      const span = spans.find(s => s.spanId === log.spanId)!
      expect(httpRequests ? requests.some(r => r.spanId === span.parent) : span.parent === suiteLog.spanId).toBe(true)
    }
  } else expect(f.traces()).toEqual([])
  expect((await runTestSuite(host, f.suite.suite, f.suite.sha256)).entries.map(e => e.observation)).toEqual(['retained', 'retained'])
  expect((await testSuiteResult(host, f.suite.suite)).status).toBe('passed'); await f.flush()
  expect(f.logs().filter(l => l.event === 'jevable.execution.segment.ended')).toHaveLength(2)
  expect(f.logs().filter(l => l.event === 'jevable.test.suite.ended')).toHaveLength(3)
  expect(await Promise.all(f.suite.suite.entries.map(async entry => resultEnvelope.parse(await f.client.operation({ operation: 'runs.events', id: entry.runId })).result))).toEqual(events)
  expect(await Promise.all(f.suite.suite.entries.map(async entry => resultEnvelope.parse(await f.client.operation({ operation: 'runs.show', id: entry.runId })).result))).toEqual(runs)
  const clientPackets = f.packets.filter(p => resourceAttributes(p.bytes).some(r => r['jevable.component'] === 'suite-client'))
  expect(clientPackets.length).toBeGreaterThan(0)
  for (const packet of clientPackets) for (const resource of resourceAttributes(packet.bytes)) {
    expect(resource['service.name']).toBe('jevable-suite-client'); expect(resource).not.toHaveProperty('jevable.storage.kind')
  }
  const sum = clientPackets.filter(p => p.path === '/v1/metrics').flatMap(p => metricSums(p.bytes)).filter(m => m.name === 'jevable.test.suite.invocations').at(-1)!
  expect(sum.points.reduce((s, p) => s + p.value, 0)).toBe(3)
  clientDispatchCounts(f.packets)
  for (const point of sum.points) expect(Object.keys(point.labels).sort()).toEqual(['jevable.suite.failure_policy', 'jevable.suite.mode', 'jevable.suite.outcome'])
  for (const packet of f.packets) { expect(packet.bytes.toString()).not.toContain('PRIVATE_'); expect(packet.bytes.toString()).not.toContain(token) }
})
it.each([0, 1].flatMap(sampleRatio => [false, true].flatMap(https => [1, 2].map(concurrency => ({ sampleRatio, https, concurrency })))))('actual CLI client configuration parents loopback HTTP / verified HTTPS ($sampleRatio/$https/$concurrency)', async ({ sampleRatio, https, concurrency }) => {
  const f = await fixture(sampleRatio, https, true, 200, concurrency), manifest = join(f.directory, 'suite.json'), policy = join(f.directory, 'client-telemetry.json'), key = join(f.directory, 'exporter.key'), owner = join(f.directory, 'owner.key'), carrier = join(f.directory, 'context.json')
  await writeFile(manifest, JSON.stringify(f.suite.suite)); await writeFile(owner, token, { mode: 0o600 }); await writeFile(key, 'PRIVATE_EXPORTER_KEY', { mode: 0o600 })
  await writeFile(policy, JSON.stringify({ ...f.telemetry, authentication: { kind: 'bearer', credentialRef: 'client/exporter' } }), { mode: 0o600 })
  await writeFile(carrier, JSON.stringify(context), { mode: 0o600 })
  const args = ['tests', 'suite', 'run', manifest, '--suite-sha256', f.suite.sha256, '--endpoint', f.service.url, '--token-file', owner,
    '--suite-telemetry-file', policy, '--suite-telemetry-credential-file', key, '--trace-context-file', carrier, ...(https ? ['--ca-file', tls.cert, '--instance-id', f.service.instanceId] : [])]
  const first = await cli(args); expect(first.code, first.err).toBe(0); expect(first.result.status).toBe('passed')
  expect(first.out + first.err).not.toContain('PRIVATE_')
  const second = await cli(args); expect(second.code, second.err).toBe(0); expect(second.result.entries.map((e: { observation: string }) => e.observation)).toEqual(['retained', 'retained'])
  await f.flush()
  expect(f.logs().filter(l => l.event === 'jevable.execution.segment.ended')).toHaveLength(2)
  const suiteLogs = f.logs().filter(l => l.event === 'jevable.test.suite.ended'); expect(suiteLogs).toHaveLength(2)
  for (const log of suiteLogs) {
    expect(log.traceId).toBe('1'.repeat(32))
    if (sampleRatio) expect(f.traces().find(s => s.spanId === log.spanId)).toMatchObject({ parent: '2'.repeat(16), traceId: '1'.repeat(32) })
  }
  if (!sampleRatio) expect(f.traces()).toEqual([])
  const clientPackets = f.packets.filter(p => resourceAttributes(p.bytes).some(r => r['jevable.component'] === 'suite-client'))
  expect(clientPackets.length).toBeGreaterThan(0)
  expect(new Set(clientPackets.flatMap(p => resourceAttributes(p.bytes).map(r => r['service.instance.id']))).size).toBe(2)
  expect(clientPackets.every(p => p.authorization === 'Bearer PRIVATE_EXPORTER_KEY')).toBe(true)
  for (const packet of f.packets) expect(packet.bytes.toString()).not.toContain('PRIVATE_')
})
it('selected Docker adapter forwards suite scope through its verified HTTPS client without owning local storage', async () => {
  // Only read-only Docker observation is doubled; transport, suite and owner are real.
  // This is not an actual Docker engine/container qualification.
  const f = await fixture(1, true), manifest = join(f.directory, 'suite.json'), policy = join(f.directory, 'client.json'), owner = join(f.directory, 'owner.key')
  await writeFile(manifest, JSON.stringify(f.suite.suite)); await writeFile(policy, JSON.stringify(f.telemetry), { mode: 0o600 }); await writeFile(owner, token, { mode: 0o600 })
  docker.read.mockResolvedValue({ storage: 'sqlite' })
  docker.inspect.mockResolvedValue({ containerId: '5'.repeat(64), status: 'running', resources: { endpoint: f.service.url }, service: { status: 'ready', instanceId: f.service.instanceId } })
  const args = ['tests', 'suite', 'run', manifest, '--suite-sha256', f.suite.sha256, '--runtime', 'docker', '--owner-file', join(f.directory, 'not-read-owner.json'),
    '--owner-sha256', '6'.repeat(64), '--container-id', '5'.repeat(64), '--token-file', owner, '--ca-file', tls.cert, '--suite-telemetry-file', policy]
  const result = await cli(args); expect(result.code, result.err).toBe(0); expect(result.result.status).toBe('passed')
  expect(docker.read).toHaveBeenCalledTimes(1); expect(docker.inspect).toHaveBeenCalledTimes(1); await f.flush()
  const suite = f.logs().find(l => l.event === 'jevable.test.suite.ended')!
  expect(f.logs().filter(l => l.event === 'jevable.execution.segment.ended')).toHaveLength(2)
  const requests = f.logs().filter(l => l.event === 'jevable.http.request.ended' && l.traceId === suite.traceId)
  expect(requests).toHaveLength(8)
  for (const request of requests) expect(f.traces().find(s => s.spanId === request.spanId)!.parent).toBe(suite.spanId)
  expect(z.object({ instanceId: z.uuid() }).parse(await f.client.capabilities()).instanceId).toBe(f.service.instanceId)
})
it('opt-out forwards the original context and emits no client aggregate', async () => {
  const f = await fixture(), host = createHttpTestSuiteHost(f.client, context)
  expect((await runTestSuite(host, f.suite.suite, f.suite.sha256)).status).toBe('passed'); await f.flush()
  expect(f.logs().filter(l => l.event === 'jevable.test.suite.ended')).toEqual([])
  expect(f.packets.flatMap(p => resourceAttributes(p.bytes)).some(r => r['jevable.component'] === 'suite-client')).toBe(false)
  const requests = f.logs().filter(l => l.event === 'jevable.http.request.ended' && l.traceId === '1'.repeat(32))
  expect(requests).toHaveLength(8)
  for (const request of requests) expect(f.traces().find(s => s.spanId === request.spanId)!.parent).toBe('2'.repeat(16))
})
it('client telemetry cannot bypass a failed immutable owner pin or retry discovery', async () => {
  const f = await fixture(), caps = vi.spyOn(f.client, 'capabilities').mockResolvedValue({ instanceId: randomUUID(), api: { protocol: PROTOCOL_VERSION } })
  const dispatch = vi.spyOn(f.client, 'operation'), host = createHttpTestSuiteHost(f.client, context, f.observer)
  f.client.pinInstance(f.service.instanceId)
  for (let i = 0; i < 2; i++) expect((await runTestSuite(host, f.suite.suite, f.suite.sha256)).status).toBe('blocked')
  expect(caps).toHaveBeenCalledTimes(1); expect(dispatch).not.toHaveBeenCalled(); await f.observer.flush()
  expect(f.logs().filter(l => l.event === 'jevable.test.suite.ended')).toHaveLength(2)
  expect(f.logs().filter(l => l.event === 'jevable.execution.segment.ended')).toEqual([])
})
it('export refusal cannot replay remote execution or suppress its report', async () => {
  const f = await fixture(1, false, false, 503), host = createHttpTestSuiteHost(f.client, context, f.observer)
  expect((await runTestSuite(host, f.suite.suite, f.suite.sha256)).status).toBe('passed'); await f.flush()
  expect((await runTestSuite(host, f.suite.suite, f.suite.sha256)).status).toBe('passed'); await f.flush()
  expect(f.logs().filter(l => l.event === 'jevable.execution.segment.ended')).toHaveLength(2)
})
it.each(['throw', 'invalid', 'rejection', 'resolved-promise', 'thenable', 'array'])('faulty diagnostic carriers preserve the original admitted request context (%s)', async fault => {
  const f = await fixture(), base = createHttpTestSuiteHost(f.client, context)
  const bad = { observeTestSuite() {}, traceContext() {
    if (fault === 'throw') throw Error('PRIVATE_FAULT')
    if (fault === 'rejection') return Promise.reject(Error('PRIVATE_FAULT'))
    if (fault === 'resolved-promise') return Promise.resolve(context)
    if (fault === 'thenable') return { then(resolve: (value: unknown) => void) { resolve(context) } }
    if (fault === 'array') return []
    return { traceparent: 'PRIVATE_INVALID' }
  } } as unknown as TestSuiteTelemetry
  const client = { call: vi.fn(async (command, forwarded) => {
    expect(forwarded).toEqual(context)
    return command.operation === 'tests.result' ? base.testResult(command.runId) : command.operation === 'tests.show' ? base.testCase(command.id)
      : command.operation === 'projects.show' ? base.project(command.id) : base.runTest(command.test, command.runId)
  }) }
  expect((await runTestSuite(createOperationTestSuiteHost(client, context, bad), f.suite.suite, f.suite.sha256)).status).toBe('passed')
  expect(client.call).toHaveBeenCalledTimes(8)
  await new Promise(resolve => setImmediate(resolve))
})
it.each(['retainedStateMetrics', 'runtimeWorkMetrics', 'storageQueueMetrics', 'storageTransactionMetrics', 'journalTransactions', 'sqliteStatementMetrics', 'httpRequests', 'httpConnections', 'grantOperations', 'grantPolicyDecisions'])('refuses owner-only flag %s before creating client instrumentation', flag => {
  expect(() => createTestSuiteTelemetry({ endpoint: 'http://127.0.0.1:1/v1/traces', metricsEndpoint: 'http://127.0.0.1:1/v1/metrics', authentication: { kind: 'none' }, [flag]: true })).toThrow('invalid-command')
})
it('private client configuration refuses missing/shared/unprotected keys and never consumes management credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-client-policy-')), policy = join(directory, 'policy.json'), owner = join(directory, 'owner.key'), key = join(directory, 'exporter.key')
  await writeFile(owner, token, { mode: 0o600 }); await writeFile(key, 'PRIVATE_EXPORTER_KEY', { mode: 0o600 })
  const config = { endpoint: 'http://127.0.0.1:1/v1/traces', authentication: { kind: 'bearer', credentialRef: 'client/key' } }
  await writeFile(policy, JSON.stringify(config), { mode: 0o600 })
  const values = { endpoint: 'http://127.0.0.1:1', 'token-file': owner, 'suite-telemetry-file': policy }
  await expect(readSuiteTelemetryOptions(values)).rejects.toThrow('Suite telemetry requires')
  await expect(readSuiteTelemetryOptions({ ...values, 'suite-telemetry-credential-file': owner })).rejects.toThrow('Suite telemetry requires')
  const hard = join(directory, 'hard.key'); await link(owner, hard)
  await expect(readSuiteTelemetryOptions({ ...values, 'suite-telemetry-credential-file': hard })).rejects.toThrow('Suite telemetry requires')
  const symbolic = join(directory, 'linked.json'); await symlink(policy, symbolic)
  await expect(readSuiteTelemetryOptions({ ...values, 'suite-telemetry-file': symbolic, 'suite-telemetry-credential-file': key })).rejects.toThrow('Suite telemetry requires')
  if (process.platform !== 'win32') { await chmod(key, 0o640); await expect(readSuiteTelemetryOptions({ ...values, 'suite-telemetry-credential-file': key })).rejects.toThrow('Suite telemetry requires'); await chmod(key, 0o600) }
  expect((await readSuiteTelemetryOptions({ ...values, 'suite-telemetry-credential-file': key }))!.config.serviceName).toBe('jevable-suite-client')
  await writeFile(policy, JSON.stringify({ ...config, authentication: { kind: 'none' } }))
  await expect(readSuiteTelemetryOptions({ ...values, 'suite-telemetry-credential-file': key })).rejects.toThrow('Suite telemetry requires')
})
it('selection refuses local-owner/client telemetry mixing without reading any file', () => {
  for (const values of [{ 'suite-telemetry-file': '/not-read' }, { endpoint: 'http://127.0.0.1:1', 'token-file': '/not-read', 'suite-telemetry-credential-file': '/not-read' }]) expect(() => suiteSelection(values)).toThrow()
  expect(suiteSelection({ endpoint: 'http://127.0.0.1:1', 'token-file': '/not-read', 'suite-telemetry-file': '/not-read' })).toBe('http')
  expect(parseSuiteTelemetryConfig({ endpoint: 'http://127.0.0.1:1', authentication: { kind: 'none' } }).serviceName).toBe('jevable-suite-client')
})
it.each(['hash', 'context', 'policy'])('CLI refuses malformed %s before owner credentials or network', async fault => {
  const f = await fixture(), manifest = join(f.directory, 'suite.json'), policy = join(f.directory, 'invalid-client.json'), carrier = join(f.directory, 'invalid-context.json')
  await writeFile(manifest, JSON.stringify(f.suite.suite)); await writeFile(policy, '{"PRIVATE_INVALID":true}', { mode: 0o600 }); await writeFile(carrier, '{"traceparent":"PRIVATE_INVALID"}', { mode: 0o600 })
  const caps = vi.spyOn(RuntimeClient.prototype, 'capabilities'), dispatch = vi.spyOn(RuntimeClient.prototype, 'operation')
  const result = await cli(['tests', 'suite', 'run', manifest, '--suite-sha256', fault === 'hash' ? '0'.repeat(64) : f.suite.sha256,
    '--endpoint', f.service.url, '--token-file', join(f.directory, 'PRIVATE_MISSING_OWNER_KEY'),
    ...(fault === 'context' ? ['--trace-context-file', carrier] : ['--suite-telemetry-file', policy])])
  expect(result.code).toBe(2); expect(result.out).toBe(''); expect(result.err).not.toContain('PRIVATE_')
  expect(result.err).toContain(fault === 'hash' ? 'Suite hash differs' : fault === 'context' ? 'Trace context requires' : 'Suite telemetry requires')
  expect(caps).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled()
})
it('keeps client parents/baggage private to concurrent scopes and restores the fallback afterward', async () => {
  const telemetry = createTestSuiteTelemetry({ endpoint: 'http://127.0.0.1:1/v1/traces', authentication: { kind: 'none' }, baggageKeys: ['request.class'], timeoutMs: 10, flushTimeoutMs: 10 })
  cleanup.push(() => telemetry.close())
  const fallback = Object.freeze(context), gate = Promise.withResolvers<void>()
  const snapshots: { traceparent?: string | undefined; baggage?: string | undefined }[] = []
  const identity = { sha256: 'a'.repeat(64), mode: 'run' as const, failurePolicy: 'stop' as const, entries: 1, concurrency: 1 }
  const observations = ['1', '3'].map(digit => telemetry.observeTestSuite(identity, { traceparent: `00-${digit.repeat(32)}-${'2'.repeat(16)}-01`, baggage: context.baggage })!)
  const pending = observations.map(observation => observation.within(async () => { await gate.promise; snapshots.push(telemetry.traceContext()!) }))
  expect(telemetry.traceContext(fallback)).toBe(fallback); gate.resolve(); await Promise.all(pending)
  expect(snapshots.map(c => c.traceparent!.split('-')[1]).sort()).toEqual(['1'.repeat(32), '3'.repeat(32)])
  expect(snapshots.map(c => c.baggage)).toEqual(['request.class=PRIVATE_BAGGAGE', 'request.class=PRIVATE_BAGGAGE'])
  expect(telemetry.traceContext(fallback)).toBe(fallback); for (const observation of observations) observation.finish('passed')
})

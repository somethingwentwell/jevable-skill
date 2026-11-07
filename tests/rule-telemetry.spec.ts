import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Span } from '@opentelemetry/api'
import { JsonTraceSerializer, ProtobufTraceSerializer, JsonLogsSerializer, ProtobufLogsSerializer,
  JsonMetricsSerializer, ProtobufMetricsSerializer } from '@opentelemetry/otlp-transformer'
import { LocalRuntime } from '../src/runtime/local.ts'
import { RuntimeTelemetry } from '../src/telemetry/traces.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { advanceCheckpoint, advanceDurably, compileLocalRun, initialCheckpoint } from '../src/runtime/run-evaluator.ts'
import { observeCommittedRuleRoute } from '../src/runtime/run-telemetry.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const source = (mode: 'ifElse' | 'switch') => JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow',
  metadata: { id: 'rule-trace', name: 'Rule trace' }, spec: {
    inputSchema: { type: 'object', required: ['route', 'secret'], additionalProperties: false,
      properties: { route: { type: 'string' }, secret: { type: 'string' } } },
    nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
      choose: { type: 'rule', config: mode === 'ifElse' ? { mode, condition: '${{ inputs.route == "yes" }}' }
        : { mode, value: '${{ inputs.route }}', cases: [{ value: 'yes', port: 'chosen' }] } },
      end: { type: 'output', config: { value: '${{ inputs.secret }}' } } },
    edges: [{ from: 'start', to: 'choose' }, ...(mode === 'ifElse' ? ['true', 'false'] : ['chosen', 'default'])
      .map(port => ({ from: 'choose', port, to: 'end' }))] } })
const attributes = (value: any) => Object.fromEntries((value.attributes ?? []).map((a: any) => [a.key,
  a.value.stringValue ?? a.value.boolValue ?? a.value.intValue]))
async function receiver() {
  const traces: any[] = [], logs: any[] = [], metrics: any[] = [], wire: Buffer[] = []
  for (const [serializer, json, target] of [[ProtobufTraceSerializer, JsonTraceSerializer, traces],
    [ProtobufLogsSerializer, JsonLogsSerializer, logs], [ProtobufMetricsSerializer, JsonMetricsSerializer, metrics]] as const) {
    const encode = serializer.serializeRequest
    vi.spyOn(serializer, 'serializeRequest').mockImplementation((records: any) => {
      target.push(JSON.parse(Buffer.from(json.serializeRequest(records)!).toString()))
      return encode(records)
    })
  }
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk)
    wire.push(Buffer.concat(chunks)); response.writeHead(200, { 'content-type': 'application/x-protobuf' }); response.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No fixture address')
  const origin = `http://127.0.0.1:${address.port}/v1/`
  return { config: { endpoint: origin + 'traces', logsEndpoint: origin + 'logs', metricsEndpoint: origin + 'metrics',
    authentication: { kind: 'none' as const }, intervalMs: 60000, timeoutMs: 1000, flushTimeoutMs: 2000 }, wire,
    traces: () => traces.flatMap(b => b.resourceSpans.flatMap((r: any) => r.scopeSpans.flatMap((s: any) => s.spans))),
    logs: () => logs.flatMap(b => b.resourceLogs.flatMap((r: any) => r.scopeLogs.flatMap((s: any) => s.logRecords))), metrics }
}

for (const sampleRatio of [0, 1]) it.each([['ifElse', 'yes', 'true'], ['ifElse', 'no', 'false'],
  ['switch', 'yes', 'chosen'], ['switch', 'no', 'default']] as const)
('joins committed %s/%s route %s to trace/log endings at sampling ' + sampleRatio, async (mode, route, port) => {
  const received = await receiver(), dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-rule-telemetry-'))
  const runtime = await LocalRuntime.open({ dataDirectory, telemetry: { ...received.config, sampleRatio } })
  cleanup.push(() => runtime.close())
  const input = { route, secret: 'PRIVATE_RULE_OUTPUT' }, run = await runtime.run(source(mode), input)
  expect(run.state.status).toBe('completed')
  const step = run.state.steps.find(s => s.nodeId === 'choose')!
  expect(step.port).toBe(port)
  await runtime.telemetryFlush()
  const log = received.logs().find(l => attributes(l)['jevable.attempt.id'] === step.inspection!.attemptId)
  expect(attributes(log)).toMatchObject({ 'jevable.rule.port': port, 'jevable.rule.settled': true })
  expect(log.spanId).toBe(step.inspection!.trace!.spanId)
  if (sampleRatio) {
    const span = received.traces().find(s => s.spanId === step.inspection!.trace!.spanId)
    expect(attributes(span)).toMatchObject({ 'jevable.rule.port': port, 'jevable.rule.settled': true })
  } else expect(received.traces()).toEqual([])
  for (const other of received.logs().filter(l => l !== log)) expect(attributes(other)).not.toHaveProperty('jevable.rule.port')
  expect(JSON.stringify(received.metrics)).not.toContain('jevable.rule.port')
  expect(JSON.stringify(received.metrics)).not.toContain('jevable.rule.settled')
  expect(Buffer.concat(received.wire).includes('PRIVATE_RULE_OUTPUT')).toBe(false)
  const packets = received.wire.length, events = runtime.events(run.id)
  expect(await runtime.run(source(mode), input, { id: run.id })).toEqual(run)
  expect(runtime.events(run.id)).toEqual(events); await runtime.telemetryFlush()
  expect(received.wire).toHaveLength(packets)
})

function durableRule() {
  const graph = compileLocalRun(source('ifElse'), DEFAULT_COMPILER_LIMITS), input = { route: 'yes', secret: 'PRIVATE_RULE_INPUT' }
  const checkpoint = advanceCheckpoint(graph, input, initialCheckpoint(graph), DEFAULT_COMPILER_LIMITS.binding.data)
  if (checkpoint.status !== 'paused') throw Error('Expected rule checkpoint')
  const setAttributes = vi.fn(), end = vi.fn(), span = { setAttributes, end, setAttribute: vi.fn(), setStatus: vi.fn(),
    spanContext: () => ({ traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags: 0 }) } as unknown as Span
  return { graph, input, checkpoint, span, setAttributes, end }
}
it('does not emit committed route metadata while result acknowledgement is held', async () => {
  const f = durableRule(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  const pending = advanceDurably(f.graph, f.input, f.checkpoint, DEFAULT_COMPILER_LIMITS.binding.data,
    { async intent() {}, span: () => f.span, async result(next) { entered.resolve(); await gate.promise; return next } })
  await entered.promise; expect(f.setAttributes).not.toHaveBeenCalled(); expect(f.end).not.toHaveBeenCalled()
  gate.resolve(); await pending
  expect(f.setAttributes).toHaveBeenCalledExactlyOnceWith({ 'jevable.rule.port': 'true', 'jevable.rule.settled': true })
  expect(f.end).toHaveBeenCalledTimes(1)
})
it('does not claim a settled route after an unacknowledged result write', async () => {
  const f = durableRule(), failure = Error('PRIVATE_UNCERTAIN_COMMIT')
  await expect(advanceDurably(f.graph, f.input, f.checkpoint, DEFAULT_COMPILER_LIMITS.binding.data,
    { async intent() {}, span: () => f.span, async result() { throw failure } })).rejects.toBe(failure)
  expect(f.setAttributes).not.toHaveBeenCalled(); expect(f.end).toHaveBeenCalledTimes(1)
})
it('contains a route diagnostic failure without repeating an acknowledged result write', async () => {
  const f = durableRule(), result = vi.fn(async next => next)
  f.setAttributes.mockImplementation(() => { throw Error('PRIVATE_DIAGNOSTIC') })
  const next = await advanceDurably(f.graph, f.input, f.checkpoint, DEFAULT_COMPILER_LIMITS.binding.data,
    { async intent() {}, span: () => f.span, result })
  expect(next.status).toBe('paused'); expect(result).toHaveBeenCalledTimes(1); expect(f.end).toHaveBeenCalledTimes(1)
})
it.each([undefined, '', '1invalid', 'line\nfeed', 'a'.repeat(129)])('omits invalid route metadata %s', port => {
  const f = durableRule(); observeCommittedRuleRoute(f.span, port); expect(f.setAttributes).not.toHaveBeenCalled()
})
it('logs only validated settled ports of Rule node observations', async () => {
  const r = await receiver(), telemetry = new RuntimeTelemetry({ ...r.config, sampleRatio: 0 }, () => undefined)
  cleanup.push(() => telemetry.close())
  for (const [name, kind, port, settled] of [['jevable.node', 'ifElse', 'true', true], ['jevable.node', 'switch', 'chosen', true],
    ['jevable.node', 'ifElse', 'true', false], ['jevable.node', 'switch', 'bad\nport', true],
    ['jevable.node', 'output', 'true', true], ['jevable.model', 'ifElse', 'true', true]] as const) {
    const span = telemetry.start(name, { 'jevable.node.kind': kind })
    span.setAttributes({ 'jevable.rule.port': port, 'jevable.rule.settled': settled })
    telemetry.end(span, 'completed'); span.end()
  }
  await telemetry.flush(); const logs = r.logs()
  expect(logs).toHaveLength(6)
  expect(attributes(logs[0])).toMatchObject({ 'jevable.rule.port': 'true', 'jevable.rule.settled': true })
  expect(attributes(logs[1])).toMatchObject({ 'jevable.rule.port': 'chosen', 'jevable.rule.settled': true })
  for (const log of logs.slice(2)) expect(attributes(log)).not.toHaveProperty('jevable.rule.port')
  for (const log of logs.slice(2, 4)) expect(attributes(log)['jevable.rule.settled']).toBe(false)
  for (const log of logs.slice(4)) expect(attributes(log)).not.toHaveProperty('jevable.rule.settled')
})

import { afterEach, expect, it } from 'vitest'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { selectBaggage, baggageKeysSchema } from '../src/telemetry/baggage.ts'
import { parseTelemetryConfig } from '../src/telemetry/config.ts'
import { RuntimeTelemetry } from '../src/telemetry/traces.ts'
import { connectionSchema } from '../src/providers/config.ts'
import { LocalRuntime } from '../src/runtime/local.ts'
import { RuntimeClient, startRuntimeService } from '../src/http/index.ts'
import { PROTOCOL_VERSION } from '../src/capabilities.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const parent = '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01'
const token = 'a'.repeat(64), secret = 'PRIVATE_BAGGAGE'
const telemetryBase = { endpoint: 'http://127.0.0.1:1/v1/traces', authentication: { kind: 'none' as const } }

it('keeps baggage opt-in absent from historical default policies', () => {
  expect(parseTelemetryConfig(telemetryBase)).not.toHaveProperty('baggageKeys')
  expect(selectBaggage('not a baggage header', [])).toBeUndefined()
  expect(selectBaggage(undefined, ['tenant'])).toBeUndefined()
})
it.each([
  ['tenant = A , hidden=PRIVATE', 'tenant=A'],
  ['tenant=A=B=C', 'tenant=A=B=C'],
  ['tenant=;public; region = eu%20west', 'tenant=;public;region=eu%20west'],
  ['tenant=%C3%A9%25%2C%3B%5C%0A', 'tenant=%C3%A9%25%2C%3B%5C%0A'],
  ['tenant=%FF', 'tenant=%FF'], // Wire-only: this layer never decodes UTF-8 values.
  ['tenant=A,tenant=B;flag', 'tenant=A,tenant=B;flag'],
  ['tenant=\t A \t ; flag \t', 'tenant=A;flag'],
  ['hidden=private', undefined],
  ['', undefined],
] as const)('filters complete W3C members without changing encoded values: %s', (header, expected) => {
  expect(selectBaggage(header, ['tenant'])).toBe(expected)
})
it.each(['tenant', '=value', 'tenant=A,', ',tenant=A', 'tenant=A,,region=B', 'tenant="A"',
  'tenant=A\\B', 'tenant=A B', 'tenant=%', 'tenant=%XY', 'tenant=%0', 'tenant=é',
  'tenant=A\r\nAuthorization: evil', 'tenant=A\0', 'tenant=A;', 'tenant=A; =B',
  'tenant=A;flag=two words', 'hidden=invalid%QZ'])('refuses invalid opted-in wire input without echo: %s', header => {
  expect(() => selectBaggage(header, ['tenant'])).toThrow('invalid-command')
})
it('admits the bounded wire limits, rejects overflow, and never clips a member', () => {
  const maximum = 'tenant=' + 'A'.repeat(8192 - 7)
  expect(selectBaggage(maximum, ['tenant'])).toBe(maximum)
  expect(() => selectBaggage(maximum + 'A', ['tenant'])).toThrow('invalid-command')
  const members = Array.from({ length: 64 }, () => 'tenant=A').join(',')
  expect(selectBaggage(members, ['tenant'])).toBe(members)
  expect(() => selectBaggage(members + ',tenant=A', ['tenant'])).toThrow('invalid-command')
})
it.each([['tenant', 'tenant'], ['bad key'], [''], ['é'], ['x'.repeat(129)], Array(65).fill('tenant')])(
  'rejects invalid or duplicate explicit key policies', keys => {
    expect(baggageKeysSchema.safeParse(keys).success).toBe(false)
    expect(() => parseTelemetryConfig({ ...telemetryBase, baggageKeys: keys })).toThrow('invalid-command')
  })
it('does not treat prototype-like token keys as object properties', () => {
  expect(selectBaggage('__proto__=A,constructor=B,toString=C', ['__proto__', 'constructor'])).toBe('__proto__=A,constructor=B')
})

function workflow(retries = 1, approval = false) {
  const nodes: Record<string, object> = {
    start: { type: 'trigger', config: { modes: ['manual'] } },
    model: { type: 'llm', config: { provider: 'fixture', model: 'fixture-model',
      connection: { mode: 'workspace', id: 'fixture' }, prompt: '${{ inputs }}', responseFormat: 'text', historyScope: 'none',
      generation: { maxTokens: 30, stream: false }, execution: { maxAttempts: retries, timeoutSeconds: 3 } } },
    end: { type: 'output', config: { value: '${{ nodes.model.output }}' } },
  }
  if (approval) nodes.review = { type: 'humanApproval', config: { title: 'Review', input: '${{ inputs }}',
    inputSchema: { type: 'string' }, actions: ['approve', 'reject'], expiresAfter: '24h', onReject: 'cancelled', onTimeout: 'expired' } }
  return JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'baggage', name: 'Baggage fixture' },
    spec: { inputSchema: { type: 'string' }, nodes, edges: [
      { from: 'start', to: approval ? 'review' : 'model' }, ...(approval ? [{ from: 'review', port: 'approve', to: 'model' }] : []),
      { from: 'model', to: 'end' }] } })
}
async function fixture(options: { runtimeKeys?: string[]; destinationKeys?: string[]; tracePropagation?: 'none' | 'w3c';
  sampleRatio?: number; httpRequests?: boolean; refuseFirst?: boolean; telemetry?: boolean } = {}) {
  const models: { headers: Record<string, unknown>; body: string }[] = [], otlp: { headers: Record<string, unknown>; bytes: Buffer }[] = []
  const receiver = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
    const bytes = Buffer.concat(chunks)
    if (req.url === '/v1/chat/completions') {
      models.push({ headers: { ...req.headers }, body: bytes.toString() })
      if (options.refuseFirst && models.length === 1) { res.writeHead(503); res.end(); return }
      await new Promise(resolve => setTimeout(resolve, 5))
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'fixture output' } }],
        usage: { prompt_tokens: 2, completion_tokens: 1 } }))
    } else { otlp.push({ headers: { ...req.headers }, bytes }); res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.end() }
  })
  await new Promise<void>((resolve, reject) => { receiver.once('error', reject); receiver.listen(0, '127.0.0.1', resolve) })
  cleanup.push(() => new Promise<void>(resolve => { receiver.close(() => resolve()); receiver.closeAllConnections() }))
  const address = receiver.address(); if (!address || typeof address === 'string') throw Error('fixture bind')
  const base = `http://127.0.0.1:${address.port}`, dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-baggage-'))
  const config = { ...telemetryBase, endpoint: base + '/v1/traces', metricsEndpoint: base + '/v1/metrics', logsEndpoint: base + '/v1/logs',
    intervalMs: 60000, timeoutMs: 1000, flushTimeoutMs: 2000, sampleRatio: options.sampleRatio ?? 1,
    httpRequests: options.httpRequests ?? false, ...(options.runtimeKeys === undefined ? {} : { baggageKeys: options.runtimeKeys }) }
  const open = () => LocalRuntime.open({ dataDirectory, ...(options.telemetry === false ? {} : { telemetry: config }) })
  const runtime = await open(); cleanup.push(() => runtime.close())
  const connection = { id: 'fixture', provider: 'fixture', protocol: 'openai-compatible', endpoint: base + '/v1', allowedModels: ['fixture-model'],
    authentication: { kind: 'none' }, tokenParameter: 'max_tokens', maxResponseBytes: 10000, maxRequestBytes: 10000, maxStreamEvents: 100,
    maxTimeoutSeconds: 5, tracePropagation: options.tracePropagation ?? 'w3c',
    ...(options.destinationKeys === undefined ? {} : { baggageKeys: options.destinationKeys }) }
  runtime.configureConnection(connection, 0, 'fixture')
  return { runtime, connection, open, config, dataDirectory, models, otlp }
}

it('requires explicit W3C destination approval for a baggage key policy', async () => {
  const f = await fixture()
  for (const tracePropagation of [undefined, 'none']) expect(connectionSchema.safeParse({
    ...f.connection, tracePropagation, baggageKeys: ['tenant'] }).success).toBe(false)
  expect(connectionSchema.safeParse({ ...f.connection, baggageKeys: ['tenant'] }).success).toBe(true)
})
it.each([
  { runtimeKeys: ['tenant'] },
  { destinationKeys: ['tenant'] },
  { runtimeKeys: [], destinationKeys: ['tenant'] },
  { runtimeKeys: ['tenant'], destinationKeys: [] },
  { telemetry: false, destinationKeys: ['tenant'] },
  { runtimeKeys: ['tenant'], tracePropagation: 'none' as const },
])('does not forward baggage when either explicit boundary is absent: %j', async options => {
  const f = await fixture(options)
  const run = await f.runtime.withTraceContext({ traceparent: parent, baggage: 'tenant=' + secret }, () => f.runtime.run(workflow(), 'input'))
  expect(run.state.status).toBe('completed'); expect(f.models).toHaveLength(1)
  expect(f.models[0]!.headers.baggage).toBeUndefined()
})
it.each([0, 1])('propagates only the key intersection through actual provider retries with sampling=%s', async sampleRatio => {
  const f = await fixture({ runtimeKeys: ['tenant', 'zone'], destinationKeys: ['tenant', 'region'], sampleRatio, refuseFirst: true })
  const context = { traceparent: parent, baggage: `tenant=${secret};flag,zone=PRIVATE_ZONE,region=PRIVATE_REGION` }
  const id = randomUUID(), promise = f.runtime.withTraceContext(context, () => f.runtime.run(workflow(2), 'input', { id }))
  context.baggage = 'tenant=PRIVATE_MUTATION'
  const run = await promise; expect(run.state.status).toBe('completed'); expect(f.models).toHaveLength(2)
  for (const call of f.models) {
    expect(call.headers.baggage).toBe(`tenant=${secret};flag`)
    expect(call.headers.traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-0[01]$/u)
    expect(call.body).not.toContain('PRIVATE_')
  }
  const evidence = await f.runtime.exportRun(id, true), events = await f.runtime.events(id)
  expect(JSON.stringify([run, evidence, events])).not.toContain('PRIVATE_')
  const retry = await f.runtime.withTraceContext({ baggage: 'tenant=PRIVATE_RETRY' }, () => f.runtime.run(workflow(2), 'input', { id }))
  expect(retry).toEqual(run); expect(await f.runtime.events(id)).toEqual(events); expect(f.models).toHaveLength(2)
  await f.runtime.close()
  expect((await readFile(join(f.dataDirectory, 'runtime.sqlite'))).includes(Buffer.from(secret))).toBe(false)
  expect(f.otlp.length).toBeGreaterThan(0)
  for (const packet of f.otlp) { expect(packet.headers.baggage).toBeUndefined(); expect(packet.bytes.includes(Buffer.from('PRIVATE_'))).toBe(false) }
})
it('isolates concurrent requests and clears nested legacy-parent scopes', async () => {
  const f = await fixture({ runtimeKeys: ['tenant'], destinationKeys: ['tenant'] })
  await Promise.all(['A', 'B'].map(label => f.runtime.withTraceContext({ baggage: `tenant=PRIVATE_${label}` }, async () => {
    await new Promise(resolve => setTimeout(resolve, label === 'A' ? 10 : 0))
    await f.runtime.run(workflow(), label)
  })))
  for (const call of f.models) {
    const prompt = JSON.parse(call.body).messages.at(-1).content
    expect(call.headers.baggage).toBe(`tenant=PRIVATE_${prompt}`)
  }
  await f.runtime.withTraceContext({ baggage: 'tenant=PRIVATE_OUTER' }, async () => {
    await f.runtime.withTraceParent(undefined, () => f.runtime.run(workflow(), 'nested'))
    await f.runtime.run(workflow(), 'outer')
  })
  expect(f.models[2]!.headers.baggage).toBeUndefined(); expect(f.models[3]!.headers.baggage).toBe('tenant=PRIVATE_OUTER')
  await f.runtime.run(workflow(), 'outside'); expect(f.models[4]!.headers.baggage).toBeUndefined()
})
it('never recovers baggage from a waiting run or configuration-free reopen', async () => {
  const f = await fixture({ runtimeKeys: ['tenant'], destinationKeys: ['tenant'] })
  const waiting = await f.runtime.withTraceContext({ baggage: 'tenant=' + secret }, () => f.runtime.run(workflow(1, true), 'input'))
  expect(waiting.state.status).toBe('waiting'); expect(f.models).toHaveLength(0)
  if (waiting.state.status !== 'waiting') throw Error('fixture wait')
  await f.runtime.close()
  const reopened = await f.open(); cleanup.push(() => reopened.close())
  const run = await reopened.decide(waiting.id, waiting.state.attempt.id, 'approve', 'fixture')
  expect(run.state.status).toBe('completed'); expect(f.models[0]!.headers.baggage).toBeUndefined()
  expect(JSON.stringify(await reopened.exportRun(run.id, true))).not.toContain(secret)
})
it('separates telemetry owners and rejects invalid SDK carriers before execution', async () => {
  const one = new RuntimeTelemetry({ ...telemetryBase, baggageKeys: ['tenant'] }, () => undefined)
  const two = new RuntimeTelemetry({ ...telemetryBase, baggageKeys: ['tenant'] }, () => undefined)
  cleanup.push(() => one.close(), () => two.close())
  one.withTraceContext({ baggage: 'tenant=' + secret }, () => { expect(one.baggage()).toBe('tenant=' + secret); expect(two.baggage()).toBeUndefined() })
  expect(one.baggage()).toBeUndefined()
  expect(() => one.withTraceContext({ baggage: 'tenant=bad%QZ' }, () => { throw Error('must not execute') })).toThrow('invalid-command')
  expect(() => one.withTraceContext({ traceparent: 'invalid' }, () => {})).toThrow('invalid-command')
  expect(() => one.withTraceContext({ baggage: 'tenant=A', extra: 'forbidden' } as any, () => {})).toThrow('invalid-command')
})
it.each([false, true])('admits authenticated HTTP context without signal or response leakage, request spans=%s', async httpRequests => {
  const f = await fixture({ runtimeKeys: ['tenant'], destinationKeys: ['tenant'], httpRequests })
  await f.runtime.close()
  const service = await startRuntimeService({ runtime: { dataDirectory: f.dataDirectory, telemetry: f.config }, token, actor: 'fixture' })
  cleanup.push(async () => { await service.close(); await service.closed })
  const client = new RuntimeClient(service.url, token), id = randomUUID()
  const result = await client.operation({ operation: 'runs.start', id, yaml: workflow(), input: 'input' },
    { traceparent: parent, baggage: 'tenant=' + secret + ',hidden=PRIVATE_HIDDEN' })
  expect(f.models[0]!.headers.baggage).toBe('tenant=' + secret); expect(JSON.stringify(result)).not.toContain(secret)
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-jevable-protocol': PROTOCOL_VERSION }
  const invalidId = randomUUID(), command = { operation: 'runs.start' as const, id: invalidId, yaml: workflow(), input: 'input' }
  const invalid = await fetch(service.url + '/v1/operations', { method: 'POST', headers: { ...headers, baggage: 'tenant=PRIVATE_INVALID%' }, body: JSON.stringify(command) })
  expect(invalid.status).toBe(400); expect(await invalid.text()).not.toContain('PRIVATE_')
  const unauthorized = await fetch(service.url + '/v1/operations', { method: 'POST', headers: { ...headers, authorization: 'Bearer ' + 'b'.repeat(64), baggage: 'tenant=PRIVATE_INVALID%' }, body: JSON.stringify(command) })
  expect(unauthorized.status).toBe(401); expect(f.models).toHaveLength(1)
  await expect(client.operation(command, { baggage: 'tenant=PRIVATE_INVALID%' })).rejects.toMatchObject({ code: 'invalid-command' })
  const retry = await client.operation({ operation: 'runs.start', id, yaml: workflow(), input: 'input' }, { baggage: 'tenant=PRIVATE_RETRY' })
  expect(retry).toEqual(result); expect(f.models).toHaveLength(1)
  await service.close(); await service.closed
  expect(f.otlp.length).toBeGreaterThan(0)
  for (const packet of f.otlp) { expect(packet.headers.baggage).toBeUndefined(); expect(packet.bytes.includes(Buffer.from('PRIVATE_'))).toBe(false) }
})
it('combines repeated W3C baggage header fields only after authentication', async () => {
  const f = await fixture({ runtimeKeys: ['tenant'], destinationKeys: ['tenant'] }); await f.runtime.close()
  const service = await startRuntimeService({ runtime: { dataDirectory: f.dataDirectory, telemetry: f.config }, token, actor: 'fixture' })
  cleanup.push(async () => { await service.close(); await service.closed })
  const payload = JSON.stringify({ operation: 'runs.start', id: randomUUID(), yaml: workflow(), input: 'input' })
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(service.url + '/v1/operations', { method: 'POST', headers: ['Host', new URL(service.url).host, 'Authorization', 'Bearer ' + token,
      'Content-Type', 'application/json', 'X-Jevable-Protocol', PROTOCOL_VERSION, 'Content-Length', String(Buffer.byteLength(payload)),
      'baggage', 'tenant=PRIVATE_FIRST', 'baggage', 'tenant=PRIVATE_SECOND;flag'] }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)) })
    request.on('error', reject); request.end(payload)
  })
  expect(status).toBe(200); expect(f.models[0]!.headers.baggage).toBe('tenant=PRIVATE_FIRST,tenant=PRIVATE_SECOND;flag')
})

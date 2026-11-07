import { afterEach, expect, it } from 'vitest'
import { createServer, type IncomingMessage } from 'node:http'
import { chmod, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { readCliTraceContext } from '../src/cli/trace-context.ts'
import { openCliOperations, operationSelection } from '../src/cli/operations.ts'
import { previewSelection } from '../src/cli/preview.ts'
import { main } from '../src/cli.ts'
import { LocalRuntime, prepareGrantToken } from '../src/runtime/index.ts'
import { ReleaseClient } from '../src/releases/client.ts'
import { PROTOCOL_VERSION } from '../src/capabilities.ts'
import { RuntimeClient } from '../src/http/client.ts'
import { createHttpTestSuiteHost } from '../src/testing/http.ts'
import { createTestSuite } from '../src/testing/suite.ts'
import { suiteFromCli } from '../src/cli/suite.ts'

const parent = '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01'
const secret = 'PRIVATE_CLI_METADATA', token = 'a'.repeat(64)
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function file(bytes: string | Buffer, mode = 0o600) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-cli-context-')), path = join(directory, 'context.json')
  await writeFile(path, bytes, { mode }); return { directory, path }
}
async function cli(...args: string[]) {
  let output = '', error = ''
  const exit = await main(args, { out: text => { output += text }, err: text => { error += text } })
  return { exit, output, error, result: output ? JSON.parse(output) : undefined }
}
it('private context file is an explicit immutable canonical snapshot, not a credential or ambient state', async () => {
  expect(await readCliTraceContext(undefined)).toBeUndefined()
  const f = await file(JSON.stringify({ traceparent: parent, baggage: 'request.class = interactive ; flag ,other = ignored' }))
  const context = await readCliTraceContext(f.path)
  expect(context).toEqual({ traceparent: parent, baggage: 'request.class=interactive;flag,other=ignored' })
  expect(Object.isFrozen(context)).toBe(true)
  await writeFile(f.path, JSON.stringify({ baggage: 'request.class=changed' }))
  expect(context!.baggage).toBe('request.class=interactive;flag,other=ignored')
  expect(await readCliTraceContext(f.path)).toEqual({ baggage: 'request.class=changed' })
})
it.each(['{}', '{"baggage":""}', '{"baggage":" \t "}'])('private empty context explicitly clears carrier: %s', async bytes => {
  const f = await file(bytes.replace('\t', '\\t'))
  expect(await readCliTraceContext(f.path)).toEqual({})
})
it.each([
  '', 'not JSON PRIVATE_INPUT', 'null', '[]', '"PRIVATE_INPUT"', '{"baggage":1}',
  JSON.stringify({ traceparent: 'PRIVATE_INVALID_PARENT' }),
  JSON.stringify({ baggage: 'request.class=PRIVATE_BAD%' }),
  JSON.stringify({ baggage: 'request.class=A\r\nAuthorization: PRIVATE' }),
  JSON.stringify({ baggage: 'request.class=' + 'A'.repeat(8192) }),
  JSON.stringify({ baggage: 'request.class=A', actor: 'PRIVATE_FORGED_ACTOR' }),
  JSON.stringify({ baggage: 'request.class=A', tracestate: 'PRIVATE_TRACESTATE' }),
  ' '.repeat(65_537), Buffer.from([0xff]),
])('private parser refuses malformed/oversized context without disclosing values', async bytes => {
  const f = await file(bytes)
  await expect(readCliTraceContext(f.path)).rejects.toMatchObject({ message: expect.not.stringContaining('PRIVATE') })
})
it('private parser refuses symlinks, directories, missing files, and group-readable files', async () => {
  const f = await file('{}'), link = join(f.directory, 'link.json')
  await symlink(f.path, link)
  for (const path of [link, f.directory, join(f.directory, 'missing.json')]) await expect(readCliTraceContext(path)).rejects.toThrow('Trace context requires')
  if (process.platform !== 'win32') { await chmod(f.path, 0o640); await expect(readCliTraceContext(f.path)).rejects.toThrow('owner-only') }
  for (const value of ['', true, false]) await expect(readCliTraceContext(value)).rejects.toThrow('Trace context requires')
})
it('invalid private context refuses before local state creation or Docker/remote credential access', async () => {
  const f = await file('{"baggage":"PRIVATE_BAD%"}'), state = join(f.directory, 'state')
  expect(operationSelection({ 'trace-context-file': f.path })).toBe('local')
  for (const values of [
    { 'data-dir': state },
    { runtime: 'docker', 'owner-file': '/absent-owner', 'owner-sha256': 'a'.repeat(64), 'container-id': 'b'.repeat(64), 'token-file': '/absent-token' },
    { endpoint: 'https://127.0.0.1:1', 'token-file': '/absent-token' },
  ]) await expect(openCliOperations({ ...values, 'trace-context-file': f.path })).rejects.toThrow('Trace context requires')
  expect(await readdir(f.directory)).toEqual(['context.json'])
})
it.each([['preview', 'examples/echo.yaml', '--serve'], ['caller', 'stream', randomUUID()], ['runtime', 'status'], ['runtime', 'serve'], ['validate', 'examples/echo.yaml']].map(args => ({ args })))(
  'context option is unavailable for preview, SSE, startup, health and offline compilation: $args', async ({ args }) => {
    const result = await cli(...args, '--trace-context-file', '/absent-context')
    expect(result.exit).toBe(2); expect(result.output).toBe('')
  })
it('direct preview selector also refuses per-operation context before startup I/O', () => {
  for (const runtime of [undefined, 'local', 'docker']) expect(() => previewSelection({ runtime, 'trace-context-file': '/absent' })).toThrow('per-operation only')
})

function workflow() {
  return JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'cli-context', name: 'CLI context fixture' },
    spec: { inputSchema: { type: 'string' }, nodes: {
      start: { type: 'trigger', config: { modes: ['manual'] } },
      model: { type: 'llm', config: { provider: 'fixture', model: 'fixture-model', connection: { mode: 'workspace', id: 'fixture' },
        prompt: '${{ inputs }}', responseFormat: 'text', historyScope: 'none', generation: { maxTokens: 30, stream: false }, execution: { maxAttempts: 2, timeoutSeconds: 3 } } },
      end: { type: 'output', config: { value: '${{ nodes.model.output }}' } },
    }, edges: [{ from: 'start', to: 'model' }, { from: 'model', to: 'end' }] } })
}
async function listener(reply: (req: IncomingMessage, bytes: Buffer, res: import('node:http').ServerResponse) => void) {
  const server = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk); reply(req, Buffer.concat(chunks), res) })
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes) })
  cleanup.push(() => new Promise<void>(yes => { server.close(() => yes()); server.closeAllConnections() }))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('fixture bind')
  return `http://127.0.0.1:${address.port}`
}
it.each([0, 1])('actual local CLI retries carry only approved metadata and never persist it with sample=%s', async sampleRatio => {
  const models: { baggage: unknown; traceparent: unknown; body: string }[] = [], packets: Buffer[] = []
  const base = await listener((req, bytes, res) => {
    if (req.url === '/v1/chat/completions') {
      models.push({ baggage: req.headers.baggage, traceparent: req.headers.traceparent, body: bytes.toString() })
      if (models.length === 1) { res.writeHead(503); res.end(); return }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'output' } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }))
    } else { expect(req.headers.baggage).toBeUndefined(); packets.push(bytes); res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.end() }
  })
  const f = await file(JSON.stringify({ traceparent: parent, baggage: `request.class=${secret};flag,other=PRIVATE_DROP` }))
  const dataDirectory = join(f.directory, 'state'), input = join(f.directory, 'input.json'), yaml = join(f.directory, 'workflow.yaml'), policy = join(f.directory, 'telemetry.json')
  await writeFile(input, '"input"'); await writeFile(yaml, workflow())
  const telemetry = { endpoint: base + '/v1/traces', metricsEndpoint: base + '/v1/metrics', logsEndpoint: base + '/v1/logs',
    authentication: { kind: 'none' }, intervalMs: 60000, timeoutMs: 1000, flushTimeoutMs: 2000, baggageKeys: ['request.class'], sampleRatio }
  await writeFile(policy, JSON.stringify(telemetry), { mode: 0o600 })
  const owner = await LocalRuntime.open({ dataDirectory }); cleanup.push(() => owner.close())
  owner.configureConnection({ id: 'fixture', provider: 'fixture', protocol: 'openai-compatible', endpoint: base + '/v1', allowedModels: ['fixture-model'],
    authentication: { kind: 'none' }, tokenParameter: 'max_tokens', maxResponseBytes: 10000, maxRequestBytes: 10000, maxStreamEvents: 100,
    maxTimeoutSeconds: 5, tracePropagation: 'w3c', baggageKeys: ['request.class', 'other'] }, 0, 'fixture')
  await owner.close()
  const id = randomUUID(), args = ['run', yaml, '--input', input, '--id', id, '--data-dir', dataDirectory, '--telemetry-file', policy, '--trace-context-file', f.path]
  const started = await cli(...args)
  expect(started.exit).toBe(0); expect(started.result.output).toBe('output'); expect(models).toHaveLength(2)
  for (const model of models) { expect(model.baggage).toBe(`request.class=${secret};flag`); expect(model.traceparent).toMatch(/^00-1{32}-[a-f0-9]{16}-0[01]$/u); expect(model.body).not.toContain('PRIVATE_') }
  expect(started.output + started.error).not.toContain('PRIVATE_')
  await writeFile(f.path, JSON.stringify({ baggage: 'request.class=PRIVATE_REENTRY' }))
  expect((await cli(...args)).result).toEqual(started.result); expect(models).toHaveLength(2)
  const withoutContext = args.slice(0, -2).map(value => value === id ? randomUUID() : value)
  expect((await cli(...withoutContext)).exit).toBe(0); expect(models).toHaveLength(3); expect(models.at(-1)!.baggage).toBeUndefined()
  const evidence = await cli('runs', 'export', id, '--include-private', '--output', join(f.directory, 'evidence.json'), '--data-dir', dataDirectory)
  expect(evidence.exit).toBe(0); expect((await readFile(evidence.result.artifact.path, 'utf8'))).not.toContain('PRIVATE_')
  expect((await readFile(join(dataDirectory, 'runtime.sqlite'))).includes(Buffer.from(secret))).toBe(false)
  expect(packets.length).toBeGreaterThan(0)
  for (const packet of packets) expect(packet.includes(Buffer.from('PRIVATE_'))).toBe(false)
  // Suite CLI has its own local host path. Exercise the actual model, not just the option grammar.
  const author = await LocalRuntime.open({ dataDirectory }); cleanup.push(() => author.close())
  const project = author.editProject({ operation: 'create', yaml: workflow(), title: 'Suite context', actor: 'fixture' })
  const draft = author.editTest({ operation: 'create', actor: 'fixture', definition: { title: 'Suite context',
    project: { id: project.id, generation: project.generation, revision: project.acceptedRevision }, input: 'input',
    expectations: [{ kind: 'status', value: 'completed' }] } })
  const accepted = author.editTest({ operation: 'accept', id: draft.id, expectedGeneration: draft.generation, reviewedSha256: draft.sha256, actor: 'fixture' })
  const suite = createTestSuite({ title: 'Context suite', failurePolicy: 'stop', tests: [{ id: accepted.id, generation: accepted.generation, sha256: accepted.sha256 }] })
  const suitePath = join(f.directory, 'suite.json'); await writeFile(suitePath, JSON.stringify(suite.suite)); await author.close()
  await writeFile(f.path, JSON.stringify({ baggage: 'request.class=PRIVATE_SUITE' }))
  const suiteResult = await cli('tests', 'suite', 'run', suitePath, '--suite-sha256', suite.sha256, '--data-dir', dataDirectory, '--telemetry-file', policy, '--trace-context-file', f.path)
  expect(suiteResult.exit).toBe(0); expect(suiteResult.result.status).toBe('passed'); expect(models).toHaveLength(4)
  expect(models.at(-1)!.baggage).toBe('request.class=PRIVATE_SUITE'); expect(suiteResult.output + suiteResult.error).not.toContain('PRIVATE_')
  const operations = await openCliOperations({ 'data-dir': dataDirectory, 'telemetry-file': policy, 'trace-context-file': f.path })
  cleanup.push(() => operations.close())
  await writeFile(f.path, JSON.stringify({ baggage: 'request.class=PRIVATE_LATER_FILE' }))
  await operations.call({ operation: 'runs.start', id: randomUUID(), yaml: workflow(), input: 'input' })
  expect(models.at(-1)!.baggage).toBe('request.class=PRIVATE_SUITE')
  await operations.call({ operation: 'runs.start', id: randomUUID(), yaml: workflow(), input: 'input' }, parent)
  expect(models.at(-1)!.baggage).toBeUndefined()
  await operations.call({ operation: 'runs.start', id: randomUUID(), yaml: workflow(), input: 'input' }, { baggage: 'request.class=PRIVATE_EXPLICIT_OVERRIDE' })
  expect(models.at(-1)!.baggage).toBe('request.class=PRIVATE_EXPLICIT_OVERRIDE'); expect(models).toHaveLength(7)
  await operations.close()
  const raw = await readFile(join(dataDirectory, 'runtime.sqlite'))
  for (const value of [secret, 'PRIVATE_SUITE', 'PRIVATE_LATER_FILE', 'PRIVATE_EXPLICIT_OVERRIDE']) expect(raw.includes(Buffer.from(value))).toBe(false)
  for (const packet of packets) expect(packet.includes(Buffer.from('PRIVATE_'))).toBe(false)
})

it.each(['runtime', 'reviewer', 'caller', 'release'] as const)('explicit %s wire sends private carrier only as headers (not authority qualification)', async role => {
  const calls: { headers: IncomingMessage['headers']; body: any; path: string | undefined }[] = []
  const instanceId = randomUUID(), id = randomUUID(), pin = { id: randomUUID(), sha256: 'b'.repeat(64), revision: 'c'.repeat(64) }, requestId = randomUUID()
  const timestamp = '2026-10-03T00:00:00.000Z'
  const value = role === 'reviewer' ? { schemaVersion: 1, instanceId, result: { schemaVersion: 1, requestId, runId: id, attemptId: randomUUID(), revision: pin.revision, action: 'approve', at: timestamp, pauseAfter: true, status: 'paused' } }
    : { schemaVersion: 1, instanceId, result: { schemaVersion: 1, id, revision: pin.revision, release: { id: pin.id, sha256: pin.sha256 }, createdAt: timestamp, updatedAt: timestamp, status: 'completed', ...(role === 'caller' ? { output: 'fixture output' } : {}) } }
  const endpoint = await listener((req, bytes, res) => {
    calls.push({ headers: req.headers, body: JSON.parse(bytes.toString()), path: req.url })
    res.writeHead(200, { 'content-type': 'application/json', 'x-jevable-protocol': PROTOCOL_VERSION }); res.end(JSON.stringify(value))
  })
  const f = await file(JSON.stringify({ traceparent: parent, baggage: 'request.class = ' + secret + ' ; flag' }))
  const tokenFile = join(f.directory, 'token'), requestFile = join(f.directory, 'request.json'), pinFile = join(f.directory, 'pin.json')
  const credential = ['reviewer', 'caller'].includes(role) ? prepareGrantToken(randomUUID()).token : token
  await writeFile(tokenFile, credential, { mode: 0o600 }); await writeFile(pinFile, JSON.stringify(pin))
  await writeFile(requestFile, JSON.stringify(role === 'reviewer' ? { requestId, action: 'approve', pauseAfter: true } : { operation: 'runs.show', id }))
  const common = ['--endpoint', endpoint, '--token-file', tokenFile, '--trace-context-file', f.path]
  if (role === 'release') await new ReleaseClient(endpoint, token, pin.sha256).operation({ operation: 'runs.show', id }, (await readCliTraceContext(f.path))!)
  else {
    const args = role === 'runtime' ? ['runtime', 'request', requestFile] : role === 'reviewer' ? ['reviewer', 'decide', requestFile, '--instance-id', instanceId]
      : ['caller', 'read', id, '--instance-id', instanceId, '--release-pin-file', pinFile]
    const result = await cli(...args, ...common); expect(result.exit).toBe(0); expect(result.output + result.error).not.toContain('PRIVATE_')
  }
  expect(calls).toHaveLength(1); expect(calls[0]!.headers).toMatchObject({ traceparent: parent, baggage: 'request.class=' + secret + ';flag', authorization: 'Bearer ' + credential })
  expect(JSON.stringify(calls[0]!.body)).not.toContain('PRIVATE_')
  if (role === 'release') expect(calls[0]!.body.releaseSha256).toBe(pin.sha256)
})
it('command help discovers private file input without reading it or exposing a value flag', async () => {
  for (const args of [['run'], ['runtime', 'request'], ['reviewer', 'decide'], ['caller', 'start']]) {
    const result = await cli(...args, '--help', '--json'); expect(result.exit).toBe(0)
    expect(result.output).toContain('trace-context-file'); expect(result.output).not.toContain('PRIVATE_')
  }
})
it('suite HTTP host snapshots context before its context-free handshake (wire-only fixture)', async () => {
  const calls: { headers: IncomingMessage['headers']; path: string | undefined }[] = [], instanceId = randomUUID()
  const endpoint = await listener((req, _bytes, res) => {
    calls.push({ headers: req.headers, path: req.url })
    res.writeHead(200, { 'content-type': 'application/json', 'x-jevable-protocol': PROTOCOL_VERSION })
    res.end(JSON.stringify(req.url === '/v1/capabilities' ? { instanceId, api: { protocol: PROTOCOL_VERSION } } : { schemaVersion: 1, instanceId, result: { fixture: true } }))
  })
  const client = new RuntimeClient(endpoint, token), context = { traceparent: parent, baggage: 'request.class=' + secret }
  expect(() => createHttpTestSuiteHost(client, { baggage: 'PRIVATE_INVALID%' })).toThrow('invalid-command'); expect(calls).toHaveLength(0)
  const host = createHttpTestSuiteHost(client, context); context.baggage = 'request.class=PRIVATE_MUTATION'
  expect(await host.project(randomUUID())).toEqual({ fixture: true }); expect(calls).toHaveLength(2)
  expect(calls[0]!.headers.baggage).toBeUndefined(); expect(calls[0]!.headers.traceparent).toBeUndefined()
  expect(calls[1]!.headers).toMatchObject({ baggage: 'request.class=' + secret, traceparent: parent, 'x-jevable-instance': instanceId })
})
it.each(['local', 'http'] as const)('suite %s rejects invalid context before storage or credential access', async selection => {
  const f = await file('{"baggage":"PRIVATE_BAD%"}'), path = join(f.directory, 'suite.json')
  const suite = createTestSuite({ title: 'Context refusal', failurePolicy: 'stop', tests: [{ id: randomUUID(), generation: 1, sha256: 'a'.repeat(64) }] })
  await writeFile(path, JSON.stringify(suite.suite))
  await expect(suiteFromCli('run', path, { 'suite-sha256': suite.sha256, 'trace-context-file': f.path,
    ...(selection === 'local' ? { 'data-dir': join(f.directory, 'state') } : { endpoint: 'http://127.0.0.1:1', 'token-file': '/absent-token' }) }, () => {})).rejects.toThrow('Trace context requires')
  expect((await readdir(f.directory)).sort()).toEqual(['context.json', 'suite.json'])
})

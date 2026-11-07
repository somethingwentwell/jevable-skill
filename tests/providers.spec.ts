import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { LocalRuntime } from '../src/runtime/index.ts'
import type { ProviderConnection } from '../src/providers/config.ts'
import { ProviderStore } from '../src/providers/store.ts'
import { main } from '../src/cli.ts'

type Request = { body: Record<string, unknown>; authorization: string | undefined; url: string | undefined }
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(reply: (request: Request, response: ServerResponse) => void) {
  const requests: Request[] = []
  const server = createServer(async (request, response) => {
    let text = ''
    for await (const chunk of request) text += String(chunk)
    const entry = { body: JSON.parse(text) as Record<string, unknown>, authorization: request.headers.authorization, url: request.url }
    requests.push(entry)
    reply(entry, response)
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()) }))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('expected TCP listener')
  return { endpoint: `http://127.0.0.1:${address.port}/v1`, requests }
}
function config(endpoint: string): ProviderConnection {
  return { id: 'settings-default', provider: 'fixture', protocol: 'openai-compatible', endpoint,
    allowedModels: ['fixture-model'], authentication: { kind: 'bearer', credentialRef: 'fixture/key' },
    tokenParameter: 'max_tokens', maxResponseBytes: 100_000, maxRequestBytes: 100_000, maxStreamEvents: 1000, maxTimeoutSeconds: 5 }
}
async function owner(connection?: ProviderConnection) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-provider-'))
  const runtime = await LocalRuntime.open({ dataDirectory })
  cleanup.push(() => runtime.close())
  if (connection) {
    runtime.configureConnection(connection, 0, 'local:test')
    runtime.setCredential('fixture/key', 'fixture-private-token', 0, 'local:test')
  }
  return { dataDirectory, runtime }
}
function workflow(stream = false, decision = false, maxAttempts = 1) {
  const execution = { timeoutSeconds: 2, maxAttempts }
  const model = { provider: 'fixture', model: 'fixture-model', connection: { mode: 'workspace', id: 'settings-default' },
    prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 30, stream }, execution, historyScope: 'none' }
  const nodes: Record<string, unknown> = { start: { type: 'trigger', config: { modes: ['manual'] } },
    draft: { type: 'llm', config: model }, review: { type: 'humanApproval', config: { title: 'Review draft',
      input: '${{ nodes.draft.output }}', inputSchema: { type: 'string' }, actions: ['approve', 'reject'], expiresAfter: '1h', onReject: 'cancelled', onTimeout: 'expired' } },
    end: { type: 'output', config: { value: '${{ nodes.draft.output }}' } } }
  const edges: { from: string; to: string; port?: string }[] = [{ from: 'start', to: decision ? 'judge' : 'draft' },
    { from: 'draft', to: 'review' }, { from: 'review', to: 'end', port: 'approve' }]
  if (decision) {
    nodes.judge = { type: 'decision', config: { provider: 'llm', model: 'fixture-model', connection: model.connection,
      llm: { provider: 'fixture', generation: model.generation }, execution, state: '${{ inputs }}',
      questions: { urgent: { type: 'noul', instructions: 'Is the ticket urgent?' } } } }
    nodes.route = { type: 'rule', config: { mode: 'ifElse', condition: '${{ nodes.judge.output.urgent.probability >= 0.5 }}' } }
    nodes.skipped = { type: 'output', config: { value: 'not urgent' } }
    edges.push({ from: 'judge', to: 'route' }, { from: 'route', to: 'draft', port: 'true' }, { from: 'route', to: 'skipped', port: 'false' })
  }
  return JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'model-test', name: 'Model test' },
    spec: { inputSchema: { type: 'string' }, nodes, edges } })
}

function completion(request: Request, response: ServerResponse) {
  const structured = Boolean(request.body.tools)
  const output = structured ? JSON.stringify({ value: { urgent: { type: 'noul', probability: 0.9, confidence: 0.8 } } }) : 'A real fixture response'
  const metadata = { id: 'fixture-response', model: 'fixture-model-2026' }
  const usage = { prompt_tokens: 12, completion_tokens: 8 }
  if (!request.body.stream) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ...metadata, usage, choices: [{ index: 0, finish_reason: structured ? 'tool_calls' : 'stop',
      message: { role: 'assistant', content: structured ? null : output, ...(structured ? {
        tool_calls: [{ id: 'collect-1', type: 'function', function: { name: 'jevable_return_result', arguments: output } }],
      } : {}) } }] }))
    return
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const chunk = (delta: unknown, finish_reason: string | null = null) => ({ ...metadata, choices: [{ index: 0, delta, finish_reason }] })
  const events = [chunk({ role: 'assistant' }),
    structured ? chunk({ tool_calls: [{ index: 0, id: 'collect-1', type: 'function', function: { name: 'jevable_return_result', arguments: output.slice(0, 20) } }] })
      : chunk({ content: output.slice(0, 5) }),
    structured ? chunk({ tool_calls: [{ index: 0, function: { arguments: output.slice(20) } }] }) : chunk({ content: output.slice(5) }),
    chunk({}, structured ? 'tool_calls' : 'stop'), { ...metadata, choices: [], usage }]
  const body = events.map(value => `data: ${JSON.stringify(value)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n'
  // Exercise parser fragments rather than assuming HTTP chunks align with SSE events.
  for (let index = 0; index < body.length; index += 17) response.write(body.slice(index, index + 17))
  response.end()
}

describe('standalone configured providers', () => {
  it('aborts an in-flight transport after a durable cancellation request without redispatch', async () => {
    let reached!: () => void
    const started = new Promise<void>(resolve => { reached = resolve })
    const server = await fixture((_request, response) => { reached(); response.on('error', () => {}) })
    const { runtime, dataDirectory } = await owner(config(server.endpoint)), id = randomUUID()
    const running = runtime.run(workflow(), 'private cancellation prompt', { id })
    await started
    runtime.cancel(id, randomUUID(), 'local:owner')
    const stopped = await running
    expect(stopped.state).toMatchObject({ status: 'cancelled', previousStatus: 'executing', next: 'draft' })
    expect(server.requests).toHaveLength(1)
    const db = new DatabaseSync(join(dataDirectory, 'runtime.sqlite'))
    const row = db.prepare('SELECT record FROM model_calls').get() as { record: string }
    expect(JSON.parse(row.record).result).toMatchObject({ status: 'failed', code: 'cancelled' }); db.close()
    expect(await runtime.run(workflow(), 'private cancellation prompt', { id })).toEqual(stopped)
    expect(server.requests).toHaveLength(1)
  })

  it.each([false, true])('runs typed Decision → Rule → LLM → Approval with streaming=%s and verifies it offline after restart', async stream => {
    const server = await fixture(completion)
    const { runtime, dataDirectory } = await owner(config(server.endpoint))
    expect(await runtime.check(workflow(stream, true))).toMatchObject({ status: 'valid', runtimeReadiness: 'ready', execution: 'not-run' })
    expect(server.requests).toHaveLength(0)
    const run = await runtime.run(workflow(stream, true), 'An urgent ticket')
    expect(run.state.status).toBe('waiting')
    if (run.state.status !== 'waiting') throw Error('expected review')
    expect(run.state.steps.find(step => step.nodeId === 'judge')?.output).toEqual({ urgent: { type: 'noul', probability: 0.9, confidence: 0.8 } })
    expect(run.state.steps.find(step => step.nodeId === 'draft')?.inspection?.modelUsage).toEqual({ tries: 1, inputTokens: 12, outputTokens: 8 })
    expect(server.requests).toHaveLength(2)
    expect(server.requests.every(request => request.authorization === 'Bearer fixture-private-token' && request.url === '/v1/chat/completions')).toBe(true)
    await runtime.close()
    const reopened = await LocalRuntime.open({ dataDirectory })
    cleanup.push(() => reopened.close())
    expect((await reopened.show(run.id)).state).toEqual(run.state)
    const finished = await reopened.decide(run.id, run.state.attempt.id, 'approve', 'local:reviewer')
    expect(finished.state).toMatchObject({ status: 'completed', output: 'A real fixture response' })
    expect(server.requests).toHaveLength(2)
    const changed = { ...config(server.endpoint), allowedModels: ['different-model'] }
    reopened.configureConnection(changed, 1, 'local:test')
    reopened.setCredential('fixture/key', 'rotated-secret', 1, 'local:test')
    expect((await reopened.show(run.id)).state.status).toBe('completed')
    expect(await reopened.check(workflow())).toMatchObject({ runtimeReadiness: 'unavailable', diagnostics: [{ code: 'model-not-allowed' }] })
    const database = new DatabaseSync(join(dataDirectory, 'runtime.sqlite'), { readOnly: true })
    const evidence = database.prepare('SELECT record FROM model_calls').all()
    database.close()
    expect(JSON.stringify(evidence)).not.toContain('fixture-private-token')
    expect(JSON.stringify(evidence)).not.toContain('rotated-secret')
    expect(JSON.stringify(evidence)).toContain('fixture-model-2026')
  })

  it.each([false, true])('retains retried typed Decision and LLM evidence across SQLite restart, streaming=%s', async stream => {
    let calls = 0
    const server = await fixture((request, response) => {
      if (++calls % 2 === 1) { response.writeHead(503); response.end('private transient detail') }
      else completion(request, response)
    })
    const { runtime, dataDirectory } = await owner(config(server.endpoint)), source = workflow(stream, true, 2)
    const run = await runtime.run(source, 'An urgent ticket')
    expect(run.state.status).toBe('waiting')
    if (run.state.status !== 'waiting') throw Error('expected approval')
    expect(run.state.steps.filter(step => ['judge', 'draft'].includes(step.nodeId)).map(step => step.inspection?.modelUsage?.tries)).toEqual([2, 2])
    expect(server.requests).toHaveLength(4)
    await runtime.close()
    const reopened = await LocalRuntime.open({ dataDirectory }); cleanup.push(() => reopened.close())
    expect((await reopened.show(run.id)).state).toEqual(run.state)
    expect((await reopened.decide(run.id, run.state.attempt.id, 'approve', 'local:reviewer')).state.status).toBe('completed')
    expect(server.requests).toHaveLength(4)
  })

  it('rejects missing credentials, disallowed models and over-limit retries before starting nodes', async () => {
    const { runtime } = await owner()
    runtime.configureConnection(config('https://models.example.test/v1'), 0, 'local:test')
    expect(await runtime.check(workflow())).toMatchObject({ runtimeReadiness: 'unavailable', diagnostics: [{ code: 'missing-credential' }] })
    await expect(runtime.run(workflow(), 'private input')).rejects.toMatchObject({ code: 'missing-credential' })
    runtime.setCredential('fixture/key', 'private-fixture-key', 0, 'local:test')
    const source = JSON.parse(workflow()); source.spec.nodes.draft.config.execution.maxAttempts = 11
    await expect(runtime.run(JSON.stringify(source), 'input')).rejects.toMatchObject({ code: 'unsupported-settings' })
    expect(runtime.list()).toEqual([])
  })

  it.each(['http://remote.example.test/v1', 'https://u:p@models.example.test/v1', 'https://models.example.test/v1?key=private'])('refuses unsafe configured endpoint %s', async endpoint => {
    const { runtime } = await owner()
    expect(() => runtime.configureConnection(config(endpoint), 0, 'local:test')).toThrow('invalid-config')
    expect(runtime.connections()).toEqual([])
  })

  it('refuses stale configuration and credential writes and audits only references', async () => {
    const { runtime } = await owner(config('https://models.example.test/v1'))
    expect(() => runtime.configureConnection(config('https://different.example.test/v1'), 0, 'local:test')).toThrow('conflict')
    expect(() => runtime.setCredential('fixture/key', 'other-secret', 0, 'local:test')).toThrow('conflict')
    expect(JSON.stringify(runtime.providerAudit())).not.toContain('fixture-private-token')
    expect(runtime.providerAudit()).toHaveLength(2)
    expect(runtime.credentialStatus('fixture/key')).toMatchObject({ configured: true, generation: 1 })
  })

  it.each(['redirect', 'http-error', 'oversize', 'unfinished', 'wrong-tool'])('refuses %s without redispatch or secret diagnostics', async mode => {
    const server = await fixture((request, response) => {
      if (mode === 'redirect') { response.writeHead(307, { location: `${server.endpoint}/elsewhere` }); response.end(); return }
      if (mode === 'http-error') { response.writeHead(500); response.end('provider-error-with-private-value'); return }
      if (mode === 'oversize') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('x'.repeat(150_000)); return }
      if (mode === 'unfinished') { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n'); return }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [
        { id: 'evil', type: 'function', function: { name: 'send_email', arguments: '{}' } },
      ] } }] }))
    })
    const { runtime } = await owner(config(server.endpoint)), id = randomUUID(), yaml = workflow(mode === 'unfinished')
    await expect(runtime.run(yaml, 'private input', { id })).rejects.toThrow(/^Jevable provider operation failed:/u)
    const saved = await runtime.run(yaml, 'private input', { id })
    expect(saved.state.status).toBe('executing')
    await expect(runtime.resume(id)).rejects.toMatchObject({ code: 'conflict' })
    expect(server.requests).toHaveLength(1)
    expect(JSON.stringify(runtime.providerAudit())).not.toContain('provider-error-with-private-value')
  })

  it('does not dispatch if durable model-request admission fails', async () => {
    const server = await fixture(completion), { runtime } = await owner(config(server.endpoint))
    vi.spyOn(ProviderStore.prototype, 'saveEvidence').mockImplementation(() => { throw Error('disk unavailable') })
    await expect(runtime.run(workflow(), 'input')).rejects.toThrow('disk unavailable')
    expect(server.requests).toHaveLength(0)
  })

  it('does not change the route or repeat a model call when response evidence cannot commit', async () => {
    const server = await fixture(completion), { runtime } = await owner(config(server.endpoint)), id = randomUUID()
    const save = ProviderStore.prototype.saveEvidence
    vi.spyOn(ProviderStore.prototype, 'saveEvidence').mockImplementation(function (this: ProviderStore, record) {
      if (record.result.status === 'completed') throw Error('response write failed')
      return save.call(this, record)
    })
    await expect(runtime.run(workflow(), 'input', { id })).rejects.toThrow('response write failed')
    expect((await runtime.show(id)).state.status).toBe('executing')
    expect(server.requests).toHaveLength(1)
  })

  it('accepts a private credential file through the CLI without printing its content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-credential-cli-')), file = join(directory, 'key.txt'), data = join(directory, 'state')
    await writeFile(file, 'never-print-this-secret\n', { mode: 0o600 })
    let output = ''
    const io = { out: (text: string) => { output += text }, err: (text: string) => { output += text } }
    expect(await main(['credentials', 'set', 'fixture/key', '--file', file, '--expected-generation', '0', '--data-dir', data], io)).toBe(0)
    expect(output).not.toContain('never-print-this-secret')
    expect(JSON.parse(output)).toMatchObject({ ref: 'fixture/key', configured: true, generation: 1 })
    await chmod(file, 0o644)
    expect(await main(['credentials', 'set', 'fixture/other', '--file', file, '--expected-generation', '0', '--data-dir', data], io)).toBe(1)
    expect(output).not.toContain('never-print-this-secret')
    expect(await readFile(file, 'utf8')).toBe('never-print-this-secret\n')
  })

  it('times out an unfinished response body without retrying', async () => {
    const server = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(': heartbeat\n\n')
    })
    const { runtime } = await owner(config(server.endpoint)), id = randomUUID(), source = JSON.parse(workflow(true))
    source.spec.nodes.draft.config.execution.timeoutSeconds = 1
    await expect(runtime.run(JSON.stringify(source), 'input', { id })).rejects.toMatchObject({ code: 'timeout' })
    expect(server.requests).toHaveLength(1)
    expect((await runtime.show(id)).state.status).toBe('executing')
  })

  it('migrates a version-1 database without changing its existing run evidence', async () => {
    const { runtime, dataDirectory } = await owner()
    const yaml = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
    const run = await runtime.run(yaml, 'retained across migration')
    const events = await runtime.events(run.id)
    await runtime.close()
    const database = new DatabaseSync(join(dataDirectory, 'runtime.sqlite'))
    database.exec('DROP TABLE provider_connections; DROP TABLE provider_credentials; DROP TABLE model_calls; DROP TABLE provider_audit; PRAGMA user_version=1;')
    database.close()
    const migrated = await LocalRuntime.open({ dataDirectory })
    cleanup.push(() => migrated.close())
    expect(await migrated.show(run.id)).toEqual(run)
    expect(await migrated.events(run.id)).toEqual(events)
    expect(migrated.connections()).toEqual([])
    const reopened = new DatabaseSync(join(dataDirectory, 'runtime.sqlite'), { readOnly: true })
    expect(reopened.prepare('PRAGMA user_version').get()?.user_version).toBe(18)
    expect(migrated.testCases()).toEqual([])
    expect(migrated.releases()).toEqual([])
    reopened.close()
  })

  it('detects modified durable model requests during restart without calling the provider', async () => {
    const server = await fixture(completion), { runtime, dataDirectory } = await owner(config(server.endpoint))
    await runtime.run(workflow(), 'original input')
    await runtime.close()
    const database = new DatabaseSync(join(dataDirectory, 'runtime.sqlite'))
    const row = database.prepare('SELECT attempt_id, record FROM model_calls').get() as { attempt_id: string; record: string }
    const record = JSON.parse(row.record)
    record.request.messages[0].content = 'altered request'
    database.prepare('UPDATE model_calls SET record=? WHERE attempt_id=?').run(JSON.stringify(record), row.attempt_id)
    database.close()
    await expect(LocalRuntime.open({ dataDirectory })).rejects.toMatchObject({ code: 'corrupt-evidence' })
    expect(server.requests).toHaveLength(1)
  })
})

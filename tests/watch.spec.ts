import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { watchRun, type RunWatchOptions } from '../src/http/watch.ts'
import { startRuntimeService, RuntimeClient } from '../src/http/index.ts'
import { watchFromCli } from '../src/cli/watch.ts'
import { main } from '../src/cli.ts'
import { PROTOCOL_VERSION } from '../src/capabilities.ts'

const id = randomUUID(), instanceId = randomUUID(), hash = 'a'.repeat(64), at = '2026-09-30T00:00:00.000Z'
function response(status = 'executing', checkpointSha256 = hash) {
  return { schemaVersion: 1, instanceId, result: { schemaVersion: 1, id, revision: hash, checkpointSha256, status,
    createdAt: at, updatedAt: at, steps: [{ input: 'PRIVATE_INPUT', output: 'PRIVATE_OUTPUT' }], output: 'PRIVATE_RESULT', actor: 'PRIVATE_ACTOR' } }
}
const collect = async (client: Parameters<typeof watchRun>[0], options: RunWatchOptions = {}) => {
  const events = []; for await (const event of watchRun(client, id, { intervalMs: 100, durationMs: 2000, ...options })) events.push(event); return events
}
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

it('polls only retained state, emits changes once and never prints private response fields', async () => {
  const operation = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(response()).mockResolvedValue(response('completed', 'b'.repeat(64)))
  const events = await collect({ operation })
  expect(operation.mock.calls).toEqual(Array(3).fill([{ operation: 'runs.show', id }]))
  expect(events.map(e => e.type)).toEqual(['snapshot', 'snapshot', 'stopped'])
  expect(events.at(-1)).toMatchObject({ reason: 'completed', polls: 3, execution: 'not-requested', last: { recordedSteps: 1 } })
  expect(JSON.stringify(events)).not.toContain('PRIVATE_')
})
it.each(['waiting', 'paused'])('stops for attention at %s without acting', async status => {
  const operation = vi.fn().mockResolvedValue(response(status)), events = await collect({ operation })
  expect(events.at(-1)).toMatchObject({ reason: 'attention', polls: 1 }); expect(operation).toHaveBeenCalledTimes(1)
})
it.each(['failed', 'cancelled'])('stops at terminal %s', async status => {
  expect((await collect({ operation: async () => response(status) })).at(-1)).toMatchObject({ reason: status })
})
it('follows approval/paused changes only when requested and observes externally completed work', async () => {
  const operation = vi.fn().mockResolvedValueOnce(response('waiting')).mockResolvedValueOnce(response('paused', 'b'.repeat(64))).mockResolvedValue(response('completed', 'c'.repeat(64)))
  const events = await collect({ operation }, { follow: true }); expect(events.filter(e => e.type === 'snapshot')).toHaveLength(3)
  expect(events.at(-1)).toMatchObject({ reason: 'completed' })
})
it.each(['instance', 'revision', 'id', 'created'])('stops on changed %s identity, without following another owner or run', async field => {
  const next = response('completed', 'b'.repeat(64))
  if (field === 'instance') next.instanceId = randomUUID()
  if (field === 'revision') next.result.revision = 'c'.repeat(64)
  if (field === 'id') next.result.id = randomUUID()
  if (field === 'created') next.result.createdAt = '2026-09-30T00:00:01.000Z'
  const operation = vi.fn().mockResolvedValueOnce(response()).mockResolvedValue(next)
  await expect(collect({ operation })).rejects.toMatchObject({ code: 'watch-identity-changed' }); expect(operation).toHaveBeenCalledTimes(2)
})
it('sanitizes malformed responses and remote failures, and never retries a failed read', async () => {
  await expect(collect({ operation: async () => ({ private: 'PRIVATE_PAYLOAD' }) })).rejects.toMatchObject({ code: 'invalid-watch-response' })
  const operation = vi.fn().mockRejectedValue(Error('PRIVATE_SECRET'))
  await expect(collect({ operation })).rejects.toMatchObject({ code: 'watch-read-failed' }); expect(operation).toHaveBeenCalledTimes(1)
})
it('ignores consumer mutation of yielded observations', async () => {
  const operation = vi.fn().mockResolvedValueOnce(response()).mockResolvedValue(response('completed'))
  const watcher = watchRun({ operation }, id, { intervalMs: 100 })
  const first = await watcher.next(); if (first.value?.type !== 'snapshot') throw Error('Expected snapshot')
  first.value.observation.revision = 'f'.repeat(64); first.value.observation.status = 'cancelled'
  expect((await watcher.next()).value).toMatchObject({ observation: { status: 'completed', revision: hash } }); await watcher.return(undefined)
})
it('reports a bounded deadline without interpreting executing as a failed workflow', async () => {
  const operation = vi.fn().mockResolvedValue(response())
  const events = await collect({ operation }, { durationMs: 30 })
  expect(events.at(-1)).toMatchObject({ reason: 'deadline', last: { status: 'executing' }, polls: 1 }); expect(operation).toHaveBeenCalledTimes(1)
})
it('suppresses late responses and deadlines after slow reads without a second read', async () => {
  const operation = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 30)); return response('completed') })
  expect(await collect({ operation }, { durationMs: 10 })).toMatchObject([{ type: 'stopped', reason: 'deadline', last: null, polls: 1 }])
})
it('interrupts idle delays and suppresses late in-flight snapshots without cancelling a run', async () => {
  const controller = new AbortController(), operation = vi.fn().mockResolvedValue(response())
  const watcher = watchRun({ operation }, id, { intervalMs: 60000, signal: controller.signal })
  await watcher.next(); const waiting = watcher.next(); controller.abort()
  expect((await waiting).value).toMatchObject({ reason: 'interrupted', polls: 1 }); await watcher.return(undefined)
  const pending = Promise.withResolvers<unknown>(), other = new AbortController()
  const task = collect({ operation: () => pending.promise }, { signal: other.signal }); other.abort(); pending.resolve(response('completed'))
  expect(await task).toMatchObject([{ reason: 'interrupted', last: null }])
  const never = vi.fn(); await collect({ operation: never }, { signal: other.signal }); expect(never).not.toHaveBeenCalled()
})
it.each([{ intervalMs: 0 }, { durationMs: 3600001 }, { follow: 'yes' }, { unknown: true }])('rejects invalid settings before reads: %j', async options => {
  const operation = vi.fn(); await expect(collect({ operation }, options as RunWatchOptions)).rejects.toMatchObject({ code: 'invalid-watch-options' }); expect(operation).not.toHaveBeenCalled()
})
it.each([['--data-dir', 'forbidden'], ['--interval-ms', '99'], ['--duration-ms', '1e3'], ['--release-sha256', 'wrong']])('rejects bad CLI flags before touching credential files: %j', async flags => {
  let err = ''; const code = await main(['runs', 'watch', id, '--endpoint', 'http://127.0.0.1:1234', '--token-file', '/missing-secret', ...flags], { out: () => {}, err: text => { err += text } })
  expect(code).toBe(2); expect(JSON.parse(err).code).toBe('invalid-input')
})
it('observes a real owning service without acquiring storage or changing its retained checkpoint/events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-watch-')), token = randomBytes(32).toString('hex'), tokenFile = join(directory, 'token')
  await writeFile(tokenFile, token, { mode: 0o600 })
  const service = await startRuntimeService({ runtime: { dataDirectory: join(directory, 'state') }, token, actor: 'watch-fixture' })
  cleanup.push(async () => { await service.close(); await service.closed })
  const client = new RuntimeClient(service.url, token), yaml = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
  const runId = randomUUID(), started: any = await client.operation({ operation: 'runs.start', id: runId, yaml, input: { message: 'PRIVATE_APPROVAL' } })
  const before = await client.operation({ operation: 'runs.events', id: runId }), signals = new EventEmitter(), lines: string[] = []
  expect(await watchFromCli(runId, { endpoint: service.url, 'token-file': tokenFile }, line => lines.push(line), signals)).toBe(3)
  expect(lines.map(line => JSON.parse(line))).toMatchObject([{ type: 'snapshot', observation: { status: 'waiting' } }, { type: 'stopped', reason: 'attention' }])
  expect(lines.join('')).not.toMatch(/PRIVATE_APPROVAL|watch-fixture/)
  expect(await client.operation({ operation: 'runs.events', id: runId })).toEqual(before)
  expect(await client.operation({ operation: 'runs.show', id: runId })).toEqual(started)
  expect(signals.listenerCount('SIGINT') + signals.listenerCount('SIGTERM')).toBe(0)
  expect((await readdir(directory)).sort()).toEqual(['state', 'token'])
})
it('cleans up signal handlers and stops a CLI observer on SIGTERM while a read is in flight', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-watch-signal-')), tokenFile = join(directory, 'token'), signals = new EventEmitter()
  await writeFile(tokenFile, 'a'.repeat(64), { mode: 0o600 })
  const server = createServer((_req, res) => { signals.emit('SIGTERM'); res.writeHead(200, { 'Content-Type': 'application/json', 'X-Jevable-Protocol': PROTOCOL_VERSION }); res.end(JSON.stringify(response('completed'))) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address(); if (!address || typeof address === 'string') throw Error()
  const lines: string[] = []
  expect(await watchFromCli(id, { endpoint: `http://127.0.0.1:${address.port}`, 'token-file': tokenFile }, line => lines.push(line), signals)).toBe(143)
  expect(lines.map(line => JSON.parse(line))).toMatchObject([{ reason: 'interrupted', last: null }])
  expect(signals.listenerCount('SIGTERM') + signals.listenerCount('SIGINT')).toBe(0)
})

it('observes an actual in-flight attempt then completion without dispatching another model call', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-watch-active-')), token = randomBytes(32).toString('hex')
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>()
  let calls = 0
  const service = await startRuntimeService({ runtime: { dataDirectory: directory, models: {
    admit() {}, async execute() { calls++; entered.resolve(); await finish.promise; return { output: 'PRIVATE_MODEL_OUTPUT', usage: { tries: 1 } } }, async verify() {},
  } }, token, actor: 'watch-active-fixture' })
  cleanup.push(async () => { finish.resolve(); await service.close(); await service.closed })
  const client = new RuntimeClient(service.url, token), runId = randomUUID()
  const yaml = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'watch', name: 'Watch' },
    spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
      write: { type: 'llm', config: { provider: 'fixture', model: 'fixture', connection: { mode: 'workspace', id: 'fixture' },
        prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 20, stream: false },
        execution: { timeoutSeconds: 60, maxAttempts: 1 }, historyScope: 'none' } },
      end: { type: 'output', config: { value: '${{ nodes.write.output }}' } } },
      edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }] } })
  const running = client.operation({ operation: 'runs.start', id: runId, yaml, input: 'PRIVATE_MODEL_INPUT' })
  void running.catch(() => {}); cleanup.push(async () => { finish.resolve(); await running.catch(() => {}) })
  await entered.promise
  const watcher = watchRun(client, runId, { intervalMs: 100, durationMs: 3000 })
  try {
    const first = (await watcher.next()).value; expect(first).toMatchObject({ type: 'snapshot', observation: { status: 'executing' } })
    finish.resolve(); expect(await running).toMatchObject({ result: { status: 'completed' } })
    const second = (await watcher.next()).value; expect(second).toMatchObject({ type: 'snapshot', observation: { status: 'completed' } })
    expect(JSON.stringify([first, second])).not.toContain('PRIVATE_'); expect(calls).toBe(1)
    expect((await watcher.next()).value).toMatchObject({ reason: 'completed', polls: 2 })
  } finally { await watcher.return(undefined) }
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID, randomBytes } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { LocalRuntime, prepareGrantToken } from '../src/runtime/index.ts'
import { CallerClient, RuntimeClient, startRuntimeService } from '../src/http/index.ts'
import { observeCallerRun, callerStreamRequestSchema, encodeCallerStreamEvent, admitCallerStreamEvent, type CallerStreamEvent } from '../src/http/caller-stream.ts'
import { callerStreamFromCli } from '../src/cli/caller.ts'
import { main } from '../src/cli.ts'
import { CORE_VERSION, PROTOCOL_VERSION } from '../src/capabilities.ts'

const source = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const collect = async <T>(items: AsyncIterable<T>) => { const result: T[] = []; for await (const item of items) result.push(item); return result }

async function fixture({ paused = false, enabled = true, capacity = 16, yaml = source } = {}) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-caller-stream-')), token = randomBytes(32).toString('hex')
  const runtime = await LocalRuntime.open({ dataDirectory })
  const project = await runtime.editProject({ operation: 'create', yaml, title: 'Stream fixture', actor: 'owner:test' })
  const release = await runtime.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision,
    version: '1.0.0', actor: 'owner:test', runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
  const pin = { id: release.snapshot.id, sha256: release.sha256, revision: project.acceptedRevision }, grants = []
  for (const permissions of [['start', 'read', 'control'], ['start', 'read'], ['start'], ['read']] as const) {
    const grant = prepareGrantToken(randomUUID())
    await runtime.issueGrant({ id: grant.id, tokenSha256: grant.tokenSha256, actor: 'owner:test',
      expiresAt: new Date(Date.now() + 3600000).toISOString(), scope: { kind: 'caller', release: pin, permissions: [...permissions] } })
    grants.push(grant)
  }
  const grant = grants[0]!, id = randomUUID()
  await runtime.startWithGrant(grant.token, yaml === source ? 'PRIVATE_STREAM_INPUT' : { message: 'PRIVATE_STREAM_INPUT' }, { id, paused })
  await runtime.close()
  const service = await startRuntimeService({ runtime: { dataDirectory }, token, actor: 'owner:service', callerOperations: enabled, maxConcurrentRequests: capacity })
  cleanup.push(async () => { await service.close(); await service.closed })
  const owner = new RuntimeClient(service.url, token), client = new CallerClient(service.url, grant.token, service.instanceId, pin)
  const events = async () => (await owner.operation({ operation: 'runs.events', id }) as any).result
  const raw = (body: unknown = { id, release: pin }, headers: Record<string, string> = {}, method = 'POST', path = '/v1/caller/stream') => fetch(service.url + path,
    { method, headers: { authorization: `Bearer ${grant.token}`, 'content-type': 'application/json', accept: 'text/event-stream',
      'x-jevable-protocol': PROTOCOL_VERSION, 'x-jevable-instance': service.instanceId, ...headers }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) })
  return { dataDirectory, token, pin, grant, grants, id, service, owner, client, events, raw }
}

describe('caller stream actual standalone ownership and read authorization', () => {
  it('projects completed metadata without output/input/grant/steps and leaves exact journal evidence unchanged', async () => {
    const f = await fixture(), before = await f.events(), calls = vi.spyOn(LocalRuntime.prototype, 'readWithGrant')
    const result = await collect(f.client.stream(f.id.toUpperCase()))
    expect(result).toMatchObject([{ type: 'snapshot', sequence: 1, result: { id: f.id, status: 'completed', release: { id: f.pin.id } } },
      { type: 'stopped', sequence: 2, reason: 'completed', execution: 'not-requested' }])
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|"(?:output|input|yaml|steps|actor|grantId|scope|checkpointSha256)"/)
    expect(calls).toHaveBeenCalledTimes(1); expect(await f.events()).toEqual(before)
    expect((await f.client.read(f.id)).result.output).toBe('PRIVATE_STREAM_INPUT')
    const raw = await f.raw()
    expect(raw.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    expect(raw.headers.get('cache-control')).toBe('no-store')
    expect(await raw.text()).not.toMatch(/PRIVATE|^id:|^retry:/m)
    expect(await f.events()).toEqual(before)
  })
  it.each(['paused', 'waiting'])('stops at %s without following by default or settling execution/approval', async status => {
    const yaml = status === 'waiting' ? await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8') : source
    const f = await fixture({ paused: status === 'paused', yaml }), before = await f.events()
    const result = await collect(f.client.stream(f.id))
    expect(result).toMatchObject([{ type: 'snapshot', result: { status } }, { type: 'stopped', reason: 'attention' }])
    expect(await f.events()).toEqual(before)
  })
  it('suppresses unchanged snapshots, sends authenticated fixed heartbeats and ends at a bounded deadline', async () => {
    const f = await fixture({ paused: true }), before = await f.events(), calls = vi.spyOn(LocalRuntime.prototype, 'readWithGrant')
    const raw = await f.raw({ id: f.id, release: f.pin, intervalMs: 100, durationMs: 250, follow: true }), text = await raw.text()
    expect(text.match(/event: snapshot/g)).toHaveLength(1); expect(text).toContain(': keepalive\n\n')
    expect(text).toContain('"reason":"deadline"'); expect(calls.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(await f.events()).toEqual(before)
  })
  it('freshly refuses a revoked grant after the first event and never resumes the paused run', async () => {
    const f = await fixture({ paused: true }), before = await f.events(), stream = f.client.stream(f.id, { intervalMs: 100, durationMs: 1000, follow: true })
    expect((await stream.next()).value).toMatchObject({ type: 'snapshot', result: { status: 'paused' } })
    await f.owner.operation({ operation: 'grants.revoke', command: { id: f.grant.id, requestId: randomUUID(), expectedGeneration: 1 } })
    expect((await stream.next()).value).toMatchObject({ type: 'stopped', sequence: 2, reason: 'read-refused' })
    expect((await stream.next()).done).toBe(true); expect(await f.events()).toEqual(before)
  })
  it('observes explicit caller control on another request; stream never dispatches an advance or reads output', async () => {
    const f = await fixture({ paused: true }), stream = f.client.stream(f.id, { follow: true, intervalMs: 100, durationMs: 1000 })
    expect((await stream.next()).value).toMatchObject({ type: 'snapshot', result: { status: 'paused' } })
    const checkpoint = await f.client.checkpoint(f.id)
    await f.client.control(f.id, { requestId: randomUUID(), mode: 'continue', expectedCheckpointSha256: checkpoint.result.checkpointSha256 })
    const before = await f.events(), advance = vi.spyOn(LocalRuntime.prototype, 'advance'), reads = vi.spyOn(LocalRuntime.prototype, 'readWithGrant')
    const rest = await collect(stream)
    expect(rest).toMatchObject([{ type: 'snapshot', sequence: 2, result: { status: 'completed' } }, { type: 'stopped', sequence: 3, reason: 'completed' }])
    expect(JSON.stringify(rest)).not.toContain('PRIVATE'); expect(advance).not.toHaveBeenCalled(); expect(reads).toHaveBeenCalledTimes(1)
    expect(await f.events()).toEqual(before)
  })
  it('disconnect/AbortSignal only stops observation and releases capacity; no cancellation or execution', async () => {
    const f = await fixture({ paused: true }), before = await f.events(), controller = new AbortController()
    const stream = f.client.stream(f.id, { signal: controller.signal, follow: true, intervalMs: 100, durationMs: 1000 })
    await stream.next(); controller.abort()
    expect(await collect(stream)).toMatchObject([{ type: 'stopped', reason: 'interrupted' }])
    expect(await f.events()).toEqual(before); expect((await f.client.read(f.id)).result.status).toBe('paused')
  })
  it('drains long observation before storage closes instead of retaining service ownership for the full duration', async () => {
    const f = await fixture({ paused: true }), stream = f.client.stream(f.id, { follow: true, durationMs: 60000 })
    await stream.next()
    const result = f.service.close(1000), rest = await collect(stream)
    expect(rest).toMatchObject([{ type: 'stopped', reason: 'draining' }]); expect(await result).toMatchObject({ status: 'closed' })
    await f.service.closed
    const reopened = await LocalRuntime.open({ dataDirectory: f.dataDirectory }); cleanup.push(() => reopened.close())
    expect((await reopened.show(f.id)).state.status).toBe('paused')
  })
  it('uses ordinary request capacity, never the reserved owner control slot', async () => {
    const f = await fixture({ paused: true, capacity: 1 }), controller = new AbortController()
    const stream = f.client.stream(f.id, { signal: controller.signal, follow: true, durationMs: 1000, intervalMs: 100 })
    await stream.next()
    try {
      await expect(collect(f.client.stream(f.id))).rejects.toMatchObject({ code: 'concurrency-limit', status: 429 })
      expect((await f.owner.operation({ operation: 'runs.show', id: f.id }) as any).result.status).toBe('paused')
    } finally { controller.abort(); await collect(stream) }
  })
  it('rejects start-only/foreign/read-only grants, forged secret and reviewed-release substitutions', async () => {
    const f = await fixture(), before = await f.events()
    for (const grant of [f.grants[1]!, f.grants[2]!, f.grants[3]!, prepareGrantToken(f.grant.id)])
      await expect(collect(new CallerClient(f.service.url, grant.token, f.service.instanceId, f.pin).stream(f.id))).rejects.toHaveProperty('code', 'not-found')
    for (const key of ['id', 'sha256', 'revision'])
      await expect(collect(new CallerClient(f.service.url, f.grant.token, f.service.instanceId,
        { ...f.pin, [key]: key === 'id' ? randomUUID() : 'b'.repeat(64) }).stream(f.id))).rejects.toHaveProperty('code', 'not-found')
    await expect(collect(f.client.stream(randomUUID()))).rejects.toHaveProperty('code', 'not-found')
    expect(await f.events()).toEqual(before)
  })
  it('keeps owner tokens, origin/proxy/instance/protocol ambiguity and reconnect cursors out of the route', async () => {
    const f = await fixture()
    for (const [headers, status] of [
      [{ authorization: `Bearer ${f.token}` }, 401], [{ authorization: `Bearer ${prepareGrantToken(randomUUID()).token}` }, 404],
      [{ 'x-jevable-instance': randomUUID() }, 409], [{ 'x-jevable-instance': '' }, 409], [{ 'x-jevable-protocol': 'wrong' }, 409],
      [{ origin: 'https://foreign.invalid' }, 403], [{ 'x-forwarded-for': '127.0.0.1' }, 403],
      [{ accept: 'application/json' }, 400], [{ 'last-event-id': '1' }, 400],
    ] as [Record<string, string>, number][]) expect((await f.raw(undefined, headers)).status).toBe(status)
    expect((await f.raw(undefined, {}, 'GET')).status).toBe(405)
    expect((await f.raw(undefined, {}, 'POST', '/v1/caller/stream?token=never')).status).toBe(400)
    for (const value of [{ id: f.id, release: f.pin, actor: 'forged' }, { id: f.id, release: f.pin, cursor: '1' },
      { id: f.id, release: f.pin, intervalMs: 99 }, { id: f.id, release: f.pin, durationMs: 60001 }]) expect((await f.raw(value)).status).toBe(400)
  })
  it('is unavailable unless the management caller interface is explicitly enabled', async () => {
    const f = await fixture({ enabled: false })
    await expect(collect(f.client.stream(f.id))).rejects.toHaveProperty('code', 'unauthorized')
    expect(JSON.stringify(await f.owner.capabilities())).not.toContain('/v1/caller/stream')
  })
  it('does not adopt traceparent even for authorized observation and rechecks permission after an awaited read hook', async () => {
    const f = await fixture(), before = await f.events(), parent = '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01'
    const observed = vi.spyOn(LocalRuntime.prototype, 'withTraceParent')
    const response = await f.raw(undefined, { traceparent: parent }); expect(response.status).toBe(200); await response.text()
    expect(observed.mock.calls.filter(call => call[0] === parent)).toHaveLength(0)
    const original = LocalRuntime.prototype.readWithGrant
    vi.spyOn(LocalRuntime.prototype, 'readWithGrant').mockImplementation(function(this: LocalRuntime, token, id, context) {
      return original.call(this, token, id, async (pin, execute) => context!(pin, async () => {
        await this.revokeGrant({ id: f.grant.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' }); return execute()
      }))
    })
    await expect(collect(f.client.stream(f.id))).rejects.toHaveProperty('code', 'not-found')
    expect(await f.events()).toEqual(before)
  })
  it('runs protected-file CLI stream with truthful exit codes and no owner handshake', async () => {
    const f = await fixture({ paused: true }), tokenFile = join(f.dataDirectory, 'caller.token'), pinFile = join(f.dataDirectory, 'pin.json')
    await writeFile(tokenFile, f.grant.token, { mode: 0o600 }); await writeFile(pinFile, JSON.stringify(f.pin))
    const flags = ['--endpoint', f.service.url, '--instance-id', f.service.instanceId, '--release-pin-file', pinFile, '--token-file', tokenFile]
    let out = '', err = ''
    expect(await main(['caller', 'stream', f.id, ...flags], { out: x => { out += x }, err: x => { err += x } })).toBe(3)
    expect(err).toBe(''); expect(out.trim().split('\n').map(x => JSON.parse(x))).toMatchObject([{ type: 'snapshot' }, { reason: 'attention' }])
    expect(out).not.toContain(f.grant.token); expect(out).not.toContain('PRIVATE')
    for (const extra of [['--duration-ms', '60001'], ['--interval-ms', '99'], ['--data-dir', 'never-created'], ['--runtime', 'docker']]) {
      out = ''; err = ''
      expect(await main(['caller', 'stream', f.id, ...flags.filter((_, i) => i < flags.length - 2), '--token-file', 'never-read.token', ...extra],
        { out: x => { out += x }, err: x => { err += x } })).toBe(2)
      expect(out).toBe(''); expect(err).not.toContain('never-read.token'); expect(err).not.toContain('transport-uncertain')
    }
    const signals = new EventEmitter(), before = await f.events(); out = ''
    const result = callerStreamFromCli(f.id, { endpoint: f.service.url, 'instance-id': f.service.instanceId, 'release-pin-file': pinFile,
      'token-file': tokenFile, follow: true, 'interval-ms': '100', 'duration-ms': '1000' }, x => { out += x; signals.emit('SIGTERM') }, signals)
    expect(await result).toBe(143); expect(signals.listenerCount('SIGTERM')).toBe(0); expect(await f.events()).toEqual(before)
  })
})

const instanceId = randomUUID(), id = randomUUID(), pin = { id: randomUUID(), sha256: 'a'.repeat(64), revision: 'b'.repeat(64) }
const receipt = (status = 'paused') => ({ schemaVersion: 1, id, revision: pin.revision, release: { id: pin.id, sha256: pin.sha256 },
  status, createdAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z' })
const snapshot = (): CallerStreamEvent => ({ schemaVersion: 1, type: 'snapshot', sequence: 1, instanceId, result: receipt() as never })
const stopped = (): CallerStreamEvent => ({ schemaVersion: 1, type: 'stopped', sequence: 2, instanceId, reason: 'attention', execution: 'not-requested' })
async function peer(text: string | Buffer, headers: Record<string, string> = {}, status = 200) {
  const calls: any[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk)
    calls.push({ method: request.method, path: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) })
    response.writeHead(status, { 'Content-Type': 'text/event-stream', 'X-Jevable-Protocol': PROTOCOL_VERSION, ...headers }); response.end(text)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Fixture')
  return { calls, client: new CallerClient(`http://127.0.0.1:${address.port}`, prepareGrantToken(randomUUID()).token, instanceId, pin, 1000, 65536) }
}

describe('caller stream wire parser and projection (not deployment qualification)', () => {
  it('accepts fixed heartbeats and canonical events, sends one pinned POST and no reconnect fields', async () => {
    const f = await peer(encodeCallerStreamEvent(snapshot()) + encodeCallerStreamEvent(null) + encodeCallerStreamEvent(stopped()))
    expect(await collect(f.client.stream(id.toUpperCase()))).toEqual([snapshot(), stopped()])
    expect(f.calls).toHaveLength(1); expect(f.calls[0]).toMatchObject({ method: 'POST', path: '/v1/caller/stream',
      body: { id, release: pin, intervalMs: 1000, durationMs: 15000, follow: false }, headers: { accept: 'text/event-stream' } })
    expect(f.calls[0].headers).not.toHaveProperty('last-event-id'); expect(f.calls[0].headers).not.toHaveProperty('traceparent')
  })
  it.each(['output', 'actor', 'instance', 'run', 'release', 'revision', 'created', 'sequence', 'event', 'reason', 'terminal-mismatch'])('refuses %s stream substitutions without widening or reconnect', async damage => {
    const first: any = snapshot(), second: any = stopped()
    if (['output', 'actor'].includes(damage)) first.result[damage] = 'PRIVATE_WIRE'
    if (damage === 'instance') first.instanceId = randomUUID()
    if (damage === 'run') first.result.id = randomUUID()
    if (damage === 'release') first.result.release.id = randomUUID()
    if (damage === 'revision') first.result.revision = 'c'.repeat(64)
    if (damage === 'created') { second.type = 'snapshot'; second.result = { ...first.result, createdAt: '2026-10-02T00:00:00.000Z' }; delete second.reason; delete second.execution }
    if (damage === 'sequence') first.sequence = 2
    if (damage === 'event') first.type = 'private'
    if (damage === 'reason') second.reason = 'retry-execution'
    if (damage === 'terminal-mismatch') second.reason = 'completed'
    const frame = (v: any) => `event: ${v.type}\ndata: ${JSON.stringify(v)}\n\n`
    const f = await peer(frame(first) + frame(second))
    await expect(collect(f.client.stream(id))).rejects.toMatchObject({ code: 'invalid-response', message: expect.not.stringContaining('PRIVATE_WIRE') })
    expect(f.calls).toHaveLength(1)
  })
  it.each(['cursor', 'retry', 'unknown-field', 'invalid-json', 'oversized-frame', 'invalid-utf8', 'truncated-frame', 'no-stop', 'wrong-media', 'compression', 'redirect'])('refuses %s wire behavior without retry', async damage => {
    let text: string | Buffer = encodeCallerStreamEvent(snapshot()) + encodeCallerStreamEvent(stopped()), status = 200
    const headers: Record<string, string> = {}
    if (damage === 'cursor') text = 'id: 1\n' + text
    if (damage === 'retry') text = 'retry: 1\n' + text
    if (damage === 'unknown-field') text = 'private: SECRET\n' + text
    if (damage === 'invalid-json') text = 'event: snapshot\ndata: {\n\n'
    if (damage === 'oversized-frame') text = 'data: ' + 'x'.repeat(17000)
    if (damage === 'invalid-utf8') text = Buffer.from([0xff])
    if (damage === 'truncated-frame') text = encodeCallerStreamEvent(snapshot()) + 'event: stopped\ndata: {}'
    if (damage === 'no-stop') text = encodeCallerStreamEvent(snapshot())
    if (damage === 'wrong-media') headers['Content-Type'] = 'application/json'
    if (damage === 'compression') headers['Content-Encoding'] = 'gzip'
    if (damage === 'redirect') { status = 307; headers.Location = 'https://never-contacted.invalid' }
    const f = await peer(text, headers, status)
    await expect(collect(f.client.stream(id))).rejects.toHaveProperty('code', damage === 'redirect' ? 'redirect-refused' : damage === 'no-stop' ? 'stream-incomplete' : 'invalid-response')
    expect(f.calls).toHaveLength(1)
  })
  it('refuses invalid options/identity before contacting a peer; pre-aborted observation makes no request', async () => {
    const f = await peer('')
    for (const value of [{ intervalMs: 99 }, { durationMs: 60001 }, { follow: 'yes' }, { cursor: '1' }, { signal: {} }, null])
      await expect(collect(f.client.stream(id, value as never))).rejects.toHaveProperty('code', 'invalid-command')
    await expect(collect(f.client.stream('invalid'))).rejects.toHaveProperty('code', 'invalid-command')
    const signal = AbortSignal.abort()
    expect(await collect(f.client.stream(id, { signal }))).toMatchObject([{ type: 'stopped', sequence: 1, reason: 'interrupted' }])
    expect(f.calls).toHaveLength(0)
  })
  it('projects only metadata, checks read results and refuses initial unauthorized errors before successful streaming', async () => {
    const request = callerStreamRequestSchema.parse({ id, release: pin }), controller = new AbortController()
    const results = await collect(observeCallerRun(async () => ({ ...receipt('completed'), output: 'PRIVATE_OUTPUT' }), instanceId, request, controller.signal))
    expect(results).toMatchObject([{ type: 'snapshot', result: { status: 'completed' } }, { type: 'stopped', reason: 'completed' }])
    expect(JSON.stringify(results)).not.toContain('PRIVATE_OUTPUT')
    for (const value of [{ ...receipt('completed') }, { ...receipt(), output: 'PRIVATE' }, { ...receipt(), id: randomUUID() }, { ...receipt(), actor: 'forged' }])
      await expect(collect(observeCallerRun(async () => value, instanceId, request, controller.signal))).rejects.toThrow()
    const error = Error('PRIVATE_REFUSAL')
    await expect(collect(observeCallerRun(async () => { throw error }, instanceId, request, controller.signal))).rejects.toBe(error)
  })
})

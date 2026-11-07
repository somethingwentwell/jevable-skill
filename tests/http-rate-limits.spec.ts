import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHttpRateLimiter, HttpRateLimitError, isOwnerControlCommand, httpRateLimitsSchema, readHttpRateLimitsFile } from '../src/http/rate-limits.ts'
import { startRuntimeService, RuntimeClient } from '../src/http/index.ts'
import { startPostgresRuntimeService } from '../src/http/postgres.ts'
import { LocalRuntime, prepareGrantToken } from '../src/runtime/index.ts'
import { PostgresRuntime } from '../src/runtime/postgres.ts'
import { CORE_VERSION, PROTOCOL_VERSION } from '../src/capabilities.ts'
import { main } from '../src/cli.ts'
import { serveFromCli } from '../src/http/cli-service.ts'
import * as serviceProcess from '../src/http/process.ts'
import { runReleaseApp, type ReleaseBackend } from '../src/releases/app.ts'
import { createTlsFixture, fixturePort } from '../scripts/tls-fixture.mjs'
import { WorkflowRuntimeError as WorkflowError } from '../src/runtime/errors.ts'
import { createServer } from 'node:http'

const token = 'a'.repeat(64), bucket = { capacity: 1, refillTokens: 1, refillIntervalMs: 3_600_000 }
const policy = { requests: bucket, controls: { ...bucket, capacity: 8 } }
const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture(patch: Partial<Parameters<typeof startRuntimeService>[0]> = {}, enabled = true) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-rate-limits-')), dataDirectory = join(directory, 'state')
  const service = await startRuntimeService({ runtime: { dataDirectory }, token, actor: 'fixture:owner', ...(enabled ? { rateLimits: policy } : {}), ...patch })
  cleanup.push(async () => { await service.close(); await service.closed })
  const raw = (command: unknown, path = '/v1/operations', method = 'POST', headers: Record<string, string> = {}) => fetch(service.url + path, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-jevable-protocol': PROTOCOL_VERSION,
      'x-jevable-instance': service.instanceId, ...headers }, ...(method === 'GET' ? {} : { body: JSON.stringify(command) }),
  })
  return { directory, dataDirectory, service, raw }
}
const start = (id = randomUUID()) => ({ operation: 'runs.start' as const, id, yaml: echo, input: 'PRIVATE_RATE_INPUT', paused: true })

describe('bounded monotonic two-lane token buckets', () => {
  it('refills fractional credit, caps idle credit, never refunds refusals, and rounds Retry-After upwards', () => {
    let at = 0
    const limiter = createHttpRateLimiter({ requests: { capacity: 2, refillTokens: 1, refillIntervalMs: 1500 }, controls: bucket }, () => at)
    limiter.admit('requests'); limiter.admit('requests')
    try { limiter.admit('requests'); throw Error('expected refusal') } catch (error) { expect(error).toMatchObject({ status: 429, code: 'rate-limit', retryAfterSeconds: 2 }) }
    at = 1499; expect(() => limiter.admit('requests')).toThrow(HttpRateLimitError)
    at = 1500; limiter.admit('requests'); expect(() => limiter.admit('requests')).toThrow(HttpRateLimitError)
    at = 100_000; limiter.admit('requests'); limiter.admit('requests'); expect(() => limiter.admit('requests')).toThrow(HttpRateLimitError)
    limiter.admit('controls'); expect(() => limiter.admit('controls')).toThrow(HttpRateLimitError)
  })
  it('does not grant credit on backwards/nonfinite clocks or let policy mutation change either quota', () => {
    let at = 1000
    const supplied = structuredClone(policy), limiter = createHttpRateLimiter(supplied, () => at)
    supplied.requests.capacity = 999; limiter.policy().requests.capacity = 999
    limiter.admit('requests'); at = 0; expect(() => limiter.admit('requests')).toThrow(HttpRateLimitError)
    at = 1000; expect(() => limiter.admit('requests')).toThrow(HttpRateLimitError)
    at = NaN; expect(() => limiter.admit('requests')).toThrow(WorkflowError)
    expect(limiter.policy()).toEqual(policy)
  })
  it.each([null, {}, { requests: bucket }, { ...policy, extra: true },
    { ...policy, requests: { ...bucket, capacity: 0 } }, { ...policy, requests: { ...bucket, capacity: 10_001 } },
    { ...policy, requests: { ...bucket, refillTokens: 0 } }, { ...policy, requests: { ...bucket, refillTokens: 1.5 } },
    { ...policy, controls: { ...bucket, refillIntervalMs: 999 } }, { ...policy, controls: { ...bucket, refillIntervalMs: 3_600_001 } },
    { ...policy, controls: { ...bucket, identity: 'PRIVATE_ACCOUNT' } }])('refuses malformed policy before reading a clock or opening SQLite/PostgreSQL %j', async value => {
    const clock = vi.fn(() => 0), sqlite = vi.spyOn(LocalRuntime, 'open'), postgres = vi.spyOn(PostgresRuntime, 'open')
    expect(httpRateLimitsSchema.safeParse(value).success).toBe(false)
    expect(() => createHttpRateLimiter(value, clock)).toThrow(); expect(clock).not.toHaveBeenCalled()
    await expect(startRuntimeService({ runtime: { dataDirectory: '/not-opened' }, token, actor: 'fixture', rateLimits: value } as never)).rejects.toHaveProperty('code', 'invalid-command')
    await expect(startPostgresRuntimeService({ runtime: {} as never, token, actor: 'fixture', rateLimits: value } as never)).rejects.toHaveProperty('code', 'invalid-command')
    expect(sqlite).not.toHaveBeenCalled(); expect(postgres).not.toHaveBeenCalled()
  })
  it('limits reserve classification to existing exact owner/scoped stop/status operations', () => {
    for (const path of ['/v1/operations', '/v1/preview/operations']) {
      const scoped = path.includes('preview'), prefix = scoped ? '' : 'runs.'
      for (const operation of ['show', 'cancel']) expect(isOwnerControlCommand(path, { operation: prefix + operation })).toBe(true)
      expect(isOwnerControlCommand(path, { operation: prefix + 'advance', mode: 'pause' })).toBe(true)
      for (const mode of ['step', 'continue', 'recover']) expect(isOwnerControlCommand(path, { operation: prefix + 'advance', mode })).toBe(false)
      for (const command of [null, [], {}, { operation: 'runs.start' }, { operation: 'approvals.decide' }]) expect(isOwnerControlCommand(path, command)).toBe(false)
    }
    for (const path of ['/v1/caller/operations', '/v1/reviewer/decisions', '/v1/async-runs'])
      expect(isOwnerControlCommand(path, { operation: 'runs.cancel' })).toBe(false)
  })
})

describe('actual owned HTTP rate admission (not deployed/cluster qualification)', () => {
  it('shares credits across simultaneous requests and leaves rejected run identities absent', async () => {
    const f = await fixture({ rateLimits: { ...policy, requests: { ...bucket, capacity: 2 } } }), commands = Array.from({ length: 8 }, () => start())
    const responses = await Promise.all(commands.map(command => f.raw(command)))
    expect(responses.filter(r => r.status === 200)).toHaveLength(2); expect(responses.filter(r => r.status === 429)).toHaveLength(6)
    for (const response of responses.filter(r => r.status === 429)) {
      expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toMatchObject({ code: 'rate-limit', execution: 'not-dispatched', retryAfterSeconds: Number(response.headers.get('retry-after')) })
    }
    await f.service.close(); await f.service.closed
    const runtime = await LocalRuntime.open({ dataDirectory: f.dataDirectory })
    try {
      expect((await runtime.list()).map(run => run.id).sort()).toEqual(commands.filter((_, i) => responses[i]!.status === 200).map(c => c.id).sort())
      for (const command of commands.filter((_, i) => responses[i]!.status === 429)) await expect(runtime.show(command.id)).rejects.toHaveProperty('code', 'not-found')
    } finally { await runtime.close() }
  })
  it('preserves status/cancellation reserve when ordinary credit is exhausted, with no approval/continue bypass', async () => {
    const f = await fixture(), command = start()
    expect((await f.raw(command)).status).toBe(200)
    expect((await f.raw({ operation: 'runs.advance', id: command.id, mode: 'continue', requestId: randomUUID(), expectedCheckpointSha256: 'b'.repeat(64) })).status).toBe(429)
    expect((await f.raw({ operation: 'approvals.decide', id: command.id, attemptId: randomUUID(), action: 'approve' })).status).toBe(429)
    const shown = await f.raw({ operation: 'runs.show', id: command.id }); expect(shown.status).toBe(200)
    expect(await shown.json()).toMatchObject({ result: { status: 'paused', steps: [] } })
    expect((await f.raw({ operation: 'runs.cancel', id: command.id, requestId: randomUUID() })).status).toBe(200)
    expect(await (await f.raw({ operation: 'runs.show', id: command.id })).json()).toMatchObject({ result: { status: 'cancelled' } })
    const invalid = await f.raw({ operation: 'runs.cancel', id: command.id, requestId: randomUUID(), actor: 'spoofed' })
    expect(invalid.status).toBe(400)
  })
  it('does not consume credit for rejected owner authentication/instance/protocol or exempt discovery', async () => {
    const f = await fixture()
    for (const headers of [{ authorization: 'Bearer ' + 'b'.repeat(64) }, { 'x-jevable-instance': randomUUID() }, { 'x-jevable-protocol': 'invalid' }])
      expect((await f.raw(start(), '/v1/operations', 'POST', headers)).status).not.toBe(200)
    for (let i = 0; i < 3; i++) expect(await (await f.raw({}, '/v1/capabilities', 'GET')).json()).toMatchObject({ api: { rateLimits: {
      algorithm: 'token-bucket', scope: 'runtime-instance', persistence: false, automaticRetry: false, requests: bucket,
    } } })
    expect((await f.raw(start())).status).toBe(200); expect((await f.raw(start())).status).toBe(429)
  })
  it('bounds the separate reserve, preserves default behavior, and resets credits only on explicit replacement', async () => {
    const f = await fixture({ rateLimits: { requests: bucket, controls: bucket } })
    expect((await f.raw({}, '/v1/health', 'GET')).status).toBe(200)
    expect((await f.raw({}, '/v1/health', 'GET')).status).toBe(429)
    expect((await f.raw(start())).status).toBe(200)
    await f.service.close(); await f.service.closed
    const second = await startRuntimeService({ runtime: { dataDirectory: f.dataDirectory }, token, actor: 'fixture', rateLimits: policy })
    cleanup.push(async () => { await second.close(); await second.closed })
    expect(second.instanceId).not.toBe(f.service.instanceId)
    const client = new RuntimeClient(second.url, token)
    expect(await client.operation(start())).toMatchObject({ result: { status: 'paused' } })
    const defaultHost = await fixture({}, false)
    for (let i = 0; i < 4; i++) expect((await defaultHost.raw(start())).status).toBe(200)
    expect((await (await defaultHost.raw({}, '/v1/capabilities', 'GET')).json()).api).not.toHaveProperty('rateLimits')
  })
  it('shares ordinary credit with async admission while metadata reads retain reserved credit', async () => {
    const f = await fixture({ asyncRuns: { maxConcurrentRuns: 2 } }), first = start(), rejected = randomUUID()
    expect((await f.raw(first)).status).toBe(200)
    expect((await f.raw({ kind: 'workflow', id: rejected, yaml: echo, input: 'PRIVATE_ASYNC', paused: true }, '/v1/async-runs')).status).toBe(429)
    expect((await f.raw({}, '/v1/async-runs/' + first.id, 'GET')).status).toBe(200)
    const missing = await f.raw({}, '/v1/async-runs/' + rejected, 'GET'); expect(missing.status).toBe(404)
  })
  it('never permits reviewer decisions to use owner reserve or settle an approval after ordinary exhaustion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-rate-reviewer-')), runtime = await LocalRuntime.open({ dataDirectory: directory })
    const run = await runtime.run(approval, { message: 'PRIVATE_APPROVAL' })
    if (run.state.status !== 'waiting') throw Error('expected wait')
    const prepared = prepareGrantToken(randomUUID())
    await runtime.issueGrant({ id: prepared.id, tokenSha256: prepared.tokenSha256, actor: 'fixture', expiresAt: new Date(Date.now() + 3600000).toISOString(),
      scope: { kind: 'reviewer', runId: run.id, revision: run.revision, attemptId: run.state.attempt.id, decisions: ['approve'] } })
    const before = await runtime.events(run.id); await runtime.close()
    const f = await fixture({ runtime: { dataDirectory: directory }, reviewerDecisions: true })
    expect((await f.raw({ operation: 'runs.list' })).status).toBe(200)
    const denied = await f.raw({ requestId: randomUUID(), action: 'approve' }, '/v1/reviewer/decisions', 'POST', { authorization: `Bearer ${prepared.token}` })
    expect(denied.status).toBe(429)
    expect(await (await f.raw({ operation: 'runs.show', id: run.id })).json()).toMatchObject({ result: { status: 'waiting' } })
    await f.service.close(); await f.service.closed
    const reopened = await LocalRuntime.open({ dataDirectory: directory })
    try { expect(await reopened.events(run.id)).toEqual(before) } finally { await reopened.close() }
  })
  it('shares ordinary credits with real caller reads without allowing caller cancel to use reserve', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-rate-caller-')), runtime = await LocalRuntime.open({ dataDirectory: directory })
    const project = runtime.editProject({ operation: 'create', yaml: echo, title: 'Caller', actor: 'fixture' })
    const release = runtime.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision,
      version: '1.0.0', actor: 'fixture', runtime: { version: CORE_VERSION, sha256: 'b'.repeat(64) } })
    const pin = { id: release.snapshot.id, sha256: release.sha256, revision: release.snapshot.workflow.revision }, prepared = prepareGrantToken(randomUUID())
    await runtime.issueGrant({ id: prepared.id, tokenSha256: prepared.tokenSha256, actor: 'fixture', expiresAt: new Date(Date.now() + 3600000).toISOString(),
      scope: { kind: 'caller', release: pin, permissions: ['start', 'read', 'cancel'] } })
    const run = await runtime.startWithGrant(prepared.token, 'PRIVATE_CALLER', { id: randomUUID(), paused: true })
    const before = await runtime.events(run.id); await runtime.close()
    const f = await fixture({ runtime: { dataDirectory: directory }, callerOperations: true })
    const delegated = { authorization: `Bearer ${prepared.token}` }
    expect((await f.raw({ operation: 'read', id: run.id, release: pin }, '/v1/caller/operations', 'POST', delegated)).status).toBe(200)
    expect((await f.raw({ operation: 'runs.list' })).status).toBe(429)
    expect((await f.raw({ operation: 'cancel', id: run.id, release: pin, request: { requestId: randomUUID() } }, '/v1/caller/operations', 'POST', delegated)).status).toBe(429)
    expect((await f.raw({ operation: 'runs.show', id: run.id })).status).toBe(200)
    await f.service.close(); await f.service.closed
    const reopened = await LocalRuntime.open({ dataDirectory: directory })
    try { expect(await reopened.events(run.id)).toEqual(before) } finally { await reopened.close() }
  })
  it('keeps scoped preview graph reads/execution separate from inert HTML and preserves its own reserve', async () => {
    const f = await fixture({ preview: { source: echo }, rateLimits: { ...policy, requests: { ...bucket, capacity: 2 } } })
    const page = await fetch(f.service.url); expect(page.status).toBe(200); expect(page.headers.get('content-type')).toContain('text/html')
    const boot = await f.raw({}, '/v1/preview/bootstrap'), session = (await boot.json()).result
    expect(boot.status).toBe(200); expect(session.token).toBeTypeOf('string')
    const id = randomUUID(), scoped = { authorization: `Bearer ${session.token}` }
    expect((await f.raw({ operation: 'run', id, input: 'PRIVATE_PREVIEW', paused: true }, '/v1/preview/operations', 'POST', scoped)).status).toBe(200)
    expect((await f.raw({ operation: 'runs' }, '/v1/preview/operations', 'POST', scoped)).status).toBe(429)
    const shown = await f.raw({ operation: 'show', id }, '/v1/preview/operations', 'POST', scoped)
    expect(shown.status).toBe(200); expect(await shown.json()).toMatchObject({ result: { id, status: 'paused', steps: [] } })
    expect((await fetch(f.service.url)).status).toBe(200)
  })
  it('uses the same limiter for explicitly trusted HTTPS without weakening TLS or adding retry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-rate-tls-')), credentials = await createTlsFixture(directory), port = await fixturePort()
    const f = await fixture({ port, tls: { publicOrigin: `https://127.0.0.1:${port}`, bindAddress: '127.0.0.1', certificateFile: credentials.cert, privateKeyFile: credentials.key } })
    const client = new RuntimeClient(f.service.url, token, 2000, 20_000_000, { ca: credentials.ca })
    const first = start(); expect(await client.operation(first)).toMatchObject({ result: { id: first.id } })
    await expect(client.operation(start())).rejects.toMatchObject({ code: 'rate-limit', status: 429, retryAfterSeconds: 3600 })
    expect(await client.operation({ operation: 'runs.show', id: first.id })).toMatchObject({ result: { status: 'paused' } })
    await expect(new RuntimeClient(f.service.url, token, 1000).health()).rejects.toHaveProperty('code', 'transport-uncertain')
  }, 20000)
  it.each([
    ['1', 1], ['3600', 3600], ['0', undefined], ['01', undefined], ['3601', undefined],
    ['999999999', undefined], ['-1', undefined], ['1, 2', undefined], ['Wed, 21 Oct 2015 07:28:00 GMT', undefined],
  ])('treats Retry-After %s only as a bounded hint without waiting or retrying', async (header, expected) => {
    let calls = 0
    const server = createServer((_request, response) => {
      calls++; response.writeHead(429, { 'Content-Type': 'application/json', 'X-Jevable-Protocol': PROTOCOL_VERSION, 'Retry-After': header! })
      response.end(JSON.stringify({ schemaVersion: 1, status: 'error', code: 'rate-limit' }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    const address = server.address(); if (!address || typeof address === 'string') throw Error('missing listener')
    const client = new RuntimeClient(`http://127.0.0.1:${address.port}`, token)
    await expect(client.health()).rejects.toMatchObject({ code: 'rate-limit', status: 429, retryAfterSeconds: expected })
    expect(calls).toBe(1)
  })
})

describe('rate policy startup adapters and bounded offline discovery', () => {
  it('reads only a strict bounded JSON policy and rejects unknown fields, nonfiles and oversized documents', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-rate-files-')), path = join(directory, 'policy.json')
    expect(await readHttpRateLimitsFile(undefined)).toBeUndefined()
    for (const text of ['not-json', JSON.stringify({ ...policy, token: 'PRIVATE' }), ' '.repeat(4097)]) {
      await writeFile(path, text); await expect(readHttpRateLimitsFile(path)).rejects.toHaveProperty('code', 'invalid-command')
    }
    await expect(readHttpRateLimitsFile(true)).rejects.toHaveProperty('code', 'invalid-command')
    await expect(readHttpRateLimitsFile(directory)).rejects.toHaveProperty('code', 'invalid-command')
    await writeFile(path, JSON.stringify(policy)); expect(await readHttpRateLimitsFile(path)).toEqual(policy)
  })
  it('advertises local and Docker startup policy/schema but refuses per-operation and restart overrides', async () => {
    const invoke = async (args: string[]) => { let out = '', err = ''; const code = await main([...args, '--json'], { out: s => { out += s }, err: s => { err += s } }); return { code, out, err } }
    for (const action of ['serve', 'start']) {
      const result = await invoke(['runtime', action, '--help']); expect(result.code).toBe(0)
      const help = JSON.parse(result.out); expect(help.variants[0].options['rate-limits-file']).toBe('string')
      expect(help.inputContracts.find((entry: any) => entry.id === 'http-rate-limits').schema).toEqual(httpRateLimitsSchema.toJSONSchema({ io: 'input' }))
      if (action === 'start') expect(help.variants[1].options['rate-limits-file']).toBe('string')
    }
    expect((await invoke(['run', 'not-read', '--rate-limits-file', 'not-read'])).code).toBe(2)
    for (const action of ['inspect', 'stop', 'restart']) expect((await invoke(['runtime', action, '--runtime', 'docker', '--rate-limits-file', 'not-read'])).code).toBe(2)
  })
  it('forwards startup policy to local and exported-app service hosts without opening an authoring server dependency', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-rate-adapters-')), file = join(directory, 'policy.json'), tokenFile = join(directory, 'token')
    await writeFile(file, JSON.stringify(policy)); await writeFile(tokenFile, token, { mode: 0o600 })
    vi.spyOn(serviceProcess, 'runServiceProcess').mockImplementation(async begin => {
      const service = await begin()
      try { expect((await new RuntimeClient(service.url, token).capabilities() as any).api.rateLimits.requests).toEqual(bucket) }
      finally { await service.close(); await service.closed }
      return 0
    })
    expect(await serveFromCli({ 'data-dir': join(directory, 'local'), 'rate-limits-file': file }, token, () => {})).toBe(0)
    const runtime = await LocalRuntime.open({ dataDirectory: join(directory, 'authoring') })
    const project = runtime.editProject({ operation: 'create', yaml: echo, title: 'App', actor: 'fixture' })
    const release = runtime.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision, version: '1.0.0', actor: 'fixture', runtime: { version: CORE_VERSION, sha256: 'b'.repeat(64) } })
    await runtime.close()
    const serve = vi.fn(async (_values, _directory, options) => {
      expect(options.rateLimits).toEqual(policy)
      return startRuntimeService({ ...options, runtime: { dataDirectory: join(directory, 'app') } })
    })
    const open = vi.fn(async () => { throw Error('No direct app owner expected') }), backend: ReleaseBackend = { storage: 'sqlite', open, serve }
    expect(await runReleaseApp(backend, release.snapshot, ['serve', '--token-file', tokenFile, '--rate-limits-file', file], directory)).toBe(0)
    expect(serve).toHaveBeenCalledTimes(1); expect(open).not.toHaveBeenCalled()
    await writeFile(file, JSON.stringify({ ...policy, extra: true }))
    await expect(serveFromCli({ 'data-dir': join(directory, 'not-created'), 'rate-limits-file': file }, token, () => {})).rejects.toHaveProperty('code', 'invalid-command')
    expect(await readdir(directory)).not.toContain('not-created')
  })
})

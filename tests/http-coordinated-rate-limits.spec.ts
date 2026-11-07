import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCoordinatedHttpRateLimiter, HttpRateCoordinatorError,
  type CoordinatedHttpRateLimits, type HttpRateDebit, type HttpRateDebitReceipt } from '../src/http/coordinated-rate-limits.ts'
import { createHttpRateLimiter, HttpRateLimitError } from '../src/http/rate-limits.ts'
import { startRuntimeService } from '../src/http/index.ts'
import { startPostgresRuntimeService } from '../src/http/postgres.ts'
import { startPreviewGateway } from '../src/http/preview-gateway.ts'
import { startRuntimeServer } from '../src/http/server.ts'
import { LocalRuntime, prepareGrantToken } from '../src/runtime/index.ts'
import { PostgresRuntime } from '../src/runtime/postgres.ts'
import { PROTOCOL_VERSION } from '../src/capabilities.ts'

const token = 'a'.repeat(64)
const bucket = { capacity: 1, refillTokens: 1, refillIntervalMs: 3_600_000 }
const policy = { requests: bucket, controls: { ...bucket, capacity: 8 } }
const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const receipt = (request: HttpRateDebit, admitted = true): HttpRateDebitReceipt => {
  const { requestId, scope, policySha256, lane } = request
  return admitted ? { requestId, scope, policySha256, lane, admitted }
    : { requestId, scope, policySha256, lane, admitted, retryAfterSeconds: 3600 }
}
function options(consume: CoordinatedHttpRateLimits['consume'] = async request => receipt(request)): CoordinatedHttpRateLimits {
  return { scope: randomUUID(), policy: structuredClone(policy), timeoutMs: 100, consume }
}
/** Atomic in-process test double only; this is NOT a database/distributed/deployment qualification. */
function sharedFixture(capacity = 1) {
  const limiter = createHttpRateLimiter({ ...policy, requests: { ...bucket, capacity } }, () => 0)
  const calls: HttpRateDebit[] = []
  const config = options(async request => {
    calls.push(structuredClone(request))
    try { limiter.admit(request.lane); return receipt(request) }
    catch (error) {
      if (!(error instanceof HttpRateLimitError)) throw error
      return { ...receipt(request, false), retryAfterSeconds: error.retryAfterSeconds } as HttpRateDebitReceipt
    }
  })
  config.policy = limiter.policy()
  return { config, calls }
}
async function fixture(coordinatedRateLimits: CoordinatedHttpRateLimits,
  patch: Partial<Parameters<typeof startRuntimeService>[0]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-coordinated-admission-')), dataDirectory = join(directory, 'state')
  const service = await startRuntimeService({ runtime: { dataDirectory }, token, actor: 'fixture:owner', coordinatedRateLimits, ...patch })
  cleanup.push(async () => { await service.close(); await service.closed })
  const raw = (command: unknown, path = '/v1/operations', method = 'POST', headers: Record<string, string> = {}) => fetch(service.url + path, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-jevable-protocol': PROTOCOL_VERSION,
      'x-jevable-instance': service.instanceId, ...headers }, ...(method === 'GET' ? {} : { body: JSON.stringify(command) }),
  })
  return { service, raw, dataDirectory: patch.runtime?.dataDirectory ?? dataDirectory }
}
const start = () => ({ operation: 'runs.start', id: randomUUID(), yaml: echo, input: 'PRIVATE_COORDINATED_INPUT', paused: true })
async function retained(f: Awaited<ReturnType<typeof fixture>>) {
  await f.service.close(); await f.service.closed
  const runtime = await LocalRuntime.open({ dataDirectory: f.dataDirectory })
  try { return await runtime.list() } finally { await runtime.close() }
}

describe('explicit SDK coordinator boundary (backend test doubles, not distributed acceptance)', () => {
  it('pins identity, policy, function, and detached debit arguments before asynchronous admission', async () => {
    const calls: HttpRateDebit[] = []
    const consume = vi.fn(async (request: HttpRateDebit) => { calls.push(structuredClone(request)); request.policy.requests.capacity = 999; return receipt(request) })
    const supplied = options(consume), expected = structuredClone(supplied.policy), scope = supplied.scope
    const limiter = createCoordinatedHttpRateLimiter(supplied)
    supplied.policy.requests.capacity = 999; supplied.scope = randomUUID(); supplied.timeoutMs = 5000
    supplied.consume = async () => { throw Error('must not retarget') }
    limiter.policy().requests.capacity = 1000
    await limiter.admit('requests'); await limiter.admit('controls')
    expect(consume).toHaveBeenCalledTimes(2); expect(limiter.policy()).toEqual(expected)
    const policySha256 = createHash('sha256').update(JSON.stringify(expected)).digest('hex')
    expect(limiter.identity()).toEqual({ scope, policySha256, timeoutMs: 100 })
    expect(calls[0]).toEqual({ requestId: expect.any(String), scope, policySha256, lane: 'requests', policy: expected })
    expect(calls[1]).toEqual({ requestId: expect.any(String), scope, policySha256, lane: 'controls', policy: expected })
    expect(calls[0]!.requestId).not.toBe(calls[1]!.requestId)
    await expect(limiter.admit('unknown' as never)).rejects.toHaveProperty('code', 'invalid-command')
    expect(consume).toHaveBeenCalledTimes(2)
  })
  it('shares the test coordinator across independent limiters, with no local fallback or denial refund', async () => {
    const shared = sharedFixture(2), a = createCoordinatedHttpRateLimiter(shared.config), b = createCoordinatedHttpRateLimiter(shared.config)
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).admit('requests')))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2)
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(10)
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toMatchObject({ status: 429, code: 'rate-limit', retryAfterSeconds: 3600 })
    expect(new Set(shared.calls.map(call => call.requestId)).size).toBe(12)
    await a.admit('controls'); await b.admit('controls')
    await expect(createCoordinatedHttpRateLimiter(shared.config).admit('requests')).rejects.toBeInstanceOf(HttpRateLimitError)
  })
  it.each([
    (r: HttpRateDebit) => ({ ...receipt(r), requestId: randomUUID() }),
    (r: HttpRateDebit) => ({ ...receipt(r), scope: randomUUID() }),
    (r: HttpRateDebit) => ({ ...receipt(r), policySha256: 'b'.repeat(64) }),
    (r: HttpRateDebit) => ({ ...receipt(r), lane: 'controls' }),
    (r: HttpRateDebit) => ({ ...receipt(r), extra: 'PRIVATE_COORDINATOR' }),
    (r: HttpRateDebit) => ({ ...receipt(r), admitted: 'yes' }),
    (r: HttpRateDebit) => ({ ...receipt(r), retryAfterSeconds: 1 }),
    (r: HttpRateDebit) => ({ ...receipt(r, false), retryAfterSeconds: 0 }),
    (r: HttpRateDebit) => ({ ...receipt(r, false), retryAfterSeconds: 3601 }),
    (r: HttpRateDebit) => ({ ...receipt(r, false), retryAfterSeconds: 1.5 }),
    () => null,
  ])('fails closed on malformed or mismatched receipts without retry (%#)', async transform => {
    const consume = vi.fn(async (request: HttpRateDebit) => transform(request) as HttpRateDebitReceipt)
    await expect(createCoordinatedHttpRateLimiter(options(consume)).admit('requests')).rejects.toMatchObject({ status: 503, code: 'rate-coordinator-unavailable', message: 'rate-coordinator-unavailable' })
    expect(consume).toHaveBeenCalledTimes(1)
  })
  it.each([new Error('PRIVATE_PASSWORD'), new HttpRateLimitError(999_999), 'PRIVATE_DATABASE_URI'])('sanitizes all adapter exceptions, including forged quota errors (%#)', async error => {
    const consume = vi.fn(async () => { throw error })
    await expect(createCoordinatedHttpRateLimiter(options(consume)).admit('requests')).rejects.toBeInstanceOf(HttpRateCoordinatorError)
    expect(consume).toHaveBeenCalledTimes(1)
  })
  it('times out once, aborts the adapter, and ignores late success instead of retrying', async () => {
    let resolve!: (value: HttpRateDebitReceipt) => void, request!: HttpRateDebit, signal!: AbortSignal
    const consume = vi.fn((value: HttpRateDebit, abort: AbortSignal) => {
      request = value; signal = abort; return new Promise<HttpRateDebitReceipt>(yes => { resolve = yes })
    })
    const limiter = createCoordinatedHttpRateLimiter(options(consume))
    await expect(limiter.admit('requests')).rejects.toBeInstanceOf(HttpRateCoordinatorError)
    expect(signal.aborted).toBe(true); resolve(receipt(request)); await Promise.resolve()
    expect(consume).toHaveBeenCalledTimes(1)
  })
  it('clears its timeout after a valid receipt; it does not later abort settled debit', async () => {
    vi.useFakeTimers()
    try {
      let signal!: AbortSignal
      const limiter = createCoordinatedHttpRateLimiter(options(async (request, abort) => { signal = abort; return receipt(request) }))
      await limiter.admit('requests'); await vi.advanceTimersByTimeAsync(1000)
      expect(signal.aborted).toBe(false); expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it.each([null, {}, { scope: 'not-uuid' }, { ...options(), timeoutMs: 99 }, { ...options(), timeoutMs: 5001 },
    { ...options(), consume: true }, { ...options(), extra: 'not-allowed' },
    { ...options(), policy: { ...policy, requests: { ...bucket, capacity: 0 } } },
  ])('refuses invalid configuration before opening SQLite, PostgreSQL or gateway owner (%#)', async value => {
    const sqlite = vi.spyOn(LocalRuntime, 'open'), postgres = vi.spyOn(PostgresRuntime, 'open'), call = vi.fn()
    expect(() => createCoordinatedHttpRateLimiter(value)).toThrow()
    await expect(startRuntimeService({ runtime: { dataDirectory: '/not-opened' }, token, actor: 'fixture', coordinatedRateLimits: value } as never)).rejects.toHaveProperty('code', 'invalid-command')
    await expect(startPostgresRuntimeService({ runtime: {} as never, token, actor: 'fixture', coordinatedRateLimits: value } as never)).rejects.toHaveProperty('code', 'invalid-command')
    await expect(startPreviewGateway({ source: echo, projectId: randomUUID(), token, coordinatedRateLimits: value } as never, { call })).rejects.toHaveProperty('code', 'invalid-command')
    expect(sqlite).not.toHaveBeenCalled(); expect(postgres).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled()
  })
  it('rejects simultaneous local and coordinated policies before opening either backend', async () => {
    const sqlite = vi.spyOn(LocalRuntime, 'open'), postgres = vi.spyOn(PostgresRuntime, 'open')
    const patch = { token, actor: 'fixture', rateLimits: policy, coordinatedRateLimits: options() }
    await expect(startRuntimeService({ runtime: { dataDirectory: '/not-opened' }, ...patch })).rejects.toHaveProperty('code', 'invalid-command')
    await expect(startPostgresRuntimeService({ runtime: {} as never, ...patch })).rejects.toHaveProperty('code', 'invalid-command')
    expect(sqlite).not.toHaveBeenCalled(); expect(postgres).not.toHaveBeenCalled()
  })
  it('preserves the explicit callable while cloning PostgreSQL startup configuration', async () => {
    const open = vi.spyOn(PostgresRuntime, 'open').mockRejectedValue(new Error('TEST_ONLY_DATABASE_NOT_OPENED'))
    const consume = vi.fn(async (request: HttpRateDebit) => receipt(request))
    await expect(startPostgresRuntimeService({ runtime: {} as never, token, actor: 'fixture', coordinatedRateLimits: options(consume) }))
      .rejects.toThrow('TEST_ONLY_DATABASE_NOT_OPENED')
    expect(open).toHaveBeenCalledTimes(1); expect(consume).not.toHaveBeenCalled()
  })
})

describe('actual owned HTTP services with a shared test adapter (not cluster/database qualification)', () => {
  it('admits one shared quota across two independent SQLite owners and retains no denied run', async () => {
    const shared = sharedFixture(3), owners = [await fixture(shared.config), await fixture(shared.config)]
    const commands = Array.from({ length: 10 }, () => start())
    const responses = await Promise.all(commands.map((command, i) => owners[i % 2]!.raw(command)))
    expect(responses.filter(r => r.status === 200)).toHaveLength(3)
    expect(responses.filter(r => r.status === 429)).toHaveLength(7)
    for (const response of responses.filter(r => r.status === 429)) {
      expect(response.headers.get('retry-after')).toBe('3600')
      expect(await response.json()).toMatchObject({ code: 'rate-limit', execution: 'not-dispatched', retryAfterSeconds: 3600 })
    }
    expect(shared.calls).toHaveLength(10); expect(new Set(shared.calls.map(call => call.requestId)).size).toBe(10)
    expect(JSON.stringify(shared.calls)).not.toContain('PRIVATE_COORDINATED_INPUT')
    expect(JSON.stringify(shared.calls)).not.toContain(token)
    for (let i = 0; i < owners.length; i++) {
      const rows = await retained(owners[i]!)
      expect(rows.map(r => r.id).sort()).toEqual(commands.filter((_, j) => j % 2 === i && responses[j]!.status === 200).map(c => c.id).sort())
      for (const row of rows) expect(row.status).toBe('paused')
    }
  })
  it('does not debit rejected owner/protocol/instance requests or exempt capabilities; exposes only pinned metadata', async () => {
    const shared = sharedFixture(), f = await fixture(shared.config)
    for (const headers of [{ authorization: 'Bearer ' + 'b'.repeat(64) }, { 'x-jevable-instance': randomUUID() }, { 'x-jevable-protocol': 'invalid' }])
      expect((await f.raw(start(), '/v1/operations', 'POST', headers)).status).not.toBe(200)
    const caps = await (await f.raw({}, '/v1/capabilities', 'GET')).json()
    expect(caps.api.rateLimits).toMatchObject({ algorithm: 'host-coordinated-token-bucket', scope: 'explicit-shared-scope', persistence: 'coordinator-defined; not-attested',
      coordinator: { scope: shared.config.scope, policySha256: expect.stringMatching(/^[a-f0-9]{64}$/u), timeoutMs: 100 }, automaticRetry: false })
    expect(shared.calls).toHaveLength(0)
    expect((await f.raw(start())).status).toBe(200); expect((await f.raw(start())).status).toBe(429)
    expect(shared.calls.map(call => call.lane)).toEqual(['requests', 'requests'])
  })
  it('keeps shared owner stop/status reserve separate from starts, continue and approvals', async () => {
    const shared = sharedFixture(), a = await fixture(shared.config), b = await fixture(shared.config), command = start()
    expect((await a.raw(command)).status).toBe(200)
    expect((await b.raw(start())).status).toBe(429)
    expect((await a.raw({ operation: 'runs.advance', id: command.id, mode: 'continue', requestId: randomUUID(), expectedCheckpointSha256: 'b'.repeat(64) })).status).toBe(429)
    expect((await a.raw({ operation: 'approvals.decide', id: command.id, attemptId: randomUUID(), action: 'approve' })).status).toBe(429)
    expect((await b.raw({}, '/v1/health', 'GET')).status).toBe(200)
    expect((await a.raw({ operation: 'runs.show', id: command.id })).status).toBe(200)
    expect((await a.raw({ operation: 'runs.cancel', id: command.id, requestId: randomUUID() })).status).toBe(200)
    expect(shared.calls.map(call => call.lane)).toEqual(['requests', 'requests', 'requests', 'requests', 'controls', 'controls', 'controls'])
    expect(await retained(a)).toMatchObject([{ id: command.id, status: 'cancelled' }]); expect(await retained(b)).toEqual([])
  })
  it('does not reset shared test coordinator quota when an HTTP owner is explicitly replaced', async () => {
    const shared = sharedFixture(), first = await fixture(shared.config), command = start()
    expect((await first.raw(command)).status).toBe(200)
    await first.service.close(); await first.service.closed
    const second = await fixture(shared.config, { runtime: { dataDirectory: first.dataDirectory } })
    expect(second.service.instanceId).not.toBe(first.service.instanceId)
    expect((await second.raw(start())).status).toBe(429)
    expect(await retained(second)).toMatchObject([{ id: command.id, status: 'paused' }])
  })
  it('shares async admission while exact metadata reads use reserve and denied UUIDs remain absent', async () => {
    const shared = sharedFixture(), f = await fixture(shared.config, { asyncRuns: { maxConcurrentRuns: 2 } })
    const created = start(), denied = start()
    expect((await f.raw(created)).status).toBe(200)
    expect((await f.raw({ kind: 'workflow', id: denied.id, yaml: echo, input: 'PRIVATE_ASYNC', paused: true }, '/v1/async-runs')).status).toBe(429)
    expect((await f.raw({}, '/v1/async-runs/' + created.id, 'GET')).status).toBe(200)
    expect((await f.raw({}, '/v1/async-runs/' + denied.id, 'GET')).status).toBe(404)
    expect(shared.calls.map(call => call.lane)).toEqual(['requests', 'requests', 'controls', 'controls'])
    expect(await retained(f)).toMatchObject([{ id: created.id, status: 'paused' }])
  })
  it('keeps inert preview HTML exempt, debits scoped operations and authenticates before reserve', async () => {
    const shared = sharedFixture(2), f = await fixture(shared.config, { preview: { source: echo } })
    expect((await fetch(f.service.url)).status).toBe(200); expect(shared.calls).toHaveLength(0)
    const boot = await f.raw({}, '/v1/preview/bootstrap'), session = (await boot.json()).result
    expect(boot.status).toBe(200)
    const command = start(), scoped = { authorization: `Bearer ${session.token}` }
    expect((await f.raw({ operation: 'run', id: command.id, input: command.input, paused: true }, '/v1/preview/operations', 'POST', scoped)).status).toBe(200)
    expect((await f.raw({ operation: 'runs' }, '/v1/preview/operations', 'POST', scoped)).status).toBe(429)
    expect((await f.raw({ operation: 'show', id: command.id }, '/v1/preview/operations', 'POST', { authorization: 'Bearer invalid' })).status).toBe(401)
    expect((await f.raw({ operation: 'show', id: command.id }, '/v1/preview/operations', 'POST', scoped)).status).toBe(200)
    expect(shared.calls.map(call => call.lane)).toEqual(['requests', 'requests', 'requests', 'controls'])
    expect(await retained(f)).toMatchObject([{ id: command.id, status: 'paused' }])
  })
  it('never lets valid reviewer grants use owner reserve or settle an approval after exhaustion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-coordinated-reviewer-')), runtime = await LocalRuntime.open({ dataDirectory: directory })
    let runId!: string, prepared!: ReturnType<typeof prepareGrantToken>, before!: Awaited<ReturnType<LocalRuntime['events']>>
    try {
      const run = await runtime.run(approval, { message: 'PRIVATE_APPROVAL' })
      if (run.state.status !== 'waiting') throw Error('expected approval wait')
      runId = run.id; prepared = prepareGrantToken(randomUUID())
      await runtime.issueGrant({ id: prepared.id, tokenSha256: prepared.tokenSha256, actor: 'fixture', expiresAt: new Date(Date.now() + 3600000).toISOString(),
        scope: { kind: 'reviewer', runId: run.id, revision: run.revision, attemptId: run.state.attempt.id, decisions: ['approve'] } })
      before = await runtime.events(run.id)
    } finally { await runtime.close() }
    const shared = sharedFixture(), f = await fixture(shared.config, { runtime: { dataDirectory: directory }, reviewerDecisions: true })
    expect((await f.raw({ operation: 'runs.list' })).status).toBe(200)
    const delegated = await f.raw({ requestId: randomUUID(), action: 'approve' }, '/v1/reviewer/decisions', 'POST', { authorization: `Bearer ${prepared.token}` })
    expect(delegated.status).toBe(429)
    expect((await f.raw({ operation: 'runs.show', id: runId })).status).toBe(200)
    expect(shared.calls.map(call => call.lane)).toEqual(['requests', 'requests', 'controls'])
    await f.service.close(); await f.service.closed
    const reopened = await LocalRuntime.open({ dataDirectory: directory })
    try { expect(await reopened.events(runId)).toEqual(before) } finally { await reopened.close() }
  })
  it('refuses dispatch if drain starts while the debit is pending; host still owns coordinator lifecycle', async () => {
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(yes => { enter = yes }), hold = new Promise<void>(yes => { release = yes })
    const consume = vi.fn(async (request: HttpRateDebit) => { enter(); await hold; return receipt(request) })
    const f = await fixture(options(consume)), command = start(), response = f.raw(command)
    try {
      await entered; expect(await f.service.close(1)).toMatchObject({ status: 'draining' })
    } finally { release() }
    const rejected = await response
    expect(rejected.status).toBe(503); expect(await rejected.json()).toMatchObject({ code: 'draining' })
    expect(await retained(f)).toEqual([]); expect(consume).toHaveBeenCalledTimes(1)
  })
  it('returns safe 503 on timeout and never executes on late acknowledgement or automatically retries', async () => {
    let release!: (receipt: HttpRateDebitReceipt) => void, request!: HttpRateDebit, signal!: AbortSignal
    const consume = vi.fn((value: HttpRateDebit, abort: AbortSignal) => { request = value; signal = abort; return new Promise<HttpRateDebitReceipt>(yes => { release = yes }) })
    const f = await fixture(options(consume)), command = start(), response = await f.raw(command)
    expect(response.status).toBe(503); expect(response.headers.get('retry-after')).toBeNull()
    expect(await response.json()).toMatchObject({ code: 'rate-coordinator-unavailable', execution: 'not-dispatched', quota: 'uncertain; no-retry-or-refund' })
    expect(signal.aborted).toBe(true); release(receipt(request)); await Promise.resolve()
    expect(await retained(f)).toEqual([]); expect(consume).toHaveBeenCalledTimes(1)
  })
  it('sanitizes upstream exceptions in HTTP bodies and leaves the requested UUID absent', async () => {
    const consume = vi.fn(async () => { throw Error('PRIVATE_DATABASE_PASSWORD') }), f = await fixture(options(consume))
    const response = await f.raw(start())
    expect(response.status).toBe(503); expect(response.headers.get('retry-after')).toBeNull()
    const body = await response.text(); expect(body).not.toContain('PRIVATE_DATABASE_PASSWORD'); expect(body).toContain('not-dispatched')
    expect(await retained(f)).toEqual([]); expect(consume).toHaveBeenCalledTimes(1)
  })
  it('does not close a coordinator with its HTTP server or consume quota during startup', async () => {
    const config = options(), consume = vi.spyOn(config, 'consume'), close = vi.fn(async () => {})
    const server = await startRuntimeServer({ token, actor: 'fixture', coordinatedRateLimits: config }, async () => ({
      capabilities: () => ({}), withTraceParent: (_parent, operation) => operation(), close,
    }))
    cleanup.push(async () => { await server.close(); await server.closed })
    expect(consume).not.toHaveBeenCalled(); await server.close(); await server.closed
    expect(close).toHaveBeenCalledTimes(1); expect(consume).not.toHaveBeenCalled()
  })
})

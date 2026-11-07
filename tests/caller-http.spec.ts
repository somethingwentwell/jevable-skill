import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LocalRuntime, prepareGrantToken } from '../src/runtime/index.ts'
import { startRuntimeService, RuntimeClient, CallerClient } from '../src/http/index.ts'
import { startPostgresRuntimeService } from '../src/http/postgres.ts'
import { CORE_VERSION, PROTOCOL_VERSION } from '../src/capabilities.ts'
import { main } from '../src/cli.ts'

const yaml = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture(enabled = true, maxConcurrentRequests = 16, source = yaml) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-caller-http-')), token = randomBytes(32).toString('hex')
  const runtime = await LocalRuntime.open({ dataDirectory })
  const project = runtime.editProject({ operation: 'create', yaml: source, title: 'Caller HTTP fixture', actor: 'owner:test' })
  const release = runtime.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision,
    version: '1.0.0', actor: 'owner:test', runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
  const pin = { id: release.snapshot.id, sha256: release.sha256, revision: release.snapshot.workflow.revision }
  const grants = []
  for (const permissions of [['start', 'read', 'cancel'], ['start'], ['read'], ['start', 'cancel']] as const) {
    const grant = prepareGrantToken(randomUUID())
    await runtime.issueGrant({ id: grant.id, tokenSha256: grant.tokenSha256, actor: 'owner:test',
      expiresAt: new Date(Date.now() + 3600000).toISOString(), scope: { kind: 'caller', release: pin, permissions: [...permissions] } })
    grants.push(grant)
  }
  await runtime.close()
  const service = await startRuntimeService({ runtime: { dataDirectory }, token, actor: 'owner:service', callerOperations: enabled, maxConcurrentRequests })
  cleanup.push(async () => { await service.close(); await service.closed })
  const owner = new RuntimeClient(service.url, token), grant = grants[0]!
  const caller = new CallerClient(service.url, grant.token, service.instanceId, pin)
  const request = { input: 'PRIVATE_CALLER_INPUT', options: { id: randomUUID() } }
  const raw = (body: unknown = { operation: 'start', release: pin, ...request }, headers: Record<string, string> = {}, path = '/v1/caller/operations', method = 'POST') =>
    fetch(service.url + path, { method, headers: { Authorization: `Bearer ${grant.token}`, 'Content-Type': 'application/json',
      'X-Jevable-Protocol': PROTOCOL_VERSION, 'X-Jevable-Instance': service.instanceId, ...headers },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) })
  const events = async () => (await owner.operation({ operation: 'runs.events', id: request.options.id }) as any).result
  return { dataDirectory, token, grants, grant, pin, service, owner, caller, request, raw, events }
}

describe('standalone opt-in pinned caller HTTP and CLI', () => {
  it.each(['paused', 'waiting'])('cancels its own %s run without granting output access; receipt retry adds no event', async status => {
    const source = status === 'waiting' ? await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8') : yaml
    const f = await fixture(true, 16, source), grant = f.grants[3]!, client = new CallerClient(f.service.url, grant.token, f.service.instanceId, f.pin)
    const input = status === 'waiting' ? { message: 'PRIVATE_INPUT' } : 'PRIVATE_INPUT'
    await client.start({ input, options: { id: f.request.options.id, paused: status === 'paused' } })
    const request = { requestId: randomUUID() }, receipt = await client.cancel(f.request.options.id, request), events = await f.events()
    expect(receipt.result).toMatchObject({ id: f.request.options.id, status: 'cancelled', requestId: request.requestId,
      externalEffects: expect.stringContaining('not-reverted') })
    expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE_|actor|delegation|grantId|output|steps|yaml/)
    expect(await client.cancel(f.request.options.id, request)).toEqual(receipt)
    expect(await f.events()).toEqual(events)
    await expect(client.read(f.request.options.id)).rejects.toHaveProperty('code', 'not-found')
    await expect(client.cancel(f.request.options.id, { requestId: randomUUID() })).rejects.toHaveProperty('code', 'conflict')
    expect(await f.events()).toEqual(events)
  })
  it('filters cancellation permission/ownership/token and reviewed pins before parent adoption or writing', async () => {
    const f = await fixture(), id = f.request.options.id, request = { requestId: randomUUID() }
    await f.caller.start({ ...f.request, options: { id, paused: true } }); const events = await f.events()
    const parent = '00-' + '3'.repeat(32) + '-' + '4'.repeat(16) + '-01', observed = vi.spyOn(LocalRuntime.prototype, 'withTraceParent')
    for (const grant of [f.grants[1]!, f.grants[2]!, f.grants[3]!, prepareGrantToken(f.grant.id)])
      await expect(new CallerClient(f.service.url, grant.token, f.service.instanceId, f.pin).cancel(id, request, parent)).rejects.toHaveProperty('code', 'not-found')
    for (const field of ['id', 'sha256', 'revision'])
      await expect(new CallerClient(f.service.url, f.grant.token, f.service.instanceId, { ...f.pin, [field]: field === 'id' ? randomUUID() : 'b'.repeat(64) })
        .cancel(id, request, parent)).rejects.toHaveProperty('code', 'not-found')
    expect(observed.mock.calls.filter(call => call[0] === parent)).toHaveLength(0)
    expect(await f.events()).toEqual(events)
    await f.caller.cancel(id, request, parent)
    expect(observed.mock.calls.filter(call => call[0] === parent)).toHaveLength(1)
  })
  it.each(['new', 'retry'])('reauthenticates cancellation %s after an awaited trusted HTTP context', async phase => {
    const f = await fixture(), id = f.request.options.id, request = { requestId: randomUUID() }
    await f.caller.start({ ...f.request, options: { id, paused: true } })
    if (phase === 'retry') await f.caller.cancel(id, request)
    const events = await f.events(), original = LocalRuntime.prototype.cancelWithGrant
    vi.spyOn(LocalRuntime.prototype, 'cancelWithGrant').mockImplementation(function(this: LocalRuntime, token, runId, value, context) {
      return original.call(this, token, runId, value, async (pin, execute) => context!(pin, async () => {
        await this.revokeGrant({ id: f.grant.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' })
        await Promise.resolve(); return execute()
      }))
    })
    await expect(f.caller.cancel(id, request)).rejects.toHaveProperty('code', 'not-found')
    expect(await f.events()).toEqual(events)
  })
  it('retains committed pending cancellation after lost COMMIT acknowledgment and replacement; retry never settles', async () => {
    const f = await fixture(), id = f.request.options.id, request = { requestId: randomUUID() }
    await f.caller.start({ ...f.request, options: { id, paused: true } })
    const original = DatabaseSync.prototype.exec; let armed = true
    const failure = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function(this: DatabaseSync, sql) {
      original.call(this, sql); if (armed && sql === 'COMMIT') { armed = false; throw Error('PRIVATE_LOST_ACK') }
    })
    await expect(f.caller.cancel(id, request)).rejects.toMatchObject({ code: 'operation-failed', message: expect.not.stringContaining('PRIVATE_LOST_ACK') })
    failure.mockRestore()
    const events = await f.events(), receipt = await f.caller.cancel(id, request)
    expect(receipt.result.status).toBe('paused'); expect(await f.events()).toEqual(events)
    await f.service.close(); await f.service.closed
    const replacement = await startRuntimeService({ runtime: { dataDirectory: f.dataDirectory }, token: f.token, actor: 'owner:service', callerOperations: true })
    cleanup.push(async () => { await replacement.close(); await replacement.closed })
    const client = new CallerClient(replacement.url, f.grant.token, replacement.instanceId, f.pin)
    expect((await client.cancel(id, request)).result).toEqual(receipt.result)
    expect((await new RuntimeClient(replacement.url, f.token).operation({ operation: 'runs.events', id }) as any).result).toEqual(events)
    await expect(new CallerClient(replacement.url, f.grant.token, f.service.instanceId, f.pin).cancel(id, request)).rejects.toHaveProperty('code', 'instance-mismatch')
  })
  it('drives strict retained-request cancellation CLI and refuses malformed files before credential access', async () => {
    const f = await fixture(), id = f.request.options.id, request = { requestId: randomUUID() }
    await f.caller.start({ ...f.request, options: { id, paused: true } })
    const pinFile = join(f.dataDirectory, 'pin.json'), tokenFile = join(f.dataDirectory, 'caller.token'), requestFile = join(f.dataDirectory, 'cancel.json')
    await writeFile(pinFile, JSON.stringify(f.pin)); await writeFile(tokenFile, f.grant.token, { mode: 0o600 }); await writeFile(requestFile, JSON.stringify(request))
    const flags = ['--endpoint', f.service.url, '--instance-id', f.service.instanceId, '--release-pin-file', pinFile]
    const invoke = async (tail: string[]) => { let out = '', err = ''; const code = await main(['caller', 'cancel', id, ...flags, ...tail],
      { out: s => { out += s }, err: s => { err += s } }); return { code, out, err } }
    const args = ['--token-file', tokenFile, '--request-file', requestFile], first = await invoke(args)
    expect(first.code, first.err).toBe(0); expect(JSON.parse(first.out).result).toMatchObject({ status: 'cancelled', requestId: request.requestId })
    const events = await f.events(); expect(await invoke(args)).toEqual(first); expect(await f.events()).toEqual(events)
    expect(first.out + first.err).not.toContain(f.grant.token)
    for (const value of [{}, { requestId: 'invalid' }, { ...request, actor: 'forged' }, { ...request, input: 'x'.repeat(5000) }]) {
      await writeFile(requestFile, JSON.stringify(value))
      const result = await invoke(['--token-file', 'not-read.token', '--request-file', requestFile])
      expect(result.code).not.toBe(0); expect(result.err).not.toContain('not-read.token'); expect(result.err).not.toContain('transport-uncertain')
    }
    for (const extra of [[], ['--data-dir', 'forbidden'], ['--runtime', 'docker'], ['--storage', 'postgres'], ['--actor', 'forged']]) {
      const result = await invoke(['--token-file', 'not-read.token', ...extra])
      expect(result.code).not.toBe(0); expect(result.err).not.toContain('transport-uncertain')
    }
  })
  it('adopts trace parents only after exact scoped authentication and reviewed release agreement', async () => {
    const f = await fixture(), parent = '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01'
    const observed = vi.spyOn(LocalRuntime.prototype, 'withTraceParent')
    await expect(new CallerClient(f.service.url, f.grant.token, f.service.instanceId, { ...f.pin, id: randomUUID() })
      .start(f.request, parent)).rejects.toHaveProperty('code', 'not-found')
    await expect(new CallerClient(f.service.url, prepareGrantToken(f.grant.id).token, f.service.instanceId, f.pin)
      .start(f.request, parent)).rejects.toHaveProperty('code', 'not-found')
    expect(observed.mock.calls.filter(call => call[0] === parent)).toHaveLength(0)
    await f.caller.start(f.request, parent)
    expect(observed.mock.calls.filter(call => call[0] === parent)).toHaveLength(1)
  })
  it('never gives callers the owner-reserved control slot while an admitted request is pending', async () => {
    const f = await fixture(true, 1), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
    const original = LocalRuntime.prototype.startWithGrant
    vi.spyOn(LocalRuntime.prototype, 'startWithGrant').mockImplementation(async function(this: LocalRuntime, ...args) {
      entered.resolve(); await gate.promise; return original.apply(this, args)
    })
    const pending = f.caller.start(f.request)
    try {
      await entered.promise
      await expect(f.caller.read(f.request.options.id)).rejects.toMatchObject({ code: 'concurrency-limit', status: 429 })
      await expect(f.caller.cancel(f.request.options.id, { requestId: randomUUID() })).rejects.toMatchObject({ code: 'concurrency-limit', status: 429 })
      await expect(f.owner.operation({ operation: 'runs.show', id: f.request.options.id })).rejects.toMatchObject({ code: 'not-found', status: 404 })
    } finally { gate.resolve(); await pending }
  })
  it('rejects malformed retained input/pins and read identity before touching a missing secret', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jevable-caller-cli-invalid-')), pinFile = join(dir, 'pin.json'), inputFile = join(dir, 'start.json')
    const pin = { id: randomUUID(), sha256: 'a'.repeat(64), revision: 'b'.repeat(64) }
    await writeFile(pinFile, JSON.stringify(pin)); await writeFile(inputFile, JSON.stringify({ input: 'x', options: { id: randomUUID() }, actor: 'forged' }))
    const flags = ['--endpoint', 'http://127.0.0.1:9', '--instance-id', randomUUID(), '--release-pin-file', pinFile, '--token-file', 'not-read.token']
    const invoke = async (action: string, value: string) => {
      let err = ''; const code = await main(['caller', action, value, ...flags], { out: () => {}, err: s => { err += s } })
      expect(code).not.toBe(0); expect(err).not.toContain('not-read.token'); expect(err).not.toContain('transport-uncertain')
    }
    await invoke('start', inputFile); await invoke('read', 'not-a-uuid')
    await writeFile(pinFile, JSON.stringify({ ...pin, actor: 'forged' })); await invoke('read', randomUUID())
  })
  it('returns metadata on start and own completed output only on read; exact retries do not write', async () => {
    const f = await fixture(), first = await f.caller.start(f.request), before = await f.events()
    expect(first.result.status).toBe('completed'); expect(first.result).not.toHaveProperty('output')
    expect(await f.caller.start(f.request)).toEqual(first)
    expect(await f.events()).toEqual(before)
    expect((await f.caller.read(f.request.options.id)).result).toEqual({ ...first.result, output: f.request.input })
    for (const key of ['capabilities', 'health', 'operation']) expect(f.caller).not.toHaveProperty(key)
    expect(JSON.stringify(first)).not.toContain('PRIVATE_'); expect(JSON.stringify(first)).not.toContain(f.grant.id)
    await expect(f.caller.start({ ...f.request, input: 'changed' })).rejects.toHaveProperty('code', 'conflict')
    expect(await f.events()).toEqual(before)
  })
  it('drives protected-file CLI without an owner handshake and rejects mixed target flags before secret access', async () => {
    const f = await fixture(), tokenFile = join(f.dataDirectory, 'caller.token'), pinFile = join(f.dataDirectory, 'pin.json'), requestFile = join(f.dataDirectory, 'start.json')
    await writeFile(tokenFile, f.grant.token + '\n', { mode: 0o600 })
    await writeFile(pinFile, JSON.stringify(f.pin)); await writeFile(requestFile, JSON.stringify(f.request))
    const flags = ['--endpoint', f.service.url, '--instance-id', f.service.instanceId, '--release-pin-file', pinFile, '--token-file', tokenFile]
    for (const [action, value] of [['start', requestFile], ['read', f.request.options.id]]) {
      let stdout = '', stderr = ''
      const code = await main(['caller', action!, value!, ...flags], { out: s => { stdout += s }, err: s => { stderr += s } })
      expect(code, stderr).toBe(0); expect(JSON.parse(stdout).result).toMatchObject({ id: f.request.options.id, status: 'completed' })
      expect(stdout + stderr).not.toContain(f.grant.token)
    }
    for (const extra of [['--data-dir', 'forbidden'], ['--runtime', 'docker'], ['--storage', 'postgres'], ['--actor', 'forged']]) {
      let stderr = ''
      const code = await main(['caller', 'start', 'not-read.json', ...flags, ...extra], { out: () => {}, err: s => { stderr += s } })
      expect(code).not.toBe(0); expect(stderr).not.toContain('transport-uncertain')
    }
  })
  it.each(['id', 'sha256', 'revision'] as const)('refuses an unreviewed release %s BEFORE execution', async field => {
    const f = await fixture(), pin = { ...f.pin, [field]: field === 'id' ? randomUUID() : 'b'.repeat(64) }
    await expect(new CallerClient(f.service.url, f.grant.token, f.service.instanceId, pin).start(f.request)).rejects.toHaveProperty('code', 'not-found')
    const runs = (await f.owner.operation({ operation: 'runs.list' }) as any).result
    expect(runs).toEqual({ schemaVersion: 1, runs: [] })
  })
  it('preserves role and per-grant ownership boundaries and refuses revoked receipt observation', async () => {
    const f = await fixture(); await f.caller.start(f.request)
    const startOnly = new CallerClient(f.service.url, f.grants[1]!.token, f.service.instanceId, f.pin)
    const readOnly = new CallerClient(f.service.url, f.grants[2]!.token, f.service.instanceId, f.pin)
    await expect(startOnly.read(f.request.options.id)).rejects.toHaveProperty('code', 'not-found')
    await expect(readOnly.start(f.request)).rejects.toHaveProperty('code', 'not-found')
    await expect(readOnly.read(f.request.options.id)).rejects.toHaveProperty('code', 'not-found')
    await expect(startOnly.start(f.request)).rejects.toHaveProperty('code', 'not-found')
    for (const path of ['/v1/health', '/v1/capabilities', '/v1/operations', '/v1/reviewer/decisions'])
      expect((await f.raw({}, {}, path)).status).toBe(401)
    expect((await f.raw(undefined, { Authorization: `Bearer ${f.token}` })).status).toBe(401)
    await f.owner.operation({ operation: 'grants.revoke', command: { id: f.grant.id, requestId: randomUUID(), expectedGeneration: 1 } })
    await expect(f.caller.start(f.request)).rejects.toHaveProperty('code', 'not-found')
    await expect(f.caller.read(f.request.options.id)).rejects.toHaveProperty('code', 'not-found')
  })
  it('requires exact instance/protocol and strict command fields with bounded browser/proxy context', async () => {
    const f = await fixture()
    for (const headers of [{ 'X-Jevable-Instance': '' }, { 'X-Jevable-Instance': randomUUID() }, { 'X-Jevable-Protocol': 'wrong' },
      { Origin: 'https://foreign.invalid' }, { 'X-Forwarded-For': '127.0.0.1' }]) expect((await f.raw(undefined, headers)).status).not.toBe(200)
    for (const body of [{ operation: 'cancel', id: f.request.options.id, release: f.pin },
      { operation: 'start', release: f.pin, ...f.request, actor: 'forged' }]) expect((await f.raw(body)).status).toBe(400)
    const oversized = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(f.service.url + '/v1/caller/operations', { method: 'POST', headers: {
        Authorization: `Bearer ${f.grant.token}`, 'Content-Type': 'application/json', 'Content-Length': '4000001',
        'X-Jevable-Protocol': PROTOCOL_VERSION, 'X-Jevable-Instance': f.service.instanceId,
      } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)) })
      req.on('error', reject); req.end('{}')
    })
    expect(oversized).toBe(413)
    expect((await f.owner.operation({ operation: 'runs.list' }) as any).result).toEqual({ schemaVersion: 1, runs: [] })
  })
  it('is disabled by default/explicit opt-out and refuses preview/release mode before creating state', async () => {
    const f = await fixture(false)
    const caps = await f.owner.capabilities() as any
    expect(caps.api.endpoints).not.toContain('/v1/caller/operations')
    expect((await f.raw()).status).toBe(401)
    const directory = await mkdtemp(join(tmpdir(), 'jevable-caller-incompatible-')), state = join(directory, 'not-created')
    for (const mode of [{ preview: { source: yaml } }, { release: { snapshot: {} } }]) {
      await expect(startRuntimeService({ runtime: { dataDirectory: state }, token: f.token, actor: 'owner', callerOperations: true, ...mode })).rejects.toHaveProperty('code', 'invalid-command')
      await expect(startPostgresRuntimeService({ runtime: {} as never, token: f.token, actor: 'owner', callerOperations: true,
        ...(mode.preview ? { preview: { source: yaml, projectId: randomUUID() } } : { release: mode.release }) })).rejects.toHaveProperty('code', 'invalid-command')
    }
    await expect(access(state)).rejects.toHaveProperty('code', 'ENOENT')
  })
})

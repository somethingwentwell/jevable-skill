import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LocalRuntime, prepareGrantToken } from '../src/runtime/index.ts'
import { PostgresRuntime } from '../src/runtime/postgres.ts'
import { startRuntimeService, CallerClient, RuntimeClient } from '../src/http/index.ts'
import { startPostgresRuntimeService } from '../src/http/postgres.ts'
import { PROTOCOL_VERSION, CORE_VERSION } from '../src/capabilities.ts'
import { main } from '../src/cli.ts'

const source = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const command = (checkpoint: { checkpointSha256: string }, mode: 'step' | 'continue' | 'pause' | 'recover', extra = {}) => ({
  requestId: randomUUID(), mode, expectedCheckpointSha256: checkpoint.checkpointSha256, ...extra,
})
async function fixture(yaml = source, maxConcurrentRequests = 16) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-caller-control-http-')), token = randomBytes(32).toString('hex')
  const owner = await LocalRuntime.open({ dataDirectory })
  const project = await owner.editProject({ operation: 'create', yaml, title: 'Caller control HTTP fixture', actor: 'owner:test' })
  const release = await owner.createRelease({ projectId: project.id, revision: project.acceptedRevision, expectedGeneration: 1,
    version: '1.0.0', actor: 'owner:test', runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
  const pin = { id: release.snapshot.id, sha256: release.sha256, revision: project.acceptedRevision }, grants = []
  for (const permissions of [['start', 'control'], ['start', 'control'], ['start', 'read'], ['start', 'cancel']] as const) {
    const grant = prepareGrantToken(randomUUID())
    await owner.issueGrant({ id: grant.id, tokenSha256: grant.tokenSha256, scope: { kind: 'caller', release: pin, permissions: [...permissions] },
      actor: 'owner:test', expiresAt: new Date(Date.now() + 3600000).toISOString() }); grants.push(grant)
  }
  await owner.close()
  const service = await startRuntimeService({ runtime: { dataDirectory }, actor: 'owner:service', token, callerOperations: true, maxConcurrentRequests })
  cleanup.push(async () => { await service.close(); await service.closed })
  const grant = grants[0]!, client = new CallerClient(service.url, grant.token, service.instanceId, pin), admin = new RuntimeClient(service.url, token)
  const id = randomUUID(), input = yaml === source ? 'PRIVATE_CONTROL_INPUT' : { message: 'PRIVATE_CONTROL_INPUT' }
  await client.start({ input, options: { id, paused: true } })
  const checkpoint = (await client.checkpoint(id)).result
  const events = async () => (await admin.operation({ operation: 'runs.events', id }) as any).result
  const raw = (body: unknown) => fetch(service.url + '/v1/caller/operations', { method: 'POST', headers: { authorization: `Bearer ${grant.token}`,
    'content-type': 'application/json', 'x-jevable-protocol': PROTOCOL_VERSION, 'x-jevable-instance': service.instanceId }, body: JSON.stringify(body) })
  return { dataDirectory, token, service, grant, grants, client, admin, id, pin, checkpoint, events, raw }
}

describe('standalone strict opt-in caller checkpoint/control HTTP and CLI', () => {
  it('steps, pauses, configures/clears breakpoints and completes with metadata-only canonical receipts, without owner fallback', async () => {
    const f = await fixture(), ownerAdvance = vi.spyOn(LocalRuntime.prototype, 'advance'), first = command(f.checkpoint, 'step')
    const stepped = (await f.client.control(f.id.toUpperCase(), { ...first, requestId: first.requestId.toUpperCase() })).result
    expect(stepped).toMatchObject({ id: f.id, status: 'paused', mode: 'step', requestId: first.requestId })
    const pause = (await f.client.control(f.id, command(stepped, 'pause'))).result
    const hit = (await f.client.control(f.id, command(pause, 'continue', { breakpoints: ['result'] }))).result
    expect(hit.status).toBe('paused')
    const done = (await f.client.control(f.id, command(hit, 'continue', { breakpoints: [] }))).result
    expect(done.status).toBe('completed'); expect(ownerAdvance).not.toHaveBeenCalled()
    expect(JSON.stringify([f.checkpoint, stepped, pause, hit, done])).not.toMatch(/PRIVATE|"(?:output|input|yaml|actor|grantId|scope|delegation|steps|breakpoints)"/)
    const events = await f.events()
    expect((await f.client.control(f.id, first)).result.status).toBe('completed')
    expect((await f.client.checkpoint(f.id)).result.status).toBe('completed'); expect(await f.events()).toEqual(events)
    await expect(f.client.read(f.id)).rejects.toHaveProperty('code', 'not-found')
    await expect(f.client.cancel(f.id, { requestId: randomUUID() })).rejects.toHaveProperty('code', 'not-found')
    expect((await f.admin.operation({ operation: 'runs.show', id: f.id }) as any).result.output).toBe('PRIVATE_CONTROL_INPUT')
  })
  it('authenticates creating control grant and reviewed release before trace-parent adoption or private access', async () => {
    const f = await fixture(), request = command(f.checkpoint, 'step'), events = await f.events()
    const parent = '00-' + '3'.repeat(32) + '-' + '4'.repeat(16) + '-01', observed = vi.spyOn(LocalRuntime.prototype, 'withTraceParent')
    for (const grant of [...f.grants.slice(1), prepareGrantToken(f.grant.id)]) {
      const client = new CallerClient(f.service.url, grant.token, f.service.instanceId, f.pin)
      await expect(client.checkpoint(f.id, parent)).rejects.toHaveProperty('code', 'not-found')
      await expect(client.control(f.id, request, parent)).rejects.toHaveProperty('code', 'not-found')
    }
    for (const field of ['id', 'sha256', 'revision']) {
      const client = new CallerClient(f.service.url, f.grant.token, f.service.instanceId, { ...f.pin, [field]: field === 'id' ? randomUUID() : 'c'.repeat(64) })
      await expect(client.checkpoint(f.id, parent)).rejects.toHaveProperty('code', 'not-found')
      await expect(client.control(f.id, request, parent)).rejects.toHaveProperty('code', 'not-found')
    }
    expect(observed.mock.calls.filter(call => call[0] === parent)).toHaveLength(0); expect(await f.events()).toEqual(events)
    await f.client.control(f.id, request, parent); expect(observed.mock.calls.filter(call => call[0] === parent)).toHaveLength(1)
  })
  it.each(['actor', 'at', 'delegation', 'grantId', 'scope', 'traceParent', 'input', 'output', 'unknown'])('refuses nested or envelope %s injection without writes', async key => {
    const f = await fixture(), request = command(f.checkpoint, 'step'), events = await f.events()
    for (const body of [{ operation: 'control', id: f.id, release: f.pin, request: { ...request, [key]: 'forged' } },
      { operation: 'control', id: f.id, release: f.pin, request, [key]: 'forged' },
      { operation: 'checkpoint', id: f.id, release: f.pin, [key]: 'forged' }]) expect((await f.raw(body)).status).toBe(400)
    expect(await f.events()).toEqual(events)
  })
  it.each(['new', 'retry', 'checkpoint'])('rechecks authority after awaited %s HTTP context and refuses without a run write', async phase => {
    const f = await fixture(), request = command(f.checkpoint, 'step')
    if (phase === 'retry') await f.client.control(f.id, request)
    const events = await f.events()
    const wrap = (owner: LocalRuntime, context: any) => async (pin: any, execute: any) => context(pin, async () => {
      await owner.revokeGrant({ id: f.grant.id, expectedGeneration: 1, requestId: randomUUID(), actor: 'owner:test' }); await Promise.resolve(); return execute()
    })
    if (phase === 'checkpoint') {
      const original = LocalRuntime.prototype.controlCheckpointWithGrant
      vi.spyOn(LocalRuntime.prototype, 'controlCheckpointWithGrant').mockImplementation(function(this: LocalRuntime, token, id, context) { return original.call(this, token, id, wrap(this, context)) })
      await expect(f.client.checkpoint(f.id)).rejects.toHaveProperty('code', 'not-found')
    } else {
      const original = LocalRuntime.prototype.advanceWithGrant
      vi.spyOn(LocalRuntime.prototype, 'advanceWithGrant').mockImplementation(function(this: LocalRuntime, token, id, value, context) { return original.call(this, token, id, value, wrap(this, context)) })
      await expect(f.client.control(f.id, request)).rejects.toHaveProperty('code', 'not-found')
    }
    expect(await f.events()).toEqual(events)
  })
  it('retains a pending committed control after lost SQLite acknowledgment and clean replacement; same-ID retry never executes', async () => {
    const f = await fixture(), request = command(f.checkpoint, 'step'), exec = DatabaseSync.prototype.exec; let armed = true
    const fault = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function(this: DatabaseSync, sql) {
      exec.call(this, sql); if (armed && sql === 'COMMIT') { armed = false; throw Error('PRIVATE_CONTROL_LOST_ACK') }
    })
    await expect(f.client.control(f.id, request)).rejects.toMatchObject({ code: 'operation-failed', message: expect.not.stringContaining('PRIVATE_CONTROL_LOST_ACK') }); fault.mockRestore()
    const events = await f.events(), receipt = (await f.client.control(f.id, request)).result
    expect(receipt.checkpointSha256).not.toBe(f.checkpoint.checkpointSha256); expect(receipt.status).toBe('paused'); expect(await f.events()).toEqual(events)
    await f.service.close(); await f.service.closed
    const service = await startRuntimeService({ runtime: { dataDirectory: f.dataDirectory }, token: f.token, actor: 'owner:replacement', callerOperations: true })
    cleanup.push(async () => { await service.close(); await service.closed })
    const client = new CallerClient(service.url, f.grant.token, service.instanceId, f.pin)
    expect((await client.control(f.id, request)).result).toEqual(receipt)
    expect((await new RuntimeClient(service.url, f.token).operation({ operation: 'runs.events', id: f.id }) as any).result).toEqual(events)
    await expect(new CallerClient(service.url, f.grant.token, f.service.instanceId, f.pin).control(f.id, request)).rejects.toHaveProperty('code', 'instance-mismatch')
    expect((await client.control(f.id, command(receipt, 'continue'))).result.status).toBe('completed')
  })
  it('refuses stale or changed commands, impossible recovery, cancelled state and all approval-wait modes', async () => {
    const f = await fixture(), request = command(f.checkpoint, 'step'), result = (await f.client.control(f.id, request)).result, events = await f.events()
    await expect(f.client.control(f.id, command(f.checkpoint, 'continue'))).rejects.toHaveProperty('code', 'conflict')
    await expect(f.client.control(f.id, { ...request, mode: 'continue' })).rejects.toHaveProperty('code', 'conflict')
    await expect(f.client.control(f.id, command(result, 'recover'))).rejects.toHaveProperty('code', 'conflict'); expect(await f.events()).toEqual(events)
    await f.admin.operation({ operation: 'runs.cancel', id: f.id, requestId: randomUUID() })
    const cancelled = (await f.client.checkpoint(f.id)).result
    await expect(f.client.control(f.id, command(cancelled, 'continue'))).rejects.toHaveProperty('code', 'conflict')
    const a = await fixture(await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8'))
    const waiting = (await a.client.control(a.id, command(a.checkpoint, 'continue'))).result, before = await a.events()
    expect(waiting.status).toBe('waiting')
    for (const mode of ['step', 'continue', 'pause', 'recover'] as const) await expect(a.client.control(a.id, command(waiting, mode))).rejects.toHaveProperty('code', 'conflict')
    expect(await a.events()).toEqual(before)
  })
  it('uses the protected-file CLI for checkpoint/control and rejects input before credential reads', async () => {
    const f = await fixture(), pinFile = join(f.dataDirectory, 'pin.json'), tokenFile = join(f.dataDirectory, 'caller.token'), requestFile = join(f.dataDirectory, 'control.json')
    await writeFile(pinFile, JSON.stringify(f.pin)); await writeFile(tokenFile, f.grant.token, { mode: 0o600 })
    const flags = ['--endpoint', f.service.url, '--instance-id', f.service.instanceId, '--release-pin-file', pinFile]
    const invoke = async (action: string, args: string[]) => { let out = '', err = ''; const code = await main(['caller', action, f.id, ...flags, ...args], { out: s => { out += s }, err: s => { err += s } }); return { code, out, err } }
    const checkpoint = await invoke('checkpoint', ['--token-file', tokenFile]); expect(checkpoint.code, checkpoint.err).toBe(0)
    expect(JSON.parse(checkpoint.out).result).toEqual(f.checkpoint)
    const request = command(f.checkpoint, 'step'); await writeFile(requestFile, JSON.stringify(request))
    const args = ['--token-file', tokenFile, '--request-file', requestFile], first = await invoke('control', args)
    expect(first.code, first.err).toBe(0); expect(JSON.parse(first.out).result).toMatchObject({ mode: 'step', requestId: request.requestId })
    const events = await f.events(); expect(await invoke('control', args)).toEqual(first); expect(await f.events()).toEqual(events)
    expect(first.out + first.err).not.toContain(f.grant.token)
    for (const value of [{}, { ...request, delegation: {} }, { ...request, expectedCheckpointSha256: 'wrong' }, { ...request, input: 'x'.repeat(20000) }]) {
      await writeFile(requestFile, JSON.stringify(value)); const result = await invoke('control', ['--token-file', 'not-read.token', '--request-file', requestFile])
      expect(result.code).not.toBe(0); expect(result.err).not.toContain('not-read.token'); expect(result.err).not.toContain('transport-uncertain')
    }
    for (const extra of [[], ['--data-dir', 'forbidden'], ['--runtime', 'docker'], ['--storage', 'postgres'], ['--actor', 'forged']]) {
      const result = await invoke('control', ['--token-file', 'not-read.token', ...extra]); expect(result.code).not.toBe(0)
      expect(result.err).not.toContain('not-read.token'); expect(result.err).not.toContain('transport-uncertain')
    }
    expect(await f.events()).toEqual(events)
  })
  it('refuses checkpoint/control overflow without borrowing the reserved owner-control slot', async () => {
    const f = await fixture(source, 1), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), original = LocalRuntime.prototype.advanceWithGrant
    vi.spyOn(LocalRuntime.prototype, 'advanceWithGrant').mockImplementation(async function(this: LocalRuntime, ...args) { entered.resolve(); await gate.promise; return original.apply(this, args) })
    const pending = f.client.control(f.id, command(f.checkpoint, 'step'))
    try {
      await entered.promise
      await expect(f.client.checkpoint(f.id)).rejects.toMatchObject({ code: 'concurrency-limit', status: 429 })
      await expect(f.client.control(f.id, command(f.checkpoint, 'pause'))).rejects.toMatchObject({ code: 'concurrency-limit', status: 429 })
      expect((await f.admin.operation({ operation: 'runs.show', id: f.id }) as any).result.id).toBe(f.id)
    } finally { gate.resolve(); await pending }
  })
  it('routes PostgreSQL management checkpoint/control to the guarded SDK port (routing double, not actual SQL)', async () => {
    const pin = { id: randomUUID(), sha256: 'a'.repeat(64), revision: 'b'.repeat(64) }, id = randomUUID(), grant = prepareGrantToken(randomUUID())
    const receipt = { schemaVersion: 1 as const, id, revision: pin.revision, release: { id: pin.id, sha256: pin.sha256 },
      status: 'paused' as const, createdAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z', checkpointSha256: 'c'.repeat(64) }
    const request = command(receipt, 'step'), checkpoint = vi.fn(async (_token, _id, context) => context(pin, async () => receipt))
    const advance = vi.fn(async (_token, _id, value, context) => context(pin, async () => ({ ...receipt, requestId: value.requestId, mode: value.mode, requestedAt: receipt.createdAt })))
    const owner = { controlCheckpointWithGrant: checkpoint, advanceWithGrant: advance, withTraceParent: vi.fn((_parent, execute) => execute()),
      observeHttpRequest: vi.fn(), observeHttpConnection: vi.fn(), observeHttpTransportFailure: vi.fn(), health: vi.fn(), close: vi.fn(async () => {}) }
    vi.spyOn(PostgresRuntime, 'open').mockResolvedValue(owner as never)
    const service = await startPostgresRuntimeService({ runtime: {} as never, actor: 'owner:fixture', token: randomBytes(32).toString('hex'), callerOperations: true })
    cleanup.push(async () => { await service.close(); await service.closed })
    const client = new CallerClient(service.url, grant.token, service.instanceId, pin)
    expect((await client.checkpoint(id)).result).toEqual(receipt)
    expect((await client.control(id, request)).result.requestId).toBe(request.requestId)
    expect(checkpoint).toHaveBeenCalledWith(grant.token, id, expect.any(Function))
    expect(advance).toHaveBeenCalledWith(grant.token, id, request, expect.any(Function))
  })
})

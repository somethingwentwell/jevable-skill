import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LocalRuntime, prepareGrantToken, executionCheckpointHash, type GrantScope, type ModelCalls } from '../src/runtime/index.ts'
import { RunStore } from '../src/runtime/store.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { SQLiteGrantStore } from '../src/access/sqlite-grants.ts'
import { callerCancellationReceiptSchema } from '../src/access/caller-cancellation.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const decision = await readFile(new URL('../examples/native-decision.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const at = '2026-10-02T00:00:00.000Z', expiresAt = '2026-10-03T00:00:00.000Z'
const owners: LocalRuntime[] = []
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); for (const owner of owners.splice(0)) await owner.close() })
async function fixture(source = echo, models?: ModelCalls) {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at)
  const directory = await mkdtemp(join(tmpdir(), 'jevable-caller-runtime-')), state = join(directory, 'state')
  const owner = await LocalRuntime.open({ dataDirectory: state, ...(models ? { models } : {}) }); owners.push(owner)
  const project = owner.editProject({ operation: 'create', title: 'Caller fixture', yaml: source, actor: 'owner:test' })
  const release = owner.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision,
    version: '1.0.0', actor: 'owner:test', runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
  const scope: Extract<GrantScope, { kind: 'caller' }> = { kind: 'caller', release: { id: release.snapshot.id, sha256: release.sha256,
    revision: release.snapshot.workflow.revision }, permissions: ['read', 'start'] }
  async function issue(permissions = scope.permissions) {
    const prepared = prepareGrantToken(randomUUID())
    await owner.issueGrant({ id: prepared.id, tokenSha256: prepared.tokenSha256, actor: 'owner:test', expiresAt, scope: { ...scope, permissions } })
    return prepared
  }
  const prepared = await issue()
  return { owner, state, release, scope, prepared, issue }
}
const options = () => ({ id: randomUUID() })

describe('standalone caller SDK cancellation', () => {
  it.each(['paused', 'waiting'] as const)('cancels its own %s run with private writer-derived attribution and a metadata-only receipt', async status => {
    const f = await fixture(status === 'waiting' ? approval : echo), caller = await f.issue(['start', 'cancel']), id = randomUUID(), request = { requestId: randomUUID() }
    await f.owner.startWithGrant(caller.token, status === 'waiting' ? { message: 'PRIVATE_INPUT' } : 'PRIVATE_INPUT', { id, paused: status === 'paused' })
    vi.setSystemTime('2026-10-02T00:01:00.000Z')
    const receipt = await f.owner.cancelWithGrant(caller.token, id.toUpperCase(), request)
    expect(receipt.status).toBe('cancelled'); expect(callerCancellationReceiptSchema.parse(receipt)).toEqual(receipt)
    expect(receipt).toMatchObject({ id, requestId: request.requestId, requestedAt: '2026-10-02T00:01:00.000Z', externalEffects: expect.stringContaining('not-reverted') })
    const record = await f.owner.show(id), events = await f.owner.events(id)
    expect(record.cancellation).toEqual({ id: request.requestId, actor: `grant:${caller.id}`, at: receipt.requestedAt,
      delegation: { grantId: caller.id, scope: { ...f.scope, permissions: ['cancel', 'start'] }, deadline: expiresAt } })
    expect(events.find(e => e.kind === 'cancellation-requested')?.data).toEqual(record.cancellation)
    expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE_INPUT|delegation|grantId|actor|yaml|steps|scope/)
    expect(JSON.stringify(await f.owner.exportRun(id))).not.toContain(caller.id)
    expect(JSON.stringify(await f.owner.exportRun(id, true))).toContain(caller.id)
    await expect(f.owner.readWithGrant(caller.token, id)).rejects.toHaveProperty('code', 'not-found')
    expect(await f.owner.cancelWithGrant(caller.token, id, request)).toEqual(receipt)
    expect(await f.owner.events(id)).toEqual(events)
    await f.owner.close(); const reopened = await LocalRuntime.open({ dataDirectory: f.state }); owners.push(reopened)
    expect(await reopened.cancelWithGrant(caller.token, id, request)).toEqual(receipt)
    expect(await reopened.events(id)).toEqual(events)
  })
  it('filters foreign, owner and missing runs before private decoding and never invokes their context', async () => {
    const f = await fixture(), own = await f.issue(['start', 'cancel']), other = await f.issue(['start', 'cancel']), id = randomUUID()
    await f.owner.startWithGrant(own.token, 'private', { id, paused: true })
    const ownerRun = await f.owner.run(echo, 'owner', { paused: true }), hook = vi.fn()
    for (const runId of [id, ownerRun.id, randomUUID()]) {
      const get = vi.spyOn(RunStore.prototype, 'get')
      await expect(f.owner.cancelWithGrant(other.token, runId, { requestId: randomUUID() }, hook)).rejects.toHaveProperty('code', 'not-found')
      expect(get).not.toHaveBeenCalled(); get.mockRestore()
    }
    await expect(f.owner.cancelWithGrant(f.prepared.token, id, { requestId: randomUUID() }, hook)).rejects.toHaveProperty('code', 'not-found')
    await expect(f.owner.cancelWithGrant(prepareGrantToken(own.id).token, id, { requestId: randomUUID() }, hook)).rejects.toHaveProperty('code', 'not-found')
    expect(hook).not.toHaveBeenCalled()
  })
  it.each(['actor', 'delegation', 'scope', 'at', 'release', 'authority', 'traceParent', 'cause', 'unknown'])('refuses caller-supplied %s or missing request identity before any write', async key => {
    const f = await fixture(), caller = await f.issue(['start', 'cancel']), id = randomUUID()
    await f.owner.startWithGrant(caller.token, 'input', { id, paused: true }); const events = await f.owner.events(id)
    await expect(f.owner.cancelWithGrant(caller.token, id, { requestId: randomUUID(), [key]: 'forged' })).rejects.toHaveProperty('code', 'invalid-command')
    await expect(f.owner.cancelWithGrant(caller.token, id, {} as never)).rejects.toHaveProperty('code', 'invalid-command')
    await expect(f.owner.cancelWithGrant(caller.token, id, { requestId: randomUUID() }, {} as never)).rejects.toHaveProperty('code', 'invalid-command')
    expect(await f.owner.events(id)).toEqual(events)
  })
  it('captures the original strict request and isolates the pin from trusted context mutation', async () => {
    const f = await fixture(), caller = await f.issue(['start', 'cancel']), id = randomUUID(), request = { requestId: randomUUID() }, expected = request.requestId
    await f.owner.startWithGrant(caller.token, 'input', { id, paused: true })
    const receipt = await f.owner.cancelWithGrant(caller.token, id, request, async (pin, execute) => {
      pin.id = randomUUID(); request.requestId = randomUUID(); await Promise.resolve(); return execute()
    })
    expect(receipt.requestId).toBe(expected); expect(receipt.release.id).toBe(f.scope.release.id)
  })
  it('refuses a backward admission clock instead of committing historically invalid attribution', async () => {
    const f = await fixture(), caller = await f.issue(['start', 'cancel']), id = randomUUID()
    vi.setSystemTime('2026-10-02T00:01:00.000Z'); await f.owner.startWithGrant(caller.token, 'input', { id, paused: true })
    const events = await f.owner.events(id); vi.setSystemTime(at)
    await expect(f.owner.cancelWithGrant(caller.token, id, { requestId: randomUUID() })).rejects.toHaveProperty('code', 'conflict')
    expect(await f.owner.events(id)).toEqual(events)
  })
  it.each(['new-revoked', 'new-expired', 'retry-revoked', 'retry-expired'])('reauthenticates %s after awaited context without a run write', async kind => {
    const f = await fixture(), caller = await f.issue(['start', 'cancel']), id = randomUUID(), request = { requestId: randomUUID() }
    await f.owner.startWithGrant(caller.token, 'input', { id, paused: true })
    if (kind.startsWith('retry')) await f.owner.cancelWithGrant(caller.token, id, request)
    const events = await f.owner.events(id)
    await expect(f.owner.cancelWithGrant(caller.token, id, request, async (_pin, execute) => {
      if (kind.endsWith('revoked')) await f.owner.revokeGrant({ id: caller.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' })
      else vi.setSystemTime(expiresAt)
      await Promise.resolve(); return execute()
    })).rejects.toHaveProperty('code', 'not-found')
    expect(await f.owner.events(id)).toEqual(events)
  })
  it('refuses expiry at the final transaction guard and does not abort a worker', async () => {
    const f = await fixture(), caller = await f.issue(['start', 'cancel']), id = randomUUID()
    await f.owner.startWithGrant(caller.token, 'input', { id, paused: true }); const events = await f.owner.events(id)
    const original = SQLiteGrantStore.prototype.authorizeInTransaction, abort = vi.spyOn(AbortController.prototype, 'abort')
    vi.spyOn(SQLiteGrantStore.prototype, 'authorizeInTransaction').mockImplementation(function (this: SQLiteGrantStore, ...args) {
      const result = original.apply(this, args); vi.setSystemTime(expiresAt); return result
    })
    await expect(f.owner.cancelWithGrant(caller.token, id, { requestId: randomUUID() })).rejects.toHaveProperty('code', 'not-found')
    expect(abort).not.toHaveBeenCalled(); expect(await f.owner.events(id)).toEqual(events)
  })
  it.each(['cancellation-requested', 'run-cancelled'])('preserves atomic admission and receipt-only recovery when %s insertion fails', async kind => {
    const f = await fixture(), caller = await f.issue(['start', 'cancel']), id = randomUUID(), request = { requestId: randomUUID() }
    await f.owner.startWithGrant(caller.token, 'input', { id, paused: true }); const before = await f.owner.events(id)
    const db = new DatabaseSync(join(f.state, 'runtime.sqlite'))
    try {
      db.exec(`CREATE TRIGGER cancellation_failure BEFORE INSERT ON events WHEN NEW.kind='${kind}' BEGIN SELECT RAISE(ABORT,'fixture cancellation failure'); END`)
      await expect(f.owner.cancelWithGrant(caller.token, id, request)).rejects.toThrow('fixture cancellation failure')
      const events = await f.owner.events(id)
      if (kind === 'cancellation-requested') { expect(events).toEqual(before); expect(await f.owner.show(id)).not.toHaveProperty('cancellation') }
      else {
        expect(events).toHaveLength(before.length + 1)
        expect((await f.owner.cancelWithGrant(caller.token, id, request)).status).toBe('paused')
        expect(await f.owner.events(id)).toEqual(events)
      }
    } finally { db.exec('DROP TRIGGER cancellation_failure'); db.close() }
  })
  it('observes a pending admitted cancellation after an actual lost COMMIT acknowledgment and reopen, without settling it', async () => {
    const f = await fixture(), caller = await f.issue(['start', 'cancel']), id = randomUUID(), request = { requestId: randomUUID() }
    await f.owner.startWithGrant(caller.token, 'input', { id, paused: true })
    const original = DatabaseSync.prototype.exec; let armed = true
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      original.call(this, sql); if (armed && sql === 'COMMIT') { armed = false; throw Error('fixture lost cancellation acknowledgment') }
    })
    await expect(f.owner.cancelWithGrant(caller.token, id, request)).rejects.toThrow('fixture lost cancellation acknowledgment')
    const events = await f.owner.events(id), abort = vi.spyOn(AbortController.prototype, 'abort')
    expect((await f.owner.cancelWithGrant(caller.token, id, request)).status).toBe('paused')
    expect(await f.owner.events(id)).toEqual(events); expect(abort).not.toHaveBeenCalled()
    await f.owner.close(); const reopened = await LocalRuntime.open({ dataDirectory: f.state }); owners.push(reopened)
    expect((await reopened.cancelWithGrant(caller.token, id, request)).status).toBe('paused')
    expect(await reopened.events(id)).toEqual(events)
    expect(reopened.cancel(id, request.requestId, 'owner:test').state.status).toBe('cancelled')
  })
  it('refuses terminal runs, a changed cancellation identity, and adoption of an owner cancellation', async () => {
    const f = await fixture(), caller = await f.issue(['start', 'cancel'])
    const complete = randomUUID(); await f.owner.startWithGrant(caller.token, 'input', { id: complete })
    await expect(f.owner.cancelWithGrant(caller.token, complete, { requestId: randomUUID() })).rejects.toHaveProperty('code', 'conflict')
    const id = randomUUID(), request = { requestId: randomUUID() }; await f.owner.startWithGrant(caller.token, 'input', { id, paused: true })
    f.owner.cancel(id, request.requestId, `grant:${caller.id}`)
    await expect(f.owner.cancelWithGrant(caller.token, id, request)).rejects.toHaveProperty('code', 'conflict')
    const other = randomUUID(); await f.owner.startWithGrant(caller.token, 'input', { id: other, paused: true })
    await f.owner.cancelWithGrant(caller.token, other, request)
    await expect(f.owner.cancelWithGrant(caller.token, other, { requestId: randomUUID() })).rejects.toHaveProperty('code', 'conflict')
  })
  it('admits an active worker abort once, returns an unsettled receipt, and lets that worker settle after revocation', async () => {
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(); let signal: AbortSignal | undefined
    const models: ModelCalls = { admit: vi.fn(), verify: vi.fn(), execute: vi.fn(async (_plan, _input, _id, abortSignal) => {
      signal = abortSignal; entered.resolve(); await gate.promise; throw Error('fixture stopped model')
    }) }
    const f = await fixture(decision, models), caller = await f.issue(['start', 'cancel']), id = randomUUID(), request = { requestId: randomUUID() }
    const pending = f.owner.startWithGrant(caller.token, 'PRIVATE_INPUT', { id })
    try {
      await entered.promise
      const abort = vi.spyOn(AbortController.prototype, 'abort')
      const first = await f.owner.cancelWithGrant(caller.token, id, request), events = await f.owner.events(id)
      expect(first.status).toBe('executing'); expect(signal?.aborted).toBe(true); expect(abort).toHaveBeenCalledOnce()
      expect(await f.owner.cancelWithGrant(caller.token, id, request)).toEqual(first)
      expect(await f.owner.events(id)).toEqual(events); expect(abort).toHaveBeenCalledOnce()
      await f.owner.revokeGrant({ id: caller.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' })
    } finally { gate.resolve(); expect((await pending).status).toBe('cancelled') }
    expect(models.execute).toHaveBeenCalledOnce()
    expect((await f.owner.show(id)).state.status).toBe('cancelled')
    await expect(f.owner.cancelWithGrant(caller.token, id, request)).rejects.toHaveProperty('code', 'not-found')
  })
  it.each(['actor', 'grant', 'permission', 'release', 'deadline', 'before-creation', 'event-kind', 'event-missing'] as const)('refuses retained cancellation %s corruption without repair or effects', async kind => {
    const f = await fixture(), caller = await f.issue(['start', 'cancel']), id = randomUUID(), request = { requestId: randomUUID() }
    await f.owner.startWithGrant(caller.token, 'input', { id, paused: true })
    vi.setSystemTime('2026-10-02T00:01:00.000Z'); await f.owner.cancelWithGrant(caller.token, id, request); await f.owner.close()
    const db = new DatabaseSync(join(f.state, 'runtime.sqlite'))
    try {
      const record = JSON.parse(db.prepare('SELECT record FROM runs WHERE id=?').get(id)!.record as string), saved = record.cancellation
      if (kind === 'actor') saved.actor = 'owner:forged'
      if (kind === 'grant') { saved.delegation.grantId = randomUUID(); saved.actor = `grant:${saved.delegation.grantId}` }
      if (kind === 'permission') saved.delegation.scope.permissions = ['start']
      if (kind === 'release') saved.delegation.scope.release.sha256 = 'b'.repeat(64)
      if (kind === 'deadline') saved.delegation.deadline = '2026-10-04T00:00:00.000Z'
      if (kind === 'before-creation') saved.at = '2026-10-01T00:00:00.000Z'
      db.prepare('UPDATE runs SET record=? WHERE id=?').run(JSON.stringify(record), id)
      db.prepare("UPDATE events SET data=? WHERE run_id=? AND kind='cancellation-requested'").run(JSON.stringify(saved), id)
      if (kind === 'event-kind') db.prepare("UPDATE events SET kind='execution-segment' WHERE run_id=? AND kind='cancellation-requested'").run(id)
      if (kind === 'event-missing') db.prepare("DELETE FROM events WHERE run_id=? AND kind='cancellation-requested'").run(id)
    } finally { db.close() }
    await expect(LocalRuntime.open({ dataDirectory: f.state })).rejects.toHaveProperty('code', 'corrupt')
  })
})

describe('standalone caller SDK starts and reads', () => {

  it('invokes trusted caller contexts only after scoped authentication and gives an isolated release pin', async () => {
    const f = await fixture(), id = randomUUID(), invoked = vi.fn()
    await expect(f.owner.startWithGrant(prepareGrantToken(f.prepared.id).token, 'input', { id }, invoked)).rejects.toHaveProperty('code', 'not-found')
    await expect(f.owner.readWithGrant(f.prepared.token, randomUUID(), invoked)).rejects.toHaveProperty('code', 'not-found')
    expect(invoked).not.toHaveBeenCalled()
    const options = { id, paused: true }
    const first = await f.owner.startWithGrant(f.prepared.token, 'input', options, async (pin, execute) => {
      expect(pin).toEqual(f.scope.release)
      pin.id = randomUUID(); options.id = randomUUID(); options.paused = false
      return execute()
    })
    expect(first).toMatchObject({ id, status: 'paused', release: { id: f.scope.release.id } })
    const read = await f.owner.readWithGrant(f.prepared.token, id, async (pin, execute) => {
      pin.sha256 = 'b'.repeat(64); return execute()
    })
    expect(read).toEqual(first)
  })
  it.each(['new', 'retry', 'read'] as const)('reauthenticates %s after an awaited trusted caller hook without run mutation', async kind => {
    const f = await fixture(), existing = { id: randomUUID(), paused: true }
    await f.owner.startWithGrant(f.prepared.token, 'input', existing)
    const before = await f.owner.events(existing.id)
    const selected = kind === 'new' ? { id: randomUUID(), paused: true } : existing
    const hook = async (_pin: unknown, execute: () => Promise<any>) => {
      await f.owner.revokeGrant({ id: f.prepared.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' })
      await Promise.resolve(); return execute()
    }
    const result = kind === 'read' ? f.owner.readWithGrant(f.prepared.token, existing.id, hook)
      : f.owner.startWithGrant(f.prepared.token, 'input', selected, hook)
    await expect(result).rejects.toHaveProperty('code', 'not-found')
    expect(await f.owner.events(existing.id)).toEqual(before)
    if (kind === 'new') await expect(f.owner.show(selected.id)).rejects.toHaveProperty('code', 'not-found')
  })
  it('refuses non-function caller context before starting or inspecting a run', async () => {
    const f = await fixture()
    await expect(f.owner.startWithGrant(f.prepared.token, 'input', { id: randomUUID() }, {} as never)).rejects.toHaveProperty('code', 'invalid-command')
    await expect(f.owner.readWithGrant(f.prepared.token, randomUUID(), {} as never)).rejects.toHaveProperty('code', 'invalid-command')
  })
  it('executes the retained release and derives private immutable ownership; start receipt excludes even authorized output', async () => {
    const f = await fixture(), o = options(), receipt = await f.owner.startWithGrant(f.prepared.token, 'PRIVATE_INPUT', o)
    expect(receipt).toEqual({ schemaVersion: 1, id: o.id, revision: f.scope.release.revision,
      release: { id: f.scope.release.id, sha256: f.scope.release.sha256 }, createdAt: at, updatedAt: at, status: 'completed' })
    const run = await f.owner.show(o.id)
    expect(run.caller).toEqual({ grantId: f.prepared.id, actor: `grant:${f.prepared.id}`, at, scope: f.scope })
    const events = await f.owner.events(o.id)
    expect(events[0]?.data).toMatchObject({ caller: run.caller })
    expect(await f.owner.readWithGrant(f.prepared.token, o.id)).toEqual({ ...receipt, output: 'PRIVATE_INPUT' })
    for (const value of [receipt, await f.owner.readWithGrant(f.prepared.token, o.id)]) {
      for (const key of ['yaml', 'input', 'state', 'steps', 'caller', 'actor', 'scope', 'grantId', 'token']) expect(value).not.toHaveProperty(key)
    }
    const db = new DatabaseSync(join(f.state, 'runtime.sqlite'), { readOnly: true })
    try { for (const table of ['runs', 'events']) {
      const text = JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())
      expect(text).not.toContain(f.prepared.token); expect(text).not.toContain(f.prepared.tokenSha256)
    } } finally { db.close() }
    const publicEvidence = await f.owner.exportRun(o.id)
    expect(JSON.stringify(publicEvidence)).not.toContain(f.prepared.id)
    expect(JSON.stringify(publicEvidence)).not.toContain('PRIVATE_INPUT')
  })
  it('same-ID retry observes retained state without resuming, redispatch or new evidence; changed options conflict', async () => {
    const f = await fixture(), o = { ...options(), paused: true }
    const first = await f.owner.startWithGrant(f.prepared.token, 'input', o), events = await f.owner.events(o.id)
    expect(await f.owner.startWithGrant(f.prepared.token, 'input', o)).toEqual(first)
    expect(await f.owner.events(o.id)).toEqual(events)
    for (const [input, selected] of [['changed', o], ['input', { ...o, paused: false }]] as const)
      await expect(f.owner.startWithGrant(f.prepared.token, input, selected)).rejects.toHaveProperty('code', 'conflict')
    const run = await f.owner.show(o.id)
    await f.owner.advance(o.id, { requestId: randomUUID(), expectedCheckpointSha256: executionCheckpointHash(run), mode: 'continue' }, 'owner:test')
    const completed = await f.owner.startWithGrant(f.prepared.token, 'input', o)
    expect(completed.status).toBe('completed'); expect(completed).not.toHaveProperty('output')
  })
  it('start-only grants receive metadata, never read permission; read-only grants cannot create runs', async () => {
    const f = await fixture(), start = await f.issue(['start']), read = await f.issue(['read'])
    const o = options(); expect(await f.owner.startWithGrant(start.token, 'private', o)).not.toHaveProperty('output')
    await expect(f.owner.readWithGrant(start.token, o.id)).rejects.toHaveProperty('code', 'not-found')
    await expect(f.owner.startWithGrant(read.token, 'private', options())).rejects.toHaveProperty('code', 'not-found')
    await expect(f.owner.readWithGrant(read.token, o.id)).rejects.toHaveProperty('code', 'not-found')
    expect(f.owner.list()).toHaveLength(1)
  })
  it('isolates runs from other grants for the same release, owner runs, and independent installations', async () => {
    const f = await fixture(), other = await f.issue(), o = options()
    await f.owner.startWithGrant(f.prepared.token, 'private', o)
    const ownerRun = await f.owner.runRelease(f.release.snapshot, 'owner input')
    for (const id of [o.id, ownerRun.id]) {
      await expect(f.owner.readWithGrant(other.token, id)).rejects.toHaveProperty('code', 'not-found')
      await expect(f.owner.startWithGrant(other.token, 'private', { id })).rejects.toHaveProperty('code', 'not-found')
    }
    await expect(f.owner.readWithGrant(other.token, randomUUID())).rejects.toHaveProperty('code', 'not-found')
    await expect(f.owner.runRelease(f.release.snapshot, 'private', o)).rejects.toHaveProperty('code', 'conflict')
    const isolated = await fixture()
    await expect(isolated.owner.startWithGrant(f.prepared.token, 'private', options())).rejects.toHaveProperty('code', 'not-found')
  })
  it.each(['actor', 'caller', 'project', 'test', 'release', 'yaml', 'authorization', 'unknown'])('rejects client-supplied %s and missing retry identity before mutation', async key => {
    const f = await fixture()
    await expect(f.owner.startWithGrant(f.prepared.token, 'input', { ...options(), [key]: 'forged' })).rejects.toHaveProperty('code', 'invalid-command')
    await expect(f.owner.startWithGrant(f.prepared.token, 'input', {} as never)).rejects.toHaveProperty('code', 'invalid-command')
    expect(f.owner.list()).toEqual([])
  })
  it.each(['malformed', 'wrong-secret', 'owner-token', 'revoked', 'expired'] as const)('refuses %s authorization for new starts, retries and reads without mutation', async kind => {
    const f = await fixture(), o = { ...options(), paused: true }
    await f.owner.startWithGrant(f.prepared.token, 'input', o); const events = await f.owner.events(o.id)
    let token = f.prepared.token
    if (kind === 'malformed') token = 'jvg1.invalid'
    if (kind === 'wrong-secret') token = prepareGrantToken(f.prepared.id).token
    if (kind === 'owner-token') token = 'b'.repeat(64)
    if (kind === 'revoked') await f.owner.revokeGrant({ id: f.prepared.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' })
    if (kind === 'expired') vi.setSystemTime(expiresAt)
    for (const selected of [o, options()]) await expect(f.owner.startWithGrant(token, 'input', selected)).rejects.toHaveProperty('code', 'not-found')
    await expect(f.owner.readWithGrant(token, o.id)).rejects.toHaveProperty('code', 'not-found')
    expect(await f.owner.events(o.id)).toEqual(events); expect(f.owner.list()).toHaveLength(1)
  })
  it('reviewer tokens cannot start or inspect workflows', async () => {
    const f = await fixture(), run = await f.owner.run(approval, { message: 'private' })
    if (run.state.status !== 'waiting') throw Error('expected wait')
    const reviewer = prepareGrantToken(randomUUID())
    await f.owner.issueGrant({ id: reviewer.id, tokenSha256: reviewer.tokenSha256, expiresAt, actor: 'owner:test',
      scope: { kind: 'reviewer', runId: run.id, attemptId: run.state.attempt.id, revision: run.revision, decisions: ['approve'] } })
    await expect(f.owner.startWithGrant(reviewer.token, 'private', options())).rejects.toHaveProperty('code', 'not-found')
    await expect(f.owner.readWithGrant(reviewer.token, run.id)).rejects.toHaveProperty('code', 'not-found')
  })
  it.each(['revoked', 'expired'] as const)('rechecks %s after delayed model admission, before the atomic creation checkpoint', async kind => {
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
    const models: ModelCalls = { admit: vi.fn(async () => { entered.resolve(); await gate.promise }), execute: vi.fn(), verify: vi.fn() }
    const f = await fixture(decision, models), o = { ...options(), paused: true }, pending = f.owner.startWithGrant(f.prepared.token, 'input', o)
    const rejected = expect(pending).rejects.toHaveProperty('code', 'not-found')
    try {
      await entered.promise
      if (kind === 'revoked') await f.owner.revokeGrant({ id: f.prepared.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' })
      else vi.setSystemTime(expiresAt)
    } finally { gate.resolve() }
    await rejected; expect(f.owner.list()).toEqual([]); expect(models.execute).not.toHaveBeenCalled()
  })
  it('rolls back run snapshot and creation attribution when event insertion fails', async () => {
    const f = await fixture(), db = new DatabaseSync(join(f.state, 'runtime.sqlite')), o = options()
    try {
      db.exec("CREATE TRIGGER caller_event_failure BEFORE INSERT ON events WHEN NEW.kind='run-created' BEGIN SELECT RAISE(ABORT,'fixture write failure'); END")
      await expect(f.owner.startWithGrant(f.prepared.token, 'input', o)).rejects.toThrow('fixture write failure')
      expect(db.prepare('SELECT count(*) AS n FROM runs').get()!.n).toBe(0)
      expect(db.prepare('SELECT count(*) AS n FROM events').get()!.n).toBe(0)
    } finally { db.exec('DROP TRIGGER caller_event_failure'); db.close() }
    expect((await f.owner.startWithGrant(f.prepared.token, 'input', o)).status).toBe('completed')
  })
  it('recovers an actually committed creation after its acknowledgment is lost; exact retry never adds an event', async () => {
    const f = await fixture(), o = { ...options(), paused: true }, original = DatabaseSync.prototype.exec
    let armed = true
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      original.call(this, sql)
      if (armed && sql === 'COMMIT') { armed = false; throw new Error('fixture lost commit acknowledgment') }
    })
    await expect(f.owner.startWithGrant(f.prepared.token, 'input', o)).rejects.toThrow('fixture lost commit acknowledgment')
    const run = await f.owner.show(o.id), events = await f.owner.events(o.id)
    expect(events).toHaveLength(1); expect(events[0]?.data).toMatchObject({ caller: run.caller })
    await f.owner.close()
    const reopened = await LocalRuntime.open({ dataDirectory: f.state }); owners.push(reopened)
    expect((await reopened.startWithGrant(f.prepared.token, 'input', o)).status).toBe('paused')
    expect(await reopened.events(o.id)).toEqual(events)
  })
  it('keeps reserved in-flight run identities scoped while provider admission is pending', async () => {
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
    const models: ModelCalls = { admit: vi.fn(async () => { entered.resolve(); await gate.promise }), execute: vi.fn(), verify: vi.fn() }
    const f = await fixture(decision, models), other = await f.issue(), o = { ...options(), paused: true }
    const pending = f.owner.startWithGrant(f.prepared.token, 'input', o)
    try {
      await entered.promise
      await expect(f.owner.startWithGrant(f.prepared.token, 'input', o)).rejects.toHaveProperty('code', 'busy')
      await expect(f.owner.startWithGrant(other.token, 'input', o)).rejects.toHaveProperty('code', 'not-found')
      await expect(f.owner.readWithGrant(other.token, o.id)).rejects.toHaveProperty('code', 'not-found')
      expect(models.admit).toHaveBeenCalledOnce()
    } finally { gate.resolve(); await pending }
    expect(f.owner.list()).toHaveLength(1)
  })
  it.each(['revoked', 'expired'] as const)('rechecks %s after asynchronous retained model verification before exposing completed output', async kind => {
    let held = false
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
    const reply = { model: 'fixture-native', answers: {
      team: { type: 'choice', choice: 'billing', probabilities: { billing: 0.75, support: 0.25 }, confidence: 0.6 },
      urgency: { type: 'score', score: 1.6, legend: { '0': 'Routine', '1': 'Soon', '2': 'Immediate' }, probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 }, confidence: 0.8 },
      review: { type: 'noul', noul: 0.1 } }, usage: { input_tokens: 12, output_tokens: 0 } }
    const models: ModelCalls = { admit: vi.fn(), execute: vi.fn(async () => ({ output: JSON.stringify(reply), usage: { tries: 1 } })),
      verify: vi.fn(async () => { if (held) { entered.resolve(); await gate.promise } }) }
    const f = await fixture(decision, models), o = options()
    expect((await f.owner.startWithGrant(f.prepared.token, 'PRIVATE_INPUT', o)).status).toBe('completed')
    held = true
    const pending = f.owner.readWithGrant(f.prepared.token, o.id), rejection = expect(pending).rejects.toHaveProperty('code', 'not-found')
    try {
      await entered.promise
      if (kind === 'revoked') await f.owner.revokeGrant({ id: f.prepared.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' })
      else vi.setSystemTime(expiresAt)
    } finally { gate.resolve() }
    await rejection; expect(models.execute).toHaveBeenCalledOnce()
  })
  it.each(['actor', 'scope', 'time', 'event', 'missing-grant'] as const)('refuses persisted %s corruption on reopen without repairing or executing', async kind => {
    const f = await fixture(), o = { ...options(), paused: true }
    await f.owner.startWithGrant(f.prepared.token, 'input', o); await f.owner.close()
    const db = new DatabaseSync(join(f.state, 'runtime.sqlite'))
    let before: unknown
    try {
      const record = JSON.parse(db.prepare('SELECT record FROM runs WHERE id=?').get(o.id)!.record as string)
      const event = JSON.parse(db.prepare("SELECT data FROM events WHERE run_id=? AND kind='run-created'").get(o.id)!.data as string)
      if (kind === 'actor') record.caller.actor = 'owner:forged'
      if (kind === 'scope') record.caller.scope.permissions = ['start']
      if (kind === 'time') record.caller.at = '2026-10-02T00:00:01.000Z'
      if (kind !== 'event') event.caller = record.caller
      else delete event.caller
      db.prepare('UPDATE runs SET record=? WHERE id=?').run(JSON.stringify(record), o.id)
      db.prepare("UPDATE events SET data=? WHERE run_id=? AND kind='run-created'").run(JSON.stringify(event), o.id)
      if (kind === 'missing-grant') { db.prepare('DELETE FROM access_grant_events WHERE grant_id=?').run(f.prepared.id); db.prepare('DELETE FROM access_grants WHERE id=?').run(f.prepared.id) }
      before = db.prepare('SELECT record FROM runs WHERE id=?').get(o.id)
    } finally { db.close() }
    await expect(LocalRuntime.open({ dataDirectory: f.state })).rejects.toHaveProperty('code', 'corrupt')
    const inspect = new DatabaseSync(join(f.state, 'runtime.sqlite'), { readOnly: true })
    try { expect(inspect.prepare('SELECT record FROM runs WHERE id=?').get(o.id)).toEqual(before) } finally { inspect.close() }
  })
  it('selects scoped identity before loading foreign private payloads', async () => {
    const f = await fixture(), foreign = await f.owner.run(echo, 'owner private'), get = vi.spyOn(RunStore.prototype, 'get')
    get.mockClear()
    await expect(f.owner.readWithGrant(f.prepared.token, foreign.id)).rejects.toHaveProperty('code', 'not-found')
    await expect(f.owner.startWithGrant(f.prepared.token, 'input', { id: foreign.id })).rejects.toHaveProperty('code', 'not-found')
    expect(get).not.toHaveBeenCalled()
  })
  it('preserves historical ownership through revoked/expired reopen; does not restore authority or run again', async () => {
    const f = await fixture(), o = { ...options(), paused: true }
    await f.owner.startWithGrant(f.prepared.token, 'input', o); const run = await f.owner.show(o.id), events = await f.owner.events(o.id)
    await f.owner.revokeGrant({ id: f.prepared.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' })
    await f.owner.close(); vi.setSystemTime(expiresAt)
    const reopened = await LocalRuntime.open({ dataDirectory: f.state }); owners.push(reopened)
    expect(await reopened.show(o.id)).toEqual(run); expect(await reopened.events(o.id)).toEqual(events)
    await expect(reopened.startWithGrant(f.prepared.token, 'input', o)).rejects.toHaveProperty('code', 'not-found')
    await expect(reopened.readWithGrant(f.prepared.token, o.id)).rejects.toHaveProperty('code', 'not-found')
  })
  it('canonicalizes retained UUIDs and refuses closed operations before authentication', async () => {
    const f = await fixture(), o = options()
    const receipt = await f.owner.startWithGrant(f.prepared.token, 'input', { id: o.id.toUpperCase() })
    expect(receipt.id).toBe(o.id); expect((await f.owner.readWithGrant(f.prepared.token, o.id.toUpperCase())).id).toBe(o.id)
    await f.owner.close()
    await expect(f.owner.startWithGrant('', 'input', {} as never)).rejects.toHaveProperty('code', 'closed')
    await expect(f.owner.readWithGrant('', 'invalid')).rejects.toHaveProperty('code', 'closed')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { LocalRuntime } from '../src/runtime/local.ts'
import { RunStore } from '../src/runtime/store.ts'
import { RunLedger } from '../src/runtime/run-ledger.ts'
import { executionCheckpointHash, localRunSchema, type LocalRun } from '../src/runtime/run-types.ts'
import { savedExecutionControlSchema } from '../src/runtime/control.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { SQLiteGrantStore } from '../src/access/sqlite-grants.ts'
import { prepareGrantToken, grantMetadata, grantTokenProof, issueGrantRecord, type GrantScope } from '../src/access/grants.ts'
import { admitGrantAction } from '../src/access/actions.ts'
import { callerControlCheckpoint, callerControlCheckpointSchema, callerControlEvidenceSchema, callerControlReceiptSchema,
  callerControlRequestSchema, callerControlTarget, callerControlRetry, prepareCallerControl, assertCallerControlCheckpoint,
  verifyCallerControls, verifyCallerControlBatchIdentity } from '../src/access/caller-control.ts'
import { verifyCallerCancellationBatchIdentity } from '../src/access/caller-cancellation.ts'
import { compileLocalRun, initialCheckpoint } from '../src/runtime/run-evaluator.ts'
import { callerControlSdkChecks, callerControlModelSource as modelSource } from './caller-control-sdk-checks.ts'
import type { ModelCalls } from '../src/runtime/model-port.ts'

const source = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const at = '2026-10-02T00:00:00.000Z', admittedAt = '2026-10-02T00:01:00.000Z', expiresAt = '2026-10-03T00:00:00.000Z'
const owners: LocalRuntime[] = []
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); for (const owner of owners.splice(0)) await owner.close() })
function pure() {
  const graph = compileLocalRun(source, DEFAULT_COMPILER_LIMITS), prepared = prepareGrantToken(randomUUID())
  const scope: Extract<GrantScope, { kind: 'caller' }> = { kind: 'caller', release: { id: randomUUID(), sha256: 'a'.repeat(64),
    revision: graph.source.revision }, permissions: ['control', 'start'] }
  const grant = issueGrantRecord({ id: prepared.id, tokenSha256: prepared.tokenSha256, actor: 'owner:test', scope, expiresAt }, at)
  const record: LocalRun = { schemaVersion: 1, id: randomUUID(), revision: graph.source.revision, yaml: graph.source.yaml,
    input: 'PRIVATE_INPUT', createdAt: at, updatedAt: at, release: { id: scope.release.id, sha256: scope.release.sha256 },
    caller: { grantId: grant.id, actor: `grant:${grant.id}`, at, scope }, state: initialCheckpoint(graph), loopDeadlines: {} }
  const request = (mode: 'step' | 'continue' | 'pause' | 'recover' = 'step') => ({ requestId: randomUUID(), mode, expectedCheckpointSha256: executionCheckpointHash(record) })
  const admission = () => admitGrantAction(grant, grantTokenProof(prepared.token)!, { kind: 'control', runId: record.id }, callerControlTarget(record), admittedAt)
  return { graph, grant, record, request, admission }
}
async function sqlite(yaml = source, models?: ModelCalls, input: unknown = 'PRIVATE_INPUT') {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at)
  const directory = await mkdtemp(join(tmpdir(), 'jevable-caller-control-'))
  const owner = await LocalRuntime.open({ dataDirectory: join(directory, 'state'), ...(models ? { models } : {}) }); owners.push(owner)
  const project = owner.editProject({ operation: 'create', title: 'Control fixture', yaml, actor: 'owner:test' })
  const release = owner.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision,
    version: '1.0.0', actor: 'owner:test', runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
  const scope: Extract<GrantScope, { kind: 'caller' }> = { kind: 'caller', release: { id: release.snapshot.id, sha256: release.sha256,
    revision: project.acceptedRevision }, permissions: ['control', 'start'] }
  const prepared = prepareGrantToken(randomUUID())
  await owner.issueGrant({ id: prepared.id, tokenSha256: prepared.tokenSha256, actor: 'owner:test', scope, expiresAt })
  const id = randomUUID(); await owner.startWithGrant(prepared.token, input, { id, paused: true })
  const store = Reflect.get(owner, 'store') as RunStore // Test-only access to the private writer, not a public SDK control.
  const checked = (record: LocalRun) => new RunLedger(DEFAULT_COMPILER_LIMITS).check(record, { events: store.events(id), release,
    grant: store.grantStore().get(prepared.id) })
  vi.setSystemTime(admittedAt)
  const request = { requestId: randomUUID(), mode: 'step' as const, expectedCheckpointSha256: executionCheckpointHash(store.get(id)!) }
  async function issue(permissions = scope.permissions) {
    const caller = prepareGrantToken(randomUUID())
    await owner.issueGrant({ id: caller.id, tokenSha256: caller.tokenSha256, actor: 'owner:test', scope: { ...scope, permissions }, expiresAt })
    return caller
  }
  return { owner, store, checked, id, prepared, request, directory, issue }
}

callerControlSdkChecks('SQLite public caller control SDK', async yaml => {
  const f = await sqlite(yaml, undefined, yaml ? { message: 'UNUSED_FIXTURE_INPUT' } : 'PRIVATE_INPUT')
  return { owner: f.owner, issue: f.issue, events: (id: string) => f.owner.events(id) }
})

describe('SQLite caller SDK model/control boundaries (trusted model adapter, not provider qualification)', () => {
  it.each([true, false])('recovers only an already retained response (available=%s), never redispatches or executes downstream', async available => {
    const result = { output: 'PRIVATE_RETAINED_REPLY', usage: { tries: 1, inputTokens: 7, outputTokens: 3 } }
    const execute = vi.fn(async () => result), recover = vi.fn(async () => { if (!available) throw Error('no retained response'); return result })
    const f = await sqlite(modelSource, { admit() {}, execute, recover, async verify() {} }), save = f.store.save.bind(f.store)
    let armed = true
    vi.spyOn(f.store, 'save').mockImplementation((record, kind, data) => {
      if (armed && kind === 'node-result' && record.state.steps.some(step => step.nodeId === 'write')) { armed = false; throw Error('lost node settlement') }
      return save(record, kind, data)
    })
    const run = { ...f.request, mode: 'continue' as const }
    await expect(f.owner.advanceWithGrant(f.prepared.token, f.id, run)).rejects.toThrow('lost node settlement')
    expect(execute).toHaveBeenCalledTimes(1)
    const events = await f.owner.events(f.id), retry = await f.owner.advanceWithGrant(f.prepared.token, f.id, run)
    expect(retry.status).toBe('executing'); expect(await f.owner.events(f.id)).toEqual(events); expect(recover).not.toHaveBeenCalled()
    const request = { requestId: randomUUID(), mode: 'recover' as const, expectedCheckpointSha256: retry.checkpointSha256 }
    if (!available) {
      await expect(f.owner.advanceWithGrant(f.prepared.token, f.id, request)).rejects.toThrow('no retained response')
      expect(await f.owner.events(f.id)).toEqual(events)
    } else {
      const recovered = await f.owner.advanceWithGrant(f.prepared.token, f.id, request)
      expect(recovered.status).toBe('paused'); expect((await f.owner.show(f.id)).state).toMatchObject({ next: 'end', steps: [{ nodeId: 'start' }, { nodeId: 'write' }] })
      const after = await f.owner.events(f.id)
      expect(await f.owner.advanceWithGrant(f.prepared.token, f.id, request)).toEqual(recovered)
      expect(await f.owner.events(f.id)).toEqual(after); expect(recover).toHaveBeenCalledTimes(1)
      const done = await f.owner.advanceWithGrant(f.prepared.token, f.id, { requestId: randomUUID(), mode: 'continue', expectedCheckpointSha256: recovered.checkpointSha256 })
      expect(done.status).toBe('completed'); expect(done).not.toHaveProperty('output')
    }
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it.each(['revoked', 'expired'])('reauthenticates %s after awaited retained-response recovery before admission or settlement', async kind => {
    const result = { output: 'PRIVATE_REPLY', usage: { tries: 1 } }, execute = vi.fn(async () => result)
    const recover = vi.fn(async () => {
      if (kind === 'revoked') await f.owner.revokeGrant({ id: f.prepared.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' })
      else vi.setSystemTime(expiresAt)
      await Promise.resolve(); return result
    })
    const f = await sqlite(modelSource, { admit() {}, execute, recover, async verify() {} }), save = f.store.save.bind(f.store)
    let armed = true
    vi.spyOn(f.store, 'save').mockImplementation((record, event, data) => {
      if (armed && event === 'node-result' && record.state.steps.some(step => step.nodeId === 'write')) { armed = false; throw Error('lost settlement') }
      return save(record, event, data)
    })
    await expect(f.owner.advanceWithGrant(f.prepared.token, f.id, { ...f.request, mode: 'continue' })).rejects.toThrow('lost settlement')
    const events = await f.owner.events(f.id), checkpoint = await f.owner.controlCheckpointWithGrant(f.prepared.token, f.id)
    await expect(f.owner.advanceWithGrant(f.prepared.token, f.id, { requestId: randomUUID(), mode: 'recover',
      expectedCheckpointSha256: checkpoint.checkpointSha256 })).rejects.toHaveProperty('code', 'not-found')
    expect(await f.owner.events(f.id)).toEqual(events); expect((await f.owner.show(f.id)).state.status).toBe('executing')
    expect(execute).toHaveBeenCalledTimes(1); expect(recover).toHaveBeenCalledTimes(1)
  })
  it('admits pause during an active model, observes the original request while busy, and stops at the safe settlement', async () => {
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
    const execute = vi.fn(async () => { entered.resolve(); await gate.promise; return { output: 'PRIVATE_REPLY', usage: { tries: 1 } } })
    const f = await sqlite(modelSource, { admit() {}, execute, async verify() {} }), request = { ...f.request, mode: 'continue' as const }
    const pending = f.owner.advanceWithGrant(f.prepared.token, f.id, request)
    try {
      await entered.promise
      const busy = await f.owner.advanceWithGrant(f.prepared.token, f.id, request), events = await f.owner.events(f.id)
      expect(busy.status).toBe('executing'); expect(await f.owner.events(f.id)).toEqual(events)
      await expect(f.owner.advanceWithGrant(f.prepared.token, f.id, { requestId: randomUUID(), mode: 'recover', expectedCheckpointSha256: busy.checkpointSha256 })).rejects.toHaveProperty('code', 'busy')
      const pauseRequest = { requestId: randomUUID(), mode: 'pause' as const, expectedCheckpointSha256: busy.checkpointSha256 }
      const pause = await f.owner.advanceWithGrant(f.prepared.token, f.id, pauseRequest)
      expect(pause.status).toBe('executing')
      const pausedEvents = await f.owner.events(f.id)
      expect(await f.owner.advanceWithGrant(f.prepared.token, f.id, pauseRequest)).toEqual(pause)
      expect(await f.owner.events(f.id)).toEqual(pausedEvents)
    } finally { gate.resolve() }
    const result = await pending
    expect(result.status).toBe('paused'); expect((await f.owner.show(f.id)).state).toMatchObject({ next: 'end' })
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it.each(['revoked', 'expired'])('rechecks %s after awaited provider admission, before control intent or dispatch', async kind => {
    let armed = false
    const execute = vi.fn(), models: ModelCalls = { async admit() {
      if (!armed) return
      if (kind === 'revoked') await f.owner.revokeGrant({ id: f.prepared.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' })
      else vi.setSystemTime(expiresAt)
      await Promise.resolve()
    }, execute, async verify() {} }
    const f = await sqlite(modelSource, models), events = await f.owner.events(f.id); armed = true
    await expect(f.owner.advanceWithGrant(f.prepared.token, f.id, { ...f.request, mode: 'continue' })).rejects.toHaveProperty('code', 'not-found')
    expect(execute).not.toHaveBeenCalled(); expect(await f.owner.events(f.id)).toEqual(events)
  })
  it('keeps a committed lost control acknowledgment pending across reopen; same UUID observes instead of executing', async () => {
    const f = await sqlite(), original = DatabaseSync.prototype.exec; let armed = true
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      original.call(this, sql); if (armed && sql === 'COMMIT') { armed = false; throw Error('lost control admission acknowledgment') }
    })
    await expect(f.owner.advanceWithGrant(f.prepared.token, f.id, f.request)).rejects.toThrow('lost control admission acknowledgment')
    const events = await f.owner.events(f.id), result = await f.owner.advanceWithGrant(f.prepared.token, f.id, f.request)
    expect((await f.owner.show(f.id)).state.steps).toEqual([]); expect(await f.owner.events(f.id)).toEqual(events)
    await f.owner.close()
    const reopened = await LocalRuntime.open({ dataDirectory: join(f.directory, 'state') }); owners.push(reopened)
    expect(await reopened.advanceWithGrant(f.prepared.token, f.id, f.request)).toEqual(result)
    expect(await reopened.events(f.id)).toEqual(events); expect((await reopened.show(f.id)).state.steps).toEqual([])
  })
})

describe('caller control shared admission contract; not SDK execution qualification', () => {
  it.each(['step', 'continue', 'pause', 'recover'] as const)('retains writer-derived %s attribution and metadata-only retry without effects', mode => {
    const f = pure()
    if (mode === 'recover') f.record.state = { ...f.record.state as Extract<LocalRun['state'], { status: 'paused' }>, status: 'executing',
      attempt: { id: randomUUID() as never, nodeId: f.record.state.status === 'paused' ? f.record.state.next : 'start' as never, prepared: { status: 'ready', input: 'PRIVATE' } } }
    const request = f.request(mode), result = prepareCallerControl(f.record, request, f.admission())
    expect(result.control).toEqual({ ...request, actor: `grant:${f.grant.id}`, at: admittedAt,
      delegation: { grantId: f.grant.id, scope: f.grant.scope, deadline: expiresAt } })
    expect(localRunSchema.parse(result.record)).toEqual(result.record)
    expect(result.record.state).toEqual(f.record.state)
    const receipt = callerControlRetry(result.record, request)!
    expect(callerControlReceiptSchema.parse(receipt)).toEqual(receipt)
    expect(callerControlCheckpointSchema.parse(callerControlCheckpoint(result.record))).toMatchObject({ id: f.record.id })
    expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE|actor|grantId|delegation|yaml|steps|input|output|scope|deadline|breakpoints/)
    expect(receipt.checkpointSha256).not.toBe(request.expectedCheckpointSha256)
    expect(() => verifyCallerControls(result.record, [{ kind: 'execution-requested', data: result.control }], grantMetadata(f.grant, expiresAt))).not.toThrow()
    expect(() => verifyCallerControlBatchIdentity('execution-requested', result.control, request.requestId)).not.toThrow()
    expect(verifyCallerCancellationBatchIdentity('execution-requested', result.control, request.requestId)).toBeUndefined()
  })
  it.each(['actor', 'at', 'delegation', 'scope', 'grantId', 'release', 'authority', 'traceParent', 'unknown'])('rejects public %s injection', key => {
    const f = pure(), request = { ...f.request(), [key]: 'forged' }
    expect(callerControlRequestSchema.safeParse(request).success).toBe(false)
    expect(() => prepareCallerControl(f.record, request, f.admission())).toThrow(expect.objectContaining({ code: 'invalid-command' }))
  })
  it.each(['step', 'continue', 'pause', 'recover'] as const)('refuses %s at an approval wait or cancelled checkpoint', mode => {
    const f = pure(), position = f.record.state as Extract<LocalRun['state'], { status: 'paused' }>
    f.record.state = { ...position, status: 'waiting', attempt: { id: randomUUID() as never, nodeId: position.next, prepared: { status: 'ready', input: null } }, expiresAt }
    expect(() => assertCallerControlCheckpoint(f.record, f.request(mode))).toThrow(expect.objectContaining({ code: 'conflict' }))
    f.record.state = localRunSchema.shape.state.parse({ ...position, status: 'cancelled', previousStatus: 'paused' })
    expect(() => assertCallerControlCheckpoint(f.record, f.request(mode))).toThrow(expect.objectContaining({ code: 'conflict' }))
  })
  it.each(['pause', 'recover'] as const)('refuses %s breakpoint configuration', mode => {
    const f = pure()
    expect(() => assertCallerControlCheckpoint(f.record, { ...f.request(mode), breakpoints: [] })).toThrow(expect.objectContaining({ code: 'invalid-command' }))
  })
  it('refuses stale hashes, excess history and backward admission clocks', () => {
    const f = pure(), request = f.request()
    expect(() => prepareCallerControl(f.record, { ...request, expectedCheckpointSha256: 'b'.repeat(64) }, f.admission())).toThrow(expect.objectContaining({ code: 'conflict' }))
    f.record.updatedAt = '2026-10-02T00:02:00.000Z'
    expect(() => prepareCallerControl(f.record, request, f.admission())).toThrow(expect.objectContaining({ code: 'conflict' }))
    f.record.controlRequests = Array.from({ length: 10000 }, () => ({ ...f.request(), actor: 'owner:test', at }))
    expect(() => assertCallerControlCheckpoint(f.record, f.request())).toThrow(expect.objectContaining({ code: 'limit' }))
  })
  it.each(['mode', 'expectedCheckpointSha256', 'breakpoints'] as const)('refuses changed %s on retained retry, including explicit empty versus omitted breakpoints', key => {
    const f = pure(), request = f.request(), result = prepareCallerControl(f.record, request, f.admission())
    const changed = { ...request, [key]: key === 'mode' ? 'continue' : key === 'breakpoints' ? [] : 'b'.repeat(64) }
    expect(() => callerControlRetry(result.record, changed)).toThrow(expect.objectContaining({ code: 'conflict' }))
  })
  it('cannot adopt an owner request, retarget a foreign admission, or authenticate from private attribution', () => {
    const f = pure(), request = f.request()
    f.record.controlRequests = [{ ...request, actor: 'owner:test', at }]
    expect(() => callerControlRetry(f.record, request)).toThrow(expect.objectContaining({ code: 'conflict' }))
    delete f.record.controlRequests
    expect(() => prepareCallerControl(f.record, request, { ...f.admission(), grantId: randomUUID() })).toThrow(expect.objectContaining({ code: 'corrupt' }))
    const result = prepareCallerControl(f.record, request, f.admission())
    expect(() => verifyCallerControls(result.record, [{ kind: 'execution-requested', data: result.control }])).toThrow(expect.objectContaining({ code: 'corrupt' }))
    expect(() => verifyCallerControlBatchIdentity('execution-requested', result.control, randomUUID())).toThrow(expect.objectContaining({ code: 'corrupt' }))
  })
  it.each(['actor', 'grant', 'scope', 'deadline', 'missing-event', 'missing-snapshot', 'early', 'late', 'extra'])('rejects %s historical attribution corruption', kind => {
    const f = pure(), result = prepareCallerControl(f.record, f.request(), f.admission()), control = structuredClone(result.control)
    if (kind === 'actor') control.actor = 'owner:forged'
    if (kind === 'grant') { control.delegation.grantId = randomUUID(); control.actor = `grant:${control.delegation.grantId}` }
    if (kind === 'scope') control.delegation.scope.release.sha256 = 'b'.repeat(64)
    if (kind === 'deadline') control.delegation.deadline = '2026-10-04T00:00:00.000Z'
    if (kind === 'early') control.at = '2026-10-01T23:59:00.000Z'
    if (kind === 'late') control.at = expiresAt
    if (kind === 'extra') Reflect.set(control, 'authority', 'owner')
    const record = { ...result.record, controlRequests: kind === 'missing-snapshot' ? undefined : [control] } as LocalRun
    const events = kind === 'missing-event' ? [] : [{ kind: 'execution-requested', data: control }]
    expect(() => verifyCallerControls(record, events, grantMetadata(f.grant, admittedAt))).toThrow(expect.objectContaining({ code: 'corrupt' }))
  })
  it('retains legacy owner control shape and rejects a forged actor in delegated saved records', () => {
    const f = pure(), request = f.request(), legacy = { ...request, actor: 'owner:test', at }
    expect(savedExecutionControlSchema.parse(legacy)).toEqual(legacy)
    expect(() => verifyCallerControls({ ...f.record, controlRequests: [legacy] }, [{ kind: 'execution-requested', data: legacy }])).not.toThrow()
    const result = prepareCallerControl(f.record, request, f.admission())
    expect(callerControlEvidenceSchema.safeParse({ ...result.control, actor: 'owner:forged' }).success).toBe(false)
    expect(savedExecutionControlSchema.safeParse({ ...result.control, actor: 'owner:forged' }).success).toBe(false)
  })
})

describe('SQLite private caller control writer; admission only, never execution', () => {
  it('refuses recovery of a valid retained non-model intent instead of admitting unusable control history', async () => {
    const f = await sqlite(), record = f.store.get(f.id)!
    if (record.state.status !== 'paused') throw Error('fixture must be paused')
    const attempt = { id: randomUUID() as never, nodeId: record.state.next,
      prepared: { status: 'ready' as const, input: structuredClone(record.input) } }
    const pending: LocalRun = { ...record, updatedAt: admittedAt, state: { ...record.state, status: 'executing', attempt } }
    f.store.save(pending, 'node-intent', { attempt, scope: null, revision: record.revision })
    expect(await f.owner.show(f.id)).toEqual(pending)
    const events = f.store.events(f.id), request = { ...f.request, mode: 'recover' as const, expectedCheckpointSha256: executionCheckpointHash(pending) }
    expect(() => f.store.saveCallerControl(f.prepared.token, f.id, request, f.checked, DEFAULT_COMPILER_LIMITS)).toThrow(expect.objectContaining({ code: 'conflict' }))
    expect(f.store.events(f.id)).toEqual(events); expect(await f.owner.show(f.id)).toEqual(pending)
  })
  it.each(['step', 'continue', 'pause'] as const)('atomically writes %s intent and repeats only unchanged observation', async mode => {
    const f = await sqlite(), before = f.store.get(f.id)!, request = { ...f.request, mode }
    const result = f.store.saveCallerControl(f.prepared.token, f.id, request, f.checked, DEFAULT_COMPILER_LIMITS)
    expect(result.admitted).toBe(true); expect(result.record.state).toEqual(before.state)
    expect(f.store.events(f.id)).toHaveLength(2); expect(f.store.events(f.id)[1]?.data).toEqual(result.record.controlRequests?.[0])
    expect(await f.owner.show(f.id)).toEqual(result.record)
    const events = f.store.events(f.id)
    vi.setSystemTime('2026-10-02T00:02:00.000Z')
    expect(f.store.saveCallerControl(f.prepared.token, f.id, request, f.checked, DEFAULT_COMPILER_LIMITS)).toEqual({ record: result.record, admitted: false })
    expect(f.store.events(f.id)).toEqual(events)
    await f.owner.revokeGrant({ id: f.prepared.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' })
    expect(() => f.store.saveCallerControl(f.prepared.token, f.id, request, f.checked, DEFAULT_COMPILER_LIMITS)).toThrow(expect.objectContaining({ code: 'not-found' }))
    expect(await f.owner.show(f.id)).toEqual(result.record) // Revocation never erases already admitted provenance.
  })
  it('rejects foreign or missing runs before decoding their payload, and stale/forged commands before mutation', async () => {
    const f = await sqlite(), read = vi.spyOn(f.store, 'get')
    expect(() => f.store.saveCallerControl(f.prepared.token, randomUUID(), f.request, f.checked, DEFAULT_COMPILER_LIMITS)).toThrow(expect.objectContaining({ code: 'not-found' }))
    expect(read).not.toHaveBeenCalled(); read.mockRestore()
    const before = f.store.events(f.id)
    expect(() => f.store.saveCallerControl(f.prepared.token, f.id, { ...f.request, expectedCheckpointSha256: 'b'.repeat(64) }, f.checked, DEFAULT_COMPILER_LIMITS)).toThrow(expect.objectContaining({ code: 'conflict' }))
    expect(() => f.store.saveCallerControl(f.prepared.token, f.id, { ...f.request, actor: 'owner' } as never, f.checked, DEFAULT_COMPILER_LIMITS)).toThrow(expect.objectContaining({ code: 'invalid-command' }))
    expect(() => f.store.saveCallerControl(f.prepared.token, f.id, { ...f.request, breakpoints: ['missing'] }, f.checked, DEFAULT_COMPILER_LIMITS)).toThrow(expect.objectContaining({ code: 'invalid-command' }))
    expect(f.store.events(f.id)).toEqual(before)
    await expect(f.owner.advance(f.id, { ...f.request, delegation: {} } as never, 'owner:test')).rejects.toHaveProperty('code', 'invalid-command')
    expect(f.store.events(f.id)).toEqual(before)
  })
  it('checks deadline again immediately before the write', async () => {
    const f = await sqlite(), before = f.store.events(f.id), original = SQLiteGrantStore.prototype.authorizeInTransaction
    vi.spyOn(SQLiteGrantStore.prototype, 'authorizeInTransaction').mockImplementation(function (this: SQLiteGrantStore, ...args) {
      const result = original.apply(this, args); vi.setSystemTime(expiresAt); return result
    })
    expect(() => f.store.saveCallerControl(f.prepared.token, f.id, f.request, f.checked, DEFAULT_COMPILER_LIMITS)).toThrow(expect.objectContaining({ code: 'not-found' }))
    expect(f.store.events(f.id)).toEqual(before)
  })
  it('rolls back an event-write failure atomically; a committed lost acknowledgment only observes on retry', async () => {
    const f = await sqlite(), before = f.store.events(f.id), db = new DatabaseSync(join(f.directory, 'state/runtime.sqlite'))
    try {
      db.exec("CREATE TRIGGER control_failure BEFORE INSERT ON events WHEN NEW.kind='execution-requested' BEGIN SELECT RAISE(ABORT,'fixture control write failure'); END")
      expect(() => f.store.saveCallerControl(f.prepared.token, f.id, f.request, f.checked, DEFAULT_COMPILER_LIMITS)).toThrow('fixture control write failure')
      expect(f.store.events(f.id)).toEqual(before); expect(f.store.get(f.id)).not.toHaveProperty('controlRequests')
    } finally { db.exec('DROP TRIGGER control_failure'); db.close() }
    const original = DatabaseSync.prototype.exec; let armed = true
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      original.call(this, sql); if (armed && sql === 'COMMIT') { armed = false; throw Error('fixture lost control acknowledgment') }
    })
    expect(() => f.store.saveCallerControl(f.prepared.token, f.id, f.request, f.checked, DEFAULT_COMPILER_LIMITS)).toThrow('fixture lost control acknowledgment')
    const events = f.store.events(f.id), retained = f.store.get(f.id)!
    expect(f.store.saveCallerControl(f.prepared.token, f.id, f.request, f.checked, DEFAULT_COMPILER_LIMITS)).toEqual({ record: retained, admitted: false })
    expect(f.store.events(f.id)).toEqual(events); expect(retained.state.steps).toEqual([])
    expect(await f.owner.show(f.id)).toEqual(retained)
  })
})

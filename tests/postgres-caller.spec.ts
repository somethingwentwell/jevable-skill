import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PostgresRuntime } from '../src/runtime/postgres.ts'
import { PostgresRunStore } from '../src/runtime/postgres-store.ts'
import { PostgresGrantStore } from '../src/access/postgres-grants.ts'
import { PostgresJournal, JournalError, type JournalBatch } from '../src/storage/postgres.ts'
import { journalConditionHash, checkJournalConditionTime, type JournalConditions } from '../src/storage/conditions.ts'
import { ConfiguredModels } from '../src/providers/model-calls.ts'
import { prepareGrantToken, type GrantScope } from '../src/access/grants.ts'
import { inspectRelease } from '../src/releases/snapshot.ts'
import { compileLocalRun } from '../src/runtime/run-evaluator.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { parseNotificationConfig } from '../src/notifications/config.ts'
import { RuntimeTelemetry } from '../src/telemetry/traces.ts'
import { callerCancellationReceiptSchema } from '../src/access/caller-cancellation.ts'
import { callerControlTarget, prepareCallerControl, callerControlRetry } from '../src/access/caller-control.ts'
import { executionCheckpointHash } from '../src/runtime/run-types.ts'
import { callerControlSdkChecks, callerControlModelSource } from './caller-control-sdk-checks.ts'
import { createServer } from 'node:http'
import type { ModelCalls } from '../src/runtime/model-port.ts'
import { traceRecords } from '../scripts/check-postgres-telemetry.mjs'
import { logRecords } from '../scripts/check-telemetry-package.mjs'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const native = await readFile(new URL('../examples/native-decision.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const at = '2026-10-02T00:00:00.000Z', expiresAt = '2026-10-03T00:00:00.000Z'
const owners: PostgresRuntime[] = []
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); for (const owner of owners.splice(0)) await owner.close() })

/** Domain integration double, NOT actual SQL/locking/durability. Actual SQL qualification is separate. */
class JournalDouble {
  readonly signal = new AbortController().signal
  readonly rows = new Map<string, { collection: string; key: string; version: string; deleted: boolean; value: unknown }>()
  readonly history: any[] = []
  readonly receipts = new Map<string, any>()
  readonly reads: string[] = []
  readonly guards: (JournalConditions | undefined)[] = []
  hook: ((collection: string, key: string) => Promise<void>) | undefined
  failCommit = false
  key(collection: string, key: string) { return `${collection}/${key}` }
  put(collection: string, key: string, value: unknown, version = '1') {
    this.rows.set(this.key(collection, key), { collection, key, version, deleted: false, value: structuredClone(value) })
  }
  async get(collection: string, key: string) { this.reads.push(this.key(collection, key)); await this.hook?.(collection, key); return structuredClone(this.rows.get(this.key(collection, key))) }
  async exists(collection: string, key: string) { return this.rows.has(this.key(collection, key)) }
  async callerRun(pin: { id: string; grantId: string; release: { id: string; sha256: string; revision: string } }) {
    const row = this.rows.get(this.key('runs', pin.id)), value = row?.value as any, run = value?.record
    if (!row || row.deleted || value.format !== 'jevable.pg-run/v1' || run?.caller?.grantId !== pin.grantId
      || run?.release?.id !== pin.release.id || run.release.sha256 !== pin.release.sha256 || run.revision !== pin.release.revision) return undefined
    return structuredClone(row)
  }
  async count(collection: string) { return [...this.rows.values()].filter(row => row.collection === collection && !row.deleted).length }
  async events(after: string, limit: number, collections: string[], key?: string) {
    const events = this.history.filter(e => BigInt(e.sequence) > BigInt(after) && collections.includes(e.collection) && (key === undefined || e.key === key)).slice(0, limit)
    return { events: structuredClone(events), cursor: events.at(-1)?.sequence ?? after }
  }
  async receipt(id: string) { return structuredClone(this.receipts.get(id)) }
  async commit(batch: JournalBatch, guard?: JournalConditions) {
    this.guards.push(structuredClone(guard))
    if (guard) {
      checkJournalConditionTime(guard)
      for (const condition of guard.records) {
        const row = this.rows.get(this.key(condition.collection, condition.key))
        if (!row || row.deleted || row.version !== condition.version || journalConditionHash(row.value) !== condition.sha256) throw new JournalError('conflict')
      }
    }
    if (this.receipts.has(batch.id)) throw new JournalError('conflict')
    for (const change of batch.changes) if ((this.rows.get(this.key(change.collection, change.key))?.version ?? '0') !== change.expectedVersion) throw new JournalError('conflict')
    const changes = []
    for (const change of batch.changes) {
      if (change.operation !== 'put') throw Error('fixture only puts')
      const version = String(BigInt(change.expectedVersion) + 1n)
      this.put(change.collection, change.key, change.value, version); changes.push({ collection: change.collection, key: change.key, version, deleted: false })
    }
    const sequences = []
    for (const event of batch.events) { const sequence = String(this.history.length + 1); sequences.push(sequence)
      this.history.push({ ...structuredClone(event), sequence, batchId: batch.id, at, epoch: '1' }) }
    const receipt = { id: batch.id, requestSha256: journalConditionHash(batch), ownerId: randomUUID(), epoch: '1', recordedAt: at, changes, eventSequences: sequences }
    this.receipts.set(batch.id, receipt)
    if (this.failCommit) { this.failCommit = false; throw new JournalError('commit-uncertain') }
    return structuredClone(receipt)
  }
  async close() {}
}
async function fixture(source = echo) {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at)
  const journal = new JournalDouble(), graph = compileLocalRun(source, DEFAULT_COMPILER_LIMITS)
  const release = inspectRelease({ format: 'jevable.ai/release', schemaVersion: 1, id: randomUUID(), version: '1.0.0', createdAt: at,
    createdBy: 'owner:test', project: { id: randomUUID(), generation: 1 }, workflow: { yaml: graph.source.yaml, revision: graph.source.revision }, runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
  journal.put('releases', release.snapshot.id, { format: 'jevable.pg-release/v1', ...release })
  journal.put('release-versions', `${release.snapshot.project.id}/1.0.0`, { format: 'jevable.pg-release-version/v1', projectId: release.snapshot.project.id, version: '1.0.0', firstReleaseId: release.snapshot.id })
  // Private constructor use is confined to test; production exposes no injected journal/model bypass.
  const owner = Reflect.construct(PostgresRuntime, [journal, 10000, 10000, 4_000_000, parseNotificationConfig({})]) as PostgresRuntime; owners.push(owner)
  const scope: Extract<GrantScope, { kind: 'caller' }> = { kind: 'caller', release: { id: release.snapshot.id, sha256: release.sha256, revision: graph.source.revision }, permissions: ['read', 'start'] }
  async function issue(permissions = scope.permissions) { const p = prepareGrantToken(randomUUID()); await owner.issueGrant({ id: p.id, tokenSha256: p.tokenSha256, actor: 'owner:test', expiresAt, scope: { ...scope, permissions } }); return p }
  const prepared = await issue()
  return { journal, owner, prepared, release, scope, issue }
}

callerControlSdkChecks('PostgreSQL public caller control SDK (journal double, not actual SQL)', async source => {
  const f = await fixture(source)
  return { owner: f.owner, issue: f.issue, events: (id: string) => f.owner.events(id) }
})

describe('PostgreSQL caller SDK model/control boundaries (journal/model doubles, not actual SQL/providers)', () => {
  async function modelFixture() {
    vi.spyOn(ConfiguredModels.prototype, 'admit').mockResolvedValue({} as never)
    vi.spyOn(ConfiguredModels.prototype, 'verify').mockResolvedValue(undefined)
    const f = await fixture(callerControlModelSource), caller = await f.issue(['control', 'start']), id = randomUUID()
    await f.owner.startWithGrant(caller.token, 'PRIVATE_INPUT', { id, paused: true })
    const checkpoint = await f.owner.controlCheckpointWithGrant(caller.token, id)
    return { ...f, caller, id, request: { requestId: randomUUID(), mode: 'continue' as const, expectedCheckpointSha256: checkpoint.checkpointSha256 } }
  }
  it.each([true, false])('reads only a retained response (available=%s) and never redispatches or executes downstream', async available => {
    const result = { output: 'PRIVATE_RETAINED_REPLY', usage: { tries: 1, inputTokens: 7, outputTokens: 3 } }
    const execute = vi.spyOn(ConfiguredModels.prototype, 'execute').mockResolvedValue(result)
    const recover = vi.spyOn(ConfiguredModels.prototype, 'recover').mockImplementation(async () => { if (!available) throw Error('no retained response'); return result })
    const f = await modelFixture(), commit = f.journal.commit.bind(f.journal); let armed = true
    vi.spyOn(f.journal, 'commit').mockImplementation(async (batch, conditions) => {
      const event = batch.events[0], data = event?.data as any
      if (armed && event?.kind === 'node-result' && data?.data.nodeId === 'write') { armed = false; throw new JournalError('commit-uncertain') }
      return commit(batch, conditions)
    })
    await expect(f.owner.advanceWithGrant(f.caller.token, f.id, f.request)).rejects.toHaveProperty('code', 'commit-uncertain')
    const events = await f.owner.events(f.id), retry = await f.owner.advanceWithGrant(f.caller.token, f.id, f.request)
    expect(retry.status).toBe('executing'); expect(await f.owner.events(f.id)).toEqual(events); expect(recover).not.toHaveBeenCalled()
    const request = { requestId: randomUUID(), mode: 'recover' as const, expectedCheckpointSha256: retry.checkpointSha256 }
    if (!available) {
      await expect(f.owner.advanceWithGrant(f.caller.token, f.id, request)).rejects.toThrow('no retained response')
      expect(await f.owner.events(f.id)).toEqual(events)
    } else {
      const recovered = await f.owner.advanceWithGrant(f.caller.token, f.id, request)
      expect(recovered.status).toBe('paused'); expect((await f.owner.show(f.id)).state).toMatchObject({ next: 'end' })
      const after = await f.owner.events(f.id)
      expect(await f.owner.advanceWithGrant(f.caller.token, f.id, request)).toEqual(recovered)
      expect(await f.owner.events(f.id)).toEqual(after); expect(recover).toHaveBeenCalledTimes(1)
      const done = await f.owner.advanceWithGrant(f.caller.token, f.id, { requestId: randomUUID(), mode: 'continue', expectedCheckpointSha256: recovered.checkpointSha256 })
      expect(done.status).toBe('completed'); expect(done).not.toHaveProperty('output')
    }
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it.each(['revoked', 'expired'])('reauthenticates %s after awaited retained-response recovery before admission or settlement', async kind => {
    const result = { output: 'PRIVATE_REPLY', usage: { tries: 1 } }
    const execute = vi.spyOn(ConfiguredModels.prototype, 'execute').mockResolvedValue(result)
    const f = await modelFixture(), commit = f.journal.commit.bind(f.journal); let armed = true
    vi.spyOn(f.journal, 'commit').mockImplementation(async (batch, conditions) => {
      const event = batch.events[0], data = event?.data as any
      if (armed && event?.kind === 'node-result' && data?.data.nodeId === 'write') { armed = false; throw new JournalError('commit-uncertain') }
      return commit(batch, conditions)
    })
    await expect(f.owner.advanceWithGrant(f.caller.token, f.id, f.request)).rejects.toHaveProperty('code', 'commit-uncertain')
    const recover = vi.spyOn(ConfiguredModels.prototype, 'recover').mockImplementation(async () => {
      if (kind === 'revoked') await f.owner.revokeGrant({ id: f.caller.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' })
      else vi.setSystemTime(expiresAt)
      await Promise.resolve(); return result
    })
    const events = await f.owner.events(f.id), checkpoint = await f.owner.controlCheckpointWithGrant(f.caller.token, f.id)
    await expect(f.owner.advanceWithGrant(f.caller.token, f.id, { requestId: randomUUID(), mode: 'recover',
      expectedCheckpointSha256: checkpoint.checkpointSha256 })).rejects.toHaveProperty('code', 'not-found')
    expect(await f.owner.events(f.id)).toEqual(events); expect((await f.owner.show(f.id)).state.status).toBe('executing')
    expect(execute).toHaveBeenCalledTimes(1); expect(recover).toHaveBeenCalledTimes(1)
  })
  it('admits an in-flight pause and observes the active original UUID without reacquiring a worker', async () => {
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
    const execute = vi.spyOn(ConfiguredModels.prototype, 'execute').mockImplementation(async () => {
      entered.resolve(); await gate.promise; return { output: 'PRIVATE_REPLY', usage: { tries: 1 } }
    })
    const f = await modelFixture(), pending = f.owner.advanceWithGrant(f.caller.token, f.id, f.request)
    try {
      await entered.promise
      const busy = await f.owner.advanceWithGrant(f.caller.token, f.id, f.request)
      expect(busy.status).toBe('executing')
      await expect(f.owner.advanceWithGrant(f.caller.token, f.id, { requestId: randomUUID(), mode: 'recover', expectedCheckpointSha256: busy.checkpointSha256 })).rejects.toHaveProperty('code', 'busy')
      const request = { requestId: randomUUID(), mode: 'pause' as const, expectedCheckpointSha256: busy.checkpointSha256 }
      const pause = await f.owner.advanceWithGrant(f.caller.token, f.id, request), events = await f.owner.events(f.id)
      expect(pause.status).toBe('executing')
      expect(await f.owner.advanceWithGrant(f.caller.token, f.id, request)).toEqual(pause)
      expect(await f.owner.events(f.id)).toEqual(events)
    } finally { gate.resolve() }
    expect((await pending).status).toBe('paused'); expect((await f.owner.show(f.id)).state).toMatchObject({ next: 'end' })
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it.each(['revoked', 'expired'])('rechecks %s after awaited provider admission, before a control write or dispatch', async kind => {
    const f = await modelFixture(), events = await f.owner.events(f.id), execute = vi.spyOn(ConfiguredModels.prototype, 'execute')
    vi.spyOn(ConfiguredModels.prototype, 'admit').mockImplementation(async () => {
      if (kind === 'revoked') await f.owner.revokeGrant({ id: f.caller.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' })
      else vi.setSystemTime(expiresAt)
      await Promise.resolve(); return {} as never
    })
    await expect(f.owner.advanceWithGrant(f.caller.token, f.id, f.request)).rejects.toHaveProperty('code', 'not-found')
    expect(execute).not.toHaveBeenCalled(); expect(await f.owner.events(f.id)).toEqual(events)
  })
  it('leaves a double-simulated lost admission acknowledgment pending; original UUID never executes it on retry', async () => {
    const f = await fixture(), caller = await f.issue(['control', 'start']), id = randomUUID()
    await f.owner.startWithGrant(caller.token, 'input', { id, paused: true })
    const request = { requestId: randomUUID(), mode: 'step' as const, expectedCheckpointSha256: (await f.owner.controlCheckpointWithGrant(caller.token, id)).checkpointSha256 }
    f.journal.failCommit = true
    await expect(f.owner.advanceWithGrant(caller.token, id, request)).rejects.toHaveProperty('code', 'commit-uncertain')
    const events = await f.owner.events(id)
    expect((await f.owner.advanceWithGrant(caller.token, id, request)).status).toBe('paused')
    expect((await f.owner.show(id)).state.steps).toEqual([]); expect(await f.owner.events(id)).toEqual(events)
  })
})

describe('PostgreSQL private caller control writer (journal double, not SQL or SDK execution)', () => {
  async function controlFixture() {
    const f = await fixture(), caller = await f.issue(['control', 'start']), id = randomUUID()
    await f.owner.startWithGrant(caller.token, 'PRIVATE_INPUT', { id, paused: true })
    const record = await f.owner.show(id), request = { requestId: randomUUID(), mode: 'step' as const, expectedCheckpointSha256: executionCheckpointHash(record) }
    vi.setSystemTime('2026-10-02T00:01:00.000Z')
    const planned = await new PostgresGrantStore(f.journal as unknown as PostgresJournal).planAction(caller.token, { kind: 'control', runId: id }, async () => {
      const row = await f.journal.get('runs', id)
      return { target: callerControlTarget(record), condition: { collection: 'runs', key: id, version: row!.version, sha256: journalConditionHash(row!.value) } }
    })
    const prepared = prepareCallerControl(record, request, planned.admission), row = await f.journal.get('runs', id)
    const store = new PostgresRunStore(f.journal as unknown as PostgresJournal)
    const command = JSON.parse(JSON.stringify({ requestId: request.requestId, expectedVersion: row!.version,
      record: prepared.record, kind: 'execution-requested', data: prepared.control }))
    return { ...f, caller, id, record, request, prepared, conditions: planned.conditions, command, store }
  }
  it('commits exact attributed intent with grant/run/time pins and retains read-only retry without execution', async () => {
    const f = await controlFixture()
    await f.store.save(f.command, f.conditions)
    expect(f.journal.history.at(-1)).toMatchObject({ batchId: f.request.requestId, kind: 'execution-requested' })
    expect(await f.owner.show(f.id)).toEqual(f.prepared.record)
    const count = f.journal.history.length
    expect(callerControlRetry(await f.owner.show(f.id), f.request)).toMatchObject({ id: f.id, mode: 'step' })
    expect(f.journal.history).toHaveLength(count); expect(f.prepared.record.state.steps).toEqual([])
    await expect(f.store.save(f.command, f.conditions)).rejects.toHaveProperty('code', 'conflict')
  })
  it.each(['absent', 'not-before', 'deadline', 'grant', 'run', 'version'] as const)('refuses missing/substituted %s writer guard before any journal commit', async kind => {
    const f = await controlFixture(), conditions = structuredClone(f.conditions), count = f.journal.history.length
    if (kind === 'not-before') conditions.notBefore = at
    if (kind === 'deadline') conditions.expiresAt = '2026-10-04T00:00:00.000Z'
    if (kind === 'grant') conditions.records = conditions.records.filter(pin => pin.collection !== 'access-grants')
    if (kind === 'run') conditions.records = conditions.records.filter(pin => pin.collection !== 'runs')
    if (kind === 'version') conditions.records.find(pin => pin.collection === 'runs')!.version = '2'
    expect(() => f.store.save(f.command, kind === 'absent' ? undefined : conditions)).toThrow(expect.objectContaining({ code: 'invalid-command' }))
    expect(f.journal.history).toHaveLength(count); expect(await f.owner.show(f.id)).toEqual(f.record)
  })
  it('rejects an action/batch UUID substitution before writing and on retained replay', async () => {
    const f = await controlFixture(), count = f.journal.history.length
    expect(() => f.store.save({ ...f.command, requestId: randomUUID() }, f.conditions)).toThrow(expect.objectContaining({ code: 'corrupt' }))
    expect(f.journal.history).toHaveLength(count)
    await f.store.save(f.command, f.conditions)
    f.journal.history.at(-1)!.batchId = randomUUID()
    await expect(f.owner.show(f.id)).rejects.toHaveProperty('code', 'corrupt')
  })
  it.each(['revoked', 'expired'] as const)('refuses %s after planning, without a control record or journal event', async kind => {
    const f = await controlFixture()
    if (kind === 'revoked') await f.owner.revokeGrant({ id: f.caller.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' })
    else vi.setSystemTime(expiresAt)
    const count = f.journal.history.length
    await expect(f.store.save(f.command, f.conditions)).rejects.toHaveProperty('code', 'conflict')
    expect(f.journal.history).toHaveLength(count); expect(await f.owner.show(f.id)).toEqual(f.record)
  })
  it('observes a double-simulated committed admission after acknowledgment loss, never reconstructing execution', async () => {
    const f = await controlFixture(); f.journal.failCommit = true
    await expect(f.store.save(f.command, f.conditions)).rejects.toHaveProperty('code', 'commit-uncertain')
    const count = f.journal.history.length, record = await f.owner.show(f.id)
    expect(callerControlRetry(record, f.request)).toMatchObject({ id: f.id, mode: 'step' })
    expect(f.journal.history).toHaveLength(count); expect(record.state.steps).toEqual([])
  })
  it('keeps delegated admission out of the public owner control input', async () => {
    const f = await controlFixture(), count = f.journal.history.length
    await expect(f.owner.advance(f.id, { ...f.request, delegation: f.prepared.control.delegation } as never, 'owner:test')).rejects.toHaveProperty('code', 'invalid-command')
    expect(f.journal.history).toHaveLength(count)
  })
})

describe('PostgreSQL SDK caller cancellation (journal double, not actual SQL)', () => {
  it.each(['paused', 'waiting'] as const)('retains authenticated %s cancellation causality across observation-only retries', async status => {
    const f = await fixture(status === 'waiting' ? approval : echo)
    Reflect.set(f.owner, 'telemetry', new RuntimeTelemetry({ endpoint: 'http://127.0.0.1:9/v1/traces',
      authentication: { kind: 'none' }, sampleRatio: 0 }, async () => undefined))
    const caller = await f.issue(['start', 'cancel']), id = randomUUID(), request = { requestId: randomUUID() }
    const parent = `00-${'3'.repeat(32)}-${'4'.repeat(16)}-01`
    await f.owner.startWithGrant(caller.token, status === 'waiting' ? { message: 'private' } : 'private', { id, paused: status === 'paused' })
    const receipt = await f.owner.withTraceParent(parent, () => f.owner.cancelWithGrant(caller.token, id, request))
    const saved = await f.owner.show(id), events = await f.owner.events(id)
    const traceParent = { traceId: '3'.repeat(32), spanId: '4'.repeat(16), traceFlags: 1 }
    expect(saved.cancellation?.traceParent).toEqual(traceParent)
    expect(saved.traceSegments!.at(-1)!.cause).toEqual({ kind: 'cancellation', requestId: request.requestId, parent: traceParent })
    const batch = f.journal.history.find(e => e.kind === 'cancellation-requested')!
    expect(batch.batchId).toBe(request.requestId); expect(batch.data.data.traceParent).toEqual(traceParent)
    expect(await f.owner.withTraceParent(`00-${'5'.repeat(32)}-${'6'.repeat(16)}-00`, () => f.owner.cancelWithGrant(caller.token, id, request))).toEqual(receipt)
    expect(await f.owner.show(id)).toEqual(saved); expect(await f.owner.events(id)).toEqual(events)
    expect((await f.owner.exportRun(id)).snapshot.run.cancellation?.traceParent).toEqual(traceParent)
  })

  it('retains the first admission context after a lost journal COMMIT acknowledgement without retry settlement', async () => {
    const f = await fixture()
    Reflect.set(f.owner, 'telemetry', new RuntimeTelemetry({ endpoint: 'http://127.0.0.1:9/v1/traces',
      authentication: { kind: 'none' }, sampleRatio: 0 }, async () => undefined))
    const caller = await f.issue(['start', 'cancel']), id = randomUUID(), request = { requestId: randomUUID() }
    await f.owner.startWithGrant(caller.token, 'private', { id, paused: true }); f.journal.failCommit = true
    await expect(f.owner.withTraceParent(`00-${'3'.repeat(32)}-${'4'.repeat(16)}-01`, () => f.owner.cancelWithGrant(caller.token, id, request)))
      .rejects.toHaveProperty('code', 'commit-uncertain')
    const saved = await f.owner.show(id), events = await f.owner.events(id)
    expect(saved.cancellation?.traceParent).toEqual({ traceId: '3'.repeat(32), spanId: '4'.repeat(16), traceFlags: 1 })
    expect((await f.owner.withTraceParent(`00-${'5'.repeat(32)}-${'6'.repeat(16)}-00`, () => f.owner.cancelWithGrant(caller.token, id, request))).status).toBe('paused')
    expect(await f.owner.show(id)).toEqual(saved); expect(await f.owner.events(id)).toEqual(events)
  })

  it.each(['paused', 'waiting'] as const)('cancels its own %s run with exact grant/run/time conditions and metadata-only receipt', async status => {
    const f = await fixture(status === 'waiting' ? approval : echo), caller = await f.issue(['start', 'cancel']), id = randomUUID(), request = { requestId: randomUUID() }
    await f.owner.startWithGrant(caller.token, status === 'waiting' ? { message: 'PRIVATE_INPUT' } : 'PRIVATE_INPUT', { id, paused: status === 'paused' })
    vi.setSystemTime('2026-10-02T00:01:00.000Z')
    const receipt = await f.owner.cancelWithGrant(caller.token, id, request)
    expect(callerCancellationReceiptSchema.parse(receipt)).toEqual(receipt); expect(receipt.status).toBe('cancelled')
    const record = await f.owner.show(id), events = await f.owner.events(id)
    expect(record.cancellation).toEqual({ id: request.requestId, actor: `grant:${caller.id}`, at: receipt.requestedAt,
      delegation: { grantId: caller.id, scope: { ...f.scope, permissions: ['cancel', 'start'] }, deadline: expiresAt } })
    const event = f.journal.history.find(e => e.kind === 'cancellation-requested')
    expect(event.batchId).toBe(request.requestId); expect(event.data.data).toEqual(record.cancellation)
    const guard = f.journal.guards.find(g => g?.records.some(pin => pin.collection === 'runs'))!
    expect(guard.notBefore).toBe(receipt.requestedAt); expect(guard.expiresAt).toBe(expiresAt)
    expect(guard.records.map(pin => pin.collection)).toEqual(['access-grants', 'runs'])
    expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE_INPUT|delegation|grantId|actor|yaml|steps|scope/)
    expect(JSON.stringify(await f.owner.exportRun(id))).not.toContain(caller.id)
    expect(JSON.stringify(await f.owner.exportRun(id, true))).toContain(caller.id)
    const count = f.journal.history.length, writes = f.journal.guards.length
    expect(await f.owner.cancelWithGrant(caller.token, id, request)).toEqual(receipt)
    expect(await f.owner.events(id)).toEqual(events); expect(f.journal.history).toHaveLength(count); expect(f.journal.guards).toHaveLength(writes)
    await expect(f.owner.readWithGrant(caller.token, id)).rejects.toHaveProperty('code', 'not-found')
  })
  it('filters other grants, owner runs and missing IDs before private reads or a trusted hook', async () => {
    const f = await fixture(), caller = await f.issue(['start', 'cancel']), other = await f.issue(['start', 'cancel']), id = randomUUID(), hook = vi.fn()
    await f.owner.startWithGrant(caller.token, 'private', { id, paused: true }); const owner = await f.owner.run(echo, 'owner', { paused: true })
    for (const selected of [id, owner.id, randomUUID()]) {
      f.journal.reads.splice(0)
      await expect(f.owner.cancelWithGrant(other.token, selected, { requestId: randomUUID() }, hook)).rejects.toHaveProperty('code', 'not-found')
      expect(f.journal.reads.some(key => key.startsWith('runs/'))).toBe(false)
    }
    await expect(f.owner.cancelWithGrant(f.prepared.token, id, { requestId: randomUUID() }, hook)).rejects.toHaveProperty('code', 'not-found')
    expect(hook).not.toHaveBeenCalled()
  })
  it.each(['actor', 'delegation', 'scope', 'at', 'release', 'authority', 'traceParent', 'cause', 'unknown'])('refuses caller-supplied %s and missing UUID without mutation', async key => {
    const f = await fixture(), caller = await f.issue(['start', 'cancel']), id = randomUUID()
    await f.owner.startWithGrant(caller.token, 'input', { id, paused: true }); const count = f.journal.history.length
    await expect(f.owner.cancelWithGrant(caller.token, id, { requestId: randomUUID(), [key]: 'forged' })).rejects.toHaveProperty('code', 'invalid-command')
    await expect(f.owner.cancelWithGrant(caller.token, id, {} as never)).rejects.toHaveProperty('code', 'invalid-command')
    await expect(f.owner.cancelWithGrant(caller.token, id, { requestId: randomUUID() }, {} as never)).rejects.toHaveProperty('code', 'invalid-command')
    expect(f.journal.history).toHaveLength(count)
  })
  it('captures request and release pins before a trusted asynchronous hook', async () => {
    const f = await fixture(), caller = await f.issue(['start', 'cancel']), id = randomUUID(), request = { requestId: randomUUID() }, expected = request.requestId
    await f.owner.startWithGrant(caller.token, 'input', { id, paused: true })
    const receipt = await f.owner.cancelWithGrant(caller.token, id, request, async (pin, execute) => {
      pin.id = randomUUID(); request.requestId = randomUUID(); await Promise.resolve(); return execute()
    })
    expect(receipt.requestId).toBe(expected); expect(receipt.release.id).toBe(f.scope.release.id)
  })
  it('refuses a backward admission clock before a historically invalid write', async () => {
    const f = await fixture(), caller = await f.issue(['start', 'cancel']), id = randomUUID()
    vi.setSystemTime('2026-10-02T00:01:00.000Z'); await f.owner.startWithGrant(caller.token, 'input', { id, paused: true })
    const events = await f.owner.events(id); vi.setSystemTime(at)
    await expect(f.owner.cancelWithGrant(caller.token, id, { requestId: randomUUID() })).rejects.toHaveProperty('code', 'conflict')
    expect(await f.owner.events(id)).toEqual(events)
  })
  it.each(['new-revoked', 'new-expired', 'retry-revoked', 'retry-expired'])('reauthenticates %s after an awaited hook with no run write', async kind => {
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
  it.each(['revoked', 'expired', 'checkpoint-changed'])('refuses %s after planning but at the exact guarded commit', async kind => {
    const f = await fixture(), caller = await f.issue(['start', 'cancel']), id = randomUUID()
    await f.owner.startWithGrant(caller.token, 'input', { id, paused: true }); const events = await f.owner.events(id), commit = f.journal.commit.bind(f.journal)
    vi.spyOn(f.journal, 'commit').mockImplementation(async (batch, guard) => {
      if (batch.events.some(e => e.kind === 'cancellation-requested')) {
        if (kind === 'expired') vi.setSystemTime(expiresAt)
        else if (kind === 'revoked') {
          const row = f.journal.rows.get(f.journal.key('access-grants', caller.id))!
          row.version = '2'
        } else f.journal.rows.get(f.journal.key('runs', id))!.version = '2'
      }
      return commit(batch, guard)
    })
    const abort = vi.spyOn(AbortController.prototype, 'abort')
    await expect(f.owner.cancelWithGrant(caller.token, id, { requestId: randomUUID() })).rejects.toHaveProperty('code', 'conflict')
    expect(abort).not.toHaveBeenCalled(); expect(f.journal.history.filter(e => e.collection === 'runs')).toHaveLength(events.length)
  })
  it('observes an uncertain committed request without abort or settlement, including a new runtime object', async () => {
    const f = await fixture(), caller = await f.issue(['start', 'cancel']), id = randomUUID(), request = { requestId: randomUUID() }
    await f.owner.startWithGrant(caller.token, 'input', { id, paused: true }); f.journal.failCommit = true
    await expect(f.owner.cancelWithGrant(caller.token, id, request)).rejects.toHaveProperty('code', 'commit-uncertain')
    const events = await f.owner.events(id), writes = f.journal.guards.length, abort = vi.spyOn(AbortController.prototype, 'abort')
    expect((await f.owner.cancelWithGrant(caller.token, id, request)).status).toBe('paused')
    expect(await f.owner.events(id)).toEqual(events); expect(f.journal.guards).toHaveLength(writes); expect(abort).not.toHaveBeenCalled()
    await f.owner.close()
    const reopened = Reflect.construct(PostgresRuntime, [f.journal, 10000, 10000, 4_000_000, parseNotificationConfig({})]) as PostgresRuntime; owners.push(reopened)
    expect((await reopened.cancelWithGrant(caller.token, id, request)).status).toBe('paused')
    expect(await reopened.events(id)).toEqual(events)
    expect((await reopened.cancel(id, request.requestId, 'owner:test')).state.status).toBe('cancelled')
  })
  it('does not adopt an owner cancellation or accept a changed request, terminal run or used batch UUID', async () => {
    const f = await fixture(), caller = await f.issue(['start', 'cancel']), request = { requestId: randomUUID() }
    const id = randomUUID(); await f.owner.startWithGrant(caller.token, 'input', { id, paused: true }); await f.owner.cancel(id, request.requestId, `grant:${caller.id}`)
    await expect(f.owner.cancelWithGrant(caller.token, id, request)).rejects.toHaveProperty('code', 'conflict')
    const other = randomUUID(); await f.owner.startWithGrant(caller.token, 'input', { id: other, paused: true })
    await expect(f.owner.cancelWithGrant(caller.token, other, { requestId: caller.id })).rejects.toHaveProperty('code', 'conflict')
    await f.owner.cancelWithGrant(caller.token, other, request)
    await expect(f.owner.cancelWithGrant(caller.token, other, { requestId: randomUUID() })).rejects.toHaveProperty('code', 'conflict')
    const complete = randomUUID(); await f.owner.startWithGrant(caller.token, 'input', { id: complete })
    await expect(f.owner.cancelWithGrant(caller.token, complete, request)).rejects.toHaveProperty('code', 'conflict')
  })
  it('requires exact action UUID, deadline and grant/run guards at the writer rather than accepting a token lookup', async () => {
    const f = await fixture(), caller = await f.issue(['start', 'cancel']), id = randomUUID(), request = { requestId: randomUUID() }
    await f.owner.startWithGrant(caller.token, 'input', { id, paused: true })
    let captured: any, conditions: JournalConditions | undefined
    const original = PostgresRunStore.prototype.save
    vi.spyOn(PostgresRunStore.prototype, 'save').mockImplementation(function (this: PostgresRunStore, value, guard) {
      if (value.kind === 'cancellation-requested') { captured = structuredClone(value); conditions = structuredClone(guard); throw Error('fixture intercepted admission') }
      return original.call(this, value, guard)
    })
    await expect(f.owner.cancelWithGrant(caller.token, id, request)).rejects.toThrow('fixture intercepted admission')
    vi.restoreAllMocks(); const store = new PostgresRunStore(f.journal as unknown as PostgresJournal), before = f.journal.history.length
    for (const guard of [undefined, { ...conditions!, notBefore: '2026-10-02T00:01:00.000Z' }, { ...conditions!, expiresAt: '2026-10-04T00:00:00.000Z' },
      { ...conditions!, records: conditions!.records.filter(pin => pin.collection !== 'access-grants') },
      { ...conditions!, records: conditions!.records.filter(pin => pin.collection !== 'runs') }]) {
      if (guard?.notBefore === conditions!.notBefore && guard?.expiresAt === conditions!.expiresAt && guard.records.length === 2) continue
      expect(() => store.save(captured, guard)).toThrowError(expect.objectContaining({ code: 'invalid-command' }))
    }
    expect(() => store.save({ ...captured, requestId: randomUUID() }, conditions)).toThrowError(expect.objectContaining({ code: 'corrupt' }))
    expect(f.journal.history).toHaveLength(before)
  })
  it('signals an active model only once, observes an unsettled retry, and lets already admitted settlement finish', async () => {
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(); let signal: AbortSignal | undefined
    vi.spyOn(ConfiguredModels.prototype, 'admit').mockResolvedValue({} as never)
    vi.spyOn(ConfiguredModels.prototype, 'verify').mockResolvedValue(undefined)
    const model = vi.spyOn(ConfiguredModels.prototype, 'execute').mockImplementation(async (_plan, _input, _id, abortSignal) => {
      signal = abortSignal; entered.resolve(); await gate.promise; throw Error('fixture stopped model')
    })
    const f = await fixture(native), caller = await f.issue(['start', 'cancel']), id = randomUUID(), request = { requestId: randomUUID() }
    const pending = f.owner.startWithGrant(caller.token, 'PRIVATE_INPUT', { id })
    try {
      await entered.promise; const abort = vi.spyOn(AbortController.prototype, 'abort')
      const first = await f.owner.cancelWithGrant(caller.token, id, request), events = await f.owner.events(id)
      expect(first.status).toBe('executing'); expect(signal?.aborted).toBe(true); expect(abort).toHaveBeenCalledOnce()
      expect(await f.owner.cancelWithGrant(caller.token, id, request)).toEqual(first)
      expect(await f.owner.events(id)).toEqual(events); expect(abort).toHaveBeenCalledOnce()
      await f.owner.revokeGrant({ id: caller.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' })
    } finally { gate.resolve(); expect((await pending).status).toBe('cancelled') }
    expect(model).toHaveBeenCalledOnce(); expect((await f.owner.show(id)).state.status).toBe('cancelled')
  })
  it.each(['actor', 'grant', 'permission', 'release', 'deadline', 'before-creation', 'event-kind', 'event-missing', 'batch'] as const)('refuses cancellation %s corruption before receipt or effects', async kind => {
    const f = await fixture(), caller = await f.issue(['start', 'cancel']), id = randomUUID(), request = { requestId: randomUUID() }
    await f.owner.startWithGrant(caller.token, 'input', { id, paused: true })
    vi.setSystemTime('2026-10-02T00:01:00.000Z'); await f.owner.cancelWithGrant(caller.token, id, request)
    const row = f.journal.rows.get(f.journal.key('runs', id))!, record = (row.value as any).record, saved = record.cancellation
    if (kind === 'actor') saved.actor = 'owner:forged'
    if (kind === 'grant') { saved.delegation.grantId = randomUUID(); saved.actor = `grant:${saved.delegation.grantId}` }
    if (kind === 'permission') saved.delegation.scope.permissions = ['start']
    if (kind === 'release') saved.delegation.scope.release.sha256 = 'b'.repeat(64)
    if (kind === 'deadline') saved.delegation.deadline = '2026-10-04T00:00:00.000Z'
    if (kind === 'before-creation') saved.at = '2026-10-01T00:00:00.000Z'
    const event = f.journal.history.find(e => e.key === id && e.kind === 'cancellation-requested')!; event.data.data = structuredClone(saved)
    if (kind === 'event-kind') event.kind = 'execution-segment'
    if (kind === 'event-missing') f.journal.history.splice(f.journal.history.indexOf(event), 1)
    if (kind === 'batch') event.batchId = randomUUID()
    const count = f.journal.history.length
    await expect(f.owner.cancelWithGrant(caller.token, id, request)).rejects.toHaveProperty('code', 'corrupt')
    expect(f.journal.history).toHaveLength(count)
  })
})

describe('PostgreSQL SDK caller domain integration (journal double)', () => {

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
  it('executes an exact release with guarded atomic attribution; returns only metadata then explicit own completed output', async () => {
    const f = await fixture(), id = randomUUID(), receipt = await f.owner.startWithGrant(f.prepared.token, 'PRIVATE', { id })
    expect(receipt.status).toBe('completed'); expect(receipt).not.toHaveProperty('output')
    expect(await f.owner.readWithGrant(f.prepared.token, id)).toEqual({ ...receipt, output: 'PRIVATE' })
    const run = await f.owner.show(id), events = await f.owner.events(id)
    expect(run.caller).toEqual({ grantId: f.prepared.id, actor: `grant:${f.prepared.id}`, at, scope: f.scope })
    expect(events[0]?.data).toMatchObject({ caller: run.caller })
    expect(f.journal.guards.find(value => value?.records.some(r => r.collection === 'releases'))?.records.map(r => r.collection)).toEqual(['access-grants', 'releases'])
    expect(JSON.stringify(await f.owner.exportRun(id))).not.toContain(f.prepared.id)
    expect(JSON.stringify(f.journal.history)).not.toContain(f.prepared.token)
  })
  it('retry observes mutable current state, never replays a stale creation write or resumes execution', async () => {
    const f = await fixture(), o = { id: randomUUID(), paused: true }, first = await f.owner.startWithGrant(f.prepared.token, 'input', o), count = f.journal.history.length
    expect(await f.owner.startWithGrant(f.prepared.token, 'input', o)).toEqual(first)
    expect(f.journal.history).toHaveLength(count)
    await expect(f.owner.startWithGrant(f.prepared.token, 'changed', o)).rejects.toHaveProperty('code', 'conflict')
    await expect(f.owner.startWithGrant(f.prepared.token, 'input', { ...o, paused: false })).rejects.toHaveProperty('code', 'conflict')
    await f.owner.resume(o.id)
    expect((await f.owner.startWithGrant(f.prepared.token, 'input', o)).status).toBe('completed')
  })
  it('start-only and read-only permissions never substitute for one another or another grant ownership', async () => {
    const f = await fixture(), start = await f.issue(['start']), read = await f.issue(['read']), id = randomUUID()
    expect((await f.owner.startWithGrant(start.token, 'input', { id })).status).toBe('completed')
    await expect(f.owner.readWithGrant(start.token, id)).rejects.toHaveProperty('code', 'not-found')
    await expect(f.owner.readWithGrant(read.token, id)).rejects.toHaveProperty('code', 'not-found')
    await expect(f.owner.startWithGrant(read.token, 'input', { id: randomUUID() })).rejects.toHaveProperty('code', 'not-found')
  })
  it('filters foreign/owner runs before private reads, including foreign creation collisions', async () => {
    const f = await fixture(), id = randomUUID(), other = await f.issue(), ownerRun = await f.owner.runRelease(f.release.snapshot, 'owner-private')
    await f.owner.startWithGrant(f.prepared.token, 'input', { id })
    for (const selected of [id, ownerRun.id, randomUUID()]) {
      f.journal.reads.splice(0)
      await expect(f.owner.readWithGrant(other.token, selected)).rejects.toHaveProperty('code', 'not-found')
      expect(f.journal.reads.some(key => key.startsWith('runs/'))).toBe(false)
    }
    for (const selected of [id, ownerRun.id]) {
      f.journal.reads.splice(0)
      await expect(f.owner.startWithGrant(other.token, 'input', { id: selected })).rejects.toHaveProperty('code', 'not-found')
      expect(f.journal.reads.some(key => key.startsWith('runs/'))).toBe(false)
    }
    await expect(f.owner.runRelease(f.release.snapshot, 'input', { id })).rejects.toHaveProperty('code', 'conflict')
  })
  it.each(['actor', 'caller', 'release', 'project', 'yaml', 'test', 'authority'])('refuses client %s and missing retained UUID without mutation', async key => {
    const f = await fixture(), count = f.journal.history.length
    await expect(f.owner.startWithGrant(f.prepared.token, 'input', { id: randomUUID(), [key]: 'forged' })).rejects.toHaveProperty('code', 'invalid-command')
    await expect(f.owner.startWithGrant(f.prepared.token, 'input', {} as never)).rejects.toHaveProperty('code', 'invalid-command')
    expect(f.journal.history).toHaveLength(count)
  })
  it.each(['expired', 'revoked', 'wrong-secret', 'owner-token'] as const)('refuses %s start/read/retry without checkpoint changes', async kind => {
    const f = await fixture(), o = { id: randomUUID(), paused: true }; await f.owner.startWithGrant(f.prepared.token, 'input', o)
    let token = f.prepared.token
    if (kind === 'expired') vi.setSystemTime(expiresAt)
    if (kind === 'revoked') await f.owner.revokeGrant({ id: f.prepared.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' })
    if (kind === 'wrong-secret') token = prepareGrantToken(f.prepared.id).token
    if (kind === 'owner-token') token = 'a'.repeat(64)
    const count = f.journal.history.length
    await expect(f.owner.startWithGrant(token, 'input', o)).rejects.toHaveProperty('code', 'not-found')
    await expect(f.owner.startWithGrant(token, 'input', { id: randomUUID() })).rejects.toHaveProperty('code', 'not-found')
    await expect(f.owner.readWithGrant(token, o.id)).rejects.toHaveProperty('code', 'not-found')
    expect(f.journal.history).toHaveLength(count); expect((await f.owner.show(o.id)).state.status).toBe('paused')
  })
  it.each(['revoked', 'expired'] as const)('refuses %s after delayed model admission before planning/writing', async kind => {
    const f = await fixture(native), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
    vi.spyOn(ConfiguredModels.prototype, 'admit').mockImplementation(async () => { entered.resolve(); await gate.promise; return {} as never })
    const execute = vi.spyOn(ConfiguredModels.prototype, 'execute'), pending = f.owner.startWithGrant(f.prepared.token, 'input', { id: randomUUID(), paused: true })
    const rejected = expect(pending).rejects.toHaveProperty('code', 'not-found')
    try { await entered.promise
      if (kind === 'revoked') await f.owner.revokeGrant({ id: f.prepared.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' })
      else vi.setSystemTime(expiresAt)
    } finally { gate.resolve() }
    await rejected; expect(await f.journal.count('runs')).toBe(0); expect(execute).not.toHaveBeenCalled()
  })
  it.each(['revoked', 'expired'] as const)('guard refuses %s after planning and before creation commit', async kind => {
    const f = await fixture(), original = PostgresRunStore.prototype.saveCallerCreation
    vi.spyOn(PostgresRunStore.prototype, 'saveCallerCreation').mockImplementation(async function(this: PostgresRunStore, value, guard) {
      if (kind === 'revoked') await f.owner.revokeGrant({ id: f.prepared.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' })
      else vi.setSystemTime(expiresAt)
      return original.call(this, value, guard)
    })
    await expect(f.owner.startWithGrant(f.prepared.token, 'input', { id: randomUUID(), paused: true })).rejects.toHaveProperty('code', 'conflict')
    expect(await f.journal.count('runs')).toBe(0)
  })
  it('scopes in-flight identity reservations and does not expose another caller busy state', async () => {
    const f = await fixture(native), other = await f.issue(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), o = { id: randomUUID(), paused: true }
    vi.spyOn(ConfiguredModels.prototype, 'admit').mockImplementation(async () => { entered.resolve(); await gate.promise; return {} as never })
    const pending = f.owner.startWithGrant(f.prepared.token, 'input', o)
    try { await entered.promise
      await expect(f.owner.startWithGrant(f.prepared.token, 'input', o)).rejects.toHaveProperty('code', 'busy')
      await expect(f.owner.startWithGrant(other.token, 'input', o)).rejects.toHaveProperty('code', 'not-found')
    } finally { gate.resolve(); await pending }
  })
  it('detaches input/options before awaited grant reads and rechecks expiry after slow private replay', async () => {
    const objectSource = echo.replace('    type: string', '    type: object\n    properties:\n      message: {type: string}\n    required: [message]\n    additionalProperties: false')
    const f = await fixture(objectSource), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), o = { id: randomUUID(), paused: true }, input = { message: 'captured' }
    f.journal.hook = async (collection) => { if (collection === 'access-grants') { entered.resolve(); await gate.promise } }
    const pending = f.owner.startWithGrant(f.prepared.token, input, o)
    await entered.promise; input.message = 'changed'; o.id = randomUUID(); o.paused = false; f.journal.hook = undefined; gate.resolve()
    const receipt = await pending; expect(receipt.id).not.toBe(o.id); expect(receipt.status).toBe('paused')
    expect((await f.owner.show(receipt.id)).input).toEqual({ message: 'captured' })
    const hold = Promise.withResolvers<void>(), reading = Promise.withResolvers<void>()
    f.journal.hook = async collection => { if (collection === 'runs') { reading.resolve(); await hold.promise } }
    const read = f.owner.readWithGrant(f.prepared.token, receipt.id), rejected = expect(read).rejects.toHaveProperty('code', 'not-found')
    try { await reading.promise; vi.setSystemTime(expiresAt) } finally { hold.resolve() }
    await rejected
  })
  it('retains one creation after double-simulated lost acknowledgment; public retry observes it without write replay', async () => {
    const f = await fixture(), o = { id: randomUUID(), paused: true }; f.journal.failCommit = true
    await expect(f.owner.startWithGrant(f.prepared.token, 'input', o)).rejects.toHaveProperty('code', 'commit-uncertain')
    const count = f.journal.history.length, run = await f.owner.show(o.id)
    expect(run.caller?.grantId).toBe(f.prepared.id)
    expect((await f.owner.startWithGrant(f.prepared.token, 'input', o)).status).toBe('paused')
    expect(f.journal.history).toHaveLength(count)
  })
  it('denies reviewer principals without loading caller source or a private target', async () => {
    const f = await fixture(), p = prepareGrantToken(randomUUID()), store = new PostgresGrantStore(f.journal as unknown as PostgresJournal)
    await store.issue({ id: p.id, tokenSha256: p.tokenSha256, actor: 'owner:test', expiresAt,
      scope: { kind: 'reviewer', runId: randomUUID(), attemptId: randomUUID(), revision: f.scope.release.revision, decisions: ['approve'] } }, async () => {})
    f.journal.reads.splice(0)
    await expect(f.owner.startWithGrant(p.token, 'input', { id: randomUUID() })).rejects.toHaveProperty('code', 'not-found')
    await expect(f.owner.readWithGrant(p.token, randomUUID())).rejects.toHaveProperty('code', 'not-found')
    expect(f.journal.reads.every(key => key.startsWith('access-grants/'))).toBe(true)
    await f.owner.close()
    await expect(f.owner.startWithGrant('', null, {} as never)).rejects.toHaveProperty('code', 'closed')
    await expect(f.owner.readWithGrant('', '')).rejects.toHaveProperty('code', 'closed')
  })
})

async function reviewerFixture(traced = false) {
  const f = await fixture(approval)
  if (traced) Reflect.set(f.owner, 'telemetry', new RuntimeTelemetry({ endpoint: 'http://127.0.0.1:9/v1/traces',
    authentication: { kind: 'none' }, sampleRatio: 0 }, () => undefined, { storage: 'postgres' }))
  const run = await f.owner.runRelease(f.release.snapshot, { message: 'PRIVATE_REVIEW' })
  if (run.state.status !== 'waiting') throw Error('expected reviewer wait')
  const scope: Extract<GrantScope, { kind: 'reviewer' }> = { kind: 'reviewer', runId: run.id, attemptId: run.state.attempt.id,
    revision: run.revision, decisions: ['approve', 'reject'] }
  async function reviewer(decisions = scope.decisions) {
    const p = prepareGrantToken(randomUUID())
    await f.owner.issueGrant({ id: p.id, tokenSha256: p.tokenSha256, actor: 'owner:test', expiresAt, scope: { ...scope, decisions } })
    return p
  }
  return { ...f, run, reviewerScope: scope, reviewer, review: await reviewer() }
}
const reviewRequest = (action: 'approve' | 'reject' = 'approve', pauseAfter = true) => ({ requestId: randomUUID(), action, pauseAfter })

describe('PostgreSQL reviewer SDK domain integration (NOT actual SQL)', () => {
  it('authenticates before propagation and rechecks receipt authorization after a trusted hook awaits', async () => {
    const f = await reviewerFixture(), selected = reviewRequest(), hook = vi.fn(async (execute: () => Promise<any>) => execute())
    await expect(f.owner.decideWithGrant(prepareGrantToken(randomUUID()).token, selected, hook)).rejects.toHaveProperty('code', 'not-found')
    expect(hook).not.toHaveBeenCalled()
    await f.owner.decideWithGrant(f.review.token, selected)
    const count = f.journal.history.length
    await expect(f.owner.decideWithGrant(f.review.token, selected, async execute => {
      await f.owner.revokeGrant({ id: f.review.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' })
      return execute()
    })).rejects.toHaveProperty('code', 'not-found')
    expect(f.journal.history.slice(count).map(e => e.collection)).not.toContain('runs')
  })
  it.each(['approve', 'reject'] as const)('commits an unsampled %s segment in the same guarded journal batch', async action => {
    const f = await reviewerFixture(true), selected = reviewRequest(action), before = await f.owner.show(f.run.id), count = f.journal.history.length
    const receipt = await f.owner.decideWithGrant(f.review.token, selected), after = await f.owner.show(f.run.id)
    const changes = f.journal.history.slice(count), segment = after.traceSegments!.at(-1)
    expect(after.traceSegments).toHaveLength(before.traceSegments!.length + 1)
    expect(changes.map(e => e.kind)).toEqual(['approval-decided'])
    expect(changes[0].batchId).toBe(selected.requestId)
    expect(changes[0].data.data.segment).toEqual(segment)
    expect(segment).toMatchObject({ operation: 'approval', at: receipt.at, trace: { traceFlags: 0 }, previous: before.traceSegments!.at(-1)!.trace })
    expect(await f.owner.decideWithGrant(f.review.token, selected)).toEqual(receipt)
    expect(f.journal.history).toHaveLength(count + 1)
  })
  it.each(['missing-event', 'missing-record', 'trace', 'operation', 'timestamp', 'previous', 'parent', 'order', 'duplicate'] as const)(
    'refuses retained reviewer trace %s corruption at verified SQL-adapter reads (domain double)', async kind => {
      const f = await reviewerFixture(true); await f.owner.decideWithGrant(f.review.token, reviewRequest())
      const row = f.journal.rows.get(f.journal.key('runs', f.run.id))!, record = (row.value as any).record
      const event = f.journal.history.find(e => e.key === f.run.id && e.kind === 'approval-decided').data.data
      const segment = record.traceSegments.at(-1)
      if (kind === 'missing-event') delete event.segment
      if (kind === 'missing-record') record.traceSegments.pop()
      if (kind === 'trace') event.segment.trace.spanId = 'c'.repeat(16)
      if (kind === 'operation') { segment.operation = 'resume'; event.segment = structuredClone(segment) }
      if (kind === 'timestamp') { segment.at = expiresAt; event.segment = structuredClone(segment) }
      if (kind === 'previous') { delete segment.previous; event.segment = structuredClone(segment) }
      if (kind === 'parent') { segment.parent = { ...segment.trace, traceId: 'd'.repeat(32) }; event.segment = structuredClone(segment) }
      if (kind === 'order') record.traceSegments.reverse()
      if (kind === 'duplicate') record.traceSegments.push(structuredClone(segment))
      const count = f.journal.history.length
      await expect(f.owner.show(f.run.id)).rejects.toHaveProperty('code', 'corrupt')
      expect(f.journal.history).toHaveLength(count)
    })
  it.each(['approve', 'reject'] as const)('retains guarded %s attribution in state and event; returns metadata only', async action => {
    const f = await reviewerFixture(), selected = reviewRequest(action), receipt = await f.owner.decideWithGrant(f.review.token, selected)
    expect(receipt).toEqual({ schemaVersion: 1, ...selected, runId: f.run.id, attemptId: f.reviewerScope.attemptId,
      revision: f.run.revision, at, status: action === 'approve' ? 'paused' : 'failed' })
    const event = (await f.owner.events(f.run.id)).find(e => e.kind === 'approval-decided')?.data as any
    expect(event.decision).toEqual({ kind: 'action', action, actor: `grant:${f.review.id}`, at,
      delegation: { requestId: selected.requestId, grantId: f.review.id, scope: f.reviewerScope, deadline: expiresAt, pauseAfter: true } })
    const guard = f.journal.guards.find(value => value?.records.some(r => r.collection === 'runs'))
    expect(guard?.records.map(r => r.collection)).toEqual(['access-grants', 'runs'])
    expect(guard?.expiresAt).toBe(expiresAt)
    const evidence = JSON.stringify(await f.owner.exportRun(f.run.id))
    for (const secret of [f.review.id, f.review.token, 'PRIVATE_REVIEW', 'delegation']) expect(evidence).not.toContain(secret)
    expect(JSON.stringify(f.journal.history)).not.toContain(f.review.token)
    for (const key of ['input', 'output', 'yaml', 'steps', 'state', 'scope', 'actor', 'grantId', 'deadline']) expect(receipt).not.toHaveProperty(key)
  })
  it('observes exact retries without writing/resuming; changed options conflict and foreign requests stay isolated', async () => {
    const f = await reviewerFixture(), other = await f.reviewer(), selected = reviewRequest(), first = await f.owner.decideWithGrant(f.review.token, selected)
    const count = f.journal.history.length
    expect(await f.owner.decideWithGrant(f.review.token, selected)).toEqual(first)
    await expect(f.owner.decideWithGrant(f.review.token, { ...selected, action: 'reject' })).rejects.toHaveProperty('code', 'conflict')
    await expect(f.owner.decideWithGrant(f.review.token, { ...selected, pauseAfter: false })).rejects.toHaveProperty('code', 'conflict')
    await expect(f.owner.decideWithGrant(other.token, selected)).rejects.toHaveProperty('code', 'not-found')
    await expect(f.owner.decideWithGrant(f.review.token, reviewRequest())).rejects.toHaveProperty('code', 'not-found')
    expect(f.journal.history).toHaveLength(count)
    await f.owner.resume(f.run.id)
    expect((await f.owner.decideWithGrant(f.review.token, selected)).status).toBe('completed')
  })
  it('continues an approved run exactly once when pauseAfter is false', async () => {
    const f = await reviewerFixture(), selected = reviewRequest('approve', false)
    expect((await f.owner.decideWithGrant(f.review.token, selected)).status).toBe('completed')
    const count = f.journal.history.length
    expect((await f.owner.decideWithGrant(f.review.token, selected)).status).toBe('completed')
    expect(f.journal.history).toHaveLength(count)
  })
  it.each(['actor', 'runId', 'attemptId', 'revision', 'scope', 'authority'])('refuses client %s without target reads or mutation', async key => {
    const f = await reviewerFixture(), count = f.journal.history.length
    f.journal.reads.splice(0)
    await expect(f.owner.decideWithGrant(f.review.token, { ...reviewRequest(), [key]: 'forged' })).rejects.toHaveProperty('code', 'invalid-command')
    expect(f.journal.reads).toEqual([]); expect(f.journal.history).toHaveLength(count)
  })
  it.each(['caller', 'owner', 'wrong-secret', 'revoked', 'expired', 'disallowed'] as const)('refuses %s before any private run read', async kind => {
    const f = await reviewerFixture()
    let token = f.review.token
    if (kind === 'caller') token = f.prepared.token
    if (kind === 'owner') token = 'a'.repeat(64)
    if (kind === 'wrong-secret') token = prepareGrantToken(f.review.id).token
    if (kind === 'revoked') await f.owner.revokeGrant({ id: f.review.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' })
    if (kind === 'expired') vi.setSystemTime(expiresAt)
    if (kind === 'disallowed') token = (await f.reviewer(['reject'])).token
    f.journal.reads.splice(0)
    const count = f.journal.history.length
    await expect(f.owner.decideWithGrant(token, reviewRequest())).rejects.toHaveProperty('code', 'not-found')
    expect(f.journal.reads.some(key => key.startsWith('runs/'))).toBe(false); expect(f.journal.history).toHaveLength(count)
  })
  it.each(['revoked', 'expired', 'changed-run'] as const)('final writer guard refuses %s after action planning without a decision write', async kind => {
    const f = await reviewerFixture(), original = PostgresRunStore.prototype.save
    let changed = false
    vi.spyOn(PostgresRunStore.prototype, 'save').mockImplementation(async function(this: PostgresRunStore, value, guard) {
      if (!changed && (value as any).kind === 'approval-decided') {
        changed = true
        if (kind === 'revoked') await f.owner.revokeGrant({ id: f.review.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' })
        if (kind === 'expired') vi.setSystemTime(expiresAt)
        if (kind === 'changed-run') { const row = f.journal.rows.get(`runs/${f.run.id}`)!; row.version = String(BigInt(row.version) + 1n) }
      }
      return original.call(this, value, guard)
    })
    await expect(f.owner.decideWithGrant(f.review.token, reviewRequest())).rejects.toHaveProperty('code', 'conflict')
    expect(f.journal.history.filter(e => e.collection === 'runs' && e.kind === 'approval-decided')).toEqual([])
  })
  it('refuses expiry after a slow private replay, without disclosing or changing retained state', async () => {
    const f = await reviewerFixture(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
    const count = f.journal.history.length
    f.journal.hook = async collection => { if (collection === 'runs') { entered.resolve(); await gate.promise } }
    const pending = f.owner.decideWithGrant(f.review.token, reviewRequest()), rejected = expect(pending).rejects.toHaveProperty('code', 'not-found')
    try { await entered.promise; vi.setSystemTime(expiresAt) } finally { gate.resolve() }
    await rejected; expect(f.journal.history).toHaveLength(count)
  })
  it('recovers a double-simulated lost acknowledgment without another journal write or continuation', async () => {
    const f = await reviewerFixture(), selected = reviewRequest(); f.journal.failCommit = true
    await expect(f.owner.decideWithGrant(f.review.token, selected)).rejects.toHaveProperty('code', 'commit-uncertain')
    const count = f.journal.history.length
    expect((await f.owner.decideWithGrant(f.review.token, selected)).status).toBe('paused')
    expect(f.journal.history).toHaveLength(count)
  })
  it('keeps expired/revoked historical decisions inspectable without restoring delegated authority', async () => {
    const f = await reviewerFixture(), selected = reviewRequest(); await f.owner.decideWithGrant(f.review.token, selected)
    const before = await f.owner.show(f.run.id)
    await f.owner.revokeGrant({ id: f.review.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' })
    vi.setSystemTime(expiresAt)
    expect(await f.owner.show(f.run.id)).toEqual(before)
    await expect(f.owner.decideWithGrant(f.review.token, selected)).rejects.toHaveProperty('code', 'not-found')
    await f.owner.close()
    await expect(f.owner.decideWithGrant('', {} as never)).rejects.toHaveProperty('code', 'closed')
  })
  it.each(['scope', 'deadline', 'event', 'missing-grant', 'batch-request'] as const)('refuses %s retained attribution corruption without repairing or executing', async kind => {
    const f = await reviewerFixture(); await f.owner.decideWithGrant(f.review.token, reviewRequest())
    const row = f.journal.rows.get(`runs/${f.run.id}`)!, record = (row.value as any).record,
      event = f.journal.history.find(e => e.collection === 'runs' && e.kind === 'approval-decided'), decision = record.state.steps.find((s: any) => s.nodeId === 'review').inspection.approval
    if (kind === 'scope') decision.delegation.scope.decisions = ['approve']
    if (kind === 'deadline') decision.delegation.deadline = '2026-10-03T00:00:01.000Z'
    if (kind === 'batch-request') decision.delegation.requestId = randomUUID()
    event.data.data.decision = structuredClone(decision)
    if (kind === 'event') delete event.data.data.decision.delegation
    if (kind === 'missing-grant') f.journal.rows.delete(`access-grants/${f.review.id}`)
    const count = f.journal.history.length
    await expect(f.owner.show(f.run.id)).rejects.toHaveProperty('code', 'corrupt')
    expect(f.journal.history).toHaveLength(count)
  })
  it('refuses delegated decision request substitution at the checkpoint writer before any journal mutation', async () => {
    const f = await reviewerFixture(), original = PostgresRunStore.prototype.save, count = f.journal.history.length
    vi.spyOn(PostgresRunStore.prototype, 'save').mockImplementation(async function(this: PostgresRunStore, value, guard) {
      return original.call(this, { ...value, requestId: randomUUID() }, guard)
    })
    await expect(f.owner.decideWithGrant(f.review.token, reviewRequest())).rejects.toHaveProperty('code', 'corrupt')
    expect(f.journal.history).toHaveLength(count)
    expect((await f.owner.show(f.run.id)).state.status).toBe('waiting')
  })
  it.each(['missing', 'grant', 'run', 'version', 'time', 'deadline'] as const)('refuses a %s delegated decision admission condition before mutation', async kind => {
    const f = await reviewerFixture(), original = PostgresRunStore.prototype.save, count = f.journal.history.length
    vi.spyOn(PostgresRunStore.prototype, 'save').mockImplementation(async function(this: PostgresRunStore, value, guard) {
      const changed = structuredClone(guard)!
      if (kind === 'grant') changed.records = changed.records.filter(pin => pin.collection !== 'access-grants')
      if (kind === 'run') changed.records = changed.records.filter(pin => pin.collection !== 'runs')
      if (kind === 'version') changed.records.find(pin => pin.collection === 'runs')!.version = '999'
      if (kind === 'time') changed.notBefore = new Date(Date.parse(changed.notBefore!) - 1).toISOString()
      if (kind === 'deadline') changed.expiresAt = new Date(Date.parse(changed.expiresAt) + 1).toISOString()
      return original.call(this, value, kind === 'missing' ? undefined : changed)
    })
    await expect(f.owner.decideWithGrant(f.review.token, reviewRequest())).rejects.toHaveProperty('code', 'invalid-command')
    expect(f.journal.history).toHaveLength(count)
    expect((await f.owner.show(f.run.id)).state.status).toBe('waiting')
  })
})

/** Delegated admission boundaries: domain/journal/model doubles with an actual private OTLP receiver.
 * This does not qualify installed SDK bytes, PostgreSQL COMMITs, provider dispatch or a browser. */
async function delegatedPreliveReceiver(sampleRatio: number) {
  const packets: { route: string; bytes: Buffer }[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
    expect(['/v1/traces', '/v1/logs']).toContain(req.url)
    packets.push({ route: req.url!, bytes: Buffer.concat(chunks) })
    res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.end()
  })
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes) })
  const address = server.address(); if (!address || typeof address === 'string') throw Error('private listener missing')
  const config = { endpoint: `http://127.0.0.1:${address.port}/v1/traces`, logsEndpoint: `http://127.0.0.1:${address.port}/v1/logs`,
    authentication: { kind: 'none' as const }, sampleRatio, intervalMs: 60000, timeoutMs: 1000 }
  return { packets, config, async close() { await new Promise<void>(yes => { server.close(() => yes()); server.closeAllConnections() }) } }
}
const delegatedPreliveModes = ['start', 'step', 'continue', 'cancel', 'recover', 'review-approve', 'review-reject'] as const
const delegatedPreliveRows = [0, 1].flatMap(sampleRatio => delegatedPreliveModes.flatMap(mode =>
  (['hold', 'refuse', 'lose'] as const).map(fault => ({ sampleRatio, mode, fault }))))
const delegatedPreliveParent = '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01'
describe('delegated pre-live source admission boundaries (journal/model doubles, actual private OTLP)', () => {
  it.each(delegatedPreliveRows)('retains exact delegated admission without premature execution ($sampleRatio, $mode, $fault)', async ({ sampleRatio, mode, fault }) => {
    const review = mode.startsWith('review-'), f = await fixture(review ? approval : mode === 'recover' ? callerControlModelSource : echo)
    const wire = await delegatedPreliveReceiver(sampleRatio), telemetry = new RuntimeTelemetry(wire.config, () => undefined, { storage: 'postgres' })
    Reflect.set(f.owner, 'telemetry', telemetry)
    const models: ModelCalls = { admit: vi.fn(), verify: vi.fn(async () => undefined),
      execute: vi.fn(async () => ({ output: 'PRIVATE_PRELIVE_OUTPUT', usage: { tries: 1 } })),
      recover: vi.fn(async () => ({ output: 'PRIVATE_PRELIVE_OUTPUT', usage: { tries: 1 } })) }
    Reflect.set(f.owner, 'models', models)
    if (mode === 'recover') {
      // The independent retained-record reader also validates the mocked provider route/result.
      vi.spyOn(ConfiguredModels.prototype, 'admit').mockResolvedValue({} as never)
      vi.spyOn(ConfiguredModels.prototype, 'verify').mockResolvedValue(undefined)
    }
    const caller = await f.issue(['start', 'control', 'cancel']), id = randomUUID(), requestId = randomUUID()
    let token = caller.token, command: { requestId: string; action: 'approve' | 'reject'; pauseAfter: boolean } | undefined
    let control: { requestId: string; mode: 'step' | 'continue' | 'recover'; expectedCheckpointSha256: string } | undefined
    const rows = () => structuredClone({ records: [...f.journal.rows], events: f.journal.history, receipts: [...f.journal.receipts] })
    let beforeSteps = 0, beforeSegments = 0
    try {
      if (review) {
        const run = await f.owner.runRelease(f.release.snapshot, { message: 'PRIVATE_PRELIVE_REVIEW' }, { id })
        if (run.state.status !== 'waiting') throw Error('fixture reviewer wait missing')
        const prepared = prepareGrantToken(randomUUID())
        await f.owner.issueGrant({ id: prepared.id, tokenSha256: prepared.tokenSha256, expiresAt, actor: 'PRIVATE_PRELIVE_OWNER',
          scope: { kind: 'reviewer', runId: id, revision: run.revision, attemptId: run.state.attempt.id, decisions: ['approve', 'reject'] } })
        token = prepared.token; command = { requestId, action: mode === 'review-approve' ? 'approve' : 'reject', pauseAfter: false }
        beforeSteps = run.state.steps.length; beforeSegments = run.traceSegments?.length ?? 0
      } else if (mode !== 'start') {
        if (mode === 'recover') {
          const original = f.journal.commit.bind(f.journal)
          const setup = vi.spyOn(f.journal, 'commit').mockImplementation(async (batch, guard) => {
            if (batch.events.some(e => e.kind === 'node-result') && [...f.journal.rows.values()].some(r =>
              r.collection === 'runs' && (r.value as any).record?.state?.status === 'executing' && (r.value as any).record.state.next === 'write')) throw new JournalError('unavailable')
            return original(batch, guard)
          })
          try { await expect(f.owner.startWithGrant(token, 'PRIVATE_PRELIVE_INPUT', { id })).rejects.toHaveProperty('code', 'unavailable') }
          finally { setup.mockRestore() }
        } else await f.owner.startWithGrant(token, 'PRIVATE_PRELIVE_INPUT', { id, paused: true })
        const saved = await f.owner.show(id); beforeSteps = saved.state.steps.length; beforeSegments = saved.traceSegments?.length ?? 0
        if (mode === 'step' || mode === 'continue' || mode === 'recover') { const checkpoint = await f.owner.controlCheckpointWithGrant(token, id)
          control = { requestId, mode, expectedCheckpointSha256: checkpoint.checkpointSha256 } }
      }
      await f.owner.telemetryFlush()
      const baseline = rows(), firstPacket = wire.packets.length, gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
      const kind = review ? 'approval-decided' : mode === 'start' ? 'run-created' : mode === 'cancel' ? 'cancellation-requested' : 'execution-requested'
      const error = new JournalError(fault === 'refuse' ? 'unavailable' : 'commit-uncertain'), original = f.journal.commit.bind(f.journal)
      let matches = 0, terminal = false
      const spy = vi.spyOn(f.journal, 'commit').mockImplementation(async (batch, guard) => {
        if (!batch.events.some(e => e.collection === 'runs' && e.key === id && e.kind === kind)) return original(batch, guard)
        matches++; if (fault === 'refuse') throw error
        const result = await original(batch, guard)
        if (fault === 'lose') throw error
        entered.resolve(); await gate.promise; return result
      })
      const ownerRun = vi.spyOn(f.owner, 'run'), ownerAdvance = vi.spyOn(f.owner, 'advance'),
        ownerDecision = vi.spyOn(f.owner, 'decide'), ownerCancel = vi.spyOn(f.owner, 'cancel')
      const invoke = (owner = f.owner) => review ? owner.decideWithGrant(token, command!)
        : mode === 'start' ? owner.startWithGrant(token, 'PRIVATE_PRELIVE_INPUT', { id })
        : mode === 'cancel' ? owner.cancelWithGrant(token, id, { requestId }) : owner.advanceWithGrant(token, id, control!)
      const pending = f.owner.withTraceParent(delegatedPreliveParent, () => invoke()).then(value => { terminal = true; return { value, error: undefined } },
        caught => { terminal = true; return { value: undefined, error: caught } })
      const decoded = () => {
        const packets = wire.packets.slice(firstPacket)
        return { packets, spans: packets.filter(p => p.route === '/v1/traces').flatMap(p => traceRecords(p.bytes)),
          logs: packets.filter(p => p.route === '/v1/logs').flatMap(p => logRecords(p.bytes)) }
      }
      try {
        if (fault === 'hold') {
          await Promise.race([entered.promise, pending.then(() => { throw Error('Admission must be held before returning') })])
          expect(terminal).toBe(false); expect(matches).toBe(1)
          const committed = rows(), row = f.journal.rows.get('runs/' + id)!, record = (row.value as any).record
          expect(committed.events.at(-1)?.kind).toBe(kind)
          expect(record.state.steps).toHaveLength(beforeSteps + Number(mode === 'review-approve'))
          expect(record.traceSegments?.length ?? 0).toBe(beforeSegments + Number(review))
          for (let i = 0; i < 2; i++) {
            await f.owner.telemetryFlush(); expect(terminal).toBe(false); expect(rows()).toEqual(committed)
            const { packets, spans, logs } = decoded()
            expect(spans.filter(s => ['jevable.run', 'jevable.resume', 'jevable.approval', 'jevable.cancel', 'jevable.node', 'jevable.model'].includes(s.name))).toEqual([])
            expect(logs.filter(l => ['jevable.execution.segment.ended', 'jevable.node.attempt.ended', 'jevable.model.call.ended'].includes(l.event))).toEqual([])
            for (const packet of packets) expect(packet.bytes.includes(Buffer.from('PRIVATE_'))).toBe(false)
            expect(models.execute).toHaveBeenCalledTimes(mode === 'recover' ? 1 : 0)
            expect(models.recover).toHaveBeenCalledTimes(mode === 'recover' ? 1 : 0)
          }
        }
        gate.resolve(); const result = await pending; expect(matches).toBe(1)
        if (fault === 'hold') { expect(result.error).toBeUndefined(); expect(result.value?.status).toBe(
          mode === 'start' || mode === 'continue' || mode === 'review-approve' ? 'completed' : mode === 'cancel' ? 'cancelled' : mode === 'review-reject' ? 'failed' : 'paused') }
        else { expect(result.error).toBe(error); expect(result.value).toBeUndefined() }
        const retained = rows()
        if (fault === 'refuse') expect(retained).toEqual(baseline)
        else expect(retained.events.filter(e => e.collection === 'runs' && e.key === id && e.kind === kind)).toHaveLength(1)
        await f.owner.telemetryFlush()
        const { packets, spans, logs } = decoded(), segments = logs.filter(l => l.event === 'jevable.execution.segment.ended')
        expect(segments).toHaveLength(fault === 'hold' || review ? 1 : 0)
        expect(logs.filter(l => l.event === 'jevable.node.attempt.ended')).toHaveLength(fault === 'hold'
          ? mode === 'start' || mode === 'continue' ? 2 : mode === 'step' || mode === 'review-approve' ? 1 : 0 : 0)
        if (sampleRatio) for (const l of logs) expect(spans.some(s => s.traceId === l.traceId && s.spanId === l.spanId)).toBe(true)
        else expect(spans).toEqual([])
        for (const l of segments) {
          expect(l.traceId).toBe('1'.repeat(32)); expect(l.attributes['jevable.outcome']).toBe(
            fault === 'hold' ? result.value!.status : 'failed-or-uncertain')
          if (sampleRatio) expect(spans.find(s => s.spanId === l.spanId)?.parent).toBe('2'.repeat(16))
        }
        for (const packet of packets) expect(packet.bytes.includes(Buffer.from('PRIVATE_'))).toBe(false)
        expect(ownerRun).not.toHaveBeenCalled(); expect(ownerAdvance).not.toHaveBeenCalled(); expect(ownerDecision).not.toHaveBeenCalled(); expect(ownerCancel).not.toHaveBeenCalled()
        expect(models.execute).toHaveBeenCalledTimes(mode === 'recover' ? 1 : 0); expect(models.recover).toHaveBeenCalledTimes(mode === 'recover' ? 1 : 0)
        spy.mockRestore()
        if (fault !== 'refuse') {
          const count = wire.packets.length, receipt = await invoke(); expect(rows()).toEqual(retained)
          await f.owner.telemetryFlush(); expect(wire.packets).toHaveLength(count)
          // Explicit owner replacement observes the same domain-double rows; not real SQL recovery.
          await f.owner.close()
          const reopened = Reflect.construct(PostgresRuntime, [f.journal, 10000, 10000, 4_000_000, parseNotificationConfig({})]) as PostgresRuntime
          owners.push(reopened); Reflect.set(reopened, 'models', models)
          const diagnostics = new RuntimeTelemetry(wire.config, () => undefined, { storage: 'postgres' }); Reflect.set(reopened, 'telemetry', diagnostics)
          expect(await invoke(reopened)).toEqual(receipt); expect(rows()).toEqual(retained)
          await reopened.telemetryFlush(); expect(wire.packets).toHaveLength(count); await reopened.close()
          expect(models.execute).toHaveBeenCalledTimes(mode === 'recover' ? 1 : 0); expect(models.recover).toHaveBeenCalledTimes(mode === 'recover' ? 1 : 0)
        }
      } finally { gate.resolve(); await pending; spy.mockRestore() }
    } finally { await f.owner.close(); await wire.close() }
  })
  it('preserves every previous caller/reviewer domain case and assertion', async () => {
    const before = await readFile(new URL('../qualification/runner-snapshots/delegated-prelive/postgres-caller.spec.ts.before-delegated-prelive.txt', import.meta.url), 'utf8')
    const after = await readFile(new URL('./postgres-caller.spec.ts', import.meta.url), 'utf8'), boundary = after.indexOf('/** Delegated admission boundaries:')
    expect(boundary).toBeGreaterThan(0)
    expect(after.slice(0, boundary).replace(
      "import { createServer } from 'node:http'\nimport type { ModelCalls } from '../src/runtime/model-port.ts'\nimport { traceRecords } from '../scripts/check-postgres-telemetry.mjs'\nimport { logRecords } from '../scripts/check-telemetry-package.mjs'\n", '')).toBe(before + '\n')
  })
})

describe('PostgreSQL approval/cancellation optimistic conflict (journal double, not actual SQL)', () => {
  it.each([false, true])('finishes a retained cancellation that wins while an approval decision is committing (telemetry=%s)', async telemetry => {
    const f = await fixture(approval)
    const waiting = await f.owner.run(approval, { message: 'PRIVATE_SYNTHETIC_REVIEW' })
    expect(waiting.state.status).toBe('waiting')
    if (waiting.state.status !== 'waiting') throw Error('missing approval')
    if (telemetry) Reflect.set(f.owner, 'telemetry', new RuntimeTelemetry({ endpoint: 'http://127.0.0.1:9/v1/traces',
      authentication: { kind: 'none' }, sampleRatio: 0 }, async () => undefined))
    const requestId = randomUUID(), originalCursor = Reflect.get(f.owner, 'cursor').bind(f.owner)
    let armed = true, requestReceipt: Awaited<ReturnType<PostgresRuntime['cancel']>> | undefined
    vi.spyOn(f.owner as any, 'cursor').mockImplementation(async (...args: unknown[]) => {
      const id = args[0]
      if (typeof id !== 'string') throw Error('missing run identity')
      const cursor = await originalCursor(id)
      const originalLoad = cursor.load.bind(cursor)
      cursor.load = async () => {
        const record = await originalLoad()
        if (armed) {
          armed = false
          requestReceipt = await f.owner.cancel(waiting.id, requestId, 'synthetic-operator-b')
          expect(requestReceipt.state.status).toBe('waiting')
          expect(requestReceipt.cancellation?.id).toBe(requestId)
        }
        return record
      }
      return cursor
    })
    const decided = await f.owner.decide(waiting.id, waiting.state.attempt.id, 'approve', 'synthetic-reviewer-a')
    expect(armed).toBe(false)
    expect(decided.state.status).toBe('cancelled')
    expect(await f.owner.show(waiting.id)).toEqual(decided)
    const events = await f.owner.events(waiting.id)
    expect(events.filter(event => event.kind === 'cancellation-requested')).toHaveLength(1)
    expect(events.filter(event => event.kind === 'run-cancelled')).toHaveLength(1)
    expect(events.filter(event => event.kind === 'approval-decided')).toHaveLength(0)
    expect(events.filter(event => event.kind === 'execution-segment')).toHaveLength(telemetry ? 1 : 0)
    expect(await f.owner.cancel(waiting.id, requestId, 'synthetic-operator-b')).toEqual(decided)
    expect(await f.owner.events(waiting.id)).toEqual(events)
  })

  it.each([false, true])('settles a cancellation that wins the delegated reviewer commit without returning private run data (telemetry=%s)', async telemetry => {
    const f = await reviewerFixture(telemetry)
    const request = reviewRequest('approve', false), cancellationId = randomUUID()
    const original = PostgresRunStore.prototype.save
    let injected = false
    vi.spyOn(PostgresRunStore.prototype, 'save').mockImplementation(async function(this: PostgresRunStore, command, guard) {
      if (!injected && (command as any).kind === 'approval-decided') {
        injected = true
        const admitted = await f.owner.cancel(f.run.id, cancellationId, 'synthetic-operator-b')
        expect(admitted.state.status).toBe('waiting')
        expect(admitted.cancellation?.id).toBe(cancellationId)
      }
      return original.call(this, command, guard)
    })
    await expect(f.owner.decideWithGrant(f.review.token, request)).rejects.toHaveProperty('code', 'conflict')
    expect(injected).toBe(true)
    const final = await f.owner.show(f.run.id), events = await f.owner.events(f.run.id)
    expect(final.state.status).toBe('cancelled')
    expect(events.filter(event => event.kind === 'cancellation-requested')).toHaveLength(1)
    expect(events.filter(event => event.kind === 'run-cancelled')).toHaveLength(1)
    expect(events.filter(event => event.kind === 'approval-decided')).toHaveLength(0)
    expect(await f.owner.cancel(f.run.id, cancellationId, 'synthetic-operator-b')).toEqual(final)
    expect(await f.owner.events(f.run.id)).toEqual(events)
  })

  it('commits only one expired approval when two owner decisions start at the deadline', async () => {
    const f = await fixture(approval)
    const waiting = await f.owner.run(approval, { message: 'PRIVATE_SYNTHETIC_REVIEW' })
    expect(waiting.state.status).toBe('waiting')
    if (waiting.state.status !== 'waiting') throw Error('missing approval')
    vi.setSystemTime(new Date(waiting.state.expiresAt))
    const outcomes = await Promise.allSettled([
      f.owner.decide(waiting.id, waiting.state.attempt.id, 'approve', 'synthetic-reviewer-a'),
      f.owner.decide(waiting.id, waiting.state.attempt.id, 'reject', 'synthetic-reviewer-b'),
    ])
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1)
    const final = await f.owner.show(waiting.id), events = await f.owner.events(waiting.id)
    expect(final.state).toMatchObject({ status: 'failed', code: 'approval-expired' })
    expect(events.filter(event => event.kind === 'approval-decided')).toMatchObject([{ data: { decision: { kind: 'expired' } } }])
    expect(events.filter(event => event.kind === 'run-cancelled')).toHaveLength(0)
    await expect(f.owner.cancel(waiting.id, randomUUID(), 'synthetic-operator-b')).rejects.toHaveProperty('code', 'conflict')
    expect(await f.owner.events(waiting.id)).toEqual(events)
  })

  it('guards an owner expiry-only closure before any PostgreSQL journal write (domain double)', async () => {
    const f = await fixture(approval)
    const waiting = await f.owner.run(approval, { message: 'PRIVATE_SYNTHETIC_REVIEW' })
    if (waiting.state.status !== 'waiting') throw Error('missing approval')
    const before = await f.owner.events(waiting.id)
    await expect(f.owner.decide(waiting.id, waiting.state.attempt.id, 'approve', 'synthetic-reviewer', { expireOnly: true }))
      .rejects.toHaveProperty('code', 'conflict')
    expect((await f.owner.show(waiting.id)).state.status).toBe('waiting')
    expect(await f.owner.events(waiting.id)).toEqual(before)
    vi.setSystemTime(new Date(waiting.state.expiresAt))
    const closed = await f.owner.decide(waiting.id, waiting.state.attempt.id, 'approve', 'synthetic-reviewer', { expireOnly: true })
    expect(closed.state).toMatchObject({ status: 'failed', code: 'approval-expired' })
    expect(closed.state.steps.map(step => step.nodeId)).toEqual(['start'])
    expect((await f.owner.events(waiting.id)).filter(event => event.kind === 'approval-decided')).toHaveLength(1)
  })

  it('finishes cancellation ahead of an expired owner approval without writing both outcomes', async () => {
    const f = await fixture(approval)
    const waiting = await f.owner.run(approval, { message: 'PRIVATE_SYNTHETIC_REVIEW' })
    expect(waiting.state.status).toBe('waiting')
    if (waiting.state.status !== 'waiting') throw Error('missing approval')
    vi.setSystemTime(new Date(waiting.state.expiresAt))
    const requestId = randomUUID(), original = Reflect.get(f.owner, 'cursor').bind(f.owner)
    let injected = false
    vi.spyOn(f.owner as any, 'cursor').mockImplementation(async (...args: unknown[]) => {
      const id = args[0]
      if (typeof id !== 'string') throw Error('missing run identity')
      const cursor = await original(id), load = cursor.load.bind(cursor)
      cursor.load = async () => {
        const record = await load()
        if (!injected) {
          injected = true
          const admitted = await f.owner.cancel(waiting.id, requestId, 'synthetic-operator-b')
          expect(admitted.cancellation?.id).toBe(requestId)
        }
        return record
      }
      return cursor
    })
    const decided = await f.owner.decide(waiting.id, waiting.state.attempt.id, 'approve', 'synthetic-reviewer-a')
    expect(injected).toBe(true)
    expect(decided.state.status).toBe('cancelled')
    const events = await f.owner.events(waiting.id)
    expect(events.filter(event => event.kind === 'approval-decided')).toHaveLength(0)
    expect(events.filter(event => event.kind === 'cancellation-requested')).toHaveLength(1)
    expect(events.filter(event => event.kind === 'run-cancelled')).toHaveLength(1)
    expect(await f.owner.cancel(waiting.id, requestId, 'synthetic-operator-b')).toEqual(decided)
    expect(await f.owner.events(waiting.id)).toEqual(events)
  })
})

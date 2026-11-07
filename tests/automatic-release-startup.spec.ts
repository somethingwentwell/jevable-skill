import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID, createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalRuntime } from '../src/runtime/local.ts'
import { PostgresRuntime } from '../src/runtime/postgres.ts'
import { PostgresJournal, JournalError, type JournalBatch, type JournalCollection } from '../src/storage/postgres.ts'
import { journalConditionHash } from '../src/storage/conditions.ts'
import { WorkflowRuntimeError } from '../src/runtime/errors.ts'
import { inspectRelease, type Release } from '../src/releases/snapshot.ts'
import { compileWorkflowYaml } from '../src/workflow/index.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { reviewAutomaticApprovalPolicy } from '../src/notifications/automatic-policy.ts'
import { notificationSha256 } from '../src/notifications/schema.ts'
import { parseNotificationConfig } from '../src/notifications/config.ts'
import { prepareAutomaticStartupRelease, automaticStartupReleaseRead } from '../src/notifications/automatic-startup.ts'
import { startRuntimeService } from '../src/http/service.ts'
import { startPostgresRuntimeService } from '../src/http/postgres.ts'
import { ReleaseClient } from '../src/releases/client.ts'
import { releaseMain } from '../src/releases/entry.ts'

const yaml = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const graph = compileWorkflowYaml(yaml, DEFAULT_COMPILER_LIMITS)
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
function release(): Release {
  return inspectRelease({ format: 'jevable.ai/release', schemaVersion: 1, id: randomUUID(), version: '1.0.0',
    createdAt: new Date().toISOString(), createdBy: 'PRIVATE_CREATOR', project: { id: randomUUID(), generation: 1 },
    workflow: { yaml: graph.source.yaml, revision: graph.source.revision }, runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
}
function configuration(selected: Release, url = 'http://127.0.0.1:9/unused', scope: unknown = {
  kind: 'release', id: selected.snapshot.id, sha256: selected.sha256, revision: selected.snapshot.workflow.revision,
}) {
  const endpoint = { id: 'review', url, credentialRef: 'review/key', timeoutMs: 1000 }
  const reviewed = reviewAutomaticApprovalPolicy({ format: 'jevable.ai/automatic-approval-policy/v1', routes: [{
    scope, endpointId: endpoint.id, endpointSha256: notificationSha256(endpoint), eventKinds: ['requested', 'decided'],
  }] })
  return parseNotificationConfig({ endpoints: [endpoint], maxInFlight: 1, automatic: {
    policy: reviewed.policy, reviewedPolicySha256: reviewed.policySha256, maxPending: 1, maxAdmissions: 100, maxEvents: 200,
  } })
}
async function directory() { return mkdtemp(join(tmpdir(), 'jevable-auto-release-startup-')) }
async function receiver() {
  const key = 'whsec_' + randomBytes(32).toString('base64'), received: any[] = []
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString(), signature = 'v1,' + createHmac('sha256', Buffer.from(key.slice(6), 'base64'))
      .update(`${request.headers['webhook-id']}.${request.headers['webhook-timestamp']}.${body}`).digest('base64')
    expect(request.headers['webhook-signature']).toBe(signature)
    received.push(JSON.parse(body)); response.writeHead(202); response.end()
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('fixture port')
  return { key, received, url: `http://127.0.0.1:${address.port}/approval` }
}
async function provision(dataDirectory: string, key: string) {
  const owner = await LocalRuntime.open({ dataDirectory })
  try { await owner.setCredential('review/key', key, 0, 'fixture'); expect(owner.releases()).toEqual([]) }
  finally { await owner.close() }
}

/** Source factory/domain/CAS double only, not actual SQL transactions, leases or delivery qualification. */
class JournalDouble {
  readonly controller = new AbortController()
  get signal() { return this.controller.signal }
  readonly rows = new Map<string, { collection: JournalCollection; key: string; version: string; deleted: boolean; value: unknown }>()
  readonly history: (JournalBatch['events'][number] & { sequence: string; batchId: string; at: string; epoch: string })[] = []
  readonly receipts = new Map<string, unknown>()
  close = vi.fn(async () => {})
  private key(collection: string, key: string) { return JSON.stringify([collection, key]) }
  put(collection: JournalCollection, key: string, value: unknown, version = '1') { this.rows.set(this.key(collection, key), { collection, key, value: structuredClone(value), version, deleted: false }) }
  async get(collection: JournalCollection, key: string) { return structuredClone(this.rows.get(this.key(collection, key))) }
  async exists(collection: JournalCollection, key: string) { return this.rows.has(this.key(collection, key)) }
  async count(collection: JournalCollection) { return [...this.rows.values()].filter(row => row.collection === collection && !row.deleted).length }
  async records(collection: JournalCollection, limit: number) {
    const page = await this.page(collection, undefined, limit)
    if (page.nextCursor) throw new JournalError('limit')
    return page.records
  }
  async page(collection: JournalCollection, after?: string, limit = 100) {
    const rows = [...this.rows.values()].filter(row => row.collection === collection && !row.deleted && (!after || row.key > after)).sort((a, b) => a.key < b.key ? -1 : 1)
    return { records: structuredClone(rows.slice(0, limit)), nextCursor: rows.length > limit ? rows[limit - 1]!.key : null }
  }
  async events(after: string, limit: number, collections: JournalCollection[], key?: string) {
    const events = this.history.filter(event => BigInt(event.sequence) > BigInt(after) && collections.includes(event.collection) && (!key || event.key === key)).slice(0, limit)
    return { events: structuredClone(events), cursor: events.at(-1)?.sequence ?? after }
  }
  async receipt(id: string) { return structuredClone(this.receipts.get(id)) }
  async commit(batch: JournalBatch) {
    this.signal.throwIfAborted()
    if (this.receipts.has(batch.id)) return structuredClone(this.receipts.get(batch.id))
    for (const change of batch.changes) if ((this.rows.get(this.key(change.collection, change.key))?.version ?? '0') !== change.expectedVersion) throw new JournalError('conflict')
    const changes = [], eventSequences = []
    for (const change of batch.changes) {
      if (change.operation !== 'put') throw new Error('fixture puts only')
      const version = String(BigInt(change.expectedVersion) + 1n)
      this.put(change.collection, change.key, change.value, version); changes.push({ collection: change.collection, key: change.key, version, deleted: false })
    }
    for (const event of batch.events) {
      const sequence = String(this.history.length + 1); eventSequences.push(sequence)
      this.history.push({ ...structuredClone(event), sequence, batchId: batch.id, at: new Date().toISOString(), epoch: '1' })
    }
    const receipt = { id: batch.id, requestSha256: journalConditionHash(batch), ownerId: randomUUID(), epoch: '1', recordedAt: new Date().toISOString(), changes, eventSequences }
    this.receipts.set(batch.id, receipt); return structuredClone(receipt)
  }
}


describe('reviewed exact-release startup candidate', () => {
  it('clones a structurally verified release and never treats it as local approval or execution proof', () => {
    const selected = release(), config = configuration(selected), candidate = prepareAutomaticStartupRelease(selected, config.automatic)!
    expect(candidate).toEqual(selected); expect(candidate).not.toBe(selected)
    selected.snapshot.createdBy = 'changed'; expect(candidate.snapshot.createdBy).toBe('PRIVATE_CREATOR')
  })
  it.each(['project', 'foreign-id', 'checksum', 'revision'] as const)('refuses %s routes before ownership', async change => {
    const selected = release(), scope: any = { kind: 'release', id: selected.snapshot.id, sha256: selected.sha256, revision: selected.snapshot.workflow.revision }
    if (change === 'project') { scope.kind = 'project'; scope.generation = 1; delete scope.sha256 }
    if (change === 'foreign-id') scope.id = randomUUID()
    if (change === 'checksum') scope.sha256 = 'b'.repeat(64)
    if (change === 'revision') scope.revision = 'c'.repeat(64)
    const notifications = configuration(selected, undefined, scope), dataDirectory = join(await directory(), 'unopened')
    const open = vi.spyOn(PostgresJournal, 'open')
    await expect(LocalRuntime.open({ dataDirectory, startupRelease: selected, notifications })).rejects.toHaveProperty('code', 'conflict')
    await expect(PostgresRuntime.open({ database: {} as never, startupRelease: selected, notifications })).rejects.toHaveProperty('code', 'conflict')
    expect(open).not.toHaveBeenCalled(); await expect(stat(dataDirectory)).rejects.toHaveProperty('code', 'ENOENT')
  })
  it.each([null, {}, { snapshot: {} }, { snapshot: {}, sha256: 'a'.repeat(64), actor: 'spoof' }])('refuses malformed startup pins without ownership', async value => {
    const selected = release(), dataDirectory = join(await directory(), 'unopened')
    await expect(LocalRuntime.open({ dataDirectory, startupRelease: value as never, notifications: configuration(selected) }))
      .rejects.toHaveProperty('code', 'invalid-command')
    await expect(stat(dataDirectory)).rejects.toHaveProperty('code', 'ENOENT')
  })
  it('refuses unchecked wrappers and startup import without reviewed opt-in', async () => {
    const selected = release(), dataDirectory = join(await directory(), 'unopened')
    await expect(LocalRuntime.open({ dataDirectory, startupRelease: selected })).rejects.toHaveProperty('code', 'invalid-command')
    await expect(LocalRuntime.open({ dataDirectory, startupRelease: { ...selected, sha256: 'b'.repeat(64) }, notifications: configuration(selected) }))
      .rejects.toHaveProperty('code', 'conflict')
    await expect(stat(dataDirectory)).rejects.toHaveProperty('code', 'ENOENT')
  })
  it('never replaces existing checked state or masks corruption/uncertain storage errors', async () => {
    const selected = release(), existing = release()
    expect(await automaticStartupReleaseRead(selected.snapshot.id, () => existing, selected)).toBe(existing)
    expect(await automaticStartupReleaseRead(selected.snapshot.id, () => { throw new WorkflowRuntimeError('not-found') }, selected)).toBe(selected)
    for (const code of ['corrupt', 'conflict', 'busy', 'closed'] as const) {
      await expect(automaticStartupReleaseRead(selected.snapshot.id, () => { throw new WorkflowRuntimeError(code) }, selected)).rejects.toHaveProperty('code', code)
    }
    await expect(automaticStartupReleaseRead(randomUUID(), () => { throw new WorkflowRuntimeError('not-found') }, selected)).rejects.toHaveProperty('code', 'not-found')
  })
})

describe('fresh source SQLite release bootstrap', () => {
  it('retains only the immutable release before attachment, sends only after a new commit and never replays on restart', async () => {
    const sink = await receiver(), selected = release(), dataDirectory = await directory(), notifications = configuration(selected, sink.url)
    await provision(dataDirectory, sink.key)
    const runtime = await LocalRuntime.open({ dataDirectory, startupRelease: selected, notifications }); cleanup.push(() => runtime.close())
    expect(runtime.releases()).toEqual([selected]); expect(runtime.projects()).toEqual([]); expect(runtime.list()).toEqual([])
    expect((await runtime.automaticApprovalAdmissions()).records).toEqual([])
    expect(sink.received).toEqual([])
    const run = await runtime.runRelease(selected.snapshot, { message: 'PRIVATE_INPUT' })
    expect(run.state.status).toBe('waiting'); await runtime.close()
    expect(sink.received).toHaveLength(1); expect(sink.received[0].data.release).toEqual({ id: selected.snapshot.id, sha256: selected.sha256 })
    expect(JSON.stringify(sink.received)).not.toContain('PRIVATE_')
    const reopened = await LocalRuntime.open({ dataDirectory, startupRelease: selected, notifications }); cleanup.push(() => reopened.close())
    expect(await reopened.runRelease(selected.snapshot, { message: 'PRIVATE_INPUT' }, { id: run.id })).toEqual(run)
    expect((await reopened.automaticApprovalAdmissions()).records).toHaveLength(1)
    await reopened.close(); expect(sink.received).toHaveLength(1)
  })
  it('does not persist the release when exporter credential readiness refuses', async () => {
    const selected = release(), dataDirectory = await directory()
    await expect(LocalRuntime.open({ dataDirectory, startupRelease: selected, notifications: configuration(selected), telemetry: {
      endpoint: 'http://127.0.0.1:9/v1/traces', authentication: { kind: 'bearer', credentialRef: 'missing/key' },
    } })).rejects.toHaveProperty('code', 'invalid-command')
    const owner = await LocalRuntime.open({ dataDirectory }); cleanup.push(() => owner.close())
    expect(owner.releases()).toEqual([]); expect(owner.list()).toEqual([])
  })
  it('refuses a conflicting stored release without replacement or notification', async () => {
    const selected = release(), dataDirectory = await directory(), owner = await LocalRuntime.open({ dataDirectory,
      startupRelease: selected, notifications: configuration(selected) }); await owner.close()
    const changed = inspectRelease({ ...selected.snapshot, createdBy: 'substitution' })
    await expect(LocalRuntime.open({ dataDirectory, startupRelease: changed, notifications: configuration(changed) })).rejects.toHaveProperty('code', 'conflict')
    const read = await LocalRuntime.open({ dataDirectory }); cleanup.push(() => read.close())
    expect(read.releases()).toEqual([selected]); expect(read.list()).toEqual([])
  })
  it('the actual exact-release source HTTP service bootstraps fresh state and advertises configured delivery honestly', async () => {
    const sink = await receiver(), selected = release(), dataDirectory = await directory(), notifications = configuration(selected, sink.url)
    await provision(dataDirectory, sink.key)
    const token = randomBytes(32).toString('hex')
    const start = () => startRuntimeService({ runtime: { dataDirectory, notifications }, release: { snapshot: selected.snapshot }, token, actor: 'fixture' })
    const service = await start(); cleanup.push(() => service.close())
    const client = new ReleaseClient(service.url, token, selected.sha256)
    expect((await client.capabilities() as any).approvalNotifications).toMatchObject({ automaticDelivery: true, delivery: 'explicit-and-reviewed-automatic' })
    expect((await client.operation({ operation: 'runs.list' }) as any).result.runs).toEqual([]); expect(sink.received).toEqual([])
    const id = randomUUID(), command = { operation: 'runs.start' as const, id, input: { message: 'PRIVATE_HTTP' } }
    const run = (await client.operation(command) as any).result; expect(run.status).toBe('waiting')
    await service.close(); expect(sink.received).toHaveLength(1)
    const replacement = await start(); cleanup.push(() => replacement.close())
    const other = new ReleaseClient(replacement.url, token, selected.sha256)
    expect((await other.operation(command) as any).result).toEqual(run)
    await replacement.close(); expect(sink.received).toHaveLength(1)
  })
  it.each(['sqlite', 'postgres'] as const)('%s service rejects foreign automatic scope before acquiring a database', async storage => {
    const selected = release(), foreign = release(), dataDirectory = join(await directory(), 'unopened')
    const open = vi.spyOn(PostgresJournal, 'open')
    const options = { token: randomBytes(32).toString('hex'), actor: 'fixture', release: { snapshot: selected.snapshot } }
    const work = storage === 'sqlite' ? startRuntimeService({ ...options, runtime: { dataDirectory, notifications: configuration(foreign) } })
      : startPostgresRuntimeService({ ...options, runtime: { database: {} as never, notifications: configuration(foreign) } })
    await expect(work).rejects.toHaveProperty('code', 'conflict'); expect(open).not.toHaveBeenCalled()
    await expect(stat(dataDirectory)).rejects.toHaveProperty('code', 'ENOENT')
  })
  it('the actual source release entry imports its reviewed snapshot before the run and drains delivery', async () => {
    const sink = await receiver(), selected = release(), dataDirectory = await directory(), notifications = configuration(selected, sink.url)
    await provision(dataDirectory, sink.key)
    const files = await directory(), input = join(files, 'input.json'), config = join(files, 'notifications.json')
    await writeFile(input, JSON.stringify({ message: 'PRIVATE_ENTRY' })); await writeFile(config, JSON.stringify(notifications), { mode: 0o600 })
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((_value: any, encodingOrDone?: any, done?: any) => {
      const callback = typeof encodingOrDone === 'function' ? encodingOrDone : done
      if (callback) queueMicrotask(() => callback(null))
      return true
    })
    const code = await releaseMain(selected.snapshot, ['run', '--id', randomUUID(), '--input', input, '--data-dir', dataDirectory, '--notifications-file', config], files)
    stdout.mockRestore(); expect(code).toBe(3); expect(sink.received).toHaveLength(1)
    const owner = await LocalRuntime.open({ dataDirectory }); cleanup.push(() => owner.close())
    expect(owner.releases()).toEqual([selected]); expect(owner.projects()).toEqual([])
    expect(owner.list()).toHaveLength(1); expect(owner.list()[0]!.status).toBe('waiting')
  })
})

describe('source PostgreSQL factory bootstrap with disclosed CAS double', () => {
  it('imports before automatic attachment, preserves exact release pins and never replays after replacement', async () => {
    const sink = await receiver(), selected = release(), journal = new JournalDouble(), notifications = configuration(selected, sink.url)
    vi.spyOn(PostgresJournal, 'open').mockResolvedValue(journal as never)
    const seed = await PostgresRuntime.open({ database: {} as never })
    await seed.setCredential('review/key', sink.key, 0, 'fixture'); await seed.close()
    expect(await journal.count('releases')).toBe(0)
    const runtime = await PostgresRuntime.open({ database: {} as never, startupRelease: selected, notifications })
    cleanup.push(() => runtime.close())
    expect((await runtime.releases()).releases).toEqual([selected]); expect(await runtime.projects()).toEqual([])
    expect(sink.received).toEqual([])
    const imported = journal.history.filter(event => event.collection === 'releases')
    expect(imported).toHaveLength(1); expect(imported[0]!.kind).toBe('release-imported')
    const run = await runtime.runRelease(selected.snapshot, { message: 'PRIVATE_PG_DOUBLE' })
    await runtime.close(); expect(run.state.status).toBe('waiting'); expect(sink.received).toHaveLength(1)
    const before = structuredClone(journal.history), replacement = await PostgresRuntime.open({ database: {} as never, startupRelease: selected, notifications })
    cleanup.push(() => replacement.close())
    expect(await replacement.runRelease(selected.snapshot, { message: 'PRIVATE_PG_DOUBLE' }, { id: run.id })).toEqual(run)
    await replacement.close(); expect(journal.history).toEqual(before); expect(sink.received).toHaveLength(1)
  })
})

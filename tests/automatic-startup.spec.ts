import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { LocalRuntime, reviewAutomaticApprovalPolicy, type NotificationRuntimeConfig } from '../src/runtime/index.ts'
import { PostgresRuntime } from '../src/runtime/postgres.ts'
import { PostgresJournal, JournalError, type JournalBatch, type JournalCollection } from '../src/storage/postgres.ts'
import { notificationSha256 } from '../src/notifications/schema.ts'
import { parseNotificationConfig } from '../src/notifications/config.ts'
import { journalConditionHash } from '../src/storage/conditions.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { showSchema } from '../src/contracts.ts'

const yaml = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close() })
const endpoint = (url = 'http://127.0.0.1:9/unused') => ({ id: 'review', url, credentialRef: 'notification/key', timeoutMs: 1000 })
function configuration(scope: unknown, url?: string): NotificationRuntimeConfig {
  const ep = endpoint(url), review = reviewAutomaticApprovalPolicy({ format: 'jevable.ai/automatic-approval-policy/v1',
    routes: [{ scope, endpointId: ep.id, endpointSha256: notificationSha256(ep), eventKinds: ['requested', 'decided', 'expired', 'cancelled'] }] })
  return { endpoints: [ep], maxInFlight: 1, automatic: { policy: review.policy, reviewedPolicySha256: review.policySha256,
    maxPending: 1, maxAdmissions: 100, maxEvents: 200 } }
}
function mutable(value: NotificationRuntimeConfig) { return structuredClone(value) as any }
function rereview(value: any) { value.automatic.reviewedPolicySha256 = reviewAutomaticApprovalPolicy(value.automatic.policy).policySha256 }
async function sink() {
  const bodies: string[] = [], server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    bodies.push(Buffer.concat(chunks).toString('utf8')); res.writeHead(202); res.end()
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture port')
  return { bodies, url: `http://127.0.0.1:${address.port}/approval` }
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

async function seed(backend: 'sqlite' | 'postgres-double', url?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-automatic-startup-')), journal = new JournalDouble()
  const owner = backend === 'sqlite'
    ? await LocalRuntime.open({ dataDirectory: directory, notifications: { endpoints: [endpoint(url)] } })
    : Reflect.construct(PostgresRuntime, [journal, 10000, 10000, 4_000_000, parseNotificationConfig({ endpoints: [endpoint(url)] })]) as PostgresRuntime
  cleanups.push(() => owner.close())
  const project = await owner.editProject({ operation: 'create', title: 'Startup review', yaml, actor: 'PRIVATE_OWNER' })
  await owner.setCredential('notification/key', 'whsec_' + randomBytes(32).toString('base64'), 0, 'PRIVATE_OWNER')
  const release = await owner.createRelease({ projectId: project.id, expectedGeneration: project.generation,
    revision: project.acceptedRevision, version: '1.0.0', actor: 'PRIVATE_OWNER', runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
  const scope = { kind: 'project', id: project.id, generation: project.generation, revision: project.acceptedRevision }
  const config = configuration(scope, url)
  const open = async (notifications: NotificationRuntimeConfig | null = config) => {
    if (backend === 'postgres-double') vi.spyOn(PostgresJournal, 'open').mockResolvedValue(journal as never)
    const runtime = backend === 'sqlite' ? await LocalRuntime.open({ dataDirectory: directory, ...(notifications ? { notifications } : {}) })
      : await PostgresRuntime.open({ database: {} as never, ...(notifications ? { notifications } : {}) })
    cleanups.push(() => runtime.close()); return runtime
  }
  const start = (runtime: LocalRuntime | PostgresRuntime, id = randomUUID()) => runtime.runProject(project.id, project.generation,
    project.acceptedRevision, { message: 'PRIVATE_REVIEW_VALUE' }, { id })
  return { owner, directory, journal, project, release, config, open, start }
}

describe('source automatic startup configuration and read-only owner diagnostics', () => {
  const scope = { kind: 'project', id: randomUUID(), generation: 1, revision: 'a'.repeat(64) }
  it('default omission preserves the exact old configuration and does not infer an automatic policy', () => {
    expect(parseNotificationConfig({})).toEqual({ endpoints: [], maxInFlight: 16, maxDeliveries: 10000, maxEvents: 20000 })
  })
  it('review helper is canonical, detached, metadata-only and explicit about unverified scopes', () => {
    const original = mutable(configuration(scope)).automatic.policy
    const a = reviewAutomaticApprovalPolicy(original)
    original.routes[0].eventKinds.reverse()
    const b = reviewAutomaticApprovalPolicy(original)
    expect(a).toEqual(b); expect(a).toMatchObject({ scopeVerification: 'not-performed', dispatch: 'not-attempted' })
    original.routes[0].scope.id = randomUUID()
    expect(a.policy.routes[0]!.scope.id).toBe(scope.id)
  })
  const mutations: [string, (value: any) => void][] = [
    ['missing review checksum', value => { delete value.automatic.reviewedPolicySha256 }],
    ['changed review checksum', value => { value.automatic.reviewedPolicySha256 = '0'.repeat(64) }],
    ['malformed review checksum', value => { value.automatic.reviewedPolicySha256 = 'A'.repeat(64) }],
    ['changed destination URL', value => { value.endpoints[0].url = 'http://127.0.0.1:8/changed' }],
    ['changed credential reference', value => { value.endpoints[0].credentialRef = 'notification/changed' }],
    ['changed destination timeout', value => { value.endpoints[0].timeoutMs = 2000 }],
    ['missing destination', value => { value.endpoints = [] }],
    ['unknown automatic key', value => { value.automatic.replay = true }],
    ['actor override', value => { value.automatic.actor = 'PRIVATE_OVERRIDE' }],
    ['empty routes', value => { value.automatic.policy.routes = [] }],
    ['duplicate route', value => { value.automatic.policy.routes.push(structuredClone(value.automatic.policy.routes[0])) }],
    ['duplicate kind', value => { value.automatic.policy.routes[0].eventKinds.push('requested') }],
    ['wildcard scope', value => { value.automatic.policy.routes[0].scope = { kind: 'all' } }],
    ['over in-flight bound', value => { value.automatic.maxPending = 2 }],
    ['zero pending bound', value => { value.automatic.maxPending = 0 }],
    ['fractional pending bound', value => { value.automatic.maxPending = 1.5 }],
    ['over pending bound', value => { value.maxInFlight = 64; value.automatic.maxPending = 65 }],
    ['zero admission bound', value => { value.automatic.maxAdmissions = 0 }],
    ['insufficient audit capacity', value => { value.automatic.maxEvents = 199 }],
  ]
  it.each(mutations)('rejects %s before owner creation or effects', (_name, mutate) => {
    const config = mutable(configuration(scope)); mutate(config)
    expect(() => parseNotificationConfig(config)).toThrow('invalid-command')
  })
  it('structural discovery includes the policy shape but cannot prove review, scope existence or delivery authority', () => {
    const schema = showSchema('notification-config')
    expect(JSON.stringify(schema)).toContain('reviewedPolicySha256')
    expect(JSON.stringify(schema)).toContain('endpointSha256')
  })

  for (const backend of ['sqlite', 'postgres-double'] as const) {
    it(`${backend}: public source startup selects new commits only, diagnostics are detached and configuration-free reopen never sends`, async () => {
      const receiver = await sink(), f = await seed(backend, receiver.url)
      const historical = await f.start(f.owner)
      await f.owner.close()
      const config = mutable(f.config), runtime = await f.open(config)
      expect(runtime.automaticApprovalNotificationStatus()).toMatchObject({ configured: true, routeCount: 1,
        policySha256: config.automatic.reviewedPolicySha256, live: { pending: 0, active: 0 } })
      expect((await runtime.automaticApprovalAdmissions()).records).toEqual([])
      await runtime.show(historical.id); await runtime.events(historical.id)
      expect(receiver.bodies).toEqual([])
      config.automatic.policy.routes[0].scope.id = randomUUID(); config.endpoints[0].url = 'http://127.0.0.1:8/changed'
      const run = await f.start(runtime); expect(run.state.status).toBe('waiting')
      await runtime.close()
      expect(receiver.bodies).toHaveLength(1); expect(receiver.bodies[0]).not.toContain('PRIVATE_REVIEW_VALUE')
      const disabled = await f.open(null)
      expect(disabled.automaticApprovalNotificationStatus()).toEqual({ schemaVersion: 1, configured: false, live: null })
      const page = await disabled.automaticApprovalAdmissions()
      expect(page.records).toHaveLength(1); expect(page.records[0]!.outcome.status).toBe('delivery-recorded')
      const id = page.records[0]!.request.requestId, record = await disabled.automaticApprovalAdmission(id)
      record.policy.routes[0]!.endpointSha256 = '0'.repeat(64)
      expect(await disabled.automaticApprovalAdmission(id)).toEqual(page.records[0])
      await disabled.show(run.id); await disabled.close()
      expect(receiver.bodies).toHaveLength(1)
    })
    it(`${backend}: exact immutable release scope is verified and selected by source startup`, async () => {
      const receiver = await sink(), f = await seed(backend, receiver.url)
      await f.owner.close()
      const config = configuration({ kind: 'release', id: f.release.snapshot.id, sha256: f.release.sha256,
        revision: f.release.snapshot.workflow.revision }, receiver.url)
      const runtime = await f.open(config)
      await runtime.runRelease(f.release.snapshot, { message: 'PRIVATE_REVIEW_VALUE' })
      await runtime.close(); expect(receiver.bodies).toHaveLength(1)
    })
    it.each(['unknown-project', 'future-generation', 'wrong-revision', 'unknown-release', 'wrong-release-hash'] as const)(
      `${backend}: startup refuses %s without notification admission or dispatch`, async damage => {
        const f = await seed(backend); await f.owner.close()
        const config = mutable(f.config)
        const selected = config.automatic.policy.routes[0].scope
        if (damage === 'unknown-project') selected.id = randomUUID()
        if (damage === 'future-generation') selected.generation++
        if (damage === 'wrong-revision') selected.revision = '0'.repeat(64)
        if (damage === 'unknown-release' || damage === 'wrong-release-hash') config.automatic.policy.routes[0].scope = {
          kind: 'release', id: damage === 'unknown-release' ? randomUUID() : f.release.snapshot.id,
          sha256: damage === 'wrong-release-hash' ? '0'.repeat(64) : f.release.sha256, revision: f.release.snapshot.workflow.revision }
        rereview(config)
        const before = structuredClone([...f.journal.rows.values()])
        await expect(f.open(config)).rejects.toHaveProperty('code', damage.startsWith('unknown') ? 'not-found' : 'conflict')
        if (backend === 'sqlite') {
          const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'))
          try { expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 18 }) } finally { db.close() }
        } else expect([...f.journal.rows.values()]).toEqual(before)
      })
    it(`${backend}: diagnostics are bounded read-only pages and never migrate or manufacture records`, async () => {
      const f = await seed(backend); await f.owner.close()
      const disabled = await f.open(null)
      expect(await disabled.automaticApprovalAdmissions()).toEqual({ records: [], nextCursor: null })
      await expect(disabled.automaticApprovalAdmissions({ limit: 201 })).rejects.toHaveProperty('code', 'invalid-command')
      await expect(disabled.automaticApprovalAdmissions({ after: randomUUID() })).rejects.toHaveProperty('code', 'not-found')
      await expect(disabled.automaticApprovalAdmission('PRIVATE_INVALID_ID')).rejects.toHaveProperty('code', 'invalid-command')
      await expect(disabled.automaticApprovalAdmission(randomUUID())).rejects.toHaveProperty('code', 'not-found')
      if (backend === 'sqlite') {
        const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'))
        try { expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 18 }) } finally { db.close() }
      }
      await disabled.close()
      expect(() => disabled.automaticApprovalNotificationStatus()).toThrow('closed')
    })
    it(`${backend}: known historical accepted project generation stays selectable after rename`, async () => {
      const receiver = await sink(), f = await seed(backend, receiver.url), waiting = await f.start(f.owner)
      await f.owner.editProject({ operation: 'rename', id: f.project.id, expectedGeneration: f.project.generation, title: 'Changed title', actor: 'PRIVATE_OWNER' })
      await f.owner.close()
      const runtime = await f.open()
      if (waiting.state.status !== 'waiting') throw new Error('fixture wait')
      await runtime.decide(waiting.id, waiting.state.attempt.id, 'approve', 'PRIVATE_REVIEWER')
      await runtime.close()
      expect(receiver.bodies.map(value => JSON.parse(value).type)).toEqual(['ai.jevable.approval.decided'])
    })
  }
  it('invalid reviewed startup fails before SQLite directory creation or PostgreSQL journal opening', async () => {
    const directory = join(await mkdtemp(join(tmpdir(), 'jevable-invalid-automatic-startup-')), 'not-created')
    const config = mutable(configuration(scope)); config.automatic.reviewedPolicySha256 = '0'.repeat(64)
    await expect(LocalRuntime.open({ dataDirectory: directory, notifications: config })).rejects.toHaveProperty('code', 'invalid-command')
    await expect(stat(directory)).rejects.toHaveProperty('code', 'ENOENT')
    const open = vi.spyOn(PostgresJournal, 'open')
    await expect(PostgresRuntime.open({ database: {} as never, notifications: config })).rejects.toHaveProperty('code', 'invalid-command')
    expect(open).not.toHaveBeenCalled()
  })
})

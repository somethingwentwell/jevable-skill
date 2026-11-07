import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { PostgresRuntime } from '../src/runtime/postgres.ts'
import { JournalError, type JournalBatch } from '../src/storage/postgres.ts'
import { journalConditionHash, checkJournalConditionTime, type JournalConditions } from '../src/storage/conditions.ts'
import { prepareGrantToken } from '../src/access/grants.ts'
import { callerRunReceiptSchema } from '../src/access/caller.ts'
import { callerControlReceiptSchema } from '../src/access/caller-control.ts'
import { callerCancellationReceiptSchema } from '../src/access/caller-cancellation.ts'
import { reviewerDecisionReceiptSchema } from '../src/access/reviewer.ts'
import { inspectRelease } from '../src/releases/snapshot.ts'
import { compileLocalRun } from '../src/runtime/run-evaluator.ts'
import { executionCheckpointHash, type LocalRun } from '../src/runtime/run-types.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { CORE_VERSION, PROTOCOL_VERSION } from '../src/capabilities.ts'
import { parseNotificationConfig } from '../src/notifications/config.ts'
import { RuntimeTelemetry } from '../src/telemetry/traces.ts'
import { ConfiguredModels } from '../src/providers/model-calls.ts'
import { startPostgresRuntimeService } from '../src/http/postgres.ts'
import { traceRecords } from '../scripts/check-postgres-telemetry.mjs'
import { logRecords } from '../scripts/check-telemetry-package.mjs'
import type { ModelCalls } from '../src/runtime/model-port.ts'
import type { AsyncRunOptions } from '../src/runtime/async-run.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const modelSource = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'management-model', name: 'Management model' },
  spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
    write: { type: 'llm', config: { provider: 'fixture', model: 'fixture', connection: { mode: 'workspace', id: 'fixture' },
      prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 20, stream: false }, historyScope: 'none',
      execution: { timeoutSeconds: 60, maxAttempts: 1 } } }, end: { type: 'output', config: { value: '${{ nodes.write.output }}' } } },
    edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }] } })
const at = '2026-10-05T00:00:00.000Z', expiresAt = '2026-10-06T00:00:00.000Z'
const parent = '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01'
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

/** Source-domain double only: no database open, SQL, locks, durability or actual provider. */
class JournalDouble {
  readonly signal = new AbortController().signal
  readonly rows = new Map<string, { collection: string; key: string; version: string; deleted: boolean; value: unknown }>()
  readonly history: any[] = []
  readonly receipts = new Map<string, any>()
  put(collection: string, key: string, value: unknown, version = '1') {
    this.rows.set(`${collection}/${key}`, { collection, key, version, deleted: false, value: structuredClone(value) })
  }
  async get(collection: string, key: string) { return structuredClone(this.rows.get(`${collection}/${key}`)) }
  async exists(collection: string, key: string) { return this.rows.has(`${collection}/${key}`) }
  async callerRun(pin: { id: string; grantId: string; release: { id: string; sha256: string; revision: string } }) {
    const row = this.rows.get('runs/' + pin.id), value = row?.value as any, run = value?.record
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
    if (guard) {
      checkJournalConditionTime(guard)
      for (const condition of guard.records) {
        const row = this.rows.get(`${condition.collection}/${condition.key}`)
        if (!row || row.deleted || row.version !== condition.version || journalConditionHash(row.value) !== condition.sha256) throw new JournalError('conflict')
      }
    }
    if (this.receipts.has(batch.id)) throw new JournalError('conflict')
    for (const change of batch.changes) if ((this.rows.get(`${change.collection}/${change.key}`)?.version ?? '0') !== change.expectedVersion) throw new JournalError('conflict')
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
    this.receipts.set(batch.id, receipt); return structuredClone(receipt)
  }
  async close() {}
}

async function receiver(sampleRatio: number) {
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
    authentication: { kind: 'none' as const }, sampleRatio, httpRequests: true, intervalMs: 60000, timeoutMs: 1000 }
  return { packets, config, async close() { await new Promise<void>(yes => { server.close(() => yes()); server.closeAllConnections() }) } }
}
const modes = ['start', 'step', 'continue', 'cancel', 'recover', 'review-approve', 'review-reject'] as const
const cases = [0, 1].flatMap(sampleRatio => (['owner', 'delegated'] as const).flatMap(authority => modes.flatMap(mode =>
  (['hold', 'refuse', 'lose'] as const).map(fault => ({ sampleRatio, authority, mode, fault })))))

// New SDK admission boundary checks reuse this test-only journal; NOT actual SQL or durable-disk qualification.
describe('PostgreSQL asynchronous SDK admission with journal/model doubles', () => {
  function fixture() {
    const journal = new JournalDouble()
    const owner = Reflect.construct(PostgresRuntime, [journal, 10000, 10000, 4_000_000, parseNotificationConfig({})]) as PostgresRuntime
    const models: ModelCalls = { admit: vi.fn(), async verify() {}, execute: vi.fn(async () => ({ output: 'model result', usage: { tries: 1 } })) }
    Reflect.set(owner, 'models', models)
    return { owner, journal, models }
  }

  it.each(['raw', 'project', 'release'] as const)('awaits creation commit and verified readback before publishing a %s receipt', async kind => {
    const { owner, journal } = fixture(), id = randomUUID()
    const project = await owner.editProject({ operation: 'create', yaml: echo, title: 'Private project', actor: 'local:test' })
    const release = await owner.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision,
      version: '1.0.0', runtime: { version: CORE_VERSION, sha256: '1'.repeat(64) }, actor: 'local:test' })
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), commit = journal.commit.bind(journal)
    journal.commit = async (...args) => {
      if (args[0].events.some(event => event.kind === 'run-created')) { entered.resolve(); await gate.promise }
      return commit(...args)
    }
    const start = () => kind === 'raw' ? owner.runAsync(echo, 'private input', { id })
      : kind === 'project' ? owner.runProjectAsync(project.id, 1, project.acceptedRevision, 'private input', { id })
        : owner.runReleaseAsync(release.snapshot, 'private input', { id })
    let admitted = false
    const pending = start().then(value => { admitted = true; return value })
    try {
      await entered.promise; expect(admitted).toBe(false); expect(journal.rows.has('runs/' + id)).toBe(false)
      await expect(owner.close()).rejects.toHaveProperty('code', 'busy')
      gate.resolve()
      const receipt = await pending
      expect(receipt).toMatchObject({ observation: 'created', run: { id, state: { status: 'paused', steps: [] } } })
      if (kind === 'project') expect(receipt.run.project).toEqual({ id: project.id, generation: 1 })
      if (kind === 'release') expect(receipt.run.release).toEqual({ id: release.snapshot.id, sha256: release.sha256 })
      const result = await receipt.completion
      expect(result.state).toMatchObject({ status: 'completed', output: 'private input' })
      const before = structuredClone(journal.history)
      const retry = await start()
      expect(retry.observation).toBe('retained'); expect(await retry.completion).toEqual(result)
      expect(journal.history).toEqual(before)
    } finally { gate.resolve(); await (await pending).completion; await owner.close() }
  })

  it('rejects a lost creation commit acknowledgement while retaining its original checkpoint for inspection', async () => {
    const { owner, journal, models } = fixture(), id = randomUUID(), commit = journal.commit.bind(journal)
    const failure = new JournalError('commit-uncertain')
    journal.commit = async (...args) => { const receipt = await commit(...args)
      if (args[0].events.some(event => event.kind === 'run-created')) throw failure
      return receipt }
    try {
      await expect(owner.runAsync(echo, 'input', { id })).rejects.toBe(failure)
      expect((await owner.show(id)).state.status).toBe('paused')
      expect(journal.history.filter(event => event.collection === 'runs').map(event => event.kind)).toEqual(['run-created'])
      expect(models.execute).not.toHaveBeenCalled()
      journal.commit = commit
      const retry = await owner.runAsync(echo, 'input', { id })
      expect(retry.observation).toBe('retained'); expect((await retry.completion).state.status).toBe('paused')
    } finally { await owner.close() }
  })

  it('does not publish before readback or dispatch when ownership is lost after creation acknowledgement', async () => {
    const { owner, journal, models } = fixture(), id = randomUUID(), commit = journal.commit.bind(journal)
    const signal = new AbortController(), failure = new Error('readback owner lost')
    Reflect.set(journal, 'signal', signal.signal)
    journal.commit = async (...args) => { const receipt = await commit(...args)
      if (args[0].events.some(event => event.kind === 'run-created')) signal.abort(failure)
      return receipt }
    try {
      await expect(owner.runAsync(echo, 'input', { id })).rejects.toBe(failure)
      expect(journal.history.filter(event => event.collection === 'runs').map(event => event.kind)).toEqual(['run-created'])
      expect(models.execute).not.toHaveBeenCalled()
    } finally { await owner.close() }
  })

  it('preserves execution reservation and rejected completion after an admitted uncertain model dispatch', async () => {
    const { owner, journal, models } = fixture(), id = randomUUID(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
    const failure = new Error('model uncertain')
    models.execute = vi.fn(async () => { entered.resolve(); await gate.promise; throw failure })
    let completion: Promise<unknown> | undefined
    try {
      const admitted = await owner.runAsync(modelSource, 'private input', { id })
      completion = admitted.completion.catch(error => error)
      expect(admitted.run.state.status).toBe('paused')
      await entered.promise; expect((await owner.show(id)).state.status).toBe('executing')
      await expect(owner.close()).rejects.toHaveProperty('code', 'busy')
      await expect(owner.runAsync(modelSource, 'private input', { id })).rejects.toHaveProperty('code', 'busy')
      gate.resolve(); expect(await completion).toBe(failure)
      const before = structuredClone(journal.history)
      const retained = await owner.runAsync(modelSource, 'private input', { id })
      expect(retained.observation).toBe('retained'); expect((await retained.completion).state.status).toBe('executing')
      expect(models.execute).toHaveBeenCalledTimes(1); expect(journal.history).toEqual(before)
    } finally { gate.resolve(); await completion; await owner.close() }
  })

  it('refuses missing UUID or injected provenance consistently on all new public entrypoints', async () => {
    const { owner, journal } = fixture()
    try {
      for (const invalid of [{}, { id: randomUUID(), project: {} }, { id: randomUUID(), release: {} }, { id: randomUUID(), test: {} }]) {
        const options = invalid as AsyncRunOptions
        for (const call of [() => owner.runAsync(echo, 'input', options), () => owner.runProjectAsync(randomUUID(), 1, '1'.repeat(64), 'input', options),
          () => owner.runReleaseAsync({}, 'input', options)]) await expect(call()).rejects.toHaveProperty('code', 'invalid-command')
      }
      expect(journal.rows.size).toBe(0); expect(journal.history).toEqual([])
    } finally { await owner.close() }
  })
})

describe('management pre-live HTTP admission (journal/model doubles, actual loopback HTTP/OTLP)', () => {
  it.each(cases)('keeps admission, authority, error mapping and HTTP ancestry exact ($sampleRatio, $authority, $mode, $fault)', async ({ sampleRatio, authority, mode, fault }) => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at)
    const delegated = authority === 'delegated', review = mode.startsWith('review-'), source = review ? approval : mode === 'recover' ? modelSource : echo
    const journal = new JournalDouble(), graph = compileLocalRun(source, DEFAULT_COMPILER_LIMITS), wire = await receiver(sampleRatio)
    const release = inspectRelease({ format: 'jevable.ai/release', schemaVersion: 1, id: randomUUID(), version: '1.0.0', createdAt: at,
      createdBy: 'PRIVATE_ISSUER', project: { id: randomUUID(), generation: 1 }, workflow: { yaml: graph.source.yaml, revision: graph.source.revision }, runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
    journal.put('releases', release.snapshot.id, { format: 'jevable.pg-release/v1', ...release })
    journal.put('release-versions', `${release.snapshot.project.id}/1.0.0`, { format: 'jevable.pg-release-version/v1', projectId: release.snapshot.project.id, version: '1.0.0', firstReleaseId: release.snapshot.id })
    // Test-only constructor/storage/model injection. Production API exposes none of these bypasses.
    const owner = Reflect.construct(PostgresRuntime, [journal, 10000, 10000, 4_000_000, parseNotificationConfig({})]) as PostgresRuntime
    const telemetry = new RuntimeTelemetry(wire.config, () => undefined, { storage: 'postgres' }); Reflect.set(owner, 'telemetry', telemetry)
    const models: ModelCalls = { admit: vi.fn(), verify: vi.fn(async () => undefined), execute: vi.fn(async () => ({ output: 'PRIVATE_MODEL_OUTPUT', usage: { tries: 1 } })),
      recover: vi.fn(async () => ({ output: 'PRIVATE_MODEL_OUTPUT', usage: { tries: 1 } })) }
    Reflect.set(owner, 'models', models)
    if (mode === 'recover') { vi.spyOn(ConfiguredModels.prototype, 'admit').mockResolvedValue({} as never); vi.spyOn(ConfiguredModels.prototype, 'verify').mockResolvedValue(undefined) }
    const id = randomUUID(), requestId = randomUUID(), hostToken = randomBytes(32).toString('hex'), caller = prepareGrantToken(randomUUID())
    const pin = { id: release.snapshot.id, sha256: release.sha256, revision: graph.source.revision }
    await owner.issueGrant({ id: caller.id, tokenSha256: caller.tokenSha256, actor: 'PRIVATE_ISSUER', expiresAt,
      scope: { kind: 'caller', release: pin, permissions: ['start', 'control', 'cancel'] } })
    let token = delegated ? caller.token : hostToken, path = delegated ? '/v1/caller/operations' : '/v1/operations', before: LocalRun | undefined
    let command: Record<string, unknown>
    const start = () => delegated ? owner.startWithGrant(caller.token, 'PRIVATE_INPUT', { id, paused: mode !== 'recover' })
      : owner.run(source, 'PRIVATE_INPUT', { id, paused: mode !== 'recover' })
    try {
      if (review) {
        before = await owner.runRelease(release.snapshot, { message: 'PRIVATE_REVIEW' }, { id })
        if (before.state.status !== 'waiting') throw Error('fixture wait missing')
        if (delegated) {
          const reviewer = prepareGrantToken(randomUUID()); token = reviewer.token; path = '/v1/reviewer/decisions'
          await owner.issueGrant({ id: reviewer.id, tokenSha256: reviewer.tokenSha256, expiresAt, actor: 'PRIVATE_ISSUER',
            scope: { kind: 'reviewer', runId: id, revision: before.revision, attemptId: before.state.attempt.id, decisions: ['approve', 'reject'] } })
        }
        command = { ...(delegated ? { requestId } : { operation: 'approvals.decide', id, attemptId: before.state.attempt.id }), action: mode === 'review-approve' ? 'approve' : 'reject', pauseAfter: false }
      } else if (mode === 'start') command = delegated ? { operation: 'start', release: pin, input: 'PRIVATE_INPUT', options: { id } }
        : { operation: 'runs.start', id, yaml: source, input: 'PRIVATE_INPUT' }
      else {
        if (mode === 'recover') {
          const original = journal.commit.bind(journal), setup = vi.spyOn(journal, 'commit').mockImplementation(async (batch, guard) => {
            if (batch.events.some(e => e.kind === 'node-result') && (journal.rows.get('runs/' + id)?.value as any)?.record.state.status === 'executing'
              && (journal.rows.get('runs/' + id)?.value as any).record.state.next === 'write') throw new JournalError('unavailable')
            return original(batch, guard)
          })
          try { await expect(start()).rejects.toHaveProperty('code', 'unavailable') } finally { setup.mockRestore() }
        } else await start()
        before = await owner.show(id)
        command = mode === 'cancel' ? delegated ? { operation: 'cancel', release: pin, id, request: { requestId } }
          : { operation: 'runs.cancel', id, requestId }
          : delegated ? { operation: 'control', release: pin, id, request: { requestId, mode, expectedCheckpointSha256: executionCheckpointHash(before) } }
            : { operation: 'runs.advance', id, requestId, mode, expectedCheckpointSha256: executionCheckpointHash(before) }
      }
      const open = vi.spyOn(PostgresRuntime, 'open').mockResolvedValue(owner)
      const service = await startPostgresRuntimeService({ runtime: { database: { host: '127.0.0.1', port: 5432, database: 'fixture', user: 'fixture', password: 'PRIVATE_DATABASE', namespace: 'fixture', initialize: false, tls: { mode: 'loopback-test' } } },
        token: hostToken, actor: 'PRIVATE_HOST_ACTOR', callerOperations: true, reviewerDecisions: true })
      expect(open).toHaveBeenCalledOnce()
      const raw = (extra: Record<string, string> = {}) => fetch(service.url + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
        'x-jevable-protocol': PROTOCOL_VERSION, 'x-jevable-instance': service.instanceId, traceparent: parent, ...extra }, body: JSON.stringify(command) })
      const rows = () => structuredClone({ records: [...journal.rows], events: journal.history, receipts: [...journal.receipts] })
      const kind = review ? 'approval-decided' : mode === 'start' ? 'run-created' : mode === 'cancel' ? 'cancellation-requested' : 'execution-requested'
      const baseline = rows(), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
      let pending: Promise<{ status: number; body: any }> | undefined
      try {
        // Bad transport pins and cross-role owner/delegated tokens never reach a writer or adopt the parent.
        for (const headers of [{ 'x-jevable-instance': randomUUID() }, { 'x-jevable-protocol': 'invalid' }, { authorization: `Bearer ${delegated ? hostToken : caller.token}` }]) {
          const response = await raw(headers); expect(response.status).toBe(headers.authorization ? 401 : 409); await response.json(); expect(rows()).toEqual(baseline)
        }
        await vi.waitFor(async () => { await owner.telemetryFlush(); expect(wire.packets.filter(p => p.route === '/v1/logs').flatMap(p => logRecords(p.bytes)).filter(l => l.event === 'jevable.http.request.ended')).toHaveLength(3) }, { timeout: 1500, interval: 5 })
        const rejectedSpans = wire.packets.filter(p => p.route === '/v1/traces').flatMap(p => traceRecords(p.bytes)).filter(s => s.name === 'jevable.http.request')
        expect(rejectedSpans).toHaveLength(sampleRatio ? 3 : 0); for (const span of rejectedSpans) { expect(span.parent).toBeUndefined(); expect(span.traceId).not.toBe('1'.repeat(32)) }
        const firstPacket = wire.packets.length, original = journal.commit.bind(journal), error = new JournalError(fault === 'refuse' ? 'unavailable' : 'commit-uncertain')
        let matches = 0, terminal = false
        const spy = vi.spyOn(journal, 'commit').mockImplementation(async (batch, guard) => {
          if (!batch.events.some(e => e.collection === 'runs' && e.key === id && e.kind === kind)) return original(batch, guard)
          matches++; if (fault === 'refuse') throw error
          const receipt = await original(batch, guard); if (fault === 'lose') throw error
          entered.resolve(); await gate.promise; return receipt
        })
        const ownerMethods = [vi.spyOn(owner, 'run'), vi.spyOn(owner, 'advance'), vi.spyOn(owner, 'decide'), vi.spyOn(owner, 'cancel')]
        const decoded = () => { const packets = wire.packets.slice(firstPacket); return { packets,
          spans: packets.filter(p => p.route === '/v1/traces').flatMap(p => traceRecords(p.bytes)), logs: packets.filter(p => p.route === '/v1/logs').flatMap(p => logRecords(p.bytes)) } }
        pending = raw().then(async response => { const body = await response.json(); terminal = true; return { status: response.status, body } })
        try {
          if (fault === 'hold') {
            await Promise.race([entered.promise, pending.then(() => { throw Error('Admission must be held before returning') })])
            const committed = rows(), record = (journal.rows.get('runs/' + id)!.value as any).record
            expect(matches).toBe(1); expect(terminal).toBe(false); expect(committed.events.at(-1)?.kind).toBe(kind)
            expect(record.state.steps).toHaveLength((before?.state.steps.length ?? 0) + Number(mode === 'review-approve'))
            expect(record.traceSegments?.length ?? 0).toBe((before?.traceSegments?.length ?? 0) + Number(review))
            for (let i = 0; i < 2; i++) {
              await owner.telemetryFlush(); expect(terminal).toBe(false); expect(rows()).toEqual(committed)
              const { spans, logs } = decoded()
              expect(spans.filter(s => ['jevable.http.request', 'jevable.run', 'jevable.resume', 'jevable.approval', 'jevable.cancel', 'jevable.node', 'jevable.model'].includes(s.name))).toEqual([])
              expect(logs.filter(l => ['jevable.http.request.ended', 'jevable.execution.segment.ended', 'jevable.node.attempt.ended', 'jevable.model.call.ended'].includes(l.event))).toEqual([])
              expect(models.execute).toHaveBeenCalledTimes(mode === 'recover' ? 1 : 0); expect(models.recover).toHaveBeenCalledTimes(mode === 'recover' ? 1 : 0)
            }
          }
          gate.resolve(); const result = await pending; expect(matches).toBe(1)
          if (fault === 'hold') expect(result).toMatchObject({ status: 200, body: { instanceId: service.instanceId, result: { status: mode === 'start' || mode === 'continue' || mode === 'review-approve' ? 'completed' : mode === 'cancel' ? 'cancelled' : mode === 'review-reject' ? 'failed' : 'paused' } } })
          else expect(result).toMatchObject({ status: 503, body: { status: 'error', code: fault === 'refuse' ? 'unavailable' : 'commit-uncertain' } })
          const retained = rows()
          if (fault === 'refuse' && !(review && !delegated)) expect(retained).toEqual(baseline)
          else expect(retained.events.filter(e => e.collection === 'runs' && e.key === id && e.kind === kind)).toHaveLength(fault === 'refuse' ? 0 : 1)
          const record = (journal.rows.get('runs/' + id)?.value as any)?.record as LocalRun | undefined
          if (fault !== 'hold' && record) {
            expect(record.state.steps).toHaveLength((before?.state.steps.length ?? 0) + Number(fault === 'lose' && mode === 'review-approve'))
            expect(record.traceSegments?.length ?? 0).toBe((before?.traceSegments?.length ?? 0) + Number(review && (!delegated || fault !== 'refuse')))
            if (fault === 'refuse') expect(record.state).toEqual(before!.state)
          }
          if (fault === 'refuse' && review && !delegated) {
            // Direct owner approval persists its new segment before the refused decision; no other mutation.
            expect(retained.events.slice(0, baseline.events.length)).toEqual(baseline.events)
            expect(retained.events.slice(baseline.events.length)).toHaveLength(1)
            expect(retained.receipts).toHaveLength(baseline.receipts.length + 1)
            for (const [key, prior] of baseline.records) {
              const current = journal.rows.get(key)!
              if (key !== 'runs/' + id) expect(current).toEqual(prior)
              else { expect(current.version).toBe(String(BigInt(prior.version) + 1n))
                expect(current.value).toEqual({ ...(prior.value as any), record: { ...(prior.value as any).record, traceSegments: record!.traceSegments } }) }
            }
          }
          await vi.waitFor(async () => { await owner.telemetryFlush(); expect(decoded().logs.filter(l => l.event === 'jevable.http.request.ended')).toHaveLength(1) }, { timeout: 1500, interval: 5 })
          const { packets, spans, logs } = decoded(), http = logs.find(l => l.event === 'jevable.http.request.ended')!, segments = logs.filter(l => l.event === 'jevable.execution.segment.ended')
          expect(http.traceId).toBe('1'.repeat(32)); expect(http.attributes).toMatchObject({ 'http.route': path, 'http.response.status_code': result.status, 'jevable.http.outcome': 'response-finished' })
          expect(segments).toHaveLength(fault === 'hold' || review ? 1 : 0)
          expect(logs.filter(l => l.event === 'jevable.node.attempt.ended')).toHaveLength(fault === 'hold' ? mode === 'start' || mode === 'continue' ? 2 : mode === 'step' || mode === 'review-approve' ? 1 : 0 : 0)
          for (const segment of segments) { expect(segment.traceId).toBe(http.traceId); expect(segment.attributes['jevable.outcome']).toBe(fault === 'hold' ? result.body.result.status : 'failed-or-uncertain') }
          if (fault !== 'refuse') {
            const event = retained.events.findLast(e => e.collection === 'runs' && e.key === id && e.kind === kind)!
            if (mode !== 'start') {
              const actor = review ? event.data.data.decision.actor : event.data.data.actor
              expect(actor).toBe(delegated ? `grant:${review ? token.split('.')[1] : caller.id}` : 'PRIVATE_HOST_ACTOR')
            }
            if (delegated && !review) expect(record!.caller).toMatchObject({ grantId: caller.id, actor: `grant:${caller.id}`, scope: { kind: 'caller', release: pin } })
          }
          if (sampleRatio) {
            expect(spans.find(s => s.spanId === http.spanId)).toMatchObject({ name: 'jevable.http.request', parent: '2'.repeat(16), traceId: http.traceId })
            for (const segment of segments) expect(spans.find(s => s.spanId === segment.spanId)?.parent).toBe(http.spanId)
            for (const log of logs) expect(spans.some(s => s.traceId === log.traceId && s.spanId === log.spanId)).toBe(true)
          } else expect(spans).toEqual([])
          for (const packet of wire.packets) for (const secret of ['PRIVATE_', hostToken, caller.token, token]) expect(packet.bytes.includes(Buffer.from(secret))).toBe(false)
          if (delegated) { for (const method of ownerMethods) expect(method).not.toHaveBeenCalled(); expect(JSON.stringify(result.body)).not.toContain('PRIVATE_') }
          else expect(ownerMethods.reduce((sum, method) => sum + method.mock.calls.length, 0)).toBe(1)
          if (delegated && fault === 'hold') {
            const schema = review ? reviewerDecisionReceiptSchema : mode === 'cancel' ? callerCancellationReceiptSchema : mode === 'start' ? callerRunReceiptSchema : callerControlReceiptSchema
            expect(schema.parse(result.body.result)).toEqual(result.body.result)
          }
          for (const secret of [hostToken, caller.token, token]) expect(JSON.stringify(result.body)).not.toContain(secret)
          expect(models.execute).toHaveBeenCalledTimes(mode === 'recover' ? 1 : 0); expect(models.recover).toHaveBeenCalledTimes(mode === 'recover' ? 1 : 0)
          spy.mockRestore()
          // Owner approval has no idempotent decision UUID; never retry it or authorize continuation.
          // Owner cancellation has a distinct settlement contract; uncertain owner cancel is not replayed here.
          if (fault !== 'refuse' && (delegated || !review && !(mode === 'cancel' && fault === 'lose'))) {
            const retry = await raw(); expect(retry.status).toBe(200); const value = await retry.json()
            if (fault === 'hold') expect(value).toEqual(result.body)
            expect(rows()).toEqual(retained); expect(models.execute).toHaveBeenCalledTimes(mode === 'recover' ? 1 : 0); expect(models.recover).toHaveBeenCalledTimes(mode === 'recover' ? 1 : 0)
            await vi.waitFor(async () => { await owner.telemetryFlush(); expect(decoded().logs.filter(l => l.event === 'jevable.http.request.ended')).toHaveLength(2) }, { timeout: 1500, interval: 5 })
            expect(decoded().logs.filter(l => l.event === 'jevable.execution.segment.ended')).toEqual(segments)
            expect(decoded().logs.filter(l => l.event === 'jevable.node.attempt.ended')).toEqual(logs.filter(l => l.event === 'jevable.node.attempt.ended'))
          }
        } finally { gate.resolve(); await pending; spy.mockRestore() }
      } finally { gate.resolve(); await pending; await service.close(); await service.closed }
    } finally { await owner.close(); await wire.close() }
  }, 10000)
})

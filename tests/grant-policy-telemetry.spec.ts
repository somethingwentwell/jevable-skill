import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { admitGrantAction, type GrantAction, type GrantActionTarget } from '../src/access/actions.ts'
import { GRANT_POLICY_ACTIONS, observeGrantPolicy } from '../src/access/policy-observation.ts'
import { prepareGrantToken, grantTokenProof, issueGrantRecord } from '../src/access/grants.ts'
import { SQLiteGrantStore, initializeGrantTables } from '../src/access/sqlite-grants.ts'
import { PostgresGrantStore } from '../src/access/postgres-grants.ts'
import type { PostgresJournal, JournalBatch } from '../src/storage/postgres.ts'
import { journalConditionHash } from '../src/storage/conditions.ts'
import { LocalRuntime } from '../src/runtime/index.ts'
import { WorkflowRuntimeError } from '../src/runtime/errors.ts'
import { RuntimeTelemetry } from '../src/telemetry/traces.ts'
import { parseTelemetryConfig, type TelemetryConfig } from '../src/telemetry/config.ts'
import { observeGrantPolicyDecision } from '../src/telemetry/grant-policy.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { traceRecords } from '../scripts/check-postgres-telemetry.mjs'
import { fields, logRecords, metricSums } from '../scripts/check-telemetry-package.mjs'

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
const parent = '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01'
const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
function policyFixture(label: typeof GRANT_POLICY_ACTIONS[number] = 'caller.start') {
  const prepared = prepareGrantToken(randomUUID()), at = new Date().toISOString(), expiresAt = new Date(Date.now() + 3600000).toISOString()
  const release = { id: randomUUID(), sha256: 'a'.repeat(64), revision: 'b'.repeat(64) }, runId = randomUUID(), attemptId = randomUUID()
  const reviewer = label.startsWith('reviewer.'), decision = label === 'reviewer.reject' ? 'reject' : label === 'reviewer.custom' ? 'requestChanges' : 'approve'
  const command = { id: prepared.id, tokenSha256: prepared.tokenSha256, actor: 'PRIVATE_ISSUER', expiresAt,
    scope: reviewer ? { kind: 'reviewer' as const, runId, attemptId, revision: release.revision, decisions: [decision] }
      : { kind: 'caller' as const, release, permissions: ['start', 'read', 'control', 'cancel'] as ('start' | 'read' | 'control' | 'cancel')[] } }
  const record = issueGrantRecord(command, at), proof = grantTokenProof(prepared.token)!
  const action: GrantAction = reviewer ? { kind: 'decision', runId, attemptId, decision }
    : label === 'caller.start' ? { kind: 'start', release } : { kind: label.split('.')[1] as 'read' | 'control' | 'cancel', runId }
  const target: GrantActionTarget = label === 'caller.start' ? { kind: 'release', release }
    : { kind: 'run', runId, revision: release.revision, release, callerGrantId: record.id, cancelled: false, wait: { attemptId, expiresAt } }
  return { prepared, at, expiresAt, command, record, proof, action, target, release }
}
async function receiverFixture(options: Partial<TelemetryConfig> = {}, refused = false) {
  const received: { path: string; bytes: Buffer; baggage: string | undefined }[] = []
  const receiver = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const bytes of req) chunks.push(bytes)
    received.push({ path: req.url!, bytes: Buffer.concat(chunks), baggage: req.headers.baggage as string | undefined })
    res.writeHead(refused ? 503 : 200, { 'content-type': 'application/x-protobuf' }); res.end()
  })
  await new Promise<void>((yes, no) => { receiver.once('error', no); receiver.listen(0, '127.0.0.1', yes) })
  cleanup.push(() => new Promise<void>(yes => { receiver.close(() => yes()); receiver.closeAllConnections() }))
  const address = receiver.address(); if (!address || typeof address === 'string') throw Error('listener')
  const base = `http://127.0.0.1:${address.port}`, config: TelemetryConfig = { endpoint: base + '/v1/traces',
    metricsEndpoint: base + '/v1/metrics', logsEndpoint: base + '/v1/logs', authentication: { kind: 'none' },
    intervalMs: 60000, timeoutMs: 1000, flushTimeoutMs: 2000, ...options }
  const telemetry = new RuntimeTelemetry(config, () => undefined, { storage: 'sqlite' }); cleanup.push(() => telemetry.close())
  const spans = () => received.filter(r => r.path === '/v1/traces').flatMap(r => traceRecords(r.bytes)).filter(s => s.name === 'jevable.access.policy')
  const logs = () => received.filter(r => r.path === '/v1/logs').flatMap(r => logRecords(r.bytes)).filter(l => l.event === 'jevable.access.policy.ended')
  const sums = () => received.filter(r => r.path === '/v1/metrics').flatMap(r => metricSums(r.bytes)).filter(m => m.name === 'jevable.access.policy.evaluations')
  return { config, telemetry, received, spans, logs, sums }
}

it('grant-policy telemetry is a strict independent default-off startup opt-in', () => {
  const config = { endpoint: 'http://127.0.0.1/v1/traces', authentication: { kind: 'none' as const } }
  expect(parseTelemetryConfig(config).grantPolicyDecisions).toBe(false)
  for (const value of ['true', 1, null]) expect(() => parseTelemetryConfig({ ...config, grantPolicyDecisions: value })).toThrow('invalid-command')
  expect(parseTelemetryConfig({ ...config, grantPolicyDecisions: true }).grantOperations).toBe(false)
})
it('diagnostic begin/end failure preserves one evaluation and the exact original value/error', () => {
  const f = policyFixture(), result = {}, work = vi.fn(() => result), end = vi.fn(() => { throw Error('PRIVATE_HOOK') })
  expect(observeGrantPolicy(f.action, () => ({ end }), work)).toBe(result); expect(work).toHaveBeenCalledTimes(1)
  expect(end).toHaveBeenCalledWith('admitted')
  const original = new WorkflowRuntimeError('not-found'), caught = vi.fn()
  try { observeGrantPolicy(f.action, () => { throw Error('begin') }, () => { throw original }) } catch (error) { caught(error) }
  expect(caught).toHaveBeenCalledWith(original)
  const lookalike = { code: 'not-found', message: 'PRIVATE_ERROR' }, failed = vi.fn()
  expect(() => observeGrantPolicy(f.action, () => ({ end: failed }), () => { throw lookalike })).toThrow()
  expect(failed).toHaveBeenCalledWith('failed')
})
it.each([0, 1])('receives all twenty-one fixed policy groups, context and private-free real OTLP at sampling %s', async sampleRatio => {
  const f = await receiverFixture({ grantPolicyDecisions: true, sampleRatio, baggageKeys: ['request.class'] })
  const secrets: string[] = []
  for (const kind of GRANT_POLICY_ACTIONS) {
    const p = policyFixture(kind); secrets.push(p.prepared.token, p.prepared.tokenSha256, p.prepared.id)
    const call = (proof = p.proof, target = p.target) => f.telemetry.withTraceContext({ traceparent: parent, baggage: 'request.class=PRIVATE_BAGGAGE' },
      () => admitGrantAction(p.record, proof, p.action, target, p.at, action => f.telemetry.observeGrantPolicy(action)))
    expect(call()).toEqual(admitGrantAction(p.record, p.proof, p.action, p.target, p.at))
    expect(() => call({ ...p.proof, tokenSha256: 'e'.repeat(64) })).toThrow('not-found')
    expect(() => call(p.proof, {} as GrantActionTarget)).toThrow('corrupt')
  }
  await f.telemetry.close()
  const spans = f.spans(), logs = f.logs(), sum = f.sums().at(-1)!
  expect(spans).toHaveLength(sampleRatio ? 21 : 0); expect(logs).toHaveLength(21)
  expect(Reflect.get(sum, 'temporality')).toBe(2); expect(sum.points).toHaveLength(21)
  expect(sum.points.reduce((n: number, p: any) => n + p.value, 0)).toBe(21)
  const actual = sum.points.map((p: any) => { expect(p.value).toBe(1)
    expect(Object.keys(p.labels).sort()).toEqual(['jevable.access.action', 'jevable.access.policy.outcome'])
    return p.labels['jevable.access.action'] + '/' + p.labels['jevable.access.policy.outcome'] })
  expect(actual.sort()).toEqual(GRANT_POLICY_ACTIONS.flatMap(a => ['admitted', 'refused', 'failed'].map(o => a + '/' + o)).sort())
  for (const span of spans) {
    expect(span.traceId).toBe('1'.repeat(32)); expect(span.parent).toBe('2'.repeat(16))
    const failed = span.attributes['jevable.access.policy.outcome'] === 'failed'
    expect(Object.keys(span.attributes).sort()).toEqual((failed ? ['error.type', 'jevable.access.action', 'jevable.access.policy.outcome'] : ['jevable.access.action', 'jevable.access.policy.outcome']).sort())
    expect(logs.some(l => l.spanId === span.spanId && l.traceId === span.traceId)).toBe(true)
  }
  for (const log of logs) {
    const failed = log.attributes['jevable.access.policy.outcome'] === 'failed'
    expect(Reflect.get(log, 'severity')).toBe(failed ? 17 : 9)
    expect(log.attributes['error.type']).toBe(failed ? 'grant_policy_failed' : undefined)
  }
  const counts = f.received.filter(r => r.path === '/v1/metrics').flatMap(r =>
    (fields(r.bytes).get(1) ?? []).flatMap((resource: Buffer) => (fields(resource).get(2) ?? []).flatMap((scope: Buffer) =>
      (fields(scope).get(2) ?? []).flatMap((metric: Buffer) => {
        const m = fields(metric); if (m.get(1)![0].toString() !== 'jevable.access.policy.duration') return []
        return [(fields(m.get(9)![0]).get(1) ?? []).reduce((n: number, point: Buffer) => n + Number(fields(point).get(4)![0].readBigUInt64LE()), 0)]
      }))))
  expect(counts.at(-1)).toBe(21)
  for (const r of f.received) { expect(r.baggage).toBeUndefined(); expect(r.bytes.includes(Buffer.from('PRIVATE_'))).toBe(false)
    for (const secret of secrets) expect(r.bytes.includes(Buffer.from(secret))).toBe(false) }
})
it.each([undefined, false])('does not observe policy when grantPolicyDecisions=%s', async grantPolicyDecisions => {
  const f = await receiverFixture(grantPolicyDecisions === undefined ? {} : { grantPolicyDecisions }), p = policyFixture()
  admitGrantAction(p.record, p.proof, p.action, p.target, p.at, a => f.telemetry.observeGrantPolicy(a))
  await f.telemetry.close(); expect(f.spans()).toEqual([]); expect(f.logs()).toEqual([]); expect(f.sums()).toEqual([])
})
it('collector rejection cannot turn admission into refusal or repeat the predicate', async () => {
  const f = await receiverFixture({ grantPolicyDecisions: true }, true), p = policyFixture()
  const work = vi.fn(() => admitGrantAction(p.record, p.proof, p.action, p.target, p.at, a => f.telemetry.observeGrantPolicy(a)))
  expect(work().grantId).toBe(p.record.id); await f.telemetry.flush(); await f.telemetry.close()
  expect(work).toHaveBeenCalledTimes(1); expect(f.received.length).toBeGreaterThan(0)
})
it('expected refusals are not faults, once-only endings contain diagnostic exceptions and invalid outcomes', () => {
  const span = { setAttributes: vi.fn(), setStatus: vi.fn(), end: vi.fn(), spanContext: () => ({ traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags: 1 }) }
  const settled = vi.fn(() => { throw Error('PRIVATE_HOOK') })
  const observation = observeGrantPolicyDecision({ startSpan: () => span } as any, 'caller.read', undefined, settled)
  expect(() => { observation.end('refused'); observation.end('failed') }).not.toThrow()
  expect(span.setStatus).not.toHaveBeenCalled(); expect(span.end).toHaveBeenCalledTimes(1); expect(settled).toHaveBeenCalledTimes(1)
  const invalid = observeGrantPolicyDecision({ startSpan: () => span } as any, 'caller.read', undefined, settled)
  invalid.end('PRIVATE_OUTCOME' as any); expect(settled).toHaveBeenCalledTimes(1)
})
it('refuses unknown actions and policy observations after closing', async () => {
  const f = await receiverFixture({ grantPolicyDecisions: true })
  expect(f.telemetry.observeGrantPolicy('PRIVATE_ACTION' as any)).toBeUndefined()
  await f.telemetry.close(); expect(f.telemetry.observeGrantPolicy('caller.start')).toBeUndefined()
})
it('SQLite policy hooks stay inside the existing transaction and never alter grant rows on evaluation', () => {
  const p = policyFixture(), db = new DatabaseSync(':memory:'); cleanup.push(() => db.close()); initializeGrantTables(db)
  const ended = vi.fn(), begin = vi.fn(() => { expect(db.isTransaction).toBe(true); return { end: ended } })
  const store = new SQLiteGrantStore(db, undefined, begin); store.issue(p.command, () => {})
  const rows = () => JSON.stringify({ grants: db.prepare('SELECT * FROM access_grants').all(), events: db.prepare('SELECT * FROM access_grant_events').all() })
  const original = rows()
  expect(() => store.authorizeInTransaction(p.prepared.token, p.action, p.target)).toThrow('busy'); expect(begin).not.toHaveBeenCalled()
  db.exec('BEGIN IMMEDIATE')
  try {
    expect(store.authorizeInTransaction(p.prepared.token, p.action, p.target).grantId).toBe(p.record.id)
    expect(() => store.authorizeInTransaction(p.prepared.token, p.action, { kind: 'release', release: { ...p.release, id: randomUUID() } })).toThrow('not-found')
    expect(() => store.authorizeInTransaction('PRIVATE_BAD_TOKEN', p.action, p.target)).toThrow('not-found')
  } finally { db.exec('ROLLBACK') }
  expect(begin).toHaveBeenCalledTimes(2); expect(ended.mock.calls).toEqual([['admitted'], ['refused']]); expect(rows()).toBe(original)
})
it('actual standalone SQLite caller writes are observed; reads, retained retries, revocation and reopen never rebuild evaluations', async () => {
  const f = await receiverFixture({ grantPolicyDecisions: true }), dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-policy-runtime-'))
  const owner = await LocalRuntime.open({ dataDirectory, telemetry: f.config }); cleanup.push(() => owner.close())
  const project = owner.editProject({ operation: 'create', title: 'Policy fixture', yaml: echo, actor: 'PRIVATE_OWNER' })
  const release = owner.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision,
    version: '1.0.0', actor: 'PRIVATE_OWNER', runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
  const p = prepareGrantToken(randomUUID()), scope = { kind: 'caller' as const, release: { id: release.snapshot.id, sha256: release.sha256, revision: project.acceptedRevision }, permissions: ['start', 'read'] as ('start' | 'read')[] }
  await owner.issueGrant({ id: p.id, tokenSha256: p.tokenSha256, scope, actor: 'PRIVATE_ISSUER', expiresAt: new Date(Date.now() + 3600000).toISOString() })
  const request = { id: randomUUID(), paused: true }, input = 'PRIVATE_INPUT'
  const receipt = await owner.withTraceParent(parent, () => owner.startWithGrant(p.token, input, request)), events = await owner.events(request.id)
  expect(await owner.startWithGrant(p.token, input, request)).toEqual(receipt)
  await owner.readWithGrant(p.token, request.id); expect(await owner.events(request.id)).toEqual(events)
  await expect(owner.startWithGrant('PRIVATE_BAD_TOKEN', input, { id: randomUUID() })).rejects.toHaveProperty('code', 'not-found')
  await owner.revokeGrant({ id: p.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'PRIVATE_REVOKER' })
  await expect(owner.startWithGrant(p.token, input, request)).rejects.toHaveProperty('code', 'not-found')
  await owner.close()
  expect(f.spans()).toHaveLength(2); expect(f.logs()).toHaveLength(2)
  expect(f.sums().at(-1)!.points).toEqual([{ value: 2, labels: { 'jevable.access.action': 'caller.start', 'jevable.access.policy.outcome': 'admitted' } }])
  const packetCount = f.received.length, reopened = await LocalRuntime.open({ dataDirectory, telemetry: f.config }); cleanup.push(() => reopened.close())
  expect(await reopened.events(request.id)).toEqual(events); await reopened.close(); expect(f.received).toHaveLength(packetCount)
  for (const r of f.received) { expect(r.bytes.includes(Buffer.from('PRIVATE_'))).toBe(false); expect(r.bytes.includes(Buffer.from(p.token))).toBe(false); expect(r.bytes.includes(Buffer.from(p.tokenSha256))).toBe(false) }
})
it('PostgreSQL planning double observes policy, not later condition validation or commit success', async () => {
  const p = policyFixture(), rows = new Map<string, any>(), events: any[] = [], ended = vi.fn(), begin = vi.fn(() => ({ end: ended }))
  const journal = { signal: new AbortController().signal, get: async (_: string, id: string) => structuredClone(rows.get(id)),
    events: async (_: string, __: number, ___: string[], id: string) => ({ events: events.filter(e => e.key === id) }),
    count: async () => rows.size, receipt: async () => undefined,
    commit: async (batch: JournalBatch) => { for (const c of batch.changes) if (c.operation === 'put') rows.set(c.key, { key: c.key, version: String(BigInt(c.expectedVersion) + 1n), value: structuredClone(c.value) })
      for (const e of batch.events) events.push({ ...e, batchId: batch.id }); return {} },
  } as unknown as PostgresJournal
  const store = new PostgresGrantStore(journal, undefined, begin); await store.issue(p.command, async () => {})
  const condition = { collection: 'releases' as const, key: p.release.id, version: '1', sha256: journalConditionHash({ source: 'verified private target' }) }
  const planned = await store.planAction(p.prepared.token, p.action, async () => ({ target: p.target, condition }))
  expect(planned.conditions.records[1]).toEqual(condition)
  await expect(store.planAction(p.prepared.token, p.action, async () => ({ target: p.target, condition: { ...condition, key: randomUUID() } }))).rejects.toHaveProperty('code', 'corrupt')
  expect(begin).toHaveBeenCalledTimes(2); expect(ended.mock.calls).toEqual([['admitted'], ['admitted']]); expect(events).toHaveLength(1)
})

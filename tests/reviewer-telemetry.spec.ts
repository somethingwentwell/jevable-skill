import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parse } from 'yaml'
import { LocalRuntime, prepareGrantToken } from '../src/runtime/index.ts'
import { traceNavigationTools } from '../src/telemetry/navigation.ts'
import { traceRecords } from '../scripts/check-postgres-telemetry.mjs'
import { logRecords, metricSums } from '../scripts/check-telemetry-package.mjs'

const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const loop = await readFile(new URL('../examples/loop-approval.yaml', import.meta.url), 'utf8')
const model = parse(approval)
model.spec.nodes.draft = { type: 'llm', config: { provider: 'fixture', model: 'review-fixture',
  connection: { mode: 'workspace', id: 'review-model' }, prompt: '${{ inputs.message }}', responseFormat: 'text',
  generation: { maxTokens: 20, stream: false }, historyScope: 'none', execution: { timeoutSeconds: 10, maxAttempts: 1 } } }
model.spec.nodes.result.config.value = '${{ nodes.draft.output }}'
model.spec.edges = [{ from: 'start', to: 'review' }, { from: 'review', port: 'approve', to: 'draft' }, { from: 'draft', to: 'result' }]
const source = JSON.stringify(model), cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
const request = (action: 'approve' | 'reject' = 'approve', pauseAfter = true) => ({ requestId: randomUUID(), action, pauseAfter })

/** Real private HTTP/protobuf and model bytes, not SDK exporter mocks or a deployed/production profile. */
async function fixture(sampleRatio: number, yaml = source, input: unknown = { message: 'PRIVATE_REVIEW_PROMPT' }) {
  const received: { path: string; bytes: Buffer }[] = [], modelRequests: { auth?: string; body: unknown }[] = []
  let unavailable = false
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
    const bytes = Buffer.concat(chunks)
    if (req.url === '/v1/chat/completions') {
      modelRequests.push({ ...(req.headers.authorization ? { auth: req.headers.authorization } : {}), body: JSON.parse(bytes.toString()) })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'PRIVATE_REVIEW_REPLY' } }],
        usage: { prompt_tokens: 7, completion_tokens: 3 } })); return
    }
    expect(['/v1/traces', '/v1/logs', '/v1/metrics']).toContain(req.url)
    expect(req.headers['content-type']).toBe('application/x-protobuf')
    received.push({ path: req.url!, bytes }); res.writeHead(unavailable ? 503 : 200, { 'content-type': 'application/x-protobuf' }); res.end()
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('private fixture listener missing')
  const base = `http://127.0.0.1:${address.port}`, directory = await mkdtemp(join(tmpdir(), 'jevable-reviewer-telemetry-'))
  const config = { endpoint: `${base}/v1/traces`, logsEndpoint: `${base}/v1/logs`, metricsEndpoint: `${base}/v1/metrics`,
    authentication: { kind: 'none' as const }, sampleRatio, intervalMs: 60000, timeoutMs: 1000 }
  const owner = await LocalRuntime.open({ dataDirectory: directory, telemetry: config }); cleanup.push(() => owner.close())
  owner.configureConnection({ id: 'review-model', provider: 'fixture', protocol: 'openai-compatible', endpoint: `${base}/v1`,
    allowedModels: ['review-fixture'], authentication: { kind: 'bearer', credentialRef: 'review/model' },
    tokenParameter: 'max_tokens', maxRequestBytes: 100_000, maxResponseBytes: 100_000, maxTimeoutSeconds: 60, maxStreamEvents: 100 }, 0, 'PRIVATE_REVIEW_OWNER')
  owner.setCredential('review/model', 'PRIVATE_REVIEW_MODEL_KEY', 0, 'PRIVATE_REVIEW_OWNER')
  const run = await owner.run(yaml, input)
  const issue = async (value = run) => {
    if (value.state.status !== 'waiting') throw Error('expected exact reviewer wait')
    const prepared = prepareGrantToken(randomUUID())
    await owner.issueGrant({ id: prepared.id, tokenSha256: prepared.tokenSha256, actor: 'PRIVATE_REVIEW_OWNER', expiresAt: new Date(Date.now() + 3600000).toISOString(),
      scope: { kind: 'reviewer', runId: value.id, revision: value.revision, attemptId: value.state.attempt.id, decisions: ['approve', 'reject'] } })
    return prepared
  }
  const prepared = await issue()
  const traces = () => received.filter(r => r.path === '/v1/traces').flatMap(r => traceRecords(r.bytes))
  const logs = () => received.filter(r => r.path === '/v1/logs').flatMap(r => logRecords(r.bytes))
  const metrics = () => received.filter(r => r.path === '/v1/metrics').flatMap(r => metricSums(r.bytes))
  const approvalPoints = () => metrics().filter(m => m.name === 'jevable.execution.segments').flatMap(m => m.points).filter(p => p.labels['jevable.operation'] === 'approval')
  return { owner, directory, config, run, prepared, issue, received, modelRequests, traces, logs, metrics, approvalPoints,
    unavailable() { unavailable = true } }
}

describe('atomic delegated reviewer tracing and actual fixture model execution (SQLite host only)', () => {
  it.each([0, 1].flatMap(sampleRatio => [
    { sampleRatio, action: 'approve' as const, pauseAfter: true, status: 'paused', calls: 0 },
    { sampleRatio, action: 'approve' as const, pauseAfter: false, status: 'completed', calls: 1 },
    { sampleRatio, action: 'reject' as const, pauseAfter: true, status: 'failed', calls: 0 },
  ]))('joins retained decision, actual model and received signals ($sampleRatio, $action, $pauseAfter)', async row => {
    const f = await fixture(row.sampleRatio), selected = request(row.action, row.pauseAfter), originalEvents = await f.owner.events(f.run.id)
    const receipt = await f.owner.decideWithGrant(f.prepared.token, selected)
    expect(receipt.status).toBe(row.status); expect(f.modelRequests).toHaveLength(row.calls)
    const saved = await f.owner.show(f.run.id), events = await f.owner.events(f.run.id), segment = saved.traceSegments!.at(-1)!
    expect(saved.traceSegments).toHaveLength(2)
    expect(segment.trace.traceFlags).toBe(row.sampleRatio)
    expect(events.slice(originalEvents.length).filter(e => e.kind === 'execution-segment')).toEqual([])
    const event = events.find(e => e.kind === 'approval-decided')!.data as any
    expect(event.segment).toEqual(segment); expect(segment.at).toBe(receipt.at); expect(segment.previous).toEqual(f.run.traceSegments![0]!.trace)
    await f.owner.telemetryFlush()
    const span = f.traces().find(s => s.name === 'jevable.approval')
    if (row.sampleRatio) {
      expect(span).toMatchObject({ traceId: segment.trace.traceId, spanId: segment.trace.spanId,
        attributes: { 'jevable.node.id': 'review', 'jevable.attempt.id': receipt.attemptId, 'jevable.outcome': row.status } })
      expect((span as any).links).toEqual([{ traceId: segment.previous!.traceId, spanId: segment.previous!.spanId }])
    } else expect(f.traces()).toEqual([])
    const logs = f.logs().filter(l => l.event === 'jevable.execution.segment.ended' && l.attributes['jevable.operation'] === 'approval')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ traceId: segment.trace.traceId, spanId: segment.trace.spanId,
      attributes: { 'jevable.node.id': 'review', 'jevable.attempt.id': receipt.attemptId, 'jevable.outcome': row.status } })
    expect(f.approvalPoints().at(-1)).toMatchObject({ value: 1, labels: { 'jevable.operation': 'approval', 'jevable.outcome': row.status } })
    if (row.calls) {
      expect(f.modelRequests[0]!.auth).toBe('Bearer PRIVATE_REVIEW_MODEL_KEY')
      const draft = saved.state.steps.find(s => s.nodeId === 'draft')!
      const evidence = await f.owner.exportRun(f.run.id)
      expect(evidence.snapshot.models!.calls).toHaveLength(1)
      const modelSpan = f.traces().find(s => s.name === 'jevable.model')
      if (row.sampleRatio) expect(modelSpan).toMatchObject({ parent: draft.inspection!.trace!.spanId, attributes: { 'gen_ai.usage.input_tokens': 7, 'gen_ai.usage.output_tokens': 3 } })
    }
    const evidence = await f.owner.exportRun(f.run.id), projected = evidence.snapshot.journal.find(e => e.kind === 'approval-decided') as any
    expect(projected.trace).toEqual(segment.trace); expect(projected.previous).toEqual(segment.previous)
    expect(traceNavigationTools().project(evidence.snapshot).references).toContainEqual(expect.objectContaining({ source: 'journal-trace', ...segment.trace }))
    const diagnostic = JSON.stringify([evidence, f.traces(), f.logs(), f.metrics()])
    for (const privateValue of ['PRIVATE_REVIEW', f.prepared.id, f.prepared.token, f.prepared.tokenSha256, selected.requestId, 'delegation']) expect(diagnostic).not.toContain(privateValue)
    for (const metric of f.metrics()) for (const point of metric.points)
      for (const label of ['jevable.run.id', 'jevable.attempt.id', 'jevable.node.id', 'jevable.grant.id']) expect(point.labels).not.toHaveProperty(label)
    const packets = f.received.length
    expect(await f.owner.decideWithGrant(f.prepared.token, selected)).toEqual(receipt)
    expect(await f.owner.events(f.run.id)).toEqual(events); await f.owner.telemetryFlush(); expect(f.received).toHaveLength(packets)
    await f.owner.close()
    const reopened = await LocalRuntime.open({ dataDirectory: f.directory, telemetry: f.config }); cleanup.push(() => reopened.close())
    expect(await reopened.show(f.run.id)).toEqual(saved)
    expect(await reopened.decideWithGrant(f.prepared.token, selected)).toEqual(receipt)
    await reopened.telemetryFlush(); expect(f.received).toHaveLength(packets); expect(f.modelRequests).toHaveLength(row.calls)
  })
  it.each([0, 1])('observes failed/uncertain writers without fabricating durable traces or continuing ($sampleRatio)', async sampleRatio => {
    const f = await fixture(sampleRatio), selected = request('approve', false), before = await f.owner.show(f.run.id), originalEvents = await f.owner.events(f.run.id)
    const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'))
    try {
      db.exec("CREATE TRIGGER reviewer_trace_failure BEFORE INSERT ON events WHEN NEW.kind='approval-decided' BEGIN SELECT RAISE(ABORT,'PRIVATE_REVIEW_DISK_FAILURE'); END")
      await expect(f.owner.decideWithGrant(f.prepared.token, selected)).rejects.toThrow('PRIVATE_REVIEW_DISK_FAILURE')
      expect(await f.owner.show(f.run.id)).toEqual(before); expect(await f.owner.events(f.run.id)).toEqual(originalEvents)
    } finally { db.exec('DROP TRIGGER reviewer_trace_failure'); db.close() }
    expect(f.modelRequests).toEqual([]); await f.owner.telemetryFlush()
    expect(f.logs().find(l => l.attributes['jevable.operation'] === 'approval')).toMatchObject({ attributes: { 'jevable.outcome': 'failed-or-uncertain' } })
    if (sampleRatio) expect(f.traces().find(s => s.name === 'jevable.approval')).toMatchObject({ attributes: { 'jevable.outcome': 'failed-or-uncertain' } })
    expect(JSON.stringify([f.traces(), f.logs(), f.metrics()])).not.toContain('PRIVATE_REVIEW')
    expect((await f.owner.decideWithGrant(f.prepared.token, { ...selected, pauseAfter: true })).status).toBe('paused')
    expect((await f.owner.show(f.run.id)).traceSegments).toHaveLength(2)
    expect(f.modelRequests).toEqual([])
  })
  it.each([0, 1])('preserves the actual atomic decision after lost COMMIT acknowledgment; retry/reopen creates no telemetry or model work ($sampleRatio)', async sampleRatio => {
    const f = await fixture(sampleRatio), selected = request('approve', false), original = DatabaseSync.prototype.exec
    let armed = true
    const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function(this: DatabaseSync, sql: string) {
      original.call(this, sql)
      if (armed && sql === 'COMMIT') { armed = false; throw Error('PRIVATE_REVIEW_LOST_COMMIT') }
    })
    try { await expect(f.owner.decideWithGrant(f.prepared.token, selected)).rejects.toThrow('PRIVATE_REVIEW_LOST_COMMIT') } finally { spy.mockRestore() }
    const saved = await f.owner.show(f.run.id), events = await f.owner.events(f.run.id), segment = saved.traceSegments!.at(-1)!
    expect(saved.state.status).toBe('paused'); expect(saved.traceSegments).toHaveLength(2)
    expect((events.at(-1)!.data as any).segment).toEqual(segment); expect(f.modelRequests).toEqual([])
    await f.owner.telemetryFlush()
    expect(f.logs().find(l => l.spanId === segment.trace.spanId)).toMatchObject({ attributes: { 'jevable.outcome': 'failed-or-uncertain' } })
    const packets = f.received.length; await f.owner.close()
    const reopened = await LocalRuntime.open({ dataDirectory: f.directory, telemetry: f.config }); cleanup.push(() => reopened.close())
    expect((await reopened.decideWithGrant(f.prepared.token, selected)).status).toBe('paused')
    expect(await reopened.show(f.run.id)).toEqual(saved); expect(await reopened.events(f.run.id)).toEqual(events)
    await reopened.telemetryFlush(); expect(f.received).toHaveLength(packets); expect(f.modelRequests).toEqual([])
  })
  it.each([0, 1])('contains Collector loss without rolling back the decision or redispatching on receipt retry ($sampleRatio)', async sampleRatio => {
    const f = await fixture(sampleRatio), selected = request('approve', false)
    await f.owner.telemetryFlush(); f.unavailable()
    expect((await f.owner.decideWithGrant(f.prepared.token, selected)).status).toBe('completed')
    const saved = await f.owner.show(f.run.id), events = await f.owner.events(f.run.id), status = await f.owner.telemetryFlush()
    if (!('logs' in status) || !status.logs || !('metrics' in status) || !status.metrics || !('failedBatches' in status)) throw Error('expected all three configured signal statuses')
    expect(status.logs.failedBatches).toBeGreaterThan(0); expect(status.metrics.failedBatches).toBeGreaterThan(0)
    if (sampleRatio) expect(status.failedBatches).toBeGreaterThan(0)
    const packets = f.received.length
    expect((await f.owner.decideWithGrant(f.prepared.token, selected)).status).toBe('completed')
    expect(await f.owner.show(f.run.id)).toEqual(saved); expect(await f.owner.events(f.run.id)).toEqual(events)
    await f.owner.telemetryFlush(); expect(f.received).toHaveLength(packets); expect(f.modelRequests).toHaveLength(1)
  })
  it.each([0, 1])('links scoped loop reviewer segments across iterations; old requests only observe ($sampleRatio)', async sampleRatio => {
    const f = await fixture(sampleRatio, loop, ['PRIVATE_REVIEW_FIRST', 'PRIVATE_REVIEW_SECOND']), selected = request('approve', false)
    expect((await f.owner.decideWithGrant(f.prepared.token, selected)).status).toBe('waiting')
    const second = await f.owner.show(f.run.id), next = await f.issue(second), rejection = request('reject')
    expect((await f.owner.decideWithGrant(next.token, rejection)).status).toBe('paused')
    await f.owner.telemetryFlush()
    const logs = f.logs().filter(l => l.attributes['jevable.operation'] === 'approval')
    expect(logs.map(l => l.attributes['jevable.loop.index'])).toEqual([0, 1])
    expect(logs.map(l => l.attributes['jevable.node.id'])).toEqual(['review', 'review'])
    const saved = await f.owner.show(f.run.id)
    expect(saved.traceSegments).toHaveLength(3)
    expect(saved.traceSegments![2]!.previous).toEqual(saved.traceSegments![1]!.trace)
    const packets = f.received.length
    expect((await f.owner.decideWithGrant(f.prepared.token, selected)).status).toBe('paused')
    await f.owner.telemetryFlush(); expect(f.received).toHaveLength(packets)
  })
  it('records an explicit trace parent and refuses unauthorized retries before starting an approval segment', async () => {
    const f = await fixture(1), selected = request()
    await f.owner.telemetryFlush(); const packets = f.received.length
    await expect(f.owner.decideWithGrant('a'.repeat(64), selected)).rejects.toHaveProperty('code', 'not-found')
    await f.owner.telemetryFlush(); expect(f.received).toHaveLength(packets)
    await f.owner.withTraceParent('00-11111111111111111111111111111111-2222222222222222-01', () => f.owner.decideWithGrant(f.prepared.token, selected))
    const segment = (await f.owner.show(f.run.id)).traceSegments!.at(-1)!
    expect(segment.parent).toMatchObject({ traceId: '1'.repeat(32), spanId: '2'.repeat(16) })
    await f.owner.telemetryFlush()
    expect(f.traces().find(s => s.name === 'jevable.approval')).toMatchObject({ traceId: '1'.repeat(32), parent: '2'.repeat(16), spanId: segment.trace.spanId })
  })
})

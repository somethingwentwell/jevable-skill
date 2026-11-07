import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LocalRuntime, prepareGrantToken } from '../src/runtime/index.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { RunStore } from '../src/runtime/store.ts'
import { traceNavigationTools } from '../src/telemetry/navigation.ts'
import { traceRecords } from '../scripts/check-postgres-telemetry.mjs'
import { logRecords } from '../scripts/check-telemetry-package.mjs'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const model = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'cancel', name: 'Cancel fixture' },
  spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
    write: { type: 'llm', config: { provider: 'fixture', model: 'fixture', connection: { mode: 'workspace', id: 'fixture' },
      prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 20, stream: false },
      execution: { timeoutSeconds: 10, maxAttempts: 1 }, historyScope: 'none' } },
    end: { type: 'output', config: { value: '${{ nodes.write.output }}' } } },
  edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }] } })
const startParent = `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`
const cancelParent = `00-${'3'.repeat(32)}-${'4'.repeat(16)}-00`
const retryParent = `00-${'5'.repeat(32)}-${'6'.repeat(16)}-01`
const admission = { traceId: '3'.repeat(32), spanId: '4'.repeat(16), traceFlags: 0 }
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

/** Actual private HTTP/protobuf receiver and a held configured-model POST, not a production/deployed profile. */
async function fixture(source = echo, sampleRatio = 0) {
  const received: { path: string; bytes: Buffer }[] = [], modelParents: unknown[] = [], entered = Promise.withResolvers<void>()
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
    if (req.url === '/v1/chat/completions') { modelParents.push(req.headers.traceparent); entered.resolve(); return }
    received.push({ path: req.url!, bytes: Buffer.concat(chunks) }); res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.end()
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('fixture missing')
  const base = `http://127.0.0.1:${address.port}`, directory = await mkdtemp(join(tmpdir(), 'jevable-cancellation-cause-'))
  const telemetry = { endpoint: `${base}/v1/traces`, logsEndpoint: `${base}/v1/logs`, authentication: { kind: 'none' as const },
    sampleRatio, intervalMs: 60000, timeoutMs: 1000 }
  const owner = await LocalRuntime.open({ dataDirectory: directory, telemetry }); cleanup.push(() => owner.close())
  owner.configureConnection({ id: 'fixture', provider: 'fixture', protocol: 'openai-compatible', endpoint: `${base}/v1`,
    allowedModels: ['fixture'], authentication: { kind: 'none' }, tracePropagation: 'w3c', tokenParameter: 'max_tokens',
    maxRequestBytes: 100000, maxResponseBytes: 100000, maxTimeoutSeconds: 60, maxStreamEvents: 100 }, 0, 'PRIVATE_CAUSE_OWNER')
  const project = owner.editProject({ operation: 'create', title: 'Fixture', yaml: source, actor: 'PRIVATE_CAUSE_OWNER' })
  const release = owner.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision,
    version: '1.0.0', actor: 'PRIVATE_CAUSE_OWNER', runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
  const grant = prepareGrantToken(randomUUID())
  await owner.issueGrant({ id: grant.id, tokenSha256: grant.tokenSha256, actor: 'PRIVATE_CAUSE_OWNER',
    expiresAt: new Date(Date.now() + 3600000).toISOString(), scope: { kind: 'caller',
      release: { id: release.snapshot.id, sha256: release.sha256, revision: release.snapshot.workflow.revision }, permissions: ['start', 'cancel'] } })
  return { owner, directory, telemetry, grant, received, modelParents, entered,
    traces: () => received.filter(r => r.path === '/v1/traces').flatMap(r => traceRecords(r.bytes)),
    logs: () => received.filter(r => r.path === '/v1/logs').flatMap(r => logRecords(r.bytes)) }
}

describe('durable cancellation admission causality (SQLite host, received fixture signals)', () => {
  it('deduplicates coincident predecessor/admission links while retaining both roles and original flags', async () => {
    const f = await fixture(approval, 1), waiting = await f.owner.run(approval, { message: 'private' })
    const previous = waiting.traceSegments!.at(-1)!.trace, requestId = randomUUID()
    const header = `00-${previous.traceId}-${previous.spanId}-00`
    const stopped = f.owner.withTraceParent(header, () => f.owner.cancel(waiting.id, requestId, 'owner:test'))
    const segment = stopped.traceSegments!.at(-1)!
    expect(segment.previous).toEqual(previous); expect(segment.cause!.parent).toEqual({ ...previous, traceFlags: 0 })
    await f.owner.telemetryFlush()
    expect(f.traces().find(s => s.name === 'jevable.cancel')).toMatchObject({ links: [{ traceId: previous.traceId, spanId: previous.spanId }] })
  })

  it('enabling telemetry on an old context-free cancellation never invents admission or settlement history', async () => {
    const f = await fixture(), directory = await mkdtemp(join(tmpdir(), 'jevable-old-cancellation-'))
    const original = await LocalRuntime.open({ dataDirectory: directory }); cleanup.push(() => original.close())
    const run = await original.run(echo, 'private', { paused: true }), requestId = randomUUID()
    const saved = original.withTraceParent(cancelParent, () => original.cancel(run.id, requestId, 'owner:test'))
    expect(saved.cancellation?.traceParent).toBeUndefined(); expect(saved.traceSegments).toBeUndefined(); await original.close()
    const reopened = await LocalRuntime.open({ dataDirectory: directory, telemetry: f.telemetry }); cleanup.push(() => reopened.close())
    expect(reopened.withTraceParent(retryParent, () => reopened.cancel(run.id, requestId, 'owner:retry'))).toEqual(saved)
    await reopened.telemetryFlush(); expect(f.received).toEqual([])
  })

  it.each([0, 1].flatMap(sample => ['paused', 'waiting', 'active'].map(mode => ({ sample, mode }))))(
    'retains the first admission context and worker ancestry ($sample, $mode)', async ({ sample, mode }) => {
      const f = await fixture(mode === 'active' ? model : mode === 'waiting' ? approval : echo, sample)
      const id = randomUUID(), request = { requestId: randomUUID() }
      const pending = f.owner.withTraceParent(startParent, () => f.owner.startWithGrant(f.grant.token,
        mode === 'waiting' ? { message: 'PRIVATE_CAUSE_INPUT' } : 'PRIVATE_CAUSE_INPUT', { id, paused: mode === 'paused' }))
      if (mode === 'active') await f.entered.promise; else await pending
      const receipt = await f.owner.withTraceParent(cancelParent, () => f.owner.cancelWithGrant(f.grant.token, id, request))
      expect(receipt.status).toBe(mode === 'active' ? 'executing' : 'cancelled')
      await pending
      const saved = await f.owner.show(id), events = await f.owner.events(id), segment = saved.traceSegments!.at(-1)!
      const cause = { kind: 'cancellation', requestId: request.requestId, parent: admission }
      expect(saved.cancellation?.traceParent).toEqual(admission); expect(segment.cause).toEqual(cause)
      expect(segment.parent).toEqual(mode === 'active' ? saved.traceSegments![0]!.parent : admission)
      expect(segment.previous).toEqual(saved.traceSegments!.at(-2)?.trace); expect(segment.trace.traceFlags).toBe(sample)
      expect(events.find(e => e.kind === 'cancellation-requested')?.data).toEqual(saved.cancellation)
      const exported = await f.owner.exportRun(id), projected = exported.snapshot.journal.find(e => e.kind === 'execution-segment' && 'operation' in e && e.operation === 'cancel')
      expect(projected).toMatchObject({ cause }); expect(exported.snapshot.run.cancellation?.traceParent).toEqual(admission)
      const refs = traceNavigationTools().project(exported.snapshot).references
      for (const source of ['cancellation-admission', 'segment-cause', 'journal-cancellation-admission', 'journal-cause'])
        expect(refs).toContainEqual(expect.objectContaining({ source, ...admission, requestId: request.requestId }))
      await f.owner.telemetryFlush()
      const cancel = f.traces().filter(s => s.name === 'jevable.cancel')
      expect(cancel).toHaveLength(sample)
      const attributes = { 'jevable.cancellation.request_id': request.requestId,
        'jevable.cancellation.trace_id': admission.traceId, 'jevable.cancellation.span_id': admission.spanId }
      if (sample) expect(cancel[0]).toMatchObject({ parent: segment.parent!.spanId,
        links: [segment.previous, admission].filter(t => t !== undefined).map(t => ({ traceId: t!.traceId, spanId: t!.spanId })), attributes })
      expect(f.logs().find(l => l.attributes['jevable.operation'] === 'cancel')).toMatchObject({ attributes })
      for (const secret of ['PRIVATE_CAUSE', f.grant.id, f.grant.token, f.grant.tokenSha256])
        expect(JSON.stringify([exported, f.traces(), f.logs()])).not.toContain(secret)
      const packets = f.received.length
      const retry = () => f.owner.withTraceParent(retryParent, () => f.owner.cancelWithGrant(f.grant.token, id, request))
      const terminalReceipt = await retry()
      expect(terminalReceipt.status).toBe('cancelled'); expect(await f.owner.events(id)).toEqual(events)
      expect(await f.owner.show(id)).toEqual(saved); await f.owner.telemetryFlush(); expect(f.received).toHaveLength(packets)
      await f.owner.close()
      const reopened = await LocalRuntime.open({ dataDirectory: f.directory, telemetry: f.telemetry }); cleanup.push(() => reopened.close())
      expect(await reopened.withTraceParent(retryParent, () => reopened.cancelWithGrant(f.grant.token, id, request))).toEqual(terminalReceipt)
      expect(await reopened.show(id)).toEqual(saved); await reopened.telemetryFlush(); expect(f.received).toHaveLength(packets)
      expect(f.modelParents).toHaveLength(mode === 'active' ? 1 : 0)
    })

  it.each([false, true])('owner cancellation keeps first admission, and absent context stays absent (parent=%s)', async parent => {
    const f = await fixture(), run = await f.owner.run(echo, 'private', { paused: true }), request = randomUUID()
    const saved = f.owner.withTraceParent(parent ? cancelParent : undefined, () => f.owner.cancel(run.id, request, 'owner:test'))
    expect(saved.cancellation?.traceParent).toEqual(parent ? admission : undefined)
    expect(saved.traceSegments!.at(-1)!.cause).toEqual(parent ? { kind: 'cancellation', requestId: request, parent: admission } : undefined)
    expect(f.owner.withTraceParent(retryParent, () => f.owner.cancel(run.id, request, 'owner:retry'))).toEqual(saved)
  })

  it('lost admission acknowledgement retains the original context but retry does not settle or observe it', async () => {
    const f = await fixture(), id = randomUUID(), request = { requestId: randomUUID() }
    await f.owner.startWithGrant(f.grant.token, 'private', { id, paused: true })
    const original = RunStore.prototype.saveCallerCancellation
    const fault = vi.spyOn(RunStore.prototype, 'saveCallerCancellation').mockImplementation(function (this: RunStore, ...args) {
      original.apply(this, args); throw Error('fixture lost admission acknowledgment')
    })
    await expect(f.owner.withTraceParent(cancelParent, () => f.owner.cancelWithGrant(f.grant.token, id, request))).rejects.toThrow('fixture lost admission')
    fault.mockRestore(); const saved = await f.owner.show(id), events = await f.owner.events(id)
    expect(saved.cancellation?.traceParent).toEqual(admission); expect(saved.state.status).toBe('paused')
    expect((await f.owner.withTraceParent(retryParent, () => f.owner.cancelWithGrant(f.grant.token, id, request))).status).toBe('paused')
    expect(await f.owner.show(id)).toEqual(saved); expect(await f.owner.events(id)).toEqual(events)
    expect(f.logs().some(l => l.attributes['jevable.operation'] === 'cancel')).toBe(false)
  })

  it.each(['missing-cause', 'cause-parent', 'cause-request', 'wrong-operation', 'snapshot-only', 'journal-only'])(
    'refuses retained %s corruption without inventing history', async damage => {
      const f = await fixture(), id = randomUUID(), request = { requestId: randomUUID() }
      await f.owner.startWithGrant(f.grant.token, 'private', { id, paused: true })
      await f.owner.withTraceParent(cancelParent, () => f.owner.cancelWithGrant(f.grant.token, id, request)); await f.owner.close()
      const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'))
      try {
        const record = JSON.parse(db.prepare('SELECT record FROM runs WHERE id=?').get(id)!.record as string)
        const segment = record.traceSegments.at(-1)
        if (damage === 'missing-cause') delete segment.cause
        if (damage === 'cause-parent') segment.cause.parent.spanId = '7'.repeat(16)
        if (damage === 'cause-request') segment.cause.requestId = randomUUID()
        if (damage === 'wrong-operation') segment.operation = 'resume'
        if (damage === 'snapshot-only') segment.parent.spanId = '7'.repeat(16)
        if (damage !== 'journal-only') db.prepare('UPDATE runs SET record=? WHERE id=?').run(JSON.stringify(record), id)
        if (damage !== 'snapshot-only') db.prepare("UPDATE events SET data=? WHERE run_id=? AND kind='execution-segment' AND json_extract(data,'$.operation')='cancel'")
          .run(JSON.stringify(damage === 'journal-only' ? { ...segment, cause: undefined } : segment), id)
      } finally { db.close() }
      await expect(LocalRuntime.open({ dataDirectory: f.directory })).rejects.toHaveProperty('code', 'corrupt')
    })
})

import { DatabaseSync } from 'node:sqlite'
import { createServer, type RequestListener } from 'node:http'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeTelemetry } from '../src/telemetry/traces.ts'
import { executeWorkflow, type ExecutionPersistence } from '../src/runtime/execution.ts'
import { compileLocalRun, initialCheckpoint } from '../src/runtime/run-evaluator.ts'
import { localRunSchema, type LocalRun } from '../src/runtime/run-types.ts'
import { DEFAULT_COMPILER_LIMITS as limits } from '../src/limits.ts'
import { ConfiguredModels } from '../src/providers/model-calls.ts'
import { ProviderStore } from '../src/providers/store.ts'
import type { ProviderPersistence } from '../src/providers/persistence.ts'
import { modelEvidenceVersion } from '../src/providers/evidence-transition.ts'
import type { ModelEvidence } from '../src/providers/records.ts'
import { traceRecords } from '../scripts/check-postgres-telemetry.mjs'
import { logRecords } from '../scripts/check-telemetry-package.mjs'

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const source = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'backoff-journal', name: 'Backoff interruption' },
  spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
    model: { type: 'llm', config: { provider: 'fixture', model: 'fixture-model', connection: { mode: 'workspace', id: 'fixture' },
      prompt: '${{ inputs }}', responseFormat: 'text', historyScope: 'none', generation: { maxTokens: 30, stream: false },
      execution: { maxAttempts: 2, timeoutSeconds: 5 } } }, result: { type: 'output', config: { value: '${{ nodes.model.output }}' } } },
    edges: [{ from: 'start', to: 'model' }, { from: 'model', to: 'result' }] } })
async function server(handler: RequestListener) {
  const listener = createServer(handler)
  await new Promise<void>((yes, no) => { listener.once('error', no); listener.listen(0, '127.0.0.1', yes) })
  cleanup.push(() => new Promise<void>(yes => { listener.close(() => yes()); listener.closeAllConnections() }))
  const address = listener.address(); if (!address || typeof address === 'string') throw Error('Missing private fixture listener')
  return 'http://127.0.0.1:' + address.port
}

// Actual configured HTTP/retry/shared driver/OTLP. Journal transactions and run persistence
// are simulated, while model evidence uses SQLite. This does not qualify real PostgreSQL.
async function fixture(sampleRatio: number, mode: 'cancel' | 'failed-cancel-write' | 'owner-loss') {
  const packets: { route: string; bytes: Buffer }[] = [], requests: unknown[] = [], writes: ModelEvidence[] = []
  const cancellation = new AbortController(), ownership = new AbortController(), failure = Error('PRIVATE_BACKOFF_STORAGE_FAILURE')
  const collector = await server(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
    packets.push({ route: req.url!, bytes: Buffer.concat(chunks) }); res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.end()
  })
  const endpoint = await server(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString()))
    res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '2' }); res.end('{}')
  })
  const telemetry = new RuntimeTelemetry({ endpoint: collector + '/v1/traces', logsEndpoint: collector + '/v1/logs',
    authentication: { kind: 'none' }, sampleRatio, journalTransactions: true, intervalMs: 60000, timeoutMs: 1000, flushTimeoutMs: 2000 },
  () => undefined, { storage: 'postgres' })
  cleanup.push(() => telemetry.close())
  const starts = vi.spyOn(telemetry, 'start') // Pass-through diagnostics only; no replaced business methods.
  async function journal<T>(kind: 'read' | 'write', work: () => T | Promise<T>): Promise<T> {
    const observation = telemetry.observeJournalTransaction(kind)
    try { const value = await work(); observation?.end('acknowledged'); return value }
    catch (error) { observation?.end('failed-before-commit'); throw error }
  }
  const database = new DatabaseSync(':memory:'); database.exec('CREATE TABLE model_calls(attempt_id TEXT PRIMARY KEY,record TEXT NOT NULL)')
  cleanup.push(() => database.close()); const durable = new ProviderStore(database, 100_000)
  const store: ProviderPersistence = { signal: ownership.signal,
    connection: () => journal('read', () => ({ generation: 1, updatedAt: new Date().toISOString(), connection: {
      id: 'fixture', provider: 'fixture', protocol: 'openai-compatible', endpoint: endpoint + '/v1', allowedModels: ['fixture-model'],
      authentication: { kind: 'none' }, tokenParameter: 'max_tokens', maxResponseBytes: 10000, maxRequestBytes: 10000,
      maxStreamEvents: 100, maxTimeoutSeconds: 5 } })), credential: () => journal('read', () => undefined),
    evidence: id => journal('read', () => durable.evidence(id)), saveEvidence: record => journal('write', () => {
      if (mode === 'failed-cancel-write' && modelEvidenceVersion(record) === 3) throw failure
      durable.saveEvidence(record); writes.push(structuredClone(record))
    }) }
  const graph = compileLocalRun(source, limits), at = new Date().toISOString()
  let record: LocalRun = { schemaVersion: 1, id: randomUUID(), yaml: graph.source.yaml, revision: graph.source.revision,
    input: 'PRIVATE_BACKOFF_INPUT', createdAt: at, updatedAt: at, state: initialCheckpoint(graph), loopDeadlines: {} }
  const events: { kind: string; data: unknown }[] = []
  const port: ExecutionPersistence = { load: () => journal('read', () => structuredClone(record)),
    events: () => journal('read', () => structuredClone(events)), save: (next, kind, data) => journal('write', () => {
      record = localRunSchema.parse(next) as LocalRun; events.push({ kind, data: structuredClone(data) })
    }), saveSegment: next => journal('write', () => { record = next; return next }), finishCancellation: next => journal('write', () => next) }
  return { telemetry, starts, packets, requests, writes, durable, failure, cancellation, ownership,
    record: () => structuredClone(record), events: () => structuredClone(events),
    run: () => executeWorkflow({ initial: structuredClone(record), graph, limits, maxTransitions: 100,
      operation: 'run', signal: cancellation.signal, port, models: new ConfiguredModels(store), telemetry }),
    spans: () => packets.filter(p => p.route === '/v1/traces').flatMap(p => traceRecords(p.bytes)),
    logs: () => packets.filter(p => p.route === '/v1/logs').flatMap(p => logRecords(p.bytes)) }
}

describe('model backoff interruption journal ancestry (source fixture, not PostgreSQL)', () => {
  it.each([0, 1].flatMap(sample => (['cancel', 'failed-cancel-write', 'owner-loss'] as const).map(mode => ({ sample, mode }))))(
    'retains single-try evidence and live enclosing ancestry ($sample, $mode)', async ({ sample, mode }) => {
      const f = await fixture(sample, mode)
      // Install a rejection handler immediately; waiting for a read-only diagnostic is not execution retry.
      const pending = f.run().then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
      await vi.waitFor(() => expect(f.starts.mock.calls.filter(([name]) => name === 'jevable.model.backoff')).toHaveLength(1),
        { timeout: 1500, interval: 5 })
      expect(f.requests).toHaveLength(1); expect(f.writes.map(modelEvidenceVersion)).toEqual([1, 2])
      const before = structuredClone(f.writes[1]!)
      if (mode === 'owner-loss') f.ownership.abort(f.failure); else f.cancellation.abort(Error('PRIVATE_BACKOFF_CANCEL'))
      const outcome = await pending
      if (mode === 'cancel') expect(outcome.error).toMatchObject({ code: 'cancelled' })
      else expect(outcome.error).toBe(f.failure)
      expect(outcome.value).toBeUndefined(); expect(f.requests).toHaveLength(1)
      expect(f.writes.map(modelEvidenceVersion)).toEqual(mode === 'cancel' ? [1, 2, 3] : [1, 2])
      const retained = f.durable.evidence(before.attemptId)!
      if (retained.schemaVersion !== 2 || before.schemaVersion !== 2) throw Error('Missing retry evidence')
      expect(retained.tries).toEqual(before.tries); expect(retained.tries).toHaveLength(1)
      expect(retained.result).toEqual(mode === 'cancel' ? expect.objectContaining({ status: 'failed', code: 'cancelled' }) : { status: 'pending' })
      const record = f.record(), events = f.events()
      expect(record.state.status).toBe('executing'); expect(events.filter(e => e.kind === 'node-intent')).toHaveLength(2)
      expect(events.filter(e => e.kind === 'node-result')).toHaveLength(1) // Trigger only; no invented model settlement.
      await f.telemetry.flush()
      const spans = f.spans(), logs = f.logs(), expectedBackoff = mode === 'owner-loss' ? 'commit-or-execution-failed' : 'cancelled'
      expect(logs.filter(l => l.event === 'jevable.model.try.ended')).toHaveLength(1)
      expect(logs.filter(l => l.event === 'jevable.model.backoff.ended')).toHaveLength(1)
      expect(logs.find(l => l.event === 'jevable.model.backoff.ended')?.attributes['jevable.outcome']).toBe(expectedBackoff)
      if (sample) {
        const model = spans.find(s => s.name === 'jevable.model')!, attempt = spans.find(s => s.name === 'jevable.model.try')!,
          backoff = spans.find(s => s.name === 'jevable.model.backoff')!
        expect(spans.filter(s => s.name === 'jevable.model.try')).toHaveLength(1)
        expect(attempt.parent).toBe(model.spanId); expect(backoff.parent).toBe(model.spanId)
        expect(attempt.attributes['jevable.model.try.settled']).toBe(true)
        expect(backoff.attributes['jevable.outcome']).toBe(expectedBackoff)
        const journals = spans.filter(s => s.name === 'jevable.storage.journal.transaction')
        expect(journals.filter(s => s.parent === attempt.spanId && s.attributes['jevable.storage.transaction.kind'] === 'write')).toHaveLength(2)
        expect(journals.filter(s => s.parent === backoff.spanId)).toHaveLength(0)
        const final = journals.filter(s => s.parent === model.spanId && s.attributes['jevable.storage.transaction.kind'] === 'write')
        expect(final).toHaveLength(mode === 'owner-loss' ? 0 : 1)
        if (mode !== 'owner-loss') expect(final[0]!.attributes['jevable.storage.transaction.outcome'])
          .toBe(mode === 'cancel' ? 'acknowledged' : 'failed-before-commit')
      } else expect(spans).toHaveLength(0)
      for (const packet of f.packets) expect(packet.bytes.includes(Buffer.from('PRIVATE_'))).toBe(false)
      // An executing shared-driver record is returned unchanged, never dispatched again.
      // This is distinct from the configured adapter's uncertain-attempt refusal.
      expect(await f.run()).toEqual(record)
      expect(f.requests).toHaveLength(1); expect(f.record()).toEqual(record); expect(f.events()).toEqual(events)
      expect(f.durable.evidence(before.attemptId)).toEqual(retained)
    })
})

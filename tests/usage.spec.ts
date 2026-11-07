import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { LocalRuntime } from '../src/runtime/local.ts'
import { createUsageReport, inspectUsageSelection, inspectEvidenceSelection } from '../src/evidence/index.ts'
import { dispatchOperation } from '../src/http/operations.ts'
import { main } from '../src/cli.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
const selection = (...runs: { id: string; revision: string }[]) => ({ schemaVersion: 1, runs: runs.map(({ id, revision }) => ({ id, revision })) })
const digest = (snapshot: unknown) => createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-usage-')), runtime = await LocalRuntime.open({ dataDirectory: join(directory, 'state') })
  cleanup.push(() => runtime.close())
  const run = await runtime.run(echo, 'PRIVATE_INPUT')
  return { directory, runtime, run, evidence: await runtime.exportRun(run.id) }
}
function completed(inputTokens: number | undefined = 12, outputTokens: number | undefined = 3) {
  return { nodeId: 'decision', attemptId: randomUUID(), evidence: 'recorded', evidenceSchemaVersion: 1, status: 'completed',
    usage: { tries: 1, ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }) } }
}
async function projected(calls: unknown[] | undefined) {
  const f = await fixture(), envelope: any = structuredClone(f.evidence)
  if (calls === undefined) delete envelope.snapshot.models
  else envelope.snapshot.models.calls = calls
  envelope.checksum.value = digest(envelope.snapshot)
  const host = { exportRun: vi.fn(() => envelope) }
  return { ...f, envelope, host, report: () => createUsageReport(host, selection(f.run)) }
}
async function cli(args: string[]) {
  let out = '', err = ''
  const exit = await main(args, { out: value => { out += value }, err: value => { err += value } })
  return { exit, out: out ? JSON.parse(out) : undefined, err: err ? JSON.parse(err) : undefined }
}
describe('retained usage reporting', () => {
  const window = { from: '2020-01-01T00:00:00.000Z', before: '2020-01-02T00:00:00.000Z' }
  it('uses original intent time with inclusive start and exclusive end, retaining selected-source provenance', async () => {
    const times = ['2019-12-31T23:59:59.999Z', window.from, '2020-01-01T12:00:00.000Z', window.before]
    const f = await projected(times.map(intentAt => ({ ...completed(), intentAt })))
    const picked = { ...selection(f.run), window }, report = await createUsageReport(f.host, picked)
    expect(report.summary).toMatchObject({ modelIntents: 2, inputTokens: { reportedTokens: '24', coverage: 'complete-for-observed-intents' } })
    expect(report.runs[0]!.calls.map(call => call.intentAt)).toEqual(times.slice(1, 3))
    expect(report.windowCoverage).toEqual({ observedModelIntents: 4, outsideWindow: 2, unlocatedModelIntents: 0 })
    expect(report.runs[0]!.snapshotSha256).toBe(f.envelope.checksum.value)
    expect(report.selectionSha256).toBe(digest(inspectUsageSelection(picked).selection))
    expect(report.selectionSha256).not.toBe(inspectEvidenceSelection(selection(f.run)).sha256)
    expect(f.host.exportRun).toHaveBeenCalledExactlyOnceWith(f.run.id, false)
  })
  it('preserves unscoped report shape and hash, and refuses usage-only fields in evidence ZIP selections', async () => {
    const f = await projected([{ ...completed(), intentAt: window.from }]), report = await f.report()
    expect(report).not.toHaveProperty('window'); expect(report).not.toHaveProperty('windowCoverage')
    expect(report.runs[0]!.calls[0]).not.toHaveProperty('intentAt')
    expect(report.selectionSha256).toBe(inspectEvidenceSelection(selection(f.run)).sha256)
    expect(() => inspectEvidenceSelection({ ...selection(f.run), window })).toThrow()
  })
  it('preserves valid legacy second precision and finer retained fractions at millisecond boundaries', async () => {
    const times = ['2020-01-01T00:00:00Z', '2020-01-01T23:59:59.999999Z', '2020-01-02T00:00:00.000001Z']
    const f = await projected(times.map(intentAt => ({ ...completed(), intentAt }))), report = await createUsageReport(f.host, { ...selection(f.run), window })
    expect(report.summary.inputTokens.reportedTokens).toBe('24')
    expect(report.runs[0]!.calls.map(call => call.intentAt)).toEqual(times.slice(0, 2))
    expect(report.windowCoverage!.outsideWindow).toBe(1)
  })
  it('rejects a retained sub-millisecond intent later than the observed run even when Date.parse rounds both equally', async () => {
    const f = await projected([{ ...completed(), intentAt: '2020-01-01T00:00:00.000001Z' }])
    f.envelope.snapshot.run.updatedAt = window.from; f.envelope.checksum.value = digest(f.envelope.snapshot)
    await expect(createUsageReport(f.host, { ...selection(f.run), window })).rejects.toHaveProperty('code', 'corrupt')
  })
  it('reports missing timestamps as unlocated rather than claiming known zero or silently allocating calls', async () => {
    const f = await projected([completed(), { nodeId: 'custom', attemptId: randomUUID(), evidence: 'not-recorded' }])
    const report = await createUsageReport(f.host, { ...selection(f.run), window })
    expect(report.summary).toMatchObject({ modelIntents: 0, inputTokens: { reportedTokens: null, coverage: 'unavailable' } })
    expect(report.windowCoverage).toEqual({ observedModelIntents: 2, outsideWindow: 0, unlocatedModelIntents: 2 })
    expect(report.runs[0]!.calls).toEqual([])
  })
  it('retains partial known totals alongside unlocated calls without treating missing input and output as zero', async () => {
    const call = { ...completed(0, 0), intentAt: window.from }; delete (call.usage as any).outputTokens
    const f = await projected([call, completed()]), report = await createUsageReport(f.host, { ...selection(f.run), window })
    expect(report.summary.inputTokens).toMatchObject({ reportedTokens: '0', coverage: 'partial', reportingCalls: 1 })
    expect(report.summary.outputTokens).toMatchObject({ reportedTokens: null, coverage: 'unavailable', completedCallsWithoutField: 1 })
    expect(report.windowCoverage).toEqual({ observedModelIntents: 2, outsideWindow: 0, unlocatedModelIntents: 1 })
  })
  it('keeps an included retry operation whole even when its settlement and tries cross the selected boundary', async () => {
    const call = { ...completed(9, 0), intentAt: window.from, settledAt: '2020-01-03T00:00:00.000Z', evidenceSchemaVersion: 2,
      policy: { kind: 'transient-http-v1', maxAttempts: 2 }, usage: { tries: 2, inputTokens: 9, outputTokens: 0 },
      tries: ['failed', 'completed'].map((status, index) => ({ id: randomUUID(), number: index + 1, status, intentAt: window.before })) }
    const f = await projected([call]), report = await createUsageReport(f.host, { ...selection(f.run), window })
    expect(report.summary).toMatchObject({ recordedTries: 2, inputTokens: { reportedTokens: '9', coverage: 'partial' } })
    expect(report.window).toMatchObject({ basis: 'original-model-intent', retryAllocation: 'entire-call; not-per-try-or-prorated' })
  })
  it.each([null, {}, { from: window.from }, { before: window.before }, { ...window, extra: true },
    { from: window.before, before: window.from }, { from: window.from, before: window.from },
    { ...window, from: '2020-01-01T00:00:00Z' }, { ...window, from: '2020-01-01T00:00:00.000+00:00' },
    { ...window, from: '2020-02-30T00:00:00.000Z' }])('rejects invalid window %j before reading any run', async window => {
    const host = { exportRun: vi.fn() }
    await expect(createUsageReport(host, { ...selection({ id: randomUUID(), revision: 'a'.repeat(64) }), window }))
      .rejects.toHaveProperty('code', 'invalid-command')
    expect(host.exportRun).not.toHaveBeenCalled()
  })
  it.each(['bad-time', 'future-time', 'excluded-corruption', 'excluded-duplicate'])('does not let a window hide %s', async variant => {
    const call: any = { ...completed(), intentAt: '2019-01-01T00:00:00.000Z' }, calls = [call]
    if (variant === 'bad-time') call.intentAt = 'invalid'
    if (variant === 'future-time') call.intentAt = '2999-01-01T00:00:00.000Z'
    if (variant === 'excluded-corruption') call.usage.tries = 3
    if (variant === 'excluded-duplicate') calls.push(structuredClone(call))
    const f = await projected(calls)
    await expect(createUsageReport(f.host, { ...selection(f.run), window })).rejects.toHaveProperty('code', 'corrupt')
  })
  it('detaches the window before asynchronous source reads and retains missing-history uncertainty', async () => {
    const f = await projected([{ ...completed(), intentAt: window.from }]), picked = { ...selection(f.run), window: { ...window } }
    const pending = createUsageReport({ exportRun: async () => { await Promise.resolve(); return f.envelope } }, picked)
    picked.window.from = window.before
    expect((await pending).summary.completedCalls).toBe(1)
    const missing = await projected(undefined), report = await createUsageReport(missing.host, { ...selection(missing.run), window })
    expect(report.summary).toMatchObject({ unavailableHistories: 1, inputTokens: { reportedTokens: null, coverage: 'unavailable' } })
  })
  it('reads only the selected runs, returns known zero for no model intents, and never exposes private values', async () => {
    const { runtime, run } = await fixture(), other = await runtime.run(echo, 'UNSELECTED_PRIVATE_INPUT')
    const before = await runtime.events(run.id), report = await createUsageReport(runtime, selection(run))
    expect(report.runs.map(r => r.id)).toEqual([run.id])
    expect(report.summary).toMatchObject({ modelIntents: 0, inputTokens: { reportedTokens: '0', coverage: 'complete-for-observed-intents' } })
    expect(JSON.stringify(report)).not.toMatch(new RegExp(`PRIVATE|${other.id}`))
    expect(await runtime.events(run.id)).toEqual(before)
    expect(await createUsageReport(runtime, selection(run))).toEqual(report)
  })
  it('counts loop iterations and attempts once instead of summing duplicate step/journal projections', async () => {
    const a = completed(), b = { ...completed(20, 5), scope: { loop: 'items', index: 1 } }
    const f = await projected([a, b]); f.envelope.snapshot.steps = [{ modelUsage: { tries: 1, inputTokens: 900 } }]
    f.envelope.checksum.value = digest(f.envelope.snapshot)
    const report = await f.report()
    expect(report.summary).toMatchObject({ modelIntents: 2, completedCalls: 2, recordedTries: 2,
      inputTokens: { reportedTokens: '32', reportingCalls: 2 }, outputTokens: { reportedTokens: '8' } })
    expect(report.runs[0]!.calls[1]).toMatchObject({ scope: b.scope, inputTokens: '20' })
    expect(f.host.exportRun).toHaveBeenCalledExactlyOnceWith(f.run.id, false)
  })
  it('sums exact integer strings beyond safe JavaScript totals', async () => {
    const f = await projected([completed(Number.MAX_SAFE_INTEGER, 0), completed(Number.MAX_SAFE_INTEGER, 0)])
    expect((await f.report()).summary.inputTokens.reportedTokens).toBe('18014398509481982')
  })
  it('distinguishes provider-reported zero, a missing field, and unavailable model history', async () => {
    const missing = completed(0, 0); delete (missing.usage as any).outputTokens
    const report = await (await projected([missing])).report()
    expect(report.summary.inputTokens).toMatchObject({ reportedTokens: '0', coverage: 'complete-for-observed-intents' })
    expect(report.summary.outputTokens).toMatchObject({ reportedTokens: null, coverage: 'unavailable', completedCallsWithoutField: 1 })
    const unavailable = await (await projected(undefined)).report()
    expect(unavailable.summary).toMatchObject({ unavailableHistories: 1, inputTokens: { reportedTokens: null, coverage: 'unavailable' } })
    expect(unavailable.runs[0]!.modelHistory).toBe('unavailable')
  })
  it('keeps failed, pending and missing records visible, without implying dispatch or zero cost', async () => {
    const calls = [completed(), { nodeId: 'judge', attemptId: randomUUID(), evidence: 'not-recorded' },
      ...['failed', 'pending'].map(status => ({ nodeId: 'judge', attemptId: randomUUID(), evidence: 'recorded', evidenceSchemaVersion: 1, status }))]
    const report = await (await projected(calls)).report()
    expect(report.summary).toMatchObject({ modelIntents: 4, unrecordedCalls: 1, failedCalls: 1, pendingCalls: 1, recordedTries: 3,
      failedOrPendingTries: 2, inputTokens: { reportedTokens: '12', coverage: 'partial' } })
    expect(report.runs[0]!.calls[1]).toMatchObject({ recordedTries: null, inputTokens: null })
  })
  it('does not multiply the successful-response usage by retry count', async () => {
    const call = { ...completed(), evidenceSchemaVersion: 2, policy: { kind: 'transient-http-v1', maxAttempts: 3 },
      usage: { tries: 3, inputTokens: 12, outputTokens: 3 },
      tries: ['failed', 'failed', 'completed'].map((status, index) => ({ id: randomUUID(), number: index + 1, status })) }
    const report = await (await projected([call])).report()
    expect(report.summary).toMatchObject({ recordedTries: 3, failedOrPendingTries: 2, completedCalls: 1,
      inputTokens: { reportedTokens: '12', coverage: 'partial' } })
  })
  it('handles a pending retry backoff and cancelled failed retry without making up usage', async () => {
    for (const status of ['pending', 'failed']) {
      const call = { nodeId: 'judge', attemptId: randomUUID(), evidence: 'recorded', evidenceSchemaVersion: 2, status,
        policy: { kind: 'transient-http-v1', maxAttempts: 2 }, tries: [{ id: randomUUID(), number: 1, status: 'failed' }] }
      expect((await (await projected([call])).report()).summary).toMatchObject({ failedOrPendingTries: 1, inputTokens: { reportedTokens: null } })
    }
  })
  it.each(['checksum', 'privacy', 'revision', 'id', 'updatedAt'])('refuses mismatched or malformed %s evidence', async field => {
    const f = await projected([completed()])
    if (field === 'checksum') f.envelope.checksum.value = '0'.repeat(64)
    else {
      if (field === 'privacy') f.envelope.snapshot.privacy.payloads = 'included'
      else f.envelope.snapshot.run[field] = field === 'id' ? randomUUID() : field === 'revision' ? '0'.repeat(64) : 'bad'
      f.envelope.checksum.value = digest(f.envelope.snapshot)
    }
    await expect(f.report()).rejects.toHaveProperty('code', 'corrupt')
  })
  it.each(['duplicate', 'unsafe', 'negative', 'wrongTries', 'failedUsage', 'retryMismatch', 'duplicateTry'])('refuses corrupt %s accounting fields', async variant => {
    const call: any = completed(), calls = [call]
    if (variant === 'duplicate') calls.push({ ...call })
    if (variant === 'unsafe') call.usage.inputTokens = Number.MAX_SAFE_INTEGER + 1
    if (variant === 'negative') call.usage.inputTokens = -1
    if (variant === 'wrongTries') call.usage.tries = 2
    if (variant === 'failedUsage') call.status = 'failed'
    if (variant === 'retryMismatch' || variant === 'duplicateTry') {
      const id = randomUUID(); call.evidenceSchemaVersion = 2; call.policy = { kind: 'transient-http-v1', maxAttempts: 2 }
      call.tries = [{ id, number: 1, status: 'failed' }, { id: variant === 'duplicateTry' ? id : randomUUID(), number: 2, status: 'completed' }]
      if (variant === 'duplicateTry') call.usage.tries = 2
    }
    await expect((await projected(calls)).report()).rejects.toHaveProperty('code', 'corrupt')
  })
  it('rejects invalid or duplicate selections before reads, including case-equivalent UUIDs', async () => {
    const host = { exportRun: vi.fn() }, id = 'abcdefab-cdef-4abc-8abc-abcdefabcdef', revision = 'a'.repeat(64)
    for (const picked of [null, selection(), selection({ id: 'bad', revision }), selection({ id, revision }, { id: id.toUpperCase(), revision }),
      { schemaVersion: 1, runs: Array.from({ length: 101 }, () => ({ id: randomUUID(), revision })) }]) {
      await expect(createUsageReport(host, picked)).rejects.toHaveProperty('code', 'invalid-command')
    }
    expect(host.exportRun).not.toHaveBeenCalled()
  })
  it('detaches selection before asynchronous reads and returns no partial report if a selected run is missing', async () => {
    const f = await fixture(), picked = selection(f.run), original = structuredClone(picked)
    const promise = createUsageReport({ exportRun: async () => { await Promise.resolve(); return f.evidence } }, picked)
    picked.runs[0]!.revision = '0'.repeat(64)
    expect((await promise).runs[0]!.revision).toBe(original.runs[0]!.revision)
    await expect(createUsageReport(f.runtime, selection(f.run, { id: randomUUID(), revision: f.run.revision }))).rejects.toHaveProperty('code', 'not-found')
  })
  it('bounds call counts and source bytes without returning a partial report', async () => {
    const f = await projected(Array.from({ length: 10001 }, () => completed()))
    await expect(f.report()).rejects.toHaveProperty('code', 'limit')
    const large = await projected([]); large.envelope.snapshot.extra = 'x'.repeat(16_000_000)
    await expect(large.report()).rejects.toHaveProperty('code', 'limit')
  })
  it('accepts decimal PostgreSQL evidence without converting its sequence to a number', async () => {
    const f = await projected([completed()])
    f.envelope.schemaVersion = 2; f.envelope.snapshot.schemaVersion = 2
    f.envelope.snapshot.storage = { kind: 'postgres', recordVersion: '4' }
    f.envelope.snapshot.journal[0].sequence = '9007199254740993'
    f.envelope.checksum.value = digest(f.envelope.snapshot)
    const report = await f.report()
    expect(report.summary.inputTokens.reportedTokens).toBe('12')
    expect(report.runs[0]!.snapshotSha256).toBe(f.envelope.checksum.value)
  })
  it('aggregates independently observed runs, preserving snapshot checksums and excluding arbitrary added fields', async () => {
    const f = await fixture(), second = await f.runtime.run(echo, 'PRIVATE_OTHER'), e1: any = f.evidence, e2: any = await f.runtime.exportRun(second.id)
    for (const e of [e1, e2]) { e.snapshot.models.calls = [{ ...completed(), route: 'PRIVATE_ENDPOINT', raw: 'PRIVATE_RESPONSE' }]; e.checksum.value = digest(e.snapshot) }
    const report = await createUsageReport({ exportRun: id => id === f.run.id ? e1 : e2 }, selection(f.run, second))
    expect(report.summary.inputTokens.reportedTokens).toBe('24'); expect(report.runs.map(r => r.snapshotSha256)).toEqual([e1.checksum.value, e2.checksum.value])
    expect(report.consistency).toBe('per-run-observations; not-an-atomic-snapshot'); expect(JSON.stringify(report)).not.toContain('PRIVATE_')
  })
  it('supports CLI and both operation backend contracts without journal mutations', async () => {
    const f = await fixture(), picked = selection(f.run), before = await f.runtime.events(f.run.id)
    const expected = await createUsageReport(f.runtime, picked)
    expect(await dispatchOperation({ storage: 'sqlite', runtime: f.runtime }, { operation: 'usage.report', selection: picked }, 'fixture')).toEqual(expected)
    // Asynchronous target contract only; real PostgreSQL qualification is a separate fixture.
    expect(await dispatchOperation({ storage: 'postgres', runtime: { exportRun: async () => f.evidence } } as any,
      { operation: 'usage.report', selection: picked }, 'fixture')).toEqual(expected)
    expect(await f.runtime.events(f.run.id)).toEqual(before)
    const file = join(f.directory, 'selection.json'); await writeFile(file, JSON.stringify(picked)); await f.runtime.close()
    expect(await cli(['usage', 'report', file, '--data-dir', join(f.directory, 'state')])).toMatchObject({ exit: 0, out: expected })
    await writeFile(file, JSON.stringify(selection()))
    expect((await cli(['usage', 'report', file, '--data-dir', join(f.directory, 'must-not-create')])).exit).not.toBe(0)
    expect(await readdir(f.directory)).not.toContain('must-not-create')
  })
  it('shares scoped selection through CLI and both API contracts, refusing invalid windows before opening state', async () => {
    const f = await fixture(), picked = { ...selection(f.run), window }, before = await f.runtime.events(f.run.id)
    const expected = await createUsageReport(f.runtime, picked)
    expect(expected.windowCoverage).toEqual({ observedModelIntents: 0, outsideWindow: 0, unlocatedModelIntents: 0 })
    for (const storage of ['sqlite', 'postgres']) {
      expect(await dispatchOperation({ storage, runtime: { exportRun: async () => f.evidence } } as any,
        { operation: 'usage.report', selection: picked }, 'fixture')).toEqual(expected)
    }
    expect(await f.runtime.events(f.run.id)).toEqual(before)
    const file = join(f.directory, 'window.json'); await writeFile(file, JSON.stringify(picked)); await f.runtime.close()
    expect(await cli(['usage', 'report', file, '--data-dir', join(f.directory, 'state')])).toMatchObject({ exit: 0, out: expected })
    await writeFile(file, JSON.stringify({ ...picked, window: { ...window, before: window.from } }))
    expect((await cli(['usage', 'report', file, '--data-dir', join(f.directory, 'invalid-window-state')])).exit).toBe(2)
    expect(await readdir(f.directory)).not.toContain('invalid-window-state')
  })
  it('reports a real configured-model retry from retained records after restart without contacting the provider', async () => {
    let requests = 0
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* drain fixture request */ }
      if (++requests === 1) { response.writeHead(503); response.end('{}'); return }
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop',
        message: { role: 'assistant', content: 'PRIVATE_MODEL_OUTPUT' } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }))
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
    const address = server.address(); if (!address || typeof address === 'string') throw Error('fixture address')
    const f = await fixture(), endpoint = `http://127.0.0.1:${address.port}/v1`
    f.runtime.configureConnection({ id: 'settings-default', provider: 'fixture', protocol: 'openai-compatible', endpoint, allowedModels: ['fixture'],
      authentication: { kind: 'bearer', credentialRef: 'fixture/key' }, tokenParameter: 'max_tokens', maxResponseBytes: 100000,
      maxRequestBytes: 100000, maxStreamEvents: 1000, maxTimeoutSeconds: 5 }, 0, 'PRIVATE_ACTOR')
    f.runtime.setCredential('fixture/key', 'PRIVATE_TOKEN', 0, 'PRIVATE_ACTOR')
    const source = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'model', name: 'Model' }, spec: {
      inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
        judge: { type: 'llm', config: { provider: 'fixture', model: 'fixture', connection: { mode: 'workspace', id: 'settings-default' },
          prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 30, stream: false }, execution: { timeoutSeconds: 5, maxAttempts: 2 }, historyScope: 'none' } },
        end: { type: 'output', config: { value: '${{ nodes.judge.output }}' } } }, edges: [{ from: 'start', to: 'judge' }, { from: 'judge', to: 'end' }] } })
    const run = await f.runtime.run(source, 'PRIVATE_PROMPT'), before = await f.runtime.events(run.id)
    expect(run.state.status).toBe('completed'); expect(requests).toBe(2)
    await f.runtime.close()
    const reopened = await LocalRuntime.open({ dataDirectory: join(f.directory, 'state') }); cleanup.push(() => reopened.close())
    const report = await createUsageReport(reopened, selection(run))
    expect(report.summary).toMatchObject({ recordedTries: 2, failedOrPendingTries: 1, inputTokens: { reportedTokens: '12', coverage: 'partial' } })
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE_|127\.0\.0\.1/); expect(requests).toBe(2)
    expect(await reopened.events(run.id)).toEqual(before)
    const envelope = await reopened.exportRun(run.id), record = envelope.snapshot.models!.calls[0]!
    if (record.evidence !== 'recorded') throw Error('Expected configured model record')
    const intentAt = record.intentAt
    const picked = { ...selection(run), window: { from: intentAt, before: new Date(Date.parse(intentAt) + 1).toISOString() } }
    const scoped = await createUsageReport(reopened, picked)
    expect(scoped.summary).toMatchObject({ recordedTries: 2, inputTokens: { reportedTokens: '12', coverage: 'partial' } })
    expect(scoped.runs[0]!.calls[0]).toHaveProperty('intentAt', intentAt)
    expect(await reopened.events(run.id)).toEqual(before); expect(requests).toBe(2)
  })
})

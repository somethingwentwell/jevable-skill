import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, mkdtemp, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { LocalRuntime } from '../src/runtime/local.ts'
import { createUsageReport, inspectUsageSelection, inspectEvidenceSelection } from '../src/evidence/index.ts'
import { dispatchOperation } from '../src/http/operations.ts'
import { main } from '../src/cli.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const closes: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) await close() })
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const window = { from: '2020-01-01T00:00:00.000Z', before: '2020-01-02T00:00:00.000Z' }
function call(provider = 'fixture', model = 'a', inputTokens = 12) {
  return { nodeId: 'model', attemptId: randomUUID(), evidence: 'recorded', evidenceSchemaVersion: 1, status: 'completed',
    intentAt: window.from, usageIdentity: { provider, model }, usage: { tries: 1, inputTokens, outputTokens: 0 } }
}
async function fixture(calls: unknown[] | null = []) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-usage-group-')), runtime = await LocalRuntime.open({ dataDirectory: join(directory, 'state') })
  closes.push(() => runtime.close())
  const run = await runtime.run(echo, 'PRIVATE_INPUT'), base: any = await runtime.exportRun(run.id), grouped = structuredClone(base)
  grouped.snapshot.privacy.modelIdentities = 'included-by-explicit-usage-request'
  if (calls === null) delete grouped.snapshot.models
  else grouped.snapshot.models = { ...grouped.snapshot.models, usageIdentities: 'requested-provider-model/v1', calls }
  grouped.checksum.value = digest(grouped.snapshot)
  const host = { exportRun: vi.fn(() => base), exportUsageRun: vi.fn(() => grouped) }
  const selection = { schemaVersion: 1, runs: [{ id: run.id, revision: run.revision }] }
  return { directory, runtime, run, base, grouped, host, selection }
}
describe('explicit requested-provider/model usage grouping', () => {
  it('uses only the opted-in host read, sums requested models/provider groups once, and keeps stable ordering', async () => {
    const f = await fixture([call('b', 'z'), call('a', 'y', 2), call('a', 'x', 3)])
    const report = await createUsageReport(f.host, { ...f.selection, groupBy: 'provider-model' })
    expect(report.groups!.map(g => [g.key, g.summary.inputTokens.reportedTokens])).toEqual([
      [{ provider: 'a', model: 'x' }, '3'], [{ provider: 'a', model: 'y' }, '2'], [{ provider: 'b', model: 'z' }, '12'],
    ])
    expect(report.summary.inputTokens.reportedTokens).toBe('17')
    expect(report.runs[0]!.groups).toEqual(report.groups)
    expect(f.host.exportRun).not.toHaveBeenCalled(); expect(f.host.exportUsageRun).toHaveBeenCalledExactlyOnceWith(f.run.id)
    const providers = await createUsageReport(f.host, { ...f.selection, groupBy: 'provider' })
    expect(providers.groups!.map(g => [g.key, g.summary.inputTokens.reportedTokens])).toEqual([[{ provider: 'a' }, '5'], [{ provider: 'b' }, '12']])
    expect(providers.groups!.some(g => Object.hasOwn(g.key, 'model'))).toBe(false)
  })
  it('keeps unknown calls/histories separate, distinguishing provider-reported zero from unavailable usage', async () => {
    const f = await fixture([call('fixture', 'zero', 0), { nodeId: 'custom', attemptId: randomUUID(), evidence: 'not-recorded' }])
    const report = await createUsageReport(f.host, { ...f.selection, groupBy: 'provider-model' })
    expect(report.groups!.find(g => g.key.provider === null)).toMatchObject({ key: { provider: null, model: null },
      summary: { unrecordedCalls: 1, inputTokens: { reportedTokens: null, coverage: 'unavailable' } } })
    expect(report.groups!.find(g => g.key.provider === 'fixture')).toMatchObject({ summary: { inputTokens: { reportedTokens: '0', coverage: 'complete-for-observed-intents' } } })
    expect(report.summary.inputTokens.coverage).toBe('partial')
    const missing = await fixture(null), unavailable = await createUsageReport(missing.host, { ...missing.selection, groupBy: 'provider' })
    expect(unavailable.groups).toEqual([{ key: { provider: null }, summary: unavailable.summary, unlocatedModelIntents: 0 }])
  })
  it('composes with windows, excludes known outside identities, and marks unlocated known and unknown groups incomplete', async () => {
    const known: any = call('known', 'm'); delete known.intentAt
    const f = await fixture([call(), known, { ...call('outside', 'm'), intentAt: window.before },
      { nodeId: 'custom', attemptId: randomUUID(), evidence: 'not-recorded' }])
    const report = await createUsageReport(f.host, { ...f.selection, window, groupBy: 'provider-model' })
    expect(report.groups!.map(g => g.key.provider)).toEqual(['fixture', 'known', null])
    expect(report.groups!.find(g => g.key.provider === 'known')).toMatchObject({ unlocatedModelIntents: 1,
      summary: { modelIntents: 0, inputTokens: { reportedTokens: null, coverage: 'unavailable' } } })
    expect(report.windowCoverage).toEqual({ observedModelIntents: 4, outsideWindow: 1, unlocatedModelIntents: 2 })
    expect(report.summary.inputTokens).toMatchObject({ reportedTokens: '12', coverage: 'partial' })
  })
  it('counts an included retry once and retains unavailable failed/pending usage under its verified identity', async () => {
    const retry = { ...call('retry', 'm', 7), evidenceSchemaVersion: 2, policy: { kind: 'transient-http-v1', maxAttempts: 2 },
      usage: { tries: 2, inputTokens: 7, outputTokens: 0 }, tries: ['failed', 'completed'].map((status, index) => ({ id: randomUUID(), number: index + 1, status })) }
    const failed: any = call('failed', 'm'); failed.status = 'failed'; delete failed.usage
    const f = await fixture([retry, failed]), report = await createUsageReport(f.host, { ...f.selection, groupBy: 'provider' })
    expect(report.groups!.find(g => g.key.provider === 'retry')).toMatchObject({ summary: { recordedTries: 2,
      failedOrPendingTries: 1, inputTokens: { reportedTokens: '7', coverage: 'partial' } } })
    expect(report.groups!.find(g => g.key.provider === 'failed')).toMatchObject({ summary: { failedCalls: 1,
      inputTokens: { reportedTokens: null, coverage: 'unavailable' } } })
  })
  it('uses collision-safe group keys and exact decimal totals without summing arbitrary source fields', async () => {
    const f = await fixture([call('__proto__', 'a:b', Number.MAX_SAFE_INTEGER), call('__proto__', 'a:b', Number.MAX_SAFE_INTEGER),
      { ...call('a:b', 'c'), raw: 'PRIVATE_RAW', responseId: 'PRIVATE_ID', providerModel: 'PRIVATE_PROVIDER_REPORTED_MODEL' }, call('a', 'b:c')])
    const report = await createUsageReport(f.host, { ...f.selection, groupBy: 'provider-model' })
    expect(report.groups).toHaveLength(3)
    expect(report.groups!.find(g => g.key.provider === '__proto__')!.summary.inputTokens.reportedTokens).toBe('18014398509481982')
    expect(JSON.stringify(report)).not.toContain('PRIVATE_')
  })
  it('leaves ordinary evidence and ungrouped reports unchanged and rejects grouping in evidence ZIP selections', async () => {
    const f = await fixture([call()]), before = structuredClone(f.base), report = await createUsageReport(f.host, f.selection)
    expect(report).not.toHaveProperty('groups'); expect(report.runs[0]).not.toHaveProperty('groups')
    expect(f.host.exportUsageRun).not.toHaveBeenCalled(); expect(f.base).toEqual(before)
    expect(() => inspectEvidenceSelection({ ...f.selection, groupBy: 'provider' })).toThrow()
    expect(inspectUsageSelection({ ...f.selection, groupBy: undefined }).sha256).toBe(inspectEvidenceSelection(f.selection).sha256)
  })
  it.each([null, '', 'model', ['provider'], 'Provider', true])('refuses unsupported grouping %j before reads', async groupBy => {
    const host = { exportRun: vi.fn(), exportUsageRun: vi.fn() }
    await expect(createUsageReport(host, { schemaVersion: 1, runs: [{ id: randomUUID(), revision: 'a'.repeat(64) }], groupBy }))
      .rejects.toHaveProperty('code', 'invalid-command')
    expect(host.exportRun).not.toHaveBeenCalled(); expect(host.exportUsageRun).not.toHaveBeenCalled()
  })
  it('refuses older hosts without opted-in projection, never falling back to private or ordinary evidence', async () => {
    const f = await fixture([call()]), host = { exportRun: vi.fn(() => f.base) }
    await expect(createUsageReport(host, { ...f.selection, groupBy: 'provider' })).rejects.toHaveProperty('code', 'invalid-command')
    expect(host.exportRun).not.toHaveBeenCalled()
  })
  it.each(['privacy-marker', 'format-marker', 'missing-identity', 'extra-route', 'blank', 'padded', 'too-long', 'unrecorded-identity'])
    ('refuses corrupt opted-in identity %s even when outside the window', async variant => {
      const c: any = { ...call(), intentAt: window.before }, f = await fixture([c])
      if (variant === 'privacy-marker') delete f.grouped.snapshot.privacy.modelIdentities
      else if (variant === 'format-marker') delete f.grouped.snapshot.models.usageIdentities
      else if (variant === 'missing-identity') delete c.usageIdentity
      else if (variant === 'extra-route') c.usageIdentity.endpoint = 'PRIVATE_ENDPOINT'
      else if (variant === 'blank') c.usageIdentity.model = ''
      else if (variant === 'padded') c.usageIdentity.provider = ' fixture '
      else if (variant === 'too-long') c.usageIdentity.model = 'x'.repeat(257)
      else { c.evidence = 'not-recorded'; delete c.status; delete c.usage; delete c.evidenceSchemaVersion }
      f.grouped.snapshot.models.calls = [c]; f.grouped.checksum.value = digest(f.grouped.snapshot)
      await expect(createUsageReport(f.host, { ...f.selection, groupBy: 'provider-model', window })).rejects.toHaveProperty('code', 'corrupt')
    })
  it('bounds aggregate group cardinality without returning partial results', async () => {
    const f = await fixture(Array.from({ length: 1001 }, (_, i) => call('p', String(i))))
    await expect(createUsageReport(f.host, { ...f.selection, groupBy: 'provider-model' })).rejects.toHaveProperty('code', 'limit')
    expect((await createUsageReport(f.host, { ...f.selection, groupBy: 'provider' })).groups).toHaveLength(1)
  })
  it('detaches grouping before asynchronous reads and shares its selection through management operations', async () => {
    const f = await fixture([call()]), picked = { ...f.selection, groupBy: 'provider-model' }
    const pending = createUsageReport({ ...f.host, exportUsageRun: async () => { await Promise.resolve(); return f.grouped } }, picked)
    picked.groupBy = 'provider'
    const report = await pending; expect(report.groupBy).toBe('provider-model')
    expect(await dispatchOperation({ storage: 'sqlite', runtime: f.host } as any,
      { operation: 'usage.report', selection: { ...picked, groupBy: 'provider-model' } }, 'fixture')).toEqual(report)
  })
  it('accepts grouped PostgreSQL decimal-sequence evidence without converting it or altering its hash', async () => {
    const f = await fixture([call()]); f.grouped.schemaVersion = 2; f.grouped.snapshot.schemaVersion = 2
    f.grouped.snapshot.storage = { kind: 'postgres', recordVersion: '1' }; f.grouped.snapshot.journal[0].sequence = '9007199254740993'
    f.grouped.checksum.value = digest(f.grouped.snapshot)
    const report = await createUsageReport(f.host, { ...f.selection, groupBy: 'provider' })
    expect(report.runs[0]!.snapshotSha256).toBe(f.grouped.checksum.value); expect(report.groups![0]!.summary.inputTokens.reportedTokens).toBe('12')
  })
  it('validates CLI grouping before opening state and uses the opted-in runtime for known-zero reports', async () => {
    const f = await fixture(), file = join(f.directory, 'selection.json')
    await f.runtime.close()
    const invoke = async (state = 'state') => { let out = ''; const exit = await main(['usage', 'report', file, '--data-dir', join(f.directory, state)],
      { out: value => { out += value }, err: () => {} }); return { exit, out: out ? JSON.parse(out) : undefined } }
    await writeFile(file, JSON.stringify({ ...f.selection, groupBy: 'provider' }))
    expect(await invoke()).toMatchObject({ exit: 0, out: { groupBy: 'provider', groups: [], summary: { inputTokens: { reportedTokens: '0' } } } })
    await writeFile(file, JSON.stringify({ ...f.selection, groupBy: 'model' }))
    expect((await invoke('invalid-group-state')).exit).toBe(2); expect(await readdir(f.directory)).not.toContain('invalid-group-state')
  })
  it('projects verified requested identities only on explicit runtime reads and survives restart without provider replay', async () => {
    let requests = 0
    const receiver = createServer(async (req, res) => {
      for await (const _chunk of req) { /* private fixture */ }
      requests++; res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ model: 'PRIVATE_PROVIDER_RESPONSE_VERSION', choices: [{ index: 0, finish_reason: 'stop',
        message: { role: 'assistant', content: 'PRIVATE_RESPONSE' } }], usage: { prompt_tokens: 7, completion_tokens: 0 } }))
    })
    await new Promise<void>((resolve, reject) => { receiver.once('error', reject); receiver.listen(0, '127.0.0.1', resolve) })
    closes.push(() => new Promise<void>(resolve => { receiver.closeAllConnections(); receiver.close(() => resolve()) }))
    const address = receiver.address(); if (!address || typeof address === 'string') throw Error('Fixture address')
    const f = await fixture(), endpoint = `http://127.0.0.1:${address.port}/v1`
    f.runtime.configureConnection({ id: 'private-route', provider: 'fixture-provider', protocol: 'openai-compatible', endpoint,
      allowedModels: ['requested-model'], authentication: { kind: 'bearer', credentialRef: 'fixture/key' }, tokenParameter: 'max_tokens',
      maxRequestBytes: 10000, maxResponseBytes: 10000, maxStreamEvents: 100, maxTimeoutSeconds: 5 }, 0, 'PRIVATE_ACTOR')
    f.runtime.setCredential('fixture/key', 'PRIVATE_CREDENTIAL', 0, 'PRIVATE_ACTOR')
    const yaml = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'grouping', name: 'Grouping' },
      spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
        model: { type: 'llm', config: { provider: 'fixture-provider', model: 'requested-model', connection: { mode: 'workspace', id: 'private-route' },
          prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 20, stream: false }, execution: { timeoutSeconds: 5, maxAttempts: 1 }, historyScope: 'none' } },
        end: { type: 'output', config: { value: '${{ nodes.model.output }}' } } }, edges: [{ from: 'start', to: 'model' }, { from: 'model', to: 'end' }] } })
    const run = await f.runtime.run(yaml, 'PRIVATE_PROMPT'), before = await f.runtime.events(run.id)
    const selection = { schemaVersion: 1, runs: [{ id: run.id, revision: run.revision }] }, ordinary = await f.runtime.exportRun(run.id)
    expect(JSON.stringify(ordinary)).not.toMatch(/fixture-provider|requested-model|usageIdentity|modelIdentities/)
    const explicit = await f.runtime.exportUsageRun(run.id)
    expect(explicit.snapshot.models!.calls[0]).toHaveProperty('usageIdentity', { provider: 'fixture-provider', model: 'requested-model' })
    expect(explicit.checksum.value).not.toBe(ordinary.checksum.value)
    const report = await createUsageReport(f.runtime, { ...selection, groupBy: 'provider-model' })
    expect(report.groups![0]).toMatchObject({ key: { provider: 'fixture-provider', model: 'requested-model' },
      summary: { inputTokens: { reportedTokens: '7' }, outputTokens: { reportedTokens: '0' } } })
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE_|127\.0\.0\.1|private-route|fixture\/key/)
    expect(await createUsageReport(f.runtime, selection)).not.toHaveProperty('groups')
    expect(await f.runtime.exportRun(run.id)).toEqual(ordinary); expect(await f.runtime.events(run.id)).toEqual(before)
    await f.runtime.close()
    const reopened = await LocalRuntime.open({ dataDirectory: join(f.directory, 'state') }); closes.push(() => reopened.close())
    expect(await createUsageReport(reopened, { ...selection, groupBy: 'provider-model' })).toEqual(report)
    expect(await reopened.events(run.id)).toEqual(before); expect(requests).toBe(1)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID, webcrypto } from 'node:crypto'
import { readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Script, runInNewContext } from 'node:vm'
import { LocalRuntime } from '../src/runtime/local.ts'
import { createUsageReport, inspectUsageSelection } from '../src/evidence/usage.ts'
import { dispatchOperation } from '../src/http/operations.ts'
import { PreviewSession } from '../src/preview/session.ts'
import { previewUsageTools, projectPreviewUsage, type PreviewUsageQuery } from '../src/preview/usage.ts'
import { liveUsageControls, usageControlsHtml } from '../src/preview/usage-controls.ts'
import { renderLivePage } from '../src/preview/live-page.ts'

const source = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const closes: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.unstubAllGlobals(); for (const close of closes.splice(0).reverse()) await close() })
async function fixture(calls?: unknown[]) {
  const runtime = await LocalRuntime.open({ dataDirectory: join(await mkdtemp(join(tmpdir(), 'jevable-preview-usage-')), 'state') })
  closes.push(() => runtime.close())
  const call = vi.fn(command => dispatchOperation({ storage: 'sqlite', runtime }, command, 'fixture'))
  const session = await PreviewSession.create({ call }, source), run: any = await session.operation({ operation: 'run', id: randomUUID(), input: 'PRIVATE_INPUT' })
  const evidence: any = await runtime.exportRun(run.id)
  if (calls) { evidence.snapshot.models.calls = calls; evidence.checksum.value = createHash('sha256').update(JSON.stringify(evidence.snapshot)).digest('hex') }
  const query = { runId: run.id, revision: run.revision }, report = await createUsageReport({ exportRun: () => evidence }, { schemaVersion: 1, runs: [{ id: run.id, revision: run.revision }] })
  return { runtime, session, call, run, query, report, evidence, payload: await projectPreviewUsage(query, report) }
}
const completed = (inputTokens = 0) => ({ nodeId: 'llm', attemptId: randomUUID(), evidence: 'recorded', evidenceSchemaVersion: 1,
  status: 'completed', usage: { tries: 1, inputTokens } })
describe('selected-run usage projection and admission', () => {
  it('reads a real scoped run without private output, discovery or mutation', async () => {
    const f = await fixture(), before = await f.runtime.show(f.run.id)
    f.call.mockClear()
    expect(await f.session.operation({ operation: 'usage', id: f.run.id })).toEqual(f.payload)
    expect(f.call.mock.calls.map(([c]) => c.operation)).toEqual(['runs.show', 'usage.report'])
    expect(JSON.stringify(f.payload)).not.toContain('PRIVATE_INPUT'); expect(f.payload).not.toHaveProperty('calls')
    expect(f.payload.summary.inputTokens).toMatchObject({ reportedTokens: '0', coverage: 'complete-for-observed-intents' })
    expect(await f.runtime.show(f.run.id)).toEqual(before)
  })
  it('preserves reported zero versus missing response fields and unknown failed consumption', async () => {
    const f = await fixture([completed(), { nodeId: 'llm', attemptId: randomUUID(), evidence: 'recorded', evidenceSchemaVersion: 1, status: 'failed' }])
    expect(f.payload.summary.inputTokens).toMatchObject({ reportedTokens: '0', coverage: 'partial' })
    expect(f.payload.summary.outputTokens).toMatchObject({ reportedTokens: null, coverage: 'unavailable' })
    expect(f.payload.summary.failedCalls).toBe(1)
    const tools = runInNewContext(`(${previewUsageTools.toString()})()`, { crypto: webcrypto, TextEncoder, Uint8Array })
    expect(await tools.admit(f.query, f.payload)).toEqual(f.payload)
  })
  it.each([undefined, 'provider', 'provider-model'] as const)('admits an explicit grouped/windowed real report: %s', async groupBy => {
    const f = await fixture(), window = { from: '2000-01-01T00:00:00.000Z', before: '2099-01-01T00:00:00.000Z' }
    const value = await f.session.operation({ operation: 'usage', id: f.run.id, window, ...(groupBy ? { groupBy } : {}) })
    const projected = await previewUsageTools().admit({ ...f.query, window, ...(groupBy ? { groupBy } : {}) }, value)
    expect(projected.windowCoverage).toEqual({ observedModelIntents: 0, outsideWindow: 0, unlocatedModelIntents: 0 })
    expect(projected.groups).toEqual(groupBy ? [] : undefined)
  })
  it.each([{ groupBy: 'account' }, { window: { from: 'x', before: 'y' } }, { window: { from: '2026-01-01T00:00:00Z', before: '2027-01-01T00:00:00.000Z' } },
    { window: { from: '2026-01-01T00:00:00.000Z', before: '2026-01-01T00:00:00.000Z' } }, { includePrivate: true }, { selection: { runs: [] } }, { actor: 'override' }])(
    'rejects invalid or widening requests before any owner I/O: %j', async fields => {
      const f = await fixture(); f.call.mockClear()
      await expect(f.session.operation({ operation: 'usage', id: f.run.id, ...fields })).rejects.toHaveProperty('code', 'invalid-command')
      expect(f.call).not.toHaveBeenCalled()
    })
  it('refuses foreign runs before report reads and preserves owner failures without fallback', async () => {
    const f = await fixture(), foreign = await f.runtime.run(source, 'PRIVATE_FOREIGN'); f.call.mockClear()
    await expect(f.session.operation({ operation: 'usage', id: foreign.id })).rejects.toHaveProperty('code', 'not-found')
    expect(f.call.mock.calls.map(([c]) => c.operation)).toEqual(['runs.show'])
    f.call.mockImplementation(async command => { if (command.operation === 'usage.report') throw Object.assign(Error('PRIVATE_FAILURE'), { code: 'limit' }); return dispatchOperation({ storage: 'sqlite', runtime: f.runtime }, command, 'fixture') })
    await expect(f.session.operation({ operation: 'usage', id: f.run.id })).rejects.toHaveProperty('code', 'limit')
  })
  it.each(['foreign', 'revision', 'selection-hash', 'status', 'private-root', 'private-run', 'negative', 'count-sum', 'coverage', 'unknown-as-zero', 'huge', 'unrequested-groups', 'unrequested-window', 'snapshot', 'date'])(
    'refuses contradictory or private replies: %s', async fault => {
      const f = await fixture([completed()]), v: any = structuredClone(f.payload)
      if (fault === 'foreign') v.run.id = randomUUID()
      if (fault === 'revision') v.run.revision = 'a'.repeat(64)
      if (fault === 'selection-hash') v.selectionSha256 = 'b'.repeat(64)
      if (fault === 'status') v.run.workflowStatus = 'success'
      if (fault === 'private-root') v.credentials = 'PRIVATE_SECRET'
      if (fault === 'private-run') v.run.output = 'PRIVATE_OUTPUT'
      if (fault === 'negative') v.summary.failedCalls = -1
      if (fault === 'count-sum') v.summary.modelIntents++
      if (fault === 'coverage') v.summary.inputTokens.coverage = 'unavailable'
      if (fault === 'unknown-as-zero') v.summary.outputTokens.reportedTokens = '0'
      if (fault === 'huge') v.summary.inputTokens.reportedTokens = '9'.repeat(21)
      if (fault === 'unrequested-groups') v.groups = []
      if (fault === 'unrequested-window') v.windowCoverage = {}
      if (fault === 'snapshot') v.run.snapshotSha256 = 'bad'
      if (fault === 'date') v.run.observedRunUpdatedAt = '2026-02-30T00:00:00.000Z'
      await expect(previewUsageTools().admit(f.query, v)).rejects.toThrow()
    })
  it('detaches mutable caller arguments and reply before awaited hashing', async () => {
    const f = await fixture(), query = { ...f.query }, payload = structuredClone(f.payload)
    const pending = previewUsageTools().admit(query, payload)
    query.revision = 'c'.repeat(64); payload.summary.modelIntents = 100
    expect(await pending).toEqual(f.payload)
  })
  it('matches canonical selection and serializes CSP-hashed source with controls', () => {
    const q: PreviewUsageQuery = { runId: randomUUID(), revision: 'a'.repeat(64), groupBy: 'provider' }
    expect(previewUsageTools().query(q)).toEqual(inspectUsageSelection({ schemaVersion: 1, runs: [{ id: q.runId, revision: q.revision }], groupBy: q.groupBy }).selection)
    const page = renderLivePage(randomUUID(), 'fixture'), script = /<script>([\s\S]*?)<\/script>/u.exec(page.html)![1]!
    expect(() => new Script(script)).not.toThrow()
    expect(page.csp).toContain(createHash('sha256').update(script).digest('base64'))
    expect(page.html).toContain(usageControlsHtml); expect(script).toContain('jevable.ai/preview-usage')
  })
})

class Element {
  value = ''; disabled = false; children: Element[] = []; text = ''; handlers = new Map<string, (() => void)[]>()
  set textContent(value: string) { this.text = value; this.children = [] }
  get textContent(): string { return this.text + this.children.map(c => c.textContent).join(' ') }
  append(child: Element) { this.children.push(child) }
  replaceChildren() { this.children = []; this.text = '' }
  setAttribute() {}
  addEventListener(name: string, handler: () => void) { this.handlers.set(name, [...this.handlers.get(name) ?? [], handler]) }
  click() { for (const h of this.handlers.get('click') ?? []) h() }
  change(value: string) { this.value = value; for (const h of this.handlers.get('input') ?? []) h() }
}
function controls(query: PreviewUsageQuery) {
  const elements = new Map<string, Element>(), get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)! }
  const handlers = new Map<string, () => void>()
  vi.stubGlobal('document', { getElementById: get, createElement: () => new Element() })
  vi.stubGlobal('window', { addEventListener: (name: string, h: () => void) => handlers.set(name, h) })
  let current: { runId: string; revision: string; session: string } | undefined = { ...query, session: 'one' }
  const pending: ((value: unknown) => void)[] = [], request = vi.fn(() => new Promise(resolve => pending.push(resolve)))
  const tools = previewUsageTools(), admissions: Promise<unknown>[] = []
  const controller = liveUsageControls({ request, current: () => current }, { ...tools, admit: (...args) => {
    const pending = tools.admit(...args); admissions.push(pending); return pending
  } })
  return { controller, request, pending, get: (id: string) => get('usage-' + id), event: (name: string) => handlers.get(name)!(),
    settle: async () => {
      // Let the resolved request enter admission, then await real WebCrypto rather than a timing guess.
      await Promise.resolve(); await Promise.allSettled(admissions)
      await new Promise(resolve => setImmediate(resolve))
    },
    set: (value: typeof current) => { current = value; controller.observe() } }
}
describe('serialized usage controls (not real browser verification)', () => {
  it.each(['orphan', 'retry-conservation'])('clears impossible %s accounting without fallback or automatic retry', async fault => {
    const f = await fixture(fault === 'orphan' ? [] : [completed()]), c = controls(f.query)
    c.get('load').click(); c.pending[0]!(f.payload); await c.settle()
    expect(c.get('results').textContent).toContain('Selected run total')
    const v: any = structuredClone(f.payload); v.summary.recordedTries++
    c.get('load').click(); c.pending[1]!(v); await c.settle()
    expect(c.get('results').textContent).toBe('')
    expect(c.get('message').textContent).toContain('Usage unavailable or invalid')
    expect(c.get('message').textContent).toContain('no query or execution was retried')
    expect(c.request).toHaveBeenCalledTimes(2)
    expect(c.get('load').disabled).toBe(false)
  })
  it('opens without reading, applies explicit drafts and renders totals safely', async () => {
    const f = await fixture(), c = controls(f.query)
    expect(c.request).not.toHaveBeenCalled(); c.get('load').click(); c.pending[0]!(f.payload); await c.settle()
    expect(c.request).toHaveBeenCalledExactlyOnceWith({ operation: 'usage', id: f.run.id })
    expect(c.get('results').textContent).toContain('Selected run total'); expect(c.get('results').textContent).toContain('0 · complete-for-observed-intents')
    expect(c.get('results').textContent).not.toContain('PRIVATE_INPUT')
  })
  it.each([['from', 'PRIVATE_INVALID'], ['group', 'billing'], ['from', '2026-01-01T00:00:00.000Z']])('rejects invalid draft %s without I/O or disclosure', async (field, value) => {
    const f = await fixture(), c = controls(f.query); c.get(field).change(value); c.get('load').click()
    expect(c.request).not.toHaveBeenCalled(); expect(c.get('message').textContent).toContain('Invalid usage draft'); expect(c.get('message').textContent).not.toContain('PRIVATE_INVALID')
  })
  it.each(['draft', 'clear', 'disconnect', 'session', 'run', 'pagehide'])('fences an old reply after %s without retry/restoration', async reason => {
    const f = await fixture(), c = controls(f.query); c.get('load').click()
    if (reason === 'draft') c.get('group').change('provider')
    if (reason === 'clear') c.get('clear').click()
    if (reason === 'disconnect') c.set(undefined)
    if (reason === 'session') c.set({ ...f.query, session: 'two' })
    if (reason === 'run') c.set({ ...f.query, runId: randomUUID(), session: 'one' })
    if (reason === 'pagehide') c.event('pagehide')
    c.pending[0]!(f.payload); await c.settle()
    expect(c.get('results').textContent).toBe(''); expect(c.request).toHaveBeenCalledTimes(1)
    if (reason === 'pagehide') { c.get('load').click(); c.event('pageshow'); expect(c.request).toHaveBeenCalledTimes(1); expect(c.get('results').textContent).toBe('') }
  })
  it('admits an explicit grouped/window request while draft changes only invalidate locally', async () => {
    const f = await fixture(), c = controls(f.query)
    c.get('group').change('provider-model'); c.get('from').change('2000-01-01T00:00:00.000Z'); c.get('before').change('2099-01-01T00:00:00.000Z')
    expect(c.request).not.toHaveBeenCalled(); c.get('load').click()
    expect(c.request).toHaveBeenCalledExactlyOnceWith({ operation: 'usage', id: f.run.id, groupBy: 'provider-model', window: { from: '2000-01-01T00:00:00.000Z', before: '2099-01-01T00:00:00.000Z' } })
    c.get('clear').click(); c.pending[0]!({}); await c.settle(); expect(c.get('group').value).toBe(''); expect(c.get('results').textContent).toBe('')
  })
})

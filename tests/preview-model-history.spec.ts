import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID, webcrypto } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { createPreview, projectPreviewModelHistory } from '../src/preview/index.ts'
import { liveModelHistoryControls, modelHistoryHtml } from '../src/preview/model-history-controls.ts'
import { LocalRuntime } from '../src/runtime/local.ts'

const at = '2026-09-30T00:00:00.000Z'
const source = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'history', name: 'PRIVATE_SOURCE' },
  spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
    model: { type: 'llm', config: { provider: 'fixture', model: 'fixture-model', connection: { mode: 'workspace', id: 'fixture' }, prompt: '${{ inputs }}',
      responseFormat: 'text', historyScope: 'none', generation: { maxTokens: 30, stream: false }, execution: { maxAttempts: 3, timeoutSeconds: 5 } } },
    end: { type: 'output', config: { value: '${{ nodes.model.output }}' } } }, edges: [{ from: 'start', to: 'model' }, { from: 'model', to: 'end' }] } })
const preview = createPreview(source), hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function envelope(count = 1, runId = randomUUID()) {
  const snapshot: any = { schemaVersion: 1, format: 'jevable.ai/run-evidence', run: { id: runId, revision: preview.revision, status: 'executing' },
    models: { format: 'jevable.model-history/v1', source: 'configured-model-store', calls: Array.from({ length: count }, () => ({
      nodeId: 'model', attemptId: randomUUID(), evidence: 'recorded', evidenceSchemaVersion: 2, intentAt: at, status: 'pending',
      policy: { kind: 'transient-http-v1', maxAttempts: 3, timeoutSeconds: 5 }, tries: [
        { id: randomUUID(), number: 1, intentAt: at, status: 'failed', settledAt: at, code: 'http-error', httpStatus: 503, scheduledDelayMs: 100 },
        { id: randomUUID(), number: 2, intentAt: at, status: 'pending', trace: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 0 } },
      ] })) } }
  return { schemaVersion: 1, snapshot, checksum: { algorithm: 'sha256', encoding: 'JSON.stringify(snapshot)', value: hash(snapshot) } }
}
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals() })

describe('serialized model-history projection', () => {
  it('admits retained fields only and remains import-free when serialized', () => {
    const value = envelope(), call = value.snapshot.models.calls[0]
    call.request = { prompt: 'PRIVATE_PROMPT' }; call.route = 'PRIVATE_ENDPOINT'; call.rawError = 'PRIVATE_ERROR'; call.tries[0].body = 'PRIVATE_BODY'
    const result = projectPreviewModelHistory(preview, value.snapshot.run.id, value)
    expect(result.calls[0]).toMatchObject({ status: 'pending', tries: [{ status: 'failed', scheduledDelayMs: 100 }, { status: 'pending' }] })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_')
    expect(runInNewContext(`(${projectPreviewModelHistory.toString()})(preview, id, value)`, { preview, id: value.snapshot.run.id, value })).toEqual(result)
  })
  it('distinguishes legacy, missing and older unavailable records from empty history', () => {
    const value = envelope(), call = value.snapshot.models.calls[0]
    call.evidenceSchemaVersion = 1; delete call.tries; delete call.policy
    expect(projectPreviewModelHistory(preview, value.snapshot.run.id, value).calls[0]).not.toHaveProperty('tries')
    value.snapshot.models.calls = [{ nodeId: 'model', attemptId: randomUUID(), evidence: 'not-recorded' }]
    expect(projectPreviewModelHistory(preview, value.snapshot.run.id, value).calls[0]!.evidence).toBe('not-recorded')
    value.snapshot.models.calls = []
    expect(projectPreviewModelHistory(preview, value.snapshot.run.id, value)).toMatchObject({ available: true, calls: [] })
    delete value.snapshot.models
    expect(projectPreviewModelHistory(preview, value.snapshot.run.id, value)).toMatchObject({ available: false, calls: [] })
  })
  it.each(['foreign-run', 'revision', 'node', 'private', 'unknown-status', 'code', 'order', 'duplicate', 'trace', 'delay', 'exhausted-delay', 'usage', 'root-status', 'format', 'budget', 'calendar', 'pending-settlement', 'unknown-loop'])(
    'rejects unsafe or contradictory metadata: %s', fault => {
      const value = envelope(), call = value.snapshot.models.calls[0]
      if (fault === 'foreign-run') value.snapshot.run.id = randomUUID()
      if (fault === 'revision') value.snapshot.run.revision = '0'.repeat(64)
      if (fault === 'node') call.nodeId = 'end'
      if (fault === 'private') value.snapshot.private = { output: 'PRIVATE' }
      if (fault === 'unknown-status') call.tries[0].status = 'PRIVATE_ERROR'
      if (fault === 'code') call.tries[0].code = 'PRIVATE_ERROR'
      if (fault === 'order') call.tries[1].number = 3
      if (fault === 'duplicate') call.tries[1].id = call.tries[0].id
      if (fault === 'trace') call.tries[1].trace.traceId = '0'.repeat(32)
      if (fault === 'delay') call.tries[0].scheduledDelayMs = 99
      if (fault === 'exhausted-delay') { call.policy.maxAttempts = 2; call.tries[1] = { ...call.tries[0], id: randomUUID(), number: 2, scheduledDelayMs: 200 } }
      if (fault === 'usage') { call.status = 'completed'; call.settledAt = at; call.usage = { tries: 2, inputTokens: -1 } }
      if (fault === 'root-status') { call.status = 'failed'; call.settledAt = at; call.code = 'http-error' }
      if (fault === 'format') value.snapshot.models.format = 'future/v9'
      if (fault === 'budget') value.snapshot.models.calls = Array(50001).fill(call)
      if (fault === 'calendar') call.intentAt = '2026-02-30T00:00:00.000Z'
      if (fault === 'pending-settlement') call.tries[1].settledAt = at
      if (fault === 'unknown-loop') call.scope = { loop: 'missing', index: 0 }
      expect(() => projectPreviewModelHistory(preview, fault === 'foreign-run' ? randomUUID() : value.snapshot.run.id, value)).toThrow('cannot be safely matched')
    })
  it('preserves zero-based loop identity and cancellation during backoff in a PostgreSQL envelope', () => {
    const definition = JSON.parse(source), model = definition.spec.nodes.model
    model.config.prompt = '${{ loop.item }}'; definition.spec.inputSchema = { type: 'array', items: { type: 'string' }, maxItems: 2 }
    definition.spec.nodes = { start: definition.spec.nodes.start, each: { type: 'loop', config: { mode: 'forEach', items: '${{ inputs }}',
      maxIterations: 2, timeoutSeconds: 30, body: { entry: 'model', nodes: { model }, edges: [], exits: [{ from: 'model', result: '${{ nodes.model.output }}' }] } } },
      end: { type: 'output', config: { value: '${{ nodes.each.output.results }}' } } }
    definition.spec.edges = [{ from: 'start', to: 'each' }, { from: 'each', port: 'done', to: 'end' }]
    const loopPreview = createPreview(JSON.stringify(definition)), value = envelope(), call = value.snapshot.models.calls[0]
    value.schemaVersion = 2; value.snapshot.schemaVersion = 2; value.snapshot.run.revision = loopPreview.revision; value.snapshot.run.status = 'cancelled'
    value.snapshot.storage = { kind: 'postgres', recordVersion: '9007199254740993' }
    call.scope = { loop: 'each', index: 1 }; call.tries.pop(); call.status = 'failed'; call.code = 'cancelled'; call.settledAt = at
    const original = JSON.stringify(value), result = projectPreviewModelHistory(loopPreview, value.snapshot.run.id, value)
    expect(result.calls[0]).toMatchObject({ scope: { loop: 'each', index: 1 }, status: 'failed', code: 'cancelled',
      tries: [{ number: 1, status: 'failed', scheduledDelayMs: 100 }] })
    expect(JSON.stringify(value)).toBe(original)
  })
  it('reads actual retried runtime exports offline with no extra provider dispatch', async () => {
    const runtime = await LocalRuntime.open({ dataDirectory: await mkdtemp(join(tmpdir(), 'jevable-history-view-')) }); cleanup.push(() => runtime.close())
    runtime.configureConnection({ id: 'fixture', provider: 'fixture', protocol: 'openai-compatible', endpoint: 'http://127.0.0.1:1/v1', allowedModels: ['fixture-model'],
      authentication: { kind: 'none' }, tokenParameter: 'max_tokens', maxRequestBytes: 10000, maxResponseBytes: 10000, maxStreamEvents: 100, maxTimeoutSeconds: 5 }, 0, 'local:test')
    const fetch = vi.fn(async () => fetch.mock.calls.length === 1 ? new Response('PRIVATE_FAILURE', { status: 503 }) : new Response(JSON.stringify({ choices: [
      { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'PRIVATE_OUTPUT' } } ] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    const run = await runtime.run(source, 'PRIVATE_INPUT'), evidence = await runtime.exportRun(run.id)
    const projection = projectPreviewModelHistory(preview, run.id, evidence)
    expect(projection.workflowStatus).toBe('completed'); expect(JSON.stringify(projection)).not.toContain('PRIVATE_')
    expect(projection.calls[0]).toMatchObject({ status: 'completed', usage: { tries: 2 }, tries: [{ status: 'failed' }, { status: 'completed' }] })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

/** Minimal controller/element double, not browser, visual, layout, keyboard or CSP qualification. */
class Element {
  private text = ''; children: Element[] = []; disabled = false; className = ''; tabIndex = -1
  attributes = new Map<string, string>(); handlers = new Map<string, (() => void)[]>()
  constructor(readonly tag: string) {}
  set textContent(value: string) { this.text = value; this.children = [] }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join('\n') }
  set innerHTML(_value: string) { throw Error('Unsafe dynamic markup') }
  append(child: Element) { this.children.push(child) }
  replaceChildren() { this.children = []; this.text = '' }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  addEventListener(name: string, fn: () => void) { this.handlers.set(name, [...this.handlers.get(name) ?? [], fn]) }
  click() { for (const fn of this.handlers.get('click') ?? []) fn() }
}
function controls(initial = envelope(), cryptoContext: unknown = webcrypto) {
  const elements = new Map([...modelHistoryHtml.matchAll(/id="([^"]+)"/g)].map(match => [match[1]!, new Element('div')]))
  const get = (id: string) => { const el = elements.get(id); if (!el) throw Error('Missing HTML control'); return el }
  let selected: { runId: string; preview: typeof preview } | undefined = { runId: initial.snapshot.run.id, preview }
  const pending: ReturnType<typeof Promise.withResolvers<unknown>>[] = []
  const request = vi.fn((_command: unknown) => { const next = Promise.withResolvers<unknown>(); pending.push(next); return next.promise })
  const document = { getElementById: get, createElement: (tag: string) => new Element(tag) }
  const controller = runInNewContext(`(${liveModelHistoryControls.toString()})(ctx, project)`, {
    document, crypto: cryptoContext, TextEncoder, Uint8Array,
    ctx: { request, current: () => selected }, project: projectPreviewModelHistory,
  }) as ReturnType<typeof liveModelHistoryControls>
  return { get, pending, request, controller, initial, select: (value: typeof selected) => { selected = value; controller.observe() } }
}

describe('read-only model-history panel controller (not browser qualification)', () => {
  it('fails closed when Web Crypto is unavailable rather than claiming a verified snapshot', async () => {
    const f = controls(envelope(), null); f.get('model-history-load').click(); f.pending[0]!.resolve(f.initial)
    await vi.waitFor(() => expect(f.get('model-history-message').textContent).toContain('unavailable or invalid'))
    expect(f.get('model-history-summary').textContent).toBe(''); expect(f.request).toHaveBeenCalledOnce()
  })
  it('clears a previously displayed snapshot when its explicit refresh fails', async () => {
    const f = controls(); f.get('model-history-load').click(); f.pending[0]!.resolve(f.initial)
    await vi.waitFor(() => expect(f.get('model-history-calls').children).toHaveLength(1))
    f.get('model-history-load').click(); expect(f.get('model-history-calls').children).toHaveLength(0)
    f.pending[1]!.reject(Error('PRIVATE_FAILURE'))
    await vi.waitFor(() => expect(f.get('model-history-message').textContent).toContain('unavailable or invalid'))
    expect(f.get('model-history-summary').textContent).toBe(''); expect(f.get('model-history-range').textContent).toBe('')
  })
  it('loads only on explicit action, verifies the checksum, paginates locally and never persists payloads', async () => {
    const f = controls(envelope(26))
    expect(f.request).not.toHaveBeenCalled(); f.controller.observe(); expect(f.request).not.toHaveBeenCalled()
    f.get('model-history-load').click(); f.get('model-history-load').click()
    expect(f.request).toHaveBeenCalledExactlyOnceWith({ operation: 'evidence', id: f.initial.snapshot.run.id })
    f.pending[0]!.resolve(f.initial)
    await vi.waitFor(() => expect(f.get('model-history-summary').textContent).toContain('SHA-256 verified'))
    expect(f.get('model-history-calls').children).toHaveLength(25)
    expect(f.get('model-history-range').textContent).toContain('1–25 of 26')
    expect(f.get('model-history-calls').textContent).toContain('100ms scheduled; not proof of another try')
    f.get('model-history-next').click(); expect(f.get('model-history-calls').children).toHaveLength(1)
    expect(f.get('model-history-range').textContent).toContain('26–26 of 26')
    f.get('model-history-prev').click(); expect(f.get('model-history-calls').children).toHaveLength(25)
    expect(f.request).toHaveBeenCalledOnce()
    const region = f.get('model-history-calls').children[0]!.children.find(el => el.className === 'model-history-scroll')!
    expect(region.tabIndex).toBe(0); expect(region.attributes.get('role')).toBe('region')
    expect(region.children[0]!.children[0]!.tag).toBe('caption')
  })
  it.each(['checksum', 'private', 'foreign', 'malformed', 'rejected'])('clears failed reads without echoing errors or retrying: %s', fault => {
    const f = controls(); f.get('model-history-load').click()
    if (fault === 'rejected') f.pending[0]!.reject(Error('PRIVATE_RAW_FAILURE'))
    else {
      const value = f.initial
      if (fault === 'checksum') value.checksum.value = '0'.repeat(64)
      if (fault === 'private') value.snapshot.private = { credential: 'PRIVATE_TOKEN' }
      if (fault === 'foreign') value.snapshot.run.id = randomUUID()
      if (fault === 'malformed') value.snapshot.models.calls[0].tries[0].code = 'PRIVATE_ERROR'
      f.pending[0]!.resolve(value)
    }
    return vi.waitFor(() => {
      expect(f.get('model-history-message').textContent).toContain('unavailable or invalid')
      expect(f.get('model-history-calls').children).toHaveLength(0)
      expect(f.get('model-history-summary').textContent).toBe('')
      expect(f.get('model-history-message').textContent).not.toContain('PRIVATE_'); expect(f.request).toHaveBeenCalledOnce()
    })
  })
  it('discards late reads after selection changes, including returning to the same run', async () => {
    const f = controls(); f.get('model-history-load').click()
    f.select({ runId: randomUUID(), preview }); f.select({ runId: f.initial.snapshot.run.id, preview })
    f.pending[0]!.resolve(f.initial)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(f.get('model-history-calls').children).toHaveLength(0)
    expect(f.get('model-history-message').textContent).toContain('Load a read-only')
    f.get('model-history-load').click(); f.pending[1]!.resolve(f.initial)
    await vi.waitFor(() => expect(f.get('model-history-calls').children).toHaveLength(1))
    f.select(undefined); expect(f.get('model-history-calls').children).toHaveLength(0)
    expect(f.get('model-history-load').disabled).toBe(true)
  })
  it('renders markup-looking node identifiers as text only, and never renders unexpected provider fields', async () => {
    const f = controls(), nodeId = '<img src=x onerror=PRIVATE_SCRIPT>'
    const altered = structuredClone(preview); altered.graphs[0]!.nodes.find(node => node.id === 'model')!.id = nodeId
    f.initial.snapshot.models.calls[0].nodeId = nodeId; f.initial.snapshot.models.calls[0].prompt = 'PRIVATE_PROMPT'
    f.initial.checksum.value = hash(f.initial.snapshot); f.select({ runId: f.initial.snapshot.run.id, preview: altered })
    f.get('model-history-load').click(); f.pending[0]!.resolve(f.initial)
    await vi.waitFor(() => expect(f.get('model-history-calls').children).toHaveLength(1))
    expect(f.get('model-history-calls').textContent).toContain(nodeId)
    expect(f.get('model-history-calls').textContent).not.toContain('PRIVATE_PROMPT')
  })
})

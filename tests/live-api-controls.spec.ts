import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { livePreviewBrowser } from '../src/preview/live-page.ts'
import { liveTestControls } from '../src/preview/test-controls.ts'
import { PROTOCOL_VERSION } from '../src/capabilities.ts'

/** Serialized controller and DOM doubles, not a browser, CSP or accessibility qualification. */
class Element {
  value = ''; textContent = ''; disabled = false; hidden = false; checked = false
  children: Element[] = []; handlers = new Map<string, (() => void)[]>()
  attributes = new Map<string, string>(); focused = false
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  focus() { this.focused = true }
  click() { if (!this.disabled) this.fire() }
  addEventListener(event: string, fn: () => void) { this.handlers.set(event, [...this.handlers.get(event) ?? [], fn]) }
  append(child: Element) { this.children.push(child) }
  replaceChildren() { this.children = [] }
  fire(event = 'click') { for (const fn of this.handlers.get(event) ?? []) fn() }
}
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
afterEach(() => vi.unstubAllGlobals())
function fixture(entry = { local: true, api: true }, retained: Record<string, unknown> = {}, withTests = false,
  initial: { preview?: unknown; ready?: boolean; run?: { id: string; status: string; attemptId?: string } } = {}) {
  const instance = randomUUID(), key = `jevable.preview.${instance}`, token = 'a'.repeat(64), elements = new Map<string, Element>()
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)! }
  const storage = new Map([[key, JSON.stringify({ token, expiresAt: new Date(Date.now() + 60000).toISOString(), ...retained })]])
  const calls: any[] = [], before: any[] = [], runs = new Map<string, any>()
  if (initial.run) runs.set(initial.run.id, initial.run)
  const viewGates: ReturnType<typeof gate>[] = []
  let failStorage = false, failView = false, ready = initial.ready ?? true
  const fetch = vi.fn(async (_path: string, options: RequestInit) => {
    const command = JSON.parse(String(options.body)); calls.push(command)
    let result: any
    if (command.operation === 'view') {
      const wait = viewGates.shift(), wasReady = ready
      if (wait) await wait.promise
      if (failView) { failView = false; throw Error('Readiness response lost') }
      const mode = command.triggerMode === 'api' ? { triggerMode: 'api' } : {}
      result = { project: { id: randomUUID(), generation: 1, revision: 'b'.repeat(64) }, preview: initial.preview ?? {}, entry,
        inputSchema: { type: 'string' }, sample: 'PRIVATE_INPUT', readiness: { ...mode,
          runtimeReadiness: wasReady && (command.triggerMode === 'api' ? entry.api : entry.local) ? 'ready' : 'unavailable' } }
    } else if (command.operation === 'runs') result = { runs: [...runs.values()] }
    else if (command.operation === 'show') result = runs.get(command.id)
    else if (command.operation === 'run') {
      before.push(JSON.parse(storage.get(key)!))
      result = { id: command.id, status: command.paused ? 'paused' : 'completed', output: command.input,
        ...(command.triggerMode ? { triggerMode: command.triggerMode } : {}), checkpointSha256: 'c'.repeat(64) }
      runs.set(command.id, result)
    } else if (command.operation === 'tests.list') result = { tests: [] }
    else if (command.operation === 'tests.show') result = { id: command.id, generation: 2, status: 'accepted', sha256: 'd'.repeat(64),
      definition: { title: 'API saved case', input: 'saved input', expectations: [{ kind: 'status', value: 'completed' }], triggerMode: 'api' } }
    else if (command.operation === 'tests.run') {
      before.push(JSON.parse(storage.get(key)!))
      const run = { id: command.runId, status: 'completed', output: 'saved input', triggerMode: 'api' }; runs.set(run.id, run)
      result = { run, assessment: 'passed', workflowStatus: 'completed', terminal: true }
    } else throw Error('Unexpected controller operation')
    return new Response(JSON.stringify({ instanceId: instance, result }), { headers: {
      'content-type': 'application/json', 'x-jevable-protocol': PROTOCOL_VERSION } })
  })
  const context = { document: { getElementById: get, createElement: () => new Element(), querySelector: () => get('notice') },
    sessionStorage: { getItem: (name: string) => storage.get(name) ?? null,
      setItem: (name: string, value: string) => { if (failStorage) throw Error('Storage unavailable'); storage.set(name, value) }, removeItem: (name: string) => storage.delete(name) },
    fetch, crypto: { randomUUID }, viewer: vi.fn(), instance, protocol: PROTOCOL_VERSION, TextDecoder, Uint8Array,
    AbortController, Error, setTimeout, clearTimeout, location: { reload: vi.fn() }, window: { addEventListener: vi.fn() } }
  runInNewContext(`(${livePreviewBrowser.toString()})(viewer, instance, protocol, ${withTests ? liveTestControls.toString() : 'undefined'})`, context)
  const connected = () => vi.waitFor(() => expect(get('live-message').textContent).toContain('Session open'))
  const select = (mode: '' | 'api') => { get('live-trigger-mode').value = mode; get('live-trigger-mode').fire('change') }
  return { get, calls, storage, key, before, runs, connected, select, holdView: () => { const wait = gate(); viewGates.push(wait); return wait },
    failStorage: () => { failStorage = true }, failView: () => { failView = true }, setReady: (value: boolean) => { ready = value } }
}

describe('explicit live API entry: serialized intent and retained-mode controls', () => {
  it('explains a disabled Run action beside the button while the selected request waits', async () => {
    const id = randomUUID()
    const f = fixture({ local: true, api: false }, { runId: id }, false,
      { run: { id, status: 'waiting', attemptId: randomUUID() } })
    await f.connected()
    expect(f.get('live-run').disabled).toBe(true)
    expect(f.get('live-run-guidance').textContent).toContain('Open Approvals to review it')
    expect(f.get('live-run-guidance').textContent).toContain('set it aside below')
    expect(f.get('live-set-aside').disabled).toBe(false)
    expect(f.calls.map(call => call.operation)).toEqual(['view', 'runs', 'show'])
  })
  it('sets aside only a confirmed waiting selection, retains its history and requires another explicit Run', async () => {
    const id = randomUUID()
    const f = fixture({ local: true, api: false }, { runId: id }, false,
      { run: { id, status: 'waiting', attemptId: randomUUID() } })
    await f.connected()
    f.get('live-set-aside').fire()
    expect(JSON.parse(f.storage.get(f.key)!).runId).toBeUndefined()
    expect(f.runs.get(id)?.status).toBe('waiting')
    expect(f.get('live-status').textContent).toBe('No run selected.')
    expect(f.get('live-run').disabled).toBe(false)
    expect(f.get('live-set-aside').disabled).toBe(true)
    expect(f.get('live-message').textContent).toContain('Nothing was approved, cancelled or started')
    expect(f.calls.map(call => call.operation)).toEqual(['view', 'runs', 'show'])
    f.get('live-history').value = id; f.get('live-history').fire('change')
    await vi.waitFor(() => expect(f.calls.filter(call => call.operation === 'show')).toHaveLength(2))
    expect(f.get('live-run').disabled).toBe(true)
    expect(JSON.parse(f.storage.get(f.key)!).runId).toBe(id)
  })
  it('does not set aside an unresolved or unpersistable waiting selection', async () => {
    const id = randomUUID()
    const pending = fixture({ local: true, api: false }, { runId: id, cancelId: randomUUID() }, false,
      { run: { id, status: 'waiting', attemptId: randomUUID() } })
    await pending.connected()
    expect(pending.get('live-set-aside').disabled).toBe(true)
    pending.get('live-set-aside').fire()
    expect(JSON.parse(pending.storage.get(pending.key)!).runId).toBe(id)
    const failing = fixture({ local: true, api: false }, { runId: id }, false,
      { run: { id, status: 'waiting', attemptId: randomUUID() } })
    await failing.connected()
    failing.failStorage(); failing.get('live-set-aside').fire()
    expect(JSON.parse(failing.storage.get(failing.key)!).runId).toBe(id)
    expect(failing.get('live-run').disabled).toBe(true)
    expect(failing.calls.map(call => call.operation)).toEqual(['view', 'runs', 'show'])
  })
  it('unlocks a separately accepted saved case without running or deciding the waiting case', async () => {
    const id = randomUUID(), testId = randomUUID()
    const f = fixture({ local: true, api: true }, { runId: id, testId }, true,
      { run: { id, status: 'waiting', attemptId: randomUUID() } })
    await f.connected()
    await vi.waitFor(() => expect(f.calls.some(call => call.operation === 'tests.show')).toBe(true))
    expect(f.get('test-run').disabled).toBe(true)
    f.get('live-set-aside').fire()
    expect(f.get('test-run').disabled).toBe(false)
    expect(f.calls.some(call => call.operation === 'tests.run' || call.operation === 'decide' || call.operation === 'cancel')).toBe(false)
    expect(f.runs.get(id)?.status).toBe('waiting')
  })
  it('does not rewrite the same Run live-region hint on read-only status refresh', async () => {
    const id = randomUUID()
    const f = fixture({ local: true, api: false }, { runId: id }, false,
      { run: { id, status: 'waiting', attemptId: randomUUID() } })
    await f.connected()
    const guidance = f.get('live-run-guidance')
    let value = guidance.textContent, writes = 0
    Object.defineProperty(guidance, 'textContent', {
      get: () => value,
      set: (next: string) => { value = next; writes++ },
    })
    f.get('live-inspect').fire()
    await vi.waitFor(() => expect(f.calls.filter(call => call.operation === 'show')).toHaveLength(2))
    expect(writes).toBe(0)
    f.runs.set(id, { id, status: 'completed' })
    f.get('live-inspect').fire()
    await vi.waitFor(() => expect(f.calls.filter(call => call.operation === 'show')).toHaveLength(3))
    await vi.waitFor(() => expect(value).toBe(''))
    expect(writes).toBe(1)
    expect(f.get('live-run').disabled).toBe(false)
  })
  it.each(['workflow', 'workflow/repeat'])('explains typed Custom steps in %s without execution or stale warnings', async scope => {
    const f = fixture(undefined, {}, false, { ready: false,
      preview: { graphs: [{ scope, nodes: [{ id: 'code', node: { type: 'custom' } }] }] } })
    await f.connected()
    expect(f.get('live-readiness').textContent).toContain('Custom execution unavailable.')
    expect(f.get('live-run').disabled).toBe(true)
    expect(f.calls).toEqual([{ operation: 'view' }, { operation: 'runs' }])
    f.failView(); f.get('live-refresh-readiness').fire()
    await vi.waitFor(() => expect(f.get('live-readiness').textContent).toContain('readiness unavailable'))
    expect(f.get('live-readiness').textContent).not.toContain('Custom execution unavailable.')
    f.setReady(true); f.get('live-refresh-readiness').fire()
    await vi.waitFor(() => expect(f.get('live-readiness').textContent).toContain('Runtime: ready.'))
    expect(f.get('live-readiness').textContent).not.toContain('Custom execution unavailable.')
    expect(f.calls.every(c => ['view', 'runs'].includes(c.operation))).toBe(true)
  })
  it('does not infer a Custom execution restriction from a user-authored title', async () => {
    const f = fixture(undefined, {}, false, { ready: false,
      preview: { graphs: [{ scope: 'workflow', nodes: [{ id: 'result', node: { type: 'output', title: 'Custom execution unavailable.' } }] }] } })
    await f.connected()
    expect(f.get('live-readiness').textContent).not.toContain('Custom execution unavailable.')
    expect(f.get('live-run').disabled).toBe(true)
    expect(f.calls).toEqual([{ operation: 'view' }, { operation: 'runs' }])
  })
  it('never infers API mode, refreshes readiness without execution and retains selected mode before Run', async () => {
    const f = fixture({ local: false, api: true }); await f.connected()
    expect(f.calls).toEqual([{ operation: 'view' }, { operation: 'runs' }])
    expect(f.get('live-entry-local').disabled).toBe(true); expect(f.get('live-trigger-mode').value).toBe('')
    expect(f.get('live-run').disabled).toBe(true); f.get('live-run').fire()
    expect(f.calls.some(c => c.operation === 'run')).toBe(false)
    f.select('api'); await vi.waitFor(() => expect(f.get('live-run').disabled).toBe(false))
    expect(f.calls.at(-1)).toEqual({ operation: 'view', triggerMode: 'api' }); expect(f.calls.some(c => c.operation === 'run')).toBe(false)
    f.get('live-run').fire(); await vi.waitFor(() => expect(f.get('live-status').textContent).toContain('recorded API entry'))
    const run = f.calls.find(c => c.operation === 'run')
    expect(run.triggerMode).toBe('api'); expect(f.before[0]).toMatchObject({ triggerMode: 'api', runId: run.id })
    expect(f.storage.get(f.key)).not.toContain('PRIVATE_INPUT')
  })
  it('restores valid API selection using reads only and does not allocate a run', async () => {
    const f = fixture({ local: false, api: true }, { triggerMode: 'api' }); await f.connected()
    expect(f.calls).toEqual([{ operation: 'view', triggerMode: 'api' }, { operation: 'runs' }])
    expect(f.get('live-trigger-mode').value).toBe('api'); expect(JSON.parse(f.storage.get(f.key)!)).not.toHaveProperty('runId')
  })
  it('executes an accepted API case even when default local entry is unavailable; the request cannot override the reviewed mode', async () => {
    const f = fixture({ local: false, api: true }, {}, true); await f.connected()
    expect(f.get('live-run').disabled).toBe(true)
    const id = randomUUID(); f.get('test-list').value = id; f.get('test-list').fire('change')
    await vi.waitFor(() => expect(f.get('test-run').disabled).toBe(false))
    expect(JSON.parse(f.get('test-editor').value).triggerMode).toBe('api')
    f.get('test-run').fire(); await vi.waitFor(() => expect(f.get('test-report').textContent).toContain('passed'))
    const command = f.calls.find(c => c.operation === 'tests.run')
    expect(command).not.toHaveProperty('triggerMode'); expect(command.test).toEqual({ id, generation: 2, sha256: 'd'.repeat(64) })
    expect(f.before[0].runId).toBe(command.runId); expect(f.get('live-trigger-mode').value).toBe('')
  })
  it('does not silently edit test JSON or authorize a case when selection changes', async () => {
    const f = fixture(undefined, {}, true); await f.connected()
    const draft = f.get('test-editor').value; f.get('test-authorize').checked = true
    f.select('api'); await vi.waitFor(() => expect(f.get('live-run').disabled).toBe(false))
    expect(f.get('test-editor').value).toBe(draft)
    f.get('test-use-entry').fire(); await vi.waitFor(() => expect(JSON.parse(f.get('test-editor').value).triggerMode).toBe('api'))
    expect(f.get('test-authorize').checked).toBe(false)
    expect(f.calls.every(c => ['view', 'runs', 'tests.list'].includes(c.operation))).toBe(true)
  })
  it('ignores late readiness responses after rapid explicit entry changes', async () => {
    const f = fixture(); await f.connected()
    const old = f.holdView(); f.select('api')
    expect(f.get('live-run').disabled).toBe(true); expect(f.get('live-trigger-mode').disabled).toBe(false)
    f.setReady(false); f.select('')
    await vi.waitFor(() => expect(f.get('live-readiness').textContent).toContain('Runtime: unavailable'))
    old.release(); await vi.waitFor(() => expect(f.calls.filter(c => c.operation === 'view')).toHaveLength(3))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(f.get('live-readiness').textContent).toContain('default manual/chat'); expect(f.get('live-run').disabled).toBe(true)
    expect(JSON.parse(f.storage.get(f.key)!)).not.toHaveProperty('triggerMode')
    expect(f.calls.some(c => c.operation === 'run')).toBe(false)
  })
  it('locks selection while a paused run is retained and never rewrites its recorded mode', async () => {
    const f = fixture(undefined, { triggerMode: 'api' }); await f.connected()
    f.get('live-start-paused').checked = true; f.get('live-run').fire()
    await vi.waitFor(() => expect(f.get('live-status').textContent).toContain('paused'))
    expect(f.get('live-trigger-mode').disabled).toBe(true); f.select('')
    expect(f.get('live-trigger-mode').value).toBe('api'); expect(f.calls.filter(c => c.operation === 'view')).toHaveLength(1)
    expect([...f.runs.values()][0].triggerMode).toBe('api')
  })
  it('refuses an undeclared selector and fails before dispatch when tab retention is unavailable', async () => {
    const f = fixture({ local: true, api: false }); await f.connected()
    f.select('api'); expect(f.get('live-message').textContent).toContain('not declared'); expect(f.calls.filter(c => c.operation === 'view')).toHaveLength(1)
    const g = fixture(); await g.connected(); g.failStorage(); g.select('api')
    expect(g.get('live-message').textContent).toContain('Storage unavailable'); expect(g.get('live-trigger-mode').value).toBe('')
    expect(g.calls.filter(c => c.operation === 'view')).toHaveLength(1); expect(JSON.parse(g.storage.get(g.key)!)).not.toHaveProperty('triggerMode')
  })
  it.each(['manual', 'chat', 'webhook', null, false])('refuses corrupt retained entry %s without reconnecting or dispatching', mode => {
    const f = fixture(undefined, { triggerMode: mode })
    expect(f.calls).toEqual([]); expect(f.get('live-run').disabled).toBe(true); expect(f.get('live-message').textContent).toContain('entry/control identity invalid')
  })
  it('offers an explicit readiness-only retry after a failed read with no automatic replay', async () => {
    const f = fixture(); await f.connected(); f.failView(); f.select('api')
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Choose Refresh entry readiness'))
    expect(f.get('live-message').textContent).not.toContain('Readiness response lost')
    expect(f.get('live-run').disabled).toBe(true); expect(f.calls.filter(c => c.operation === 'view')).toHaveLength(2)
    f.get('live-refresh-readiness').fire(); await vi.waitFor(() => expect(f.get('live-run').disabled).toBe(false))
    expect(f.calls.at(-1)).toEqual({ operation: 'view', triggerMode: 'api' }); expect(f.calls.some(c => c.operation === 'run')).toBe(false)
  })
})

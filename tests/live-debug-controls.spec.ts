import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { livePreviewBrowser } from '../src/preview/live-page.ts'
import { PROTOCOL_VERSION } from '../src/capabilities.ts'
import { liveBreakpointControls } from '../src/preview/breakpoint-controls.ts'
import { createPreview } from '../src/preview/model.ts'
import { readFile } from 'node:fs/promises'
import { previewRecoveryTarget } from '../src/preview/recovery.ts'
import { liveNodeInspectionControls } from '../src/preview/node-inspection-controls.ts'
import { projectPreviewExecution } from '../src/preview/execution.ts'
import { setTimeout as schedule, clearTimeout as cancelTimer } from 'node:timers'

const echoPreview = createPreview(await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8'))
const nativePreview = createPreview(await readFile(new URL('../examples/native-decision.yaml', import.meta.url), 'utf8'))

/** Controller doubles, deliberately not browser, rendering, keyboard or CSP qualification. */
class Element {
  value = ''; textContent = ''; hidden = false; disabled = false; checked = false
  children: Element[] = []; listeners = new Map<string, (() => void)[]>()
  attributes = new Map<string, string>(); focused = false
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  focus() { this.focused = true }
  click() { if (!this.disabled) this.fire() }
  addEventListener(event: string, handler: () => void) { this.listeners.set(event, [...this.listeners.get(event) ?? [], handler]) }
  append(child: Element) { this.children.push(child) }
  replaceChildren() { this.children = [] }
  fire(event = 'click') { for (const handler of this.listeners.get(event) ?? []) handler() }
}
type FixtureState = { instance: string; storage: Map<string, string>; runs: Map<string, any>; controls: Map<string, any> }
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
const timers = new Set<ReturnType<typeof schedule>>()
afterEach(() => { for (const timer of timers) cancelTimer(timer); timers.clear(); vi.unstubAllGlobals() })
function fixture(previous?: FixtureState, approval = false, withBreakpoints = false, withRecovery = false, withNodeInspection = false) {
  const preview = withRecovery ? nativePreview : echoPreview
  const state = previous ?? { instance: randomUUID(), storage: new Map(), runs: new Map(), controls: new Map() }
  const key = `jevable.preview.${state.instance}`, token = 'a'.repeat(64), calls: any[] = [], retainedBeforeDispatch: any[] = []
  const elements = new Map<string, Element>(), get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!
  }
  let fault: 'before' | 'after' | undefined, holdRead: ReturnType<typeof gate> | undefined, holdControl: ReturnType<typeof gate> | undefined
  let holdPause: ReturnType<typeof gate> | undefined, holdRun: ReturnType<typeof gate> | undefined, holdDecision: ReturnType<typeof gate> | undefined
  let holdNode: ReturnType<typeof gate> | undefined
  let failStorage = false, readsFinished = 0
  let rejected = false
  vi.stubGlobal('setTimeout', (callback: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    const timer = schedule(callback, ms, ...args); timers.add(timer); return timer
  })
  vi.stubGlobal('document', { getElementById: get, querySelector: () => get('notice'), createElement: () => new Element() })
  vi.stubGlobal('location', { reload: vi.fn() })
  if (withNodeInspection) vi.stubGlobal('window', new Element())
  vi.stubGlobal('sessionStorage', { getItem: (name: string) => state.storage.get(name) ?? null,
    setItem: (name: string, value: string) => { if (failStorage) throw Error('Storage unavailable'); state.storage.set(name, value) },
    removeItem: (name: string) => state.storage.delete(name) })
  const bump = (run: any, phase: number, status = phase >= 3 ? 'completed' : 'paused') => {
    const next = { ...run, revision: preview.revision, phase, status, nodeId: status === 'waiting' ? 'approval' : phase === 0 ? 'start' : 'result',
      checkpointSha256: String(phase).padStart(64, '0'), steps: Array.from({ length: withNodeInspection ? Math.min(phase, 2) : phase },
        (_, i) => ({ nodeId: withNodeInspection ? ['start', 'result'][i] : `node-${i}` })) }
    state.runs.set(run.id, next); return next
  }
  vi.stubGlobal('fetch', vi.fn(async (path: string, options: RequestInit) => {
    const command = JSON.parse(String(options.body)); calls.push(command)
    let result: unknown
    if (path.endsWith('bootstrap')) result = { token, expiresAt: new Date(Date.now() + 60000).toISOString() }
    else if (path.endsWith('logout')) result = {}
    else if (command.operation === 'view') result = { project: { id: 'project', generation: 1, revision: preview.revision }, preview,
      entry: { local: true, api: false }, inputSchema: { type: 'string' }, sample: 'PRIVATE_SUGGESTION', readiness: { runtimeReadiness: 'ready' } }
    else if (command.operation === 'runs') result = { runs: [...state.runs.values()] }
    else if (command.operation === 'show') {
      result = structuredClone(state.runs.get(command.id))
      if (holdRead) { const wait = holdRead; holdRead = undefined; await wait.promise }
      readsFinished++
    } else if (command.operation === 'node.inspect') {
      const run = state.runs.get(command.id)
      expect(command.expectedCheckpointSha256).toBe(run.checkpointSha256)
      result = { schemaVersion: 1, format: 'jevable.preview-node-inspection/v1', privateInspection: true, runId: run.id,
        revision: run.revision, checkpointSha256: run.checkpointSha256, selection: command.selection,
        kind: command.selection.record.kind === 'step' ? 'node-result' : 'checkpoint',
        status: command.selection.record.kind === 'step' ? 'settled' : run.status,
        input: { status: 'unavailable' }, output: command.selection.record.kind === 'step'
          ? { status: 'recorded', value: 'PRIVATE_SELECTED_RESULT' } : { status: 'unavailable' } }
      if (holdNode) { const wait = holdNode; holdNode = undefined; await wait.promise }
    } else if (command.operation === 'run') {
      expect(JSON.parse(state.storage.get(key)!).runId).toBe(command.id)
      result = bump({ id: command.id, startedPaused: command.paused === true }, holdRun ? 0 : command.paused ? 0 : 3, holdRun ? 'executing' : undefined)
      if (holdRun) { const wait = holdRun; holdRun = undefined; await wait.promise }
    } else if (command.operation === 'advance') {
      retainedBeforeDispatch.push(JSON.parse(state.storage.get(key)!)[command.mode === 'pause' ? 'pendingPause' : 'pendingControl'])
      if (rejected) { rejected = false; return new Response(JSON.stringify({ code: 'conflict' }), { status: 409,
        headers: { 'content-type': 'application/json', 'x-jevable-protocol': PROTOCOL_VERSION } }) }
      if (fault === 'before') { fault = undefined; throw Error('Lost response before admission') }
      let run = state.runs.get(command.id)
      const saved = state.controls.get(command.requestId)
      if (saved) expect(command).toEqual(saved)
      else {
        expect(command.expectedCheckpointSha256).toBe(run.checkpointSha256)
        state.controls.set(command.requestId, command)
        if (command.mode === 'recover') {
          expect(command.breakpoints).toBeUndefined(); expect(run.status).toBe('executing')
          run = bump(run, 2); run.lastControl = { requestId: command.requestId, mode: 'recover' }
        } else if (command.mode === 'pause') {
          expect(command.breakpoints).toBeUndefined()
          run = { ...run, checkpointSha256: String(state.controls.size).padStart(64, 'a'),
            lastControl: { requestId: command.requestId, mode: 'pause' }, pause: { requestId: command.requestId } }
          state.runs.set(run.id, run)
        } else {
        delete run.pause
        if (command.breakpoints !== undefined) { run.breakpoints = [...command.breakpoints]; run.breakpointConfigurationRequestId = command.requestId }
        const stops = withBreakpoints && command.mode === 'continue' && !run.breakpoint && run.phase === 0 && run.breakpoints?.includes('result')
        const phase = stops ? 1 : command.mode === 'step' ? run.phase + 1 : approval && run.phase < 2 ? 1 : 3
        run = bump(run, phase, approval && command.mode === 'continue' && phase === 1 ? 'waiting' : undefined)
        delete run.breakpoint
        if (stops) run.breakpoint = { nodeId: 'result', configurationRequestId: run.breakpointConfigurationRequestId,
          checkpointSha256: run.checkpointSha256, stepCount: run.steps.length, at: new Date().toISOString() }
        run.lastControl = { requestId: command.requestId, mode: command.mode }
        if (run.status === 'waiting') run.attemptId = randomUUID()
        }
      }
      result = structuredClone(run)
      if (holdControl) { const wait = holdControl; holdControl = undefined; await wait.promise }
      if (command.mode === 'pause' && holdPause) { const wait = holdPause; holdPause = undefined; await wait.promise }
      if (fault === 'after') { fault = undefined; throw Error('Lost response after admission') }
    } else if (command.operation === 'cancel') {
      const run = state.runs.get(command.id)
      result = { ...run, status: 'cancelled', checkpointSha256: 'c'.repeat(64), cancellation: { id: command.requestId, status: 'stopped' } }
      state.runs.set(command.id, result)
    } else if (command.operation === 'approval') {
      result = { ...state.runs.get(command.id), review: { input: 'PRIVATE_REVIEW' }, actions: ['approve', 'reject'],
        deadlineStatus: 'open-at-observation', timeoutOutcome: 'expired' }
    } else if (command.operation === 'decide') {
      const run = state.runs.get(command.id); expect(command.attemptId).toBe(run.attemptId)
      result = bump(run, command.pauseAfter ? 2 : 3)
      if (holdDecision) { const wait = holdDecision; holdDecision = undefined; await wait.promise }
    } else throw Error(`Unexpected operation: ${command.operation}`)
    return new Response(JSON.stringify({ instanceId: state.instance, result }), { headers: { 'content-type': 'application/json', 'x-jevable-protocol': PROTOCOL_VERSION } })
  }))
  const setExecution = vi.fn(), projectExecution = vi.fn((_preview: any, run: any): any => {
    if (run.phase === 99) throw Error('Unmappable receipt')
    return { runId: run.id, phase: run.phase }
  })
  const setBreakpoints = vi.fn()
  let graphSelect: ((id: string | null) => void) | undefined
  let graphNodeSelect: ((node: { nodeId: string; graphScope: string } | null) => void) | undefined
  const browser: typeof livePreviewBrowser = withRecovery || withNodeInspection ? new Function(`return (${livePreviewBrowser.toString()})`)() : livePreviewBrowser
  const dependencies: Parameters<typeof livePreviewBrowser> = [vi.fn((_data, options) => {
    graphSelect = options?.onSelect; graphNodeSelect = options?.onNodeSelect; return { setExecution, setBreakpoints }
  }), state.instance, PROTOCOL_VERSION, undefined, withNodeInspection ? new Function(`return (${projectPreviewExecution.toString()})`)() : projectExecution]
  dependencies[13] = withBreakpoints ? liveBreakpointControls : undefined
  dependencies[14] = withRecovery ? new Function(`return (${previewRecoveryTarget.toString()})`)() : undefined
  dependencies[21] = withNodeInspection ? new Function(`return (${liveNodeInspectionControls.toString()})`)() : undefined
  browser(...dependencies)
  const connected = async () => { await vi.waitFor(() => expect(get('live-message').textContent).toContain('Session open')) }
  const connect = async () => { get('live-token').value = 'f'.repeat(64); get('live-connect').fire(); await connected() }
  const start = async () => {
    get('live-input').value = JSON.stringify('PRIVATE_DEBUG_INPUT'); get('live-start-paused').checked = true
    get('live-start-paused').fire('change'); expect(get('live-run').textContent).toBe('Start paused')
    get('live-run').fire(); await vi.waitFor(() => expect(get('live-step').disabled).toBe(false))
    return JSON.parse(get('live-result').textContent)
  }
  return { state, key, calls, get, connected, connect, start, retainedBeforeDispatch, setExecution, projectExecution, setBreakpoints,
    graphSelect: (id: string | null) => graphSelect?.(id),
    graphNodeSelect: (node: { nodeId: string; graphScope: string } | null) => graphNodeSelect?.(node),
    reject: () => { rejected = true },
    lose: (when: 'before' | 'after') => { fault = when },
    holdRead: () => { holdRead = gate(); return holdRead }, holdControl: () => { holdControl = gate(); return holdControl },
    holdPause: () => { holdPause = gate(); return holdPause }, holdRun: () => { holdRun = gate(); return holdRun },
    holdDecision: () => { holdDecision = gate(); return holdDecision },
    holdNode: () => { holdNode = gate(); return holdNode },
    readsFinished: () => readsFinished, failStorage: () => { failStorage = true } }
}

describe('serialized full-page selected-node inspection wiring (not browser qualification)', () => {
  it('disconnects and restores without retaining private values or silently reselecting a run', async () => {
    const f = fixture(undefined, false, false, false, true); await f.connect(); const run = await f.start()
    f.get('live-step').fire(); await vi.waitFor(() => expect(f.get('live-step').disabled).toBe(false))
    f.graphNodeSelect({ nodeId: 'start', graphScope: 'workflow' }); f.get('node-private-load').fire()
    await vi.waitFor(() => expect(f.get('node-private-output').textContent).toContain('PRIVATE_SELECTED_RESULT'))
    f.get('live-logout').fire(); await vi.waitFor(() => expect(location.reload).toHaveBeenCalled())
    expect(f.get('node-private-output').textContent).toBe(''); expect(f.state.storage.has(f.key)).toBe(false)
    expect(f.state.runs.has(run.id)).toBe(true)
    const restored = fixture(f.state, false, false, false, true); await restored.connect()
    expect(() => restored.graphNodeSelect({ nodeId: 'start', graphScope: 'workflow' })).not.toThrow()
    expect(restored.get('node-private-load').disabled).toBe(true)
    expect(restored.calls.some(command => command.operation === 'node.inspect' || command.operation === 'run' || command.operation === 'advance')).toBe(false)
  })
  it('does not display an in-flight private response after disconnect', async () => {
    const f = fixture(undefined, false, false, false, true); await f.connect(); await f.start()
    f.get('live-step').fire(); await vi.waitFor(() => expect(f.get('live-step').disabled).toBe(false))
    f.graphNodeSelect({ nodeId: 'start', graphScope: 'workflow' }); const held = f.holdNode(); f.get('node-private-load').fire()
    await vi.waitFor(() => expect(f.calls.some(command => command.operation === 'node.inspect')).toBe(true))
    f.get('live-logout').fire(); await vi.waitFor(() => expect(location.reload).toHaveBeenCalled())
    held.release(); await vi.waitFor(() => expect(f.get('node-private-load').disabled).toBe(true))
    expect(f.get('node-private-output').textContent).toBe(''); expect(f.state.storage.has(f.key)).toBe(false)
  })
  it('allows graph selection before any run and reads private values only after an explicit request', async () => {
    const f = fixture(undefined, false, false, false, true); await f.connect()
    expect(() => f.graphNodeSelect({ nodeId: 'start', graphScope: 'workflow' })).not.toThrow()
    expect(f.get('node-private-load').disabled).toBe(true)
    expect(f.calls.map(command => command.operation)).toEqual([undefined, 'view', 'runs'])
    const run = await f.start()
    expect(f.get('node-private-load').disabled).toBe(false)
    expect(f.calls.some(command => command.operation === 'node.inspect')).toBe(false)
    f.get('node-private-load').fire()
    await vi.waitFor(() => expect(f.get('node-private-message').textContent).toContain('loaded'))
    expect(f.calls.find(command => command.operation === 'node.inspect')).toEqual({ operation: 'node.inspect', id: run.id,
      expectedCheckpointSha256: run.checkpointSha256, selection: { nodeId: 'start', graphScope: 'workflow', record: { kind: 'checkpoint' } } })
    expect(f.get('node-private-output').textContent).toContain('Unavailable')
    expect(f.state.storage.get(f.key)).not.toContain('PRIVATE_SELECTED_RESULT')
  })
  it('wires exact settled-step selection and clears a loaded value on checkpoint changes', async () => {
    const f = fixture(undefined, false, false, false, true); await f.connect(); const run = await f.start()
    f.get('live-step').fire(); await vi.waitFor(() => expect(f.get('live-step').disabled).toBe(false))
    f.graphNodeSelect({ nodeId: 'start', graphScope: 'workflow' }); f.get('node-private-load').fire()
    await vi.waitFor(() => expect(f.get('node-private-output').textContent).toContain('PRIVATE_SELECTED_RESULT'))
    const command = f.calls.find(command => command.operation === 'node.inspect')
    expect(command.selection.record).toEqual({ kind: 'step', index: 0 }); expect(command.expectedCheckpointSha256).not.toBe(run.checkpointSha256)
    f.get('live-inspect').fire(); await vi.waitFor(() => expect(f.readsFinished()).toBe(1))
    expect(f.get('node-private-output').textContent).toContain('PRIVATE_SELECTED_RESULT')
    f.state.runs.set(run.id, { ...f.state.runs.get(run.id), checkpointSha256: 'b'.repeat(64) })
    f.get('live-inspect').fire(); await vi.waitFor(() => expect(f.get('node-private-output').textContent).toBe(''))
    expect(f.calls.filter(command => command.operation === 'node.inspect')).toHaveLength(1)
  })
  it('clears a held read on graph deselection without resurrecting it when selecting the same node again', async () => {
    const f = fixture(undefined, false, false, false, true); await f.connect(); await f.start()
    f.get('live-step').fire(); await vi.waitFor(() => expect(f.get('live-step').disabled).toBe(false))
    f.graphNodeSelect({ nodeId: 'start', graphScope: 'workflow' }); const held = f.holdNode(); f.get('node-private-load').fire()
    await vi.waitFor(() => expect(f.calls.some(command => command.operation === 'node.inspect')).toBe(true))
    f.graphNodeSelect(null); f.graphNodeSelect({ nodeId: 'start', graphScope: 'workflow' }); held.release()
    await vi.waitFor(() => expect(f.get('node-private-load').disabled).toBe(false))
    expect(f.get('node-private-output').textContent).toBe(''); expect(f.state.storage.get(f.key)).not.toContain('PRIVATE_SELECTED_RESULT')
  })
})

async function recoverable(f: ReturnType<typeof fixture>) {
  await f.connect(); const run = await f.start()
  f.state.runs.set(run.id, { ...run, status: 'executing', nodeId: 'judge', attemptId: randomUUID(), checkpointSha256: 'd'.repeat(64) })
  f.get('live-inspect').fire()
  await vi.waitFor(() => expect(f.get('live-recover-authorize').disabled).toBe(false))
  return f.state.runs.get(run.id)
}
function authorizeRecovery(f: ReturnType<typeof fixture>) {
  f.get('live-recover-authorize').checked = true; f.get('live-recover-authorize').fire('change')
}

describe('serialized recovery controller intent and retention (not browser qualification)', () => {
  it('requires checkpoint-specific consent, retains recovery before dispatch and never applies breakpoint drafts or continues', async () => {
    const f = fixture(undefined, false, true, true); await f.connect(); const initial = await f.start()
    f.graphSelect('result'); f.get('breakpoint-toggle').fire()
    const run = { ...initial, status: 'executing', nodeId: 'judge', attemptId: randomUUID(), checkpointSha256: 'd'.repeat(64) }
    f.state.runs.set(run.id, run); f.get('live-inspect').fire()
    await vi.waitFor(() => expect(f.get('live-recover-authorize').disabled).toBe(false))
    expect(f.get('live-recover-status').textContent).toContain('saved response is not yet proven')
    expect(f.get('live-recover').disabled).toBe(true); f.get('live-recover').fire()
    expect(f.calls.some(c => c.operation === 'advance')).toBe(false)
    authorizeRecovery(f); expect(f.get('live-recover').disabled).toBe(false)
    const held = f.holdControl(); f.get('live-recover').fire(); f.get('live-recover').fire()
    await vi.waitFor(() => expect(f.calls.filter(c => c.mode === 'recover')).toHaveLength(1))
    const command = f.calls.find(c => c.mode === 'recover'), { operation: _operation, ...retained } = command
    expect(command.expectedCheckpointSha256).toBe(run.checkpointSha256); expect(command.breakpoints).toBeUndefined()
    expect(f.retainedBeforeDispatch).toEqual([retained]); expect(f.get('live-recover-authorize').checked).toBe(false)
    expect(f.get('live-history').disabled).toBe(true); expect(f.get('live-run').disabled).toBe(true)
    held.release(); await vi.waitFor(() => expect(f.get('live-continue').disabled).toBe(false))
    expect(f.get('live-status').textContent).toContain('paused')
    expect(f.calls.filter(c => c.operation === 'advance').map(c => c.mode)).toEqual(['recover'])
    expect(f.state.storage.get(f.key)).not.toContain('PRIVATE_')
  })

  it.each(['before', 'after'] as const)('reconnects with reads only after a lost %s-admission recovery response', async when => {
    const f = fixture(undefined, false, false, true); await recoverable(f); authorizeRecovery(f); f.lose(when); f.get('live-recover').fire()
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Your saved-response recovery may already have settled the recorded model result'))
    const command = f.calls.find(c => c.mode === 'recover')
    const restored = fixture(f.state, false, false, true); await restored.connected()
    expect(restored.calls.map(c => c.operation)).toEqual(['view', 'runs', 'show'])
    expect(restored.get('live-recover-authorize').checked).toBe(false)
    if (when === 'before') {
      expect(restored.get('live-retry-control').textContent).toBe('Retry retained recovery')
      expect(restored.get('live-recover').disabled).toBe(true)
      restored.get('live-retry-control').fire()
      await vi.waitFor(() => expect(restored.get('live-continue').disabled).toBe(false))
      expect(restored.calls.filter(c => c.operation === 'advance')).toEqual([command])
    }
    expect(restored.get('live-status').textContent).toContain('paused'); expect(restored.state.controls.size).toBe(1)
  })

  it('requires fresh consent after a changed checkpoint or an admitted-but-unsettled recovery', async () => {
    const f = fixture(undefined, false, false, true), run = await recoverable(f); authorizeRecovery(f)
    f.state.runs.set(run.id, { ...run, checkpointSha256: 'e'.repeat(64) }); f.get('live-inspect').fire()
    await vi.waitFor(() => expect(f.get('live-recover-status').textContent).toContain('e'.repeat(64)))
    expect(f.get('live-recover').disabled).toBe(true); expect(f.get('live-recover-authorize').checked).toBe(false)
    authorizeRecovery(f); f.lose('after'); f.get('live-recover').fire()
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Your saved-response recovery may already have settled the recorded model result'))
    const command = f.calls.find(c => c.mode === 'recover')
    f.state.runs.set(run.id, { ...run, checkpointSha256: 'f'.repeat(64), lastControl: { requestId: command.requestId, mode: 'recover' } })
    f.get('live-inspect').fire(); await vi.waitFor(() => expect(f.get('live-retry-control').disabled).toBe(true))
    expect(f.get('live-recover').disabled).toBe(true); expect(f.calls.filter(c => c.mode === 'recover')).toHaveLength(1)
    authorizeRecovery(f); f.get('live-recover').fire()
    await vi.waitFor(() => expect(f.get('live-continue').disabled).toBe(false))
    const next = f.calls.filter(c => c.mode === 'recover')[1]; expect(next.requestId).not.toBe(command.requestId)
    expect(next.expectedCheckpointSha256).toBe('f'.repeat(64))
  })

  it('does not keep a definitively refused, freshly confirmed unadmitted request pending or silently retry it', async () => {
    const f = fixture(undefined, false, false, true); await recoverable(f); authorizeRecovery(f); f.reject(); f.get('live-recover').fire()
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('conflict'))
    expect(f.get('live-retry-control').disabled).toBe(true); expect(f.get('live-recover-authorize').disabled).toBe(false)
    expect(f.get('live-recover').disabled).toBe(true); expect(f.calls.filter(c => c.operation === 'advance')).toHaveLength(1)
    expect(JSON.parse(f.state.storage.get(f.key)!).pendingControl).toBeUndefined(); expect(f.state.controls.size).toBe(0)
  })

  it('retains a rejected request if its confirming read is superseded by a later read', async () => {
    const f = fixture(undefined, false, false, true); await recoverable(f); authorizeRecovery(f); f.reject()
    const held = f.holdRead(), before = f.calls.filter(c => c.operation === 'show').length
    f.get('live-recover').fire(); await vi.waitFor(() => expect(f.calls.filter(c => c.operation === 'show')).toHaveLength(before + 1))
    // The first (rejection-confirming) read is held. A newer ordinary refresh must not lend it authority.
    f.get('live-inspect').fire(); await vi.waitFor(() => expect(f.calls.filter(c => c.operation === 'show')).toHaveLength(before + 2))
    held.release(); await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('conflict'))
    expect(f.get('live-retry-control').disabled).toBe(false); expect(f.calls.filter(c => c.operation === 'advance')).toHaveLength(1)
  })

  it('does not regress a cancellation on a delayed recovery response', async () => {
    const f = fixture(undefined, false, false, true); await recoverable(f); authorizeRecovery(f); const held = f.holdControl()
    f.get('live-recover').fire(); await vi.waitFor(() => expect(f.calls.some(c => c.mode === 'recover')).toBe(true))
    f.get('live-cancel').fire(); await vi.waitFor(() => expect(f.get('live-status').textContent).toContain('cancelled'))
    held.release(); await vi.waitFor(() => expect(f.get('live-run').disabled).toBe(false))
    expect(f.get('live-status').textContent).toContain('cancelled'); expect(f.get('live-recover-authorize').disabled).toBe(true)
    expect(f.calls.some(c => c.mode === 'continue')).toBe(false)
  })

  it('never dispatches recovery if tab storage fails', async () => {
    const f = fixture(undefined, false, false, true); await recoverable(f); authorizeRecovery(f); f.failStorage(); f.get('live-recover').fire()
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Storage unavailable'))
    expect(f.calls.some(c => c.operation === 'advance')).toBe(false)
  })

  it('rejects a retained recovery carrying breakpoint changes before connecting', async () => {
    const f = fixture(undefined, false, false, true), run = await recoverable(f), saved = JSON.parse(f.state.storage.get(f.key)!)
    saved.pendingControl = { id: run.id, requestId: randomUUID(), expectedCheckpointSha256: run.checkpointSha256, mode: 'recover', breakpoints: [] }
    f.state.storage.set(f.key, JSON.stringify(saved))
    const restored = fixture(f.state, false, false, true)
    expect(restored.get('live-message').textContent).toContain('identity invalid'); expect(restored.calls).toEqual([])
  })
})

describe('live stepping controller intent, races and retention (doubles only)', () => {
  it('can request another Pause during an explicitly resumed continuation without applying breakpoint drafts', async () => {
    const f = fixture(undefined, false, true); await f.connect(); const initial = await f.start()
    f.graphSelect('result'); f.get('breakpoint-toggle').fire(); f.get('live-pause').fire()
    await vi.waitFor(() => expect(f.get('live-step').disabled).toBe(false))
    expect(f.calls.find(c => c.mode === 'pause').breakpoints).toBeUndefined()
    expect(f.get('breakpoint-message').textContent).toContain('Checkpoint changed')
    f.get('breakpoint-discard').fire()
    const held = f.holdControl(); f.get('live-continue').fire()
    await vi.waitFor(() => expect(f.calls.some(c => c.mode === 'continue')).toBe(true))
    const command = f.calls.find(c => c.mode === 'continue')
    f.state.runs.set(initial.id, { ...initial, status: 'executing', checkpointSha256: 'f'.repeat(64), lastControl: { requestId: command.requestId, mode: 'continue' } })
    expect(f.get('live-pause').disabled).toBe(false); f.get('live-pause').fire()
    await vi.waitFor(() => expect(f.calls.filter(c => c.mode === 'pause')).toHaveLength(2))
    await vi.waitFor(() => expect(f.get('live-pause-status').textContent).toContain('active or uncertain'))
    f.state.runs.set(initial.id, { ...f.state.runs.get(initial.id), status: 'paused' }); held.release()
    await vi.waitFor(() => expect(f.get('live-continue').disabled).toBe(false))
    expect(f.get('live-pause-status').textContent).toContain('safe checkpoint')
  })

  it('allows Pause while an explicitly authorized approval is continuing and reports a later approval wait accurately', async () => {
    const f = fixture(undefined, true); await f.connect(); const run = await f.start(); f.get('live-continue').fire()
    await vi.waitFor(() => expect(f.get('live-review').disabled).toBe(false))
    f.get('live-review').fire(); await vi.waitFor(() => expect(f.get('live-actions').children).toHaveLength(2))
    const held = f.holdDecision(); f.get('live-authorize').checked = true; f.get('live-pause-after').checked = false
    f.get('live-actions').children[0]!.fire()
    await vi.waitFor(() => expect(f.calls.some(c => c.operation === 'decide')).toBe(true))
    f.state.runs.set(run.id, { ...f.state.runs.get(run.id), status: 'executing', checkpointSha256: 'e'.repeat(64) })
    expect(f.get('live-pause').disabled).toBe(false); f.get('live-pause').fire()
    await vi.waitFor(() => expect(f.get('live-pause-status').textContent).toContain('active or uncertain'))
    f.state.runs.set(run.id, { ...f.state.runs.get(run.id), status: 'waiting', attemptId: randomUUID() })
    held.release(); await vi.waitFor(() => expect(f.get('live-review').disabled).toBe(false))
    expect(f.get('live-pause-status').textContent).toContain('waiting for Human Approval')
    expect(f.calls.filter(c => c.operation === 'decide')).toHaveLength(1)
    expect(f.get('live-step').disabled).toBe(true)
  })

  it('retains Pause separately and preserves the actual status during an in-flight run', async () => {
    const f = fixture(); await f.connect(); const held = f.holdRun()
    f.get('live-input').value = JSON.stringify('PRIVATE_RUNNING_INPUT'); f.get('live-run').fire()
    await vi.waitFor(() => expect(f.calls.some(c => c.operation === 'run')).toBe(true))
    expect(f.get('live-step').disabled).toBe(true); expect(f.get('live-pause').disabled).toBe(false)
    f.get('live-pause').fire(); f.get('live-pause').fire()
    await vi.waitFor(() => expect(f.get('live-pause-status').textContent).toContain('active or uncertain'))
    const command = f.calls.find(c => c.mode === 'pause'), { operation: _operation, ...retained } = command
    expect(f.retainedBeforeDispatch).toEqual([retained])
    expect(f.calls.filter(c => c.mode === 'pause')).toHaveLength(1)
    expect(f.get('live-status').textContent).toContain('executing')
    expect(f.get('live-continue').disabled).toBe(true)
    expect(f.get('live-pause').disabled).toBe(true)
    const run = f.state.runs.get(command.id)
    f.state.runs.set(run.id, { ...run, status: 'paused', checkpointSha256: 'd'.repeat(64) })
    held.release()
    await vi.waitFor(() => expect(f.get('live-pause-status').textContent).toContain('safe checkpoint'))
    await vi.waitFor(() => expect(f.get('live-continue').disabled).toBe(false))
    expect(f.state.storage.get(f.key)).not.toContain('PRIVATE_')
  })

  it('does not overwrite an outstanding Continue identity with Pause or regress on its late response', async () => {
    const f = fixture(); await f.connect(); const initial = await f.start(); const held = f.holdControl()
    f.get('live-continue').fire()
    await vi.waitFor(() => expect(f.calls.some(c => c.mode === 'continue')).toBe(true))
    const continuation = JSON.parse(f.state.storage.get(f.key)!).pendingControl
    // The executing worker owns settlement. Its response snapshot is deliberately delivered late.
    f.state.runs.set(initial.id, { ...initial, status: 'executing', checkpointSha256: 'e'.repeat(64), lastControl: { requestId: continuation.requestId, mode: 'continue' } })
    f.get('live-pause').fire()
    await vi.waitFor(() => expect(f.get('live-pause-status').textContent).toContain('active or uncertain'))
    expect(f.retainedBeforeDispatch.map(c => c.mode)).toEqual(['continue', 'pause'])
    expect(f.retainedBeforeDispatch[0]).toEqual(continuation)
    const latest = f.state.runs.get(initial.id)
    f.state.runs.set(initial.id, { ...latest, status: 'paused' })
    held.release()
    await vi.waitFor(() => expect(f.get('live-continue').disabled).toBe(false))
    expect(f.get('live-status').textContent).toContain('paused')
    expect(f.get('live-pause-status').textContent).toContain('safe checkpoint')
    expect(f.calls.filter(c => c.mode === 'continue')).toHaveLength(1)
  })

  it.each(['before', 'after'] as const)('restores a lost %s-admission Pause with reads only and exact explicit retry', async when => {
    const f = fixture(); await f.connect(); await f.start(); f.lose(when); f.get('live-pause').fire()
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Your Pause request may already be recorded'))
    const command = f.calls.find(c => c.mode === 'pause')
    expect(JSON.parse(f.state.storage.get(f.key)!).pendingPause.requestId).toBe(command.requestId)
    expect(f.get('live-step').disabled).toBe(true); expect(f.get('live-history').disabled).toBe(true)
    f.get('live-step').fire(); f.get('live-continue').fire(); f.get('live-run').fire()
    expect(f.calls.filter(c => c.operation === 'advance')).toHaveLength(1)
    const restored = fixture(f.state); await restored.connected()
    expect(restored.calls.map(c => c.operation)).toEqual(['view', 'runs', 'show'])
    if (when === 'before') {
      expect(restored.get('live-retry-pause').disabled).toBe(false)
      restored.get('live-retry-pause').fire()
      await vi.waitFor(() => expect(restored.get('live-pause-status').textContent).toContain('safe checkpoint'))
      expect(restored.calls.filter(c => c.operation === 'advance')).toEqual([command])
    } else expect(restored.get('live-pause-status').textContent).toContain('safe checkpoint')
    expect(restored.state.controls.size).toBe(1)
    expect(JSON.parse(restored.state.storage.get(f.key)!).pendingPause).toBeUndefined()
  })

  it('does not let a delayed Pause receipt regress a newer cancellation result', async () => {
    const f = fixture(); await f.connect(); await f.start(); const held = f.holdPause()
    f.get('live-pause').fire()
    await vi.waitFor(() => expect(f.calls.some(c => c.mode === 'pause')).toBe(true))
    expect(f.get('live-cancel').disabled).toBe(false); f.get('live-cancel').fire()
    await vi.waitFor(() => expect(f.get('live-status').textContent).toContain('cancelled'))
    held.release(); await vi.waitFor(() => expect(f.get('live-run').disabled).toBe(false))
    expect(f.get('live-status').textContent).toContain('cancelled')
    expect(f.get('live-pause-status').textContent).toContain('Cancellation supersedes')
  })

  it.each(['waiting', 'completed', 'failed', 'cancelled'])('never submits Pause after the status read finds %s', async status => {
    const f = fixture(); await f.connect(); const run = await f.start()
    f.state.runs.set(run.id, { ...run, status }); f.get('live-pause').fire()
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Pause was not submitted'))
    expect(f.calls.some(c => c.operation === 'advance')).toBe(false)
    expect(f.get('live-status').textContent).toContain(status)
  })

  it('requires storage before Pause dispatch and does not apply a breakpoint draft', async () => {
    const f = fixture(undefined, false, true); await f.connect(); await f.start()
    f.graphSelect('result'); f.get('breakpoint-toggle').fire(); f.failStorage(); f.get('live-pause').fire()
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Storage unavailable'))
    expect(f.calls.some(c => c.operation === 'advance')).toBe(false)
    expect(f.get('breakpoint-draft').textContent).toContain('result')
  })

  it('resolves a stale unadmitted Pause by reading without claiming it executed or silently re-guarding it', async () => {
    const f = fixture(); await f.connect(); const run = await f.start(); f.lose('before'); f.get('live-pause').fire()
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Your Pause request may already be recorded'))
    f.state.runs.set(run.id, { ...run, checkpointSha256: 'b'.repeat(64) }); f.get('live-inspect').fire()
    await vi.waitFor(() => expect(f.get('live-step').disabled).toBe(false))
    expect(f.get('live-message').textContent).toContain('original checkpoint changed')
    expect(f.get('live-pause-status').textContent).toBe('')
    expect(f.state.controls.size).toBe(0)
    expect(f.calls.filter(c => c.mode === 'pause')).toHaveLength(1)
  })

  it.each(['requestId', 'id', 'mode', 'expectedCheckpointSha256', 'breakpoints'])('rejects corrupted retained Pause %s before connecting', async field => {
    const f = fixture(); await f.connect(); const run = await f.start()
    const saved = JSON.parse(f.state.storage.get(f.key)!)
    saved.pendingPause = { id: run.id, requestId: randomUUID(), mode: 'pause', expectedCheckpointSha256: run.checkpointSha256, [field]: 'invalid' }
    f.state.storage.set(f.key, JSON.stringify(saved))
    const restored = fixture(f.state)
    expect(restored.get('live-message').textContent).toContain('identity invalid')
    expect(restored.calls).toEqual([])
  })

  it('keeps graph edits local, then retains the exact list before dispatch and displays the recorded hit', async () => {
    const f = fixture(undefined, false, true); await f.connect(); await f.start()
    f.graphSelect('result'); expect(f.get('breakpoint-node').value).toBe('result')
    f.get('breakpoint-toggle').fire()
    expect(f.calls.some(call => call.operation === 'advance')).toBe(false)
    expect(f.get('breakpoint-draft').textContent).toContain('Unapplied draft: result')
    f.get('live-continue').fire()
    await vi.waitFor(() => expect(f.get('breakpoint-hit').textContent).toContain('Paused before result'))
    const command = f.calls.find(call => call.operation === 'advance')
    expect(command.breakpoints).toEqual(['result']); expect(f.retainedBeforeDispatch[0].breakpoints).toEqual(['result'])
    expect(f.get('breakpoint-draft').textContent).toBe('No unapplied changes.')
    expect(f.setBreakpoints.mock.calls.at(-1)![0]).toMatchObject({ enabled: ['result'], hit: { nodeId: 'result' } })
    f.get('breakpoint-clear').fire(); f.get('live-continue').fire()
    await vi.waitFor(() => expect(f.get('live-status').textContent).toContain('completed'))
    expect(f.calls.filter(call => call.operation === 'advance').at(-1).breakpoints).toEqual([])
  })

  it.each(['before', 'after'] as const)('retains breakpoint requests after a lost %s-admission response and reloads without execution', async when => {
    const f = fixture(undefined, false, true); await f.connect(); await f.start(); f.graphSelect('result'); f.get('breakpoint-toggle').fire()
    f.lose(when); f.get('live-continue').fire()
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Your Continue may still be running or may already have stopped'))
    const original = f.calls.find(call => call.operation === 'advance')
    expect(JSON.parse(f.state.storage.get(f.key)!).pendingControl.breakpoints).toEqual(['result'])
    const restored = fixture(f.state, false, true); await restored.connected()
    expect(restored.calls.map(call => call.operation)).toEqual(['view', 'runs', 'show'])
    if (when === 'before') {
      expect(restored.get('live-control-pending').textContent).toContain('Exact breakpoint list: result')
      restored.get('live-retry-control').fire()
      await vi.waitFor(() => expect(restored.get('breakpoint-hit').textContent).toContain('Paused before result'))
      expect(restored.calls.filter(call => call.operation === 'advance')).toEqual([original])
    } else expect(restored.get('breakpoint-hit').textContent).toContain('Paused before result')
    expect(restored.state.controls.size).toBe(1)
    expect(restored.state.storage.get(f.key)).not.toContain('PRIVATE_')
  })

  it('refuses a stale breakpoint draft instead of silently applying it to a newer checkpoint', async () => {
    const f = fixture(undefined, false, true); await f.connect(); const run = await f.start()
    f.graphSelect('result'); f.get('breakpoint-toggle').fire()
    f.state.runs.set(run.id, { ...run, checkpointSha256: 'b'.repeat(64) })
    f.get('live-inspect').fire(); await vi.waitFor(() => expect(f.get('breakpoint-message').textContent).toContain('Checkpoint changed'))
    f.get('live-continue').fire(); await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Checkpoint changed'))
    expect(f.calls.some(call => call.operation === 'advance')).toBe(false)
  })

  it.each([{ value: ['result', 'result'] }, { value: ['unknown'] }, { value: 'result' }])('never dispatches corrupted retained breakpoint data: $value', async ({ value }) => {
    const f = fixture(undefined, false, true); await f.connect(); const run = await f.start()
    const state = JSON.parse(f.state.storage.get(f.key)!)
    state.pendingControl = { id: run.id, requestId: randomUUID(), expectedCheckpointSha256: run.checkpointSha256, mode: 'continue', breakpoints: value }
    f.state.storage.set(f.key, JSON.stringify(state))
    const restored = fixture(f.state, false, true)
    if (Array.isArray(value) && value[0] === 'unknown') {
      await restored.connected(); restored.get('live-retry-control').fire()
      await vi.waitFor(() => expect(restored.get('live-message').textContent).toContain('Invalid breakpoint selection'))
    }
    expect(restored.calls.some(call => call.operation === 'advance')).toBe(false)
  })

  it('never dispatches a breakpoint draft when durable tab identity cannot be saved', async () => {
    const f = fixture(undefined, false, true); await f.connect(); await f.start()
    f.graphSelect('result'); f.get('breakpoint-toggle').fire(); f.failStorage(); f.get('live-continue').fire()
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Storage unavailable'))
    expect(f.calls.some(call => call.operation === 'advance')).toBe(false)
  })

  it('starts paused and retains exact control identity before explicit Step and Continue', async () => {
    const f = fixture(); await f.connect(); const run = await f.start()
    expect(f.calls.filter(call => call.operation === 'run')).toEqual([{ operation: 'run', id: run.id, input: 'PRIVATE_DEBUG_INPUT', paused: true }])
    expect(f.calls.some(call => call.operation === 'advance')).toBe(false)
    f.get('live-step').fire()
    await vi.waitFor(() => expect(JSON.parse(f.get('live-result').textContent).phase).toBe(1))
    const command = f.calls.find(call => call.operation === 'advance'), { operation: _operation, ...retained } = command
    expect(f.retainedBeforeDispatch).toEqual([retained]); expect(command.mode).toBe('step')
    expect(command.expectedCheckpointSha256).toBe(run.checkpointSha256)
    expect(f.state.storage.get(f.key)).not.toContain('PRIVATE_')
    expect(JSON.parse(f.state.storage.get(f.key)!).pendingControl).toBeUndefined()
    f.get('live-continue').fire()
    await vi.waitFor(() => expect(f.get('live-status').textContent).toContain('completed'))
    const commands = f.calls.filter(call => call.operation === 'advance')
    expect(commands.map(call => call.mode)).toEqual(['step', 'continue'])
    expect(commands[1].requestId).not.toBe(commands[0].requestId)
  })

  it('does not duplicate a pending action on another click and blocks run/history changes', async () => {
    const f = fixture(); await f.connect(); await f.start(); const held = f.holdControl()
    f.get('live-step').fire()
    await vi.waitFor(() => expect(f.calls.filter(call => call.operation === 'advance')).toHaveLength(1))
    expect(f.get('live-history').disabled).toBe(true)
    f.get('live-step').fire(); f.get('live-continue').fire(); f.get('live-run').fire(); f.get('live-retry-control').fire()
    expect(f.calls.filter(call => call.operation === 'advance')).toHaveLength(1)
    expect(f.calls.filter(call => call.operation === 'run')).toHaveLength(1)
    held.release(); await vi.waitFor(() => expect(f.get('live-step').disabled).toBe(false))
  })

  it('restores unresolved actions with reads only, then retries the same UUID/hash/mode explicitly', async () => {
    const original = fixture(); await original.connect(); await original.start(); original.lose('before')
    original.get('live-step').fire()
    await vi.waitFor(() => expect(original.get('live-message').textContent).toContain('Your Step may already have moved this run'))
    const command = original.calls.find(call => call.operation === 'advance')
    expect(original.get('live-step').disabled).toBe(true); expect(original.get('live-retry-control').disabled).toBe(false)
    const restored = fixture(original.state); await restored.connected()
    expect(restored.calls.map(call => call.operation)).toEqual(['view', 'runs', 'show'])
    restored.get('live-continue').fire(); expect(restored.calls.some(call => call.operation === 'advance')).toBe(false)
    restored.get('live-retry-control').fire()
    await vi.waitFor(() => expect(restored.get('live-step').disabled).toBe(false))
    expect(restored.calls.filter(call => call.operation === 'advance')).toEqual([command])
    expect(JSON.parse(restored.get('live-result').textContent).phase).toBe(1)
    expect(restored.state.controls.size).toBe(1)
  })

  it('reconciles a committed lost response using Refresh without replay or another Step', async () => {
    const f = fixture(); await f.connect(); await f.start(); f.lose('after'); f.get('live-step').fire()
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Your Step may already have moved this run'))
    f.get('live-inspect').fire()
    await vi.waitFor(() => expect(f.get('live-step').disabled).toBe(false))
    expect(JSON.parse(f.get('live-result').textContent).phase).toBe(1)
    expect(f.calls.filter(call => call.operation === 'advance')).toHaveLength(1)
    expect(JSON.parse(f.state.storage.get(f.key)!).pendingControl).toBeUndefined()
  })

  it('ignores an older pending read after a newer Step result has been displayed', async () => {
    const f = fixture(); await f.connect(); await f.start(); const held = f.holdRead()
    const reads = f.readsFinished(); f.get('live-inspect').fire()
    await vi.waitFor(() => expect(f.calls.some(call => call.operation === 'show')).toBe(true))
    f.get('live-step').fire(); await vi.waitFor(() => expect(f.get('live-step').disabled).toBe(false))
    expect(JSON.parse(f.get('live-result').textContent).phase).toBe(1)
    held.release(); await vi.waitFor(() => expect(f.readsFinished()).toBe(reads + 1))
    expect(JSON.parse(f.get('live-result').textContent).phase).toBe(1)
    expect(f.setExecution).toHaveBeenLastCalledWith({ runId: JSON.parse(f.get('live-result').textContent).id, phase: 1 })
  })

  it('clears graph evidence on run selection/loading and isolates projection failures from execution controls', async () => {
    const f = fixture(); await f.connect(); const run = await f.start()
    expect(f.setExecution).toHaveBeenLastCalledWith({ runId: run.id, phase: 0 })
    const another = { ...run, id: randomUUID(), phase: 99 }; f.state.runs.set(another.id, another)
    const held = f.holdRead(); f.get('live-history').value = another.id; f.get('live-history').fire('change')
    expect(f.setExecution).toHaveBeenLastCalledWith(null)
    held.release(); await vi.waitFor(() => expect(f.get('live-overlay-error').textContent).toContain('cannot be safely mapped'))
    expect(f.setExecution).toHaveBeenLastCalledWith(null)
    expect(f.get('live-step').disabled).toBe(false)
    expect(f.calls.some(call => call.operation === 'advance')).toBe(false)
  })

  it('reconciles a changed checkpoint without claiming an unresolved action executed or retrying it', async () => {
    const f = fixture(); await f.connect(); const run = await f.start(); f.lose('before'); f.get('live-step').fire()
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Your Step may already have moved this run'))
    // Simulate another authorized client changing this run while this tab's request was never admitted.
    f.state.runs.set(run.id, { ...run, phase: 2, checkpointSha256: '2'.padStart(64, '0') })
    f.get('live-inspect').fire(); await vi.waitFor(() => expect(f.get('live-step').disabled).toBe(false))
    expect(f.calls.filter(call => call.operation === 'advance')).toHaveLength(1)
    expect(f.state.controls.size).toBe(0)
    expect(f.get('live-message').textContent).toContain('original checkpoint changed')
    expect(JSON.parse(f.state.storage.get(f.key)!).pendingControl).toBeUndefined()
  })

  it('refuses dispatch when tab storage cannot retain the control identity', async () => {
    const f = fixture(); await f.connect(); await f.start(); f.failStorage(); f.get('live-step').fire()
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Storage unavailable'))
    expect(f.calls.some(call => call.operation === 'advance')).toBe(false)
  })

  it('defaults a debug approval to pause-after and still requires authority for the exact current wait', async () => {
    const f = fixture(undefined, true); await f.connect(); await f.start(); f.get('live-continue').fire()
    await vi.waitFor(() => expect(f.get('live-review').disabled).toBe(false))
    f.get('live-review').fire(); await vi.waitFor(() => expect(f.get('live-actions').children).toHaveLength(2))
    expect(f.get('live-pause-after').checked).toBe(true)
    const approve = f.get('live-actions').children[0]!
    approve.fire(); await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Tick the review confirmation'))
    expect(f.calls.some(call => call.operation === 'decide')).toBe(false)
    f.get('live-authorize').checked = true; approve.fire()
    await vi.waitFor(() => expect(f.get('live-step').disabled).toBe(false))
    expect(f.calls.find(call => call.operation === 'decide')).toMatchObject({ action: 'approve', pauseAfter: true })
    expect(JSON.parse(f.get('live-result').textContent).status).toBe('paused')
    f.get('live-authorize').checked = true; approve.fire()
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('current waiting attempt'))
    expect(f.calls.filter(call => call.operation === 'decide')).toHaveLength(1)
    expect(f.state.storage.get(f.key)).not.toContain('PRIVATE_REVIEW')
  })
})

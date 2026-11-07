import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { livePreviewBrowser, renderLivePage } from '../src/preview/live-page.ts'

// Actual serialized controller in a DOM with a controlled browser clock/timer queue.
// Not actual-browser rendering, runtime clock manipulation or provider execution.
const instance = '00000000-0000-4000-8000-000000000000', protocol = 'jevable/v1alpha1'
const runId = '11111111-1111-4111-8111-111111111111', sessionKey = 'a'.repeat(64), replacementKey = 'b'.repeat(64)
const newRunId = '77777777-7777-4777-8777-777777777777'
const checkpoint = 'c'.repeat(64), initialTime = Date.parse('2026-10-12T04:00:00.000Z')
const windows: JSDOM[] = []
afterEach(() => windows.splice(0).forEach(dom => dom.window.close()))
const settle = async () => { for (let n = 0; n < 15; n++) await new Promise(resolve => setImmediate(resolve)) }
const retained = (extra: object = {}) => ({ token: sessionKey, expiresAt: new Date(initialTime + 10000).toISOString(), runId, ...extra })
function reply(result: unknown, status = 200, code = 'unauthorized') {
  return new Response(JSON.stringify({ instanceId: instance, ...(status === 200 ? { result } : { code }) }),
    { status, headers: { 'content-type': 'application/json', 'x-jevable-protocol': protocol } })
}
function fixture(saved: object, auto = true) {
  const dom = new JSDOM(renderLivePage(instance, protocol, 'owner', auto).html, { runScripts: 'outside-only', url: 'http://127.0.0.1:3000/' })
  windows.push(dom)
  let now = initialTime, nextTimer = 0, refuseHistory = false, refuseRun = false, missingRun = false, bootstrapResult: unknown
  const tasks = new Map<number, { due: number; callback: () => void }>()
  dom.window.Date.now = () => now
  dom.window.setTimeout = ((callback: () => void, delay = 0) => { const id = ++nextTimer; tasks.set(id, { due: now + delay, callback }); return id }) as typeof dom.window.setTimeout
  dom.window.clearTimeout = (id?: number) => { if (id !== undefined) tasks.delete(id) }
  Object.defineProperty(dom.window.crypto, 'randomUUID', { value: () => newRunId })
  const key = `jevable.preview.${instance}`, calls: { path: string; command: any; auth?: string }[] = []
  dom.window.sessionStorage.setItem(key, JSON.stringify(saved))
  let held: ((response: Response) => void) | undefined, rejectHeld: ((error: unknown) => void) | undefined, holdPrivate = false
  const run = { id: runId, status: 'paused', revision: 'd'.repeat(64), checkpointSha256: checkpoint, steps: [] }
  const fetch = vi.fn(async (path: string, init: RequestInit) => {
    const command = JSON.parse(String(init.body)), auth = (init.headers as Record<string, string>).Authorization
    calls.push({ path, command, ...(auth ? { auth } : {}) })
    if (path.endsWith('bootstrap')) return reply(bootstrapResult ?? { token: replacementKey, expiresAt: new Date(now + 60000).toISOString() })
    if (command.operation === 'inspect' && holdPrivate) return new Promise<Response>((resolve, reject) => { held = resolve; rejectHeld = reject })
    if (command.operation === 'runs' && refuseHistory) { refuseHistory = false; return reply({}, 401) }
    if (command.operation === 'view') return reply({ project: { id: instance, generation: 1, revision: run.revision }, preview: {}, inputSchema: {},
      sample: 'Synthetic input', entry: { local: true, api: false }, readiness: { runtimeReadiness: 'ready' } })
    if (command.operation === 'runs') return reply({ runs: [run] })
    if (command.operation === 'run' && refuseRun) { refuseRun = false; missingRun = true; return reply({}, 401) }
    if (command.operation === 'show') return missingRun ? reply({}, 404, 'not-found') : reply(run)
    throw Error('Fixture refuses unexpected operation: ' + command.operation)
  })
  Object.assign(dom.window, { fetch, TextDecoder })
  const args = ['()=>({setExecution:()=>{}})', JSON.stringify(instance), JSON.stringify(protocol), ...Array(25).fill('undefined'), String(auto)]
  dom.window.eval(`(${livePreviewBrowser.toString()})(${args.join(',')})`)
  const get = <T extends HTMLElement = HTMLElement>(id: string) => dom.window.document.getElementById(id) as T
  const click = (id: string) => get<HTMLButtonElement>(id).click()
  return { dom, get, click, calls, fetch, key, tasks,
    saved: () => JSON.parse(dom.window.sessionStorage.getItem(key)!),
    refuseHistory: () => { refuseHistory = true },
    refuseRun: () => { refuseRun = true }, missingRun: () => { missingRun = true },
    holdPrivate: () => { holdPrivate = true }, resolvePrivate: (response: Response) => { expect(held).toBeDefined(); held!(response) },
    rejectPrivate: () => { expect(rejectHeld).toBeDefined(); rejectHeld!(new dom.window.Error('PRIVATE_OLD_TRANSPORT_ERROR')) },
    bootstrap: (value: unknown) => { bootstrapResult = value },
    clock(ms: number, fire = true) {
      now += ms
      if (!fire) return
      for (let n = 0; n < 100; n++) {
        const next = [...tasks].find(([, task]) => task.due <= now)
        if (!next) return
        tasks.delete(next[0]); next[1].callback()
      }
      throw Error('Unbounded timer queue')
    },
  }
}
const pending = {
  cancelId: '22222222-2222-4222-8222-222222222222', testId: '33333333-3333-4333-8333-333333333333',
  batchId: '44444444-4444-4444-8444-444444444444', pendingBatch: true,
  pendingControl: { id: runId, requestId: '55555555-5555-4555-8555-555555555555', expectedCheckpointSha256: checkpoint, mode: 'step', breakpoints: ['review'] },
  pendingPause: { id: runId, requestId: '66666666-6666-4666-8666-666666666666', expectedCheckpointSha256: checkpoint, mode: 'pause' },
}
function assertLocked(f: ReturnType<typeof fixture>) {
  expect(f.get('live-login').hidden).toBe(false); expect(f.get('live-session').hidden).toBe(true)
  expect(f.get('preview-workspace').hidden).toBe(true)
  for (const id of ['live-run', 'live-step', 'live-continue', 'live-cancel', 'live-private', 'live-review', 'live-inspect', 'live-retry-control', 'live-retry-pause'])
    expect(f.get<HTMLButtonElement>(id).disabled, id).toBe(true)
  expect(f.get('live-connect-error').textContent).toContain('nothing runs again automatically')
  expect(f.get('live-connect-error').textContent).not.toMatch(/[ab]{64}/u)
}
describe('preview scoped-session expiry and explicit reconnect', () => {
  it.each([false, true])('keeps expired startup identities and makes no automatic bootstrap in auto=%s', async auto => {
    const original = retained({ ...pending, expiresAt: new Date(initialTime - 1).toISOString() }), f = fixture(original, auto)
    await settle(); assertLocked(f)
    expect(f.calls).toEqual([]); expect(f.saved()).toEqual({ ...original, reconnectRequired: true })
    if (!auto) f.get<HTMLInputElement>('live-token').value = 'f'.repeat(64)
    f.click('live-connect'); await settle()
    expect(f.get('live-login').hidden).toBe(true)
    const { token: _token, expiresAt: _expiresAt, ...identities } = original
    expect(f.saved()).toEqual({ ...identities, token: replacementKey, expiresAt: new Date(initialTime + 60000).toISOString() })
    expect(f.calls.map(call => call.command.operation).filter(Boolean)).toEqual(['view', 'runs', 'show'])
    expect(f.calls[0]?.auth).toBe(auto ? undefined : 'Bearer ' + 'f'.repeat(64))
  })
  it('expires while idle, clears private review/consent and leaves identities without another request', async () => {
    const original = retained(), f = fixture(original); await settle()
    f.get('live-private-result').textContent = 'PRIVATE_OLD_RESULT'; f.get('live-review-data').textContent = 'PRIVATE_REVIEW'
    f.get<HTMLInputElement>('live-authorize').checked = true
    const before = [...f.calls]; f.clock(10001); await settle(); assertLocked(f)
    expect(f.calls).toEqual(before); expect(f.saved()).toEqual({ ...original, reconnectRequired: true })
    expect(f.get('live-private-result').textContent).toBe(''); expect(f.get('live-review-data').textContent).toBe('')
    expect(f.get<HTMLInputElement>('live-authorize').checked).toBe(false)
  })
  it('checks the clock before dispatch even if an idle timer was delayed', async () => {
    const f = fixture(retained()); await settle(); const before = [...f.calls]
    f.clock(10001, false); f.click('live-refresh-history'); await settle(); assertLocked(f)
    expect(f.calls).toEqual(before)
  })
  it('checks expiry before retaining a new run identity when the deadline timer was delayed', async () => {
    const original = retained({ runId: undefined }), f = fixture(original); await settle()
    expect(f.get<HTMLButtonElement>('live-run').disabled).toBe(false)
    const before = [...f.calls]; f.clock(10001, false); f.click('live-run'); await settle(); assertLocked(f)
    expect(f.calls).toEqual(before); expect(f.saved().runId).toBeUndefined(); expect(f.saved().lastRejectedId).toBeUndefined()
  })
  it('retains a locally refused UUID as unadmitted if the deadline crosses between run preflight and dispatch', async () => {
    const f = fixture(retained({ runId: undefined })); await settle(); const before = [...f.calls]
    f.dom.window.Date.now = vi.fn().mockReturnValueOnce(initialTime).mockReturnValue(initialTime + 10001)
    f.click('live-run'); await settle(); assertLocked(f)
    expect(f.calls).toEqual(before); expect(f.saved().runId).toBeUndefined(); expect(f.saved().lastRejectedId).toBe(newRunId)
    f.click('live-connect'); await settle()
    expect(f.get('live-login').hidden).toBe(true); expect(f.saved().lastRejectedId).toBe(newRunId)
    expect(f.calls.map(call => call.command.operation).filter(Boolean)).toEqual(['view', 'runs', 'view', 'runs'])
  })
  it('retains an unauthorized submission until explicit reconnect and a fresh read proves its original UUID absent', async () => {
    const f = fixture(retained({ runId: undefined })); await settle()
    f.refuseRun(); f.click('live-run'); await settle(); assertLocked(f)
    expect(f.saved().runId).toBe(newRunId); expect(f.saved().rejectedRunId).toBe(newRunId)
    expect(f.saved().lastRejectedId).toBeUndefined()
    f.click('live-connect'); await settle()
    expect(f.get('live-login').hidden).toBe(true); expect(f.saved().runId).toBeUndefined()
    expect(f.saved().lastRejectedId).toBe(newRunId); expect(f.saved().rejectedRunId).toBeUndefined()
    expect(f.calls.filter(call => call.command.operation === 'run')).toHaveLength(1)
    expect(f.calls.map(call => call.command.operation).filter(Boolean)).toEqual(['view', 'runs', 'run', 'view', 'runs', 'show'])
  })
  it('does not discard an uncertain run UUID on reconnect merely because a fresh read cannot find it', async () => {
    const original = retained({ reconnectRequired: true }), f = fixture(original); await settle()
    f.missingRun(); f.click('live-connect'); await settle()
    expect(f.get('live-login').hidden).toBe(false); expect(f.get<HTMLButtonElement>('live-run').disabled).toBe(true)
    expect(f.saved().runId).toBe(runId); expect(f.saved().lastRejectedId).toBeUndefined()
    expect(f.calls.map(call => call.command.operation).filter(Boolean)).toEqual(['view', 'runs', 'show'])
  })
  it('fences a valid unauthorized response, persists explicit reconnect and never retries it', async () => {
    const original = retained(), f = fixture(original); await settle()
    f.refuseHistory(); f.click('live-refresh-history'); await settle(); assertLocked(f)
    expect(f.calls.map(call => call.command.operation)).toEqual(['view', 'runs', 'show', 'runs'])
    const restored = fixture(f.saved()); await settle(); assertLocked(restored)
    expect(restored.calls).toEqual([]); expect(restored.saved()).toEqual(f.saved())
  })
  it.each([200, 401, 'transport'] as const)('ignores a late old-session %s response after explicit reconnect', async status => {
    const f = fixture(retained()); await settle()
    f.holdPrivate(); f.click('live-private'); await settle()
    f.refuseHistory(); f.click('live-refresh-history'); await settle(); assertLocked(f)
    f.click('live-connect'); await settle()
    expect(f.get('live-login').hidden).toBe(true)
    const before = [...f.calls], saved = f.saved()
    if (status === 'transport') f.rejectPrivate()
    else f.resolvePrivate(reply({ private: 'PRIVATE_LATE_RESPONSE' }, status))
    await settle()
    expect(f.get('live-login').hidden).toBe(true); expect(f.saved()).toEqual(saved); expect(f.calls).toEqual(before)
    expect(f.get('live-private-result').textContent).toBe('')
    expect(f.get('live-message').textContent).toContain('Session open.')
  })
  it('rechecks expiry on pageshow after pagehide cancelled its timer, without reading or running', async () => {
    const f = fixture(retained()); await settle(); const before = [...f.calls]
    f.dom.window.dispatchEvent(new f.dom.window.Event('pagehide'))
    expect(f.tasks.size).toBe(0); f.clock(10001)
    expect(f.get('live-login').hidden).toBe(true)
    f.dom.window.dispatchEvent(new f.dom.window.Event('pageshow')); assertLocked(f)
    expect(f.calls).toEqual(before)
  })
  it('fails closed on malformed retained credential timing instead of dropping pending identities and auto-connecting', async () => {
    const original = retained({ ...pending, expiresAt: 'invalid' }), f = fixture(original); await settle()
    expect(f.calls).toEqual([]); expect(f.saved()).toEqual(original)
    expect(f.get('live-message').textContent).toContain('identity invalid')
  })
  it.each([{ token: 'bad', expiresAt: new Date(initialTime + 60000).toISOString() },
    { token: replacementKey, expiresAt: 'invalid' }, { token: replacementKey, expiresAt: new Date(initialTime - 1).toISOString() }])
    ('refuses malformed/expired replacement credentials without replacing retained identity: %j', async response => {
      const original = retained({ ...pending, reconnectRequired: true }), f = fixture(original); await settle()
      f.bootstrap(response); f.click('live-connect'); await settle(); assertLocked(f)
      expect(f.saved()).toEqual(original); expect(f.calls).toHaveLength(1)
    })
})

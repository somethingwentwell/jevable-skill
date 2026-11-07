import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { livePreviewBrowser } from '../src/preview/live-page.ts'
import { PROTOCOL_VERSION } from '../src/capabilities.ts'

// Real serialized transport, minimal DOM/test-tab port. Not actual-browser/CSP acceptance.
class Element {
  value = ''; textContent = ''; disabled = false; hidden = false; checked = false
  children: Element[] = []; handlers = new Map<string, (() => void)[]>()
  attributes = new Map<string, string>()
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  addEventListener(name: string, fn: () => void) { this.handlers.set(name, [...this.handlers.get(name) ?? [], fn]) }
  append(child: Element) { this.children.push(child) }
  replaceChildren() { this.children = [] }
  focus() {}
}
type TestPort = { request(command: unknown): Promise<unknown>; error(error: unknown): void }
const settle = async () => { for (let n = 0; n < 12; n++) await new Promise(resolve => setImmediate(resolve)) }
async function refusal(promise: Promise<unknown>): Promise<Error> {
  const succeeded = Symbol('unexpected-success'), value = await promise.then(() => succeeded, error => error)
  if (!(value instanceof Error)) throw Error('Expected a rejected Error, not a successful response or an untyped failure')
  return value
}
afterEach(() => vi.useRealTimers())
async function fixture() {
  const instance = randomUUID(), token = 'a'.repeat(64), key = `jevable.preview.${instance}`
  const saved = { token, expiresAt: '2099-01-01T00:00:00.000Z', batchId: randomUUID(), pendingBatch: true, batchTriggerMode: 'api' }
  const storage = new Map([[key, JSON.stringify(saved)]]), elements = new Map<string, Element>()
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)! }
  const calls: Record<string, unknown>[] = [], signals: AbortSignal[] = []
  const events = new Map<string, (() => void)[]>()
  let failure: ((signal: AbortSignal) => Promise<Response>) | undefined
  const reply = (result: unknown, status = 200, code?: string) => new Response(JSON.stringify({ instanceId: instance,
    ...(code ? { code } : { result }) }), { status, headers: { 'content-type': 'application/json', 'x-jevable-protocol': PROTOCOL_VERSION } })
  const context: Record<string, any> = {
    document: { getElementById: get, createElement: () => new Element(), querySelector: () => get('notice') },
    sessionStorage: { getItem: (name: string) => storage.get(name) ?? null,
      setItem: (name: string, value: string) => storage.set(name, value), removeItem: (name: string) => storage.delete(name) },
    fetch: vi.fn(async (_path: string, options: RequestInit) => {
      const command = JSON.parse(String(options.body)); calls.push(command); signals.push(options.signal as AbortSignal)
      if (failure) { const pending = failure; failure = undefined; return pending(options.signal as AbortSignal) }
      return reply(command.operation === 'view'
        ? { project: { id: randomUUID(), generation: 1, revision: 'b'.repeat(64) }, preview: {}, inputSchema: {}, sample: null,
          entry: { local: true, api: true }, readiness: { runtimeReadiness: 'ready' } }
        : { runs: [] })
    }),
    viewer: () => undefined, instance, protocol: PROTOCOL_VERSION, TextDecoder, Uint8Array, AbortController,
    Error, Date, crypto: { randomUUID }, setTimeout, clearTimeout,
    window: { addEventListener: (name: string, fn: () => void) => events.set(name, [...events.get(name) ?? [], fn]) },
    location: { reload: () => {} },
  }
  runInNewContext(`(${livePreviewBrowser.toString()})(viewer, instance, protocol, ctx => {
    testPort = ctx; return { buttons() {}, observe() {}, refresh: async () => {} };
  })`, context)
  await settle(); expect(get('live-message').textContent).toContain('Session open')
  expect(get('live-message').attributes.get('data-tone')).toBe('neutral')
  expect(calls.map(call => call.operation)).toEqual(['view', 'runs'])
  return { get, calls, signals, saved, storage, key, reply, instance, port: context.testPort as TestPort,
    event: (name: string) => { for (const fn of events.get(name) ?? []) fn() },
    click: (id: string) => { for (const fn of get(id).handlers.get('click') ?? []) fn() },
    fail: (respond: (signal: AbortSignal) => Promise<Response>) => { failure = respond } }
}
const runId = randomUUID(), requestId = randomUUID(), caseId = randomUUID()
const scenarios: { command: Record<string, unknown>; guidance: string; reference?: string; mutation: boolean }[] = [
  { command: { operation: 'tests.generate', id: requestId, triggerMode: 'api' }, guidance: 'retries its original request and entry', reference: requestId, mutation: true },
  ...['tests.create', 'tests.edit', 'tests.accept', 'tests.archive'].map(operation => ({ command: { operation, id: caseId }, guidance: 'latest version before saving or accepting again', reference: caseId, mutation: true })),
  { command: { operation: 'run', id: runId, input: 'PRIVATE_INPUT' }, guidance: 'Your workflow may still be running', reference: runId, mutation: true },
  { command: { operation: 'tests.run', runId, test: { id: caseId } }, guidance: 'check this same run', reference: runId, mutation: true },
  { command: { operation: 'advance', id: runId, requestId, mode: 'pause' }, guidance: 'Retry retained Pause', reference: requestId, mutation: true },
  { command: { operation: 'advance', id: runId, requestId, mode: 'step' }, guidance: 'same Step request and checkpoint', reference: requestId, mutation: true },
  { command: { operation: 'advance', id: runId, requestId, mode: 'continue' }, guidance: 'same Continue request and checkpoint', reference: requestId, mutation: true },
  { command: { operation: 'advance', id: runId, requestId, mode: 'recover' }, guidance: 'same recovery request and checkpoint', reference: requestId, mutation: true },
  { command: { operation: 'cancel', id: runId, requestId }, guidance: 'Cancellation does not undo work', reference: requestId, mutation: true },
  { command: { operation: 'decide', id: runId, action: 'PRIVATE_ACTION' }, guidance: 'decision may already be recorded', reference: runId, mutation: true },
  { command: { operation: 'release.create', id: requestId }, guidance: 'Inspect retained release ID', reference: requestId, mutation: true },
  { command: { operation: 'view' }, guidance: 'Refresh entry readiness', mutation: false },
  ...['show', 'runs', 'inspect', 'approval'].map(operation => ({ command: { operation, id: runId }, guidance: 'Reading saved information does not restart', reference: runId, mutation: false })),
  ...['tests.list', 'tests.show', 'tests.history', 'tests.generation'].map(operation => ({ command: { operation, id: caseId }, guidance: 'does not create, accept or run tests', reference: caseId, mutation: false })),
  { command: { operation: 'tests.result', runId }, guidance: 'This does not rerun the test', reference: runId, mutation: false },
]
describe('missing preview replies explain uncertainty without changing authority', () => {
  it.each(scenarios)('$command.operation offers the correct explicit next step', async scenario => {
    const f = await fixture(), retained = f.storage.get(f.key)
    f.fail(async () => { throw Error('PRIVATE_TRANSPORT_FAILURE ' + f.saved.token) })
    const error = await refusal(f.port.request(scenario.command))
    expect(error).toBeInstanceOf(Error); expect(error.message).toContain("couldn't get a complete reply")
    expect(error.message).toContain(scenario.guidance)
    expect(error.message).toContain(scenario.mutation ? 'A missing reply does not prove this action failed. Check saved state before taking another action.' : 'This lookup does not start or change a workflow.')
    if (scenario.reference) expect(error.message).toContain(`Request reference: ${scenario.reference}.`)
    expect(error).not.toHaveProperty('status'); expect(error).not.toHaveProperty('code'); expect(error).not.toHaveProperty('notDispatched')
    f.port.error(error); expect(f.get('live-message').textContent).toBe(error.message)
    expect(f.get('live-message').attributes.get('data-tone')).toBe('warning')
    for (const privateValue of ['PRIVATE_TRANSPORT_FAILURE', 'PRIVATE_INPUT', 'PRIVATE_ACTION', f.saved.token]) expect(error.message).not.toContain(privateValue)
    expect(f.storage.get(f.key)).toBe(retained)
    await settle(); expect(f.calls).toEqual([{ operation: 'view' }, { operation: 'runs' }, scenario.command])
  })
  it.each(['fetch', 'stream', 'utf8', 'json', 'headers', 'size'] as const)('sanitizes a %s failure and retains the same batch without claiming rejection', async kind => {
    const f = await fixture(), retained = f.storage.get(f.key), command = { operation: 'tests.generate', id: f.saved.batchId, triggerMode: 'api' }
    f.fail(async () => {
      if (kind === 'fetch') throw new TypeError('PRIVATE_FETCH_DETAIL ' + f.saved.token)
      if (kind === 'stream') return new Response(new ReadableStream({ start(controller) { controller.error(Error('PRIVATE_STREAM_DETAIL')) } }),
        { headers: { 'content-type': 'application/json', 'x-jevable-protocol': PROTOCOL_VERSION } })
      if (kind === 'headers') return new Response('PRIVATE_BODY', { headers: { 'content-type': 'text/html' } })
      return new Response(kind === 'utf8' ? new Uint8Array([255]) : kind === 'size' ? new Uint8Array(20_000_001) : '{PRIVATE_JSON ' + f.saved.token,
        { headers: { 'content-type': 'application/json', 'x-jevable-protocol': PROTOCOL_VERSION } })
    })
    const error = await refusal(f.port.request(command)); f.port.error(error)
    expect(error.message).toContain('Your test drafts may already be saved')
    expect(error.message).toContain(f.saved.batchId); expect(error.message).not.toContain('PRIVATE_'); expect(error.message).not.toContain(f.saved.token)
    expect(error).not.toHaveProperty('status'); expect(f.storage.get(f.key)).toBe(retained)
    await settle(); expect(f.calls.filter(call => call.operation === 'tests.generate')).toEqual([command])
  })
  it('keeps the original fifteen-second timeout and gives draft guidance instead of run failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const f = await fixture(), retained = f.storage.get(f.key), command = { operation: 'tests.generate', id: f.saved.batchId, triggerMode: 'api' }
    f.fail(signal => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('PRIVATE_ABORT_DETAIL')))))
    let resolved = false
    const pending = refusal(f.port.request(command)).then(error => { resolved = true; return error })
    await vi.advanceTimersByTimeAsync(14_999); expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(1); const error = await pending
    expect(error.message).toContain('took too long to reply'); expect(error.message).toContain('Your test drafts may already be saved')
    expect(error.message).not.toContain('Execution may continue'); expect(error.message).not.toContain('PRIVATE_ABORT_DETAIL')
    expect(error).not.toHaveProperty('notDispatched'); expect(f.signals.at(-1)?.aborted).toBe(true)
    expect(f.storage.get(f.key)).toBe(retained); expect(f.calls.filter(call => call.operation === 'tests.generate')).toEqual([command])
  })
  it('does not mistake a decoded server rejection for a lost reply or remove its guards', async () => {
    const f = await fixture(); f.fail(async () => f.reply(undefined, 409, 'conflict'))
    const error = await refusal(f.port.request({ operation: 'tests.accept', id: caseId }))
    expect(error).toMatchObject({ status: 409, code: 'conflict' }); expect(error.message).toContain('Runtime rejected operation: conflict')
    expect(error.message).not.toContain('may already be saved')
  })
  it.each([null, [], 'PRIVATE_RESPONSE', 17])('treats invalid reply shape %j as uncertain, not a definitive rejection', async value => {
    const f = await fixture(); f.fail(async () => new Response(JSON.stringify(value),
      { headers: { 'content-type': 'application/json', 'x-jevable-protocol': PROTOCOL_VERSION } }))
    const error = await refusal(f.port.request({ operation: 'tests.generate', id: f.saved.batchId }))
    expect(error.message).toContain('Your test drafts may already be saved'); expect(error.message).not.toContain('PRIVATE_')
    expect(error).not.toHaveProperty('status'); expect(error).not.toHaveProperty('notDispatched')
  })
  it('does not echo arbitrary identities, operation names, payloads or action text', async () => {
    const f = await fixture(); f.fail(async () => { throw 'PRIVATE_THROWN_VALUE' })
    const error = await refusal(f.port.request({ operation: 'PRIVATE_OPERATION', id: 'PRIVATE_ID', input: 'PRIVATE_INPUT', action: 'PRIVATE_ACTION' }))
    expect(error.message).not.toContain('PRIVATE_'); expect(error.message).not.toContain('Request reference:')
    expect(error.message).toContain('inspect your saved work before trying again')
  })
})

// Existing API responses drive feedback only. These controller doubles cannot
// establish actual browser rendering, remote-runtime health or accessibility.
const verified = 'Last runtime reply verified. This is not a continuous connection check.'
const waiting = 'Waiting for a runtime reply. This is not proof of execution or failure.'
const unconfirmed = 'Connection unconfirmed. Check that the preview is running, then use a read-only refresh. A missing reply does not mean your work failed.'
function heldReply() {
  let resolve!: (response: Response) => void, reject!: (error: Error) => void
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
describe('runtime reply observation is separate from session admission and action uncertainty', () => {
  it('reports a historical verified reply rather than continuous liveness or locality', async () => {
    const f = await fixture()
    expect(f.get('live-connection-status').textContent).toBe(verified)
    expect(f.get('live-login').hidden).toBe(true); expect(f.get('live-session').hidden).toBe(false)
    expect(f.calls.map(call => call.operation)).toEqual(['view', 'runs'])
    const before = [...f.calls]; await settle()
    expect(f.calls).toEqual(before); expect(f.storage.get(f.key)).toBe(JSON.stringify(f.saved))
    expect(f.get('live-connection-status').textContent).not.toMatch(/online|connected locally|offline/iu)
  })
  it.each(['fetch', 'stream', 'utf8', 'json', 'headers', 'size', 'identity'] as const)('makes %s uncertainty visible without clearing saved identities or changing controls', async kind => {
    const f = await fixture(), before = f.storage.get(f.key), disabled = f.get('live-run').disabled
    f.fail(async () => {
      if (kind === 'fetch') throw Error('PRIVATE_FAILURE ' + f.saved.token)
      if (kind === 'stream') return new Response(new ReadableStream({ start(controller) { controller.error(Error('PRIVATE_STREAM')) } }),
        { headers: { 'content-type': 'application/json', 'x-jevable-protocol': PROTOCOL_VERSION } })
      if (kind === 'headers') return new Response('PRIVATE_RESPONSE', { headers: { 'content-type': 'text/html' } })
      return new Response(kind === 'utf8' ? new Uint8Array([255]) : kind === 'size' ? new Uint8Array(20_000_001)
        : kind === 'identity' ? JSON.stringify({ instanceId: randomUUID(), result: {} }) : '{PRIVATE_JSON',
      { headers: { 'content-type': 'application/json', 'x-jevable-protocol': PROTOCOL_VERSION } })
    })
    const command = { operation: 'tests.generate', id: f.saved.batchId, triggerMode: 'api' }
    const error = await refusal(f.port.request(command)); f.port.error(error)
    expect(f.get('live-connection-status').textContent).toBe(unconfirmed)
    expect(f.get('live-connection-status').textContent).not.toContain('PRIVATE_')
    expect(f.get('live-connection-status').textContent).not.toContain(f.saved.token)
    expect(f.get('live-login').hidden).toBe(true); expect(f.get('live-session').hidden).toBe(false)
    expect(f.get('live-run').disabled).toBe(disabled); expect(f.storage.get(f.key)).toBe(before)
    await settle(); expect(f.calls).toEqual([{ operation: 'view' }, { operation: 'runs' }, command])
  })
  it('a successful read changes only connection feedback, not a retained action warning or consent', async () => {
    const f = await fixture(), retained = f.storage.get(f.key)
    f.fail(async () => { throw Error('PRIVATE_TRANSPORT') })
    const error = await refusal(f.port.request({ operation: 'tests.generate', id: f.saved.batchId, triggerMode: 'api' }))
    f.port.error(error); const warning = f.get('live-message').textContent
    f.get('live-authorize').checked = true
    await f.port.request({ operation: 'tests.generation', id: f.saved.batchId })
    expect(f.get('live-connection-status').textContent).toBe(verified)
    expect(f.get('live-message').textContent).toBe(warning); expect(f.get('live-authorize').checked).toBe(true)
    expect(f.get('live-message').attributes.get('data-tone')).toBe('warning')
    expect(f.storage.get(f.key)).toBe(retained)
    expect(f.calls.slice(2)).toEqual([{ operation: 'tests.generate', id: f.saved.batchId, triggerMode: 'api' }, { operation: 'tests.generation', id: f.saved.batchId }])
  })
  it('keeps an uncertain Run warning through failed status reads, then clears it only when that run is found', async () => {
    const f = await fixture()
    expect(f.get('live-run').disabled).toBe(false)
    f.get('live-input').value = 'null'
    f.fail(async () => { throw Error('PRIVATE_RUN_TRANSPORT') })
    f.click('live-run'); await settle()
    expect(f.storage.get(f.key)).toContain('runId')
    expect(f.calls.map(call => call.operation)).toContain('run')
    const run = f.calls.find(call => call.operation === 'run')!
    const warning = f.get('live-message').textContent
    expect(warning).toContain('Your workflow may still be running')
    expect(f.get('live-message').attributes.get('data-tone')).toBe('warning')
    f.fail(async () => { throw Error('PRIVATE_STATUS_TRANSPORT') })
    await new Promise(resolve => setTimeout(resolve, 1100)); await settle()
    expect(f.calls.at(-1)).toEqual({ operation: 'show', id: run.id })
    expect(f.get('live-message').textContent).toBe(warning)
    f.fail(async () => { throw Error('PRIVATE_REFRESH_TRANSPORT') })
    f.click('live-inspect'); await settle()
    expect(f.get('live-message').textContent).toBe(warning)
    f.fail(async () => f.reply({ id: run.id, status: 'paused', checkpointSha256: 'b'.repeat(64) }))
    f.click('live-inspect'); await settle()
    expect(f.get('live-message').textContent).toContain('Saved status found for this run')
    expect(f.get('live-message').attributes.get('data-tone')).toBe('neutral')
    expect(f.calls.filter(call => call.operation === 'run')).toHaveLength(1)
    expect(f.calls.slice(3).map(call => call.operation)).toEqual(['show', 'show', 'show'])
  })
  it.each(['success', 'failure'] as const)('an older %s cannot overwrite the latest dispatch outcome', async oldOutcome => {
    const f = await fixture(), held = heldReply()
    f.fail(() => held.promise); const old = f.port.request({ operation: 'tests.list' }).then(value => value, error => error)
    expect(f.get('live-connection-status').textContent).toBe(waiting)
    f.fail(async () => { throw Error('PRIVATE_NEW_FAILURE') })
    await refusal(f.port.request({ operation: 'tests.history', id: caseId }))
    expect(f.get('live-connection-status').textContent).toBe(unconfirmed)
    if (oldOutcome === 'success') held.resolve(f.reply({ cases: [] })); else held.reject(Error('PRIVATE_OLD_FAILURE'))
    await old
    expect(f.get('live-connection-status').textContent).toBe(unconfirmed)
    expect(f.calls.slice(2)).toEqual([{ operation: 'tests.list' }, { operation: 'tests.history', id: caseId }])
  })
  it('an older failure cannot overwrite a newer verified read or its pending state', async () => {
    const f = await fixture(), older = heldReply(), newer = heldReply()
    f.fail(() => older.promise); const old = f.port.request({ operation: 'tests.list' }).catch(error => error)
    f.fail(() => newer.promise); const latest = f.port.request({ operation: 'tests.history', id: caseId })
    older.reject(Error('PRIVATE_OLD_FAILURE')); await old
    expect(f.get('live-connection-status').textContent).toBe(waiting)
    newer.resolve(f.reply({ versions: [] })); await latest
    expect(f.get('live-connection-status').textContent).toBe(verified)
  })
  it.each(['success', 'failure'] as const)('fences a held %s across pagehide and pageshow without a new lookup', async outcome => {
    const f = await fixture(), held = heldReply()
    f.fail(() => held.promise); const pending = f.port.request({ operation: 'tests.list' }).catch(error => error)
    f.event('pagehide'); const status = f.get('live-connection-status').textContent
    f.event('pageshow')
    if (outcome === 'success') held.resolve(f.reply({ cases: [] })); else held.reject(Error('PRIVATE_LATE_FAILURE'))
    await pending; await settle()
    expect(f.get('live-connection-status').textContent).toBe(status)
    expect(status).toContain('not checked since leaving'); expect(f.calls).toHaveLength(3)
    await f.port.request({ operation: 'tests.list' }); expect(f.get('live-connection-status').textContent).toBe(verified)
  })
  it('a dispatch while hidden cannot confirm the connection after the page returns', async () => {
    const f = await fixture(), held = heldReply(); f.event('pagehide')
    const status = f.get('live-connection-status').textContent
    f.fail(() => held.promise); const pending = f.port.request({ operation: 'tests.list' })
    f.event('pageshow'); held.resolve(f.reply({ cases: [] })); await pending
    expect(f.get('live-connection-status').textContent).toBe(status)
    expect(f.calls).toHaveLength(3)
  })
  it('an identified controlled rejection remains a verified reply, not an offline or succeeded action', async () => {
    const f = await fixture(); f.fail(async () => f.reply(undefined, 409, 'conflict'))
    const error = await refusal(f.port.request({ operation: 'tests.accept', id: caseId })); f.port.error(error)
    expect(error).toMatchObject({ status: 409, code: 'conflict' })
    expect(f.get('live-connection-status').textContent).toBe(verified)
    expect(f.get('live-message').textContent).toContain('Runtime rejected operation: conflict')
    expect(f.storage.get(f.key)).toBe(JSON.stringify(f.saved)); expect(f.calls).toHaveLength(3)
  })
  it('an unidentified decoded rejection cannot claim a verified instance', async () => {
    const f = await fixture(); f.fail(async () => new Response(JSON.stringify({ code: 'conflict' }),
      { status: 409, headers: { 'content-type': 'application/json', 'x-jevable-protocol': PROTOCOL_VERSION } }))
    const error = await refusal(f.port.request({ operation: 'tests.accept', id: caseId }))
    expect(error).toMatchObject({ status: 409, code: 'conflict' })
    expect(f.get('live-connection-status').textContent).toBe(unconfirmed)
  })
  it('local input errors do not invent a failed connection or dispatch', async () => {
    const f = await fixture(); f.get('live-input').value = '{PRIVATE_INVALID_JSON'
    f.click('live-run'); await settle()
    expect(f.get('live-connection-status').textContent).toBe(verified)
    expect(f.get('live-message').attributes.get('data-tone')).toBe('warning')
    for (const handler of f.get('live-input').handlers.get('input') ?? []) handler()
    expect(f.get('live-message').textContent).toContain('Input changed')
    expect(f.get('live-message').attributes.get('data-tone')).toBe('neutral')
    expect(f.calls).toHaveLength(2); expect(f.storage.get(f.key)).toBe(JSON.stringify(f.saved))
  })
  it('keeps the fifteen-second deadline and never automatically refreshes or replays a timed-out action', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const f = await fixture(); f.fail(signal => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('PRIVATE_TIMEOUT')))))
    const pending = refusal(f.port.request({ operation: 'tests.generate', id: f.saved.batchId }))
    expect(f.get('live-connection-status').textContent).toBe(waiting)
    await vi.advanceTimersByTimeAsync(14999); expect(f.get('live-connection-status').textContent).toBe(waiting)
    await vi.advanceTimersByTimeAsync(1); const error = await pending
    expect(error.message).toContain('took too long'); expect(f.get('live-connection-status').textContent).toBe(unconfirmed)
    await vi.advanceTimersByTimeAsync(30000); expect(f.calls).toHaveLength(3)
    expect(f.storage.get(f.key)).toBe(JSON.stringify(f.saved))
  })
  it('expiry cannot be reversed by a previously dispatched successful reply', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-15T00:00:00.000Z')
    const f = await fixture(), held = heldReply()
    f.fail(() => held.promise); const pending = f.port.request({ operation: 'tests.list' }).catch(error => error)
    vi.setSystemTime('2099-01-01T00:00:00.001Z'); f.event('focus')
    const status = f.get('live-connection-status').textContent
    held.resolve(f.reply({ cases: [] })); await pending
    expect(f.get('live-connection-status').textContent).toBe(status); expect(status).toContain('Connect to check')
    expect(f.get('live-session').hidden).toBe(true); expect(f.get('live-login').hidden).toBe(false)
    expect(JSON.parse(f.storage.get(f.key)!)).toEqual({ ...f.saved, reconnectRequired: true }); expect(f.calls).toHaveLength(3)
  })
  it.each(['success', 'failure'] as const)('a held old-session %s cannot overwrite an explicitly reconnected session', async outcome => {
    const f = await fixture(), held = heldReply()
    f.fail(() => held.promise); const pending = f.port.request({ operation: 'tests.list' }).catch(error => error)
    f.fail(async () => f.reply(undefined, 401, 'unauthorized'))
    await refusal(f.port.request({ operation: 'tests.history', id: caseId }))
    expect(f.get('live-connection-status').textContent).toContain('Connect to check')
    const replacement = { token: 'b'.repeat(64), expiresAt: '2099-02-01T00:00:00.000Z' }
    f.get('live-token').value = 'f'.repeat(64); f.fail(async () => f.reply(replacement))
    f.click('live-connect'); await settle()
    expect(f.get('live-connection-status').textContent).toBe(verified)
    const retained = f.storage.get(f.key)
    expect(JSON.parse(retained!)).toEqual({ ...f.saved, ...replacement })
    if (outcome === 'success') held.resolve(f.reply({ cases: [] })); else held.reject(Error('PRIVATE_OLD_SESSION'))
    await pending; await settle()
    expect(f.get('live-connection-status').textContent).toBe(verified); expect(f.storage.get(f.key)).toBe(retained)
    expect(f.calls.map(call => call.operation)).toEqual(['view', 'runs', 'tests.list', 'tests.history', undefined, 'view', 'runs'])
  })
  it('a late in-flight reply cannot replace the explicit closing status', async () => {
    const f = await fixture(), held = heldReply(), logout = heldReply()
    f.fail(() => held.promise); const pending = f.port.request({ operation: 'tests.list' })
    f.fail(() => logout.promise); f.click('live-logout')
    const status = f.get('live-connection-status').textContent; expect(status).toContain('Session closing')
    held.resolve(f.reply({ cases: [] })); await pending
    expect(f.get('live-connection-status').textContent).toBe(status)
    logout.resolve(f.reply({ status: 'disconnected' })); await settle()
    expect(f.storage.has(f.key)).toBe(false); expect(f.get('live-connection-status').textContent).toBe(status)
  })
})

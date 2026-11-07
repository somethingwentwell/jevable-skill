import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { JSDOM } from 'jsdom'
import { livePreviewBrowser, renderLivePage } from '../src/preview/live-page.ts'
import { PROTOCOL_VERSION } from '../src/capabilities.ts'
import { liveInputControls } from '../src/preview/input-controls.ts'
import { schemaInputTools } from '../src/preview/input-model.ts'

// Actual serialized controller/DOM with synthetic protocol responses, not browser acceptance.
const windows: JSDOM[] = []
afterEach(() => { for (const dom of windows.splice(0)) dom.window.close() })
async function fixture(status = 'completed', withEditor = false, deadlineStatus = 'open-at-observation', timeoutOutcome = 'expired') {
  const instance = randomUUID(), dom = new JSDOM(renderLivePage(instance, PROTOCOL_VERSION).html,
    { runScripts: 'outside-only', url: 'http://127.0.0.1:3000/' })
  windows.push(dom)
  Object.assign(dom.window, { TextEncoder, TextDecoder })
  const key = `jevable.preview.${instance}`
  dom.window.sessionStorage.setItem(key, JSON.stringify({ token: 'e'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString() }))
  const calls: any[] = [], retained = randomUUID(), attemptId = randomUUID()
  let failRun = false, failureText = 'Synthetic lost response'
  dom.window.fetch = vi.fn(async (_path: unknown, init: RequestInit) => {
    const command = JSON.parse(String(init.body)); calls.push(command)
    let result: unknown
    if (command.operation === 'view') result = { project: { id: randomUUID(), generation: 1 }, preview: {}, entry: { local: true, api: false }, readiness: { runtimeReadiness: 'ready' },
      inputSchema: { type: 'object', required: ['choice'], properties: { choice: { type: 'integer', enum: [0, 1] } } }, sample: withEditor ? { choice: 0 } : 'sample' }
    else if (command.operation === 'runs') result = { runs: [{ id: retained, status: 'completed' }] }
    else if (command.operation === 'run') {
      if (failRun) throw new dom.window.Error(failureText)
      result = { id: command.id, status, ...(status === 'waiting' ? { attemptId } : {}) }
    } else if (command.operation === 'show') result = { id: command.id, status: 'completed' }
    else if (command.operation === 'cancel') result = { id: command.id, status: 'cancelled' }
    else if (command.operation === 'approval') result = { id: command.id, attemptId, actions: ['approve'], deadlineStatus, timeoutOutcome,
      review: { input: 'Synthetic review' } }
    else if (command.operation === 'decide') result = command.expireOnly
      ? command.pauseAfter ? { id: command.id, status: 'paused', next: 'result', steps: [] }
        : { id: command.id, status: 'failed', code: 'approval-expired', nodeId: 'review', steps: [] }
      : { id: command.id, status: 'completed' }
    else throw Error('Unexpected operation in feedback fixture')
    return new Response(JSON.stringify({ instanceId: instance, result }),
      { headers: { 'content-type': 'application/json', 'x-jevable-protocol': PROTOCOL_VERSION } })
  }) as typeof dom.window.fetch
  dom.window.eval(`(${livePreviewBrowser.toString()})(()=>undefined,${JSON.stringify(instance)},${JSON.stringify(PROTOCOL_VERSION)},undefined,undefined,undefined,undefined,${withEditor ? liveInputControls.toString() : 'undefined'},${withEditor ? schemaInputTools.toString() : 'undefined'})`)
  const get = <T extends HTMLElement = HTMLElement>(id: string) => dom.window.document.getElementById(id) as T
  await vi.waitFor(() => expect(get('live-message').textContent).toContain('Session open'))
  const click = (id: string) => get<HTMLButtonElement>(id).click()
  const input = get<HTMLTextAreaElement>('live-input')
  return { dom, calls, get, click, input, key, retained, loseRunReply: (text = 'Synthetic lost response') => { failRun = true; failureText = text } }
}
describe('global preview feedback belongs to the explicit operation', () => {
  it('offers only a guarded expiry closure when the server observed a passed deadline', async () => {
    const f = await fixture('waiting', false, 'expired-at-observation')
    f.click('live-run')
    await vi.waitFor(() => expect(f.get('live-status').textContent).toContain('waiting'))
    f.click('live-review')
    await vi.waitFor(() => expect(f.get('live-actions').querySelectorAll('button')).toHaveLength(1))
    expect(f.get('live-approval-title').textContent).toBe('Review time ended')
    expect(f.get('live-approval-help').textContent).toContain('records expiry, not approval')
    expect(f.get<HTMLDetailsElement>('live-approval-options').hidden).toBe(true)
    const close = f.get('live-actions').querySelector<HTMLButtonElement>('button')!
    expect(close.textContent).toBe('Close as expired')
    expect(close.disabled).toBe(true)
    f.click('live-authorize'); expect(close.disabled).toBe(false)
    close.click()
    await vi.waitFor(() => expect(f.calls.filter(call => call.operation === 'decide')).toHaveLength(1))
    expect(f.calls.find(call => call.operation === 'decide')).toMatchObject({ action: 'approve', expireOnly: true, pauseAfter: false })
    await vi.waitFor(() => expect(f.get('live-status').textContent).toContain('failed'))
    expect(f.get('live-status').getAttribute('data-failure-code')).toBe('approval-expired')
  })
  it('pauses a timed-out branch before later steps instead of promising termination', async () => {
    const f = await fixture('waiting', false, 'expired-at-observation', 'branch')
    f.click('live-run')
    await vi.waitFor(() => expect(f.get('live-status').textContent).toContain('waiting'))
    f.click('live-review')
    await vi.waitFor(() => expect(f.get('live-actions').querySelectorAll('button')).toHaveLength(1))
    const record = f.get('live-actions').querySelector<HTMLButtonElement>('button')!
    expect(record.textContent).toBe('Record timeout and pause')
    expect(f.get('live-approval-help').textContent).toContain('Continuing the timeout path later is a separate action')
    f.click('live-authorize'); record.click()
    await vi.waitFor(() => expect(f.calls.filter(call => call.operation === 'decide')).toHaveLength(1))
    expect(f.calls.find(call => call.operation === 'decide')).toMatchObject({ expireOnly: true, pauseAfter: true })
    await vi.waitFor(() => expect(f.get('live-status').textContent).toContain('paused'))
  })
  it.each([false, true])('invalidates only a local read error on actual JSON editing (structured controller %s)', async withEditor => {
    const f = await fixture('completed', withEditor)
    if (withEditor) f.click('input-use-json')
    f.input.value = '{'; f.click('live-run')
    await vi.waitFor(() => expect(f.get('live-message').textContent).not.toContain('Session open'))
    const calls = structuredClone(f.calls), retained = f.dom.window.sessionStorage.getItem(f.key)
    const draft = '\n {"choice":"still invalid"}\n'; f.input.value = draft
    f.input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }))
    expect(f.get('live-message').textContent).toBe('Input changed. Choose Run workflow to check it; nothing was submitted.')
    expect(f.input.value).toBe(draft); expect(f.calls).toEqual(calls)
    expect(f.dom.window.sessionStorage.getItem(f.key)).toBe(retained)
    expect(f.calls.filter(c => c.operation === 'run')).toEqual([])
  })
  it('invalidates a prior local submission error on successful mode switching without submitting', async () => {
    const f = await fixture('completed', true); f.click('input-use-json')
    f.input.value = '{"choice":2}'; f.click('live-run')
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Choose one of the listed values.'))
    const calls = structuredClone(f.calls)
    f.input.value = '{"choice":0}'; f.click('input-use-fields')
    expect(f.get('live-message').textContent).toContain('Input changed.')
    expect(f.get('input-fields').hidden).toBe(false); expect(f.calls).toEqual(calls)
    expect(f.calls.filter(c => c.operation === 'run')).toEqual([])
  })
  it.each([false, true])('preserves unresolved transport feedback when input changes (structured controller %s)', async withEditor => {
    const f = await fixture('completed', withEditor); f.loseRunReply(); f.click('live-run')
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Your workflow may still be running'))
    const retained = f.dom.window.sessionStorage.getItem(f.key)
    if (withEditor) {
      const field = f.dom.window.document.querySelector<HTMLSelectElement>('#input-fields select')!
      field.value = '1'; field.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }))
    } else { f.input.value = '"edited draft"'; f.input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true })) }
    expect(f.get('live-message').textContent).toContain('Your workflow may still be running')
    expect(f.get('live-message').textContent).not.toContain('Synthetic lost response')
    expect(f.dom.window.sessionStorage.getItem(f.key)).toBe(retained)
    expect(f.calls.filter(c => c.operation === 'run')).toHaveLength(1)
  })
  it('does not treat a transport failure containing an earlier input error as draft feedback', async () => {
    const f = await fixture('completed', true); f.click('input-use-json')
    f.input.value = '{"choice":2}'; f.click('live-run')
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Choose one of the listed values.'))
    const previousText = f.get('live-message').textContent!
    f.loseRunReply(previousText); f.input.value = '{"choice":0}'; f.click('live-run')
    await vi.waitFor(() => expect(f.calls.filter(c => c.operation === 'run')).toHaveLength(1))
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Your workflow may still be running'))
    const transportText = f.get('live-message').textContent!
    expect(transportText).not.toBe(previousText)
    f.input.value = '{"choice":1}'; f.input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }))
    expect(f.get('live-message').textContent).toBe(transportText)
    expect(f.calls.filter(c => c.operation === 'run')).toHaveLength(1)
  })
  it('clears rejected local input feedback before a separately submitted valid run', async () => {
    const f = await fixture(); f.input.value = '{'; f.click('live-run')
    await vi.waitFor(() => expect(f.get('live-message').textContent).not.toContain('Session open'))
    expect(f.get('live-message').textContent).not.toBe('')
    expect(f.calls.filter(c => c.operation === 'run')).toEqual([])
    f.input.value = JSON.stringify('Synthetic valid input'); f.click('live-run')
    await vi.waitFor(() => expect(f.get('live-status').textContent).toContain('completed'))
    expect(f.get('live-message').textContent).toBe('')
    const run = f.calls.filter(c => c.operation === 'run'); expect(run).toHaveLength(1)
    expect(JSON.parse(f.dom.window.sessionStorage.getItem(f.key)!)).toHaveProperty('runId', run[0].id)
  })
  it('clears a previous test assessment when another retained run is explicitly selected, without executing or editing input', async () => {
    const f = await fixture(); f.input.value = 'UNTOUCHED LOCAL DRAFT'
    f.get('live-message').textContent = 'Test passed; workflow waiting; terminal: false.'
    const select = f.get<HTMLSelectElement>('live-history'); select.value = f.retained
    select.dispatchEvent(new f.dom.window.Event('change'))
    await vi.waitFor(() => expect(f.get('live-status').textContent).toContain('completed'))
    expect(f.get('live-message').textContent).toBe(''); expect(f.input.value).toBe('UNTOUCHED LOCAL DRAFT')
    expect(f.calls.map(c => c.operation)).toEqual(['view', 'runs', 'show'])
  })
  it('clears the earlier wait assessment when explicitly cancelling the current run', async () => {
    const f = await fixture('waiting'); f.click('live-run')
    await vi.waitFor(() => expect(f.get('live-status').textContent).toContain('waiting'))
    f.get('live-message').textContent = 'Test passed; workflow waiting; terminal: false.'
    f.click('live-cancel')
    await vi.waitFor(() => expect(f.get('live-status').textContent).toContain('cancelled'))
    expect(f.get('live-message').textContent).toBe('')
    expect(f.calls.filter(c => c.operation === 'cancel')).toHaveLength(1)
    expect(f.calls.filter(c => c.operation === 'run')).toHaveLength(1)
  })
  it('clears earlier feedback only after a reviewed decision is authorized', async () => {
    const f = await fixture('waiting'); f.click('live-run')
    await vi.waitFor(() => expect(f.get('live-status').textContent).toContain('waiting'))
    f.click('live-review'); await vi.waitFor(() => expect(f.get('live-approval').hidden).toBe(false))
    const button = f.get('live-actions').querySelector<HTMLButtonElement>('button')!
    expect(button.disabled).toBe(true)
    button.click()
    expect(f.calls.filter(c => c.operation === 'decide')).toEqual([])
    const confirmation = f.get<HTMLInputElement>('live-authorize')
    confirmation.checked = true
    confirmation.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }))
    expect(button.disabled).toBe(false)
    button.click()
    await vi.waitFor(() => expect(f.get('live-status').textContent).toContain('completed'))
    expect(f.get('live-message').textContent).toBe(''); expect(f.calls.filter(c => c.operation === 'decide')).toHaveLength(1)
  })
  it('keeps a lost-Run warning through unrelated reads, then resolves it only from the same saved run', async () => {
    const f = await fixture(); f.loseRunReply(); f.click('live-run')
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Your workflow may still be running'))
    const warning = f.get('live-message').textContent
    f.click('live-refresh-history'); await vi.waitFor(() => expect(f.calls.filter(c => c.operation === 'runs')).toHaveLength(2))
    expect(f.get('live-message').textContent).toBe(warning)
    f.click('live-inspect'); await vi.waitFor(() => expect(f.get('live-status').textContent).toContain('completed'))
    expect(f.get('live-message').textContent).toContain('Saved status found for this run')
    expect(f.get('live-message').getAttribute('data-tone')).toBe('neutral')
    expect(f.calls.filter(c => c.operation === 'run')).toHaveLength(1)
    expect(f.calls.filter(c => c.operation === 'show').map(c => c.id)).toEqual([f.calls.find(c => c.operation === 'run').id])
  })
  it('clears a previously reviewed request when a status read observes completion, without sending a decision', async () => {
    const f = await fixture('waiting'); f.click('live-run')
    await vi.waitFor(() => expect(f.get('live-status').textContent).toContain('waiting'))
    f.click('live-review'); await vi.waitFor(() => expect(f.get('live-approval').hidden).toBe(false))
    expect(f.get('live-actions').textContent).toBe('Approve')
    f.get<HTMLInputElement>('live-authorize').checked = true
    f.click('live-inspect')
    await vi.waitFor(() => expect(f.get('live-status').textContent).toContain('completed'))
    expect(f.get('live-approval').hidden).toBe(true)
    expect(f.get('live-review-data').textContent).toBe('')
    expect(f.get('live-actions').children).toHaveLength(0)
    expect(f.get<HTMLInputElement>('live-authorize').checked).toBe(false)
    expect(f.calls.filter(c => c.operation === 'decide')).toEqual([])
  })
})

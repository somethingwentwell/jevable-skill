import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { renderReleaseReviewerPage } from '../src/releases/reviewer-page.ts'
import { PROTOCOL_VERSION } from '../src/capabilities.ts'

const instanceId = randomUUID(), token = 'jvg1.' + randomUUID() + '.' + 'a'.repeat(64)
const runId = randomUUID(), attemptId = randomUUID()
const review = { schemaVersion: 1, release: { id: randomUUID(), sha256: 'b'.repeat(64), revision: 'c'.repeat(64), version: '1.0.0' },
  runId, attemptId, nodeId: 'review', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), actions: ['approve'],
  review: { title: '<img src=x onerror=alert(1)>', input: { reason: 'PRIVATE_REVIEW', accepted: false } } }
const opened: JSDOM[] = []
afterEach(() => { for (const browser of opened.splice(0)) browser.window.close(); vi.restoreAllMocks() })

function contrast(foreground: string, background: string) {
  const luminance = (hex: string) => {
    const full = hex.length === 4 ? `#${[...hex.slice(1)].map(channel => channel + channel).join('')}` : hex
    const channels = full.match(/[0-9a-f]{2}/gu)!.map(channel => parseInt(channel, 16) / 255)
      .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
  }
  const [first, second] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (first! + 0.05) / (second! + 0.05)
}

function mount(responder: (path: string, body: any) => { status: number; value: any }) {
  const page = renderReleaseReviewerPage(instanceId)
  const calls: { path: string; body: any; token: string; instance: string; protocol: string }[] = []
  const browser = new JSDOM(page.html, { runScripts: 'dangerously', url: 'http://127.0.0.1:1234/review',
    beforeParse(window) {
      Object.defineProperty(window.crypto, 'randomUUID', { value: () => randomUUID() })
      Object.defineProperty(window, 'fetch', { value: vi.fn(async (path: string, options: RequestInit) => {
        const body = JSON.parse(String(options.body)), headers = options.headers as Record<string, string>
        calls.push({ path, body, token: headers.authorization!, instance: headers['x-jevable-instance']!, protocol: headers['x-jevable-protocol']! })
        const result = responder(path, body)
        return { ok: result.status < 400, status: result.status, json: async () => result.value }
      }) })
    } })
  opened.push(browser)
  const document = browser.window.document
  return { page, browser, document, calls, connect: async () => {
    (document.getElementById('reviewer-token') as HTMLInputElement).value = token
    document.getElementById('connect-form')!.dispatchEvent(new browser.window.Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(document.getElementById('review')!.hidden).toBe(false))
  } }
}

describe('separate exact-release reviewer page', () => {
  it('starts inert with a hash-bound shell and renders one untrusted request as text', async () => {
    const f = mount(() => ({ status: 200, value: { schemaVersion: 1, instanceId, result: review } }))
    const style = f.page.html.match(/<style>([\s\S]*?)<\/style>/u)![1]!
    const script = f.page.html.match(/<script>([\s\S]*?)<\/script>/u)![1]!
    for (const source of [style, script]) expect(f.page.csp).toContain(`'sha256-${createHash('sha256').update(source).digest('base64')}'`)
    expect(f.calls).toEqual([])
    expect(f.page.html).not.toContain(token)
    expect(f.page.html).not.toContain(review.release.sha256)
    await f.connect()
    expect(f.document.activeElement).toBe(f.document.getElementById('review'))
    expect(f.document.getElementById('review')!.getAttribute('aria-labelledby')).toBe('review-title')
    expect(f.calls).toEqual([{ path: '/v1/reviewer/request', body: {}, token: `Bearer ${token}`, instance: instanceId, protocol: PROTOCOL_VERSION }])
    expect(f.document.querySelector('img')).toBeNull()
    expect(f.document.getElementById('review-title')!.textContent).toBe(review.review.title)
    expect(f.document.getElementById('review-content')!.textContent).toContain('PRIVATE_REVIEW')
    expect((f.document.getElementById('reviewer-token') as HTMLInputElement).value).toBe('')
    expect(f.browser.window.localStorage.length).toBe(0)
  })

  it('requires explicit confirmation and retries only the retained decision UUID after an uncertain reply', async () => {
    let decisions = 0
    const f = mount((path, body) => path === '/v1/reviewer/request'
      ? { status: 200, value: { schemaVersion: 1, instanceId, result: review } }
      : ++decisions === 1 ? { status: 503, value: { code: 'commit-uncertain' } }
        : { status: 200, value: { schemaVersion: 1, instanceId, result: { requestId: body.requestId,
          runId, attemptId, action: 'approve', status: 'paused' } } })
    await f.connect()
    const action = f.document.querySelector<HTMLButtonElement>('#decision-actions button')!
    expect(action.disabled).toBe(true)
    const confirm = f.document.getElementById('confirm') as HTMLInputElement
    confirm.checked = true; confirm.dispatchEvent(new f.browser.window.Event('change', { bubbles: true }))
    expect(action.disabled).toBe(false)
    action.click()
    await vi.waitFor(() => expect(f.document.getElementById('retry')!.hidden).toBe(false))
    expect(f.document.activeElement).toBe(f.document.getElementById('retry'))
    expect(f.document.getElementById('status')!.textContent).toContain('outcome may be uncertain')
    expect(f.document.getElementById('status')!.textContent).not.toContain('commit-uncertain')
    f.document.getElementById('retry')!.click()
    await vi.waitFor(() => expect(f.document.getElementById('complete')!.hidden).toBe(false))
    expect(f.document.activeElement).toBe(f.document.getElementById('complete'))
    expect(f.document.getElementById('complete')!.getAttribute('aria-labelledby')).toBe('outcome')
    const [first, second] = f.calls.filter(call => call.path === '/v1/reviewer/decisions')
    expect(first?.body).toEqual(second?.body)
    expect(first?.body).toMatchObject({ action: 'approve', pauseAfter: false })
    expect(first?.body.requestId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(f.document.getElementById('outcome')!.textContent).toContain('approval was recorded')
    f.document.getElementById('signout')!.click()
    expect(f.document.getElementById('login')!.hidden).toBe(false)
    expect(f.document.activeElement).toBe(f.document.getElementById('reviewer-token'))
    expect(f.document.getElementById('review-content')!.textContent).toBe('')
    expect(f.document.getElementById('outcome')!.textContent).toBe('')
    expect(f.document.getElementById('outcome-note')!.textContent).toBe('')
  })

  it('ends an already-open review after access is revoked without offering a futile retry', async () => {
    const f = mount(path => path === '/v1/reviewer/request'
      ? { status: 200, value: { schemaVersion: 1, instanceId, result: review } }
      : { status: 404, value: { code: 'not-found' } })
    await f.connect()
    const confirm = f.document.getElementById('confirm') as HTMLInputElement
    confirm.checked = true; confirm.dispatchEvent(new f.browser.window.Event('change', { bubbles: true }))
    f.document.querySelector<HTMLButtonElement>('#decision-actions button')!.click()
    await vi.waitFor(() => expect(f.document.getElementById('login')!.hidden).toBe(false))
    expect(f.document.getElementById('review')!.hidden).toBe(true)
    expect(f.document.getElementById('retry')!.hidden).toBe(true)
    expect(f.document.getElementById('status')!.textContent).toContain('Ask the workflow owner to check the run')
    expect(f.document.getElementById('status')!.textContent).not.toContain('Check same decision')
    expect(f.document.activeElement).toBe(f.document.getElementById('reviewer-token'))
    expect(f.document.getElementById('review-content')!.textContent).toBe('')
    expect(f.document.getElementById('review-title')!.textContent).toBe('')
    expect(f.document.querySelectorAll('#decision-actions button')).toHaveLength(0)
    f.document.getElementById('retry')!.click()
    expect(f.calls.filter(call => call.path === '/v1/reviewer/decisions')).toHaveLength(1)
  })

  it('ends a stale review safely after the service instance changes instead of offering a futile retry', async () => {
    const f = mount(path => path === '/v1/reviewer/request'
      ? { status: 200, value: { schemaVersion: 1, instanceId, result: review } }
      : { status: 409, value: { code: 'instance-mismatch' } })
    await f.connect()
    const confirm = f.document.getElementById('confirm') as HTMLInputElement
    confirm.checked = true; confirm.dispatchEvent(new f.browser.window.Event('change', { bubbles: true }))
    f.document.querySelector<HTMLButtonElement>('#decision-actions button')!.click()
    await vi.waitFor(() => expect(f.document.getElementById('login')!.hidden).toBe(false))
    expect(f.document.getElementById('review')!.hidden).toBe(true)
    expect(f.document.getElementById('retry')!.hidden).toBe(true)
    expect(f.document.getElementById('status')!.textContent).toContain('Ask the workflow owner to check the saved run')
    expect(f.document.getElementById('status')!.textContent).not.toContain('instance-mismatch')
    expect(f.document.getElementById('status')!.textContent).not.toContain('Check same decision')
    expect(f.document.getElementById('review-content')!.textContent).toBe('')
    expect(f.document.querySelectorAll('#decision-actions button')).toHaveLength(0)
    expect(f.document.activeElement).toBe(f.document.getElementById('reviewer-token'))
    expect(f.calls.filter(call => call.path === '/v1/reviewer/decisions')).toHaveLength(1)
  })

  it('ends a stale review when a successful HTTP reply names a different service instance', async () => {
    const replacementInstance = randomUUID()
    const f = mount(path => path === '/v1/reviewer/request'
      ? { status: 200, value: { schemaVersion: 1, instanceId, result: review } }
      : { status: 200, value: { schemaVersion: 1, instanceId: replacementInstance, result: {
        requestId: randomUUID(), runId, attemptId, action: 'approve', status: 'completed' } } })
    await f.connect()
    const confirm = f.document.getElementById('confirm') as HTMLInputElement
    confirm.checked = true; confirm.dispatchEvent(new f.browser.window.Event('change', { bubbles: true }))
    f.document.querySelector<HTMLButtonElement>('#decision-actions button')!.click()
    await vi.waitFor(() => expect(f.document.getElementById('login')!.hidden).toBe(false))
    expect(f.document.getElementById('review')!.hidden).toBe(true)
    expect(f.document.getElementById('complete')!.hidden).toBe(true)
    expect(f.document.getElementById('retry')!.hidden).toBe(true)
    expect(f.document.getElementById('status')!.textContent).toContain('Ask the workflow owner to check the saved run')
    expect(f.document.getElementById('review-content')!.textContent).toBe('')
    expect(f.document.querySelectorAll('#decision-actions button')).toHaveLength(0)
    expect(f.document.activeElement).toBe(f.document.getElementById('reviewer-token'))
    f.document.getElementById('retry')!.click()
    expect(f.calls.filter(call => call.path === '/v1/reviewer/decisions')).toHaveLength(1)
  })

  it('keeps disabled decision text and focus-ring colors readable in both themes', () => {
    const style = renderReleaseReviewerPage(instanceId).html.match(/<style>([\s\S]*?)<\/style>/u)![1]!
    const light = style.match(/^:root\{([^}]*)\}/u)![1]!
    const dark = style.match(/@media\(prefers-color-scheme:dark\)\{:root\{([^}]*)\}/u)![1]!
    const variable = (rules: string, name: string) => rules.match(new RegExp(`--${name}:(#[0-9a-f]{3,6})`, 'u'))![1]!
    for (const rules of [light, dark]) {
      const card = variable(rules, 'card')
      const background = variable(rules, 'bg')
      const focus = variable(rules, 'blue')
      expect(contrast('#ffffff', variable(rules, 'disabled-bg'))).toBeGreaterThanOrEqual(4.5)
      expect(contrast(focus, card)).toBeGreaterThanOrEqual(3)
      expect(contrast(focus, background)).toBeGreaterThanOrEqual(3)
    }
    expect(style).toContain('button.primary:disabled{background:var(--disabled-bg);border-color:var(--blue);color:#fff}')
    expect(style).not.toContain('button:disabled{opacity:')
    expect(style).toContain('@media(forced-colors:active)')
  })

  it('explains a rejected workflow as a decision, not a technical error', async () => {
    const rejectedReview = { ...review, actions: ['reject'] }
    const f = mount((path, body) => path === '/v1/reviewer/request'
      ? { status: 200, value: { schemaVersion: 1, instanceId, result: rejectedReview } }
      : { status: 200, value: { schemaVersion: 1, instanceId, result: { requestId: body.requestId,
        runId, attemptId, action: 'reject', status: 'failed' } } })
    await f.connect()
    const confirm = f.document.getElementById('confirm') as HTMLInputElement
    confirm.checked = true; confirm.dispatchEvent(new f.browser.window.Event('change', { bubbles: true }))
    f.document.querySelector<HTMLButtonElement>('#decision-actions button')!.click()
    await vi.waitFor(() => expect(f.document.getElementById('complete')!.hidden).toBe(false))
    expect(f.document.getElementById('outcome-note')!.textContent).toBe('The workflow stopped because this request was rejected.')
  })

  it('shows a custom workflow action in plain words and records its exact name only after confirmation', async () => {
    const customReview = { ...review, actions: ['requestChanges'] }
    const f = mount((path, body) => path === '/v1/reviewer/request'
      ? { status: 200, value: { schemaVersion: 1, instanceId, result: customReview } }
      : { status: 200, value: { schemaVersion: 1, instanceId, result: { requestId: body.requestId,
        runId, attemptId, action: 'requestChanges', status: 'paused' } } })
    await f.connect()
    const button = f.document.querySelector<HTMLButtonElement>('#decision-actions button')!
    expect(button.textContent).toBe('Request Changes')
    expect(button.disabled).toBe(true)
    const confirm = f.document.getElementById('confirm') as HTMLInputElement
    confirm.checked = true; confirm.dispatchEvent(new f.browser.window.Event('change', { bubbles: true }))
    button.click()
    await vi.waitFor(() => expect(f.document.getElementById('complete')!.hidden).toBe(false))
    expect(f.calls.at(-1)!.body.action).toBe('requestChanges')
    expect(f.document.getElementById('outcome')!.textContent).toContain('Request Changes')
  })

  it('explains a revoked or unavailable review without showing an internal error code', async () => {
    const f = mount(() => ({ status: 404, value: { code: 'not-found' } }))
    const input = f.document.getElementById('reviewer-token') as HTMLInputElement
    input.value = token
    f.document.getElementById('connect-form')!.dispatchEvent(new f.browser.window.Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(f.document.getElementById('status')!.textContent).toContain('Ask the workflow owner for a new token.'))
    expect(f.document.getElementById('status')!.textContent).not.toContain('not-found')
    expect(f.document.getElementById('review')!.hidden).toBe(true)
    expect(input.value).toBe('')
  })
})

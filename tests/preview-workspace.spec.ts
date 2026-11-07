import { afterEach, describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { createHash } from 'node:crypto'
import { Script } from 'node:vm'
import { renderLivePage } from '../src/preview/live-page.ts'
import { workspaceScript } from '../src/preview/workspace.generated.ts'
import { previewViewer } from '../src/preview/viewer.ts'
import { createPreview } from '../src/preview/model.ts'
import { liveInputControls } from '../src/preview/input-controls.ts'
import { schemaInputTools } from '../src/preview/input-model.ts'
import { readFile } from 'node:fs/promises'

// Executes the actual bundled React/Animate UI shell against DOM fixtures. These
// are not real-browser, assistive-technology or visual usability qualification.
const windows: JSDOM[] = []
afterEach(() => { for (const dom of windows.splice(0)) dom.window.close() })
const settle = () => new Promise(resolve => setTimeout(resolve, 30))
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
async function fixture() {
  const { html } = renderLivePage('00000000-0000-4000-8000-000000000000', 'jevable/v1alpha1')
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://127.0.0.1:3000/' })
  windows.push(dom)
  const document = dom.window.document
  Object.defineProperty(dom.window, 'TextEncoder', { value: TextEncoder })
  Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) })
  const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
  const editor = get<HTMLTextAreaElement>('test-editor')
  editor.value = JSON.stringify({ title: 'Approval example', input: { message: 'Synthetic example' }, expectations: [{ kind: 'status', value: 'waiting' }, { kind: 'node-visited', nodeId: 'review' }] })
  const run = get<HTMLButtonElement>('live-run'), calls: string[] = []
  run.addEventListener('click', () => calls.push('run'))
  get('live-connect').addEventListener('click', () => calls.push('connect'))
  for (const id of ['live-review', 'live-cancel', 'live-step', 'live-continue'])
    get(id).addEventListener('click', () => calls.push(id))
  dom.window.eval(workspaceScript)
  await settle()
  const connect = async () => {
    get('live-login').hidden = true; get('live-session').hidden = false; get('preview-workspace').hidden = false
    get('live-readiness').textContent = 'Runtime: ready.'; run.disabled = false
    await settle()
  }
  const click = async (id: string) => { get<HTMLButtonElement>(id).click(); await settle() }
  return { dom, document, get, connect, click, calls, run, editor }
}
describe('Animate UI workspace presentation and authority isolation', () => {
  it('keeps session access separate from the original runtime observation and operation warning', async () => {
    const f = await fixture(), observation = f.get('live-connection-status')
    expect(observation.getAttribute('role')).toBe('status')
    expect(observation.closest('#live-notices')?.getAttribute('aria-live')).toBe('polite')
    await f.connect(); f.get('live-message').textContent = 'Inspect the retained approval before deciding again.'
    const before = f.run.disabled
    observation.textContent = 'Connection unconfirmed. Refresh saved information explicitly.'; await settle()
    expect(f.document.querySelector('.connection-state')?.textContent).toBe('Session open')
    expect(f.document.querySelector('.connection-state')?.getAttribute('title')).toContain('connectivity are different')
    expect(f.get('live-connection-status')).toBe(observation); expect(observation.closest('[hidden]')).toBeNull()
    expect(f.get('live-message').textContent).toContain('retained approval'); expect(f.run.disabled).toBe(before)
    expect(f.calls).toEqual([])
    observation.textContent = 'Last runtime reply verified. Not checked continuously.'; await settle()
    expect(f.document.querySelector('.connection-state')?.textContent).toBe('Session open')
    expect(f.get('live-message').textContent).toContain('retained approval'); expect(f.calls).toEqual([])
  })
  it('explains unavailable Custom execution without redirecting a connected user to connection settings', async () => {
    const f = await fixture(); await f.connect()
    const control = f.run; control.disabled = true
    f.get('live-readiness').textContent = 'Runtime: unavailable. Custom execution unavailable.'; await settle()
    expect(f.document.querySelector('.run-guidance .status-label')?.textContent).toBe('Not ready to run')
    expect(f.document.querySelector('.run-guidance p')?.textContent).toContain('this runtime cannot run')
    expect(f.document.querySelector('.run-guidance p')?.textContent).toContain('still inspect')
    expect(f.document.querySelector('.run-guidance p')?.textContent).not.toContain('connection')
    expect(f.get('live-run')).toBe(control); expect(control.disabled).toBe(true); expect(f.calls).toEqual([])
    f.get('live-status').textContent = 'Run synthetic · waiting'; await settle()
    expect(f.document.querySelector('.run-guidance p')?.textContent).toContain('Open Approvals')
    f.get('live-status').textContent = ''; f.get('live-readiness').textContent = 'Runtime: ready.'; await settle()
    expect(f.document.querySelector('.run-guidance .status-label')?.textContent).toBe('Ready to try')
    expect(f.document.querySelector('.run-guidance p')?.textContent).not.toContain('Custom')
    expect(control.disabled).toBe(true); expect(f.calls).toEqual([])
  })
  it('distinguishes connection from readiness without changing the original run control', async () => {
    const f = await fixture(); await f.connect()
    const control = f.run
    f.run.disabled = true
    f.get('live-readiness').textContent = 'Runtime: unavailable.'; await settle()
    expect(f.document.querySelector('.run-guidance .status-label')?.textContent).toBe('Not ready to run')
    expect(f.document.querySelector('.run-guidance p')?.textContent).toContain('This workflow is not ready to run.')
    expect(f.document.querySelector('.connection-state')?.textContent).toContain('Session open')
    expect(f.get('live-run')).toBe(control); expect(control.disabled).toBe(true)
    f.get('live-readiness').textContent = 'Runtime: ready.'; await settle()
    expect(f.document.querySelector('.run-guidance .status-label')?.textContent).toBe('Ready to try')
    expect(f.document.querySelector('.run-guidance p')?.textContent).toContain('Enter a sample')
    expect(f.get('live-run')).toBe(control); expect(control.disabled).toBe(true)
    f.get('live-readiness').textContent = ''; await settle()
    expect(f.document.querySelector('.run-guidance .status-label')?.textContent).toBe('Not ready to run')
    expect(f.calls).toEqual([])
  })
  it.each([
    ['waiting', 'Waiting for your decision', 'Open Approvals'],
    ['completed', 'Run finished', 'Open Results'],
    ['failed', 'Run needs attention', 'Nothing is retried automatically'],
    ['cancelled', 'Run stopped', 'not undone'],
    ['paused', 'Run paused', 'Nothing resumes automatically'],
    ['executing', 'Result not confirmed', 'refreshing never resumes'],
    ['submitting', 'Request not confirmed', 'does not start another run on its own'],
    ['loading', 'Reading saved status', 'does not show whether'],
  ])('preserves selected %s run guidance when new-run readiness is unavailable', async (status, headline, hint) => {
    const f = await fixture(); await f.connect()
    f.run.disabled = true
    f.get('live-readiness').textContent = 'Runtime: unavailable.'
    f.get('live-status').textContent = `Run synthetic · ${status}`; await settle()
    expect(f.document.querySelector('.run-guidance .status-label')?.textContent).toBe(headline)
    expect(f.document.querySelector('.run-guidance p')?.textContent).toContain(hint)
    expect(f.document.querySelector('.run-guidance p')?.textContent).not.toContain('not ready to run')
    expect(f.run.disabled).toBe(true); expect(f.calls).toEqual([])
  })
  it.each([
    ['approval-rejected', 'Request rejected', 'The reviewer chose Reject', 'The request was rejected.'],
    ['approval-expired', 'Review time expired', 'No decision arrived before the deadline', 'The approval deadline passed'],
  ])('explains a recorded %s outcome without treating it as a broken runtime or taking another action', async (code, headline, hint, result) => {
    const f = await fixture(); await f.connect()
    f.get('live-status').dataset.failureCode = code
    f.get('live-status').textContent = 'Run synthetic · failed'; await settle()
    expect(f.document.querySelector('.run-guidance .status-label')?.textContent).toBe(headline)
    expect(f.document.querySelector('.run-guidance p')?.textContent).toContain(hint)
    expect(f.get('run-result-guidance').textContent).toContain(result)
    await f.click('tab-approvals')
    expect(f.get('approval-overview').textContent).toContain(headline)
    expect(f.get<HTMLButtonElement>('live-review').disabled).toBe(true)
    expect(f.calls).toEqual([])
    f.get('live-status').dataset.failureCode = 'arbitrary-untrusted-code'
    await settle()
    expect(f.document.querySelector('.run-guidance .status-label')?.textContent).toBe('Run needs attention')
    expect(f.get('approval-overview').textContent).toContain('Nothing waiting for your decision')
    expect(f.calls).toEqual([])
  })
  it('shows selected-run approval states without fetching, deciding or claiming a completed approval', async () => {
    const f = await fixture(); await f.connect()
    const review = f.get<HTMLButtonElement>('live-review')
    await f.click('tab-approvals')
    expect(f.get('approval-overview').textContent).toContain('Nothing waiting for your decision')
    expect(review.disabled).toBe(true)
    expect(f.get('tab-approvals').textContent).not.toContain('Needs review')
    f.get('live-status').textContent = 'Run synthetic · waiting'; await settle()
    expect(f.get('tab-approvals').textContent).toContain('Needs review')
    expect(f.get('approval-overview').textContent).toContain('A request needs your review')
    expect(f.get('live-review')).toBe(review)
    expect(f.document.querySelectorAll('#live-review')).toHaveLength(1)
    expect(f.get('live-review-data').textContent).toBe('')
    expect(f.get<HTMLInputElement>('live-authorize').checked).toBe(false)
    f.get('live-status').textContent = 'Run synthetic · completed'; await settle()
    expect(f.get('tab-approvals').textContent).not.toContain('Needs review')
    expect(f.get('approval-overview').textContent).toContain('This run has finished')
    expect(f.get('approval-overview').textContent).not.toContain('Approved')
    f.document.querySelector<HTMLButtonElement>('.approval-past-runs')!.click(); await settle()
    expect(f.get('panel-workflow').hidden).toBe(false)
    expect(f.get('panel-history').hidden).toBe(false)
    expect(f.calls).toEqual([])
  })
  it('keeps the simpler review confirmation and pause setting as original unchecked controls', async () => {
    const f = await fixture(); await f.connect(); await f.click('tab-approvals')
    expect(f.get('live-authorize').closest('label')?.textContent).toContain("I've read this request")
    expect(f.get<HTMLInputElement>('live-authorize').checked).toBe(false)
    expect(f.get('live-actions').compareDocumentPosition(f.get('live-approval-options')) & f.dom.window.Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(f.get<HTMLDetailsElement>('live-approval-options').open).toBe(false)
    expect(f.get<HTMLInputElement>('live-pause-after').checked).toBe(false)
    expect(f.get('live-review-data').closest('details')?.open).toBe(false)
    expect(f.calls).toEqual([])
  })
  it('ships phone guidance on its own row without hiding or replacing action controls', () => {
    const { html } = renderLivePage('fixture', 'jevable/v1alpha1')
    // JSDOM cannot prove layout. This guards shipping the scoped rule; actual
    // geometry, readable width and unchanged authority are checked in browser.
    expect(html).toContain('@media(max-width:800px){.run-guidance{flex-wrap:wrap;justify-content:flex-start;gap:8px 12px}')
    expect(html).toContain('.run-guidance>div{flex-basis:100%;min-width:0}')
    expect(html).toContain('.run-guidance>button{white-space:nowrap;max-width:100%}')
  })
  it('keeps a labelled single-file key picker and private paste fallback inside the original connection card', async () => {
    const f = await fixture(), picker = f.get<HTMLInputElement>('live-token-file')
    expect(picker.type).toBe('file'); expect(picker.multiple).toBe(false)
    expect(picker.getAttribute('accept')).toBeNull() // Key files may have no extension.
    expect(picker.closest('.connection-card')).not.toBeNull()
    expect(f.document.querySelector('label[for=live-token-file]')?.textContent).toBe('Choose access-key file')
    expect(f.get('live-key-file-status').getAttribute('role')).toBe('status')
    expect(f.get('live-connect-error').getAttribute('role')).toBe('alert')
    expect(f.get<HTMLInputElement>('live-token').type).toBe('password')
    expect(f.get('live-connect-help').textContent).toContain('not uploaded')
    expect(f.calls).toEqual([])
  })
  it('bundles the original Jevable artwork without external assets or runtime commands', async () => {
    const f = await fixture()
    const logo = f.document.querySelector('.workspace-brand svg.brand-mark')!
    expect(logo.getAttribute('viewBox')).toBe('0 0 40 40')
    expect(logo.getAttribute('aria-hidden')).toBe('true')
    expect(logo.querySelector('rect')?.getAttribute('fill')).toBe('#111827')
    expect(logo.querySelector('g')?.getAttribute('transform')).toBe('translate(3.9 3.9) scale(.805)')
    expect(logo.querySelector('path')?.getAttribute('d')).toBe('M26 13.5V23a7 7 0 0 1-7 7h-3')
    expect(logo.querySelectorAll('circle')).toHaveLength(2)
    expect(logo.querySelector('image')).toBeNull()
    expect(f.calls).toEqual([])
    expect(renderLivePage('fixture', 'jevable/v1alpha1').csp).toContain("img-src 'none'")
  })
  it('hashes both scripts without CDN, eval permission or inline-style permission', () => {
    const { html, csp } = renderLivePage('fixture', 'jevable/v1alpha1')
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]!)
    expect(scripts).toHaveLength(2)
    for (const script of scripts) { expect(() => new Script(script)).not.toThrow(); expect(csp).toContain('sha256-' + createHash('sha256').update(script).digest('base64')) }
    const style = html.match(/<style>([\s\S]*?)<\/style>/)![1]!
    expect(csp).toContain('sha256-' + createHash('sha256').update(style).digest('base64'))
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https:/)
    expect(workspaceScript).toContain('Copyright (c) 2025 Elliot Sutton')
    expect(workspaceScript).toContain('Commons Clause')
  })
  it('keeps the original input, execution and approval controls mounted once, without implicit commands', async () => {
    const f = await fixture()
    expect(f.document.querySelector('#workspace-root #live-login')).not.toBeNull()
    expect(f.document.querySelectorAll('#live-run')).toHaveLength(1)
    await f.connect()
    expect(f.get('live-run')).toBe(f.run)
    expect(f.document.querySelectorAll('#live-test-coverage')).toHaveLength(1)
    expect(f.get('live-test-coverage').closest('#panel-tests')).not.toBeNull()
    expect(f.get<HTMLButtonElement>('test-coverage-show').disabled).toBe(true)
    expect(f.get('live-run').closest('.workspace-sidebar')).not.toBeNull()
    expect(f.get('run-debug').closest('details')?.open).toBe(false)
    for (const id of ['tab-approvals', 'tab-tests', 'tab-publish', 'tab-settings', 'tab-workflow', 'tab-step', 'tab-try', 'tab-history', 'tab-traces', 'tab-results']) await f.click(id)
    expect(f.calls).toEqual([])
    expect(f.get('live-authorize').closest('#panel-approvals')).not.toBeNull()
    expect(f.get('live-review').closest('#panel-approvals')).not.toBeNull()
    f.run.click(); expect(f.calls).toEqual(['run'])
  })
  it('provides linked tab panels and keyboard navigation without executing or reconnecting', async () => {
    const f = await fixture(); await f.connect()
    f.get('tab-workflow').focus()
    f.get('tab-workflow').dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await settle()
    expect(f.document.activeElement?.id).toBe('tab-approvals')
    expect(f.get('tab-approvals').getAttribute('aria-selected')).toBe('true')
    expect(f.get('panel-approvals').hidden).toBe(false)
    expect(f.get('panel-workflow').hidden).toBe(true)
    for (const tab of f.document.querySelectorAll('[role=tab]')) {
      const panel = f.document.getElementById(tab.getAttribute('aria-controls')!)
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id)
    }
    expect(f.calls).toEqual([])
  })
  it('skips to the private key field only on a user click, without connecting or later stealing focus', async () => {
    const f = await fixture(), link = f.document.querySelector<HTMLAnchorElement>('.skip-link')!
    expect(f.document.activeElement).toBe(f.document.body)
    expect(link.getAttribute('href')).toBe('#live-token')
    link.click(); await settle(); expect(f.document.activeElement).toBe(f.get('live-token')); expect(f.calls).toEqual([])
    f.get('live-connect').focus(); await f.connect()
    expect(f.document.activeElement).toBe(f.get('live-connect')); expect(f.calls).toEqual([])
  })
  it.each(['workflow', 'tests', 'publish', 'settings'])('skip link returns from %s to the actual graph without runtime authority', async page => {
    const f = await fixture(); await f.connect(); await f.click('tab-' + page)
    const link = f.document.querySelector<HTMLAnchorElement>('.skip-link')!
    expect(link.getAttribute('href')).toBe('#graph'); link.click(); await settle()
    expect(f.get('panel-workflow').hidden).toBe(false); expect(f.get('tab-workflow').getAttribute('aria-selected')).toBe('true')
    expect(f.document.activeElement).toBe(f.get('graph')); expect(f.calls).toEqual([])
    f.get('tab-workflow').focus(); f.get('live-readiness').textContent = 'Runtime: ready. Changed fixture'; await settle()
    expect(f.document.activeElement).toBe(f.get('tab-workflow'))
  })
  it('synchronizes friendly test edits locally, preserving input, entry and additional assertions', async () => {
    const f = await fixture(); await f.connect()
    f.get<HTMLButtonElement>('test-create').disabled = false; await settle()
    const select = f.get<HTMLSelectElement>('friendly-test-outcome')
    select.value = 'completed'; select.dispatchEvent(new f.dom.window.Event('change', { bubbles: true })); await settle()
    expect(JSON.parse(f.editor.value)).toEqual({ title: 'Approval example', input: { message: 'Synthetic example' }, expectations: [{ kind: 'status', value: 'completed' }, { kind: 'node-visited', nodeId: 'review' }] })
    const saved = { title: 'Saved API case', input: false, triggerMode: 'api', expectations: [{ kind: 'status', value: 'waiting' }] }
    f.editor.value = JSON.stringify(saved); f.get('test-review').textContent = JSON.stringify({ definition: saved }); await settle()
    expect(f.get<HTMLInputElement>('friendly-test-name').value).toBe('Saved API case')
    expect(select.value).toBe('waiting')
    select.value = 'failed'; select.dispatchEvent(new f.dom.window.Event('change', { bubbles: true })); await settle()
    expect(JSON.parse(f.editor.value)).toEqual({ ...saved, expectations: [{ kind: 'status', value: 'failed' }] })
    expect(f.calls).toEqual([])
  })
  it('shows a waiting outcome as unfinished and returns node selection to Step details', async () => {
    const f = await fixture(); await f.connect()
    f.get('live-status').textContent = 'Run synthetic · waiting'; await settle()
    expect(f.document.querySelector('.status-label')?.textContent).toBe('Waiting for your decision')
    f.get('detail-title').textContent = 'Review request'; await settle()
    expect(f.get('tab-step').getAttribute('aria-selected')).toBe('true')
    expect(f.calls).toEqual([])
  })
  it.each(['tests', 'publish', 'settings'])('reveals original continuation controls from %s without executing or approving', async page => {
    const f = await fixture(); await f.connect(); await f.click('tab-history'); await f.click('tab-' + page)
    const original = f.get<HTMLButtonElement>('live-continue')
    original.disabled = false; f.get('live-status').textContent = 'Run synthetic · paused'; await settle()
    const navigation = [...f.document.querySelectorAll<HTMLButtonElement>('.run-guidance button')].find(button => button.textContent?.includes('Review continuation options'))!
    expect(navigation).toBeDefined(); navigation.click(); await settle()
    expect(f.get('tab-results').getAttribute('aria-selected')).toBe('true')
    expect(f.get('panel-workflow').hidden).toBe(false)
    expect(f.get('run-debug').closest('details')?.open).toBe(true)
    expect(f.get('live-continue')).toBe(original); expect(f.document.querySelectorAll('#live-continue')).toHaveLength(1)
    expect(f.document.activeElement).toBe(original); expect(f.calls).toEqual([])
    expect(f.get<HTMLInputElement>('live-authorize').checked).toBe(false)
    original.click(); expect(f.calls).toEqual(['live-continue'])
  })
  it('does not enable or focus disabled Continue when showing continuation options', async () => {
    const f = await fixture(); await f.connect()
    f.get('live-status').textContent = 'Run synthetic · paused'; await settle()
    f.document.querySelector<HTMLButtonElement>('.run-guidance button')!.click(); await settle()
    expect(f.get<HTMLButtonElement>('live-continue').disabled).toBe(true)
    expect(f.document.activeElement).toBe(f.get('run-results')); expect(f.calls).toEqual([])
  })
  it.each([
    ['completed', 'This run has finished', 'Private values load only when you ask'],
    ['waiting', 'waiting for a decision', 'opening it does not approve anything'],
    ['paused', 'This run is paused', 'paid services'],
    ['failed', 'needs attention', 'Nothing is retried automatically'],
    ['cancelled', 'This run has stopped', 'does not undo'],
    ['executing', 'final outcome is not confirmed', 'refreshing never resumes'],
    ['submitting', 'request is not confirmed', 'may already have been accepted'],
    ['loading', 'read is awaiting a reply', 'may already have an outcome'],
  ])('shows state-specific %s guidance without loading private data', async (status, headline, boundary) => {
    const f = await fixture(); await f.connect()
    f.get('live-status').textContent = `Run synthetic · ${status}`; await settle()
    expect(f.get('run-result-guidance').textContent).toContain(headline)
    expect(f.get('run-result-guidance').textContent).toContain(boundary)
    expect(f.get('live-private-result').textContent).toBe(''); expect(f.calls).toEqual([])
    f.get('live-status').textContent = 'No run selected.'; await settle()
    expect(f.get('run-result-guidance').textContent).toContain('No result is selected yet')
  })
  it('opens results for a finished run without loading values or submitting another run', async () => {
    const f = await fixture(); await f.connect(); await f.click('tab-history'); await f.click('tab-publish')
    f.get('live-status').textContent = 'Run synthetic · completed'; await settle()
    const navigate = [...f.document.querySelectorAll<HTMLButtonElement>('.run-guidance button')].find(button => button.textContent?.includes('View results'))!
    navigate.click(); await settle()
    expect(f.get('tab-results').getAttribute('aria-selected')).toBe('true')
    expect(f.document.activeElement).toBe(f.get('run-results')); expect(f.calls).toEqual([])
    expect(f.get('live-private-result').textContent).toBe('')
  })
  it.each(['executing', 'submitting', 'loading'])('keeps %s observational without changing retained identities, warnings or control authority', async status => {
    const f = await fixture(); await f.connect()
    const ids = ['live-run', 'live-review', 'live-step', 'live-continue', 'live-cancel']
    const controls = ids.map(id => f.get<HTMLButtonElement>(id))
    controls.forEach((control, index) => { control.disabled = index % 2 === 0 })
    const disabled = controls.map(control => control.disabled)
    f.get('live-message').textContent = 'An earlier action remains unconfirmed; inspect its retained request.'
    f.get<HTMLTextAreaElement>('live-input').value = 'PRIVATE_UNSENT_DRAFT'
    f.get<HTMLInputElement>('live-authorize').checked = true
    const retained = JSON.stringify({ runId: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222' })
    f.dom.window.sessionStorage.setItem('retained-request-fixture', retained)
    const node = f.get('detail-title').textContent
    f.get('live-status').textContent = `Run synthetic · ${status}`; await settle()
    expect(f.document.querySelector('.run-guidance .status-label')?.textContent).not.toBe('Working')
    expect(f.get('run-result-guidance').textContent).not.toContain('The run is still in progress')
    expect(ids.map(id => f.get(id))).toEqual(controls)
    expect(controls.map(control => control.disabled)).toEqual(disabled)
    expect(f.get('live-status').textContent).toBe(`Run synthetic · ${status}`)
    expect(f.get('live-message').textContent).toContain('earlier action remains unconfirmed')
    expect(f.get<HTMLTextAreaElement>('live-input').value).toBe('PRIVATE_UNSENT_DRAFT')
    expect(f.get<HTMLInputElement>('live-authorize').checked).toBe(true)
    expect(f.get('detail-title').textContent).toBe(node)
    expect(f.dom.window.sessionStorage.getItem('retained-request-fixture')).toBe(retained)
    expect(f.calls).toEqual([])
  })
  it.each(['tests', 'publish', 'settings'])('opens and focuses Approvals from %s even when Past runs was selected', async page => {
    const f = await fixture(); await f.connect(); await f.click('tab-history'); await f.click('tab-' + page)
    f.get('live-status').textContent = 'Run synthetic · waiting'; f.get('live-approval').hidden = false; await settle()
    f.document.querySelector<HTMLButtonElement>('.run-guidance button')!.click(); await settle()
    expect(f.get('panel-workflow').hidden).toBe(true)
    expect(f.get('tab-approvals').getAttribute('aria-selected')).toBe('true')
    expect(f.get('panel-approvals').hidden).toBe(false)
    expect(f.get('live-approval').closest('[hidden]')).toBeNull()
    expect(f.document.activeElement).toBe(f.get('approval-overview'))
    expect(f.calls).toEqual([])
    f.get('tab-approvals').focus(); f.get('live-readiness').textContent = 'Runtime: ready. Updated'; await settle()
    expect(f.document.activeElement).toBe(f.get('tab-approvals'))
  })
  it('returns from Traces to Approvals on each explicit guidance click without submitting an approval', async () => {
    const f = await fixture(); await f.connect(); f.get('live-status').textContent = 'Run synthetic · waiting'; await settle()
    for (let i = 0; i < 2; i++) {
      await f.click('tab-traces')
      f.document.querySelector<HTMLButtonElement>('.run-guidance button')!.click(); await settle()
      expect(f.get('panel-approvals').hidden).toBe(false)
      expect(f.document.activeElement).toBe(f.get('approval-overview'))
    }
    expect(f.get<HTMLInputElement>('live-authorize').checked).toBe(false)
    expect(f.calls).toEqual([])
  })
  it.each(['tests', 'publish', 'settings'])('opens Try it from %s and focuses the visible input without replacing it', async page => {
    const f = await fixture(); await f.connect()
    const input = f.get<HTMLTextAreaElement>('live-input'), draft = '{"message":"Untouched local draft"}'
    input.value = draft; await f.click('tab-step'); await f.click('tab-' + page)
    f.document.querySelector<HTMLButtonElement>('.input-jump')!.click(); await settle()
    expect(f.get('panel-workflow').hidden).toBe(false)
    expect(f.get('tab-try').getAttribute('aria-selected')).toBe('true')
    expect(f.get('panel-try').hidden).toBe(false)
    expect(f.document.activeElement).toBe(input)
    expect(input.value).toBe(draft)
    expect(f.calls).toEqual([])
  })
  it('focuses a visible field instead of hidden JSON, an omitted field or a disabled null field', async () => {
    const f = await fixture(); await f.connect()
    const schema = { type: 'object', properties: { omitted: { type: 'string' }, fixed: { type: 'null' }, message: { type: 'string' } } }
    f.get<HTMLTextAreaElement>('live-input').value = JSON.stringify({ fixed: null, message: 'Retained field draft' })
    f.dom.window.eval(`(${liveInputControls.toString()})(${JSON.stringify(schema)}, (${schemaInputTools.toString()})())`)
    const input = [...f.get('input-fields').querySelectorAll<HTMLTextAreaElement>('textarea')].find(field => field.value === 'Retained field draft')!
    expect(input).toBeDefined()
    await f.click('tab-step'); await f.click('tab-publish')
    f.document.querySelector<HTMLButtonElement>('.input-jump')!.click(); await settle()
    expect(f.document.activeElement).toBe(input)
    expect(input.value).toBe('Retained field draft')
    expect(f.get('input-json').hidden).toBe(true)
    expect(f.calls).toEqual([])
  })
  it('focuses the named input region when no editable scalar is available', async () => {
    const f = await fixture(); await f.connect()
    f.get('input-json').hidden = true
    f.document.querySelector<HTMLButtonElement>('.input-jump')!.click(); await settle()
    expect(f.document.activeElement).toBe(f.get('run-input'))
    expect(f.get('run-input').getAttribute('aria-label')).toBe('Workflow input')
    expect(f.calls).toEqual([])
  })
  it.each([
    { type: 'object', properties: {} },
    { type: 'object', properties: { fixed: { type: 'null' } } },
  ])('does not focus JSON hidden inside a collapsed input disclosure for %j', async schema => {
    const f = await fixture(); await f.connect()
    f.get<HTMLTextAreaElement>('live-input').value = JSON.stringify('fixed' in schema.properties ? { fixed: null } : {})
    f.dom.window.eval(`(${liveInputControls.toString()})(${JSON.stringify(schema)}, (${schemaInputTools.toString()})())`)
    expect(f.get('input-json').hidden).toBe(true)
    expect(f.get('input-fields').querySelector('details')?.open).toBe(false)
    f.document.querySelector<HTMLButtonElement>('.input-jump')!.click(); await settle()
    expect(f.document.activeElement).toBe(f.get('run-input'))
    expect(f.calls).toEqual([])
  })
  it('keeps detailed graph/input help collapsed and paid/external-effect warnings visible without execution', async () => {
    const f = await fixture(); await f.connect()
    const graphHelp = f.document.querySelector<HTMLDetailsElement>('.graph-help details')!, inputHelp = f.document.querySelector<HTMLDetailsElement>('.input-help')!
    expect(graphHelp.open).toBe(false); expect(inputHelp.open).toBe(false)
    expect(graphHelp.closest('[hidden]')).toBeNull()
    expect(inputHelp.closest('[hidden]')).toBeNull()
    const warning = f.document.querySelector('.run-safety')!
    expect(warning.closest('details, [hidden]')).toBeNull()
    graphHelp.open = true; inputHelp.open = true; await settle()
    expect(f.document.querySelectorAll('#live-run')).toHaveLength(1)
    expect(f.calls).toEqual([])
  })
  it.each([360, 759, 1280])('lays out the real approval graph left to right at viewport width %s without executing', async width => {
    const f = await fixture(); await f.connect()
    Object.defineProperty(f.dom.window, 'innerWidth', { value: width })
    f.dom.window.eval(`(${previewViewer.toString()})(${JSON.stringify(createPreview(approval))})`)
    await settle()
    const nodes = ['start', 'review', 'result'].map(id => f.document.querySelector(`[data-node="${id}"]`)!)
    expect(nodes.map(node => node.getAttribute('transform'))).toEqual(['translate(30 50)', 'translate(370 50)', 'translate(710 50)'])
    const edges = [...f.document.querySelectorAll('#graph [data-edge]')]
    expect(edges.map(edge => edge.getAttribute('d'))).toEqual(['M 590 98 H 650 V 98 H 710', 'M 250 98 H 310 V 98 H 370'])
    const graph = f.get('graph'), fitted = graph.getAttribute('viewBox')
    await f.click('zoom-in')
    expect(graph.getAttribute('viewBox')).not.toBe(fitted)
    await f.click('fit')
    expect(graph.getAttribute('viewBox')).toBe(fitted)
    nodes[1]!.dispatchEvent(new f.dom.window.Event('click', { bubbles: true })); await settle()
    expect(f.document.querySelector('.step-explanation')?.textContent).toContain('waits for a person')
    expect(f.document.querySelector('#detail-body')?.closest('details')?.open).toBe(false)
    expect(f.calls).toEqual([])
  })
})

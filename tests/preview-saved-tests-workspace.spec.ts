import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { renderLivePage } from '../src/preview/live-page.ts'
import { workspaceScript } from '../src/preview/workspace.generated.ts'

// Actual offline React/Animate UI bundle against original controls. Real browser
// geometry and the runtime journal are qualified separately, not inferred here.
const windows: JSDOM[] = []
afterEach(() => { for (const window of windows.splice(0)) window.window.close() })
async function fixture() {
  const dom = new JSDOM(renderLivePage('synthetic-workspace', 'jevable/v1alpha1').html,
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://127.0.0.1:3000/' }); windows.push(dom)
  Object.assign(dom.window, { TextEncoder, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
  const get = <T extends HTMLElement = HTMLElement>(id: string) => dom.window.document.getElementById(id) as T
  const ids = ['test-copy-input', 'test-create', 'test-edit', 'test-accept', 'test-run', 'test-result', 'test-result-clear',
    'test-generate', 'test-refresh', 'test-archive', 'test-unarchive', 'test-history-load', 'test-coverage-load']
  const original = new Map(ids.map(id => [id, get(id)])), calls: string[] = []
  for (const id of ids) get(id).addEventListener('click', () => calls.push(id))
  const fetch = vi.fn(); Object.assign(dom.window, { fetch })
  get<HTMLTextAreaElement>('test-editor').value = JSON.stringify({ title: 'Synthetic case', input: false,
    expectations: [{ kind: 'status', value: 'waiting' }, { kind: 'node-visited', nodeId: 'review' }] })
  get<HTMLButtonElement>('test-create').disabled = false
  dom.window.eval(workspaceScript)
  await vi.waitFor(() => expect(get('tab-tests')).not.toBeNull())
  get('live-login').hidden = true; get('live-session').hidden = false; get('live-tests').hidden = false
  await vi.waitFor(() => expect(dom.window.document.querySelector('.connection-state')?.textContent).toBe('Session open'))
  get('tab-tests').click(); await vi.waitFor(() => expect(get('panel-tests').hidden).toBe(false))
  const review = async (value: any) => {
    get('test-review').textContent = value === undefined ? '' : JSON.stringify(value)
    await vi.waitFor(() => expect(dom.window.document.querySelector('.saved-test-guide')?.textContent)
      .toContain(value ? value.definition.title : 'Save a draft'))
  }
  return { dom, get, original, calls, fetch, review }
}
const saved = (status = 'draft', archived = false) => ({ id: 'synthetic-case', generation: status === 'draft' ? 1 : 2, status, archived,
  definition: { title: 'Saved approval check', input: false, expectations: [{ kind: 'status', value: 'waiting' }] } })
describe('saved tests form one presentation-only save/review/result path', () => {
  it.each(['draft', 'accepted'])('labels the latest saved %s accurately while historical feedback remains a separate live region', async status => {
    const f = await fixture(), latest = { ...saved(status), generation: 4 }
    await f.review(latest)
    const history = { ...saved('draft'), generation: 1 }
    f.get('test-history-detail').textContent = JSON.stringify(history)
    await vi.waitFor(() => expect(f.get('test-history-reading').textContent).toContain('Saved version 1'))
    expect(f.get('test-history-reading').textContent).toContain('latest saved version above are unchanged')
    expect(f.get('test-history-reading').textContent).not.toContain('current accepted version')
    const region = f.get('test-history-status')
    expect(region.getAttribute('role')).toBe('status'); expect(region.getAttribute('aria-live')).toBe('polite')
    expect(region.closest('#live-tests')).not.toBeNull(); expect(f.dom.window.document.querySelectorAll('#test-history-status')).toHaveLength(1)
    expect(f.get('test-review').textContent).toBe(JSON.stringify(latest))
    expect(f.get<HTMLInputElement>('test-authorize').checked).toBe(false)
    expect(f.calls).toEqual([]); expect(f.fetch).not.toHaveBeenCalled()
  })
  it('reads historical input and outcome without JSON while keeping the latest review, controls and consent unchanged', async () => {
    const f = await fixture(), latest = { ...saved('accepted'), generation: 4 }
    await f.review(latest)
    f.get<HTMLInputElement>('test-authorize').checked = true
    const focus = f.get('friendly-test-name'); focus.focus()
    const history = { ...saved('accepted'), generation: 2, actor: 'PRIVATE_REVIEW_ACTOR',
      definition: { ...saved().definition, title: 'Earlier successful test', input: 'EARLIER_PRIVATE_INPUT',
        expectations: [{ kind: 'status', value: 'completed' }] } }
    f.get('test-history-detail').textContent = JSON.stringify(history)
    await vi.waitFor(() => expect(f.get('test-history-reading')?.textContent).toContain('Saved version 2'))
    expect(f.get('test-history-reading').textContent).toContain('Earlier successful test')
    expect(f.get('test-history-reading').textContent).toContain('finish successfully')
    expect(f.get('test-history-reading').textContent).toContain('EARLIER_PRIVATE_INPUT')
    expect(f.get('test-history-reading').textContent).not.toContain('PRIVATE_REVIEW_ACTOR')
    expect(f.get('test-history-detail').closest('details')?.open).toBe(false)
    expect(f.get('test-review').textContent).toBe(JSON.stringify(latest))
    expect(f.get<HTMLInputElement>('test-authorize').checked).toBe(true)
    expect(f.dom.window.document.activeElement).toBe(focus)
    expect(f.calls).toEqual([]); expect(f.fetch).not.toHaveBeenCalled()
    f.get('test-history-detail').textContent = ''
    await vi.waitFor(() => expect(f.get('test-history-reading').textContent).not.toContain('EARLIER_PRIVATE_INPUT'))
    expect(f.get('test-history-reading').textContent).not.toContain('Earlier successful test')
  })
  it.each([null, false, 0, ''])('keeps historical input %j distinct from unavailable data and never changes its exact record', async input => {
    const f = await fixture(), history = { ...saved('accepted'), definition: { ...saved().definition, input } }
    const exact = JSON.stringify(history); f.get('test-history-detail').textContent = exact
    await vi.waitFor(() => expect(f.get('test-history-reading')?.querySelector('.recorded-value')).toBeTruthy())
    expect(f.get('test-history-detail').textContent).toBe(exact)
    const text = f.get('test-history-reading').textContent
    expect(text).toContain(input === null ? 'No value (null)' : input === false ? 'No' : input === 0 ? '0' : 'Empty text')
    expect(f.calls).toEqual([])
  })
  it.each(['not-json', JSON.stringify({ generation: 2, definition: { title: 'UNTRUSTED_PARTIAL', input: 1 } }),
    JSON.stringify({ ...saved('accepted'), definition: { ...saved().definition, triggerMode: 'webhook' } })])('refuses an unavailable historical reading without inventing outcome or exposing partial fields (%s)', async text => {
    const f = await fixture(); f.get('test-history-detail').textContent = text
    await vi.waitFor(() => expect(f.get('test-history-reading')?.textContent).toContain('could not be displayed'))
    expect(f.get('test-history-reading').textContent).not.toContain('UNTRUSTED_PARTIAL')
    expect(f.get('test-history-reading').textContent).not.toContain('finish successfully')
    expect(f.get('test-history-detail').textContent).toBe(text)
    expect(f.calls).toEqual([]); expect(f.fetch).not.toHaveBeenCalled()
  })
  it('keeps every original action mounted exactly once, with no requests or synthesized clicks', async () => {
    const f = await fixture()
    for (const [id, element] of f.original) {
      expect(f.dom.window.document.querySelectorAll('#' + id)).toHaveLength(1)
      expect(f.get(id)).toBe(element); expect(element.closest('#panel-tests')).not.toBeNull()
    }
    expect(f.calls).toEqual([]); expect(f.fetch).not.toHaveBeenCalled()
    expect(f.get('test-create').closest('#test-compose-panel')).not.toBeNull()
    expect(f.get('test-accept').closest('#test-review-panel')).not.toBeNull()
    expect(f.get('test-run').closest('#test-review-panel')).not.toBeNull()
  })
  it('places results before optional coverage and keeps secondary tools collapsed', async () => {
    const f = await fixture(), results = f.get('test-outcome-panel'), coverage = f.get('live-test-coverage')
    expect(results).not.toBeNull()
    expect(results.compareDocumentPosition(coverage) & f.dom.window.Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(coverage.closest('details')?.open).toBe(false)
    for (const id of ['test-generate', 'test-archive', 'test-unarchive', 'test-history-load'])
      expect(f.get(id).closest('details')?.open).toBe(false)
    expect(f.calls).toEqual([])
  })
  it('shows an honest empty assessment with explicit run or inspection, not a fabricated success', async () => {
    const f = await fixture()
    expect(f.get('test-result-guidance').textContent).toContain('No assessment loaded')
    expect(f.get('test-result-guidance').textContent).toContain('does not execute')
    f.get('test-result-summary').textContent = "Test expectations matched. Waiting for a person's approval."
    await vi.waitFor(() => expect(f.get('test-result-guidance').textContent).toBe(''))
    expect(f.get('test-result-summary').textContent).toContain('Waiting')
    expect(f.calls).toEqual([]); expect(f.fetch).not.toHaveBeenCalled()
  })
  it('reads the saved input beside review authority and retains collapsed exact JSON', async () => {
    const f = await fixture(); await f.review(saved())
    expect(f.dom.window.document.querySelector('#test-review-panel .recorded-value')?.textContent).toBe('No')
    expect(JSON.parse(f.get('test-review').textContent!).definition.input).toBe(false)
    expect(f.dom.window.document.querySelector('#test-review-panel .saved-test-guide')?.textContent).toContain("wait for a person's approval")
    expect(f.get('test-review').closest('details')?.open).toBe(false)
    expect(f.get<HTMLInputElement>('test-authorize').checked).toBe(false)
    expect(f.calls).toEqual([])
  })
  it('distinguishes draft, accepted and archived definitions without accepting or executing', async () => {
    const f = await fixture(); await f.review(saved())
    expect(f.dom.window.document.querySelector('.saved-test-guide')?.textContent).toContain('Review this saved input')
    await f.review(saved('accepted'))
    await vi.waitFor(() => expect(f.dom.window.document.querySelector('.saved-test-guide')?.textContent).toContain('Accepted version 2'))
    await f.review(saved('accepted', true))
    await vi.waitFor(() => expect(f.dom.window.document.querySelector('.saved-test-guide')?.textContent).toContain('Archived'))
    expect(f.calls).toEqual([]); expect(f.fetch).not.toHaveBeenCalled()
  })
  it('keeps the saved review separate from an unsaved editor change and preserves extra assertions', async () => {
    const f = await fixture(); await f.review(saved())
    const select = f.get<HTMLSelectElement>('friendly-test-outcome')
    select.value = 'completed'; select.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(JSON.parse(f.get<HTMLTextAreaElement>('test-editor').value).expectations[0].value).toBe('completed'))
    expect(JSON.parse(f.get<HTMLTextAreaElement>('test-editor').value).expectations[1]).toEqual({ kind: 'node-visited', nodeId: 'review' })
    expect(f.dom.window.document.querySelector('.saved-test-guide')?.textContent).toContain("wait for a person's approval")
    expect(f.calls).toEqual([])
  })
  it('adds and removes an exact final-text check through the simple form without saving or running', async () => {
    const f = await fixture(); await f.review(saved())
    const editor = f.get<HTMLTextAreaElement>('test-editor'), toggle = f.get<HTMLInputElement>('friendly-test-check-output')
    expect(toggle.checked).toBe(false)
    toggle.click()
    await vi.waitFor(() => expect(JSON.parse(editor.value).expectations).toEqual([
      { kind: 'status', value: 'waiting' }, { kind: 'output-equals', value: '' }, { kind: 'node-visited', nodeId: 'review' }]))
    const text = f.get<HTMLTextAreaElement>('friendly-test-output')
    Object.getOwnPropertyDescriptor(f.dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(text, 'approved')
    text.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }))
    await vi.waitFor(() => expect(JSON.parse(editor.value).expectations[1]).toEqual({ kind: 'output-equals', value: 'approved' }))
    expect(f.get('test-review').textContent).toBe(JSON.stringify(saved()))
    expect(f.get<HTMLInputElement>('test-authorize').checked).toBe(false)
    toggle.click()
    await vi.waitFor(() => expect(JSON.parse(editor.value).expectations).toEqual([
      { kind: 'status', value: 'waiting' }, { kind: 'node-visited', nodeId: 'review' }]))
    expect(f.calls).toEqual([]); expect(f.fetch).not.toHaveBeenCalled()
  })
  it('shows a structured expected result without converting it to text on load', async () => {
    const f = await fixture(), editor = f.get<HTMLTextAreaElement>('test-editor')
    const definition = { title: 'Structured expectation', input: 0, expectations: [
      { kind: 'status', value: 'completed' }, { kind: 'output-equals', value: { count: 0, ok: false } }] }
    editor.value = JSON.stringify(definition); editor.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }))
    await vi.waitFor(() => expect(f.get<HTMLInputElement>('friendly-test-check-output').checked).toBe(true))
    expect(f.get('test-composer-host').textContent).toContain('Current structured result')
    expect(f.get('test-composer-host').textContent).toContain('No')
    expect(JSON.parse(editor.value)).toEqual(definition)
    expect(f.calls).toEqual([]); expect(f.fetch).not.toHaveBeenCalled()
  })
  it('does not simplify malformed or multiple output checks into an editable text field', async () => {
    const f = await fixture(), editor = f.get<HTMLTextAreaElement>('test-editor')
    const definition = { title: 'Technical expectation', input: null, expectations: [
      { kind: 'status', value: 'completed' }, { kind: 'output-equals', value: 'first', privateExtra: 'keep' },
      { kind: 'output-equals', value: 'second' }] }
    editor.value = JSON.stringify(definition); editor.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }))
    await vi.waitFor(() => expect(f.get('test-composer-host').textContent).toContain('need technical review'))
    expect(f.dom.window.document.getElementById('friendly-test-check-output')).toBeNull()
    expect(JSON.parse(editor.value)).toEqual(definition)
    expect(f.calls).toEqual([]); expect(f.fetch).not.toHaveBeenCalled()
  })
  it('clears the reading view when the owning controller discards private review or assessment text', async () => {
    const f = await fixture(); const item = saved(); item.definition.input = false
    await f.review(item); expect(f.get('test-saved-review-host').textContent).toContain('Saved approval check')
    await f.review(undefined)
    expect(f.get('test-saved-review-host').textContent).not.toContain('Saved approval check')
    expect(f.get('test-saved-review-host').textContent).not.toContain('False')
    f.get('test-result-summary').textContent = 'Recorded match'
    await vi.waitFor(() => expect(f.get('test-result-guidance').textContent).toBe(''))
    f.get('test-result-summary').textContent = ''
    await vi.waitFor(() => expect(f.get('test-result-guidance').textContent).toContain('No assessment loaded'))
    expect(f.calls).toEqual([])
  })
  it('updates presentation without stealing focus or changing consent', async () => {
    const f = await fixture(), focus = f.get('friendly-test-name'); focus.focus()
    await f.review(saved('accepted'))
    expect(f.dom.window.document.activeElement).toBe(focus)
    expect(f.get<HTMLInputElement>('test-authorize').checked).toBe(false)
    expect(f.calls).toEqual([]); expect(f.fetch).not.toHaveBeenCalled()
  })
  it('makes the saved entry and additional assertions visible without changing their exact definition', async () => {
    const f = await fixture(), item = { ...saved(), definition: { ...saved().definition, triggerMode: 'api',
      expectations: [{ kind: 'status', value: 'waiting' }, { kind: 'node-visited', nodeId: 'review' }] } }
    await f.review(item)
    expect(f.get('test-saved-review-host').textContent).toContain('API request')
    expect(f.get('test-saved-review-host').textContent).toContain('Also check')
    expect(f.get('test-saved-review-host').textContent).toContain('Step “review” must have a saved result.')
    expect(f.get('test-saved-review-host').textContent).not.toContain('node-visited')
    expect(f.get('test-review').textContent).toBe(JSON.stringify(item))
    expect(f.calls).toEqual([]); expect(f.fetch).not.toHaveBeenCalled()
  })
  it('labels a shortened saved-input reading view while preserving the complete exact record', async () => {
    const f = await fixture(), input = 'SYNTHETIC_LONG_INPUT_'.repeat(100)
    const item = { ...saved(), definition: { ...saved().definition, input } }
    await f.review(item)
    expect(f.get('test-saved-review-host').textContent).toContain('reading view is shortened')
    expect(f.get('test-review').textContent).toBe(JSON.stringify(item))
    expect(f.get('test-saved-review-host').textContent).not.toContain(input)
    expect(f.calls).toEqual([])
  })
  it('summarizes every extra assertion and exact loop scope without mutating the saved definition, consent or controls', async () => {
    const f = await fixture(), item = { ...saved(), definition: { ...saved().definition,
      expectations: [{ kind: 'status', value: 'completed' }, { kind: 'output-equals', value: { count: 0, enabled: false, empty: '', none: null } },
        { kind: 'node-visited', nodeId: 'review' }, { kind: 'node-output-equals', nodeId: 'score', value: 0.625, scope: { loop: 'repeat', index: 2 } },
        { kind: 'node-port-equals', nodeId: 'route', value: 'true', scope: { loop: 'repeat', index: 0 } }] } }
    const exact = JSON.stringify(item); f.get<HTMLInputElement>('test-authorize').checked = true
    const focus = f.get('friendly-test-name'); focus.focus(); await f.review(item)
    const host = f.get('test-saved-review-host'), text = host.textContent
    expect(host.querySelectorAll('.saved-test-checks li')).toHaveLength(4)
    expect(text).toContain('The final result must exactly match:'); expect(text).toContain('0'); expect(text).toContain('No')
    expect(text).toContain('Empty text'); expect(text).toContain('No value (null)')
    expect(text).toContain('Step “review” must have a saved result.')
    expect(text).toContain('The saved result of step “score” must exactly match:'); expect(text).toContain('0.625')
    expect(text).toContain('In round 3 of loop “repeat”.'); expect(text).toContain('In round 1 of loop “repeat”.')
    expect(text).toContain('Step “route” must choose branch “true”.'); expect(text).toContain('not whether the following step finished')
    expect(text).not.toContain('node-port-equals'); expect(text).not.toContain('node-output-equals')
    expect(f.get('test-review').textContent).toBe(exact); expect(f.get<HTMLInputElement>('test-authorize').checked).toBe(true)
    expect(f.dom.window.document.activeElement).toBe(focus); expect(f.calls).toEqual([]); expect(f.fetch).not.toHaveBeenCalled()
  })
  it.each(['invalid-node-value', 'loop-limit', 'loop-timeout', 'approval-rejected', 'approval-expired', 'ai-budget'])('keeps failure %s exact while describing its expected outcome', async value => {
    const f = await fixture(), item = { ...saved(), definition: { ...saved().definition,
      expectations: [{ kind: 'status', value: 'failed' }, { kind: 'failure-code', value }] } }
    await f.review(item)
    expect(f.get('test-saved-review-host').querySelector('.saved-check-code')?.textContent).toBe(value)
    expect(f.get('test-saved-review-host').textContent).not.toContain('failure-code')
    expect(f.get('test-review').textContent).toBe(JSON.stringify(item)); expect(f.calls).toEqual([]); expect(f.fetch).not.toHaveBeenCalled()
  })
  it.each([{ kind: 'future-check', value: 'PRESERVE_UNKNOWN' }, { kind: 'node-visited', nodeId: 'review', privateExtra: 'PRESERVE_EXTRA' },
    { kind: 'node-visited', nodeId: 'review', scope: { loop: 'repeat', index: -1 } },
    { kind: 'output-equals' }, null])('does not silently reinterpret an unavailable check (%j)', async check => {
    const f = await fixture(), item = { ...saved(), definition: { ...saved().definition,
      expectations: [{ kind: 'status', value: 'completed' }, check] } }
    await f.review(item)
    expect(f.get('test-saved-review-host').textContent).toContain('This check needs technical review.')
    expect(f.get('test-saved-review-host').textContent).not.toContain('must have a saved result')
    expect(f.get('test-review').textContent).toBe(JSON.stringify(item)); expect(f.calls).toEqual([])
  })
  it('uses the same plain-language checks for historical versions and clears them with the original private display', async () => {
    const f = await fixture(), item = { ...saved('accepted'), definition: { ...saved().definition,
      expectations: [{ kind: 'status', value: 'completed' }, { kind: 'output-equals', value: 'HISTORICAL_EXPECTATION' },
        { kind: 'node-port-equals', nodeId: 'route', value: 'approved' }] } }
    f.get('test-history-detail').textContent = JSON.stringify(item)
    await vi.waitFor(() => expect(f.get('test-history-reading').textContent).toContain('The final result must exactly match:'))
    expect(f.get('test-history-reading').textContent).toContain('HISTORICAL_EXPECTATION')
    expect(f.get('test-history-reading').textContent).toContain('Step “route” must choose branch “approved”.')
    expect(f.get('test-history-detail').textContent).toBe(JSON.stringify(item))
    f.get('test-history-detail').textContent = ''
    await vi.waitFor(() => expect(f.get('test-history-reading').textContent).not.toContain('HISTORICAL_EXPECTATION'))
    expect(f.calls).toEqual([]); expect(f.fetch).not.toHaveBeenCalled()
  })
  it('renders expected HTML-looking text only as text and labels a shortened expected value', async () => {
    const f = await fixture(), value = '<img src=x onerror="alert(1)">' + 'EXPECTED_LONG_TEXT'.repeat(100)
    const item = { ...saved(), definition: { ...saved().definition,
      expectations: [{ kind: 'status', value: 'completed' }, { kind: 'output-equals', value }] } }
    await f.review(item)
    expect(f.get('test-saved-review-host').querySelector('img')).toBeNull()
    expect(f.get('test-saved-review-host').textContent).toContain('<img src=x')
    expect(f.get('test-saved-review-host').textContent).toContain('reading view is shortened')
    expect(f.get('test-review').textContent).toBe(JSON.stringify(item)); expect(f.fetch).not.toHaveBeenCalled()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { workspaceScript } from '../src/preview/workspace.generated.ts'
import { renderLivePage } from '../src/preview/live-page.ts'

const windows: JSDOM[] = []
afterEach(() => { for (const dom of windows.splice(0)) dom.window.close() })
const id = '00000000-0000-4000-8000-000000000001', revision = 'a'.repeat(64)
async function fixture() {
  const dom = new JSDOM(renderLivePage(id, 'jevable/v1alpha1').html,
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://127.0.0.1:3000/' }); windows.push(dom)
  Object.assign(dom.window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) })
  const get = <T extends HTMLElement = HTMLElement>(name: string) => dom.window.document.getElementById(name) as T
  const clicks = vi.fn(), fetch = vi.fn(); dom.window.fetch = fetch
  for (const name of ['live-run', 'live-review', 'live-private', 'live-authorize', 'node-private-load']) get(name).addEventListener('click', clicks)
  const originals = ['live-private-result', 'live-review-data', 'node-private-input', 'node-private-output', 'detail-execution-body'].map(get)
  dom.window.eval(workspaceScript)
  await vi.waitFor(() => expect(get('workspace-root').querySelector('.workspace-footer')).not.toBeNull())
  const privateRun = (value: unknown, status = 'completed', hasOutput = true) => {
    get('live-result').textContent = JSON.stringify({ id, revision, status })
    get('live-private-result').textContent = JSON.stringify({ schemaVersion: 1, privateInspection: true,
      run: { id, revision, yaml: 'PRIVATE_SOURCE', input: { message: 'PRIVATE_INPUT' }, state: { status, ...(hasOutput ? { output: value } : {}) } } })
  }
  return { dom, get, privateRun, clicks, fetch, originals }
}
describe('readable explicitly loaded values, with exact records retained', () => {
  it.each(['Stopped · no rollback', 'Intent · outcome unsettled'])('does not promise a future result for %s', async status => {
    const f = await fixture(), input = JSON.stringify('PRIVATE_RETAINED_INPUT')
    const output = 'Unsettled: no output is recorded. This does not prove provider activity, termination or rollback.'
    f.get('detail-kind').textContent = 'Jev · judgment'
    f.get('detail-execution-body').textContent = JSON.stringify({ status, recordedResults: 0 })
    f.get('node-private-input').textContent = input; f.get('node-private-output').textContent = output
    await vi.waitFor(() => expect(f.get('node-private-summary').textContent).toContain('What came out'))
    const summary = f.get('node-private-summary')
    expect(summary.textContent).toContain('No output is recorded for this step.')
    expect(summary.textContent).not.toContain('No result yet')
    expect(summary.querySelector<HTMLDetailsElement>('details')?.open).toBe(false)
    expect(f.get('node-private-input').textContent).toBe(input); expect(f.get('node-private-output').textContent).toBe(output)
    expect(f.clicks).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.dom.window.sessionStorage.length).toBe(0)
  })
  it('shows the approval request first instead of its schema and action metadata in step values', async () => {
    const f = await fixture()
    f.get('detail-kind').textContent = 'Human Approval'
    const prepared = { title: 'Review a request', input: 'Please check this request', actions: ['approve', 'reject'],
      inputSchema: { type: 'string' }, metadata: 'KEEP_EXACT_METADATA' }
    f.get('node-private-input').textContent = JSON.stringify(prepared)
    f.get('node-private-output').textContent = 'Unsettled: no output is recorded. This does not prove provider activity, termination or rollback.'
    await vi.waitFor(() => expect(f.get('node-private-summary').textContent).toContain('What was reviewed'))
    const summary = f.get('node-private-summary')
    expect(summary.textContent).toContain('Please check this request')
    expect(summary.textContent).toContain('No output is recorded for this step.')
    const details = summary.querySelector<HTMLDetailsElement>('details')!
    expect(details.open).toBe(false); expect(details.textContent).toContain('KEEP_EXACT_METADATA')
    expect(f.get('node-private-input').textContent).toBe(JSON.stringify(prepared))
    expect(f.clicks).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
  })
  it('does not reinterpret non-approval objects or saved strings that resemble availability messages', async () => {
    const f = await fixture()
    f.get('detail-kind').textContent = 'Output'
    f.get('node-private-input').textContent = JSON.stringify({ title: 'Keep full structure', input: 'Keep input', actions: ['approve'] })
    f.get('node-private-output').textContent = JSON.stringify('Unsettled: actual saved string')
    await vi.waitFor(() => expect(f.get('node-private-summary').textContent).toContain('Unsettled: actual saved string'))
    expect(f.get('node-private-summary').textContent).not.toContain('What was reviewed')
    expect(f.get('node-private-summary').textContent).toContain('Keep full structure')
  })
  it('places explicitly loaded node values before technical step settings, without changing their controls', async () => {
    const f = await fixture(), node = f.get('node-private'), inspector = f.get('step-inspector')
    // Step details uses force-mounted panels: ordering remains stable across tab changes.
    expect(node.compareDocumentPosition(inspector) & f.dom.window.Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(f.get('node-private-summary').compareDocumentPosition(f.get('node-private-message')) & f.dom.window.Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    const privacy = Array.from(node.querySelectorAll<HTMLDetailsElement>('details')).find(item => item.querySelector('summary')?.textContent === 'Privacy and record details')!
    expect(privacy.open).toBe(false); expect(privacy.textContent).toContain('never executes or reconstructs')
    expect(f.get('node-private-load').closest('#node-private')).toBe(node)
    expect(f.clicks).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
  })
  it('mounts empty summaries without commands, values or changing original controls', async () => {
    const f = await fixture()
    for (const name of ['live-private-summary', 'node-private-summary', 'live-review-summary', 'step-execution-summary']) expect(f.get(name).textContent).toBe('')
    expect(f.clicks).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
    expect(f.get<HTMLInputElement>('live-authorize').checked).toBe(false)
    for (const original of f.originals) { expect(f.get(original.id)).toBe(original); expect((original.closest('details') as HTMLDetailsElement).open).toBe(false) }
  })
  it('shows output first, with input and full private record initially collapsed', async () => {
    const f = await fixture(); f.privateRun({ draft: 'A recorded reply draft', sent: false })
    await vi.waitFor(() => expect(f.get('live-private-summary').textContent).toContain('A recorded reply draft'))
    expect(f.get('live-private-summary').textContent).toContain('No')
    expect(f.get('live-private-summary').textContent).not.toContain('PRIVATE_SOURCE')
    expect(f.get('live-private-summary').querySelector<HTMLDetailsElement>('details')?.open).toBe(false)
    expect(f.get('live-private-result').textContent).toContain('PRIVATE_SOURCE')
    expect(f.clicks).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
  })
  it.each([null, false, 0, '', [], {}])('distinguishes recorded %j from an absent final output', async value => {
    const f = await fixture(); f.privateRun(value)
    await vi.waitFor(() => expect(f.get('live-private-summary').textContent).toContain('Workflow output'))
    expect(f.get('live-private-summary').textContent).not.toContain('No final output')
    expect(f.get('live-private-summary').querySelector('.recorded-value')).not.toBeNull()
  })
  it('labels a waiting checkpoint without inventing an output or approving', async () => {
    const f = await fixture(); f.privateRun(undefined, 'waiting', false)
    await vi.waitFor(() => expect(f.get('live-private-summary').textContent).toContain('No final output is recorded'))
    expect(f.get<HTMLInputElement>('live-authorize').checked).toBe(false); expect(f.clicks).not.toHaveBeenCalled()
  })
  it('does not present private values as current after a status or run identity change', async () => {
    const f = await fixture(); f.privateRun('PRIVATE_OUTPUT')
    await vi.waitFor(() => expect(f.get('live-private-summary').textContent).toContain('PRIVATE_OUTPUT'))
    f.get('live-result').textContent = JSON.stringify({ id, revision, status: 'waiting' })
    await vi.waitFor(() => expect(f.get('live-private-summary').textContent).toContain('do not match the current status'))
    expect(f.get('live-private-summary').textContent).not.toContain('PRIVATE_OUTPUT')
    f.get('live-result').textContent = JSON.stringify({ id: 'other-run', revision, status: 'completed' })
    await vi.waitFor(() => expect(f.get('live-private-summary').textContent).not.toContain('PRIVATE_OUTPUT'))
  })
  it('shows typed Choice confidence and native Noul without manufacturing confidence', async () => {
    const f = await fixture()
    f.get('node-private-output').textContent = JSON.stringify({ team: { type: 'choice', choice: 'billing', confidence: 0.9,
      probabilities: { billing: 0.8, support: 0.2 } }, review: { type: 'noul', noul: 0.1 } })
    f.get('node-private-input').textContent = JSON.stringify('PRIVATE_NODE_INPUT')
    await vi.waitFor(() => expect(f.get('node-private-summary').textContent).toContain('Chosen outcomebilling'))
    const summary = f.get('node-private-summary')
    expect(summary.textContent).toContain('Confidence 90%'); expect(summary.textContent).toContain('Chance of yes10%')
    expect(summary.textContent).toContain('no separate confidence score')
    expect(summary.textContent).toContain('not a yes/no verdict or permission to continue')
    expect(summary.querySelector<HTMLDetailsElement>('.value-probabilities')?.open).toBe(false)
    expect(f.get('node-private-output').textContent).toContain('"noul":0.1')
    expect(f.clicks).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
  })
  it('clears friendly values when the owning controller clears its exact text', async () => {
    const f = await fixture(); f.privateRun('PRIVATE_OUTPUT'); f.get('node-private-output').textContent = JSON.stringify('PRIVATE_NODE_VALUE')
    await vi.waitFor(() => expect(f.get('node-private-summary').textContent).toContain('PRIVATE_NODE_VALUE'))
    f.get('live-private-result').textContent = ''; f.get('node-private-output').textContent = ''; f.get('node-private-input').textContent = ''
    await vi.waitFor(() => { expect(f.get('node-private-summary').textContent).toBe(''); expect(f.get('live-private-summary').textContent).toBe('') })
    expect(f.dom.window.sessionStorage.length).toBe(0)
  })
  it('reads a fractional native Score without rounding it into a category or changing exact values', async () => {
    const f = await fixture(), answer = { type: 'score', score: 1.6, confidence: 0.8,
      legend: { '0': 'Routine', '1': 'Soon', '2': 'Immediate' }, probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 } }
    const exact = JSON.stringify(answer); f.get('node-private-output').textContent = exact
    await vi.waitFor(() => expect(f.get('node-private-summary').textContent).toContain('Score1.6'))
    const summary = f.get('node-private-summary'), details = summary.querySelector<HTMLDetailsElement>('.value-probabilities')!
    expect(details.open).toBe(false); expect(details.textContent).toContain('Score meanings'); expect(details.textContent).toContain('Immediate')
    expect(summary.querySelector('.judgment-number')!.textContent).toBe('1.6')
    expect(summary.textContent).toContain('Confidence 80%'); expect(summary.textContent).toContain('not a selected category')
    expect(f.get('node-private-output').textContent).toBe(exact)
    details.open = true
    expect(f.clicks).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.dom.window.sessionStorage.length).toBe(0)
  })
  it('reads normalized Score and Noul in a reviewed request without authorizing it', async () => {
    const f = await fixture(), input = { urgency: { type: 'score', score: 0.75, confidence: 0.4,
      probabilities: [0.25, 0.75], explanation: 'Review the timing' }, review: { type: 'noul', probability: 0.5, confidence: 0.3 } }
    const exact = JSON.stringify({ status: 'ready', input: { title: 'Review these estimates', input } }); f.get('live-review-data').textContent = exact
    await vi.waitFor(() => expect(f.get('live-review-summary').textContent).toContain('Probability of yes50%'))
    const summary = f.get('live-review-summary')
    expect(summary.textContent).toContain('Score0.75'); expect(summary.textContent).toContain('Confidence 40%')
    expect(summary.textContent).toContain('Confidence 30%'); expect(summary.textContent).toContain('not a yes/no verdict')
    expect(summary.textContent).toContain('Review the timing'); expect(summary.querySelector<HTMLDetailsElement>('details')!.open).toBe(false)
    expect(f.get('live-review-data').textContent).toBe(exact); expect(f.get<HTMLInputElement>('live-authorize').checked).toBe(false)
    expect(f.clicks).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
  })
  it('presents a reviewed title/input while keeping exact review and authorization untouched', async () => {
    const f = await fixture()
    f.get('live-review-data').textContent = JSON.stringify({ status: 'ready', input: { title: 'Review this uncertain request',
      input: { team: { type: 'choice', choice: 'billing', confidence: 0.4, probabilities: { billing: 0.8, support: 0.2 } } } } })
    await vi.waitFor(() => expect(f.get('live-review-summary').textContent).toContain('Review this uncertain request'))
    expect(f.get('live-review-summary').textContent).toContain('Confidence 40%')
    expect(f.get('live-review-summary').textContent).toContain('Nothing is approved by opening this panel')
    expect(f.get<HTMLInputElement>('live-authorize').checked).toBe(false); expect(f.clicks).not.toHaveBeenCalled()
    expect((f.get('live-review-data').closest('details') as HTMLDetailsElement).open).toBe(false)
  })
  it('summarizes retained result counts without calling them provider attempts', async () => {
    const f = await fixture()
    f.get('detail-execution-body').textContent = JSON.stringify({ status: 'Recorded result', recordedResults: 2,
      latestRecords: [{ attemptId: 'EXACT_PRIVATE_ATTEMPT' }], timing: { recordedDurationMs: 123 } })
    await vi.waitFor(() => expect(f.get('step-execution-summary').textContent).toContain('2 recorded results'))
    expect(f.get('step-execution-summary').textContent).toContain('not a count of provider calls')
    expect(f.get('step-execution-summary').textContent).not.toContain('EXACT_PRIVATE_ATTEMPT')
    expect(f.get('detail-execution-body').textContent).toContain('EXACT_PRIVATE_ATTEMPT')
  })
})
describe('bounded escaped value presentation', () => {
  const render = async (value: unknown) => {
    const f = await fixture(); f.privateRun(value)
    await vi.waitFor(() => expect(f.get('live-private-summary').querySelector('.recorded-value')).not.toBeNull())
    return f.get('live-private-summary').querySelector('.recorded-value')!.innerHTML
  }
  it('escapes malicious text/keys instead of creating links, markup or scripts', async () => {
    const html = await render({ '<img src=x onerror=alert(1)>': '<script>hostile()</script>', url: 'javascript:hostile()' })
    expect(html).not.toContain('<img'); expect(html).not.toContain('<script>'); expect(html).not.toContain('<a ')
    expect(html).toContain('&lt;script&gt;'); expect(html).toContain('javascript:hostile()')
  })
  it('bounds wide/deep/long values visibly without changing the source value', async () => {
    const input = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`field-${i}`, 'x'.repeat(5000)])), before = JSON.stringify(input)
    const html = await render(input)
    expect(html.length).toBeLessThan(16000); expect(html).toContain('reading view is shortened'); expect(JSON.stringify(input)).toBe(before)
    expect(await render({ a: { b: { c: { d: { e: { f: 1 } } } } } })).toContain('See exact JSON')
  })
  it('keeps unknown typed fields instead of dropping them through special formatting', async () => {
    expect(await render({ type: 'noul', noul: 0.5, confidence: 0.2 })).toContain('confidence')
    expect(await render({ type: 'choice', choice: 'billing', confidence: 0.9, probabilities: {}, unknown: 'KEEP_ME' })).toContain('KEEP_ME')
  })
  it.each([null, false, 0, [], { detail: 'REVIEW_REASON' }].map(explanation => ({ explanation })))('preserves non-text explanation $explanation in arbitrary Choice-shaped values', async ({ explanation }) => {
    const html = await render({ type: 'choice', choice: 'billing', confidence: 0.9,
      probabilities: { billing: 1 }, explanation })
    expect(html).toContain('<dt>explanation</dt>')
    expect(html).toContain(explanation === null ? 'No value (null)' : explanation === false ? 'No' : explanation === 0 ? '>0<'
      : Array.isArray(explanation) ? 'Empty list' : 'REVIEW_REASON')
    expect(html).not.toContain('judgment-choice')
  })
  it('distinguishes an explicitly empty Choice explanation from an omitted explanation', async () => {
    const base = { type: 'choice', choice: 'billing', confidence: 0.9, probabilities: { billing: 1 } }
    expect(await render({ ...base, explanation: '' })).toContain('Empty text')
    expect(await render(base)).not.toContain('Empty text')
  })
  it.each([0, 0.5, 1])('shows normalized Noul probability %s without thresholding it into a verdict', async probability => {
    const html = await render({ type: 'noul', probability, confidence: 0.4 })
    expect(html).toContain(`>${probability * 100}%<`); expect(html).toContain('Confidence ')
    expect(html).toContain('40%'); expect(html).toContain('not a yes/no verdict')
    expect(html).not.toContain('not a confidence score')
  })
  it.each([
    [0, '0%'], [0.1, '10%'], [0.333333, '33.33%'], [0.5, '50%'], [1, '100%'],
    [0.00000001, '&lt;0.01%'], [0.99999999, '&gt;99.99%'],
  ])('reads native yes/no probability %s without inventing confidence or a verdict', async (noul, displayed) => {
    const value = { type: 'noul', noul }, before = JSON.stringify(value);
    const html = await render(value);
    expect(html).toContain('Chance of yes'); expect(html).toContain(`>${displayed}<`);
    expect(html).toContain('no separate confidence score'); expect(html).not.toContain('Confidence ');
    expect(html).toContain('not a yes/no verdict or permission to continue');
    expect(html).not.toContain('Judgment score'); expect(JSON.stringify(value)).toBe(before);
  })
  it.each([
    { type: 'noul', noul: -1 }, { type: 'noul', noul: 2 }, { type: 'noul', noul: '0.5' },
    { type: 'noul', noul: 0.5, unknown: 'KEEP_NATIVE_EXTRA' },
  ])('keeps malformed or extended native yes/no records visible: %j', async value => {
    const html = await render(value);
    expect(html).not.toContain('Chance of yes'); expect(html).not.toContain('judgment-number');
    expect(html).toContain('<dt>noul</dt>');
    if ('unknown' in value) expect(html).toContain('KEEP_NATIVE_EXTRA');
  })
  it.each([
    [0.00000001, '&lt;0.01%'], [0.99999999, '&gt;99.99%'],
  ])('does not round a nonzero or noncertain normalized probability %s into certainty', async (probability, displayed) => {
    const html = await render({ type: 'noul', probability, confidence: 0.4 });
    expect(html).toContain(`>${displayed}<`); expect(html).toContain('Confidence ');
    expect(html).toContain('40%'); expect(html).toContain('not a yes/no verdict');
  })
  it.each([
    { type: 'score', score: 1, confidence: 0.2, probabilities: [0, 1], unknown: 'KEEP_EXTRA' },
    { type: 'score', score: 1, confidence: 0.2, probabilities: [0, 1], legend: null },
    { type: 'score', score: 1, confidence: 0.2, probabilities: { '0': 0, '1': 1 }, legend: { '0': 'Low', other: 'High' } },
    { type: 'score', score: 1, confidence: 0.2, probabilities: [0, 1], explanation: { detail: 'KEEP_REASON' } },
    { type: 'noul', probability: 0.5, confidence: 0.2, unknown: 'KEEP_EXTRA' },
    { type: 'noul', probability: 2, confidence: 0.2 },
    { type: 'noul', probability: 0.5, confidence: -1 },
    { type: 'noul', probability: 0.5, confidence: 0.2, explanation: false },
  ])('preserves unknown or malformed score/yes-no shapes instead of hiding fields: %j', async value => {
    const html = await render(value)
    expect(html).not.toContain('judgment-number')
    expect(html).toContain('<dt>type</dt>'); expect(html).toContain('<dt>confidence</dt>')
    if ('unknown' in value) expect(html).toContain('KEEP_EXTRA')
    if ('explanation' in value) expect(html).toContain('<dt>explanation</dt>')
  })
  it('escapes Score rubric/explanation text and retains bounded rendering', async () => {
    const html = await render({ type: 'score', score: 1, confidence: 0.8,
      probabilities: { '0': 0, '1': 1 }, legend: { '0': '<img src=x onerror=alert(1)>', '1': 'x'.repeat(9000) },
      explanation: '<script>hostile()</script>' })
    expect(html).not.toContain('<img'); expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;img'); expect(html).toContain('&lt;script&gt;')
    expect(html.length).toBeLessThan(16000); expect(html).toContain('reading view is shortened')
  })
})
